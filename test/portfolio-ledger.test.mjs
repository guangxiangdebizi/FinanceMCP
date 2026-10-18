import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 全部为**合成**数据：代码、价格、成交、出入金都是为验证账本算术手工编造的，
// 与任何真实账户无关。每个事件都显式带 source: 'synthetic'。
const dir = mkdtempSync(join(tmpdir(), 'ashare-ledger-'));
const LIVE = join(dir, 'ashare.sqlite');
const PORTFOLIO = join(dir, 'portfolio.sqlite');
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = LIVE;
process.env.ASHARE_PORTFOLIO_DB_PATH = PORTFOLIO;
delete process.env.ASHARE_PORTFOLIO_ENABLED;

const { openAshareDb } = await import('../build/ashare/db.js');
const { openPortfolioDb, assertPortfolioSeparateFromMarket } = await import('../build/portfolio/db.js');
const { importDemoSnapshot } = await import('../build/portfolio/account.js');
const ledger = await import('../build/portfolio/ledger.js');

const {
  buildNavSeries, confirmRealAccount, importEvents, initBaseline, isEtfCode, nextBusinessDay,
  realAccountGate, recordEvent, replayAccount, validateLedger,
} = ledger;

const ROOT = process.cwd();

// 先建市场库，供路径别名守卫回归测试使用。
const market = openAshareDb();
market.close();
assert.ok(existsSync(LIVE), 'market database created');

const db = openPortfolioDb();

// ---------------------------------------------------------------- 合成 fixture

/** 合成快照：只包含本测试自造的数量、成本与现金。 */
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

// ---------------------------------------------------------------- 主账户 fixture
// 基线 20261016（周五）：现金 10,000.00 元；159999.SZ 1,000 份（成本 1.000 元）；
// 600000.SH 500 股（成本 10.000 元）。全部为合成标的。
openAccount('syn-a', '20261016', 1000000, [
  position('159999.SZ', '合成ETF', 1000, 1000, 1000),
  position('600000.SH', '合成股票', 500, 10000, 10000),
], '2026-10-16');

const recorded = [];
recorded.push(recordEvent(db, event({
  event_id: 'A1', account_id: 'syn-a', event_type: 'TRADE_BUY', occurred_on: '20261019',
  ts_code: '159999.SZ', quantity: 1000, price_milli: 1200, fee_cents: 600,
}))); // 毛额 120,000 分，费用 600 分 → 现金 -120,600
recorded.push(recordEvent(db, event({
  event_id: 'A2', account_id: 'syn-a', event_type: 'TRADE_SELL', occurred_on: '20261020',
  ts_code: '159999.SZ', quantity: 500, price_milli: 1500, fee_cents: 500,
}))); // 毛额 75,000，净 74,500；成本出 551,500 厘
recorded.push(recordEvent(db, event({
  event_id: 'A3', account_id: 'syn-a', event_type: 'TRADE_SELL', occurred_on: '20261021',
  ts_code: '159999.SZ', quantity: 1500, price_milli: 1600, fee_cents: 600,
}))); // 全部卖出：成本 1,654,500 厘全部出清
recorded.push(recordEvent(db, event({
  event_id: 'A4', account_id: 'syn-a', event_type: 'TRADE_SELL', occurred_on: '20261022',
  ts_code: '600000.SH', quantity: 200, price_milli: 12000, fee_cents: 600, tax_cents: 600,
}))); // 股票卖出：T+1，20261023（周二）交收
recorded.push(recordEvent(db, event({
  event_id: 'A5', account_id: 'syn-a', event_type: 'DIVIDEND', occurred_on: '20261023',
  ts_code: '600000.SH', cash_delta_cents: 5000,
})));
recorded.push(recordEvent(db, event({
  event_id: 'A6', account_id: 'syn-a', event_type: 'SPLIT', occurred_on: '20261026',
  ts_code: '600000.SH', ratio_num: 3, ratio_den: 1,
})));
recorded.push(recordEvent(db, event({
  event_id: 'A7', account_id: 'syn-a', event_type: 'CASH_DEPOSIT', occurred_on: '20261027', cash_delta_cents: 200000,
})));
recorded.push(recordEvent(db, event({
  event_id: 'A8', account_id: 'syn-a', event_type: 'CASH_WITHDRAW', occurred_on: '20261028', cash_delta_cents: -100000,
})));
recorded.push(recordEvent(db, event({
  event_id: 'A9', account_id: 'syn-a', event_type: 'FEE', occurred_on: '20261029', cash_delta_cents: -1000,
})));

