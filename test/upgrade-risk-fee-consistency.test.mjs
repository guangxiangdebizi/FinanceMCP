import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Synthetic fixtures and amounts only.
const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
const dir = mkdtempSync(join(tmpdir(), 'risk-fee-consistency-'));
process.env.ASHARE_DATA_DIR = dir;
const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await load('portfolio/account.js');
const ledger = await load('portfolio/ledger.js');
const rp = await load('portfolio/riskPolicy.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');
const { calculateFees, resolveFeeRules, saveFeeProfile } = await load('portfolio/fees.js');

const days = Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''));
const asOf = days.at(-1);
const baseline = days.at(-4);
const SUPER = '159558.SZ', MIN_ONLY = '516080.SH', PLAIN = '159241.SZ';
const CODES = [SUPER, MIN_ONLY, PLAIN];
const evidence = level => ({ level, source: 'synthetic fee fixture' });
let count = 0;

function fixture({ effectiveFrom = '20260101', withPolicy = true } = {}) {
  const id = `rf-${++count}`;
  const marketPath = join(dir, `${id}-market.sqlite`);
  const market = openAshareDb(marketPath);
  upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));
  upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    CODES.map(ts_code => ({ ts_code, name: `合成ETF${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L', market: 'E' })));
  for (const code of CODES) {
    upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map(date => { const close = date > baseline ? 0.9 : 1; return { ts_code: code, trade_date: date, open: close, high: close, low: close, close, pre_close: close, pct_chg: 0, vol: 1e6, amount: 1e5 }; }));
    upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
    upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], days.map(trade_date => ({ ts_code: code, trade_date, fd_share: 100000 })));
  }
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, `reports/${id}.json`), JSON.stringify({ report_id: `S-${id}`, as_of_trade_date: asOf, status: 'READY', market: { regime: 'range', breadth: { up_ratio: .2, median_pct_chg: -1, amount_yi: 1000, amount_ma20_yi: 3000, pct_above_ma20: 10, pct_above_ma60: 10 }, indices: [] }, sectors: { all: [], top: [], bottom: [] } }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(`S-${id}`, asOf, 'READY', '2026-08-30T14:00:00Z', `reports/${id}.json`, 'manual');
  const portfolio = openPortfolioDb(join(dir, `${id}-portfolio.sqlite`), { marketPath });
  const positions = CODES.map(ts_code => ({ ts_code, name: `合成ETF${ts_code}`, quantity: 8000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 800000 }));
  account.importSnapshot(portfolio, { snapshot_id: id, as_of: baseline, source: 'synthetic-test', note: '', warnings: [], is_current: false, positions,
    totals: { total_assets_cents: 2600000, securities_mv_cents: 2400000, cash_cents: 200000, wealth_cents: 0, unrealized_pnl_cents: 0 } });
  ledger.initBaseline(portfolio, id, { asOf: baseline, snapshotId: id });
  account.markSnapshotCurrent(portfolio, id, { confirmedBy: 'synthetic-test' });
  ledger.confirmRealAccount(portfolio, id, { confirm: true, note: 'synthetic-test' });
  ledger.setAccountCompleteness(portfolio, id, { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'synthetic-test' });
  saveFeeProfile(portfolio, id, { id: 'super', code: SUPER, classification: 'SUPER_ETF', effective_from: effectiveFrom,
    values: { commission_rate: 0.00005, commission_min_cents: 0 }, evidence: { commission_rate: evidence('CONFIRMED'), commission_min_cents: evidence('CONFIRMED') } });
  saveFeeProfile(portfolio, id, { id: 'min-only', code: MIN_ONLY, classification: 'OTHER_ETF', effective_from: effectiveFrom,
    values: { commission_rate: null, commission_min_cents: 500 }, evidence: { commission_rate: evidence('UNKNOWN'), commission_min_cents: evidence('CONFIRMED') } });
  if (withPolicy) rp.recordRiskPolicy(portfolio, { account_id: id, approval_source: 'synthetic', approved_on: '20260101' });
  return { id, market, portfolio, build: () => buildDailyReport({ portfolioDb: portfolio, marketDb: market, accountId: id, snapshotId: id, asOfTradeDate: asOf, generatedAt: '2026-10-22T00:00:00Z' }),
    close: () => { market.close(); portfolio.close(); } };
}
const option = (r, action) => r.decision_comparison.options.find(o => o.action === action);

test('observation-window drawdown is labelled as such in both the report and the risk state, never as full history', () => {
  const f = fixture();
  try {
    const r = f.build();
    const dd = r.portfolio_risk.drawdown;
    assert.equal(dd.status, 'AVAILABLE');
    assert.equal(dd.scope, 'OBSERVATION_WINDOW_SINCE_BASELINE');
    assert.equal(dd.full_history, false);
    assert.equal(dd.max_drawdown_scope, 'OBSERVATION_WINDOW');
    assert.deepEqual(dd.window, { start: baseline, end: asOf });
    assert.equal(dd.points_used, 4);
    assert.match(r.portfolio_risk.drawdown_note, /不是账户全历史最大回撤/);
    // Legacy block: full history stays unavailable, window figures are the same numbers as the risk state.
    assert.equal(r.drawdown.available, false);
    assert.equal(r.drawdown.scope, 'FULL_HISTORY');
    assert.equal(r.drawdown.observation_window.full_history, false);
    assert.equal(r.drawdown.observation_window.points_used, dd.points_used);
    assert.equal(r.drawdown.observation_window.current_drawdown_pct, dd.current_drawdown_pct);
    assert.equal(r.drawdown.observation_window.max_drawdown_pct_in_window, dd.max_drawdown_pct);
    assert.doesNotMatch(r.drawdown.disclosure, /无法计算历史最大回撤；持仓浮亏不是历史最大回撤（PRD §8）。$/);
    assert.match(r.not_covered.join('|'), /全历史/);
  } finally { f.close(); }
});

test('the approved policy and its tier appear identically in every scenario; per-trade budget kept, no position cap invented', () => {
  const f = fixture();
  try {
    const r = f.build();
    const state = r.portfolio_risk;
    assert.deepEqual(r.decision_comparison.options.map(o => o.action).sort(), ['DEFENSIVE', 'HOLD', 'NO_ACTION', 'REDUCE', 'ROTATE']);
    for (const o of r.decision_comparison.options) {
      const b = o.risk_budget;
      assert.equal(b.status, 'PORTFOLIO_RISK_POLICY_APPROVED', o.action);
      assert.doesNotMatch(JSON.stringify(b), /NO_USER_CONFIRMED_PORTFOLIO_BUDGET|尚无用户确认/);
      assert.equal(b.per_stock_plan_risk_limit_pct, 0.5);
      assert.equal(b.policy.per_trade_risk_budget_pct, 0.5);
      assert.equal(b.policy.position_cap, null);
      assert.equal(b.policy.rule_version, state.policy.rule_version);
      assert.equal(b.policy.warning_level, state.warning.level);
      assert.equal(b.policy.warning_triggered, state.warning.triggered);
      assert.equal(b.policy.drawdown.scope, state.drawdown.scope);
      assert.equal(b.policy.drawdown.points_used, state.drawdown.points_used);
      assert.equal(b.policy.drawdown.full_history, false);
      assert.deepEqual(b.policy.drawdown.window, state.drawdown.window);
      assert.equal(typeof b.stress_loss_pct_of_total_assets === 'number' || b.stress_loss_pct_of_total_assets === null, true);
    }
    assert.equal(state.policy.position_cap, null);
    assert.equal(state.action_boundary.sell_quantity, null);
  } finally { f.close(); }
});

test('before the policy exists: legacy wording and shape are unchanged, and recording it does not move report_id', () => {
  const f = fixture({ withPolicy: false });
  try {
    const before = f.build();
    assert.equal('portfolio_risk' in before, false);
    assert.equal(option(before, 'HOLD').risk_budget.status, 'NO_USER_CONFIRMED_PORTFOLIO_BUDGET');
    assert.equal('policy' in option(before, 'HOLD').risk_budget, false);
    assert.equal('observation_window' in before.drawdown, false);
    assert.equal('scope' in before.drawdown, false);
    assert.equal('per_code' in before.assumptions.fees, false);
    rp.recordRiskPolicy(f.portfolio, { account_id: f.id, approval_source: 'synthetic', approved_on: '29990101' });
    assert.deepEqual(f.build(), before);
    rp.recordRiskPolicy(f.portfolio, { account_id: f.id, approval_source: 'synthetic', rule_version: 'portfolio-drawdown-policy-1.0.1', approved_on: '20260101' });
    assert.equal(f.build().report_id, before.report_id);
  } finally { f.close(); }
});

test('per-code fee profiles drive DEFENSIVE sells with the right evidence tier; category default applies elsewhere', () => {
  const f = fixture();
  try {
    const r = f.build();
    const rows = Object.fromEntries(option(r, 'DEFENSIVE').fee_breakdowns.map(x => [x.ts_code, x.breakdown]));
    const gross = 720000; // 8000 shares at 0.900 yuan
    const expected = code => calculateFees(gross, 'sell', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code, kind: 'ETF' }));
    for (const code of CODES) assert.deepEqual(rows[code].commission_cents, expected(code).commission_cents, code);
    assert.equal(rows[SUPER].commission_cents, 36);       // 0.005%, no minimum
    assert.equal(rows[PLAIN].commission_cents, 500);      // category default: minimum applies
    assert.notEqual(rows[SUPER].commission_cents, rows[PLAIN].commission_cents);
    assert.equal(rows[SUPER].fee_model.classification, 'SUPER_ETF');
    assert.deepEqual(rows[SUPER].fee_model.profile_ids, ['super']);
    assert.equal(rows[SUPER].fee_model.evidence.commission_rate.level, 'CONFIRMED');
    assert.equal(rows[SUPER].fee_model.evidence.commission_min_cents.level, 'CONFIRMED');
    assert.equal(rows[MIN_ONLY].fee_model.classification, 'OTHER_ETF');
    assert.equal(rows[MIN_ONLY].fee_model.evidence.commission_min_cents.level, 'CONFIRMED');
    assert.equal(rows[MIN_ONLY].fee_model.evidence.commission_rate.level, 'UNKNOWN');
    assert.equal(rows[MIN_ONLY].commission_cents, 500);   // unknown rate falls back to the default rate, confirmed minimum
    assert.deepEqual(rows[PLAIN].fee_model.profile_ids, []);
    assert.equal(rows[PLAIN].fee_model.evidence.commission_rate.level, 'ASSUMED');
    // The report's assumptions block does not claim the category default for the profiled codes.
    const perCode = Object.fromEntries(r.assumptions.fees.per_code.map(x => [x.ts_code, x]));
    assert.equal(r.assumptions.fees.scope, 'CATEGORY_DEFAULT');
    assert.deepEqual(Object.keys(perCode).sort(), [MIN_ONLY, SUPER].sort());
    assert.equal(perCode[SUPER].commission_min_cents, 0);
    assert.equal(perCode[SUPER].commission_rate_evidence, 'CONFIRMED');
    assert.equal(perCode[MIN_ONLY].commission_rate_evidence, 'UNKNOWN');
  } finally { f.close(); }
});

test('as-of before the profile effective date uses category defaults for every code', () => {
  const f = fixture({ effectiveFrom: '29991231' });
  try {
    const r = f.build();
    const rows = option(r, 'DEFENSIVE').fee_breakdowns;
    assert.equal(rows.length, 3);
    for (const x of rows) {
      assert.equal(x.breakdown.commission_cents, 500, x.ts_code);
      assert.deepEqual(x.breakdown.fee_model.profile_ids, []);
      assert.equal(x.breakdown.fee_model.classification, 'NORMAL_ETF');
      assert.equal(x.breakdown.fee_model.evidence.commission_rate.level, 'ASSUMED');
    }
    assert.deepEqual(r.assumptions.fees.per_code, []);
  } finally { f.close(); }
});

test('explicit research rotation sells and buys with each code\'s own profile', () => {
  const f = fixture();
  try {
    const r = buildDailyReport({ portfolioDb: f.portfolio, marketDb: f.market, accountId: f.id, snapshotId: f.id, asOfTradeDate: asOf,
      researchScenario: { sellCode: SUPER, sellQuantity: 3000, buyCode: PLAIN, buyQuantity: 1000 } });
    const rotate = option(r, 'ROTATE');
    const sell = calculateFees(270000, 'sell', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: SUPER, kind: 'ETF' }));
    const buy = calculateFees(90000, 'buy', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: PLAIN, kind: 'ETF' }));
    const dflt = calculateFees(270000, 'sell', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: PLAIN, kind: 'ETF' }));
    assert.equal(rotate.fees_cents, sell.total_cents + buy.total_cents);
    assert.ok(sell.total_cents < dflt.total_cents, 'super-code sell is cheaper than the category default');
    assert.equal(rotate.risk_budget.policy.warning_level, r.portfolio_risk.warning.level);
  } finally { f.close(); }
});
