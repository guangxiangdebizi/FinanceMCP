import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// R2 A3 反例套件：全部为**合成**数据（代码、价格、成交、出入金均为手工编造），
// 与任何真实账户无关。每个事件都显式带 source: 'synthetic'。
const dir = mkdtempSync(join(tmpdir(), 'ashare-r2-ledger-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;

const { openAshareDb } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importDemoSnapshot } = await import('../build/portfolio/account.js');
const ledger = await import('../build/portfolio/ledger.js');

const {
  buildNavSeries, importEvents, initBaseline, isEtfCode, nextBusinessDay,
  recordEvent, replayAccount, settlementCalendarFromDb, settlementRuleFor, validateLedger,
} = ledger;

// ---------------------------------------------------------------- fixture

const market = openAshareDb();
// 真实交易日历（合成种子）：20261019 为节假日，20261017/18 周末。
const CAL_ROWS = [
  ['20261015', 1], ['20261016', 1], ['20261017', 0], ['20261018', 0],
  ['20261019', 0], ['20261020', 1], ['20261021', 1], ['20261022', 1], ['20261023', 1],
];
const seedCal = market.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?,?)');
for (const [day, open] of CAL_ROWS) seedCal.run(day, open);

const db = openPortfolioDb();

function syntheticSnapshot(id, asOf, cashCents, positions) {
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  return {
    snapshot_id: id,
    as_of: asOf,
    source: 'synthetic-fixture',
    note: '合成测试快照，非真实账户',
    warnings: ['synthetic_fixture'],
    is_current: false,
    positions,
    totals: {
      total_assets_cents: cashCents + securities,
      securities_mv_cents: securities,
      cash_cents: cashCents,
      wealth_cents: 0,
      unrealized_pnl_cents: positions.reduce((sum, p) => sum + (p.market_value_cents - p.quantity * p.ref_cost_milli / 10), 0),
    },
  };
}

function position(tsCode, name, quantity, priceMilli, costMilli) {
  return {
    ts_code: tsCode, name, quantity,
    ref_price_milli: priceMilli, ref_cost_milli: costMilli,
    market_value_cents: Math.round((quantity * priceMilli) / 10),
  };
}

function openAccount(id, asOf, cashCents, positions, isoDate) {
  importDemoSnapshot(db, syntheticSnapshot(id, isoDate, cashCents, positions));
  initBaseline(db, id, { asOf, snapshotId: id });
}

const SRC = { source: 'synthetic' };
const event = (fields) => ({ ...SRC, ...fields });
const navAt = (series, date) => series.points.find(p => p.date === date);