const at = (date) => replayAccount(db, 'syn-a', { asOf: date });
const posOf = (state, code) => state.positions.find(p => p.ts_code === code);

// ---------------------------------------------------------------- 1-6 成交与成本

test('1. 买入：现金减少 毛额+费用，持仓数量与成本正确', () => {
  assert.equal(recorded[0].status, 'RECORDED');
  assert.equal(recorded[0].cash_delta_cents, -120600);
  assert.equal(recorded[0].settled_on, null);
  const s = at('20261019');
  assert.equal(s.cash.balance_cents, 879400);          // 1,000,000 − 120,600
  const p = posOf(s, '159999.SZ');
  assert.equal(p.quantity, 2000);
  assert.equal(p.cost_milli_total, 2206000);           // 1,000,000 + 1,200,000 + 费用 6,000
  assert.equal(p.cost_milli_avg, 1103);
  assert.equal(s.data_source, 'synthetic');
  assert.equal(s.real_account_status, 'REAL_ACCOUNT_PENDING');
});

test('2. 部分卖出：数量减少、成本按比例减少、已实现盈亏正确', () => {
  const s = at('20261020');
  const p = posOf(s, '159999.SZ');
  assert.equal(p.quantity, 1500);
  assert.equal(p.cost_milli_total, 1654500);           // 2,206,000 − 551,500
  assert.equal(p.cost_milli_avg, 1103);
  // 净收入 74,500 − 成本 55,150 = 19,350
  assert.equal(p.realized_pnl_cents, 19350);
  assert.equal(s.cash.balance_cents, 953900);          // 879,400 + 74,500（ETF 当日交收）
  assert.equal(s.cash.unsettled_cents, 0);
});

test('3. 全部卖出：持仓清零、现金正确、零持仓行不出现', () => {
  const s = at('20261021');
  assert.equal(posOf(s, '159999.SZ'), undefined, '清仓后不留零数量行');
  assert.equal(s.cash.balance_cents, 1193300);         // 953,900 + 239,400
  assert.equal(s.totals.realized_pnl_cents, 93300);    // 19,350 + 73,950
  assert.equal(s.positions.length, 1);
});

test('4. 费用与税费：计入现金与已实现盈亏', () => {
  const s = at('20261022');
  const p = posOf(s, '600000.SH');
  assert.equal(p.quantity, 300);
  assert.equal(p.cost_milli_total, 3000000);           // 5,000,000 − 2,000,000
  // 毛额 240,000 − 佣金 600 − 印花税 600 = 238,800；成本 200,000 → 38,800
  assert.equal(p.realized_pnl_cents, 38800);
  assert.equal(s.totals.realized_pnl_cents, 132100);   // 93,300 + 38,800
  assert.equal(s.totals.fees_cents, 2300);             // 600+500+600+600
  assert.equal(s.totals.taxes_cents, 600);
  // 股票卖出当日未交收
  assert.equal(s.cash.unsettled_cents, 238800);
  assert.equal(s.cash.settled_cents, 1193300);
  assert.equal(s.cash.balance_cents, 1432100);
});

test('5. 分红：现金增加、数量不变', () => {
  const s = at('20261023');
  const p = posOf(s, '600000.SH');
  assert.equal(p.quantity, 300);
  assert.equal(s.totals.dividends_cents, 5000);
  assert.equal(s.cash.balance_cents, 1437100);         // 1,193,300 + 238,800 交收 + 5,000
  assert.equal(s.cash.unsettled_cents, 0, 'T+1 卖出款在 20261023 交收');
});

