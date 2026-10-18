import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

// Isolated temp dir: the market DB path and the portfolio DB path are separate files.
const dir = mkdtempSync(join(tmpdir(), 'ashare-portfolio-'));
const LIVE = join(dir, 'ashare.sqlite');
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = LIVE;
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;

const { openAshareDb } = await import('../build/ashare/db.js');
const account = await import('../build/portfolio/account.js');
const { openPortfolioDb, assertPortfolioSeparateFromMarket, portfolioDbPath, portfolioEnabled } = await import('../build/portfolio/db.js');
const scenarioLib = await import('../build/portfolio/scenario.js');
const rules = await import('../build/portfolio/rules.js');

const {
  DEMO_SNAPSHOT, DEMO_SNAPSHOT_ID, accountSummary, importDemoSnapshot, latestSnapshot, reconcile, THEME_BY_CODE, valueCents,
} = account;
const { computeFees, buildScenario, affordableLots, normalizeQuote } = scenarioLib;

const DATE = '20261018';
const ROOT = process.cwd();

// Create the market DB first so the alias tests have a real file to point at.
const market = openAshareDb();
market.close();
assert.ok(existsSync(LIVE), 'market database created');

const db = openPortfolioDb();
const firstImport = importDemoSnapshot(db);
const secondImport = importDemoSnapshot(db);
const snapshot = latestSnapshot(db);
const summary = accountSummary(snapshot);
const positionCount = () => db.prepare('SELECT COUNT(*) n FROM position').get().n;
const snapshotCount = () => db.prepare('SELECT COUNT(*) n FROM account_snapshot').get().n;

// ---------------------------------------------------------------- A. 基线快照与对账

test('1. 基线快照导入幂等：重复导入不新增行', () => {
  assert.equal(firstImport.inserted, true);
  assert.equal(secondImport.inserted, false);
  assert.equal(snapshotCount(), 1);
  assert.equal(positionCount(), 5);
  assert.equal(snapshot.snapshot_id, DEMO_SNAPSHOT_ID);
  assert.equal(snapshot.source, 'prd-screenshot-v1.0');
  assert.equal(snapshot.is_current, false);
  assert.deepEqual([...snapshot.warnings].sort(), ['historical_drawdown_unknown', 'not_latest_account', 'trade_dates_unverified']);
});

test('1b. 同一 snapshot_id 但内容不同时拒绝覆盖冻结基线', () => {
  const tampered = {
    ...DEMO_SNAPSHOT,
    totals: { ...DEMO_SNAPSHOT.totals, cash_cents: DEMO_SNAPSHOT.totals.cash_cents + 1 },
  };
  assert.throws(() => importDemoSnapshot(db, tampered), /已存在且内容不同/);
  assert.equal(snapshotCount(), 1, 'no new snapshot row');
});

test('2. 对账：Σ 持仓 = 74,362.50，且 74,362.50+1,413.70+0.33 = 75,776.53（精确到分）', () => {
  const r = reconcile(snapshot);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  // Exact expected deltas, not "close enough": any drift fails loudly here.
  assert.equal(r.deltas.position_sum_vs_securities_mv_cents, 0);
  assert.equal(r.deltas.components_vs_total_cents, 0);
  assert.equal(snapshot.totals.securities_mv_cents, 7436250);
  assert.equal(snapshot.totals.cash_cents, 141370);
  assert.equal(snapshot.totals.wealth_cents, 33);
  assert.equal(snapshot.totals.total_assets_cents, 7577653);
  assert.equal(7436250 + 141370 + 33, 7577653);
  // Every position's stated market value matches quantity × reference price.
  for (const check of r.checks.filter(c => c.id.startsWith('position_mv_vs_qty_price'))) {
    assert.equal(check.delta_cents, 0, check.detail);
  }
  // The screenshot's P/L does not equal MV − cost basis; it is reported, not fixed.
  // 重算浮亏 -17,838.40 元 vs 截图 -17,812.87 元 → 差 -25.53 元 = -2,553 分。
  assert.equal(r.deltas.unrealized_pnl_recomputed_vs_stated_cents, -2553);
  assert.equal(snapshot.totals.unrealized_pnl_cents, -1781287);
  assert.ok(r.reasons.some(x => x.startsWith('unrealized_pnl_mismatch')), JSON.stringify(r.reasons));
});

