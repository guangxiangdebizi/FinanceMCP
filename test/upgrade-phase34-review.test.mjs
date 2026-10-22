import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { evaluateWatchlist } = await import('../build/ashare/evidence.js');
const { classifyEvidenceTier, legacyEvidenceTier } = await import('../build/ashare/evidenceTier.js');
const { buildBenchmarkComparison, FROZEN_FIVE_QUANTITIES } = await import('../build/portfolio/benchmarks.js');

const dir = mkdtempSync(join(tmpdir(), 'phase34-review-'));
let seq = 0;
const freshDb = () => openAshareDb(join(dir, `case-${seq += 1}.sqlite`));

// ---------------------------------------------------------------- F. evidence tiers

const forward = (overrides = {}) => ({
  type: 'TRUE_FORWARD_OBSERVATION', freeze_id: 'FRZ-1', rule_version: 'validation-1.0.0', implementation_hash: 'a'.repeat(64),
  range: { start: '20261102', end: '20270130' }, independent_dates: 60, mean_net_excess: 0.004, ci95: [0.001, 0.007], p_holm: 0.02,
  ...overrides,
});

test('legacy classifications map without implying out-of-sample validation', () => {
  assert.equal(legacyEvidenceTier('evidence_supported'), 'RESEARCH_SUPPORTED');
  assert.equal(legacyEvidenceTier('research_only'), 'UNVERIFIED');
  assert.equal(legacyEvidenceTier('contradicted'), 'REJECTED');
  // In-sample significance alone never reaches OUT_OF_SAMPLE_VALIDATED.
  assert.equal(classifyEvidenceTier({ legacy: 'evidence_supported' }).tier, 'RESEARCH_SUPPORTED');
  assert.equal(classifyEvidenceTier({}).tier, 'UNVERIFIED');
});

test('only a significant, adjusted, frozen true-forward result is OUT_OF_SAMPLE_VALIDATED', () => {
  assert.equal(classifyEvidenceTier({ legacy: 'evidence_supported', out_of_sample: forward() }).tier, 'OUT_OF_SAMPLE_VALIDATED');
  for (const type of ['RETROSPECTIVE_HOLDOUT', 'WALK_FORWARD_VALIDATION']) {
    const r = classifyEvidenceTier({ legacy: 'evidence_supported', out_of_sample: forward({ type }) });
    assert.equal(r.tier, 'RESEARCH_SUPPORTED');
    assert.ok(r.reasons.some(x => x.endsWith('cannot_establish_out_of_sample')));
  }
  const cases = [
    forward({ freeze_id: null }), forward({ rule_version: null }), forward({ range: null }), forward({ independent_dates: 59 }),
    forward({ p_holm: 0.2 }), forward({ ci95: [-0.001, 0.007] }), forward({ p_holm: null }), forward({ ci95: null }),
  ];
  for (const out_of_sample of cases) assert.notEqual(classifyEvidenceTier({ legacy: 'research_only', out_of_sample }).tier, 'OUT_OF_SAMPLE_VALIDATED');
  const rejected = classifyEvidenceTier({ legacy: 'evidence_supported', out_of_sample: forward({ mean_net_excess: -0.005, ci95: [-0.008, -0.002] }) });
  assert.equal(rejected.tier, 'REJECTED');
});

// ---------------------------------------------------------------- A. watchlist benchmark NULL handling

test('evaluateWatchlist does not treat a NULL market return as zero', () => {
  const db = freshDb();
  const days = ['20261012', '20261013', '20261014', '20261015'];
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], days.map(cal_date => ({ cal_date, is_open: 1 })));
  const bar = (ts_code, trade_date, open, close) => ({ ts_code, trade_date, open, high: Math.max(open, close), low: Math.min(open, close), close, vol: 1e6, amount: 1e6 });
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'], [
    bar('A.SZ', '20261013', 10, 10), bar('A.SZ', '20261014', 10, 11),
    bar('B.SZ', '20261013', 10, 10), bar('B.SZ', '20261014', 10, 11),
    bar('C.SZ', '20261013', 10, 10), bar('C.SZ', '20261014', 10, 10),
  ]);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [
    ...['A.SZ', 'C.SZ'].flatMap(ts_code => ['20261013', '20261014'].map(trade_date => ({ ts_code, trade_date, adj_factor: 1 }))),
    { ts_code: 'B.SZ', trade_date: '20261013', adj_factor: 1 }, { ts_code: 'B.SZ', trade_date: '20261014', adj_factor: null },
  ]);
  upsertRows(db, 'watchlist', ['trade_date', 'ts_code', 'score', 'rank', 'status', 'reason', 'entered_on'],
    [{ trade_date: '20261012', ts_code: 'A.SZ', score: 80, rank: 1, status: 'hold', reason: 'fixture', entered_on: '20261012' }]);
  const result = evaluateWatchlist(db, '20261012', '20261015', 2, 2);
  assert.equal(result.dates, 1);
  // Market = mean of the two priced stocks (10% and 0%) = 5%, not (10+null+0)/3.
  assert.equal(result.per_date[0].market_ret, 5);
  assert.equal(result.per_date[0].excess, 5);
  db.close();
});