test('6. 拆分 3:1：数量 ×3、均价 ÷3、总成本不变、现金不变', () => {
  const before = at('20261023');
  const after = at('20261026');
  const p = posOf(after, '600000.SH');
  assert.equal(p.quantity, 900);
  assert.equal(p.cost_milli_total, 3000000, '总成本不变');
  assert.equal(p.cost_milli_avg, 3333.333333);         // 3,000,000 厘 / 900 份
  assert.equal(after.cash.balance_cents, before.cash.balance_cents, '拆分不影响现金');
  assert.equal(after.totals.realized_pnl_cents, before.totals.realized_pnl_cents, '拆分不产生盈亏');
});

test('12. 零持仓清理与最终重放结果', () => {
  const s = replayAccount(db, 'syn-a');
  assert.deepEqual(s.positions.map(p => p.ts_code), ['600000.SH']);
  assert.ok(s.positions.every(p => p.quantity !== 0));
  assert.equal(s.cash.balance_cents, 1536100);         // 1,437,100 + 200,000 − 100,000 − 1,000
  assert.equal(s.cash.unsettled_cents, 0);
  assert.equal(s.totals.external_flow_cents, 100000);  // +200,000 − 100,000
  assert.equal(s.totals.securities_cost_cents, 300000);
  assert.equal(s.events_applied, 9);
  const v = validateLedger(db, 'syn-a');
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.violations.length, 0);
});

// ---------------------------------------------------------------- 7 / 11 / 14 净值

// 合成净值账户：基线 20261019，现金 2,000.00 元 + 159999.SZ 1,000 份（1.000 元）。
openAccount('syn-nav', '20261019', 200000, [position('159999.SZ', '合成ETF', 1000, 1000, 1000)], '2026-10-19');
const NAV_PRICES = {
  // 按日期：20261024 故意不给价格（模拟停牌/缺页）
  20261019: { '159999.SZ': 1000 },
  20261020: { '159999.SZ': 1600 },
  20261021: { '159999.SZ': 700 },
  20261022: { '159999.SZ': 700 },
  20261023: { '159999.SZ': 700 },
  20261026: { '159999.SZ': 1100 },
};
recordEvent(db, event({
  event_id: 'N1', account_id: 'syn-nav', event_type: 'CASH_DEPOSIT', occurred_on: '20261022', cash_delta_cents: 270000,
}));
recordEvent(db, event({
  event_id: 'N2', account_id: 'syn-nav', event_type: 'CASH_WITHDRAW', occurred_on: '20261023', cash_delta_cents: -108000,
}));

const nav = (to) => buildNavSeries(db, 'syn-nav', { from: '20261019', to, prices: NAV_PRICES });

test('7. 出入金不改变单位净值（单位净值法）', () => {
  const series = nav('20261023');
  const byDate = Object.fromEntries(series.points.map(p => [p.date, p]));
  assert.equal(byDate['20261019'].nav_per_unit, 1, '基线单位净值 1.00 元');
  assert.equal(byDate['20261020'].nav_per_unit, 1.2);
  assert.equal(byDate['20261021'].nav_per_unit, 0.9);
  // 20261022 存入 2,700 元：份额 3,000 → 6,000，单位净值不变
  assert.equal(byDate['20261022'].nav_per_unit, 0.9);
  assert.equal(byDate['20261022'].units, 6000);
  assert.equal(byDate['20261022'].external_flow_cents, 270000);
  assert.equal(byDate['20261021'].total_value_cents + 270000, byDate['20261022'].total_value_cents);
  // 20261023 取出 1,080 元：份额 6,000 → 4,800，单位净值不变
  assert.equal(byDate['20261023'].nav_per_unit, 0.9);
  assert.equal(byDate['20261023'].units, 4800);
  assert.equal(byDate['20261023'].external_flow_cents, -108000);
  assert.equal(byDate['20261022'].total_value_cents - 108000, byDate['20261023'].total_value_cents);
});

