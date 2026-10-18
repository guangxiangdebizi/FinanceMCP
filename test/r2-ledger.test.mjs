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
  readAccountCompleteness, reconcileAccountVsLedger, recordEvent, replayAccount,
  setAccountCompleteness, settlementCalendarFromDb, settlementRuleFor, validateLedger,
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

// ---------------------------------------------------------------- 13. A3 反例：from 不得重新锚定
// 基线 20261016，持仓 159558.SZ 1000 份 @1.000 元；价格 16→1.000、19→1.100、20→1.210、21→0.900。
openAccount('r2-nav-from', '20261016', 0, [position('159558.SZ', '半导体设备ETF', 1000, 1000, 1000)], '2026-10-16');
const FROM_PRICES = {
  20261016: { '159558.SZ': 1000 },
  20261019: { '159558.SZ': 1100 },
  20261020: { '159558.SZ': 1210 },
  20261021: { '159558.SZ': 900 },
};

test('A3-11 反例：from 变化不得改变重叠日期的单位净值（旧实现从 from 重新锚定）', () => {
  const full = buildNavSeries(db, 'r2-nav-from', { from: '20261016', to: '20261021', prices: FROM_PRICES });
  const late = buildNavSeries(db, 'r2-nav-from', { from: '20261020', to: '20261021', prices: FROM_PRICES });

  assert.equal(navAt(full, '20261021').nav_per_unit, 0.9);
  // 旧实现把 20261020 重新锚定为 1.00：units=121，20261021 的 0.743802 是错的。
  assert.equal(navAt(late, '20261021').nav_per_unit, 0.9, 'from 只裁剪输出，不得重新锚定份额');
  for (const point of late.points) {
    assert.equal(point.nav_per_unit, navAt(full, point.date).nav_per_unit, `${point.date} 重叠点必须一致`);
    assert.equal(point.units, navAt(full, point.date).units, `${point.date} 份额必须一致`);
  }
  // 输出确实被裁剪：只保留 >= from 的点。
  assert.deepEqual(late.points.map(p => p.date), ['20261020', '20261021']);
  assert.equal(late.from, '20261020');
  assert.equal(late.to, '20261021');
  assert.equal(late.max_drawdown.available, true);
  assert.equal(late.max_drawdown.value, -0.256198, '1.210 → 0.900');
});

test('A3-11b from 晚于现金流日：历史现金流仍参与折算（不重新锚定）', () => {
  // r2-nav-multi：20261021 入金 110 元后份额应为 200；若从 20261021 重新锚定则份额=220，
  // 20261022 的单位净值会被错误算成 0.909091。
  const series = buildNavSeries(db, 'r2-nav-multi', { from: '20261021', to: '20261022', prices: MULTI_PRICES });
  assert.deepEqual(series.points.map(p => p.date), ['20261021', '20261022']);
  assert.equal(navAt(series, '20261021').units, 200, '从基线起算：100 + 100/1.10 = 200');
  assert.equal(navAt(series, '20261022').nav_per_unit, 1, '取款不改变单位净值');
  const full = buildNavSeries(db, 'r2-nav-multi', { from: '20261019', to: '20261022', prices: MULTI_PRICES });
  for (const point of series.points) {
    assert.equal(point.nav_per_unit, navAt(full, point.date).nav_per_unit);
    assert.equal(point.units, navAt(full, point.date).units);
  }
});

// ---------------------------------------------------------------- 14. A4 可卖数量与 T+0/T+1
// 真实交易日历：20261016（五）→ 20261020（二，19 为节假日）→ 20261021。
const sellableCalendar = settlementCalendarFromDb(market);

test('A4-1 反例：权益 ETF 当日买入 → sellable_quantity=0，卖出被拒（insufficient_sellable_position）', () => {
  openAccount('r2-sellable-eq', '20261016', 100000, [], '2026-10-16');
  recordEvent(db, event({
    event_id: 'SE-BUY', account_id: 'r2-sellable-eq', event_type: 'TRADE_BUY', occurred_on: '20261020',
    ts_code: '159558.SZ', quantity: 1000, price_milli: 1000, fee_cents: 0,
  }));
  const sameDay = replayAccount(db, 'r2-sellable-eq', { asOf: '20261020', calendar: sellableCalendar });
  const p = sameDay.positions.find(x => x.ts_code === '159558.SZ');
  assert.equal(p.quantity, 1000);
  assert.equal(p.sellable_quantity, 0, 'T+1：当日买入不可卖');
  assert.equal(p.settlement_rule, 'T+1');
  assert.equal(sameDay.reconstruction.sellable_basis, 'trade_calendar');
  assert.equal(sameDay.reconstruction.previous_trading_day, '20261016', '19 日节假日，前一交易日是 16 日');

  // 同一账户按 20261021 重建：买入日 20261020 已是前一交易日 → 可卖。
  const nextDay = replayAccount(db, 'r2-sellable-eq', { asOf: '20261021', calendar: sellableCalendar });
  assert.equal(nextDay.positions.find(x => x.ts_code === '159558.SZ').sellable_quantity, 1000, '隔日可卖');
});

