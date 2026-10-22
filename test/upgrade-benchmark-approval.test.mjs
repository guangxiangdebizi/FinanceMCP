import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { buildBenchmarkComparison, BENCHMARK_DEFINITION_VERSION } = await import('../build/portfolio/benchmarks.js');
const { BASKET_DEFINITIONS, basketDefinition, CURRENT_BASKET_VERSION } = await import('../build/portfolio/benchmarkDefinitions.js');
const { calculateFees, feeRulesFor } = await import('../build/portfolio/fees.js');

const dir = mkdtempSync(join(tmpdir(), 'bench-approval-'));
let seq = 0;
const CODES = ['510300.SH', '511010.SH', '518880.SH', '513100.SH', '159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];
const DATES = ['20261012', '20261013', '20261014', '20261015', '20261016', '20261019', '20261020', '20261021', '20261022', '20261023'];
const closeOf = (code, date) => 2 + CODES.indexOf(code) * 0.1 + DATES.indexOf(date) * 0.01;
function market({ skip = () => false, withAdj = true } = {}) {
  const db = openAshareDb(join(dir, `m-${seq += 1}.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], DATES.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: DATES[i - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    CODES.map(ts_code => ({ ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' })));
  for (const ts_code of CODES) for (const trade_date of DATES) {
    if (skip(ts_code, trade_date)) continue;
    const close = closeOf(ts_code, trade_date);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
  }
  if (withAdj) upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], CODES.flatMap(ts_code => DATES.map(trade_date => ({ ts_code, trade_date, adj_factor: 1 }))));
  return db;
}
const basketOf = r => r.benchmarks.find(b => b.id === 'frozen_multi_asset_basket');

test('the approved version is appended, the provisional one is preserved unchanged', () => {
  assert.deepEqual(BASKET_DEFINITIONS.map(d => d.version), ['r2-benchmarks-1.0.0', 'r2-benchmarks-1.1.0']);
  const [old, current] = BASKET_DEFINITIONS;
  assert.equal(old.status, 'provisional_pending_user_approval');
  assert.equal(old.approved_on, null);
  assert.equal(current.status, 'approved');
  assert.equal(current.approved_on, '20261022');
  assert.equal(current.supersedes, old.version);
  assert.equal(CURRENT_BASKET_VERSION, BENCHMARK_DEFINITION_VERSION);
  assert.deepEqual({ ...current.weights }, { '510300.SH': 0.40, '511010.SH': 0.25, '518880.SH': 0.15, '513100.SH': 0.20 });
  assert.equal(Object.values(current.weights).reduce((a, b) => a + b, 0).toFixed(10), '1.0000000000');
  assert.equal(current.conventions.initial_capital_cents, 1_000_000);
  assert.match(current.conventions.rebalancing, /No rebalancing/);
  assert.throws(() => { old.status = 'approved'; });
  assert.throws(() => basketDefinition('r2-benchmarks-9.9.9'), /Unknown benchmark definition/);
});

test('default comparison uses the approved version; the old version stays reproducible and unapproved', () => {
  const db = market();
  const now = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' });
  assert.equal(now.definition_version, 'r2-benchmarks-1.1.0');
  assert.equal(basketOf(now).weights_status, 'approved');
  assert.equal(basketOf(now).definition.approved_on, '20261022');
  assert.equal(basketOf(now).status, 'OK');
  const old = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023', definition_version: 'r2-benchmarks-1.0.0' });
  assert.equal(old.definition_version, 'r2-benchmarks-1.0.0');
  assert.equal(basketOf(old).weights_status, 'provisional_pending_user_approval');
  assert.equal(basketOf(old).definition.comparison_basis, 'NOT_APPROVED');
  assert.equal(basketOf(old).total_return_pct, basketOf(now).total_return_pct, 'same weights, same numbers; only the status differs');
  // 510300 buy-and-hold and the initial five remain.
  assert.deepEqual(now.benchmarks.map(b => b.id), ['csi300_etf_buy_hold', 'frozen_multi_asset_basket', 'initial_five_etf_basket']);
  db.close();
});

test('windows starting before 2026-10-22 are labelled retrospective; later starts are prospective-eligible', () => {
  const db = market();
  const retro = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' });
  assert.equal(basketOf(retro).definition.comparison_basis, 'RETROSPECTIVE_COMPARISON');
  assert.match(basketOf(retro).definition.comparison_label, /回顾性对照/);
  assert.equal(retro.basket_definition.comparison_basis, 'RETROSPECTIVE_COMPARISON');
  assert.ok(basketOf(retro).disclosures.some(text => /回顾性对照/.test(text)));
  const forward = buildBenchmarkComparison({ marketDb: db, start: '20261022', end: '20261023' });
  assert.equal(basketOf(forward).definition.comparison_basis, 'PROSPECTIVE_ELIGIBLE');
  assert.doesNotMatch(basketOf(forward).definition.comparison_label, /回顾性对照：/);
  db.close();
});

test('common start/end is enforced: unequal windows give no excess return and nothing is trimmed', () => {
  const db = market();
  const result = buildBenchmarkComparison({ marketDb: db, start: '20261012', end: '20261023' });
  assert.equal(result.window_alignment.all_aligned, false, 'the five-ETF baseline starts at 20261016');
  assert.equal(result.window_alignment.windows.initial_five_etf_basket.start, '20261016');
  assert.equal(result.window_alignment.windows.frozen_multi_asset_basket.start, '20261012');
  assert.equal(result.relative.find(r => r.id === 'initial_five_etf_basket').status, 'UNAVAILABLE');
  assert.equal(result.relative.find(r => r.id === 'frozen_multi_asset_basket').status, 'OK');
  const aligned = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' });
  assert.equal(aligned.window_alignment.all_aligned, true);
  assert.deepEqual(basketOf(aligned).window, aligned.benchmarks[0].window);
  db.close();
});

test('a missing component price is UNAVAILABLE with a backfill hint; no window shortening or substitution', () => {
  for (const code of ['511010.SH', '518880.SH', '513100.SH']) {
    const db = market({ skip: (c, d) => c === code && d === '20261016' });
    const result = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' });
    const basket = basketOf(result);
    assert.equal(basket.status, 'UNAVAILABLE', code);
    assert.equal(basket.reason, 'leg_not_cached');
    assert.deepEqual(basket.missing_codes, [`${code}@20261016`]);
    assert.equal(basket.total_return_pct, null);
    assert.equal(basket.weights_status, 'approved', 'approval status still shown when data is missing');
    assert.match(basket.backfill.command, /etf-sync/);
    assert.equal(result.window.start, '20261016');
    assert.equal(result.benchmarks[0].status, 'OK', 'buy-and-hold 510300 is unaffected');
    db.close();
  }
});

test('513100 cross-border premium/NAV and price gaps are disclosed', () => {
  const db = market({ skip: (c, d) => c === '513100.SH' && d === '20261020' });
  const result = buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' });
  const basket = basketOf(result);
  assert.equal(basket.status, 'OK');
  const cross = basket.cross_border.find(item => item.ts_code === '513100.SH');
  assert.equal(cross.premium_discount.status, 'UNAVAILABLE');
  assert.equal(cross.premium_discount.value_pct, null);
  assert.deepEqual(cross.price_gaps.carried_forward_dates, ['20261020']);
  assert.equal(basket.valuation_quality, 'carried_forward');
  assert.ok(basket.disclosures.some(text => /513100\.SH.*跨境.*溢折价/.test(text)));
  db.close();
});

test('a missing adjustment series is disclosed as raw close, never presented as adjusted', () => {
  const db = market({ withAdj: false });
  const basket = basketOf(buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' }));
  assert.equal(basket.price_basis, 'raw_close_no_adj_factor');
  db.close();
});

test('entry fees come from the shared fee engine, including per-code profiles effective at the window start', () => {
  const db = market();
  const profile = { id: 'tag-518880', code: '518880.SH', classification: 'SUPER_ETF', effective_from: '20261016', values: {},
    evidence: {} };
  const context = { accountId: 'a', asOf: '20261016', profiles: [profile] };
  const plain = basketOf(buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023' }));
  const tagged = basketOf(buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023', fee_context: context }));
  const leg = tagged.legs.find(item => item.ts_code === '518880.SH');
  const gross = Math.round(leg.start_quantity * (leg.start_price_milli / 1000) * 100);
  const engine = (rules) => calculateFees(gross, 'buy', rules).total_cents;
  const expectedDelta = engine(feeRulesFor({ ...context, asOf: '20261016' }, '518880.SH', 'ETF')) - engine(feeRulesFor({ accountId: 'a', asOf: '20261016', profiles: [] }, '518880.SH', 'ETF'));
  assert.ok(expectedDelta < 0, 'tagged code is cheaper');
  assert.equal(tagged.entry_fee_cents - plain.entry_fee_cents, expectedDelta);
  // A profile effective after the window start must not apply retroactively.
  const later = basketOf(buildBenchmarkComparison({ marketDb: db, start: '20261016', end: '20261023', fee_context: { ...context, profiles: [{ ...profile, effective_from: '20261019' }] } }));
  assert.equal(later.entry_fee_cents, plain.entry_fee_cents);
  db.close();
});

test('every cost path (scenario, decision, daily report, benchmark, journal) goes through the one fee engine', () => {
  for (const file of ['scenario', 'decision', 'dailyReport', 'benchmarks', 'researchJournal']) {
    const source = readFileSync(join(process.cwd(), 'src', 'portfolio', `${file}.ts`), 'utf8');
    assert.match(source, /from '\.\/fees\.js'/, `${file} imports the shared fee engine`);
    assert.doesNotMatch(source, /commission_rate\s*\*|\*\s*[a-z.]*commission_rate/, `${file} must not compute commission itself`);
  }
});