test('11. 停牌无价：该日标记 no_price 并沿用上一价，不伪造价格', () => {
  const series = nav('20261024');
  const last = series.points[series.points.length - 1];
  assert.equal(last.date, '20261024');
  assert.equal(last.status, 'no_price');
  assert.deepEqual(last.no_price_codes, ['159999.SZ']);
  assert.deepEqual(last.carried_forward_codes, ['159999.SZ'], '沿用 20261023 的 7.000 元');
  const prev = series.points[series.points.length - 2];
  assert.equal(prev.date, '20261023');
  assert.equal(last.total_value_cents, prev.total_value_cents, '缺价日沿用上一估值，不凭空造价格');
  assert.equal(last.nav_per_unit, prev.nav_per_unit);
});

test('14. 最大回撤：只在基线之后、按单位净值计算', () => {
  const series = nav('20261026');
  assert.equal(series.status, 'REAL_ACCOUNT_PENDING', '未确认前不声称真实账户业绩');
  assert.equal(series.performance_available, false);
  assert.deepEqual(series.max_drawdown, {
    available: true, value: -0.25, from: '20261020', to: '20261021',
  });
  // 1.20 → 0.90 = −25%，后段 0.983333 未创新低
  assert.equal(series.points[series.points.length - 1].nav_per_unit, 0.983333);
});

test('14b. 少于两个估值点 → insufficient_history（不回填基线之前）', () => {
  openAccount('syn-short', '20261019', 100000, [], '2026-10-19');
  const series = buildNavSeries(db, 'syn-short', { from: '20261019', to: '20261019', prices: {} });
  assert.equal(series.points.length, 1);
  assert.deepEqual(series.max_drawdown, { available: false, reason: 'insufficient_history' });
  assert.equal(series.from, '20261019', '序列从基线开始，不向前回填');
});

// ---------------------------------------------------------------- 8 / 9 导入

openAccount('syn-dup', '20261016', 1000000, [], '2026-10-16');
const IMPORTED = event({
  event_id: 'D1', account_id: 'syn-dup', event_type: 'TRADE_BUY', occurred_on: '20261019',
  ts_code: '159999.SZ', quantity: 100, price_milli: 1000, fee_cents: 0,
});
const firstImport = importEvents(db, 'syn-dup', [IMPORTED]);
const eventCount = () => db.prepare('SELECT COUNT(*) n FROM account_event WHERE account_id = ?').get('syn-dup').n;
const conflictCount = () => db.prepare('SELECT COUNT(*) n FROM account_event_conflict WHERE account_id = ?').get('syn-dup').n;

test('8. 重复导入同 id 同内容 → DUPLICATE，不新增行', () => {
  assert.equal(firstImport.counts.recorded, 1);
  assert.equal(eventCount(), 1);
  const again = importEvents(db, 'syn-dup', [IMPORTED]);
  assert.equal(again.aborted, false);
  assert.equal(again.counts.duplicate, 1);
  assert.equal(again.counts.recorded, 0);
  assert.equal(eventCount(), 1, '幂等：不新增行');
  assert.equal(conflictCount(), 0, '相同内容不是冲突');
});

