import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-fix-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, openResearchDb, upsertRows, getAshareDb, closeAshareDb } = await import('../build/ashare/db.js');
const { syncTradeDate, checkQuality } = await import('../build/ashare/ingest.js');
const { syncRange } = await import('../build/ashare/sync.js');
const { generateReport, latestReportMeta } = await import('../build/ashare/report.js');
const { evaluateWatchlist, computeEvidence, loadVerdicts } = await import('../build/ashare/evidence.js');
const { scanMarket } = await import('../build/ashare/analysis.js');
const { forEachStockBars } = await import('../build/ashare/bars.js');
const { acceptance, acceptanceDay } = await import('../build/ashare/acceptance.js');
const { runCommand } = await import('../build/ashare/commands.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { seedMarket, addMarketDays, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 150);
const FUTURE = weekdays('20260105', 160).slice(150);

function helpers(args) {
  const out = [];
  return {
    out,
    h: {
      arg: name => args[name],
      flag: name => args[name] === true,
      ymd: v => v,
      print: v => out.push(v),
    },
  };
}

// ---------------------------------------------------------------- Tushare mock

/** Serve whole-market responses from `tables[api][trade_date]`, with offset pagination. */
function mockTushare(tables) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const { api_name: api, params, fields } = body;
    calls.push({ api, ...params });
    let rows = [];
    if (api === 'trade_cal') rows = tables.trade_cal ?? [];
    else if (api === 'stock_basic') rows = params.list_status === 'L' ? (tables.stock_basic ?? []) : [];
    else if (api === 'index_daily') rows = [];
    else rows = typeof tables[api]?.[params.trade_date] === 'function' ? tables[api][params.trade_date]() : (tables[api]?.[params.trade_date] ?? []);
    const cols = fields ? fields.split(',') : Object.keys(rows[0] ?? {});
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  return calls;
}

const D0 = '20261015';
const D1 = '20261016';
const quote = (i, date, close = 10) => ({ ts_code: `${600000 + i}.SH`, trade_date: date, open: close, high: close, low: close, close, pre_close: close, pct_chg: 0, vol: 1, amount: 1, adj_factor: 1, up_limit: 11, down_limit: 9, turnover_rate: 1 });
const day = (date, n, close) => Array.from({ length: n }, (_, i) => quote(i, date, close?.(i)));
const allApis = rows => ({ daily: rows, daily_basic: rows, adj_factor: rows, stk_limit: rows });