test('A4-2 债券 ETF 当日买入当日可卖（T+0）', () => {
  openAccount('r2-sellable-bond', '20261016', 100000, [], '2026-10-16');
  recordEvent(db, event({
    event_id: 'SB-BUY', account_id: 'r2-sellable-bond', event_type: 'TRADE_BUY', occurred_on: '20261020',
    ts_code: '511010.SH', quantity: 100, price_milli: 100000, fee_cents: 0,
  }));
  const state = replayAccount(db, 'r2-sellable-bond', { asOf: '20261020', calendar: sellableCalendar });
  const p = state.positions.find(x => x.ts_code === '511010.SH');
  assert.equal(p.settlement_rule, 'T+0');
  assert.equal(p.sellable_quantity, 100, '债券 ETF T+0：当日买入当日可卖');
});

test('A4-3 混合同日买入 + 历史持仓：只允许卖出历史份额', () => {
  // 基线（20261016）自带 1000 份 159558.SZ；20261020 再买 500 份。
  openAccount('r2-sellable-mix', '20261016', 100000,
    [position('159558.SZ', '半导体设备ETF', 1000, 1000, 1000)], '2026-10-16');
  recordEvent(db, event({
    event_id: 'SM-BUY', account_id: 'r2-sellable-mix', event_type: 'TRADE_BUY', occurred_on: '20261020',
    ts_code: '159558.SZ', quantity: 500, price_milli: 1000, fee_cents: 0,
  }));
  const state = replayAccount(db, 'r2-sellable-mix', { asOf: '20261020', calendar: sellableCalendar });
  const p = state.positions.find(x => x.ts_code === '159558.SZ');
  assert.equal(p.quantity, 1500);
  assert.equal(p.sellable_quantity, 1000, '只有基线（历史）份额可卖，当日买入的 500 份不可卖');
});

test('A4-4 当日先卖后买：可卖数量按 FIFO 消耗后如实减少', () => {
  openAccount('r2-sellable-fifo', '20261016', 100000,
    [position('159558.SZ', '半导体设备ETF', 1000, 1000, 1000)], '2026-10-16');
  // event_id 顺序决定同日重放顺序：SELL 先于 BUY。
  recordEvent(db, event({
    event_id: 'SF-SELL', account_id: 'r2-sellable-fifo', event_type: 'TRADE_SELL', occurred_on: '20261020',
    ts_code: '159558.SZ', quantity: 600, price_milli: 1000, fee_cents: 0,
  }), { calendar: sellableCalendar });
  recordEvent(db, event({
    event_id: 'SF-BUY', account_id: 'r2-sellable-fifo', event_type: 'TRADE_BUY', occurred_on: '20261020',
    ts_code: '159558.SZ', quantity: 300, price_milli: 1000, fee_cents: 0,
  }));
  const state = replayAccount(db, 'r2-sellable-fifo', { asOf: '20261020', calendar: sellableCalendar });
  const p = state.positions.find(x => x.ts_code === '159558.SZ');
  assert.equal(p.quantity, 700);
  assert.equal(p.sellable_quantity, 400, '1000 − 600 历史份额可卖；当日买入的 300 份不可卖');
});

test('A4-5 缺少交易日历：仍排除当日买入，并标注 calendar_assumed', () => {
  const state = replayAccount(db, 'r2-sellable-eq', { asOf: '20261020' });
  const p = state.positions.find(x => x.ts_code === '159558.SZ');
  assert.equal(p.sellable_quantity, 0, '保守：无日历也不把当日买入当成可卖');
  assert.equal(state.reconstruction.sellable_basis, 'calendar_assumed');
  assert.equal(state.reconstruction.previous_trading_day, null);
});

// ---------------------------------------------------------------- 15. A1 跨日重建 / A2 对账
test('A1-1 无事件的日期也能纯按基线重建，并给出重建依据', () => {
  openAccount('r2-reconstruct', '20261016', 500000, [position('159558.SZ', '半导体设备ETF', 1000, 1000, 1000)], '2026-10-16');
  recordEvent(db, event({
    event_id: 'RC-BUY', account_id: 'r2-reconstruct', event_type: 'TRADE_BUY', occurred_on: '20261020',
    ts_code: '159558.SZ', quantity: 1000, price_milli: 1000, fee_cents: 0,
  }));
  // 20261021 没有任何事件：仍应得到确定状态。
  const state = replayAccount(db, 'r2-reconstruct', { asOf: '20261021', calendar: sellableCalendar });
  assert.equal(state.positions.find(p => p.ts_code === '159558.SZ').quantity, 2000);
  assert.equal(state.cash.balance_cents, 400000);
  assert.equal(state.events_applied, 1, '只应用了 20261020 的买入');
  assert.equal(state.reconstruction.basis, 'baseline_plus_events');
  assert.equal(state.reconstruction.from_snapshot, false);
  assert.equal(state.reconstruction.baseline_as_of, '20261016');
  assert.equal(state.reconstruction.as_of, '20261021');
});

