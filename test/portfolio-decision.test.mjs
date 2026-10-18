import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 离线、确定性：临时市场缓存 + 合成账户快照。所有持仓与金额都清楚标注为合成数据，
// 不是用户真实账户，也不代表任何真实成交或收益。
const dir = mkdtempSync(join(tmpdir(), 'ashare-decision-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');
const { accountSummary, importSnapshot, readSnapshot, DEMO_SNAPSHOT } = await import('../build/portfolio/account.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const ledger = await import('../build/portfolio/ledger.js');
const evidenceModule = await import('../build/portfolio/evidence.js');
const { buildDecision, classifyAssetClass, ASSET_CLASS_STRESS_VERSION } = await import('../build/portfolio/decision.js');

const ROOT = process.cwd();
const DATES = weekdays('20261005', 10);
const LAST = DATES.at(-1);
const PREV = DATES.at(-2);

// ---------------------------------------------------------------- 市场缓存

const market = openAshareDb();
upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
  DATES.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DATES[i - 1] ?? null })));

const ETF_BASIC = [
  { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '航空航天指数', status: 'L', market: 'E' },
  { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '机器人指数', status: 'L', market: 'E' },
  { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备指数', status: 'L', market: 'E' },
  { ts_code: '516080.SH', name: '创新药ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '创新药指数', status: 'L', market: 'E' },
  { ts_code: '560390.SH', name: '电网设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '电网设备指数', status: 'L', market: 'E' },
  // ETF_UNIVERSE 之外的候选（合成数据）
  { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L', market: 'E' },
  { ts_code: '511260.SH', name: '十年国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '中债综合财富(总值)指数', status: 'L', market: 'E' },
  { ts_code: '518880.SH', name: '黄金ETF', fund_type: '商品型', invest_type: '被动指数型', benchmark: '上海黄金交易所Au99.99', status: 'L', market: 'E' },
  { ts_code: '513100.SH', name: '纳指ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '纳斯达克100指数', status: 'L', market: 'E' },
];
upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], ETF_BASIC);

// 收盘价与合成快照的参考价一致，便于逐项核对重估结果。
const CLOSE = {
  '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742,
  '510300.SH': 4.0, '511260.SH': 100.0, '518880.SH': 5.0, '513100.SH': 1.5,
  '159999.SZ': 1.0, // 只有行情、没有 fund_basic 的合成标的
};
for (const [code, close] of Object.entries(CLOSE)) {
  upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
    DATES.map(d => ({ ts_code: code, trade_date: d, open: close, high: close, low: close, close, pre_close: close, vol: 1000, amount: 100 })));
}
// 510300 的上一交易日价格不同：用于确认取到的是 as_of 当日而不是任意历史行。
upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
  [{ ts_code: '510300.SH', trade_date: PREV, open: 3.9, high: 3.9, low: 3.9, close: 3.9, pre_close: 3.9, vol: 1, amount: 1 }]);

// 主板个股（合成价 10.000 元）
upsertRows(market, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'],
  [{ ts_code: '600519.SH', symbol: '600519', name: '合成主板股票', list_date: '20010101', list_status: 'L' }]);
upsertRows(market, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
  [{ ts_code: '600519.SH', trade_date: LAST, open: 10, high: 10, low: 10, close: 10, pre_close: 10, vol: 1, amount: 1 }]);
// R2：个股停牌状态必须可证——每个交易日的 suspend_d 同步都要有成功记录。
upsertRows(market, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'],
  DATES.map(d => ({ dataset: 'suspend_d', key: d, rows: 0, status: 'ok', message: '', synced_at: `${LAST}T00:00:00Z` })));

// ---------------------------------------------------------------- 合成账户

const portfolio = openPortfolioDb();
const SYNTH = {
  ...DEMO_SNAPSHOT,
  snapshot_id: 'synthetic-current-2026-10-18',
  // R2：账户快照日期必须与决策日同一交易日（0 天容忍）。
  as_of: '2026-10-16',
  source: 'synthetic-test-fixture',
  note: '合成测试账户（不是真实账户）',
  warnings: ['synthetic_fixture'],
  is_current: true,
};
// 这是合成 fixture（source=synthetic-test-fixture），不是用户真实账户；"当前账户"
// 必须显式确认，账户层不允许静默声明 is_current=true。
importSnapshot(portfolio, SYNTH, { confirmCurrent: true });

// 含债券与未分类标的的合成账户：用于按资产类别施加压力的对照。
const MIXED_POSITIONS = [
  ...SYNTH.positions,
  { ts_code: '511260.SH', name: '十年国债ETF', quantity: 100, ref_price_milli: 100000, ref_cost_milli: 100000, market_value_cents: 1000000 },
  { ts_code: '159999.SZ', name: '未分类合成ETF', quantity: 1000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 100000 },
];
const MIXED_SECURITIES = MIXED_POSITIONS.reduce((a, p) => a + p.market_value_cents, 0);
const MIXED = {
  ...SYNTH,
  snapshot_id: 'synthetic-mixed-class',
  positions: MIXED_POSITIONS,
  totals: { ...SYNTH.totals, securities_mv_cents: MIXED_SECURITIES, total_assets_cents: MIXED_SECURITIES + SYNTH.totals.cash_cents + SYNTH.totals.wealth_cents },
};
// 对照用快照不是"当前账户"，因此不得清除 SYNTH 的当前标记（账户层只允许一个当前快照）。
importSnapshot(portfolio, { ...MIXED, is_current: false });

// R2 受控正例的显式测试注入：账本基线 + 用户确认 + 可复核的研究证据。
ledger.initBaseline(portfolio, 'synthetic-test', { asOf: LAST, snapshotId: SYNTH.snapshot_id, note: 'r2 test fixture' });
ledger.confirmRealAccount(portfolio, 'synthetic-test', { confirm: true, note: 'r2 test fixture' });
evidenceModule.recordResearchEvidence(portfolio, {
  evidence_id: 'EV-SYNTH-001', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ',
  strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED',
  recorded_by: 'test-fixture', note: '受控测试证据（不是真实研究结论）',
}, { confirm: true });

const current = accountSummary(readSnapshot(portfolio, SYNTH.snapshot_id));
const mixed = accountSummary(readSnapshot(portfolio, MIXED.snapshot_id));
const NAV = current.totals.total_assets_cents;

const VERIFIED = { claim: '研究结论：候选相对优势成立', source: 'RESEARCH_VERIFIED', evidence_id: 'EV-SYNTH-001', as_of: LAST };
const base = (overrides = {}) => ({
  account_id: 'synthetic-test',
  snapshot: current,
  as_of_trade_date: LAST,
  market_db: market,
  portfolio_db: portfolio,
  ...overrides,
});
const sellBuy = (overrides = {}) => buildDecision(base({
  action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
  evidence: VERIFIED,
  ...overrides,
}));

// ---------------------------------------------------------------- 1. 候选来自服务端缓存

test('1. ETF_UNIVERSE 之外的候选从服务端缓存取价与交易日', () => {
  assert.equal(SYNTH.positions.some(p => p.ts_code === '510300.SH'), false, '510300 不在账户持仓里');
  const d = sellBuy();
  assert.equal(d.quotes.source, 'server_cache');
  const q = d.quotes.entries.find(x => x.ts_code === '510300.SH');
  assert.equal(q.available, true);
  assert.equal(q.price_milli, 4000);       // 4.000 元
  assert.equal(q.trade_date, LAST);        // as_of 当日，不是 PREV 的 3.900
  assert.equal(q.quality, 'READY');
  assert.equal(q.source, 'server_cache');
  assert.equal(d.as_of_trade_date, LAST);
  // 账户快照参考价未被用于候选定价
  assert.equal(d.valuation.repriced_codes.includes('510300.SH'), false);
});

test('1b. 资产类别判定：权益 / 债券 / 黄金 / 跨境 / 未分类', () => {
  assert.equal(classifyAssetClass({ fund_type: '股票型', benchmark: '沪深300指数' }).asset_class, 'EQUITY');
  assert.equal(classifyAssetClass({ fund_type: '债券型', benchmark: '中债综合财富(总值)指数' }).asset_class, 'BOND');
  assert.equal(classifyAssetClass({ fund_type: '商品型', benchmark: '上海黄金交易所Au99.99' }).asset_class, 'GOLD');
  assert.equal(classifyAssetClass({ fund_type: '股票型', benchmark: '纳斯达克100指数' }).asset_class, 'CROSS_BORDER');
  const unknown = classifyAssetClass({ fund_type: '商品型', benchmark: '豆粕期货指数' });
  assert.equal(unknown.asset_class, 'UNKNOWN');
  assert.equal(unknown.classified, false);
});

// ---------------------------------------------------------------- 2. 未缓存候选

test('2. 候选未缓存 → DATA_INSUFFICIENT / 身份未知，且不伪造价格', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '588999.SH', buy_kind: 'ETF' },
    evidence: VERIFIED,
  }));
  assert.equal(d.status, 'DATA_INSUFFICIENT');
  // R2：身份以 resolveInstrument 为准；缓存里查不到的代码是 instrument_unknown，
  // 比旧契约的 candidate_not_cached 更明确（旧行为仍会把未知代码当 ETF 取价）。
  assert.ok(d.reasons.some(r => ['instrument_unknown', 'candidate_not_cached'].includes(r.code)), JSON.stringify(d.reasons));
  const q = d.quotes.entries.find(x => x.ts_code === '588999.SH');
  assert.equal(q.available, false);
  assert.equal('price_milli' in q, false, '未缓存时不能有任何价格字段');
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  assert.equal(rotate.status, 'DATA_INSUFFICIENT');
  assert.equal(rotate.executable, false);
  assert.deepEqual(rotate.legs, []);
  assert.deepEqual(rotate.illustrative_legs, []);
  assert.equal(rotate.cash.change_cents, 0);
  assert.deepEqual(d.quotes.missing_codes, ['588999.SH']);
});

