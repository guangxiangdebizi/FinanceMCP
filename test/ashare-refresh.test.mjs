import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-refresh-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows, closeAshareDb } = await import('../build/ashare/db.js');
const { syncTradeDate, checkQuality } = await import('../build/ashare/ingest.js');
const { generateReport, latestReportMeta } = await import('../build/ashare/report.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');

const TABLES = ['daily', 'daily_basic', 'adj_factor', 'stk_limit'];
const originalFetch = globalThis.fetch;

/**
 * Tushare mock: `answer(api, trade_date)` returns rows, or the string 'error'
 * for an API error (a permanent one, so the client does not retry).
 */
function mockTushare(answer) {
  globalThis.fetch = async (_url, init) => {
    const { api_name: api, params, fields } = JSON.parse(init.body);
    const rows = answer(api, params.trade_date);
    if (rows === 'error') return { ok: true, json: async () => ({ code: 40001, msg: '参数异常：上游服务暂不可用' }) };
    const cols = fields.split(',');
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
}

// ---------------------------------------------------------------- sync level, real-size counts

const P = '20261015';
const D = '20261016';
const quotes = (date, n, offset = 0, close = () => 10) => Array.from({ length: n }, (_, i) => ({
  ts_code: `${String(i + offset).padStart(6, '0')}.SZ`, trade_date: date, open: 10, high: 10, low: 10, close: close(i), pre_close: 10,
  pct_chg: 0, vol: 1, amount: 1, adj_factor: 1, up_limit: 11, down_limit: 9, turnover_rate: 1,
}));

function freshSyncDb() {
  const db = openAshareDb(':memory:');
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: P, is_open: 1 }, { cal_date: D, is_open: 1, pretrade_date: P }]);
  for (const t of TABLES) upsertRows(db, t, ['ts_code', 'trade_date'], quotes(P, 5500));
  return db;
}

async function refresh(db, rows) {
  mockTushare(() => rows);
  return syncTradeDate(db, D, 'refresh');
}

