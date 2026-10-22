import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Synthetic fixtures only.
const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
const dir = mkdtempSync(join(tmpdir(), 'risk-policy-'));
process.env.ASHARE_DATA_DIR = dir;
const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await load('portfolio/account.js');
const ledger = await load('portfolio/ledger.js');
const rp = await load('portfolio/riskPolicy.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');

let count = 0;
const CODE = '159558.SZ';
// 100000 shares at 1.000 = 10,000,000 cents; nav moves 1:1 with the milli price.
function ledgerFixture({ verified = true, cash = 0, baselineAsOf = '20261016' } = {}) {
  const id = `acct-${++count}`;
  const db = openPortfolioDb(join(dir, `${id}.sqlite`), { marketPath: join(dir, 'market-none.sqlite') });
  account.importSnapshot(db, { snapshot_id: id, as_of: '20261016', source: 'synthetic-test', note: '', warnings: [], is_current: false,
    positions: [{ ts_code: CODE, name: '合成ETF', quantity: 100000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 10000000 }],
    totals: { total_assets_cents: 10000000 + cash, securities_mv_cents: 10000000, cash_cents: cash, wealth_cents: 0, unrealized_pnl_cents: 0 } });
  ledger.initBaseline(db, id, { asOf: '20261016', snapshotId: id });
  if (verified) ledger.confirmRealAccount(db, id, { confirm: true, note: 'synthetic-test' });
  return { db, id };
}
const prices = (...series) => Object.fromEntries(series.map(([date, milli]) => [date, { [CODE]: milli }]));
const drawdownAt = (milli, extra = {}) => {
  const { db, id } = ledgerFixture(extra.fixture);
  try {
    if (extra.events) for (const e of extra.events(id)) ledger.recordEvent(db, e);
    return rp.assessAccountDrawdown(db, null, id, '20261020', prices(['20261016', 1000], ['20261019', 1000], ['20261020', milli], ...(extra.more ?? [])));
  } finally { db.close(); }
};
const levelAt = milli => {
  const dd = drawdownAt(milli);
  return rp.levelFor(Math.round(dd.peak_nav * 1e6), Math.round(dd.current_nav * 1e6), rp.DEFAULT_APPROVED_TIERS)?.level ?? 'NONE';
};

test('thresholds fire exactly at 10/15/20% and not below', () => {
  assert.equal(levelAt(901), 'NONE');   // 9.9%
  assert.equal(levelAt(900), 'L1');     // exactly 10%
  assert.equal(levelAt(851), 'L1');
  assert.equal(levelAt(850), 'L2');     // exactly 15%
  assert.equal(levelAt(801), 'L2');
  assert.equal(levelAt(800), 'L3');     // exactly 20%
  assert.equal(levelAt(500), 'L3');
  assert.equal(drawdownAt(900).current_drawdown_pct, 10);
  assert.deepEqual(rp.DEFAULT_APPROVED_TIERS.map(t => t.drawdown_bps), [1000, 1500, 2000]);
});

test('drawdown measures from the NAV peak, not from cost or cumulative loss', () => {
  // Peak 1.2 then 1.08 => 10% below peak although still 8% above cost.
  const dd = drawdownAt(1080, { more: [['20261019', 1200]] });
  assert.equal(dd.status, 'AVAILABLE');
  assert.equal(dd.current_drawdown_pct, 10);
  assert.equal(dd.peak_nav, 1.2);
  assert.ok(dd.excluded_bases.includes('cumulative_unrealized_loss'));
});

test('missing history, unverified account and missing baseline give HISTORICAL_DRAWDOWN_UNAVAILABLE', () => {
  const { db, id } = ledgerFixture();
  try {
    const single = rp.assessAccountDrawdown(db, null, id, '20261016', prices(['20261016', 1000]));
    assert.equal(single.status, 'HISTORICAL_DRAWDOWN_UNAVAILABLE');
    assert.equal(single.reason, 'insufficient_history');
    assert.equal(single.current_drawdown_bps, null);
    assert.equal(rp.assessAccountDrawdown(db, null, 'nobody', '20261020').reason, 'no_baseline');
  } finally { db.close(); }
  const pending = drawdownAt(800, { fixture: { verified: false } });
  assert.equal(pending.status, 'HISTORICAL_DRAWDOWN_UNAVAILABLE');
  assert.equal(pending.reason, 'account_not_verified_real');
});