// ---------------------------------------------------------------- 3. 按资产类别的压力

test('3. 债券 ETF 施加债券压力而不是权益压力；未分类标的被标记', () => {
  const d = buildDecision(base({
    snapshot: mixed,
    action: { type: 'HOLD' },
  }));
  const hold = d.options.find(o => o.action === 'HOLD');
  const bond = hold.stress.by_asset_class.find(x => x.asset_class === 'BOND');
  const equity = hold.stress.by_asset_class.find(x => x.asset_class === 'EQUITY');
  assert.equal(bond.shock_pct, -0.01);
  assert.equal(bond.exposure_cents, 1000000);
  assert.equal(bond.loss_cents, -10000);              // −1% × 10,000 元
  assert.equal(equity.shock_pct, -0.10);
  assert.notEqual(bond.shock_pct, equity.shock_pct, '不同资产类别不能共用同一个冲击');
  assert.equal(hold.stress.version, ASSET_CLASS_STRESS_VERSION);
  assert.ok(hold.stress.by_asset_class.every(x => x.assumed === true));
  // 未分类标的：按权益冲击处理，但必须显式标记
  assert.ok(hold.stress.unclassified_codes.includes('159999.SZ'), JSON.stringify(hold.stress.unclassified_codes));
  assert.ok(hold.stress.warnings.includes('stress_assumption_unclassified'));
  // 统一 −10% 只能作为演示对照
  assert.equal(hold.stress.uniform_demo.label, 'demo_only');
  assert.equal(hold.stress.uniform_demo.shock_pct, -0.10);
  assert.notEqual(hold.stress.uniform_demo.loss_cents, hold.stress.total_loss_cents);
  // 主要风险数字必须等于按类别求和，而不是统一 −10%
  const sum = hold.stress.by_asset_class.reduce((a, x) => a + x.loss_cents, 0);
  assert.equal(hold.stress.total_loss_cents, sum);
});