test('3. 权重、证券仓位与现金比例', () => {
  const semi = summary.positions.find(p => p.ts_code === '159558.SZ');
  assert.equal(semi.market_value_cents, 5507150);
  assert.equal(semi.weight.toFixed(6), '0.726762');       // 72.6762%
  assert.equal((semi.weight * 100).toFixed(4), '72.6762');
  assert.equal((summary.securities_ratio * 100).toFixed(4), '98.1339');
  assert.equal((summary.cash_ratio * 100).toFixed(4), '1.8656');
  assert.equal((summary.wealth_ratio * 100).toFixed(4), '0.0004');
  assert.equal(summary.totals.total_assets, 75776.53);
  assert.equal(summary.totals.securities_mv, 74362.5);
  assert.equal(summary.totals.cash, 1413.7);
  assert.equal(summary.totals.wealth, 0.33);
});

test('4. HHI、有效持仓数与第一持仓集中度与手算一致', () => {
  // (0.013263)^2+(0.010505)^2+(0.726762)^2+(0.083931)^2+(0.146879)^2 = 0.5570871
  assert.equal(summary.concentration.hhi.toFixed(6), '0.557087');
  assert.equal(summary.concentration.effective_positions.toFixed(4), '1.7951');
  assert.equal(summary.top_position.ts_code, '159558.SZ');
  assert.equal(summary.top_position.weight.toFixed(6), '0.726762');
  assert.ok(summary.concentration.hhi > 0.5, 'single-theme concentration is high');
  assert.ok(summary.concentration.effective_positions < 2, 'five holdings behave like fewer than two');
});

test('4b. 主题暴露：五类行业 + 权益主题 100%', () => {
  const byTheme = Object.fromEntries(summary.theme_exposure.map(t => [t.theme, t.weight]));
  assert.deepEqual(Object.keys(byTheme).sort(), Object.keys(THEME_BY_CODE).map(c => THEME_BY_CODE[c]).sort());
  assert.equal(byTheme.semiconductor_equipment.toFixed(6), '0.726762');
  assert.equal(byTheme.aerospace.toFixed(6), '0.013263');
  assert.equal(byTheme.robotics.toFixed(6), '0.010505');
  assert.equal(byTheme.innovative_drug.toFixed(6), '0.083931');
  assert.equal(byTheme.power_grid_equipment.toFixed(6), '0.146879');
  assert.equal(summary.equity_theme_exposure.weight_of_securities, 1);
});

test('5. 历史业绩与历史最大回撤显式不可用（不伪造）', () => {
  assert.equal(summary.historical_performance.available, false);
  assert.equal(summary.historical_performance.reason, 'no_history');
  assert.equal(summary.max_drawdown.available, false);
  assert.equal(summary.max_drawdown.reason, 'no_history');
});

// ---------------------------------------------------------------- B. 费用与手数