test('9. 冲突导入 → 冲突留痕、原记录不变、整批不产生部分写入', () => {
  const tampered = { ...IMPORTED, quantity: 200 };
  const fresh = event({
    event_id: 'D2', account_id: 'syn-dup', event_type: 'CASH_DEPOSIT', occurred_on: '20261020', cash_delta_cents: 1000,
  });
  const result = importEvents(db, 'syn-dup', [tampered, fresh]);
  assert.equal(result.aborted, true);
  assert.equal(result.counts.recorded, 0);
  assert.equal(result.counts.conflict, 1);
  assert.equal(eventCount(), 1, '整批回滚：新事件 D2 没有写入');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event WHERE event_id = ?').get('D2').n, 0);
  assert.equal(db.prepare('SELECT quantity FROM account_event WHERE event_id = ?').get('D1').quantity, 100, '原记录未被覆盖');
  assert.equal(conflictCount(), 1, '冲突本身单独留痕');

  // --continue-on-conflict：保留冲突、写入不冲突的事件
  const continued = importEvents(db, 'syn-dup', [tampered, fresh], { continueOnConflict: true });
  assert.equal(continued.aborted, false);
  assert.equal(continued.counts.recorded, 1);
  assert.equal(continued.counts.conflict, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event WHERE event_id = ?').get('D2').n, 1);
  assert.equal(db.prepare('SELECT quantity FROM account_event WHERE event_id = ?').get('D1').quantity, 100);
});

// ---------------------------------------------------------------- 10 撤销

openAccount('syn-rev', '20261016', 1000000, [], '2026-10-16');
const wrongBuy = event({
  event_id: 'R-BUY', account_id: 'syn-rev', event_type: 'TRADE_BUY', occurred_on: '20261019',
  ts_code: '159999.SZ', quantity: 1000, price_milli: 1000, fee_cents: 0,
});
recordEvent(db, wrongBuy);

test('10. 撤销错误买入：状态回到买入前、原记录保留、重复撤销被拒', () => {
  const before = replayAccount(db, 'syn-rev', { asOf: '20261019' });
  assert.equal(before.cash.balance_cents, 900000);
  assert.equal(posOf(before, '159999.SZ').quantity, 1000);

  const reverse = recordEvent(db, event({
    event_id: 'R-REV', account_id: 'syn-rev', event_type: 'REVERSE', occurred_on: '20261020',
    reverses_event_id: 'R-BUY',
  }));
  assert.equal(reverse.status, 'RECORDED');

  const after = replayAccount(db, 'syn-rev', { asOf: '20261020' });
  assert.equal(after.cash.balance_cents, 1000000, '现金回到买入前');
  assert.equal(after.positions.length, 0, '持仓回到买入前');

  const original = db.prepare('SELECT * FROM account_event WHERE event_id = ?').get('R-BUY');
  assert.ok(original, '原记录保留，绝不删除');
  assert.equal(original.reversed_by, 'R-REV', '原记录标记 reversed_by');

  const twice = recordEvent(db, event({
    event_id: 'R-REV2', account_id: 'syn-rev', event_type: 'REVERSE', occurred_on: '20261021',
    reverses_event_id: 'R-BUY',
  }));
  assert.equal(twice.status, 'CONFLICT');
  assert.equal(twice.reason, 'already_reversed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event WHERE event_id = ?').get('R-REV2').n, 0);
  assert.equal(replayAccount(db, 'syn-rev').cash.balance_cents, 1000000, '重复撤销不改变状态');

  // 悬空撤销：目标不存在
  assert.throws(() => recordEvent(db, event({
    event_id: 'R-BAD', account_id: 'syn-rev', event_type: 'REVERSE', occurred_on: '20261021',
    reverses_event_id: 'NOPE',
  })), /撤销目标 NOPE 不存在/);
});

// ---------------------------------------------------------------- 13 T+1

openAccount('syn-t1', '20261016', 200000, [
  position('600000.SH', '合成股票', 1000, 12000, 10000),
  position('159999.SZ', '合成ETF', 1000, 1000, 1000),
], '2026-10-16');
const stockSell = recordEvent(db, event({
  event_id: 'T1-STOCK', account_id: 'syn-t1', event_type: 'TRADE_SELL', occurred_on: '20261016',
  ts_code: '600000.SH', quantity: 500, price_milli: 12000, fee_cents: 600, tax_cents: 600,
}));
const etfSell = recordEvent(db, event({
  event_id: 'T1-ETF', account_id: 'syn-t1', event_type: 'TRADE_SELL', occurred_on: '20261016',
  ts_code: '159999.SZ', quantity: 500, price_milli: 1000, fee_cents: 500,
}));