test('3b. 跨境 ETF 按 −12% 处理，权益敞口包含跨境', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '513100.SH', buy_kind: 'ETF' },
    evidence: VERIFIED,
  }));
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  const cb = rotate.stress.by_asset_class.find(x => x.asset_class === 'CROSS_BORDER');
  assert.equal(cb.shock_pct, -0.12);
  assert.ok(cb.exposure_cents > 0);
  assert.ok(rotate.exposure.equity_weight > 0.9);
});

// ---------------------------------------------------------------- 4/5. 优势证据

test('4. UNVERIFIED 优势 → ILLUSTRATIVE，绝不 executable', () => {
  const d = sellBuy({ evidence: { claim: '只是想法', source: 'UNVERIFIED' } });
  assert.equal(d.status, 'ILLUSTRATIVE');
  assert.equal(d.evidence.verified, false);
  assert.equal(d.evidence.evidence_id, null);
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  assert.equal(rotate.executable, false);
  assert.deepEqual(rotate.legs, []);
  assert.equal(rotate.illustrative_legs.length, 2, '计算值只能出现在 illustrative_legs');
  assert.ok(rotate.reasons.some(r => r.code === 'rotation_advantage_unverified'));
  // 未经研究的轮动永远不能成为可执行方案；顶层决策表达也必须降级。
  assert.equal(d.requested_action, 'SELL_AND_BUY');
  assert.equal(d.options.find(o => o.action === 'SELL_AND_BUY').executable, false);
  assert.notEqual(d.status, 'ACTIONABLE');
});

