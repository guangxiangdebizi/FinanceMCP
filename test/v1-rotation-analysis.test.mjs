import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// D4：主动轮动与风险比较。
//
// 这一组用例锁定的是**研究比较的边界**，不是收益预测：
// - 五个候选方案（HOLD / REDUCE / ROTATE / DEFENSIVE / NO_ACTION）在日报里
//   必须同时出现，并且各自说明“为什么不是可执行”；
// - 卖出资金来源、可卖数量、一手金额与现金、费用、交易前后集中度必须被计算；
// - 没有 RESEARCH_VERIFIED 证据时，任何方案都不得变成可执行；
// - 不使用机械的固定仓位阈值自动生成卖出指令（集中度动作恒为示意）。

const dir = mkdtempSync(join(tmpdir(), 'ashare-d4-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const account = await import('../build/portfolio/account.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { confirmRealAccount, initBaseline, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');

const DAYS = ['20261012', '20261013', '20261014', '20261015', '20261016'];
const LAST = DAYS.at(-1);
const CODES = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];
const CLOSE = { '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742, '510300.SH': 4.0 };

const market = openAshareDb(join(dir, 'market.sqlite'));
upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], DAYS.map((date, index) => ({
  cal_date: date, is_open: 1, pretrade_date: DAYS[index - 1] ?? null,
})));
upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
  Object.keys(CLOSE).map(ts_code => ({ ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' })));
for (const [code, close] of Object.entries(CLOSE)) {
  upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
    DAYS.map(date => ({ ts_code: code, trade_date: date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e5 })));
  upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], DAYS.map(date => ({ ts_code: code, trade_date: date, adj_factor: 1 })));
  upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
    [{ ts_code: code, trade_date: DAYS.at(-2), fd_share: 100000, fund_type: 'ETF', market: 'SZ' },
     { ts_code: code, trade_date: LAST, fd_share: 100100, fund_type: 'ETF', market: 'SZ' }]);
}

