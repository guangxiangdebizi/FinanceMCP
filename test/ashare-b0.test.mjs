// Phase B0: regression tests for the data-layer defects found in the phase A review.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-b0-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows, logSync } = await import('../build/ashare/db.js');
const { stockHistory, financialHistory, marketData } = await import('../build/ashare/data.js');
const { checkQuality, syncSuspend } = await import('../build/ashare/ingest.js');
const { auditCache, auditDay, fillGaps, GAP_CHECK_MAX_AGE_DAYS } = await import('../build/ashare/audit.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 80);
const originalFetch = globalThis.fetch;
const DAILY_COLS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'];
const TABLES = ['daily', 'daily_basic', 'adj_factor', 'stk_limit'];

function freshDb() {
  const db = openAshareDb(':memory:');
  seedMarket(db, DATES);
  for (const d of DATES) logSync(db, 'suspend_d', d, 0, 'ok', '', { refresh_status: 'REFRESH_OK', write_mode: 'replaced' });
  return db;
}

/** Tushare stand-in answering from `source(api, params)`; records every request. */
function mockTushare(source) {
  const fetched = [];
  globalThis.fetch = async (_u, init) => {
    const { api_name: api, params, fields } = JSON.parse(init.body);
    fetched.push(`${api}:${params.trade_date ?? params.start_date}:${params.ts_code ?? 'all'}`);
    const rows = source(api, params);
    if (rows instanceof Error) return { ok: true, json: async () => ({ code: 40001, msg: rows.message }) };
    const cols = fields.split(',');
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  return fetched;
}

const dump = (db, table, where = '1=1', ...params) => db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ts_code, trade_date`).all(...params);

// ---------------------------------------------------------------- B0-1

test('B0-1: a hole in the history of a stock delisted later is a gap, not pending delisting', () => {
  const db = freshDb();
  // Delisted on DATES[70]; last bar DATES[65]; no bar on DATES[30] although it traded on DATES[31..65].
  const LATER = '600777.SH';
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'delist_date', 'list_status'],
    [{ ts_code: LATER, symbol: '600777', name: '后来退市', industry: '行业3', list_date: '20100101', delist_date: DATES[70], list_status: 'D' }]);
  for (const [i, d] of DATES.slice(0, 66).entries()) {
    if (i === 30 || i === 40) continue;
    upsertRows(db, 'daily', DAILY_COLS, [{ ts_code: LATER, trade_date: d, open: 5, high: 5, low: 5, close: 5, pre_close: 5, pct_chg: 0, vol: 1, amount: 1 }]);
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: LATER, trade_date: d, adj_factor: 1 }]);
  }
  // DATES[40]: a recorded suspension wins over every other class.
  upsertRows(db, 'suspend_d', ['ts_code', 'trade_date'], [{ ts_code: LATER, trade_date: DATES[40] }]);

  const hole = auditDay(db, DATES[30], DATES[29]);
  assert.deepEqual(hole.unexplained_sample, [LATER], 'the mid-history hole is found');
  assert.equal(hole.pending_delisting, 0);
  assert.equal(hole.status, 'GAP');
  const susp = auditDay(db, DATES[40], DATES[39]);
  assert.equal(susp.suspended, 1);
  assert.equal(susp.pending_delisting, 0);
  assert.equal(susp.unexplained_missing, 0);
  // After the last bar and before the delisting date: pending delisting (hindsight class), not a gap.
  for (const i of [66, 69]) {
    const tail = auditDay(db, DATES[i], DATES[i - 1]);
    assert.equal(tail.pending_delisting, 1, DATES[i]);
    assert.equal(tail.unexplained_missing, 0);
  }
  // Not listed any more from the delisting date on.
  assert.equal(auditDay(db, DATES[70], DATES[69]).pending_delisting, 0);
  // The data tool uses the same classes.
  const cov = stockHistory(db, { ts_code: LATER, start_date: DATES[28], end_date: DATES[72], adjust: 'none' }).coverage;
  assert.deepEqual(cov.missing_days, [DATES[30]]);
  assert.deepEqual(cov.suspended_days, [DATES[40]]);
  assert.deepEqual(cov.pending_delisting_days, DATES.slice(66, 70));
  const audit = auditCache(db, DATES[1], DATES.at(-1));
  assert.equal(audit.totals.unexplained_missing_stock_days, 1);
  assert.equal(audit.totals.pending_delisting_stock_days, 4);
});

test('B0-1: a delisted stock with no cached bars has no established last bar and remains a gap', () => {
  const db = freshDb();
  const code = '600778.SH';
  const day = DATES[30];
  upsertRows(db, 'stock_basic', ['ts_code', 'list_date', 'delist_date', 'list_status'], [
    { ts_code: code, list_date: '20100101', delist_date: DATES[70], list_status: 'D' },
  ]);
  assert.deepEqual(auditDay(db, day).unexplained_sample, [code]);
  assert.equal(auditDay(db, day).pending_delisting, 0);
  const h = stockHistory(db, { ts_code: code, start_date: day, end_date: day, adjust: 'none' });
  assert.deepEqual(h.coverage.missing_days, [day]);
  assert.deepEqual(h.coverage.pending_delisting_days, []);
});

// ---------------------------------------------------------------- B0-2

test('B0-2: one invalid bar is repaired for that stock only; other stocks keep their factors', async () => {
  const db = freshDb();
  const day = DATES[50];
  const BAD = STOCKS[3].ts_code;
  const NORMAL = STOCKS[4].ts_code;
  db.prepare('UPDATE daily SET high = low * 0.5 WHERE ts_code = ? AND trade_date = ?').run(BAD, day);
  const audit = auditCache(db, DATES[45], DATES[55]);
  const d = audit.days.find(x => x.trade_date === day);
  assert.equal(d.status, 'GAP');
  assert.deepEqual(d.invalid_bar_codes, [BAD]);

  const before = Object.fromEntries(TABLES.map(t => [t, dump(db, t, 'ts_code <> ?', BAD)]));
  const badOthers = TABLES.filter(t => t !== 'daily').map(t => [t, dump(db, t, 'ts_code = ?', BAD)]);
  // Upstream: the correct bar for BAD, and (on any whole-market request) a revised factor for NORMAL.
  const good = { ...dump(db, 'daily', 'ts_code = ? AND trade_date = ?', BAD, DATES[49])[0], trade_date: day };
  good.high = Math.max(good.open, good.close) * 1.01;
  good.low = Math.min(good.open, good.close) * 0.99;
  const fetched = mockTushare((api, p) => {
    if (p.ts_code) return api === 'daily' && p.ts_code === BAD ? [good] : [];
    if (api === 'adj_factor') return dump(db, 'adj_factor', 'trade_date = ?', p.trade_date).map(r => (r.ts_code === NORMAL ? { ...r, adj_factor: 1.25 } : r));
    return dump(db, api, 'trade_date = ?', p.trade_date);
  });
  try {
    await fillGaps(db, audit);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched, [`daily:${day}:${BAD}`], 'only the bad bar is requested');
  for (const t of TABLES) assert.deepEqual(dump(db, t, 'ts_code <> ?', BAD), before[t], `${t} of other stocks unchanged`);
  for (const [t, rows] of badOthers) assert.deepEqual(dump(db, t, 'ts_code = ?', BAD), rows, `${t} of the repaired stock unchanged`);
  assert.equal(db.prepare('SELECT adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date = ?').get(NORMAL, day).adj_factor, 1);
  assert.equal(auditCache(db, DATES[45], DATES[55]).days.find(x => x.trade_date === day).invalid_bars, 0);
});

test('B0-2: only a date with no quotes at all is refreshed as a whole-market snapshot', async () => {
  const db = freshDb();
  const day = DATES[60];
  const snapshot = Object.fromEntries(TABLES.map(t => [t, dump(db, t, 'trade_date = ?', day)]));
  db.prepare('DELETE FROM daily WHERE trade_date = ?').run(day);
  const fetched = mockTushare((api, p) => (p.ts_code ? [] : api === 'suspend_d' ? [] : snapshot[api] ?? []));
  const audit = auditCache(db, DATES[59], DATES[61]);
  try {
    await fillGaps(db, audit);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched.sort(), TABLES.map(t => `${t}:${day}:all`).sort());
  assert.equal(dump(db, 'daily', 'trade_date = ?', day).length, 60);
});

test('B0-2: every invalid bar is repaired even beyond the 200-code audit sample', async () => {
  const db = freshDb();
  const day = DATES[50];
  const template = dump(db, 'daily', 'trade_date = ?', day)[0];
  const codes = Array.from({ length: 205 }, (_, i) => `${601000 + i}.SH`);
  upsertRows(db, 'daily', DAILY_COLS, codes.map(ts_code => ({ ...template, ts_code })));
  for (const table of TABLES.filter(t => t !== 'daily')) {
    const row = dump(db, table, 'trade_date = ?', day)[0];
    upsertRows(db, table, Object.keys(row), codes.map(ts_code => ({ ...row, ts_code })));
  }
  db.prepare('UPDATE daily SET high = low * 0.5 WHERE trade_date = ? AND ts_code >= ?').run(day, codes[0]);
  const a = auditCache(db, day, day);
  assert.equal(a.days[0].invalid_bars, 205);
  assert.equal(a.days[0].invalid_bar_codes.length, 200);
  const untouched = dump(db, 'adj_factor');
  const fetched = mockTushare((api, p) => api === 'daily' ? [{ ...template, ts_code: p.ts_code }] : []);
  try { await fillGaps(db, a); } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetched.length, 205);
  assert.equal(auditDay(db, day).invalid_bars, 0);
  assert.deepEqual(dump(db, 'adj_factor'), untouched);
});

test('B0-2: missing daily basics and limits are repaired per stock without rewriting other datasets', async () => {
  const db = freshDb();
  const day = DATES[50];
  const code = STOCKS[10].ts_code;
  const missing = Object.fromEntries(['daily_basic', 'stk_limit'].map(t => [t, dump(db, t, 'ts_code = ? AND trade_date = ?', code, day)]));
  for (const table of Object.keys(missing)) db.prepare(`DELETE FROM ${table} WHERE ts_code = ? AND trade_date = ?`).run(code, day);
  const unchanged = Object.fromEntries(TABLES.map(t => [t, dump(db, t)]));
  const fetched = mockTushare((api, p) => p.ts_code === code ? missing[api] ?? [] : []);
  try { await fillGaps(db, auditCache(db, day, day)); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(fetched, [`daily_basic:${day}:${code}`, `stk_limit:${day}:${code}`]);
  for (const table of ['daily', 'adj_factor']) assert.deepEqual(dump(db, table), unchanged[table]);
  for (const table of Object.keys(missing)) {
    assert.deepEqual(dump(db, table, 'ts_code = ? AND trade_date = ?', code, day), missing[table]);
    assert.deepEqual(dump(db, table, 'ts_code <> ? OR trade_date <> ?', code, day), unchanged[table]);
  }
});

test('B0-2: per-stock gap repair rejects suspension rows outside the requested stock and date', async () => {
  const db = freshDb();
  const day = DATES[30], code = STOCKS[9].ts_code;
  db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(code, day);
  mockTushare(api => api === 'suspend_d' ? [
    { ts_code: STOCKS[10].ts_code, trade_date: day, suspend_type: 'S' },
    { ts_code: code, trade_date: DATES[29], suspend_type: 'S' },
  ] : []);
  try { await fillGaps(db, auditCache(db, day, day)); } finally { globalThis.fetch = originalFetch; }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suspend_d').get().n, 0);
  assert.deepEqual(auditDay(db, day).upstream_missing_sample, [code]);
});

// ---------------------------------------------------------------- B0-3

test('B0-3: an as-of financial query reveals nothing announced or ending after as_of', () => {
  const db = freshDb();
  const code = STOCKS[0].ts_code;
  upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'ocf_to_profit'], [
    { ts_code: code, end_date: '20251231', ann_date: '20260320', roe: 10, ocf_to_profit: 110 },
    { ts_code: code, end_date: '20260331', ann_date: '20260428', roe: 3, ocf_to_profit: 90 },
    // Anomaly: announced before its period ended.
    { ts_code: code, end_date: '20260630', ann_date: '20260410', roe: 5, ocf_to_profit: 80 },
    { ts_code: code, end_date: '20251231', ann_date: '20260601', roe: 9, ocf_to_profit: 100 },
  ]);
  const q = financialHistory(db, { ts_code: code, as_of_date: '20260415', include_revisions: true });
  const text = JSON.stringify(q);
  assert.deepEqual(q.periods.map(p => [p.end_date, p.ann_date, p.values.roe]), [['20251231', '20260320', 10]]);
  assert.equal(q.periods[0].announcements, 1, 'the 0601 restatement is not counted');
  for (const future of ['20260630', '20260428', '20260601', '20260331', 'hidden']) assert.equal(text.includes(future), false, future);
  assert.deepEqual(q.anomalies, []);
  // The anomaly is still reported, in the cache audit.
  const audit = auditCache(db, DATES[0], DATES[5]);
  assert.deepEqual(audit.global.fina_ann_date_before_period_end.map(r => r.end_date), ['20260630']);
  // Values: only ann_date ≤ as_of, anomalies excluded.
  const later = financialHistory(db, { ts_code: code, as_of_date: '20260701' });
  assert.deepEqual(later.periods.map(p => [p.end_date, p.values.roe]), [['20260331', 3], ['20251231', 9]]);
  // Once both its period end and its announcement are in the past, the excluded record is disclosed.
  assert.deepEqual(later.anomalies.map(a => a.end_date), ['20260630']);
  assert.equal(later.periods.some(p => p.end_date === '20260630'), false, 'anomalous record never used');
});

// ---------------------------------------------------------------- B0-4

test('B0-4: a failed suspension refresh keeps the cache, degrades quality and is disclosed; success recovers', async () => {
  const db = freshDb();
  const day = DATES.at(-1);
  const SUSP = STOCKS[11].ts_code;
  db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(SUSP, day);
  upsertRows(db, 'suspend_d', ['ts_code', 'trade_date'], [{ ts_code: SUSP, trade_date: day }]);
  logSync(db, 'suspend_d', day, 1, 'ok', '', { refresh_status: 'REFRESH_OK', after_rows: 1, write_mode: 'replaced' });
  assert.equal(checkQuality(db, day, false).status, 'READY');

  mockTushare(() => new Error('参数异常：注入错误'));
  try {
    assert.equal((await syncSuspend(db, day, true)).refresh_status, 'REFRESH_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suspend_d WHERE trade_date = ?').get(day).n, 1, 'old data kept');
  const q = checkQuality(db, day, false);
  assert.equal(q.status, 'DEGRADED');
  assert.equal(q.cache_status, 'READY');
  assert.ok(q.reasons.some(r => /suspend_d 请求失败.*沿用已有缓存/.test(r)), q.reasons.join('|'));
  const h = stockHistory(db, { ts_code: SUSP, start_date: DATES.at(-3), end_date: day });
  assert.deepEqual(h.coverage.suspended_days, [day], 'classification still uses the earlier snapshot');
  assert.deepEqual(h.coverage.suspend_refresh_failed_days, [day]);
  assert.equal(h.data_quality.trade_date, day, 'quality follows the query endpoint even when the stock has no bar there');
  assert.equal(h.data_quality.status, 'DEGRADED');
  const onlySuspended = stockHistory(db, { ts_code: SUSP, start_date: day, end_date: day });
  assert.equal(onlySuspended.rows.length, 0);
  assert.equal(onlySuspended.data_quality.status, 'DEGRADED', 'an entirely suspended query still reports quality');
  assert.ok(h.warnings.some(w => /停牌数据最新一次刷新失败/.test(w)));
  assert.equal(stockHistory(db, { ts_code: STOCKS[0].ts_code, end_date: day, limit: 3 }).data_quality.status, 'DEGRADED', 'queries ending on that day carry the status');
  const m = marketData(db, { end_date: day });
  assert.equal(m.days[0].breadth.suspended, 1);
  assert.equal(m.days[0].breadth.suspended_source, 'stale_cache');
  assert.equal(m.days[0].data_quality.status, 'DEGRADED');

  mockTushare((api, p) => (api === 'suspend_d' ? [{ ts_code: SUSP, trade_date: p.trade_date }] : []));
  try {
    assert.equal((await syncSuspend(db, day)).refresh_status, 'REFRESH_OK', 'an earlier failed refresh is retried even with a valid stored snapshot');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(checkQuality(db, day, false).status, 'READY');
  assert.equal(marketData(db, { end_date: day }).days[0].breadth.suspended_source, 'cache');
  assert.deepEqual(stockHistory(db, { ts_code: SUSP, start_date: DATES.at(-3), end_date: day }).coverage.suspend_refresh_failed_days, []);
});

test('B0-4: audit --fix retries failed suspension refreshes over a complete snapshot', async () => {
  const db = freshDb();
  const day = DATES.at(-1);
  logSync(db, 'suspend_d', day, 0, 'ok', 'request failed: injected', { refresh_status: 'REFRESH_FAILED', before_rows: 0, after_rows: 0, write_mode: 'none' });
  const a = auditCache(db, day, day);
  assert.equal(a.days[0].suspend_synced, true);
  const fetched = mockTushare(() => []);
  let actions;
  try { actions = await fillGaps(db, a); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(fetched, [`suspend_d:${day}:all`]);
  assert.equal(actions[0].action, 'sync_suspend_d');
  assert.equal(checkQuality(db, day, false).status, 'READY');
});

test('B0-4: a suspension refresh failing on a date never synced is unavailable, not stale', async () => {
  const db = freshDb();
  const day = DATES.at(-2);
  db.prepare("DELETE FROM sync_log WHERE dataset = 'suspend_d' AND key = ?").run(day);
  db.prepare("DELETE FROM sync_history WHERE dataset = 'suspend_d' AND key = ?").run(day);
  mockTushare(() => new Error('参数异常：注入错误'));
  try {
    await syncSuspend(db, day, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const q = checkQuality(db, day, false);
  assert.equal(q.status, 'DEGRADED');
  assert.ok(q.reasons.some(r => /此前无成功快照/.test(r)));
  const m = marketData(db, { end_date: day });
  assert.equal(m.days[0].breadth.suspended, null);
  assert.equal(m.days[0].breadth.suspended_source, 'unavailable');
});

test('gap_check: an upstream "nothing" expires and is asked again', async () => {
  const db = freshDb();
  const day = DATES[20];
  const CODE = STOCKS[12].ts_code;
  const bar = dump(db, 'daily', 'ts_code = ? AND trade_date = ?', CODE, day)[0];
  db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(CODE, day);
  const old = new Date(Date.now() - (GAP_CHECK_MAX_AGE_DAYS + 1) * 86400_000).toISOString();
  db.prepare('INSERT INTO gap_check (ts_code, trade_date, checked_at, upstream_daily, upstream_suspended) VALUES (?,?,?,0,0)').run(CODE, day, old);
  const a = auditDay(db, day, DATES[19]);
  assert.deepEqual(a.upstream_check_expired, [CODE]);
  assert.equal(a.upstream_missing, 0);
  assert.equal(a.status, 'WARN', 'an expired check is a re-check, not a cache gap');
  const history = () => stockHistory(db, { ts_code: CODE, start_date: day, end_date: day, adjust: 'none' }).coverage;
  assert.deepEqual(history().upstream_missing_days, []);
  assert.deepEqual(history().upstream_check_expired_days, [day]);
  assert.equal(history().upstream_checked_at[day], old);
  const recent = new Date().toISOString();
  db.prepare('UPDATE gap_check SET checked_at = ? WHERE ts_code = ?').run(recent, CODE);
  assert.equal(auditDay(db, day, DATES[19]).upstream_missing, 1);
  assert.deepEqual(history().upstream_missing_days, [day]);
  assert.deepEqual(history().upstream_check_expired_days, []);
  for (const invalid of ['invalid-timestamp', new Date(Date.now() + 86400_000).toISOString()]) {
    db.prepare('UPDATE gap_check SET checked_at = ? WHERE ts_code = ?').run(invalid, CODE);
    assert.deepEqual(auditDay(db, day, DATES[19]).upstream_check_expired, [CODE]);
    assert.deepEqual(history().upstream_check_expired_days, [day]);
  }
  db.prepare('UPDATE gap_check SET checked_at = ? WHERE ts_code = ?').run(old, CODE);
  // Upstream has the bar now.
  const fetched = mockTushare((api, p) => (p.ts_code === CODE && api === 'daily' ? [bar] : []));
  try {
    await fillGaps(db, auditCache(db, day, day));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched, [`daily:${day}:${CODE}`]);
  const g = db.prepare('SELECT * FROM gap_check WHERE ts_code = ? AND trade_date = ?').get(CODE, day);
  assert.equal(g.upstream_daily, 1);
  assert.ok(g.checked_at > old);
  assert.equal(auditDay(db, day, DATES[19]).status, 'OK');
});