test('4b. RESEARCH_VERIFIED 但缺少 evidence_id → 仍不可执行', () => {
  const d = sellBuy({ evidence: { claim: '缺少证据 ID', source: 'RESEARCH_VERIFIED' } });
  assert.equal(d.evidence.verified, false);
  assert.equal(d.status, 'ILLUSTRATIVE');
  assert.equal(d.options.find(o => o.action === 'SELL_AND_BUY').executable, false);
});

test('4c. 完全未提供优势证据 → NO_ACTION / no_demonstrated_advantage', () => {
  const d = sellBuy({ evidence: null });
  assert.equal(d.evidence.supplied, false);
  assert.ok(d.reasons.some(r => r.code === 'no_demonstrated_advantage'));
  assert.equal(d.status, 'ILLUSTRATIVE');
  assert.equal(d.options.find(o => o.action === 'SELL_AND_BUY').executable, false);
});

test('5. RESEARCH_VERIFIED + evidence_id + 当前账户 + 当日行情 → ACTIONABLE', () => {
  const d = sellBuy();
  assert.equal(d.snapshot_is_current, true);
  assert.equal(d.evidence.verified, true);
  assert.equal(d.evidence.evidence_id, 'EV-SYNTH-001');
  assert.equal(d.status, 'ACTIONABLE', JSON.stringify(d.reasons));
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  assert.equal(rotate.executable, true);
  assert.equal(rotate.legs.length, 2);
  assert.deepEqual(rotate.illustrative_legs, []);
  assert.equal(rotate.legs[0].side, 'SELL');
  assert.equal(rotate.legs[0].quantity, 10000);
  assert.equal(rotate.legs[0].quote_trade_date, LAST);
  assert.equal(rotate.legs[1].side, 'BUY');
  assert.equal(rotate.legs[1].ts_code, '510300.SH');
  assert.equal(rotate.legs[1].price_milli, 4000);
  assert.equal(rotate.funding_source, 'sell_proceeds_and_cash');
  // 账户不是当前快照时，同样的输入必须降级
  const stale = buildDecision(base({
    snapshot: accountSummary({ ...SYNTH, is_current: false, snapshot_id: 'synthetic-not-current' }),
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
    evidence: VERIFIED,
  }));
  assert.equal(stale.status, 'ILLUSTRATIVE');
  assert.ok(stale.reasons.some(r => r.code === 'account_not_current'));
  assert.equal(stale.options.find(o => o.action === 'SELL_AND_BUY').executable, false);
});