test('13. 股票卖出 T+1 未交收，ETF 卖出当日交收（模型假设）', () => {
  assert.equal(nextBusinessDay('20261016'), '20261019', '周五 → 下周一');
  assert.equal(stockSell.settled_on, '20261019');
  assert.equal(etfSell.settled_on, '20261016');
  assert.equal(isEtfCode('159999.SZ'), true);
  assert.equal(isEtfCode('600000.SH'), false);

  const sameDay = replayAccount(db, 'syn-t1', { asOf: '20261016' });
  // 股票 500×12.000 = 6,000.00 元 − 600 − 600 = 598,800 分未交收
  assert.equal(sameDay.cash.unsettled_cents, 598800);
  assert.equal(sameDay.cash.settled_cents, 249500);    // 200,000 + ETF 49,500
  assert.equal(sameDay.cash.balance_cents, 848300);
  assert.deepEqual(sameDay.pending_settlement, [{ ts_code: '600000.SH', cents: 598800, settles_on: '20261019' }]);

  const nextDay = replayAccount(db, 'syn-t1', { asOf: '20261019' });
  assert.equal(nextDay.cash.unsettled_cents, 0);
  assert.equal(nextDay.cash.settled_cents, 848300);
  assert.deepEqual(nextDay.pending_settlement, []);
});

// ---------------------------------------------------------------- 15 真实账户门控

openAccount('syn-pending', '20261016', 500000, [], '2026-10-16');
recordEvent(db, event({
  event_id: 'P1', account_id: 'syn-pending', event_type: 'CASH_DEPOSIT', occurred_on: '20261019', cash_delta_cents: 10000,
}));