const portfolio = openPortfolioDb(join(dir, 'portfolio.sqlite'), { marketPath: join(dir, 'market.sqlite') });
const SNAPSHOT_ID = 'synthetic-d4-2026-10-16';
account.importSnapshot(portfolio, { ...account.DEMO_SNAPSHOT, snapshot_id: SNAPSHOT_ID, as_of: LAST, source: 'synthetic-test-fixture', is_current: false });
initBaseline(portfolio, 'real-main', { asOf: LAST, snapshotId: SNAPSHOT_ID });
account.markSnapshotCurrent(portfolio, SNAPSHOT_ID, { confirmedBy: 'test-fixture' });
confirmRealAccount(portfolio, 'real-main', { confirm: true, note: 'synthetic fixture' });
setAccountCompleteness(portfolio, 'real-main', { as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test-fixture' });

const build = (extra = {}) => buildDailyReport({
  portfolioDb: portfolio, marketDb: market, accountId: 'real-main', asOfTradeDate: LAST, snapshotId: SNAPSHOT_ID,
  ...extra,
});
const report = build();
const researchReport = build({ researchScenario: {
  sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100,
} });

test('D4-1 五个方案同时出现，且都明确标注当前是否可执行', () => {
  const options = report.decision_comparison?.options ?? [];
  assert.deepEqual(options.map(option => option.action).sort(),
    ['DEFENSIVE', 'HOLD', 'NO_ACTION', 'REDUCE', 'ROTATE'].sort(), JSON.stringify(options.map(o => o.action)));
  for (const option of options) {
    assert.equal(typeof option.summary, 'string');
    assert.ok(option.summary.length > 0, `${option.action} 必须说明研究含义`);
    assert.equal(option.executable, false, `${option.action} 在全量对比中不得可执行`);
    assert.ok(Array.isArray(option.not_actionable_because));
  }
});

test('D4-2 卖出方案必须给出资金来源、可卖数量、一手金额与费用', () => {
  const defaultReduce = report.decision_comparison.options.find(option => option.action === 'REDUCE');
  assert.equal(defaultReduce.sell_plan, null, '不提供研究数量不得自动按50%阈值卖出');
  assert.equal(defaultReduce.funding_status, 'QUANTITY_REQUIRED');
  const reduce = researchReport.decision_comparison.options.find(option => option.action === 'REDUCE');
  assert.ok(reduce.sell_plan, '显式研究数量必须给出资金测算');
  assert.equal(reduce.sell_plan.quantity, 1000);
  assert.equal(reduce.executable, false);
  assert.equal(reduce.sell_plan.ts_code, '159558.SZ', '集中度最高的持仓是研究起点');
  assert.ok(reduce.sell_plan.quantity > 0);
  assert.equal(reduce.sell_plan.quantity % 100, 0, '卖出必须是整手');
  assert.ok(reduce.sell_plan.quantity <= reduce.sell_plan.sellable_quantity, '不得超过可卖数量');
  assert.ok(reduce.sell_plan.one_lot_cents > 0);
  assert.ok(reduce.sell_plan.fees_cents >= 0);
  assert.equal(reduce.sell_plan.cash_after_cents, report.account_view.revalued_basis.cash_cents + reduce.sell_plan.net_cents);
});

test('D4-3 轮动方案必须给出候选、一手金额与现金是否足够，且优势未验证', () => {
  assert.equal(report.decision_comparison.options.find(option => option.action === 'ROTATE').rotation_plan, null,
    '不提供买卖研究参数不得自动构造轮动');
  const rotate = researchReport.decision_comparison.options.find(option => option.action === 'ROTATE');
  assert.ok(rotate.rotation_plan, '显式轮动研究必须给出候选与资金测算');
  assert.equal(rotate.rotation_plan.buy_code, '510300.SH');
  assert.equal(rotate.rotation_plan.quantity, 100);
  assert.equal(rotate.executable, false);
  assert.ok(rotate.rotation_plan.buy_code, '必须有候选代码');
  assert.ok(rotate.rotation_plan.one_lot_cents > 0);
  assert.equal(typeof rotate.rotation_plan.cash_sufficient_for_one_lot, 'boolean');
  assert.equal(rotate.rotation_plan.advantage_status, 'UNVERIFIED', '没有证据时优势只能是 UNVERIFIED');
  assert.match(rotate.not_actionable_because.join(' '), /UNVERIFIED|未验证/);
});

test('D4-4 交易前后集中度与压力情景必须被计算，而不是只写定性描述', () => {
  const comparison = report.decision_comparison;
  assert.ok(comparison.concentration_before.hhi > 0);
  for (const option of comparison.options) {
    if (option.action === 'HOLD' || option.action === 'NO_ACTION') {
      assert.equal(option.concentration_after.hhi, comparison.concentration_before.hhi,
        `${option.action} 不交易时HHI口径与数值必须完全相同`);
    } else {
      assert.ok(option.concentration_after.hhi !== null, `${option.action} 必须给出交易后集中度`);
    }
  }
  const defensive = comparison.options.find(option => option.action === 'DEFENSIVE');
  assert.ok(defensive.stress_after, 'DEFENSIVE 必须给出压力情景');
  assert.ok(typeof defensive.stress_after.equity_shock_pct === 'number');
});

test('D4-5 无优势证据时不产生集中度动作，显式研究也不得升级ACTIONABLE', () => {
  for (const result of [report, researchReport]) {
    assert.deepEqual(result.first_section.actions, []);
    assert.equal(result.actionable, false);
    assert.notEqual(result.status, 'ACTIONABLE');
    const reduce = result.decision_comparison.options.find(option => option.action === 'REDUCE');
    assert.equal(reduce.executable, false);
    assert.ok(reduce.opportunity_cost.length > 0);
  }
});