test('5b. as_of 不在交易日历 → DATA_INSUFFICIENT（R2 统一交易日历）', () => {
  const d = buildDecision(base({
    as_of_trade_date: '20261019',   // 不在缓存 trade_cal 中
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
    evidence: VERIFIED,
  }));
  // R2 收紧：旧行为把“日历缺少该日期”降级为 warning 并仍给出 ILLUSTRATIVE；
  // 新契约要求 as_of 必须是日历中的开市日，否则不做可执行计算。
  assert.equal(d.status, 'DATA_INSUFFICIENT');
  assert.ok(d.reasons.some(r => r.code === 'as_of_not_trading_day'), JSON.stringify(d.reasons));
  assert.equal(d.options.find(o => o.action === 'SELL_AND_BUY').executable, false);
  assert.equal(d.options.find(o => o.action === 'SELL_AND_BUY').status, 'DATA_INSUFFICIENT');
});

// ---------------------------------------------------------------- 6. 个股计划风险

test('6. 主板个股计划风险超过净资产 0.5% → risk_budget_exceeded', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: VERIFIED,
    stock_plan: { ts_code: '600519.SH', invalidation_milli: 6000 },   // 10.000 → 6.000
  }));
  assert.ok(d.stock_plan);
  assert.equal(d.stock_plan.entry_milli, 10000);
  assert.equal(d.stock_plan.entry_source, 'server_cache');
  assert.equal(d.stock_plan.budget_cents, Math.round(NAV * 0.005));
  assert.equal(d.stock_plan.quantity, 1000);                          // 1,075,402 分预算 / 一手 1,000 元 → 10 手
  assert.equal(d.stock_plan.planned_risk_cents, 400000);              // 1000 × 4.000 元
  assert.ok(d.stock_plan.planned_risk_cents > d.stock_plan.budget_cents);
  assert.equal(d.stock_plan.ok, false);
  assert.ok(d.stock_plan.reasons.some(r => r.code === 'risk_budget_exceeded'));
  assert.match(d.stock_plan.note, /不保证成交/);
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  assert.equal(rotate.executable, false);
  assert.deepEqual(rotate.legs, [], '超预算时不能留下可下单的买入腿');
  assert.equal(d.status, 'NO_ACTION');
});

test('6b. 计划风险在预算内 → 通过，但仍声明失效价不保证成交', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: VERIFIED,
    stock_plan: { ts_code: '600519.SH', invalidation_milli: 9990 },    // 10.000 → 9.990
  }));
  assert.equal(d.stock_plan.ok, true, JSON.stringify(d.stock_plan.reasons));
  assert.equal(d.stock_plan.planned_risk_cents, 1000);                // 1000 × 0.010 元
  assert.ok(d.stock_plan.planned_risk_cents <= d.stock_plan.budget_cents);
  assert.match(d.stock_plan.note, /0\.5%/);
});

test('6c. 个股数量不足一手 → lot_rule 拒绝', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: VERIFIED,
    stock_plan: { ts_code: '600519.SH', quantity: 50, invalidation_milli: 9000 },
  }));
  assert.equal(d.stock_plan.ok, false);
  assert.ok(d.stock_plan.reasons.some(r => r.code === 'lot_rule'));
});

// ---------------------------------------------------------------- 7. 四种表达与现金守恒