test('15. 未确认为真实账户前一律 REAL_ACCOUNT_PENDING；只有 --confirm 才置位', () => {
  const gate = realAccountGate(db, 'syn-pending');
  assert.equal(gate.verified, false);
  assert.equal(gate.status, 'REAL_ACCOUNT_PENDING');

  const series = buildNavSeries(db, 'syn-pending', { from: '20261016', to: '20261019', prices: {} });
  assert.equal(series.status, 'REAL_ACCOUNT_PENDING');
  assert.equal(series.performance_available, false, '未确认前不把账本算术当作真实账户业绩');

  // 库内直接调用（等价于 CLI 缺 --confirm）：拒绝
  assert.throws(() => confirmRealAccount(db, 'syn-pending', {}), /--confirm/);
  assert.throws(() => confirmRealAccount(db, 'syn-pending', { confirm: false }), /--confirm/);
  assert.equal(realAccountGate(db, 'syn-pending').verified, false, '缺 --confirm 时开关不变');

  // CLI 不带 --confirm：非 0 退出，且不写 account_meta
  const refused = spawnSync(process.execPath, [
    join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-ledger-confirm-real',
    '--account', 'syn-pending', '--db', PORTFOLIO,
  ], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'CLI 必须拒绝缺少 --confirm 的确认请求');
  assert.match(refused.stderr, /--confirm/);
  assert.equal(realAccountGate(db, 'syn-pending').verified, false);

  // CLI 带 --confirm：置位，状态变化
  const confirmed = spawnSync(process.execPath, [
    join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-ledger-confirm-real',
    '--account', 'syn-pending', '--confirm', '--db', PORTFOLIO,
  ], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const out = JSON.parse(confirmed.stdout);
  assert.equal(out.status, 'REAL_ACCOUNT_VERIFIED');
  assert.equal(realAccountGate(db, 'syn-pending').verified, true);
  const after = buildNavSeries(db, 'syn-pending', { from: '20261016', to: '20261019', prices: {} });
  assert.equal(after.status, 'REAL_ACCOUNT_VERIFIED');
  assert.equal(after.performance_available, true);
  assert.equal(after.max_drawdown.available, true);
});

// ---------------------------------------------------------------- 校验与守卫

test('12b. validateLedger 如实报告越卖、悬空撤销与基线之前的事件', () => {
  openAccount('syn-bad', '20261016', 100000, [position('159999.SZ', '合成ETF', 100, 1000, 1000)], '2026-10-16');
  recordEvent(db, event({
    event_id: 'B1', account_id: 'syn-bad', event_type: 'TRADE_SELL', occurred_on: '20261019',
    ts_code: '159999.SZ', quantity: 500, price_milli: 1000, fee_cents: 0,
  }));
  // 直接注入一条悬空撤销与一条早于基线的事件，模拟被外部改坏的库
  db.prepare(`INSERT INTO account_event (event_id, account_id, event_type, occurred_on, settled_on, ts_code,
      quantity, price_milli, gross_cents, fee_cents, tax_cents, cash_delta_cents, ratio_num, ratio_den,
      reverses_event_id, reversed_by, note, source, recorded_at)
    VALUES ('B2','syn-bad','REVERSE','20261020',NULL,NULL,NULL,NULL,NULL,0,0,0,NULL,NULL,'NOPE',NULL,'','synthetic','2026-10-20T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO account_event (event_id, account_id, event_type, occurred_on, settled_on, ts_code,
      quantity, price_milli, gross_cents, fee_cents, tax_cents, cash_delta_cents, ratio_num, ratio_den,
      reverses_event_id, reversed_by, note, source, recorded_at)
    VALUES ('B3','syn-bad','CASH_DEPOSIT','20261001',NULL,NULL,NULL,NULL,NULL,0,0,1000,NULL,NULL,NULL,NULL,'','synthetic','2026-10-01T00:00:00.000Z')`).run();

  const result = validateLedger(db, 'syn-bad');
  assert.equal(result.ok, false);
  const codes = result.violations.map(v => v.code);
  assert.ok(codes.includes('oversell'), JSON.stringify(codes));
  assert.ok(codes.includes('quantity_negative'), JSON.stringify(codes));
  assert.ok(codes.includes('dangling_reverse'), JSON.stringify(codes));
  assert.ok(codes.includes('event_before_baseline'), JSON.stringify(codes));
  assert.equal(result.min_cash_balance_cents, 100000, '卖出增加现金，最低余额仍是基线 1,000.00 元');
  // 没有基线时明确拒绝重放
  assert.throws(() => replayAccount(db, 'no-such-account'), /没有基线/);
});

test('16. 账本库路径别名市场库 → 仍然拒绝（回归）', () => {
  assert.throws(() => assertPortfolioSeparateFromMarket(LIVE, LIVE), /账户数据库不能与正式市场数据库相同/);
  assert.throws(() => openPortfolioDb(LIVE, { marketPath: LIVE }), /账户数据库不能与正式市场数据库相同/);
  assert.notEqual(PORTFOLIO, LIVE);
});

test('17. 账本事件字段校验：未知类型/负数量/非整数金额/缺代码/零数量一律拒绝', () => {
  const base = { account_id: 'syn-a', occurred_on: '20261030' };
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X1', event_type: 'TELEPORT' })), /未知事件类型/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X2', event_type: 'TRADE_BUY', ts_code: '159999.SZ', quantity: -100, price_milli: 1000 })), /正整数/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X3', event_type: 'TRADE_BUY', ts_code: '159999.SZ', quantity: 100.5, price_milli: 1000 })), /整数/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X4', event_type: 'TRADE_BUY', quantity: 100, price_milli: 1000 })), /ts_code/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X5', event_type: 'TRADE_BUY', ts_code: '159999.SZ', quantity: 0, price_milli: 1000 })), /正整数/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X6', event_type: 'SPLIT', ts_code: '159999.SZ', ratio_num: 1, ratio_den: 1 })), /1:1/);
  assert.throws(() => recordEvent(db, event({ ...base, event_id: 'X7', event_type: 'CASH_DEPOSIT', cash_delta_cents: -1 })), /正数/);
  // 失败不留下任何行
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_id LIKE 'X%'").get().n, 0);
});