test('deposits and withdrawals do not mask or fake a drawdown', () => {
  const deposit = id => [{ event_id: 'dep-1', account_id: id, event_type: 'CASH_DEPOSIT', occurred_on: '20261020', cash_delta_cents: 5000000, source: 'synthetic' }];
  const withdraw = id => [{ event_id: 'wd-1', account_id: id, event_type: 'CASH_WITHDRAW', occurred_on: '20261020', cash_delta_cents: -2000000, source: 'synthetic' }];
  // Naive total value would show a smaller (or no) loss after the deposit; unit NAV still shows 10%.
  const withDeposit = drawdownAt(900, { events: deposit });
  assert.equal(withDeposit.current_drawdown_pct, 10);
  // 5M cash cushion: the 1M price loss is 6.6667% of 15M, and the 2M withdrawal does not change that NAV.
  const withWithdraw = drawdownAt(900, { fixture: { cash: 5000000 }, events: withdraw });
  assert.equal(withWithdraw.current_drawdown_pct, 6.6667);
  // A withdrawal with flat prices is not a drawdown.
  const flat = drawdownAt(1000, { fixture: { cash: 5000000 }, events: withdraw });
  assert.equal(flat.current_drawdown_pct, 0);
});

test('policy is persisted, idempotent, never overwritten, and gated by approval date', () => {
  const { db, id } = ledgerFixture();
  try {
    const first = rp.recordRiskPolicy(db, { account_id: id, approval_source: 'user-chat-2026-10-22' });
    assert.equal(first.created, true);
    assert.equal(first.policy.approved_on, '20261022');
    assert.equal(first.policy.rule_version, rp.RISK_POLICY_RULE_VERSION);
    assert.equal(first.policy.per_trade_risk_budget_bps, 50);
    assert.equal(first.policy.position_cap, null);
    assert.equal(first.policy.auto_reduce, false);
    assert.equal(rp.recordRiskPolicy(db, { account_id: id, approval_source: 'user-chat-2026-10-22' }).created, false);
    assert.throws(() => rp.recordRiskPolicy(db, { account_id: id, approval_source: 'someone-else' }), /不可覆盖/);
    assert.equal(db.prepare('SELECT approval_source FROM portfolio_risk_policy').get().approval_source, 'user-chat-2026-10-22');
    assert.equal(rp.loadActiveRiskPolicy(db, id, '20261021'), null);
    assert.equal(rp.loadActiveRiskPolicy(db, id, '20261022').rule_version, rp.RISK_POLICY_RULE_VERSION);
    // Re-opening (migration) keeps history.
    db.exec(rp.PORTFOLIO_RISK_POLICY_DDL);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_risk_policy').get().n, 1);
  } finally { db.close(); }
});

test('risk state: warning only triggers review, never a sell quantity; concentration survives missing history', () => {
  const { db, id } = ledgerFixture();
  try {
    rp.recordRiskPolicy(db, { account_id: id, approval_source: 'test', approved_on: '20261016' });
    const unavailable = rp.buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId: id, asOf: '20261016',
      concentration: { hhi: 1, top_position: { ts_code: CODE, weight: 1 } }, exposure: { equity_weight: 1 }, stress: { loss_cents: 1000000 } });
    assert.equal(unavailable.warning.reason, 'HISTORICAL_DRAWDOWN_UNAVAILABLE');
    assert.equal(unavailable.drawdown.status, 'HISTORICAL_DRAWDOWN_UNAVAILABLE');
    assert.equal(unavailable.concentration.hhi, 1);
    assert.equal(unavailable.exposure.equity_weight, 1);
    assert.equal(unavailable.stress.loss_cents, 1000000);
    assert.equal(unavailable.warning.triggered, false);
    for (const state of [unavailable]) {
      assert.equal(state.action_boundary.sell_quantity, null);
      assert.equal(state.action_boundary.auto_trade, false);
      assert.equal(state.policy.auto_reduce, false);
      assert.equal(state.policy.auto_liquidate, false);
      assert.equal(state.policy.position_cap, null);
      assert.equal(state.policy.per_trade_risk_budget_pct, 0.5);
      assert.doesNotMatch(JSON.stringify(state), /"(sell_)?quantity":\s*[1-9]/);
    }
    assert.equal(rp.buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId: id, asOf: '20261015' }), null);
  } finally { db.close(); }
});