test('B1. 费用分解：佣金下限 5 元、无印花税/过户费、滑点单列', () => {
  // 10,050 分 = 100.50 元：佣金 10050×0.00025 = 2.51 分 → 取 5 元下限
  const small = computeFees(10050, 'sell', rules.DEFAULT_FEE_RULES);
  assert.deepEqual(small, {
    commission_cents: 500, transfer_fee_cents: 0, stamp_duty_cents: 0,
    slippage_estimate_cents: 5, total_cents: 505, assumed: true,
  });
  // 935,000 分 = 9,350.00 元：0.00025 → 233.75 → 234 分（2.34 元）仍低于 5 元下限
  const mid = computeFees(935000, 'sell', rules.DEFAULT_FEE_RULES);
  assert.equal(mid.commission_cents, 500);
  assert.equal(mid.slippage_estimate_cents, 468);
  assert.equal(mid.total_cents, 968);
  assert.equal(mid.transfer_fee_cents, 0);
  assert.equal(mid.stamp_duty_cents, 0);
  // 2,000,000 分 = 20,000 元：0.00025 → 500 分，正好等于下限；滑点 1000 分
  const large = computeFees(2000000, 'buy', rules.DEFAULT_FEE_RULES);
  assert.equal(large.commission_cents, 500);
  assert.equal(large.slippage_estimate_cents, 1000);
  assert.equal(large.stamp_duty_cents, 0, 'ETF 无印花税（假设）');
  assert.equal(large.total_cents, 1500);
});

test('B2. 可买手数在计入最低佣金后仍不超预算', () => {
  const lotCost = valueCents(100, 4000); // 100 份 × 4.000 元 = 400 元
  const budget = 1075402;
  const lots = affordableLots(budget, lotCost, rules.DEFAULT_FEE_RULES);
  assert.equal(lots, 26);
  const gross = lots * lotCost;
  assert.ok(gross + computeFees(gross, 'buy', rules.DEFAULT_FEE_RULES).total_cents <= budget);
  const next = (lots + 1) * lotCost;
  assert.ok(next + computeFees(next, 'buy', rules.DEFAULT_FEE_RULES).total_cents > budget, 'one more lot would exceed the budget');
  // 连一手都买不起时返回 0，而不是负数
  assert.equal(affordableLots(10000, lotCost, rules.DEFAULT_FEE_RULES), 0);
});

// ---------------------------------------------------------------- C. 情景