test('7. HOLD / REDUCE_EQUITY / SELL_AND_BUY / NO_ACTION 齐全且现金守恒', () => {
  const d = sellBuy();
  assert.deepEqual(d.options.map(o => o.action), ['HOLD', 'REDUCE_EQUITY', 'SELL_AND_BUY', 'NO_ACTION']);
  for (const option of d.options) {
    assert.equal(option.cash.reconciliation_ok, true, option.action);
    assert.equal(option.cash.legs_sum_cents, option.cash.change_cents, option.action);
    assert.equal(option.cash.before_cents + option.cash.change_cents, option.cash.after_cents, option.action);
    const legs = option.legs.length ? option.legs : option.illustrative_legs;
    const legSum = legs.reduce((a, l) => a + l.cash_delta_cents, 0);
    assert.equal(legSum, option.cash.change_cents, `${option.action} 腿的现金流之和必须等于现金变化`);
    assert.equal(option.cash.before_cents, current.totals.cash_cents, option.action);
  }
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  const sell = rotate.legs.find(l => l.side === 'SELL');
  const buy = rotate.legs.find(l => l.side === 'BUY');
  assert.equal(sell.cash_delta_cents, sell.gross_cents - sell.fees.total_cents);
  assert.equal(buy.cash_delta_cents, -(buy.gross_cents + buy.fees.total_cents));
  assert.equal(rotate.cash.after_cents, current.totals.cash_cents + sell.cash_delta_cents + buy.cash_delta_cents);
  // REDUCE_EQUITY 只卖出、保留现金
  const reduce = d.options.find(o => o.action === 'REDUCE_EQUITY');
  const reduceLegs = reduce.legs.length ? reduce.legs : reduce.illustrative_legs;
  assert.equal(reduceLegs.length, 1);
  assert.equal(reduceLegs.filter(l => l.side === 'BUY').length, 0);
  assert.equal(reduce.cash.change_cents, reduceLegs[0].cash_delta_cents);
  // 每个选项都给出必需字段
  for (const option of d.options) {
    assert.ok(option.exposure);
    assert.equal(typeof option.exposure.equity_weight, 'number');
    assert.ok(Array.isArray(option.exposure.theme_weight));
    assert.ok(Array.isArray(option.exposure.industry_weight));
    assert.equal(typeof option.exposure.concentration.hhi, 'number');
    assert.equal(typeof option.exposure.cash_ratio, 'number');
    assert.equal(option.fees.assumed, true);
    assert.equal(option.fees.real_cents, null);
    assert.equal(option.fees.real_available, false);
    assert.ok(option.fees.version.length > 0);
    assert.ok(option.min_trade_unit.lot_size > 0);
    assert.ok(Array.isArray(option.invalidation_conditions) && option.invalidation_conditions.length > 0);
    assert.ok(option.stress);
    assert.ok(option.stress.total_loss_cents <= 0);
  }
  // 权重按总资产为分母：持仓 + 现金 + 理财 = 1
  const hold = d.options.find(o => o.action === 'HOLD');
  const weightSum = hold.exposure.positions.reduce((a, p) => a + p.weight, 0);
  const wealthRatio = current.totals.wealth_cents / NAV;
  assert.ok(Math.abs(weightSum + hold.exposure.cash_ratio + wealthRatio - 1) < 1e-6);
  assert.equal(hold.exposure.securities_mv_cents + hold.exposure.cash_cents + current.totals.wealth_cents, NAV);
});

test('7b. REDUCE_EQUITY 请求：只卖不买，权益敞口下降', () => {
  const d = buildDecision(base({
    action: { type: 'REDUCE_EQUITY', sell_code: '159558.SZ', sell_shares: 20000 },
  }));
  assert.equal(d.requested_action, 'REDUCE_EQUITY');
  assert.equal(d.status, 'ACTIONABLE', JSON.stringify(d.reasons));
  const reduce = d.options.find(o => o.action === 'REDUCE_EQUITY');
  assert.equal(reduce.executable, true);
  assert.equal(reduce.legs.length, 1);
  const hold = d.options.find(o => o.action === 'HOLD');
  assert.ok(reduce.exposure.equity_weight < hold.exposure.equity_weight);
  assert.ok(reduce.exposure.cash_ratio > hold.exposure.cash_ratio);
  assert.equal(reduce.cash.change_cents, reduce.legs[0].gross_cents - reduce.legs[0].fees.total_cents);
  // 未指定卖出标的时不能凭空造一个降低敞口的方案
  const noSpec = buildDecision(base({ action: { type: 'HOLD' } }));
  const reduceOption = noSpec.options.find(o => o.action === 'REDUCE_EQUITY');
  assert.equal(reduceOption.available, false);
  assert.equal(reduceOption.executable, false);
  assert.deepEqual(reduceOption.legs, []);
  assert.ok(reduceOption.reasons.some(r => r.code === 'reduce_leg_not_specified'));
});