// ---- daily report integration (additive, report_id stable) ----
const days = Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''));
const asOf = days.at(-1);
function reportFixture(tag) {
  const marketPath = join(dir, `${tag}-market.sqlite`);
  const market = openAshareDb(marketPath);
  upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));
  upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], [{ ts_code: CODE, name: '合成沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L', market: 'E' }]);
  upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], days.map(date => ({ ts_code: CODE, trade_date: date, open: 1, high: 1, low: 1, close: 1, pre_close: 1, pct_chg: 0, vol: 1e6, amount: 1e5 })));
  upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.map(trade_date => ({ ts_code: CODE, trade_date, adj_factor: 2 })));
  upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], days.map(trade_date => ({ ts_code: CODE, trade_date, fd_share: 100000 })));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, `reports/${tag}.json`), JSON.stringify({ report_id: `S-${tag}`, as_of_trade_date: asOf, status: 'READY', market: { regime: 'range', breadth: { up_ratio: .2, median_pct_chg: -1, amount_yi: 1000, amount_ma20_yi: 3000, pct_above_ma20: 10, pct_above_ma60: 10 }, indices: [] }, sectors: { all: [], top: [], bottom: [] } }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(`S-${tag}`, asOf, 'READY', '2026-08-30T14:00:00Z', `reports/${tag}.json`, 'manual');
  const portfolio = openPortfolioDb(join(dir, `${tag}-portfolio.sqlite`), { marketPath });
  account.importSnapshot(portfolio, { snapshot_id: tag, as_of: asOf, source: 'synthetic-test', note: '', warnings: [], is_current: false,
    positions: [{ ts_code: CODE, name: '合成ETF', quantity: 8000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 800000 }],
    totals: { total_assets_cents: 1000000, securities_mv_cents: 800000, cash_cents: 200000, wealth_cents: 0, unrealized_pnl_cents: 0 } });
  ledger.initBaseline(portfolio, tag, { asOf, snapshotId: tag });
  account.markSnapshotCurrent(portfolio, tag, { confirmedBy: 'synthetic-test' });
  ledger.confirmRealAccount(portfolio, tag, { confirm: true, note: 'synthetic-test' });
  ledger.setAccountCompleteness(portfolio, tag, { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'synthetic-test' });
  return { market, portfolio, build: () => buildDailyReport({ portfolioDb: portfolio, marketDb: market, accountId: tag, snapshotId: tag, asOfTradeDate: asOf, generatedAt: '2026-10-22T00:00:00Z' }) };
}

test('daily report: legacy output unchanged without policy; policy adds portfolio_risk without changing report_id', () => {
  const f = reportFixture('rp-report');
  try {
    const before = f.build();
    assert.equal('portfolio_risk' in before, false);
    assert.equal(before.drawdown.available, false);
    // Approval date after asOf -> still invisible, so historical reports stay reproducible.
    rp.recordRiskPolicy(f.portfolio, { account_id: 'rp-report', approval_source: 'test', approved_on: '29990101' });
    assert.equal('portfolio_risk' in f.build(), false);
    rp.recordRiskPolicy(f.portfolio, { account_id: 'rp-report', approval_source: 'test', rule_version: 'portfolio-drawdown-policy-1.0.1', approved_on: '20260101' });
    const after = f.build();
    assert.equal(after.report_id, before.report_id);
    assert.equal(after.portfolio_risk.warning.reason, 'HISTORICAL_DRAWDOWN_UNAVAILABLE');
    assert.equal(after.portfolio_risk.concentration.hhi !== undefined, true);
    assert.ok(after.portfolio_risk.stress);
    assert.equal(after.portfolio_risk.action_boundary.sell_quantity, null);
    assert.deepEqual({ ...after, portfolio_risk: undefined }, { ...before, portfolio_risk: undefined });
  } finally { f.market.close(); f.portfolio.close(); }
});

test('end to end from market prices: 20% NAV drawdown yields L3 review with no trade quantity', () => {
  const market = openAshareDb(join(dir, 'e2e-market.sqlite'));
  upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    [['20261016', 1], ['20261019', 1], ['20261020', 0.8]].map(([trade_date, close]) => ({ ts_code: CODE, trade_date, open: close, high: close, low: close, close, pre_close: close, pct_chg: 0, vol: 1, amount: 1 })));
  const { db, id } = ledgerFixture();
  try {
    rp.recordRiskPolicy(db, { account_id: id, approval_source: 'test', approved_on: '20261016' });
    const state = rp.buildPortfolioRiskState({ portfolioDb: db, marketDb: market, accountId: id, asOf: '20261020' });
    assert.equal(state.warning.level, 'L3');
    assert.equal(state.warning.triggered, true);
    assert.match(state.warning.required_review, /比较降低风险、部分减仓和继续持有/);
    assert.equal(state.action_boundary.sell_quantity, null);
    assert.equal(state.drawdown.current_drawdown_pct, 20);
  } finally { db.close(); market.close(); }
});