test('A2-1 对账一致：快照数量/现金/证券市值与账本重放相同 → ok', () => {
  const snapshot = {
    snapshot_id: 'r2-reconstruct',
    as_of: '2026-10-21',
    positions: [{ ts_code: '159558.SZ', quantity: 2000, ref_price_milli: 1000 }],
    totals: { cash_cents: 400000, securities_mv_cents: 200000 },
  };
  const result = reconcileAccountVsLedger(db, 'r2-reconstruct', snapshot);
  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.as_of, '20261021');
  assert.match(result.note, /一致/);
});

test('A2-2 对账冲突：数量/现金/市值任一项不符 → ok=false 并逐项报出', () => {
  const snapshot = {
    snapshot_id: 'r2-reconstruct',
    as_of: '2026-10-21',
    positions: [
      { ts_code: '159558.SZ', quantity: 1900, ref_price_milli: 1000 }, // 少 100 份
      { ts_code: '516080.SH', quantity: 100, ref_price_milli: 636 },   // 账本没有
    ],
    totals: { cash_cents: 400000, securities_mv_cents: 1963600 },
  };
  const result = reconcileAccountVsLedger(db, 'r2-reconstruct', snapshot);
  assert.equal(result.ok, false);
  const byField = result.mismatches.map(m => [m.field, m.code]);
  assert.ok(byField.some(([f, c]) => f === 'quantity' && c === '159558.SZ'), JSON.stringify(result.mismatches));
  assert.ok(byField.some(([f, c]) => f === 'quantity' && c === '516080.SH'), JSON.stringify(result.mismatches));
  const q = result.mismatches.find(m => m.field === 'quantity' && m.code === '159558.SZ');
  assert.equal(q.snapshot_value, 1900);
  assert.equal(q.ledger_value, 2000);
  assert.equal(q.delta, -100);
  assert.match(result.note, /不一致/);
});

test('A2-3 现金不一致单独报出（代码数量相同）', () => {
  const snapshot = {
    snapshot_id: 'r2-reconstruct',
    as_of: '2026-10-21',
    positions: [{ ts_code: '159558.SZ', quantity: 2000, ref_price_milli: 1000 }],
    totals: { cash_cents: 399999, securities_mv_cents: 200000 },
  };
  const result = reconcileAccountVsLedger(db, 'r2-reconstruct', snapshot);
  assert.equal(result.ok, false);
  const cash = result.mismatches.find(m => m.field === 'cash_cents');
  assert.ok(cash);
  assert.equal(cash.snapshot_value, 399999);
  assert.equal(cash.ledger_value, 400000);
  assert.equal(cash.delta, -1);
});

// ---------------------------------------------------------------- 16. 完整性声明（B3）
test('B3-1 完整性声明默认 unreported_trade_risk=true，必须 confirm 且必须有 recordedBy', () => {
  assert.throws(() => setAccountCompleteness(db, 'r2-reconstruct', { as_of: '20261021' }), /confirm/);
  assert.throws(() => setAccountCompleteness(db, 'r2-reconstruct', { as_of: '20261021' }, { confirm: true }), /recordedBy/);
  assert.throws(() => setAccountCompleteness(db, 'r2-reconstruct', { as_of: '20261021' }, { confirm: true, recordedBy: '   ' }), /recordedBy/);
  assert.equal(readAccountCompleteness(db, 'r2-reconstruct'), null, '被拒绝的写入不留下任何声明');
  const result = setAccountCompleteness(db, 'r2-reconstruct', { as_of: '20261021' }, { confirm: true, recordedBy: 'tester' });
  // 契约：返回值本身就是 AccountCompleteness；同时带 completeness 别名供 CLI 直接打印。
  assert.equal(result.unreported_trade_risk, true, '缺省保守：存在未上报交易风险');
  assert.equal(result.completeness.unreported_trade_risk, true);
  assert.equal(result.reported_events_through, null);
  assert.equal(result.as_of, '20261021');
  assert.equal(result.recorded_by, 'tester');
  const explicit = setAccountCompleteness(db, 'r2-reconstruct', {
    as_of: '20261021', reported_events_through: '20261020', unreported_trade_risk: false,
    last_user_reconciled_at: '2026-10-21T08:00:00Z', note: 'user checked',
  }, { confirm: true, recordedBy: 'tester' });
  assert.equal(explicit.unreported_trade_risk, false);
  assert.equal(explicit.reported_events_through, '20261020');
  assert.equal(explicit.recorded_by, 'tester');
  assert.equal(readAccountCompleteness(db, 'r2-reconstruct').unreported_trade_risk, false);
  // reported_events_through 不能晚于声明日
  assert.throws(() => setAccountCompleteness(db, 'r2-reconstruct', {
    as_of: '20261020', reported_events_through: '20261021',
  }, { confirm: true, recordedBy: 'tester' }), /不能晚于/);
});

test.after(() => {
  db.close();
  market.close();
});