test('P0-1: a second daily run re-queries the as-of day and replaces revised data', async () => {
  const originalFetch = globalThis.fetch;
  const db = openAshareDb(':memory:');
  try {
    // 18:40 response: 97 of 100 stocks (passes the 97% rule) plus a row Tushare later withdraws.
    const first = [...day(D1, 97), quote(999, D1, 5)];
    // 21:10 response: all 100 stocks; stock 0 has a revised close.
    const second = day(D1, 100, i => (i === 0 ? 12.34 : 10));
    let response = first;
    const tables = {
      trade_cal: [{ cal_date: D0, is_open: 1, pretrade_date: null }, { cal_date: D1, is_open: 1, pretrade_date: D0 }],
      stock_basic: [],
    };
    for (const api of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) tables[api] = { [D0]: day(D0, 100), [D1]: () => response };
    const calls = mockTushare(tables);

    const run1 = await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    assert.deepEqual(run1.refreshed, [D1]);
    assert.equal(run1.datasets[D1].daily.rows, 98);
    assert.equal(run1.datasets[D1].daily.status, 'ok');

    // The old behaviour (skip a date already marked ok) would never see the revision.
    const skipped = await syncTradeDate(db, D1, 'skip_ok');
    assert.equal(skipped.daily.fetched, false);

    response = second;
    const before = calls.filter(c => c.api === 'daily' && c.trade_date === D1).length;
    const run2 = await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    assert.equal(calls.filter(c => c.api === 'daily' && c.trade_date === D1).length, before + 1, 'second run fetched the as-of day again');
    assert.equal(calls.filter(c => c.api === 'daily' && c.trade_date === D0).length, 1, 'older complete days are not re-downloaded');
    assert.equal(run2.datasets[D1].daily.write, 'replaced');
    assert.equal(db.prepare('SELECT close FROM daily WHERE ts_code = ? AND trade_date = ?').get('600000.SH', D1).close, 12.34);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily WHERE ts_code = ? AND trade_date = ?').get('600999.SH', D1).n, 0, 'withdrawn row removed');

    // A third run with identical data: no duplicates, same counts, still ok.
    await syncRange(db, D0, D1, { refreshFrom: D1, fina: false });
    for (const table of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE trade_date = ?`).get(D1).n, 100, table);
      assert.equal(db.prepare('SELECT status FROM sync_log WHERE dataset = ? AND key = ?').get(table, D1).status, 'ok');
    }
    const history = db.prepare("SELECT COUNT(*) n FROM sync_history WHERE dataset = 'daily' AND key = ?").get(D1).n;
    assert.equal(history, 3, 'every fetch of the as-of day is kept for audit');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('P0-1: an incomplete first response is completed later; a short refresh never shrinks data', async () => {
  const originalFetch = globalThis.fetch;
  const db = openAshareDb(':memory:');
  try {
    upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: D0, is_open: 1 }, { cal_date: D1, is_open: 1, pretrade_date: D0 }]);
    let response = day(D1, 50);
    mockTushare({ ...Object.fromEntries(Object.entries(allApis(null)).map(([k]) => [k, { [D0]: day(D0, 100), [D1]: () => response }])) });
    await syncTradeDate(db, D0, 'refresh');

    const first = await syncTradeDate(db, D1, 'refresh');
    assert.equal(first.daily.status, 'partial');
    assert.equal(checkQuality(db, D1, false).status, 'NOT_READY');

    response = day(D1, 100);
    const second = await syncTradeDate(db, D1, 'skip_ok'); // partial dates are fetched again even without refresh
    assert.equal(second.daily.fetched, true);
    assert.equal(second.daily.status, 'ok');
    assert.equal(second.daily.rows, 100);

    // A stale extra row (stored 101, Tushare now answers 100) is removed by a complete refresh.
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'close'], [{ ts_code: '688999.SH', trade_date: D1, close: 1 }]);
    const cleaned = await syncTradeDate(db, D1, 'refresh');
    assert.equal(cleaned.daily.write, 'replaced');
    assert.equal(cleaned.daily.rows, 100);

    response = day(D1, 40); // transient short answer on a later refresh
    const third = await syncTradeDate(db, D1, 'refresh');
    assert.equal(third.daily.write, 'merged');
    assert.equal(third.daily.rows, 100);
    assert.equal(third.daily.status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

// ---------------------------------------------------------------- live market fixture

const live = openAshareDb();
seedMarket(live, DATES);
const LIVE_DAYS = DATES.slice(-5);
for (const d of LIVE_DAYS) generateReport(live, d, 'live');

function snapshot(db) {
  return {
    watchlist: db.prepare('SELECT * FROM watchlist ORDER BY trade_date, ts_code').all(),
    changes: db.prepare('SELECT * FROM watchlist_change ORDER BY trade_date, ts_code, action').all(),
    scores: db.prepare('SELECT trade_date, COUNT(*) n FROM stock_score GROUP BY trade_date').all(),
    reports: db.prepare('SELECT * FROM report ORDER BY report_id').all(),
    latest: LIVE_DAYS.map(d => readFileSync(join(dir, 'reports', d, 'latest.json'), 'utf8')),
  };
}

test('P0-2: replay and back-dated reports never touch live watchlists or reports', async () => {
  const before = snapshot(live);
  const latestBefore = latestReportMeta(live);
  assert.equal(latestBefore.trade_date, LIVE_DAYS.at(-1));

  // Replay over a range that overlaps the live days.
  const replay = helpers({ start: DATES.at(-20), end: DATES.at(-2) });
  await runCommand(live, 'replay', replay.h);
  assert.equal(replay.h && replay.out[0].space, 'research');
  assert.equal(replay.out[0].reports.length, 19);

  // Manual report for a date that already has later live days goes to research.
  const manual = helpers({ date: LIVE_DAYS[1] });
  await runCommand(live, 'report', manual.h);
  assert.equal(manual.out[0].space, 'research');

  assert.deepEqual(snapshot(live), before, 'live watchlist, changes, scores, reports and latest.json unchanged');
  assert.equal(latestReportMeta(live).report_id, latestBefore.report_id);

  const research = openResearchDb();
  try {
    assert.ok(research.prepare('SELECT COUNT(*) n FROM report').get().n >= 20);
    assert.equal(research.prepare("SELECT COUNT(*) n FROM main.report WHERE run_mode = 'live'").get().n, 0);
    assert.throws(() => research.exec("DELETE FROM live.watchlist"), /readonly/);
    const r = research.prepare('SELECT path FROM report LIMIT 1').get();
    assert.match(r.path, /^research\/reports\//);
  } finally {
    research.close();
  }

  // The next live day continues from the last live list, not from the replay.
  const next = weekdays('20260105', 151).at(-1);
  addMarketDays(live, [next], weekdays('20260105', 151));
  const { report } = generateReport(live, next, 'live');
  assert.equal(report.watchlist.previous_date, LIVE_DAYS.at(-1));
  const prevCount = live.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(LIVE_DAYS.at(-1)).n;
  assert.equal(report.watchlist.count, prevCount + report.watchlist.added.length - report.watchlist.removed.length);
  LIVE_DAYS.push(next);
});

test('P1-1: the latest report is ordered by trade date and prefers live over replay', () => {
  const db = openAshareDb(':memory:');
  const ins = db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)');
  ins.run('live-16', '20261016', 'READY', '2026-10-16T21:10:00+08:00', 'x', 'live');
  ins.run('replay-15', '20261015', 'READY', '2026-10-17T00:33:00+08:00', 'x', 'replay');
  ins.run('replay-16', '20261016', 'READY', '2026-10-17T00:40:00+08:00', 'x', 'replay');
  ins.run('legacy-14', '20261014', 'READY', '2026-10-18T00:00:00+08:00', 'x', null);
  assert.equal(latestReportMeta(db).report_id, 'live-16');
  assert.equal(latestReportMeta(db, '20261016').report_id, 'live-16');
  assert.equal(latestReportMeta(db, undefined, true, '20261015').report_id, 'replay-15');
  db.close();
});

test('P0-3: pool evaluation and evidence are strictly as of the report date', () => {
  const end = LIVE_DAYS.at(-1);
  const start = LIVE_DAYS[0];
  const asOf = evaluateWatchlist(live, start, end, 2, 10);
  assert.ok(asOf.pending_dates > 0, 'some pool dates have windows that end after `end`');
  const all = weekdays('20260105', 165);
  assert.ok(asOf.per_date.length > 0);
  assert.ok(asOf.per_date.every(d => all.indexOf(d.trade_date) + 2 <= all.indexOf(end)), 'only windows realised by `end`');

  // New market data after `end` must not change the as-of figures.
  addMarketDays(live, all.slice(151), all);
  assert.deepEqual(evaluateWatchlist(live, start, end, 2, 10), asOf);

  // Evidence computed through a later date is not shown as known to an earlier report.
  computeEvidence(live, DATES[0], all.at(-1));
  const later = loadVerdicts(live, all.at(-1));
  assert.equal(later.meta.usable_as_of, true);
  const early = loadVerdicts(live, DATES.at(-10));
  assert.equal(early.meta.usable_as_of, false);
  for (const v of early.verdicts.values()) {
    assert.equal(v.classification, 'research_only');
    assert.match(v.basis, /晚于/);
  }
  const research = openResearchDb();
  try {
    const { report } = generateReport(research, DATES.at(-10), 'replay');
    assert.equal(report.signals.evidence_window.usable_as_of, false);
    assert.ok(report.signals.market_summary.every(s => s.evidence === 'research_only'));
    assert.match(report.signals.evidence_scope.meaning, /样本内方向性证据/);
  } finally {
    research.close();
  }
});

test('P1-3: a stock with missing adjustment factors gets no score and no signals', () => {
  const db = openAshareDb(':memory:');
  seedMarket(db, DATES);
  const victim = STOCKS[3].ts_code;
  db.prepare('DELETE FROM adj_factor WHERE ts_code = ? AND trade_date = ?').run(victim, DATES[100]);
  let missing;
  forEachStockBars(db, DATES[0], DATES.at(-1), (_c, b) => { missing = b.adjMissing; }, [victim]);
  assert.equal(missing, 1);
  const row = scanMarket(db, DATES.at(-1)).rows.find(r => r.ts_code === victim);
  assert.equal(row.eligible, false);
  assert.match(row.ineligible_reason, /复权因子缺失/);
  assert.deepEqual(row.signals, []);
  assert.ok(row.risk_flags.some(f => /复权因子缺失/.test(f)));
  db.close();
});

// ---------------------------------------------------------------- acceptance

function fakeLiveDay(db, date, runs, { fetches = 2 } = {}) {
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  mkdirSync(join(dir, 'reports', date), { recursive: true });
  runs.forEach(([time, status, mode = 'live'], i) => {
    const id = `ASR-${date}-${i}-${mode}`;
    const path = join('reports', date, `${id}.json`);
    writeFileSync(join(dir, path), JSON.stringify({
      report_id: id, run_mode: mode, status, generated_at: `${d}T${time}:00.000+08:00`,
      data: { quality: { reasons: status === 'DEGRADED' ? ['涨跌停价覆盖率 0.9 < 0.95'] : [] } },
      watchlist: { previous_date: null, added: [], removed: [] },
    }));
    db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
      .run(id, date, status, `${d}T${time}:00.000+08:00`, path, mode);
  });
  for (let i = 0; i < fetches; i++) {
    db.prepare("INSERT INTO sync_history (dataset, key, rows, status, message, synced_at) VALUES ('daily', ?, 5500, 'ok', 'refresh', ?)")
      .run(date, `${d}T${i ? '13:10' : '10:40'}:30.000Z`);
  }
}

test('P1-2: acceptance distinguishes READY, DEGRADED, missing runs and missing re-checks', () => {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], ['20261016', '20261019', '20261020', '20261021', '20261022'].map(c => ({ cal_date: c, is_open: 1 })));
  fakeLiveDay(db, '20261019', [['18:41', 'NOT_READY'], ['21:11', 'READY']]);
  fakeLiveDay(db, '20261020', [['18:41', 'READY'], ['21:11', 'DEGRADED']]);
  fakeLiveDay(db, '20261021', [['21:11', 'READY']], { fetches: 1 });
  fakeLiveDay(db, '20261022', [['18:41', 'READY'], ['21:11', 'READY'], ['23:59', 'READY', 'replay']]);
  const now = new Date('2026-10-23T02:00:00Z');

  const ok = acceptanceDay(db, '20261019', { now });
  assert.deepEqual(ok.failed.filter(f => f !== 'watchlist_continuous'), []);
  const degraded = acceptanceDay(db, '20261020', { now });
  assert.ok(degraded.failed.includes('final_status'), 'DEGRADED is not READY');
  const allowed = acceptanceDay(db, '20261020', { now, allowDegraded: true });
  assert.ok(!allowed.failed.includes('final_status'));
  const single = acceptanceDay(db, '20261021', { now });
  assert.ok(single.failed.includes('scheduled_runs') && single.failed.includes('data_rechecked'));
  const withReplay = acceptanceDay(db, '20261022', { now });
  assert.ok(!withReplay.failed.includes('mcp_consistent'), 'a later replay does not replace the served live report');
  assert.equal(withReplay.mcp_report_id, 'ASR-20261022-1-live');
  const pending = acceptanceDay(db, '20261022', { now: new Date('2026-10-22T12:00:00Z') });
  assert.equal(pending.result, 'PENDING');
  assert.equal(acceptance(db, '20261021', 3, { now }).passed, false);
  db.close();
});

test('P1-2: a fully passing live day on real pipeline output', () => {
  // Two live runs of the fixture's last day, each after a recorded refresh of the day's quotes.
  const date = LIVE_DAYS.at(-1);
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  for (const t of ['10:41', '13:11']) {
    live.prepare("INSERT INTO sync_history (dataset, key, rows, status, message, synced_at) VALUES ('daily', ?, 60, 'ok', 'refresh', ?)").run(date, `${d}T${t}:00.000Z`);
  }
  const ids = [generateReport(live, date, 'live').meta.report_id, generateReport(live, date, 'live').meta.report_id];
  // generated_at is "now"; judge same-day against the clock the reports were written with.
  const result = acceptanceDay(live, date, { now: new Date('2030-01-01T00:00:00Z') });
  assert.equal(result.mcp_report_id, ids[1]);
  assert.ok(!result.failed.includes('mcp_consistent'));
  assert.ok(!result.failed.includes('final_status'));
  assert.ok(!result.failed.includes('watchlist_continuous'), JSON.stringify(result.watchlist));
});

// ---------------------------------------------------------------- MCP tools

test('MCP tools: five tools answer from the live cache through a read-only connection', async () => {
  closeAshareDb();
  const date = LIVE_DAYS.at(-1);
  const status = (await runAshareTool('ashare_data_status', { date })).content[0].text;
  assert.match(status, /数据质量：\*\*READY\*\*/);
  const md = (await runAshareTool('ashare_daily_report', { date })).content[0].text;
  assert.match(md, /样本内方向性证据/);
  const json = JSON.parse((await runAshareTool('ashare_daily_report', { date, format: 'json' })).content[0].text);
  assert.equal(json.run_mode, 'live');
  assert.equal(json.report_id, latestReportMeta(live, date).report_id);
  const wl = JSON.parse((await runAshareTool('ashare_watchlist', { date })).content[0].text);
  assert.equal(wl.report_id, json.report_id);
  const stock = JSON.parse((await runAshareTool('ashare_stock_analysis', { ts_code: STOCKS[0].ts_code, date })).content[0].text);
  assert.equal(stock.last_bar, date);
  const sectors = (await runAshareTool('ashare_sector_rank', { date, top: 5 })).content[0].text;
  assert.match(sectors, new RegExp(json.report_id));
  assert.throws(() => getAshareDb().exec('DELETE FROM report'), /readonly/);
  // A replayed date in research must never be what the tools serve.
  assert.ok(existsSync(join(dir, 'research', 'reports')));
  closeAshareDb();
});