const quote = (code, close, tradeDate = DATE, extra = {}) => [code, { trade_date: tradeDate, close, quality: 'READY', list_status: 'L', ...extra }];
const GOOD_QUOTES = new Map([
  quote('159558.SZ', 0.935),
  quote('510300.SH', 4.0),
]);
const SELL_BUY = { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH' };
const ADVANTAGE = { advantage: true, basis: '测试用：假定的相对优势，仅验证计算路径' };

const rotate = (overrides = {}) => buildScenario({
  snapshot: summary, as_of_trade_date: DATE, quotes: GOOD_QUOTES, action: SELL_BUY,
  evidence: ADVANTAGE, ...overrides,
});

test('6. 卖出 10,000 份 159558 → 买入 510300：手数、费用、剩余现金、前后权重', () => {
  const s = rotate();
  assert.equal(s.status, 'EXECUTABLE', JSON.stringify(s.reasons));
  assert.equal(s.decision_id.length, 64);

  // 卖出：10000 × 0.935 元 = 9,350.00 元
  assert.equal(s.trade.sell.gross_cents, 935000);
  assert.equal(s.trade.sell.fees.commission_cents, 500);   // 2.34 元 → 5 元下限
  assert.equal(s.trade.sell.fees.slippage_estimate_cents, 468);
  assert.equal(s.trade.sell.fees.total_cents, 968);
  assert.equal(s.trade.sell.net_proceeds_cents, 934032);   // 935000 − 968
  assert.equal(s.trade.budget_cents, 1075402);             // 934032 + 141370

  // 买入：一手 = 100 × 4.000 = 400 元；预算可买 26 手（剩下不足 400 元 + 费用）
  assert.equal(s.trade.buy.lots, 26);
  assert.equal(s.trade.buy.quantity, 2600);
  assert.equal(s.trade.buy.gross_cents, 1040000);
  assert.equal(s.trade.buy.fees.commission_cents, 500);   // 2.60 元 → 5 元下限
  assert.equal(s.trade.buy.fees.slippage_estimate_cents, 520);
  assert.equal(s.trade.buy.fees.total_cents, 1020);
  assert.equal(s.trade.buy.total_cost_cents, 1041020);
  assert.equal(s.trade.residual_cash_cents, 34382);
  assert.equal(s.trade.fees_cents, 968 + 1020);

  // 交易前
  assert.equal(s.before.semiconductor_equipment_weight.toFixed(6), '0.726762');
  assert.equal(s.before.concentration.hhi.toFixed(6), '0.557087');
  // 交易后：159558 = 48,900 × 0.935 = 45,721.50；510300 = 10,400.00
  const semi = s.after.positions.find(p => p.ts_code === '159558.SZ');
  assert.equal(semi.quantity, 48900);
  assert.equal(semi.market_value_cents, 4572150);
  const bought = s.after.positions.find(p => p.ts_code === '510300.SH');
  assert.equal(bought.market_value_cents, 1040000);
  assert.equal(bought.quantity, 2600);
  assert.equal(s.after.semiconductor_equipment_weight.toFixed(6), '0.603531');
  assert.equal(s.after.cash_cents, 34382); // 141370 + 934032 − 1041020
  // 费用使总资产下降，且降幅正好等于双边费用（快照价 = 行情价，价格影响为 0）
  assert.equal(s.trade.price_effect_cents, 0);
  assert.equal(s.before.total_assets_cents - s.after.total_assets_cents, 968 + 1020);
  assert.ok(s.after.concentration.hhi < s.before.concentration.hhi, 'rotation lowers single-theme concentration');

  // 三种情景对照齐全
  assert.deepEqual(s.comparison.map(r => r.action), ['HOLD', 'ROTATE', 'REDUCE_EQUITY']);
  assert.equal(s.comparison.find(r => r.action === 'ROTATE').executable, true);
  assert.equal(s.risk.kind, 'declared_stress');
  assert.equal(s.risk.shock_pct ?? s.risk.stress.shock_pct, -0.1);
  assert.equal(s.historical_performance.available, false);
  assert.equal(s.max_drawdown.available, false);
  // 所有假设都在输出中可见
  assert.equal(s.rules.fees.assumed, true);
  assert.equal(s.rules.fees.values.commission_rate, 0.00025);
  assert.equal(s.rules.lots.values.etf_lot_size, 100);
  assert.ok(s.warnings.includes('fee_assumed'));
  assert.ok(s.warnings.includes('lot_rule_assumed'));
  assert.ok(s.warnings.includes('share_data_missing'));
});

test('6b. decision_id 确定性：同一输入同一 ID，输入变化则 ID 变化', () => {
  const a = rotate();
  const b = rotate();
  assert.equal(a.decision_id, b.decision_id);
  const c = rotate({ shares: undefined, action: { ...SELL_BUY, sell_shares: 20000 } });
  assert.notEqual(a.decision_id, c.decision_id);
});

test('6c. 卖出价高于快照参考价时，价差单列而不混入费用', () => {
  const quotes = new Map([quote('159558.SZ', 0.95), quote('510300.SH', 4.0)]);
  const s = rotate({ quotes });
  assert.equal(s.trade.sell.gross_cents, 950000);
  // 10000 份对应快照市值 935000；卖出多出 15000 分 = 150 元
  assert.equal(s.trade.price_effect_cents, 15000);
});

test('7. 现金不足一手 → NOT_EXECUTABLE / insufficient_cash_for_one_lot', () => {
  const quotes = new Map([quote('159241.SZ', 1.005), quote('513100.SH', 30.0)]); // 一手 3,000 元
  const s = buildScenario({
    snapshot: summary, as_of_trade_date: DATE, quotes, evidence: ADVANTAGE,
    action: { type: 'SELL_AND_BUY', sell_code: '159241.SZ', sell_shares: 100, buy_code: '513100.SH' },
  });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'insufficient_cash_for_one_lot'), JSON.stringify(s.reasons));
  assert.equal(s.trade.buy.lots, 0);
  assert.equal(s.trade.buy.total_cost_cents, 0);
});

