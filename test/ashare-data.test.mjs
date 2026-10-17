import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-data-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows, closeAshareDb, getAshareDb, logSync } = await import('../build/ashare/db.js');
const data = await import('../build/ashare/data.js');
const { stockHistory, financialHistory, marketData, stockBasic, financialsAsOf, LIMITS } = data;
const { forEachStockBars } = await import('../build/ashare/bars.js');
const { fundamentalsAsOf } = await import('../build/ashare/fundamentals.js');
const { marketBreadth } = await import('../build/ashare/market.js');
const { checkQuality, syncSuspend, snapshotInfo } = await import('../build/ashare/ingest.js');
const { auditCache, auditDay, fillGaps, saveAudit } = await import('../build/ashare/audit.js');
const { generateReport } = await import('../build/ashare/report.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 150);
const LAST = DATES.at(-1);
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------- shared fixture (file DB, so the MCP tools can read it)

const db = openAshareDb();
seedMarket(db, DATES);
const DAILY_COLS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'];
const put = (table, cols, rows) => upsertRows(db, table, cols, rows);

// Ex-rights stock: 10-for-10 bonus on DATES[100]; raw price halves, adj_factor doubles.
const EX = '601999.SH';
const EX_DAY = DATES[100];
put('stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [{ ts_code: EX, symbol: '601999', name: '除权样本', industry: '行业0', list_date: '20180101', list_status: 'L' }]);
DATES.forEach((d, i) => {
  const raw = i < 100 ? 20 : 10;
  put('daily', DAILY_COLS, [{ ts_code: EX, trade_date: d, open: raw, high: raw, low: raw, close: raw, pre_close: i === 100 ? 10 : raw, pct_chg: 0, vol: 1000, amount: 20000 }]);
  put('adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: EX, trade_date: d, adj_factor: i < 100 ? 1 : 2 }]);
});

// New listing: listed on DATES[140].
const NEW = '688999.SH';
put('stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [{ ts_code: NEW, symbol: '688999', name: '新股样本', industry: '行业1', list_date: DATES[140], list_status: 'L' }]);
for (const d of DATES.slice(140)) {
  put('daily', DAILY_COLS, [{ ts_code: NEW, trade_date: d, open: 30, high: 30, low: 30, close: 30, pre_close: 30, pct_chg: 0, vol: 1, amount: 1 }]);
  put('adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: NEW, trade_date: d, adj_factor: 1 }]);
}

// Delisted stock: last bar DATES[120], delisted DATES[125].
const OLD = '600888.SH';
put('stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'delist_date', 'list_status'], [{ ts_code: OLD, symbol: '600888', name: '退市样本', industry: '行业2', list_date: '20100101', delist_date: DATES[125], list_status: 'D' }]);
for (const d of DATES.slice(0, 121)) {
  put('daily', DAILY_COLS, [{ ts_code: OLD, trade_date: d, open: 5, high: 5, low: 5, close: 5, pre_close: 5, pct_chg: 0, vol: 1, amount: 1 }]);
  put('adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: OLD, trade_date: d, adj_factor: 1 }]);
}

// Suspended stock: STOCKS[5] has no bars on DATES[130..132], recorded in suspend_d; STOCKS[6] misses DATES[131] with no record.
const SUSP = STOCKS[5].ts_code;
const HOLE = STOCKS[6].ts_code;
for (const d of DATES.slice(130, 133)) db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(SUSP, d);
db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(HOLE, DATES[131]);
for (const d of DATES) {
  const rows = DATES.slice(130, 133).includes(d) ? [{ ts_code: SUSP, trade_date: d }] : [];
  put('suspend_d', ['ts_code', 'trade_date'], rows);
  logSync(db, 'suspend_d', d, rows.length, 'ok', '', { refresh_status: 'REFRESH_OK', write_mode: 'replaced' });
}

// Holes a whole-market refresh cannot close: upstream has nothing for STOCKS[8] on DATES[135];
// for STOCKS[9] on DATES[136] only a per-stock suspend_d query reveals the suspension.
const UPSTREAM_GAP = STOCKS[8].ts_code;
const LATE_SUSP = STOCKS[9].ts_code;
db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(UPSTREAM_GAP, DATES[135]);
db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(LATE_SUSP, DATES[136]);

// Missing adjustment factor for STOCKS[7] on DATES[145].
const NOADJ = STOCKS[7].ts_code;
db.prepare('DELETE FROM adj_factor WHERE ts_code = ? AND trade_date = ?').run(NOADJ, DATES[145]);

// Financials of STOCKS[0]: period vs announcement, a restatement, a value that is null, an upstream anomaly.
const FIN = STOCKS[0].ts_code;
const FIN_COLS = ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'eps'];
put('fina_indicator', FIN_COLS, [
  { ts_code: FIN, end_date: '20251231', ann_date: '20260320', roe: 10, netprofit_yoy: 5, ocf_to_profit: 110, eps: 1.0 },
  { ts_code: FIN, end_date: '20251231', ann_date: '20260425', roe: 9.5, netprofit_yoy: 5, ocf_to_profit: 110, eps: 0.95 },
  { ts_code: FIN, end_date: '20260331', ann_date: '20260428', roe: 2.5, netprofit_yoy: null, ocf_to_profit: 90, eps: 0.3 },
  // Announced before the period ended: must never be "known" between 0422 and the real announcement.
  { ts_code: FIN, end_date: '20260630', ann_date: '20260422', roe: 5.1, netprofit_yoy: 7, ocf_to_profit: 100, eps: 0.6 },
  { ts_code: FIN, end_date: '20260630', ann_date: '20260815', roe: 5.1, netprofit_yoy: 7, ocf_to_profit: 100, eps: 0.6 },
]);

test('stock history: raw, qfq and hfq prices across an ex-rights date', () => {
  const none = stockHistory(db, { ts_code: EX, start_date: DATES[98], end_date: DATES[102], adjust: 'none' });
  const close = r => r[none.fields.indexOf('close')];
  assert.deepEqual(none.rows.map(close), [20, 20, 10, 10, 10]);
  const qfq = stockHistory(db, { ts_code: EX, start_date: DATES[98], end_date: DATES[102], adjust: 'qfq' });
  const adj = r => r[qfq.fields.indexOf('adj_close')];
  assert.deepEqual(qfq.rows.map(adj), [10, 10, 10, 10, 10], 'qfq = price × f / f(end): continuous at the latest basis');
  assert.equal(qfq.adjust.base.adj_factor, 2);
  const hfq = stockHistory(db, { ts_code: EX, start_date: DATES[98], end_date: DATES[102], adjust: 'hfq' });
  assert.deepEqual(hfq.rows.map(r => r[hfq.fields.indexOf('adj_close')]), [20, 20, 20, 20, 20], 'hfq = price × f');
  // As of a date before the ex-date, the later factor is never used: qfq equals raw.
  const before = stockHistory(db, { ts_code: EX, start_date: DATES[95], end_date: DATES[99], adjust: 'qfq' });
  assert.equal(before.adjust.base.trade_date, DATES[99]);
  assert.deepEqual(before.rows.map(r => r[before.fields.indexOf('adj_close')]), [20, 20, 20, 20, 20]);
  // The analysis engine's bars use the same qfq definition.
  let bars;
  forEachStockBars(db, DATES[98], DATES[102], (_c, b) => { bars = b; }, [EX]);
  assert.deepEqual(bars.close, qfq.rows.map(adj));
});

test('stock history: pagination keeps the qfq base; repeated queries are identical', () => {
  const q = { ts_code: EX, start_date: DATES[90], end_date: DATES[110], adjust: 'qfq', limit: 8 };
  const p1 = stockHistory(db, q);
  assert.equal(p1.truncated, true);
  assert.equal(p1.rows.length, 8);
  const p2 = stockHistory(db, { ...q, start_date: p1.next_start_date });
  const p3 = stockHistory(db, { ...q, start_date: p2.next_start_date });
  assert.equal(p3.truncated, false);
  const all = [...p1.rows, ...p2.rows, ...p3.rows];
  assert.equal(all.length, 21);
  assert.equal(new Set(all.map(r => r[0])).size, 21, 'no overlap between pages');
  assert.deepEqual([p1.adjust.base, p2.adjust.base, p3.adjust.base].map(b => b.adj_factor), [2, 2, 2]);
  assert.deepEqual(stockHistory(db, q), p1, 'deterministic');
});

test('stock history: suspension, unexplained gap, new listing, delisting and missing factor are distinguished', () => {
  const s = stockHistory(db, { ts_code: SUSP, start_date: DATES[128], end_date: DATES[134] });
  assert.deepEqual(s.coverage.suspended_days, DATES.slice(130, 133));
  assert.deepEqual(s.coverage.missing_days, []);
  assert.equal(s.rows.length, 4);
  const h = stockHistory(db, { ts_code: HOLE, start_date: DATES[128], end_date: DATES[134] });
  assert.deepEqual(h.coverage.missing_days, [DATES[131]]);
  assert.ok(h.warnings.some(w => /既无行情也无停牌记录/.test(w)));
  const n = stockHistory(db, { ts_code: NEW, start_date: DATES[135], end_date: DATES[145] });
  assert.equal(n.coverage.not_listed_days, 5);
  assert.equal(n.rows[0][0], DATES[140]);
  assert.deepEqual(n.coverage.missing_days, []);
  const o = stockHistory(db, { ts_code: OLD, start_date: DATES[118], end_date: DATES[130] });
  assert.equal(o.delist_date, DATES[125]);
  assert.equal(o.coverage.not_listed_days, 6, 'from the delisting date on');
  assert.deepEqual(o.coverage.pending_delisting_days, DATES.slice(121, 125), 'after the last bar, before delisting');
  assert.deepEqual(o.coverage.missing_days, []);
  const m = stockHistory(db, { ts_code: NOADJ, start_date: DATES[144], end_date: DATES[146] });
  const flag = m.fields.indexOf('adj_factor_missing');
  assert.deepEqual(m.rows.map(r => r[flag]), [false, true, false]);
  assert.equal(m.rows[1][m.fields.indexOf('adj_close')], null, 'no carried-forward factor in the data tool');
  assert.equal(m.rows[1][m.fields.indexOf('close')] > 0, true, 'raw price still returned');
  assert.deepEqual(m.coverage.adj_factor_missing_days, [DATES[145]]);
});

test('stock history: non-trading ranges, empty results and limits', () => {
  const sat = '20260110';
  const r = stockHistory(db, { ts_code: FIN, start_date: sat, end_date: '20260111' });
  assert.equal(r.rows.length, 0);
  assert.equal(r.coverage.trade_days, 0);
  assert.ok(r.warnings.includes('区间内无行情数据'));
  assert.throws(() => stockHistory(db, { ts_code: FIN, limit: LIMITS.history_rows_max + 1 }), /最大为 500/);
  assert.throws(() => stockHistory(db, { ts_code: FIN, start_date: '20100101', end_date: LAST }), /分段查询/);
  assert.throws(() => stockHistory(db, { ts_code: FIN, start_date: LAST, end_date: DATES[0] }), /晚于/);
  assert.throws(() => stockHistory(db, { ts_code: FIN, end_date: '20260231' }), /不是有效日期/);
  assert.throws(() => stockHistory(db, { ts_code: FIN, adjust: 'forward' }), /adjust/);
  assert.throws(() => stockHistory(db, { ts_code: '999999' }), /无法识别/);
  assert.throws(() => stockHistory(db, { ts_code: "600000.SH' OR 1=1 --" }), /无法识别/);
});

test('financials: as-of announcement constraint, anomalies, nulls and revisions', () => {
  const early = financialHistory(db, { ts_code: FIN, as_of_date: '20260401' });
  assert.deepEqual(early.periods.map(p => [p.end_date, p.ann_date]), [['20251231', '20260320']]);
  assert.equal(early.periods[0].values.roe, 10);
  assert.equal(early.hidden_after_as_of, 4, 'later announcements are counted, not shown');
  const mid = financialHistory(db, { ts_code: FIN, as_of_date: '20260501', include_revisions: true });
  assert.deepEqual(mid.periods.map(p => p.end_date), ['20260331', '20251231'], 'the 0630 record announced on 0422 is not used');
  assert.equal(mid.periods[0].values.netprofit_yoy, null, 'null stays null');
  assert.equal(mid.periods[1].values.roe, 9.5, 'latest announcement on or before as_of wins');
  assert.deepEqual(mid.periods[1].revisions[0].changed_fields.sort(), ['eps', 'roe']);
  assert.equal(mid.periods[1].revisions[0].values.roe, 10);
  assert.equal(mid.anomalies.length, 1);
  assert.equal(mid.anomalies[0].issue, 'ann_date_before_period_end');
  const late = financialHistory(db, { ts_code: FIN, as_of_date: '20260901', limit: 1 });
  assert.equal(late.periods[0].end_date, '20260630');
  assert.equal(late.periods[0].ann_date, '20260815');
  assert.equal(late.truncated, true);
  assert.equal(late.units.ocf_to_profit.unit.startsWith('%'), true);
  // The engine's point-in-time map uses the same rule (no look-ahead via the anomalous record).
  assert.equal(financialsAsOf(db, '20260501').get(FIN).end_date, '20260331');
  assert.equal(fundamentalsAsOf(db, '20260501').get(FIN).end_date, '20260331');
  const none = financialHistory(db, { ts_code: FIN, as_of_date: '20260101' });
  assert.equal(none.empty, true);
  assert.throws(() => financialHistory(db, { ts_code: FIN, start_period: '20260115' }), /报告期末/);
  assert.throws(() => financialHistory(db, { ts_code: FIN, limit: 41 }), /最大为 40/);
});

test('market data: index bars, breadth (same counts as the engine), suspensions and limits', () => {
  const m = marketData(db, { end_date: DATES[131], indices: ['000300.SH', '000001.SH'] });
  assert.equal(m.days.length, 1);
  const d = m.days[0];
  assert.deepEqual(d.indices.map(i => i.ts_code).sort(), ['000001.SH', '000300.SH']);
  const engine = marketBreadth(db, DATES[131]);
  assert.deepEqual([d.breadth.stocks_traded, d.breadth.up, d.breadth.down, d.breadth.limit_up, d.breadth.limit_down], [engine.stocks, engine.up, engine.down, engine.limit_up, engine.limit_down]);
  assert.equal(d.breadth.amount_yi, engine.amount_yi);
  assert.equal(d.breadth.suspended, 1);
  assert.ok(['READY', 'DEGRADED', 'NOT_READY'].includes(d.data_quality.status));
  const range = marketData(db, { start_date: DATES[100], end_date: DATES[109], include_breadth: false });
  assert.equal(range.trade_days, 10);
  assert.equal(range.days[0].breadth, undefined);
  assert.throws(() => marketData(db, { start_date: DATES[0], end_date: LAST }), /单次最多 60/);
  assert.throws(() => marketData(db, { indices: ['000016.SH'] }), /不支持的指数/);
  assert.equal(marketData(db, { start_date: '20260110', end_date: '20260111' }).empty, true);
});

test('stock basics: code list, search with escaping, paging and current-classification caveat', () => {
  const r = stockBasic(db, { ts_codes: [FIN, '600888', '退市样本', 'nope'] });
  assert.deepEqual(r.stocks.map(s => s.ts_code), [FIN, OLD]);
  assert.deepEqual(r.not_found, ['nope']);
  assert.equal(r.stocks[1].delist_date, DATES[125]);
  const page = stockBasic(db, { query: '测试', limit: 25 });
  assert.equal(page.total, 60);
  assert.equal(page.next_offset, 25);
  assert.equal(stockBasic(db, { query: '%' }).total, 0, 'LIKE wildcards are escaped');
  assert.equal(stockBasic(db, { list_status: 'D' }).total, 1);
  assert.ok(r.limitations.some(l => /当前 stock_basic 口径/.test(l)));
  assert.throws(() => stockBasic(db, {}), /筛选条件/);
  assert.throws(() => stockBasic(db, { ts_codes: Array.from({ length: 51 }, (_, i) => String(600000 + i)) }), /最多 50/);
});

test('audit: suspensions are not gaps, unexplained holes are, and --fix re-fetches only the gap date', async () => {
  const day = auditDay(db, DATES[131], DATES[130]);
  assert.equal(day.suspended, 1);
  assert.equal(day.unexplained_missing, 1);
  assert.deepEqual(day.unexplained_sample, [HOLE]);
  assert.equal(day.status, 'GAP');
  assert.equal(auditDay(db, DATES[130], DATES[129]).status !== 'GAP', true, 'a suspension alone is not a gap');
  const missingAdj = auditDay(db, DATES[145], DATES[144]);
  assert.equal(missingAdj.missing_adj_factor, 1);
  // sync_log says ok with 80 rows written but only 60 are stored: a silent loss.
  logSync(db, 'daily_basic', DATES[120], 80, 'ok', '', { refresh_status: 'REFRESH_OK', after_rows: 80, write_mode: 'replaced' });
  assert.equal(auditDay(db, DATES[120], DATES[119]).logged_ok_but_short[0].dataset, 'daily_basic');

  const audit = auditCache(db, DATES[110], LAST);
  const gaps = audit.days.filter(d => d.status === 'GAP').map(d => d.trade_date);
  assert.deepEqual(gaps, [DATES[120], DATES[131], DATES[135], DATES[136], DATES[145]]);
  // Upstream answers the gap dates completely; the fill must use the refresh rules and touch nothing else.
  const fetched = [];
  const full = {};
  for (const d of gaps) {
    full[d] = {};
    for (const t of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) full[d][t] = db.prepare(`SELECT * FROM ${t} WHERE trade_date = ?`).all(d);
    full[d].daily.push({ ...full[d].daily[0], ts_code: HOLE });
    full[d].adj_factor.push({ ts_code: NOADJ, trade_date: d, adj_factor: 1 });
    // Upstream has since revised another stock's factor; a gap fix must not write it into a stock without a gap.
    full[d].adj_factor = full[d].adj_factor.map(r => (r.ts_code === STOCKS[20].ts_code ? { ...r, adj_factor: 1.003 } : r));
  }
  globalThis.fetch = async (_u, init) => {
    const { api_name: api, params, fields } = JSON.parse(init.body);
    fetched.push(`${api}:${params.trade_date ?? params.start_date}:${params.ts_code ?? 'all'}`);
    let rows;
    if (params.ts_code) {
      rows = api === 'suspend_d'
        ? (params.ts_code === LATE_SUSP ? [{ ts_code: LATE_SUSP, trade_date: DATES[136], suspend_type: 'S' }] : [])
        : (full[params.start_date]?.[api] ?? []).filter(r => r.ts_code === params.ts_code);
    }
    else rows = api === 'suspend_d' ? db.prepare('SELECT * FROM suspend_d WHERE trade_date = ?').all(params.trade_date) : (full[params.trade_date]?.[api] ?? []);
    const cols = fields.split(',');
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  const watchBefore = db.prepare('SELECT COUNT(*) n FROM watchlist').get().n;
  try {
    const actions = await fillGaps(db, audit);
    assert.deepEqual([...new Set(actions.map(a => a.trade_date))], gaps);
    assert.ok(fetched.every(f => gaps.some(g => f.includes(`:${g}:`))), 'only gap dates were requested');
    assert.deepEqual(fetched.filter(f => f.endsWith(':all')).sort(), ['adj_factor', 'daily', 'daily_basic', 'stk_limit'].map(a => `${a}:${DATES[120]}:all`),
      'whole-market refresh only where the stored snapshot itself was short');
    const tables = ['daily', 'daily_basic', 'adj_factor', 'stk_limit'];
    assert.deepEqual(fetched.filter(f => !f.endsWith(':all')).sort(), [
      ...tables.map(t => `${t}:${DATES[131]}:${HOLE}`),
      ...tables.map(t => `${t}:${DATES[135]}:${UPSTREAM_GAP}`), `suspend_d:${DATES[135]}:${UPSTREAM_GAP}`,
      ...tables.map(t => `${t}:${DATES[136]}:${LATE_SUSP}`), `suspend_d:${DATES[136]}:${LATE_SUSP}`,
      `adj_factor:${DATES[145]}:${NOADJ}`,
    ].sort(), 'single holes are repaired per stock');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = auditCache(db, DATES[110], LAST);
  // The whole-market refresh of DATES[120] did take the revised factor; the audit makes that mix visible.
  assert.ok(after.days.find(d => d.trade_date === DATES[120]).factor_revision_boundaries.includes(STOCKS[20].ts_code));
  assert.ok(after.days.find(d => d.trade_date === DATES[121]).factor_revision_boundaries.includes(STOCKS[20].ts_code));
  const d135 = after.days.find(d => d.trade_date === DATES[135]);
  assert.equal(d135.status, 'WARN');
  assert.deepEqual(d135.upstream_missing_sample, [UPSTREAM_GAP]);
  assert.equal(after.days.find(d => d.trade_date === DATES[136]).suspended, 1, 'suspension found per stock is stored');
  assert.deepEqual(stockHistory(db, { ts_code: UPSTREAM_GAP, start_date: DATES[134], end_date: DATES[136] }).coverage.upstream_missing_days, [DATES[135]]);
  assert.equal(after.status === 'GAP', false, JSON.stringify(after.days.filter(d => d.status === 'GAP').map(d => d.issues)));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily WHERE ts_code = ? AND trade_date = ?').get(HOLE, DATES[131]).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM watchlist').get().n, watchBefore, 'no watchlist writes');
  for (const d of [DATES[131], DATES[135], DATES[145]]) {
    assert.equal(db.prepare('SELECT adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date = ?').get(STOCKS[20].ts_code, d).adj_factor, 1, 'stocks without a gap keep their stored values');
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE dataset LIKE 'repair:%'").get().n, 13, 'per-stock repairs are logged separately');
  const path = saveAudit(db, after, { fixed_from: audit.audit_id });
  assert.ok(existsSync(join(dir, path)));
  assert.equal(db.prepare('SELECT status FROM data_audit WHERE audit_id = ?').get(after.audit_id).status, after.status);
});

test('suspension sync: an API error keeps earlier data and is retried; success replaces the date', async () => {
  const d = DATES[132];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40001, msg: '参数异常：注入错误' }) });
  try {
    const r = await syncSuspend(db, d, true);
    assert.equal(r.refresh_status, 'REFRESH_FAILED');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM suspend_d WHERE trade_date = ?').get(d).n, 1, 'earlier data kept');
    assert.equal(db.prepare("SELECT status FROM sync_log WHERE dataset = 'suspend_d' AND key = ?").get(d).status, 'ok', 'the earlier successful snapshot still stands');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('snapshot: datasets written by fetches hours apart are reported as mixed', () => {
  const d = DATES[140];
  assert.equal(snapshotInfo(db, d).mixed, false);
  const at = (h) => `2026-08-01T${h}:00:00.000Z`;
  for (const [t, h] of [['daily', '10'], ['daily_basic', '10'], ['adj_factor', '13'], ['stk_limit', '10']]) {
    db.prepare("INSERT INTO sync_history (dataset, key, rows, status, message, synced_at, write_mode) VALUES (?, ?, 60, 'ok', '', ?, 'replaced')").run(t, d, at(h));
  }
  const s = checkQuality(db, d, false).snapshot;
  assert.equal(s.mixed, true);
  assert.equal(s.spread_minutes, 180);
  assert.match(s.note, /不同时间/);
});

test('MCP: the four data tools answer through the read-only connection, alongside the original five', async () => {
  generateReport(db, LAST, 'live');
  closeAshareDb();
  const call = async (name, args) => (await runAshareTool(name, args)).content[0].text;
  const h = JSON.parse(await call('ashare_stock_history', { ts_code: EX, end_date: DATES[102], start_date: DATES[98] }));
  assert.equal(h.rows.length, 5);
  const f = JSON.parse(await call('ashare_financial_data', { ts_code: FIN, as_of_date: '20260501' }));
  assert.equal(f.periods.length, 2);
  const m = JSON.parse(await call('ashare_market_data', { end_date: LAST }));
  assert.equal(m.days[0].trade_date, LAST);
  const b = JSON.parse(await call('ashare_stock_basic', { query: '样本' }));
  assert.equal(b.total, 3);
  for (const name of ['ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_sector_rank']) assert.ok((await call(name, { date: LAST })).length > 100, name);
  assert.ok((await call('ashare_stock_analysis', { ts_code: FIN, date: LAST })).length > 100);
  assert.match(await call('ashare_data_status', { date: LAST }), /最近一次历史缓存审计：AUD-/);
  await assert.rejects(() => runAshareTool('ashare_stock_history', { ts_code: FIN, limit: 9999 }), /最大为 500/);
  assert.throws(() => getAshareDb().exec('DELETE FROM daily'), /readonly/);
  closeAshareDb();
});
