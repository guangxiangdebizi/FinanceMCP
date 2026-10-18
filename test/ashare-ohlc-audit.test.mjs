// Phase B P0: NULL OHLC must be detected by the cache audit and the quality gate.
//
// SQLite comparisons with NULL are NULL, not true, so the pre-1.2.0 predicate
// (`open <= 0`, `vol < 0`, ...) silently passed a NULL open/high/low/vol. Each
// case below is run as a separate scenario: audit classification, quality
// status, repair scope of `audit --fix`, and V1 factor/score parity.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-ohlc-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows, logSync } = await import('../build/ashare/db.js');
const { checkQuality, INVALID_BAR_SQL } = await import('../build/ashare/ingest.js');
const { AUDIT_VERSION, auditCache, auditDay, fillGaps } = await import('../build/ashare/audit.js');
const { analyzeMarket, sourceQualityForDate } = await import('../build/ashare/engine.js');
const { scanMarket } = await import('../build/ashare/analysis.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 150);
const DATE = DATES.at(-1);
// The oldest bar of the scan window: inside sourceQualityForDate's 260-day window,
// outside every indicator window (MA20/MA60, ret20/ret60, RSI14, ATR14), so a
// NULL there exercises the detection path without changing any V1 number.
const MUTATED = DATES[0];
const BAD = STOCKS[35].ts_code;
const originalFetch = globalThis.fetch;

const DAILY_COLS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'];
const TABLES = ['daily', 'daily_basic', 'adj_factor', 'stk_limit'];

function freshDb() {
  const db = openAshareDb(':memory:');
  seedMarket(db, DATES);
  for (const d of DATES) logSync(db, 'suspend_d', d, 0, 'ok', '', { refresh_status: 'REFRESH_OK', write_mode: 'replaced' });
  // A report for every stock keeps the whole fixture eligible, so V1 scores and
  // ranks are a meaningful baseline.
  upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'],
    STOCKS.map(s => ({ ts_code: s.ts_code, end_date: '20260630', ann_date: '20260801', roe: 10, netprofit_yoy: 10, ocf_to_profit: 110, debt_to_assets: 40, eps: 1 })));
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
const scoreView = snapshot => snapshot.rows.map(r => ({ ts_code: r.ts_code, score: r.score, rank: r.rank, eligible: r.eligible, components: r.components }));

/** Apply one defect to BAD on MUTATED. `illegal` means a real high < low relation. */
function mutate(db, column, value) {
  if (value === 'illegal') db.prepare('UPDATE daily SET high = low * 0.5 WHERE ts_code = ? AND trade_date = ?').run(BAD, MUTATED);
  else db.prepare(`UPDATE daily SET ${column} = ? WHERE ts_code = ? AND trade_date = ?`).run(value, BAD, MUTATED);
}

const CASES = [
  { name: 'open', column: 'open', value: null, kind: 'null_open' },
  { name: 'high', column: 'high', value: null, kind: 'null_high' },
  { name: 'low', column: 'low', value: null, kind: 'null_low' },
  { name: 'close', column: 'close', value: null, kind: 'null_close' },
  { name: 'illegal high < low', column: 'high', value: 'illegal', kind: 'high_low' },
];

test('audit predicate is NULL-safe and versioned', () => {
  assert.equal(AUDIT_VERSION, 'audit-1.2.0');
  for (const field of ['open', 'high', 'low', 'close', 'vol', 'amount']) {
    assert.ok(INVALID_BAR_SQL.includes(`(${field} IS NULL)`), `${field} NULL is tested explicitly`);
  }
  // The union still carries every non-NULL rule from audit-1.1.0.
  for (const expr of ['open <= 0', 'high <= 0', 'low <= 0', 'close <= 0', 'high < low', 'close > high * 1.0001',
    'close < low * 0.9999', 'open > high * 1.0001', 'open < low * 0.9999', 'vol < 0', 'amount < 0',
    'vol > 0 AND (amount IS NULL OR amount <= 0)']) {
    assert.ok(INVALID_BAR_SQL.includes(expr), expr);
  }
});

for (const c of CASES) {
  test(`NULL/illegal OHLC (${c.name}): audit, quality, repair scope and V1 parity`, async () => {
    const db = freshDb();
    const cleanBar = dump(db, 'daily', 'ts_code = ? AND trade_date = ?', BAD, MUTATED)[0];
    const baseline = analyzeMarket(db, { date: DATE });
    const baselineScores = scoreView(baseline);
    assert.equal(baseline.universe.eligible, STOCKS.length, 'fixture baseline is fully eligible');
    assert.equal(checkQuality(db, MUTATED, false).status, 'READY', 'clean fixture day starts READY');
    assert.equal(auditDay(db, MUTATED).status, 'OK', 'clean fixture day starts OK');

    mutate(db, c.column, c.value);

    // a. The audit flags the day as GAP and names exactly the affected stock.
    const day = auditDay(db, MUTATED);
    assert.equal(day.status, 'GAP');
    assert.equal(day.invalid_bars, 1);
    assert.deepEqual(day.invalid_bar_codes, [BAD]);
    assert.equal(day.invalid_bar_kinds[c.kind], 1, `${c.kind} count`);
    assert.ok(day.issues.some(issue => issue.includes(c.kind)), day.issues.join(' | '));

    // b. The quality gate can no longer report READY.
    const q = checkQuality(db, MUTATED, false);
    assert.equal(q.status, 'NOT_READY');
    assert.equal(q.cache_status, 'NOT_READY');
    assert.ok(q.anomalies.invalid_bar >= 1, 'same predicate as the audit');
    assert.ok(q.reasons.some(reason => reason.includes('OHLC')), q.reasons.join(' | '));
    if (c.kind.startsWith('null_') && c.kind !== 'null_vol' && c.kind !== 'null_amount') {
      assert.equal(q.anomalies.null_ohlc, 1, 'NULL OHLC is counted explicitly');
      assert.ok(q.reasons.some(reason => reason.includes('空值')));
    }

    // c. Engine: technical observations are masked and signals suppressed, while
    //    the V1 formula is untouched.
    const quality = sourceQualityForDate(db, DATE);
    assert.equal(quality.get(BAD)?.technical_invalid, true);
    const snapshot = analyzeMarket(db, { date: DATE });
    // Every other stock keeps its exact clean-run score, rank and components.
    const baselineByCode = new Map(baselineScores.map(r => [r.ts_code, r]));
    const othersChanged = scoreView(snapshot).filter(r => r.ts_code !== BAD && JSON.stringify(r) !== JSON.stringify(baselineByCode.get(r.ts_code)));
    assert.deepEqual(othersChanged, [], 'V1 scores, ranks and components of every other stock are byte-identical to the clean run');
    // The engine still reproduces the legacy V1 formula exactly on this cache,
    // for the affected stock too: no scoring rule changed.
    const legacy = scanMarket(db, DATE).rows;
    for (const r of snapshot.rows) {
      const l = legacy.find(x => x.ts_code === r.ts_code);
      assert.equal(r.score, l.score ?? null, `${r.ts_code} V1 score equals legacy scan`);
      assert.equal(r.rank, l.rank ?? null, `${r.ts_code} V1 rank equals legacy scan`);
    }
    const observed = snapshot.rows.find(r => r.ts_code === BAD);
    for (const key of ['ret20', 'ret60', 'ma20', 'ma60', 'above_ma20', 'above_ma60', 'ma20_rising', 'ma60_rising', 'rsi14', 'atr_pct']) {
      assert.equal(observed.raw[key], null, `raw.${key}`);
    }
    for (const key of ['ret60', 'ret20', 'trend', 'rsi_fit', 'volatility_fit']) assert.equal(observed.normalized[key], null, `normalized.${key}`);
    assert.deepEqual(observed.signals, []);
    assert.ok(observed.quality.risk_flags.some(flag => /source OHLC/.test(flag)));
    // open/high/low are not inputs to V1's indicator recursion, so even the
    // affected stock keeps its clean score. close is (EMA-based RSI/ATR read
    // the whole window), so its score may move with the data while the formula
    // stays exact — the assertion above proves the formula did not change.
    if (c.column !== 'close') {
      assert.equal(observed.score, baselineByCode.get(BAD).score, 'V1 score of the affected stock is unchanged');
      assert.equal(observed.rank, baselineByCode.get(BAD).rank, 'V1 rank of the affected stock is unchanged');
    } else {
      assert.equal(observed.rank, baselineByCode.get(BAD).rank, 'V1 rank of the affected stock is unchanged');
    }

    // d. `audit --fix` repairs that stock and date only, and the day recovers.
    const others = Object.fromEntries(TABLES.map(t => [t, dump(db, t, 'NOT (ts_code = ? AND trade_date = ?)', BAD, MUTATED)]));
    const fetched = mockTushare((api, p) => (api === 'daily' && p.ts_code === BAD && p.start_date === MUTATED && p.end_date === MUTATED ? [cleanBar] : []));
    let actions;
    try { actions = await fillGaps(db, auditCache(db, MUTATED, MUTATED)); } finally { globalThis.fetch = originalFetch; }
    assert.deepEqual(fetched, [`daily:${MUTATED}:${BAD}`], 'only the invalid stock and date are requested');
    assert.deepEqual(actions.filter(a => a.action.startsWith('repair_')), [{ trade_date: MUTATED, action: `repair_bar ${BAD}`, result: { rows: 1 } }]);
    for (const t of TABLES) assert.deepEqual(dump(db, t, 'NOT (ts_code = ? AND trade_date = ?)', BAD, MUTATED), others[t], `${t} of every other stock/day is unchanged`);
    assert.equal(auditDay(db, MUTATED).invalid_bars, 0);
    assert.equal(auditDay(db, MUTATED).status, 'OK');
    assert.equal(checkQuality(db, MUTATED, false).status, 'READY', 'quality recovers after the repair');
    // The repaired cache is again exactly the clean baseline.
    assert.equal(sourceQualityForDate(db, DATE).has(BAD), false);
    assert.deepEqual(scoreView(analyzeMarket(db, { date: DATE })), baselineScores);
  });
}

test('a day with NULL OHLC is NOT_READY even when every coverage ratio is fine', () => {
  const db = freshDb();
  const mid = DATES[100];
  const clean = checkQuality(db, mid, false);
  assert.equal(clean.status, 'READY');
  for (const [name, ratio] of Object.entries(clean.coverage)) {
    if (name === 'daily_vs_prev') assert.ok(ratio >= 0.97, name);
    else assert.equal(ratio, 1, name);
  }
  db.prepare('UPDATE daily SET low = NULL WHERE ts_code = ? AND trade_date = ?').run(STOCKS[8].ts_code, mid);
  const q = checkQuality(db, mid, false);
  assert.equal(q.status, 'NOT_READY');
  assert.equal(q.anomalies.null_ohlc, 1);
  // Coverage is still perfect: only the anomaly forces the status.
  assert.equal(q.coverage.daily_vs_listed, 1);
  assert.equal(q.coverage.daily_basic_vs_daily, 1);
  assert.equal(q.coverage.adj_factor_vs_daily, 1);
  assert.equal(q.coverage.stk_limit_vs_daily, 1);
  assert.ok(q.reasons.every(reason => !reason.includes('覆盖率')), 'no coverage reason is involved');
});

test('volume/amount NULL policy is explicit and consistent between audit and quality', () => {
  const db = freshDb();
  const day = DATES[50];
  const [volNull, amountNull, zeroBoth] = [STOCKS[0].ts_code, STOCKS[1].ts_code, STOCKS[2].ts_code];
  db.prepare('UPDATE daily SET vol = NULL WHERE ts_code = ? AND trade_date = ?').run(volNull, day);
  db.prepare('UPDATE daily SET amount = NULL WHERE ts_code = ? AND trade_date = ?').run(amountNull, day);
  // vol = 0 with amount = 0 is a genuine no-trade bar and stays valid.
  db.prepare('UPDATE daily SET vol = 0, amount = 0 WHERE ts_code = ? AND trade_date = ?').run(zeroBoth, day);

  const d = auditDay(db, day);
  assert.equal(d.status, 'GAP');
  assert.deepEqual(d.invalid_bar_codes, [amountNull, volNull].sort());
  assert.equal(d.invalid_bar_kinds.null_vol, 1);
  assert.equal(d.invalid_bar_kinds.null_amount, 1);
  assert.equal(d.invalid_bar_kinds.missing_amount, 1, 'vol > 0 with NULL amount');
  const q = checkQuality(db, day, false);
  assert.equal(q.status, 'NOT_READY');
  assert.equal(q.anomalies.null_vol, 1);
  assert.equal(q.anomalies.null_amount, 1);
  assert.equal(q.anomalies.invalid_bar, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily WHERE trade_date = ? AND (' + INVALID_BAR_SQL + ')').get(day).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily WHERE ts_code = ? AND trade_date = ? AND (' + INVALID_BAR_SQL + ')').get(zeroBoth, day).n, 0,
    'vol = 0 with amount = 0 is not invalid');

  // A zero-volume bar with a missing amount is missing evidence, not a zero.
  db.prepare('UPDATE daily SET vol = 0 WHERE ts_code = ? AND trade_date = ?').run(amountNull, day);
  assert.equal(auditDay(db, day).invalid_bar_kinds.null_amount, 1);
  assert.equal(auditDay(db, day).invalid_bar_kinds.missing_amount, 0, 'no volume, so no volume-without-turnover claim');
  assert.deepEqual(auditDay(db, day).invalid_bar_codes, [amountNull, volNull].sort());
});