test('8. 卖出 150 份（非整手）→ NOT_EXECUTABLE / lot_rule', () => {
  const s = buildScenario({
    snapshot: summary, as_of_trade_date: DATE, quotes: GOOD_QUOTES, evidence: ADVANTAGE,
    action: { ...SELL_BUY, sell_shares: 150 },
  });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'lot_rule'), JSON.stringify(s.reasons));
});

test('8b. 卖出超过持仓 → insufficient_position；零/负数 → invalid_input', () => {
  const over = buildScenario({
    snapshot: summary, as_of_trade_date: DATE, quotes: GOOD_QUOTES, evidence: ADVANTAGE,
    action: { ...SELL_BUY, sell_shares: 60000 },
  });
  assert.equal(over.status, 'NOT_EXECUTABLE');
  assert.ok(over.reasons.some(r => r.code === 'insufficient_position'));
  for (const shares of [0, -100, 100.5]) {
    const bad = buildScenario({
      snapshot: summary, as_of_trade_date: DATE, quotes: GOOD_QUOTES, evidence: ADVANTAGE,
      action: { ...SELL_BUY, sell_shares: shares },
    });
    assert.equal(bad.status, 'NOT_EXECUTABLE', String(shares));
    assert.ok(bad.reasons.some(r => r.code === 'invalid_input'), JSON.stringify(bad.reasons));
  }
});

test('9. 过期行情 → NOT_EXECUTABLE / quote_stale，并返回报价日期', () => {
  const quotes = new Map([quote('159558.SZ', 0.935, '20261016'), quote('510300.SH', 4.0)]);
  const s = rotate({ quotes });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'quote_stale'), JSON.stringify(s.reasons));
  assert.deepEqual(s.quotes.stale_codes, ['159558.SZ']);
  assert.equal(s.quotes.quote_dates['159558.SZ'], '20261016');
  assert.equal(s.quotes.quote_dates['510300.SH'], DATE);
  assert.ok(s.warnings.includes('quote_stale'));
  // 仍然给出完整对照，但执行标记必须为 false
  assert.equal(s.comparison.find(r => r.action === 'ROTATE').executable, false);
  assert.ok(s.trade.sell.net_proceeds_cents > 0, 'numbers are still computed for comparison');
});

test('9b. 缺行情 → NOT_EXECUTABLE / quote_missing', () => {
  const quotes = new Map([quote('510300.SH', 4.0)]); // 159558.SZ 缺失
  const s = rotate({ quotes });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'quote_missing'), JSON.stringify(s.reasons));
  assert.deepEqual(s.quotes.missing_codes, ['159558.SZ']);
  assert.equal(s.trade.sell.gross_cents, null);
});

test('9c. 停牌 / 非上市状态 → NOT_EXECUTABLE / instrument_not_tradable', () => {
  const suspended = new Map([quote('159558.SZ', 0.935), quote('510300.SH', 4.0, DATE, { suspended: true })]);
  const a = rotate({ quotes: suspended });
  assert.equal(a.status, 'NOT_EXECUTABLE');
  assert.ok(a.reasons.some(r => r.code === 'instrument_not_tradable'));
  const delisted = new Map([quote('159558.SZ', 0.935), quote('510300.SH', 4.0, DATE, { list_status: 'D' })]);
  const b = rotate({ quotes: delisted });
  assert.equal(b.status, 'NOT_EXECUTABLE');
  assert.ok(b.reasons.some(r => r.code === 'instrument_not_tradable'));
});