test('18. 事件早于基线：拒绝录入（基线已包含其影响）', () => {
  assert.throws(() => recordEvent(db, event({
    event_id: 'X9', account_id: 'syn-a', event_type: 'CASH_DEPOSIT', occurred_on: '20261015', cash_delta_cents: 100,
  })), /早于基线/);
});

test('19. CLI：init/record/import/replay/nav/validate 端到端（独立库，只写 portfolio.sqlite）', () => {
  const cliDb = join(dir, 'cli-ledger.sqlite');
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), ...args], {
    cwd: dir, env: { ...process.env, ASHARE_PORTFOLIO_DB_PATH: cliDb }, encoding: 'utf8',
  });

  const init = run('portfolio-ledger-init', '--account', 'cli-acct', '--as-of', '20261016', '--cash', '500000');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).created, true);

  const buy = run('portfolio-ledger-record', '--account', 'cli-acct', '--type', 'TRADE_BUY',
    '--event-id', 'C1', '--date', '20261019', '--ts-code', '159999.SZ', '--quantity', '1000',
    '--price-milli', '1000', '--fee-cents', '500');
  assert.equal(buy.status, 0, buy.stderr);
  const buyOut = JSON.parse(buy.stdout);
  assert.equal(buyOut.status, 'RECORDED');
  assert.equal(buyOut.cash_delta_cents, -100500);

  const eventsFile = join(dir, 'cli-events.json');
  writeFileSync(eventsFile, JSON.stringify([
    { event_id: 'C2', event_type: 'DIVIDEND', occurred_on: '20261020', ts_code: '159999.SZ', cash_delta_cents: 2000, source: 'synthetic' },
    { event_id: 'C1', event_type: 'TRADE_BUY', occurred_on: '20261019', ts_code: '159999.SZ', quantity: 1000, price_milli: 1000, fee_cents: 500, source: 'synthetic' },
  ]));
  const imported = run('portfolio-ledger-import', '--account', 'cli-acct', '--file', eventsFile);
  assert.equal(imported.status, 0, imported.stderr);
  const importOut = JSON.parse(imported.stdout);
  assert.equal(importOut.aborted, false);
  assert.equal(importOut.counts.recorded, 1);
  assert.equal(importOut.counts.duplicate, 1, '同 id 同内容是幂等');

  const replay = run('portfolio-ledger-replay', '--account', 'cli-acct');
  assert.equal(replay.status, 0, replay.stderr);
  const state = JSON.parse(replay.stdout);
  assert.equal(state.cash.balance_cents, 500000 - 100500 + 2000);
  assert.equal(state.positions[0].quantity, 1000);

  const pricesFile = join(dir, 'cli-prices.json');
  writeFileSync(pricesFile, JSON.stringify({ '159999.SZ': { 20261019: 1000, 20261020: 1200 } }));
  const nav = run('portfolio-ledger-nav', '--account', 'cli-acct', '--from', '20261019', '--to', '20261020', '--prices', pricesFile);
  assert.equal(nav.status, 0, nav.stderr);
  const navOut = JSON.parse(nav.stdout);
  assert.equal(navOut.status, 'REAL_ACCOUNT_PENDING', '未确认前不报告真实账户业绩');
  assert.equal(navOut.points.length, 2);

  const validate = run('portfolio-ledger-validate', '--account', 'cli-acct');
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).ok, true);

  // 缺 --account 等参数：明确失败而不是猜测
  const bad = run('portfolio-ledger-record', '--account', 'cli-acct', '--type', 'TRADE_BUY', '--event-id', 'C9', '--date', '20261021');
  assert.notEqual(bad.status, 0);
});

test.after(() => {
  db.close();
});
