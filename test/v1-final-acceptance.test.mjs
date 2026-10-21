import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// V1.0 最终收尾验收：四个真实缺陷的失败先行用例。
//
// 1. dailyReport 顶层 ACTIONABLE 与腿的 executable 状态不一致；
// 2. 未经验证的市场证据数量 + 集中度阈值不得直接升级为可执行卖出计划；
// 3. benchmarks 中间交易日缺价被当作零市值；
// 4. 五只静态基准必须从 2026-10-16 实际数量与账户现金出发，不虚构建仓费用。
//
// 全部为合成 fixture：不是用户真实账户，也不读取生产缓存。

const dir = mkdtempSync(join(tmpdir(), 'ashare-v1-final-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');
const account = await import('../build/portfolio/account.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { initBaseline, confirmRealAccount, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { buildBenchmarkComparison, FROZEN_FIVE_QUANTITIES } = await import('../build/portfolio/benchmarks.js');

let caseSeq = 0;
function nextDir() {
  const sub = join(dir, `case-${caseSeq += 1}`);
  mkdirSync(sub, { recursive: true });
  return sub;
}

/** 建一个有完整 fund_* 表、恒定收盘价的市场缓存。 */
function marketWith({ dates, closes, missing = [] }) {
  const sub = nextDir();
  const file = join(sub, 'market.sqlite');
  const db = openAshareDb(file);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    dates.map((date, index) => ({ cal_date: date, is_open: 1, pretrade_date: dates[index - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    Object.keys(closes).map(ts_code => ({
      ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型',
      benchmark: '合成指数', status: 'L', market: 'E',
    })));
  for (const [ts_code, close] of Object.entries(closes)) {
    for (const trade_date of dates) {
      if (missing.some(m => m.ts_code === ts_code && m.trade_date === trade_date)) continue;
      upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
        [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
    }
  }
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
    Object.keys(closes).flatMap(ts_code => dates.map(trade_date => ({ ts_code, trade_date, adj_factor: 1 }))));
  return { db, file, sub };
}

/** 写入一份合成日报文件并登记到 report 表（路径相对于 ASHARE_DATA_DIR=dir）。 */
function seedReport(db, _sub, dates, asOf, market) {
  const reportId = `ASR-${asOf}-FINAL`;
  const reportDir = join(dir, 'reports', asOf);
  mkdirSync(reportDir, { recursive: true });
  const rel = `reports/${asOf}/${reportId}.json`;
  writeFileSync(join(dir, rel), JSON.stringify({
    report_id: reportId, schema: 'ashare-report-1.0.0', as_of_trade_date: asOf,
    generated_at: `${asOf}T21:40:00+08:00`, status: 'READY', run_mode: 'manual',
    market, sectors: { method: '合成', top: [], bottom: [], all: [] }, disclaimer: '合成测试',
  }));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(reportId, asOf, 'READY', `${asOf}T21:40:00+08:00`, rel, 'manual');
}

const BEARISH_MARKET = {
  regime: 'downtrend', regime_label: '下降趋势', tone: 'bearish', judgement: ['合成：下跌'],
  indices: [{ ts_code: '000300.SH', name: '沪深300', close: 4000, pct_chg: -1, ret5: -3, ret20: -8, amount_yi: 5000, above_ma20: false, above_ma60: false }],
  breadth: {
    stocks: 5000, up: 900, down: 4000, flat: 100, limit_up: 10, limit_down: 60,
    up_ratio: 0.18, median_pct_chg: -1.2, amount_yi: 8000, amount_ma20_yi: 12000,
    pct_above_ma20: 9, pct_above_ma60: 14,
  },
};

/** 已确认账户：门控应当通过，便于把缺陷与门控问题分开。 */
function confirmedAccount(subDir, snapshot, asOf) {
  const db = openPortfolioDb(join(subDir, 'portfolio.sqlite'));
  account.importSnapshot(db, snapshot);
  initBaseline(db, 'acct', { asOf, snapshotId: snapshot.snapshot_id });
  account.markSnapshotCurrent(db, snapshot.snapshot_id, { confirmedBy: 'test-fixture' });
  confirmRealAccount(db, 'acct', { confirm: true, note: 'synthetic fixture' });
  setAccountCompleteness(db, 'acct', {
    as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false, note: 'synthetic fixture',
  }, { confirm: true, recordedBy: 'test-fixture' });
  return db;
}

function snapshotOf(positions, cashCents) {
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  return {
    snapshot_id: 'synthetic-final-2026-10-16', as_of: '2026-10-16', source: 'synthetic-fixture',
    note: '合成测试账户，不是真实账户', warnings: ['synthetic_fixture'], is_current: false,
    positions,
    totals: {
      total_assets_cents: securities + cashCents, securities_mv_cents: securities,
      cash_cents: cashCents, wealth_cents: 0, unrealized_pnl_cents: 0,
    },
  };
}

function executableLegCount(report) {
  return report.first_section.actions.flatMap(action => action.legs).filter(leg => leg.executable === true).length;
}

// ---------------------------------------------------------------- 缺陷 1

test('V1F-1 顶层 ACTIONABLE 必须与腿的 executable 一致：没有可执行腿就不能是 ACTIONABLE', () => {
  const dates = weekdays('20261005', 10);
  const asOf = dates.at(-1);
  const { db: marketDb, sub } = marketWith({ dates, closes: { '159558.SZ': 1.0, '510300.SH': 4.0 } });
  seedReport(marketDb, sub, dates, asOf, BEARISH_MARKET);

  // 单一持仓恰好占总资产50%；没有显式研究量或优势证据，不自动生成交易。
  const snapshot = snapshotOf([
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 100000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 10_000_000 },
  ], 10_000_000);
  const portfolio = confirmedAccount(sub, snapshot, asOf);

  const report = buildDailyReport({ portfolioDb: portfolio, marketDb, accountId: 'acct', asOfTradeDate: asOf });
  assert.equal(report.gate.satisfied, true, JSON.stringify(report.gate.reasons));

  const legs = report.first_section.actions.flatMap(action => action.legs);
  assert.deepEqual(legs, [], '未经验证的阈值不得自动产生交易腿');
  assert.equal(report.status, 'NO_ACTION');
  assert.equal(report.decision_comparison.options.find(option => option.action === 'REDUCE').sell_plan, null);
  assert.equal(executableLegCount(report), 0, '该场景不应有任何可执行腿');
  // 核心断言：没有任何可执行腿时，顶层不得声称 ACTIONABLE。
  assert.equal(report.actionable, false, JSON.stringify({ status: report.status, legs }));
  assert.notEqual(report.status, 'ACTIONABLE', JSON.stringify({ status: report.status, legs }));

  // 反向：如果声称 actionable，就必须至少有一条可执行腿。
  if (report.actionable) assert.ok(executableLegCount(report) > 0);
});

// ---------------------------------------------------------------- 缺陷 2

test('V1F-2 未验证的市场证据数量 + 集中度阈值不得生成可执行卖出计划', () => {
  const dates = weekdays('20261005', 10);
  const asOf = dates.at(-1);
  const { db: marketDb, sub } = marketWith({ dates, closes: { '159558.SZ': 1.0 } });
  seedReport(marketDb, sub, dates, asOf, BEARISH_MARKET);

  // 集中度 >= 50% 且可减仓数量为正：这是缺陷 2 的直接触发条件。
  const snapshot = snapshotOf([
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 80_000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 8_000_000 },
  ], 2_000_000);
  const portfolio = confirmedAccount(sub, snapshot, asOf);

  const report = buildDailyReport({ portfolioDb: portfolio, marketDb, accountId: 'acct', asOfTradeDate: asOf });
  assert.equal(report.gate.satisfied, true, JSON.stringify(report.gate.reasons));

  assert.deepEqual(report.first_section.actions, [], '证据计数与集中度不自动授权卖出');
  assert.equal(report.status, 'NO_ACTION');
  assert.equal(executableLegCount(report), 0);
  const explicit = buildDailyReport({ portfolioDb: portfolio, marketDb, accountId: 'acct', asOfTradeDate: asOf,
    researchScenario: { sellCode: '159558.SZ', sellQuantity: 1000 } });
  const research = explicit.decision_comparison.options.find(option => option.action === 'REDUCE');
  assert.equal(research.sell_plan.quantity, 1000);
  assert.equal(research.executable, false);
  assert.equal(research.fact_meta.claim_status, 'UNVERIFIED');
  assert.equal(explicit.actionable, false);
  assert.equal(executableLegCount(explicit), 0);
  // 报告整体不得因此变成 ACTIONABLE。
  assert.equal(report.actionable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
});

// ---------------------------------------------------------------- 缺陷 3

test('V1F-3 中间交易日缺价不得按零市值计入：不得产生虚假回撤与波动', () => {
  // 窗口跨越 2026-10-16，使五只静态基准在基线之后也有多个交易日。
  const dates = weekdays('20260818', 60);
  const closes = {
    '510300.SH': 4.0, '511010.SH': 1.0, '518880.SH': 5.0, '513100.SH': 2.0,
    '159241.SZ': 1.0, '159278.SZ': 0.8, '159558.SZ': 0.9, '516080.SH': 0.6, '560390.SH': 0.7,
  };
  // 价格全程恒定，只让 513100.SH 在**基线之后**的某个中间交易日缺一根 bar。
  const postBaseline = dates.filter(date => date > '20261016');
  const middle = postBaseline[Math.floor(postBaseline.length / 2)];
  const { db } = marketWith({ dates, closes, missing: [{ ts_code: '513100.SH', trade_date: middle }] });

  const comparison = buildBenchmarkComparison({ marketDb: db });
  assert.equal(comparison.window.end, dates.at(-1));

  for (const benchmark of comparison.benchmarks) {
    assert.equal(benchmark.status, 'OK', `${benchmark.id} 不应因中间缺价而不可用`);
    // 价格恒定 → 真实回撤为 0、波动为 0。若把缺价当零市值，会出现明显负回撤。
    assert.equal(benchmark.max_drawdown_pct, 0, `${benchmark.id} 出现虚假回撤`);
    assert.ok(benchmark.annualized_vol_pct !== null, `${benchmark.id} 应有足够估值点计算波动`);
    assert.ok(Math.abs(benchmark.annualized_vol_pct) < 0.01,
      `${benchmark.id} 出现虚假波动：${benchmark.annualized_vol_pct}`);
  }

  // 使用到 513100.SH 的篮子必须披露"沿用上一价"的日期，而不是静默填充。
  const basket = comparison.benchmarks.find(item => item.id === 'frozen_multi_asset_basket');
  assert.equal(basket.valuation_quality, 'carried_forward');
  assert.ok(basket.carried_forward_dates.includes(middle), JSON.stringify(basket.carried_forward_dates));
});

// ---------------------------------------------------------------- 缺陷 4

test('V1F-4 五只静态基准从 2026-10-16 实际数量与现金出发，且不虚构建仓费用', () => {
  const dates = weekdays('20260818', 44);
  assert.equal(dates.at(-1), '20261016', '合成窗口必须结束在 2026-10-16');
  const closes = {
    '510300.SH': 4.0, '511010.SH': 1.0, '518880.SH': 5.0, '513100.SH': 2.0,
    '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742,
  };
  const { db } = marketWith({ dates, closes });
  const comparison = buildBenchmarkComparison({ marketDb: db });

  const five = comparison.benchmarks.find(item => item.id === 'initial_five_etf_basket');
  assert.equal(five.status, 'OK');
  // 基准锚定在实际基线日，而不是合成窗口的起点。
  assert.equal(five.window.start, '20261016');
  assert.equal(five.window.end, '20261016');

  // 已持有，不得再计一次建仓费用。
  assert.equal(five.entry_fee_cents, 0, '静态持有基准不得虚构建仓费用');

  // 起始价值 = 2026-10-16 实际证券市值 + 账户现金 1,413.70。
  const securities = Object.entries(FROZEN_FIVE_QUANTITIES)
    .reduce((sum, [code, quantity]) => sum + Math.round(quantity * closes[code] * 100), 0);
  assert.equal(securities, 7_436_250, '证券市值应为 74,362.50 元');
  assert.equal(five.start_value_cents, securities + 141_370, '起始价值应含账户现金');
  assert.equal(five.cash_cents, 141_370);
  // 期末价值同样含现金（期间不交易，现金不变）。
  assert.equal(five.end_value_cents, securities + 141_370);
  // 收益以含现金的投入为基数：价格不变 → 0%。
  assert.equal(five.total_return_pct, 0);

  // 另外两个基准仍然按各自的建仓口径计费（不受影响）。
  const csi300 = comparison.benchmarks.find(item => item.id === 'csi300_etf_buy_hold');
  assert.ok(csi300.entry_fee_cents > 0, '买入持有基准仍应计一次建仓费用');
});

// ---------------------------------------------------------------- 附加：默认窗口

test('V1F-5 未显式给 end 时，窗口必须落在行情实际覆盖的最后一天，而不是日历的未来日期', () => {
  const dates = weekdays('20260818', 44);
  const lastBar = dates.at(-1); // 20261016
  const closes = {
    '510300.SH': 4.0, '511010.SH': 1.0, '518880.SH': 5.0, '513100.SH': 2.0,
    '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742,
  };
  const { db } = marketWith({ dates, closes });
  // 交易日历排到未来：20261019 与 20261020 开市，但没有行情。
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261019', is_open: 1, pretrade_date: lastBar },
    { cal_date: '20261020', is_open: 1, pretrade_date: '20261019' },
  ]);

  const comparison = buildBenchmarkComparison({ marketDb: db }); // 不传 start/end
  assert.equal(comparison.window.end, lastBar, '默认窗口不得延伸到没有行情的未来交易日');
  for (const benchmark of comparison.benchmarks) {
    assert.equal(benchmark.status, 'OK', `${benchmark.id} 在默认窗口下应可用，实际 ${benchmark.reason}`);
  }
});

test('V1F-6 默认窗口的起点也不得早于行情覆盖范围；显式 start 仍严格按调用方要求', () => {
  const dates = weekdays('20260818', 44);
  const closes = {
    '510300.SH': 4.0, '511010.SH': 1.0, '518880.SH': 5.0, '513100.SH': 2.0,
    '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742,
  };
  const { db } = marketWith({ dates, closes });
  // 交易日历比行情早很多（行情只从 dates[20] 开始）。
  const firstBar = dates[20];
  db.prepare('DELETE FROM fund_daily WHERE trade_date < ?').run(firstBar);
  db.prepare('DELETE FROM fund_adj WHERE trade_date < ?').run(firstBar);

  // 默认调用：窗口应落在行情覆盖范围内，基准可用。
  const defaulted = buildBenchmarkComparison({ marketDb: db });
  assert.ok(defaulted.window.start >= firstBar, `默认起点 ${defaulted.window.start} 早于行情起点 ${firstBar}`);
  for (const benchmark of defaulted.benchmarks) {
    assert.equal(benchmark.status, 'OK', `${benchmark.id} 默认窗口下应可用：${benchmark.reason}`);
  }

  // 显式要求一个没有行情的起点：仍如实 unavailable，不静默缩短窗口。
  const explicit = buildBenchmarkComparison({ marketDb: db, start: dates[0], end: dates.at(-1) });
  const csi300 = explicit.benchmarks.find(item => item.id === 'csi300_etf_buy_hold');
  assert.equal(csi300.status, 'UNAVAILABLE');
  assert.equal(csi300.reason, 'window_coverage_incomplete');
});