test('10. 候选无相对优势 → NO_ACTION / no_demonstrated_advantage（不计算胜率）', () => {
  const s = rotate({ evidence: { advantage: false, basis: '相对强弱无显著差异' } });
  assert.equal(s.status, 'NO_ACTION');
  assert.ok(s.reasons.some(r => r.code === 'no_demonstrated_advantage'));
  assert.equal(s.evidence.advantage, false);
  assert.equal(s.evidence.basis, '相对强弱无显著差异');
  // 结果是"不交易"，且没有任何概率字段（本模块不计算胜率/上涨概率）。
  assert.equal('win_probability' in s, false);
  assert.equal('win_rate' in s.risk, false);
  assert.ok(s.reasons.some(r => r.code === 'no_demonstrated_advantage'));
  // 缺省证据同样 NO_ACTION
  const missing = rotate({ evidence: undefined });
  assert.equal(missing.status, 'NO_ACTION');
  assert.equal(missing.evidence.supplied, false);
});

test('11. 受限板块个股 → NOT_EXECUTABLE / permission_restricted', () => {
  for (const [code, kind] of [['688981.SH', 'STOCK'], ['300750.SZ', 'STOCK'], ['830799.BJ', 'STOCK'], ['430047.BJ', 'STOCK']]) {
    const quotes = new Map([quote('159558.SZ', 0.935), quote(code, 10)]);
    const s = rotate({ quotes, action: { ...SELL_BUY, buy_code: code, buy_instrument: { kind, board: rules.inferBoard(code) } } });
    assert.equal(s.status, 'NOT_EXECUTABLE', code);
    assert.ok(s.reasons.some(r => r.code === 'permission_restricted'), `${code}: ${JSON.stringify(s.reasons)}`);
  }
  // 沪深主板个股不因权限被拒
  assert.deepEqual(rules.tradabilityOf('600519.SH', { kind: 'STOCK', board: 'main' }), { tradable: true });
  assert.equal(rules.tradabilityOf('600519.SH', { kind: 'STOCK' }).tradable, true);
  assert.throws(() => rules.assertTradableInstrument('688981.SH', { kind: 'STOCK' }), /受限板块/);
  // ETF 不受板块前缀限制
  assert.equal(rules.tradabilityOf('588000.SH', { kind: 'ETF' }).tradable, true);
});

test('11b. 同一标的买卖 → NOT_EXECUTABLE / same_instrument', () => {
  const quotes = new Map([quote('159558.SZ', 0.935)]);
  const s = rotate({ quotes, action: { ...SELL_BUY, buy_code: '159558.SZ' } });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'same_instrument'));
});

test('12. HOLD 情景：NO_ACTION、无费用、仍有压力损失', () => {
  const s = buildScenario({ snapshot: summary, as_of_trade_date: DATE, quotes: {}, action: { type: 'HOLD' } });
  assert.equal(s.status, 'NO_ACTION');
  assert.equal(s.trade.fees_cents, 0);
  assert.equal(s.after, null);
  assert.equal(s.comparison.length, 1);
  assert.equal(s.comparison[0].action, 'HOLD');
  // −10% × 证券市值 7,436,250 = 743,625 分，占总资产 9.8134%
  assert.equal(s.risk.scenario_loss_cents, -743625);
  assert.equal(s.risk.scenario_loss_pct_of_total, -9.8134);
  assert.match(s.risk.note, /不是预测/);
  assert.equal(s.max_drawdown.available, false);
});

test('12b. 压力参数可覆盖，且被标记为假设', () => {
  const s = rotate({ rules: { stress: { shock_pct: -0.2, applies_to: 'equity_etf' } } });
  assert.equal(s.risk.scenario_loss_cents, -1487250);
  assert.equal(s.rules.stress.assumed, true);
  assert.match(s.rules.stress.provenance.shock_pct.source, /declared/);
});

// ---------------------------------------------------------------- D. 账本隔离