test('repair worklist follows the NULL-safe predicate beyond the display sample', async () => {
  const db = freshDb();
  const day = DATES[60];
  const template = dump(db, 'daily', 'trade_date = ?', day)[0];
  const codes = Array.from({ length: 205 }, (_, i) => `${601000 + i}.SH`);
  upsertRows(db, 'daily', DAILY_COLS, codes.map(ts_code => ({ ...template, ts_code })));
  for (const table of TABLES.filter(t => t !== 'daily')) {
    const row = dump(db, table, 'trade_date = ?', day)[0];
    upsertRows(db, table, Object.keys(row), codes.map(ts_code => ({ ...row, ts_code })));
  }
  // Every one of the 205 has a NULL open; the 60 fixture stocks stay valid.
  db.prepare('UPDATE daily SET open = NULL WHERE trade_date = ? AND ts_code >= ?').run(day, codes[0]);
  const a = auditCache(db, day, day);
  assert.equal(a.days[0].invalid_bars, 205);
  assert.equal(a.days[0].invalid_bar_codes.length, 200, 'display sample stays bounded');
  assert.equal(a.days[0].invalid_bar_kinds.null_open, 205);
  const bars = new Map(codes.map(code => [code, dump(db, 'daily', 'ts_code = ? AND trade_date = ?', code, day)[0]]));
  // Upstream returns each stored bar with a valid open.
  const fixed = code => ({ ...bars.get(code), open: bars.get(code).close });
  const fetched = mockTushare((api, p) => (api === 'daily' && p.ts_code ? [fixed(p.ts_code)] : []));
  try { await fillGaps(db, a); } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetched.length, 205);
  assert.ok(fetched.every(request => request.startsWith(`daily:${day}:`)), 'every request is that date');
  assert.equal(new Set(fetched.map(request => request.split(':')[2])).size, 205);
  assert.equal(auditDay(db, day).invalid_bars, 0);
  assert.equal(checkQuality(db, day, false).status, 'READY');
});