// ---------------------------------------------------------------- 1. 工作书反例
// 初始 100 元 → 跌到 90 元 → 当日再入金 100 元，单位净值仍应为 0.90（旧实现报 0.95）。
openAccount('r2-nav-fall', '20261019', 0, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-19');
recordEvent(db, event({
  event_id: 'F-DEP', account_id: 'r2-nav-fall', event_type: 'CASH_DEPOSIT',
  occurred_on: '20261020', cash_delta_cents: 10000,
}));
const FALL_PRICES = {
  20261019: { '159999.SZ': 1000 },
  20261020: { '159999.SZ': 900 },
};

test('A3-1 反例：跌到 90 后再入金 100，单位净值 0.90（不是 0.95）', () => {
  const series = buildNavSeries(db, 'r2-nav-fall', { from: '20261019', to: '20261020', prices: FALL_PRICES });
  assert.equal(navAt(series, '20261019').nav_per_unit, 1);
  const day2 = navAt(series, '20261020');
  assert.equal(day2.total_value_cents, 19000, '跌后 90 元 + 入金 100 元 = 190 元');
  assert.equal(day2.external_flow_cents, 10000, '外部现金流必须可见');
  // 旧实现按上一日估值（100 元）折算：units=200，nav=190/200=0.95。
  assert.equal(day2.nav_per_unit, 0.9, '按当日扣流前估值（90 元）折算，nav 仍为 0.90');
  assert.equal(day2.units, 211.111111, '100 + 100/0.90 = 211.111111 份');
  assert.equal(day2.confidence, 'exact');
});

// ---------------------------------------------------------------- 2. 同日上涨 + 取款
openAccount('r2-nav-rise', '20261019', 0, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-19');
recordEvent(db, event({
  event_id: 'R-WD', account_id: 'r2-nav-rise', event_type: 'CASH_WITHDRAW',
  occurred_on: '20261020', cash_delta_cents: -2000,
}));
const RISE_PRICES = {
  20261019: { '159999.SZ': 1000 },
  20261020: { '159999.SZ': 1200 },
};

test('A3-2 同日上涨 + 取款：资金流不改变同一时点收益率', () => {
  const series = buildNavSeries(db, 'r2-nav-rise', { from: '20261019', to: '20261020', prices: RISE_PRICES });
  const day2 = navAt(series, '20261020');
  assert.equal(day2.total_value_cents, 10000, '涨到 120 元后取走 20 元');
  assert.equal(day2.external_flow_cents, -2000);
  assert.equal(day2.nav_per_unit, 1.2, '取款不改变 1.00 → 1.20 的收益');
});

// ---------------------------------------------------------------- 3. 多天现金流
openAccount('r2-nav-multi', '20261019', 0, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-19');
recordEvent(db, event({
  event_id: 'M-DEP', account_id: 'r2-nav-multi', event_type: 'CASH_DEPOSIT',
  occurred_on: '20261021', cash_delta_cents: 11000,
}));
recordEvent(db, event({
  event_id: 'M-WD', account_id: 'r2-nav-multi', event_type: 'CASH_WITHDRAW',
  occurred_on: '20261022', cash_delta_cents: -10000,
}));
const MULTI_PRICES = {
  20261019: { '159999.SZ': 1000 },
  20261020: { '159999.SZ': 1100 },
  20261021: { '159999.SZ': 1100 },
  20261022: { '159999.SZ': 900 },
};

test('A3-3 连续多天现金流：单位净值路径可复核', () => {
  const series = buildNavSeries(db, 'r2-nav-multi', { from: '20261019', to: '20261022', prices: MULTI_PRICES });
  const rows = series.points.map(p => [p.date, p.nav_per_unit, p.units]);
  assert.deepEqual(rows, [
    ['20261019', 1, 100],
    ['20261020', 1.1, 100],
    ['20261021', 1.1, 200],   // 按 1.10 折 110 元 → +100 份
    ['20261022', 1, 100],     // 按 1.00 折 -100 元 → -100 份
  ]);
  assert.equal(navAt(series, '20261021').external_flow_cents, 11000);
  assert.equal(navAt(series, '20261022').external_flow_cents, -10000);
});

// ---------------------------------------------------------------- 4. 极小金额 + 同日多笔
openAccount('r2-nav-tiny', '20261019', 10000, [], '2026-10-19');
recordEvent(db, event({
  event_id: 'T-DEP1', account_id: 'r2-nav-tiny', event_type: 'CASH_DEPOSIT',
  occurred_on: '20261020', cash_delta_cents: 1,
}));
recordEvent(db, event({
  event_id: 'T-DEP2', account_id: 'r2-nav-tiny', event_type: 'CASH_DEPOSIT',
  occurred_on: '20261020', cash_delta_cents: 3,
}));
recordEvent(db, event({
  event_id: 'T-WD', account_id: 'r2-nav-tiny', event_type: 'CASH_WITHDRAW',
  occurred_on: '20261021', cash_delta_cents: -2,
}));

test('A3-4 极小金额（分）与同日多笔：取整合并后单位净值不变', () => {
  const series = buildNavSeries(db, 'r2-nav-tiny', { from: '20261019', to: '20261021', prices: {} });
  assert.equal(navAt(series, '20261019').units, 100);
  const day2 = navAt(series, '20261020');
  assert.equal(day2.external_flow_cents, 4, '同日两笔 1+3 分合并为 4 分');
  assert.equal(day2.nav_per_unit, 1);
  assert.equal(day2.units, 100.04);
  const day3 = navAt(series, '20261021');
  assert.equal(day3.external_flow_cents, -2);
  assert.equal(day3.nav_per_unit, 1);
});

// ---------------------------------------------------------------- 5. 负前值 / 零份额
openAccount('r2-nav-zero', '20261019', 0, [], '2026-10-19');
recordEvent(db, event({
  event_id: 'Z-DEP', account_id: 'r2-nav-zero', event_type: 'CASH_DEPOSIT',
  occurred_on: '20261020', cash_delta_cents: 10000,
}));

test('A3-5a 零份额 → 不编造净值，现金流仍可见', () => {
  const series = buildNavSeries(db, 'r2-nav-zero', { from: '20261019', to: '20261020', prices: {} });
  const day1 = navAt(series, '20261019');
  assert.equal(day1.nav_per_unit, null, '初始总估值 0，不能凭空给出净值');
  assert.equal(day1.status, 'insufficient_valuation');
  assert.equal(day1.confidence, 'incomplete');
  const day2 = navAt(series, '20261020');
  assert.equal(day2.nav_per_unit, null);
  assert.equal(day2.status, 'unitisation_skipped');
  assert.equal(day2.confidence, 'incomplete');
  assert.equal(day2.external_flow_cents, 10000, '外部现金流必须保留');
  assert.equal(day2.units, 0);
});

openAccount('r2-nav-neg', '20261019', 0, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-19');
recordEvent(db, event({
  event_id: 'N-WD', account_id: 'r2-nav-neg', event_type: 'CASH_WITHDRAW',
  occurred_on: '20261020', cash_delta_cents: -20000,
}));

test('A3-5b 取款导致总估值为负 → 不编造净值', () => {
  const series = buildNavSeries(db, 'r2-nav-neg', {
    from: '20261019', to: '20261020',
    prices: { 20261019: { '159999.SZ': 1000 }, 20261020: { '159999.SZ': 900 } },
  });
  const day2 = navAt(series, '20261020');
  assert.equal(day2.total_value_cents, -11000);
  assert.equal(day2.nav_per_unit, null);
  assert.equal(day2.status, 'insufficient_valuation');
  assert.equal(day2.confidence, 'incomplete');
  assert.equal(day2.external_flow_cents, -20000);
});

// ---------------------------------------------------------------- 6. 缺价日
openAccount('r2-nav-missing', '20261019', 0, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-19');

test('A3-6 缺价日沿用上一价：confidence=carried_forward，回撤质量 incomplete', () => {
  const series = buildNavSeries(db, 'r2-nav-missing', {
    from: '20261019', to: '20261021',
    prices: { 20261019: { '159999.SZ': 1000 }, 20261020: { '159999.SZ': 1200 } },
  });
  const day3 = navAt(series, '20261021');
  assert.equal(day3.status, 'no_price');
  assert.deepEqual(day3.no_price_codes, ['159999.SZ']);
  assert.deepEqual(day3.carried_forward_codes, ['159999.SZ']);
  assert.equal(day3.confidence, 'carried_forward');
  assert.equal(day3.nav_per_unit, 1.2, '缺价日沿用上一价，不插值');
  assert.equal(series.max_drawdown.available, true);
  assert.equal(series.max_drawdown.valuation_quality, 'incomplete');
  assert.deepEqual(series.max_drawdown.incomplete_dates, ['20261021']);
  assert.match(series.max_drawdown.note, /非精确估值点/);
});

// ---------------------------------------------------------------- 7. 成本兜底
openAccount('r2-nav-cost', '20261019', 10000, [], '2026-10-19');
recordEvent(db, event({
  event_id: 'C-BUY', account_id: 'r2-nav-cost', event_type: 'TRADE_BUY',
  occurred_on: '20261020', ts_code: '831999.BJ', quantity: 10, price_milli: 1000, fee_cents: 0,
}));

test('A3-7 从未有过价格 → confidence=cost_fallback', () => {
  const series = buildNavSeries(db, 'r2-nav-cost', { from: '20261019', to: '20261020', prices: {} });
  const day2 = navAt(series, '20261020');
  assert.deepEqual(day2.cost_fallback_codes, ['831999.BJ']);
  assert.equal(day2.confidence, 'cost_fallback');
  assert.equal(navAt(series, '20261019').confidence, 'exact');
});

// ---------------------------------------------------------------- 8. 精确回撤
test('A3-8 全部精确价格 → valuation_quality=exact', () => {
  const series = buildNavSeries(db, 'r2-nav-multi', { from: '20261019', to: '20261022', prices: MULTI_PRICES });
  assert.equal(series.max_drawdown.available, true);
  assert.equal(series.max_drawdown.valuation_quality, 'exact');
  assert.deepEqual(series.max_drawdown.incomplete_dates, []);
  assert.equal(series.max_drawdown.note, null);
  assert.equal(series.max_drawdown.value, -0.090909);
  assert.equal(series.max_drawdown.from, '20261020');
  assert.equal(series.max_drawdown.to, '20261022');
});

// ---------------------------------------------------------------- 9. 交收分类
test('A3-9a 交收分类：股票/权益ETF T+1；债券/黄金/跨境 T+0；未知保守 T+1', () => {
  assert.equal(isEtfCode('159999.SZ'), true);
  assert.equal(isEtfCode('600000.SH'), false);

  const stock = settlementRuleFor('600000.SH');
  assert.equal(stock.rule, 'T+1');
  assert.equal(stock.kind, 'STOCK');
  assert.equal(stock.assumed, false);

  const equityEtf = settlementRuleFor('159999.SZ');
  assert.equal(equityEtf.rule, 'T+1');
  assert.equal(equityEtf.kind, 'EQUITY_ETF');
  assert.equal(equityEtf.assumed, false);

  // 名称含“恒生”的境内权益 ETF 仍按代码判定为权益 ETF，不因单词误判为跨境。
  const domesticHangSeng = settlementRuleFor('560390.SH', { name: '易方达恒生A股电网设备ETF' });
  assert.equal(domesticHangSeng.kind, 'EQUITY_ETF');
  assert.equal(domesticHangSeng.rule, 'T+1');

  for (const [code, kind] of [
    ['511010.SH', 'BOND_ETF'], ['518880.SH', 'GOLD_ETF'], ['513050.SH', 'CROSS_BORDER_ETF'],
    ['159920.SZ', 'CROSS_BORDER_ETF'], ['159941.SZ', 'CROSS_BORDER_ETF'],
    ['159934.SZ', 'GOLD_ETF'], ['159937.SZ', 'GOLD_ETF'],
  ]) {
    const d = settlementRuleFor(code);
    assert.equal(d.rule, 'T+0', `${code} 应 T+0`);
    assert.equal(d.kind, kind, `${code} 类别`);
    assert.equal(d.assumed, false, `${code} 是已识别规则，不是假设`);
  }

  const unknown = settlementRuleFor('999999.XX');
  assert.equal(unknown.rule, 'T+1', '无法分类按保守 T+1');
  assert.equal(unknown.assumed, true, '必须标注 settlement_rule_assumed');
  assert.match(unknown.reason, /无法分类/);
});

openAccount('r2-cal', '20261016', 0, [
  position('600000.SH', '合成股票', 1000, 1000, 1000),
  position('159999.SZ', '合成权益ETF', 1000, 1000, 1000),
  position('511010.SH', '合成债券ETF', 1000, 1000, 1000),
  position('518880.SH', '合成黄金ETF', 1000, 1000, 1000),
  position('999999.XX', '未知品种', 1000, 1000, 1000),
], '2026-10-16');
// 旧构建没有 settlementCalendarFromDb 时保持 undefined，让 NAV 反例仍能独立跑出失败值。
const calendar = typeof settlementCalendarFromDb === 'function' ? settlementCalendarFromDb(market) : undefined;
const sellOn = (id, code, extra = {}) => recordEvent(db, event({
  event_id: id, account_id: 'r2-cal', event_type: 'TRADE_SELL', occurred_on: '20261016',
  ts_code: code, quantity: 100, price_milli: 1000, fee_cents: 0, ...extra,
}), { calendar });

test('A3-9b 股票/权益ETF T+1 用真实 trade_cal 的下一个开市日（跨节假日）', () => {
  const stock = sellOn('CAL-STOCK', '600000.SH');
  assert.equal(stock.settled_on, '20261020', '20261019 是节假日，顺延到下一个开市日');
  assert.equal(stock.settlement.rule, 'T+1');
  assert.equal(stock.settlement.assumed, false);
  assert.equal(stock.settlement.calendar_assumed, false, '使用了真实 trade_cal');

  const equityEtf = sellOn('CAL-EQETF', '159999.SZ');
  assert.equal(equityEtf.settled_on, '20261020');
  assert.equal(equityEtf.settlement.rule, 'T+1');
});

test('A3-9c 债券/黄金 ETF T+0 当日交收', () => {
  const bond = sellOn('CAL-BOND', '511010.SH');
  assert.equal(bond.settled_on, '20261016');
  assert.equal(bond.settlement.rule, 'T+0');
  assert.equal(bond.settlement.calendar_assumed, false);

  const gold = sellOn('CAL-GOLD', '518880.SH');
  assert.equal(gold.settled_on, '20261016');
  assert.equal(gold.settlement.rule, 'T+0');
});

test('A3-9d 未知品种 → T+1 且标注 settlement_rule_assumed', () => {
  const unknown = sellOn('CAL-UNK', '999999.XX');
  assert.equal(unknown.settled_on, '20261020');
  assert.equal(unknown.settlement.rule, 'T+1');
  assert.equal(unknown.settlement.assumed, true);
});

test('A3-9e 未提供 trade_cal → 退回工作日并标注 calendar_assumed', () => {
  openAccount('r2-cal-nocal', '20261016', 0, [
    position('600000.SH', '合成股票', 1000, 1000, 1000),
  ], '2026-10-16');
  const noCal = recordEvent(db, event({
    event_id: 'NOCAL-SELL', account_id: 'r2-cal-nocal', event_type: 'TRADE_SELL',
    occurred_on: '20261016', ts_code: '600000.SH', quantity: 100, price_milli: 1000, fee_cents: 0,
  }));
  assert.equal(noCal.settled_on, '20261019', '只跳周末（无法知道 20261019 是节假日）');
  assert.equal(noCal.settlement.calendar_assumed, true);
  assert.equal(noCal.settlement.rule, 'T+1');
  assert.equal(nextBusinessDay('20261016'), '20261019');
});

// ---------------------------------------------------------------- 10. 买入力 vs 可取
test('A3-10 买入力含未交收，可取只含已交收', () => {
  const state = replayAccount(db, 'r2-cal', { asOf: '20261016' });
  // 5 笔各 100 份 × 1.000 元 = 10,000 分；债券/黄金 T+0 共 20,000，其余 T+1 共 30,000。
  assert.equal(state.cash.settled_cents, 20000);
  assert.equal(state.cash.unsettled_cents, 30000);
  assert.equal(state.cash.withdrawable_cents, 20000, '未交收卖出款不可提取');
  assert.equal(state.cash.buying_power_cents, 50000, '未交收卖出款可用于买入（模型假设）');
  assert.equal(state.cash.balance_cents, 50000);
  assert.equal(state.cash.buying_power_cents, state.cash.settled_cents + state.cash.unsettled_cents);
  assert.equal(state.pending_settlement.length, 3);
  assert.ok(state.pending_settlement.every(p => p.settlement_rule === 'T+1'));
  assert.equal(state.pending_settlement.find(p => p.ts_code === '999999.XX').settlement_rule_assumed, true);
  assert.equal(state.pending_settlement.find(p => p.ts_code === '600000.SH').settlement_rule_assumed, false);
});

// ---------------------------------------------------------------- 额外：现金买入力行为不变
test('A3-10b 卖出款交收前确实可以用于买入', () => {
  openAccount('r2-spend', '20261016', 0, [position('600000.SH', '合成股票', 1000, 1000, 1000)], '2026-10-16');
  // event_id 决定同日重放顺序：SELL 必须排在 BUY 之前。
  recordEvent(db, event({
    event_id: 'SPEND-SELL', account_id: 'r2-spend', event_type: 'TRADE_SELL', occurred_on: '20261016',
    ts_code: '600000.SH', quantity: 100, price_milli: 1000, fee_cents: 0,
  }), { calendar });
  // 同日用未交收的卖出款买入债券 ETF（T+0）：50 份 × 1.000 元 = 5,000 分。
  const buy = recordEvent(db, event({
    event_id: 'SPEND-ZBUY', account_id: 'r2-spend', event_type: 'TRADE_BUY', occurred_on: '20261016',
    ts_code: '511010.SH', quantity: 50, price_milli: 1000, fee_cents: 0,
  }));
  assert.equal(buy.status, 'RECORDED');
  const state = replayAccount(db, 'r2-spend', { asOf: '20261016' });
  assert.equal(state.cash.unsettled_cents, 5000, '买入消耗了部分未交收卖出款');
  assert.equal(state.cash.settled_cents, 0, '没有动用已交收现金');
  assert.equal(state.cash.withdrawable_cents, 0);
  assert.equal(state.cash.buying_power_cents, 5000);
});

// ---------------------------------------------------------------- 11. 不变量回归
test('A3-12 幂等/冲突/撤销与基线后回撤仍成立', () => {
  openAccount('r2-inv', '20261016', 50000, [], '2026-10-16');
  const buy = event({
    event_id: 'INV-BUY', account_id: 'r2-inv', event_type: 'TRADE_BUY', occurred_on: '20261019',
    ts_code: '159999.SZ', quantity: 100, price_milli: 1000, fee_cents: 0,
  });
  assert.equal(recordEvent(db, buy).status, 'RECORDED');
  assert.equal(recordEvent(db, buy).status, 'DUPLICATE', '同 id 同内容幂等');
  const conflict = recordEvent(db, { ...buy, quantity: 200 });
  assert.equal(conflict.status, 'CONFLICT', '同 id 不同内容进入冲突表，不覆盖');
  assert.equal(db.prepare('SELECT quantity FROM account_event WHERE event_id = ?').get('INV-BUY').quantity, 100);

  const rev = recordEvent(db, event({
    event_id: 'INV-REV', account_id: 'r2-inv', event_type: 'REVERSE', occurred_on: '20261020',
    reverses_event_id: 'INV-BUY',
  }));
  assert.equal(rev.status, 'RECORDED');
  assert.equal(recordEvent(db, event({
    event_id: 'INV-REV2', account_id: 'r2-inv', event_type: 'REVERSE', occurred_on: '20261021',
    reverses_event_id: 'INV-BUY',
  })).reason, 'already_reversed');
  assert.equal(replayAccount(db, 'r2-inv').cash.balance_cents, 50000, '撤销后现金回到买入前');
  assert.equal(validateLedger(db, 'r2-inv').ok, true);

  // 基线-only：不足两个估值点，绝不回填历史。
  openAccount('r2-short', '20261016', 100000, [], '2026-10-16');
  const only = buildNavSeries(db, 'r2-short', { from: '20261016', to: '20261016', prices: {} });
  assert.deepEqual(only.max_drawdown, { available: false, reason: 'insufficient_history' });
  assert.equal(only.status, 'REAL_ACCOUNT_PENDING');
  assert.equal(only.performance_available, false);
});

// ---------------------------------------------------------------- 12. 停牌标记不插值
test('A3-6b 缺价日总估值等于上一估值，不做插值', () => {
  const series = buildNavSeries(db, 'r2-nav-missing', {
    from: '20261019', to: '20261021',
    prices: { 20261019: { '159999.SZ': 1000 }, 20261020: { '159999.SZ': 1200 } },
  });
  const prev = navAt(series, '20261020');
  const last = navAt(series, '20261021');
  assert.equal(last.total_value_cents, prev.total_value_cents);
  assert.equal(last.nav_per_unit, prev.nav_per_unit);
  assert.equal(last.confidence, 'carried_forward');
});

test.after(() => {
  db.close();
  market.close();
});