const log = (db, t = 'daily') => db.prepare('SELECT * FROM sync_log WHERE dataset = ? AND key = ?').get(t, D);
const count = (db, t = 'daily') => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE trade_date = ?`).get(D).n;

test('A: 5500 then 3000 keeps the complete snapshot and records the refresh as incomplete', async () => {
  const db = freshSyncDb();
  try {
    const first = await refresh(db, quotes(D, 5500));
    assert.equal(first.daily.refresh_status, 'REFRESH_OK');
    // The short answer also carries a revised close for stock 0: it must not be mixed into the kept snapshot.
    const second = await refresh(db, quotes(D, 3000, 0, i => (i === 0 ? 99 : 10)));
    assert.equal(count(db), 5500, 'no data lost');
    assert.equal(db.prepare("SELECT close FROM daily WHERE ts_code = '000000.SZ' AND trade_date = ?").get(D).close, 10, 'no partial update mixed in');
    assert.equal(second.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(second.daily.write, 'kept');
    assert.deepEqual([second.daily.fetched_rows, second.daily.before_rows, second.daily.rows], [3000, 5500, 5500]);
    const l = log(db);
    assert.equal(l.refresh_status, 'REFRESH_INCOMPLETE', 'not recorded as a successful refresh');
    assert.equal(l.status, 'ok', 'cache state is still complete');
    assert.deepEqual([l.rows, l.before_rows, l.after_rows, l.write_mode], [3000, 5500, 5500, 'kept']);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B: 3000 then 5500 completes the cache', async () => {
  const db = freshSyncDb();
  try {
    const first = await refresh(db, quotes(D, 3000));
    assert.equal(first.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.equal(first.daily.write, 'merged', 'an incomplete cache still takes the valid rows');
    assert.equal(log(db).status, 'partial');
    const second = await refresh(db, quotes(D, 5500));
    assert.equal(second.daily.refresh_status, 'REFRESH_OK');
    assert.equal(second.daily.write, 'replaced');
    assert.equal(count(db), 5500);
    assert.equal(log(db).status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('C: 5500 then 5490 with withdrawn rows is an atomic replace', async () => {
  const db = freshSyncDb();
  try {
    await refresh(db, quotes(D, 5500));
    const second = await refresh(db, quotes(D, 5490)); // stocks 5490..5499 withdrawn upstream
    assert.equal(second.daily.refresh_status, 'REFRESH_OK');
    assert.equal(second.daily.write, 'replaced');
    assert.equal(count(db), 5490);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM daily WHERE trade_date = ? AND ts_code >= '005490.SZ'").get(D).n, 0, 'withdrawn rows gone');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('D: a Tushare error keeps the data, leaves evidence and is not a successful fetch', async () => {
  const db = freshSyncDb();
  try {
    await refresh(db, quotes(D, 5500));
    mockTushare(api => (api === 'daily' ? 'error' : quotes(D, 5500)));
    const result = await syncTradeDate(db, D, 'refresh');
    assert.equal(result.daily.refresh_status, 'REFRESH_FAILED');
    assert.equal(result.daily.write, 'none');
    assert.match(result.daily.error, /上游服务暂不可用/);
    assert.equal(result.daily_basic.refresh_status, 'REFRESH_OK', 'other datasets still refresh');
    assert.equal(count(db), 5500);
    const l = log(db);
    assert.equal(l.refresh_status, 'REFRESH_FAILED');
    assert.match(l.message, /request failed/);
    const history = db.prepare("SELECT refresh_status FROM sync_history WHERE dataset = 'daily' AND key = ? ORDER BY synced_at, rowid").all(D).map(r => r.refresh_status);
    assert.deepEqual(history, ['REFRESH_OK', 'REFRESH_FAILED']);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

// ---------------------------------------------------------------- report level on the synthetic market

test('A/D/E: the report and MCP status show a bad refresh as DEGRADED, and recover after a good one', async () => {
  const live = openAshareDb();
  const dates = weekdays('20260105', 150);
  const day = dates.at(-1);
  seedMarket(live, dates);
  const good = Object.fromEntries(TABLES.map(t => [t, live.prepare(`SELECT * FROM ${t} WHERE trade_date = ?`).all(day)]));
  const counts = () => TABLES.map(t => live.prepare(`SELECT COUNT(*) n FROM ${t} WHERE trade_date = ?`).get(day).n);
  const watchlistRows = () => live.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(day).n;
  const status = async () => {
    closeAshareDb();
    return (await runAshareTool('ashare_data_status', { date: day })).content[0].text;
  };
  try {
    mockTushare((api, d) => (d === day ? good[api] : []));
    await syncTradeDate(live, day, 'refresh');
    const r1 = generateReport(live, day, 'live').report;
    assert.equal(r1.status, 'READY');
    const baseline = counts();

    // A: the 21:10 refresh of `daily` returns 55% of the market.
    mockTushare((api, d) => (d === day ? (api === 'daily' ? good.daily.slice(0, 33) : good[api]) : []));
    await syncTradeDate(live, day, 'refresh');
    assert.deepEqual(counts(), baseline);
    const q = checkQuality(live, day, false);
    assert.equal(q.cache_status, 'READY');
    assert.equal(q.status, 'DEGRADED', 'never an unqualified READY after a short refresh');
    assert.ok(q.reasons.some(r => /最新一次刷新 daily 不完整（返回 33 条，沿用上一次有效快照 60 条/.test(r)), q.reasons.join('|'));
    const r2 = generateReport(live, day, 'live').report;
    assert.equal(r2.status, 'DEGRADED');
    assert.equal(r2.data.quality.refresh.daily.refresh_status, 'REFRESH_INCOMPLETE');
    assert.ok(r2.risks.some(r => /数据降级：最新一次刷新 daily 不完整/.test(r)));
    assert.match(await status(), /DEGRADED[\s\S]*最新一次刷新 daily 不完整/);
    closeAshareDb();
    const md = (await runAshareTool('ashare_daily_report', { date: day })).content[0].text;
    assert.match(md, /（DEGRADED）[\s\S]*最新一次刷新 daily 不完整/);

    // D: the next refresh errors out entirely.
    mockTushare((api, d) => (d === day ? (api === 'adj_factor' ? 'error' : good[api]) : []));
    await syncTradeDate(live, day, 'refresh');
    assert.deepEqual(counts(), baseline);
    const r3 = generateReport(live, day, 'live').report;
    assert.equal(r3.status, 'DEGRADED');
    assert.ok(r3.data.quality.reasons.some(r => /adj_factor 请求失败/.test(r)));
    assert.ok(!r3.data.quality.reasons.some(r => /daily 不完整/.test(r)), 'daily recovered in the same run');

    // E: a good refresh clears the anomaly; the same-day watchlist is rebuilt, not duplicated.
    mockTushare((api, d) => (d === day ? good[api] : []));
    await syncTradeDate(live, day, 'refresh');
    const r4 = generateReport(live, day, 'live');
    assert.equal(r4.report.status, 'READY');
    assert.deepEqual(r4.report.data.quality.reasons, []);
    assert.deepEqual(counts(), baseline);
    assert.equal(watchlistRows(), r1.watchlist.count);
    assert.equal(r4.report.watchlist.count, r1.watchlist.count);
    assert.equal(latestReportMeta(live, day).report_id, r4.meta.report_id);
    assert.match(await status(), /数据质量：\*\*READY\*\*/);
  } finally {
    globalThis.fetch = originalFetch;
    closeAshareDb();
    live.close();
  }
});

test('B (report level): an incomplete first run is NOT_READY, the completed second run READY', async () => {
  const db = openAshareDb(':memory:');
  const dates = weekdays('20260105', 150);
  const day = dates.at(-1);
  seedMarket(db, dates);
  const good = Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} WHERE trade_date = ?`).all(day)]));
  for (const t of TABLES) db.prepare(`DELETE FROM ${t} WHERE trade_date = ?`).run(day);
  try {
    mockTushare((api, d) => (d === day ? good[api].slice(0, 33) : []));
    await syncTradeDate(db, day, 'refresh');
    const q = checkQuality(db, day, false);
    assert.equal(q.status, 'NOT_READY');
    assert.equal(q.cache_status, 'NOT_READY');
    mockTushare((api, d) => (d === day ? good[api] : []));
    await syncTradeDate(db, day, 'refresh');
    assert.equal(checkQuality(db, day, false).status, 'READY');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