test('13. 账户库路径别名市场库 → 拒绝执行，且不创建文件', () => {
  const sub = join(dir, 'nested');
  mkdirSync(sub);
  const hard = join(dir, 'hard.sqlite');
  linkSync(LIVE, hard);
  const sym = join(dir, 'sym.sqlite');
  symlinkSync(LIVE, sym);
  const dirLink = join(dir, 'dirlink');
  symlinkSync(dir, dirLink, 'dir');
  const aliases = [
    ['absolute', LIVE],
    ['relative', relative(process.cwd(), LIVE)],
    ['dotdot', join(sub, '..', 'ashare.sqlite')],
    ['symlink', sym],
    ['hardlink', hard],
    ['symlinked parent', join(dirLink, 'ashare.sqlite')],
  ];
  for (const [label, path] of aliases) {
    assert.throws(() => assertPortfolioSeparateFromMarket(path, LIVE), /账户数据库不能与正式市场数据库相同/, label);
    assert.throws(() => openPortfolioDb(path, { marketPath: LIVE }), /账户数据库不能与正式市场数据库相同/, label);
  }
  // 正常路径可用
  const ok = join(dir, 'separate', 'portfolio.sqlite');
  assert.equal(assertPortfolioSeparateFromMarket(ok, LIVE), ok);
  const db2 = openPortfolioDb(ok, { marketPath: LIVE });
  db2.close();
  assert.ok(existsSync(ok));
  // 默认账户库不等于市场库
  assert.notEqual(portfolioDbPath(), LIVE);
});

test('13b. CLI 导入不会写市场库，且输出对账结果', () => {
  const marketDb = openAshareDb();
  const before = marketDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  marketDb.close();
  const run = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
    cwd: dir, env: { ...process.env, ASHARE_DB_PATH: LIVE, ASHARE_PORTFOLIO_DB_PATH: join(dir, 'cli.sqlite') }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.inserted, true);
  assert.equal(out.reconciliation.ok, true);
  const reuse = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
    cwd: dir, env: { ...process.env, ASHARE_DB_PATH: LIVE, ASHARE_PORTFOLIO_DB_PATH: join(dir, 'cli.sqlite') }, encoding: 'utf8',
  });
  assert.equal(JSON.parse(reuse.stdout).inserted, false, 'second CLI import is a no-op');
  const marketDb2 = openAshareDb();
  assert.equal(marketDb2.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, before, 'market schema untouched');
  marketDb2.close();
});

test('13c. CLI portfolio-scenario 输出 JSON，exit 0', () => {
  const run = spawnSync(process.execPath, [
    join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-scenario', '--action', 'sell-buy',
    '--sell', '159558.SZ', '--buy', '510300.SH', '--shares', '10000',
    '--sell-price', '0.935', '--buy-price', '4.0', '--advantage', 'yes', '--basis', '测试',
    '--db', join(dir, 'cli.sqlite'),
  ], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, 'EXECUTABLE');
  assert.equal(out.trade.buy.lots, 26);
});

// ---------------------------------------------------------------- E. MCP 门控

test('14. 账户工具默认关闭：tools/list 不广告，直接调用被拒绝', async () => {
  const { getAvailableToolList, dispatchTool } = await import('../build/dispatch.js');
  delete process.env.ASHARE_PORTFOLIO_ENABLED;
  const names = getAvailableToolList().map(t => t.name);
  assert.equal(names.includes('ashare_portfolio_summary'), false);
  assert.equal(names.includes('ashare_portfolio_scenario'), false);
  assert.equal(portfolioEnabled(), false);
  await assert.rejects(() => dispatchTool('ashare_portfolio_summary', {}), /ASHARE_PORTFOLIO_ENABLED=1/);
});

test('14b. ashare_daily profile 在未开启门控时也不暴露账户工具', async () => {
  process.env.FINANCE_TOOL_PROFILE = 'ashare_daily';
  delete process.env.ASHARE_PORTFOLIO_ENABLED;
  const { getAvailableToolList } = await import('../build/dispatch.js');
  const names = getAvailableToolList().map(t => t.name);
  assert.equal(names.includes('ashare_data_status'), true);
  assert.equal(names.includes('ashare_portfolio_summary'), false);
  assert.equal(names.includes('ashare_portfolio_scenario'), false);
  delete process.env.FINANCE_TOOL_PROFILE;
});