test('7c. 无行情缓存时 HOLD 仍可对照，但交易类表达返回 DATA_INSUFFICIENT', () => {
  const d = buildDecision(base({ market_db: null, action: { type: 'HOLD' } }));
  assert.equal(d.status, 'NO_ACTION');
  assert.equal(d.options.find(o => o.action === 'HOLD').available, true);
  assert.equal(d.quotes.entries.every(q => !q.available), true);
  const trade = buildDecision(base({
    market_db: null,
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH' },
    evidence: VERIFIED,
  }));
  assert.equal(trade.status, 'DATA_INSUFFICIENT');
  assert.ok(trade.reasons.some(r => r.code === 'market_cache_unavailable'));
});

// ---------------------------------------------------------------- 8. 确定性

test('8. decision_id 确定性：重复调用一致，输入变化则变化', () => {
  const a = sellBuy();
  const b = sellBuy();
  assert.equal(a.decision_id, b.decision_id);
  assert.equal(a.decision_id.length, 64);
  assert.equal(JSON.stringify(a.decision_id), JSON.stringify(b.decision_id));
  const c = sellBuy({ evidence: { claim: '另一条结论', source: 'UNVERIFIED' } });
  assert.notEqual(a.decision_id, c.decision_id);
  const e = sellBuy({ action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 20000, buy_code: '510300.SH', buy_kind: 'ETF' } });
  assert.notEqual(a.decision_id, e.decision_id);
  // 时间不参与哈希：同一输入在不同时刻必须一致（这里通过重复调用与字段检查间接确认）
  assert.equal(a.decision_id, sellBuy().decision_id);
});

// ---------------------------------------------------------------- 9. CLI

test('9. CLI portfolio-decision 输出 JSON 且只读（exit 0）', () => {
  const run = spawnSync(process.execPath, [
    join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-decision',
    '--account', 'synthetic-test', '--action', 'sell-buy', '--snapshot', SYNTH.snapshot_id,
    '--sell', '159558.SZ', '--shares', '10000', '--buy', '510300.SH',
    '--trade-date', LAST, '--advantage-source', 'RESEARCH_VERIFIED',
    '--advantage-claim', '研究结论', '--evidence-id', 'EV-SYNTH-001',
    '--db', process.env.ASHARE_PORTFOLIO_DB_PATH, '--market-db', process.env.ASHARE_DB_PATH,
  ], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.schema, 'ashare-portfolio-decision/1.0');
  // R2：CLI 已把只读账户库传给 buildDecision，因此证据与真实账户门控都能复核；
  // 这里的正例仍是显式受控测试注入（临时账户库 + 基线 + confirmRealAccount + 证据）。
  assert.equal(out.status, 'ACTIONABLE', JSON.stringify(out.reasons));
  assert.equal(out.options.find(o => o.action === 'SELL_AND_BUY').executable, true);
  assert.equal(out.account_status.gate, 'VERIFIED');
  assert.equal(out.account_id, 'synthetic-test');
  assert.deepEqual(out.options.map(o => o.action), ['HOLD', 'REDUCE_EQUITY', 'SELL_AND_BUY', 'NO_ACTION']);
  assert.equal(out.quotes.source, 'server_cache');

  const bad = spawnSync(process.execPath, [
    join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-decision',
    '--account', 'synthetic-test', '--action', 'hold', '--snapshot', SYNTH.snapshot_id, '--trade-date', LAST,
    '--db', process.env.ASHARE_PORTFOLIO_DB_PATH, '--market-db', process.env.ASHARE_DB_PATH,
  ], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.equal(bad.status, 0, bad.stderr);
  const holdOut = JSON.parse(bad.stdout);
  assert.equal(holdOut.requested_action, 'HOLD');
  assert.equal(holdOut.status, 'NO_ACTION');
  assert.equal(holdOut.historical_performance.available, false);
  assert.equal(holdOut.max_drawdown.available, false);
});

test.after(() => {
  portfolio.close();
  market.close();
});