// ---------------------------------------------------------------- D. benchmarks

function market({ dates, closeOf, skip = () => false }) {
  const db = freshDb();
  const codes = ['510300.SH', '511010.SH', '518880.SH', '513100.SH', ...Object.keys(FROZEN_FIVE_QUANTITIES)];
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], dates.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: dates[i - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    codes.map(ts_code => ({ ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' })));
  for (const ts_code of codes) for (const trade_date of dates) {
    if (skip(ts_code, trade_date)) continue;
    const close = closeOf(ts_code, trade_date);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
  }
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], codes.flatMap(ts_code => dates.map(trade_date => ({ ts_code, trade_date, adj_factor: 1 }))));
  return db;
}
const DATES = ['20261012', '20261013', '20261014', '20261015', '20261016', '20261019', '20261020'];
const closeOf = (code, date) => {
  const base = { '510300.SH': 4, '511010.SH': 1, '518880.SH': 5, '513100.SH': 2 }[code] ?? 1;
  return base * (1 + 0.01 * DATES.indexOf(date) * (code === '510300.SH' ? 1 : 2) * (DATES.indexOf(date) % 2 ? 1 : 0.5));
};

test('benchmarks report risk-adjusted ratios and excess only over identical observation windows', () => {
  const db = market({ dates: DATES, closeOf });
  const same = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261020' });
  assert.deepEqual(same.relative.map(r => r.id), same.benchmarks.map(b => b.id));
  const csi = same.benchmarks.find(b => b.id === 'csi300_etf_buy_hold');
  const basket = same.benchmarks.find(b => b.id === 'frozen_multi_asset_basket');
  const rel = same.relative.find(r => r.id === 'frozen_multi_asset_basket');
  assert.equal(rel.status, 'OK');
  assert.equal(rel.excess_return_pct_points, Math.round((basket.total_return_pct - csi.total_return_pct) * 100) / 100);
  assert.equal(same.relative.find(r => r.id === 'csi300_etf_buy_hold').excess_return_pct_points, 0);
  for (const b of same.benchmarks) assert.ok(b.risk_adjusted && /未年化/.test(b.risk_adjusted.note));

  // The five-ETF baseline is anchored at 20261016; an earlier requested start must not be compared as if equal.
  const earlier = buildBenchmarkComparison({ marketDb: db, start: '20261012', end: '20261020' });
  const five = earlier.relative.find(r => r.id === 'initial_five_etf_basket');
  assert.equal(five.status, 'UNAVAILABLE');
  assert.equal(five.excess_return_pct_points, null);
  assert.match(five.reason, /^observation_windows_differ/);
  assert.equal(earlier.benchmarks.find(b => b.id === 'initial_five_etf_basket').window.start, '20261016');
  db.close();
});

test('missing 510300.SH start keeps the benchmark UNAVAILABLE without shortening the window or swapping constituents', () => {
  const db = market({ dates: DATES, closeOf, skip: (code, date) => code === '510300.SH' && date === '20261012' });
  const result = buildBenchmarkComparison({ marketDb: db, start: '20261012', end: '20261020' });
  const csi = result.benchmarks.find(b => b.id === 'csi300_etf_buy_hold');
  assert.equal(csi.status, 'UNAVAILABLE');
  assert.equal(csi.reason, 'window_coverage_incomplete');
  assert.deepEqual(csi.missing_codes, ['510300.SH@20261012']);
  assert.equal(csi.total_return_pct, null);
  assert.equal(csi.risk_adjusted.return_to_window_vol, null);
  assert.equal(result.window.start, '20261012');
  // The basket contains 510300.SH: it is unavailable too, never rebuilt from the other three.
  const basket = result.benchmarks.find(b => b.id === 'frozen_multi_asset_basket');
  assert.equal(basket.status, 'UNAVAILABLE');
  assert.equal(result.relative.find(r => r.id === 'frozen_multi_asset_basket').excess_return_pct_points, null);
  assert.equal(basket.weights_status, 'approved');
  db.close();
});