test('14c. ASHARE_PORTFOLIO_ENABLED=1 才暴露，且工具描述声明演示/只读/隔离/费用为假设', async () => {
  process.env.ASHARE_PORTFOLIO_ENABLED = '1';
  process.env.FINANCE_TOOL_PROFILE = 'ashare_daily';
  const { getAvailableToolList, dispatchTool } = await import('../build/dispatch.js');
  const tools = getAvailableToolList();
  const names = tools.map(t => t.name);
  assert.ok(names.includes('ashare_portfolio_summary'));
  assert.ok(names.includes('ashare_portfolio_scenario'));
  for (const name of ['ashare_portfolio_summary', 'ashare_portfolio_scenario']) {
    const tool = tools.find(t => t.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /演示\/只读账户/);
    assert.match(tool.description, /假设值/);
    assert.match(tool.description, /隔离/);
  }
  // 读取的是真实导入的账户库
  process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'cli.sqlite');
  const res = await dispatchTool('ashare_portfolio_summary', {});
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.summary.totals.total_assets_cents, 7577653);
  assert.equal(body.summary.max_drawdown.available, false);
  assert.equal(body.reconciliation.ok, true);

  const scenario = await dispatchTool('ashare_portfolio_scenario', {
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000,
    buy_code: '510300.SH', sell_price: 0.935, buy_price: 4.0, as_of_trade_date: DATE, advantage: true,
  });
  const s = JSON.parse(scenario.content[0].text);
  assert.equal(s.status, 'EXECUTABLE');
  assert.equal(s.trade.buy.lots, 26);
  delete process.env.ASHARE_PORTFOLIO_ENABLED;
  delete process.env.FINANCE_TOOL_PROFILE;
});

test('14d. 开启门控但账户库缺失时给出明确错误，而不是伪造数据', async () => {
  process.env.ASHARE_PORTFOLIO_ENABLED = '1';
  process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'missing.sqlite');
  const { dispatchTool } = await import('../build/dispatch.js');
  await assert.rejects(() => dispatchTool('ashare_portfolio_summary', {}), /账户数据库不存在/);
  assert.equal(existsSync(join(dir, 'missing.sqlite')), false, 'read-only access must not create the file');
  delete process.env.ASHARE_PORTFOLIO_ENABLED;
});

// ---------------------------------------------------------------- F. 规则元数据

test('15. 每条规则都标注 assumed 与来源', () => {
  const described = rules.describeRules();
  assert.equal(described.fees.assumed, true);
  assert.equal(described.lots.assumed, true);
  assert.equal(described.stress.assumed, true);
  for (const [key, value] of Object.entries(described.fees.provenance)) {
    assert.equal(value.assumed, true, key);
    assert.ok(value.source.length > 0, key);
  }
  for (const [key, value] of Object.entries(described.lots.provenance)) {
    assert.equal(value.assumed, true, key);
  }
  assert.match(described.fees.provenance.commission_rate.source, /待确认/);
});

test('15b. 报价归一化：显式 NOT_READY 不被"修正"为 READY', () => {
  const q = normalizeQuote('510300.SH', { trade_date: DATE, close: 4, quality: 'NOT_READY' }, DATE);
  assert.equal(q.quality, 'NOT_READY');
  const stale = normalizeQuote('510300.SH', { trade_date: '20261017', close: 4 }, DATE);
  assert.equal(stale.quality, 'STALE');
  const future = normalizeQuote('510300.SH', { trade_date: '20261019', close: 4 }, DATE);
  assert.equal(future.quality, 'NOT_READY');
  const ok = normalizeQuote('510300.SH', { trade_date: DATE, close: 4.0 }, DATE);
  assert.equal(ok.quality, 'READY');
  assert.equal(ok.price_milli, 4000);
});

test.after(() => {
  db.close();
});
