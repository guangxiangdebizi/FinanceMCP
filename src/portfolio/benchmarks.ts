import type { DatabaseSync } from 'node:sqlite';
import { ETF_UNIVERSE } from '../ashare/etf.js';
import { DEFAULT_FEE_RULES, type FeeRules } from './rules.js';

/**
 * C6 冻结对照基准（只读、确定性）。
 *
 * PRD §11 要求至少与两种**提前冻结**的对照比较，另加初始五只 ETF 的静态基线：
 * 1. `csi300_etf_buy_hold`：510300.SH 买入持有；
 * 2. `frozen_multi_asset_basket`：按**常量权重**的多资产 ETF 篮子（权重待用户批准）；
 * 3. `initial_five_etf_basket`：初始五只 ETF 按固定起始数量持有、不交易。
 *
 * 口径统一（三个基准完全一致，避免事后挑选口径）：
 * - 期初按当日收盘价买入，期末按最后交易日收盘价估值；
 * - 期初一次性买入费用：佣金率（有最低佣金）+ 单边滑点；
 * - 区间内不调仓、不再投入现金、不取现，现金余额按 0 处理；
 * - 复权：有 `fund_adj` 时按 qfq（基准 = 期末最后因子）换算，缺因子时显式标注
 *   `price_basis: raw_close_no_adj_factor`，不把原始价伪装成复权价；
 * - 交易日历：区间内第一个与最后一个**共同**交易日；每个代码必须覆盖这两个日期，
 *   否则该基准 `unavailable` 并写出原因（不缩短窗口来凑数）。
 *
 * 这些定义在实现时写死，**永不**根据结果挑选：权重、标的、费用与窗口都是常量，
 * 输出同时返回 `definition_frozen: true` 与权重状态，便于审计。
 */

// ---------------------------------------------------------------- 冻结定义

export const BENCHMARK_SCHEMA = 'ashare-benchmark-comparison/1.0';
export const BENCHMARK_DEFINITION_VERSION = 'r2-benchmarks-1.0.0';

/** 沪深300 ETF 基准。 */
export const CSI300_ETF_CODE = '510300.SH';

/**
 * 多资产篮子的**常量权重**（合计 1.0）。
 *
 * 状态：`provisional_pending_user_approval` —— PRD §11 要求"具体比例研究后预先固定"，
 * 用户尚未批准这组比例。它们在此冻结，不能因为回测结果不好看而改动；要改必须
 * 升版本号并记录原因。
 */
export const FROZEN_BASKET_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  '510300.SH': 0.40, // 权益（沪深300）
  '511010.SH': 0.25, // 债券（国债）
  '518880.SH': 0.15, // 黄金
  '513100.SH': 0.20, // 跨境（纳指）
});

export const FROZEN_BASKET_WEIGHTS_STATUS = 'provisional_pending_user_approval' as const;

export const FROZEN_BASKET_ASSET_CLASS: Readonly<Record<string, 'equity' | 'bond' | 'gold' | 'cross_border'>> = Object.freeze({
  '510300.SH': 'equity',
  '511010.SH': 'bond',
  '518880.SH': 'gold',
  '513100.SH': 'cross_border',
});

/** 初始五只 ETF 的固定起始数量（与 PRD §3 演示快照一致，之后不交易）。 */
export const FROZEN_FIVE_QUANTITIES: Readonly<Record<string, number>> = Object.freeze({
  '159241.SZ': 1000,
  '159278.SZ': 1000,
  '159558.SZ': 58900,
  '516080.SH': 10000,
  '560390.SH': 15000,
});

export const FROZEN_FIVE_QUANTITY_NOTE =
  '初始数量以 PRD §3 截图基线为准（159241 1000 份、159278 1000 份、159558 58900 份、'
  + '516080 10000 份、560390 15000 份）；数量是常量，不是当前持仓。';

/**
 * 五只静态基准的**实际起点**：用户确认的 2026-10-16 收盘基线。
 *
 * 这五只 ETF 在基线时已经持有，所以不能再收一次建仓费用；账户当时的现金也属于
 * 组合的一部分，必须计入起点，否则会高估收益率。
 */
export const FROZEN_FIVE_START_DATE = '20261016';
export const FROZEN_FIVE_CASH_CENTS = 141370; // 1,413.70 元（PRD §3）

export const BENCHMARK_DISCLAIMER =
  '对照基准是**提前冻结**的定义，用于评价，不是推荐组合，也不是可执行交易计划。'
  + '历史区间收益不构成前瞻有效性的证据；基准不会在事后按表现挑选或调参。'
  + '缺数据时该基准返回 unavailable 并给出原因，不用估计值或缩短窗口替代。';

export const BENCHMARK_NOTES = [
  '三个基准共用同一时间窗口、同一费用假设（rules.ts 的 DEFAULT_FEE_RULES）与同一现金约定（期初买入后现金为 0，期间不再投入）。',
  '定义在实现时写死：标的、权重、数量、费用与复权口径都是常量；结果不参与定义选择。',
  '多资产权重状态为 provisional_pending_user_approval：PRD §11 要求预先固定，用户尚未批准。',
] as const;

// ---------------------------------------------------------------- 类型

export type BenchmarkStatus = 'OK' | 'DEGRADED' | 'UNAVAILABLE';

export interface BenchmarkLeg {
  ts_code: string;
  name: string | null;
  /** 声明权重（多资产篮子）或按起始市值归一后的权重。 */
  weight: number | null;
  /** 起始份数；按权重建仓时为 null（份数由期初价格反推）。 */
  start_quantity: number | null;
  start_price_milli: number | null;
  end_price_milli: number | null;
  /** 区间收益（%），已含复权。 */
  total_return_pct: number | null;
  bars_used: number;
  price_basis: 'qfq_adjusted' | 'raw_close_no_adj_factor';
}

export interface BenchmarkResult {
  id: 'csi300_etf_buy_hold' | 'frozen_multi_asset_basket' | 'initial_five_etf_basket';
  label: string;
  status: BenchmarkStatus;
  /** unavailable / degraded 的机器可读原因。 */
  reason: string | null;
  detail: string | null;
  /** 仅当 status !== 'unavailable' 时有值。 */
  total_return_pct: number | null;
  max_drawdown_pct: number | null;
  annualized_vol_pct: number | null;
  /** 期末组合价值（分，整数）；unavailable 时为 null。 */
  end_value_cents: number | null;
  start_value_cents: number | null;
  /** 期初买入费用（分，含滑点与最低佣金）。 */
  entry_fee_cents: number | null;
  /** 实际使用的共同窗口（可能被日历裁剪，但不会被单个代码裁剪）。 */
  window: { start: string; end: string; trading_days: number } | null;
  legs: BenchmarkLeg[];
  price_basis: 'qfq_adjusted' | 'raw_close_no_adj_factor' | 'mixed';
  /**
   * 估值质量：`carried_forward` 表示窗口内有交易日缺该腿的 bar，已按上一已知价
   * 沿用估值（绝不按 0 市值计入）；`exact` 表示每个共同交易日都有真实收盘。
   */
  valuation_quality: 'exact' | 'carried_forward';
  /** 沿用上一已知价的日期（升序）；空表示全部为真实收盘。 */
  carried_forward_dates: string[];
  /** 五只静态基准的账户现金（分）；其它基准为 0。 */
  cash_cents: number;
  weights: Record<string, number> | null;
  weights_status: typeof FROZEN_BASKET_WEIGHTS_STATUS | null;
  /** 明确的缺失代码，便于复核为什么 unavailable。 */
  missing_codes: string[];
}

export interface BenchmarkComparisonInput {
  marketDb: DatabaseSync | null | undefined;
  /** 区间起止 YYYYMMDD（含端点）；缺省取缓存内最近 252 个交易日。 */
  start?: string;
  end?: string;
  /** 费用假设；缺省 DEFAULT_FEE_RULES（标记 assumed）。 */
  fees?: FeeRules;
}

export interface BenchmarkComparisonResult {
  schema: typeof BENCHMARK_SCHEMA;
  definition_version: string;
  definition_frozen: true;
  as_of_trade_date: string | null;
  requested_window: { start: string | null; end: string | null; defaulted: boolean };
  window: { start: string; end: string; trading_days: number } | null;
  data_quality: {
    status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
    tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean; trade_cal: boolean };
    missing_tables: string[];
    reasons: string[];
  };
  conventions: {
    fees: { version_note: string; assumed: true; values: FeeRules };
    cash: string;
    rebalancing: string;
    price_basis: string;
    return_formula: string;
  };
  benchmarks: BenchmarkResult[];
  notes: readonly string[];
  disclaimer: string;
}

// ---------------------------------------------------------------- 小工具

const YMD = /^\d{8}$/;
const r2 = (value: number): number => Math.round(value * 100) / 100;
const r4 = (value: number): number => Math.round(value * 10000) / 10000;
const r6 = (value: number): number => Math.round(value * 1000000) / 1000000;

function tableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

interface PriceSeries {
  ts_code: string;
  bars: { trade_date: string; close: number; adj_factor: number | null }[];
  byDate: Map<string, number>;
  basis: 'qfq_adjusted' | 'raw_close_no_adj_factor';
  name: string | null;
}

/**
 * 读取一个代码在 [start, end] 的收盘序列（qfq）。缺 `fund_adj` 时退化为原始收盘
 * 并显式标注；绝不静默混合两种口径。
 */
function loadSeries(
  db: DatabaseSync, code: string, start: string, end: string,
  tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean },
): PriceSeries {
  const name = tables.fund_basic
    ? ((db.prepare('SELECT name FROM fund_basic WHERE ts_code = ?').get(code) as any)?.name ?? null)
    : null;
  const rows = tables.fund_daily
    ? (db.prepare(`
        SELECT trade_date, close FROM fund_daily
        WHERE ts_code = ? AND trade_date BETWEEN ? AND ?
        ORDER BY trade_date`).all(code, start, end) as any[])
    : [];
  const factors = new Map<string, number>();
  if (tables.fund_adj) {
    for (const row of db.prepare(`
      SELECT trade_date, adj_factor FROM fund_adj
      WHERE ts_code = ? AND trade_date BETWEEN ? AND ? AND adj_factor > 0`).all(code, start, end) as any[]) {
      factors.set(String(row.trade_date), Number(row.adj_factor));
    }
  }
  // qfq 基准 = 区间内最后一个因子（不早于 end 之外）。
  let base: number | null = null;
  if (factors.size > 0) {
    const lastDate = [...factors.keys()].sort().at(-1)!;
    base = factors.get(lastDate)!;
  }
  const bars: PriceSeries['bars'] = [];
  let missingFactor = false;
  for (const row of rows) {
    const close = Number(row.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const factor = factors.get(String(row.trade_date)) ?? null;
    let adjusted = close;
    if (base !== null) {
      if (factor === null) { missingFactor = true; continue; }
      adjusted = close * (factor / base);
    }
    bars.push({ trade_date: String(row.trade_date), close: adjusted, adj_factor: factor });
  }
  const basis: PriceSeries['basis'] = base !== null ? 'qfq_adjusted' : 'raw_close_no_adj_factor';
  const byDate = new Map(bars.map(bar => [bar.trade_date, bar.close]));
  return { ts_code: code, bars, byDate, basis, name: name ? String(name) : null };
}

/** 期初买入费用：佣金（有最低）+ 单边滑点，整数分。 */
function entryFeeCents(grossCents: number, fees: FeeRules): number {
  if (!(grossCents > 0)) return 0;
  const commission = Math.max(fees.commission_min_cents, Math.round(grossCents * fees.commission_rate));
  const transfer = Math.round(grossCents * fees.transfer_fee_rate);
  const slippage = Math.round(grossCents * fees.slippage_rate_per_side);
  return commission + transfer + slippage;
}

function drawdownPct(values: number[]): number {
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    const dd = value / peak - 1;
    if (dd < worst) worst = dd;
  }
  return r4(worst * 100);
}

function annualizedVolPct(values: number[]): number | null {
  if (values.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i += 1) returns.push(values[i] / values[i - 1] - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (returns.length - 1);
  return r4(Math.sqrt(variance) * Math.sqrt(252) * 100);
}

const unavailableBenchmark = (
  id: BenchmarkResult['id'], label: string, reason: string, detail: string,
  missingCodes: string[] = [], weights: Record<string, number> | null = null,
): BenchmarkResult => ({
  id, label, status: 'UNAVAILABLE', reason, detail,
  total_return_pct: null, max_drawdown_pct: null, annualized_vol_pct: null,
  end_value_cents: null, start_value_cents: null, entry_fee_cents: null,
  window: null, legs: [], price_basis: 'raw_close_no_adj_factor',
  valuation_quality: 'exact', carried_forward_dates: [], cash_cents: 0,
  weights, weights_status: weights ? FROZEN_BASKET_WEIGHTS_STATUS : null,
  missing_codes: missingCodes,
});

/**
 * 用上一已知价前向填充一个价格序列。
 *
 * 中间交易日缺 bar（停牌、上游缺失）**不能**当成 0 市值：那会凭空造出一次
 * -weight% 的假回撤和极高的假波动。这里沿用最近一次真实收盘，并记录被沿用的日期，
 * 由调用方以 `valuation_quality: carried_forward` 披露。
 *
 * 起始日必须已有价格（调用方已强制检查），因此填充后的序列不会出现"从未有价"的点。
 */
function fillPrices(series: PriceSeries, dates: string[]): { values: number[]; carried: string[] } {
  const values: number[] = [];
  const carried: string[] = [];
  let last: number | undefined;
  for (const date of dates) {
    const price = series.byDate.get(date);
    if (price !== undefined) {
      last = price;
      values.push(price);
    } else if (last !== undefined) {
      values.push(last);
      carried.push(date);
    } else {
      // 起始日之前没有任何价格：无法估值，保持 null，由调用方判为不可用。
      values.push(Number.NaN);
    }
  }
  return { values, carried };
}

/**
 * 组合价值序列（单位：分）：在每个共同交易日按各腿份数 × 当日收盘加总。
 * 缺价的腿按上一已知价计算（见 `fillPrices`），绝不按 0 市值计入。
 */
function portfolioSeries(
  legs: { series: PriceSeries; quantity: number }[], dates: string[],
): { values: number[]; carried: string[] } {
  const carried = new Set<string>();
  const filled = legs.map(leg => {
    const { values, carried: legCarried } = fillPrices(leg.series, dates);
    for (const date of legCarried) carried.add(date);
    return { values, quantity: leg.quantity };
  });
  const values = dates.map((_, index) => filled.reduce((sum, leg) => {
    const price = leg.values[index];
    if (!Number.isFinite(price)) return Number.NaN;
    // 份 × 元/份 × 100 分/元 = 分。
    return sum + leg.quantity * price * 100;
  }, 0));
  return { values, carried: [...carried].sort() };
}

// ---------------------------------------------------------------- 主入口

/**
 * 冻结对照基准比较。确定性：同一缓存 + 同一窗口 + 同一费用得到完全相同 JSON
 * （无时间戳、无随机）。
 */
export function buildBenchmarkComparison(input: BenchmarkComparisonInput): BenchmarkComparisonResult {
  const db = input.marketDb ?? null;
  const fees = input.fees ?? DEFAULT_FEE_RULES;
  const startRaw = input.start === undefined ? undefined : String(input.start).trim();
  const endRaw = input.end === undefined ? undefined : String(input.end).trim();
  if (startRaw !== undefined && !YMD.test(startRaw)) throw new Error('start 需要 YYYYMMDD 格式');
  if (endRaw !== undefined && !YMD.test(endRaw)) throw new Error('end 需要 YYYYMMDD 格式');
  if (startRaw && endRaw && startRaw > endRaw) throw new Error(`start ${startRaw} 晚于 end ${endRaw}`);

  const tables = {
    fund_basic: tableExists(db, 'fund_basic'),
    fund_daily: tableExists(db, 'fund_daily'),
    fund_adj: tableExists(db, 'fund_adj'),
    trade_cal: tableExists(db, 'trade_cal'),
  };
  const missingTables = (['fund_basic', 'fund_daily', 'fund_adj'] as const).filter(name => !tables[name]);
  const reasons: string[] = [];
  if (!db) reasons.push('market_cache_unavailable: 没有提供只读市场缓存');
  for (const name of missingTables) reasons.push(`${name}_table_missing: 缓存中没有 ${name} 表`);

  const requested = { start: startRaw ?? null, end: endRaw ?? null, defaulted: startRaw === undefined || endRaw === undefined };

  // 交易日：优先 trade_cal；没有日历时退化为 fund_daily 的日期集合。
  let dates: string[] = [];
  if (db && tables.trade_cal) {
    const endBound = endRaw ?? '99991231';
    const rows = db.prepare(`
      SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date`).all(endBound) as any[];
    dates = rows.map(row => String(row.cal_date));
  } else if (db && tables.fund_daily) {
    const rows = db.prepare('SELECT DISTINCT trade_date FROM fund_daily ORDER BY trade_date').all() as any[];
    dates = rows.map(row => String(row.trade_date));
  }
  if (startRaw) dates = dates.filter(date => date >= startRaw);
  if (endRaw) dates = dates.filter(date => date <= endRaw);
  if (!startRaw && dates.length > 0) dates = dates.slice(-252);
  if (startRaw && dates.length > 0 && !dates.includes(startRaw)) {
    reasons.push(`start_not_trading_day: ${startRaw} 不在交易日历中，窗口从其后第一个交易日 ${dates[0]} 开始`);
  }
  if (endRaw && dates.length > 0 && !dates.includes(endRaw)) {
    reasons.push(`end_not_trading_day: ${endRaw} 不在交易日历中，窗口到其前最后一个交易日 ${dates.at(-1)} 结束`);
  }
  const window = dates.length >= 2 ? { start: dates[0], end: dates.at(-1)!, trading_days: dates.length } : null;
  if (!window) reasons.push('window_too_short: 区间内不足两个交易日');

  const benchmarks: BenchmarkResult[] = [];

  // ---------------------------------------------------------------- 1. 沪深300 ETF 买入持有
  benchmarks.push(benchmarkSingle(db, tables, dates, window, fees, {
    id: 'csi300_etf_buy_hold',
    label: '沪深300 ETF（510300.SH）买入持有',
    code: CSI300_ETF_CODE,
    notionalCents: 1_000_000, // 10,000 元等额名义本金，仅用于归一化
  }));

  // ---------------------------------------------------------------- 2. 多资产常量权重篮子
  benchmarks.push(benchmarkWeightBasket(db, tables, dates, window, fees));

  // ---------------------------------------------------------------- 3. 初始五只静态基线
  benchmarks.push(benchmarkFiveStatic(db, tables, dates, window));

  const status: 'OK' | 'DEGRADED' | 'UNAVAILABLE' = !db || !tables.fund_daily || !window
    ? 'UNAVAILABLE'
    : benchmarks.some(benchmark => benchmark.status !== 'OK') ? 'DEGRADED' : 'OK';

  return {
    schema: BENCHMARK_SCHEMA,
    definition_version: BENCHMARK_DEFINITION_VERSION,
    definition_frozen: true,
    as_of_trade_date: window?.end ?? null,
    requested_window: requested,
    window,
    data_quality: { status, tables, missing_tables: missingTables, reasons },
    conventions: {
      fees: { version_note: 'DEFAULT_FEE_RULES（r0-fees-1.0.0，假设值，未与券商核对）', assumed: true, values: { ...fees } },
      cash: '前两个基准期初按收盘价一次性买入并扣除费用，此后现金为 0；'
        + `第三个基准从 ${FROZEN_FIVE_START_DATE} 的实际持仓与账户现金 ${(FROZEN_FIVE_CASH_CENTS / 100).toFixed(2)} 元出发，`
        + '已持有不再计建仓费用。三者期间都不再投入、不取现、不分红再投资（分红体现在复权因子中）。',
      rebalancing: '区间内不调仓；多资产篮子的权重只在期初生效。',
      price_basis: '有 fund_adj 时用 qfq（基准为区间内最后因子）；缺因子时整条序列退化为原始收盘并标注 raw_close_no_adj_factor。',
      return_formula: '总收益 =（期末价值 − 期初含费投入）/ 期初含费投入；最大回撤与年化波动基于逐日组合价值序列（252 个交易日）。',
    },
    benchmarks,
    notes: BENCHMARK_NOTES,
    disclaimer: BENCHMARK_DISCLAIMER,
  };
}

// ---------------------------------------------------------------- 单个代码基准

function benchmarkSingle(
  db: DatabaseSync | null,
  tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean },
  dates: string[],
  window: { start: string; end: string; trading_days: number } | null,
  fees: FeeRules,
  spec: { id: BenchmarkResult['id']; label: string; code: string; notionalCents: number },
): BenchmarkResult {
  if (!db || !window) {
    return unavailableBenchmark(spec.id, spec.label, 'window_unavailable', '没有可用的市场缓存或交易日窗口', [spec.code]);
  }
  const series = loadSeries(db, spec.code, window.start, window.end, tables);
  if (series.byDate.size === 0) {
    return unavailableBenchmark(spec.id, spec.label, 'code_not_cached',
      `缓存中 ${spec.code} 在 ${window.start}-${window.end} 没有可用收盘价`, [spec.code]);
  }
  const startPrice = series.byDate.get(window.start);
  const endPrice = series.byDate.get(window.end);
  const missing = [
    ...(startPrice === undefined ? [`${spec.code}@${window.start}`] : []),
    ...(endPrice === undefined ? [`${spec.code}@${window.end}`] : []),
  ];
  if (missing.length > 0) {
    return unavailableBenchmark(spec.id, spec.label, 'window_coverage_incomplete',
      `窗口两端必须都有行情：缺 ${missing.join(', ')}；不缩短窗口凑数`, missing);
  }
  const quantity = Math.floor(spec.notionalCents / (startPrice! * 100)); // 分 ÷（元/份 × 100 分/元）= 份
  if (quantity <= 0) {
    return unavailableBenchmark(spec.id, spec.label, 'notional_too_small', '名义本金不足一份', [spec.code]);
  }
  const grossCents = Math.round(quantity * startPrice! * 100); // 份 × 元/份 × 100 = 分
  const fee = entryFeeCents(grossCents, fees);
  const { values: prices, carried } = fillPrices(series, dates);
  const values = prices.map(price => (Number.isFinite(price) ? quantity * price * 100 : Number.NaN));
  const invested = grossCents + fee;
  const endValue = quantity * endPrice! * 100;  return {
    id: spec.id,
    label: spec.label,
    status: 'OK',
    reason: null,
    detail: `名义本金 ${(spec.notionalCents / 100).toFixed(2)} 元，买入 ${quantity} 份；费用 ${(fee / 100).toFixed(2)} 元`,
    total_return_pct: r2(((endValue - invested) / invested) * 100),
    max_drawdown_pct: drawdownPct(values.map(value => value / invested)),
    annualized_vol_pct: annualizedVolPct(values.map(value => value / invested)),
    end_value_cents: Math.round(endValue),
    start_value_cents: invested,
    entry_fee_cents: fee,
    window: { ...window },
    legs: [{
      ts_code: spec.code,
      name: series.name,
      weight: 1,
      start_quantity: quantity,
      start_price_milli: Math.round(startPrice! * 1000),
      end_price_milli: Math.round(endPrice! * 1000),
      total_return_pct: r2((endPrice! / startPrice! - 1) * 100),
      bars_used: series.bars.length,
      price_basis: series.basis,
    }],
    price_basis: series.basis,
    valuation_quality: carried.length > 0 ? 'carried_forward' : 'exact',
    carried_forward_dates: carried,
    cash_cents: 0,
    weights: null,
    weights_status: null,
    missing_codes: [],
  };
}

// ---------------------------------------------------------------- 多资产篮子

function benchmarkWeightBasket(
  db: DatabaseSync | null,
  tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean },
  dates: string[],
  window: { start: string; end: string; trading_days: number } | null,
  fees: FeeRules,
): BenchmarkResult {
  const id: BenchmarkResult['id'] = 'frozen_multi_asset_basket';
  const label = '冻结多资产 ETF 篮子（40% 权益 / 25% 债券 / 15% 黄金 / 20% 跨境）';
  const weights = { ...FROZEN_BASKET_WEIGHTS };
  if (!db || !window) {
    return unavailableBenchmark(id, label, 'window_unavailable', '没有可用的市场缓存或交易日窗口', Object.keys(weights), weights);
  }
  const notionalCents = 1_000_000;
  const legs: { series: PriceSeries; quantity: number }[] = [];
  const legViews: BenchmarkLeg[] = [];
  const missing: string[] = [];
  let feeTotal = 0;
  let grossTotal = 0;
  for (const [code, weight] of Object.entries(weights)) {
    const series = loadSeries(db, code, window.start, window.end, tables);
    const startPrice = series.byDate.get(window.start);
    const endPrice = series.byDate.get(window.end);
    if (startPrice === undefined || endPrice === undefined) {
      missing.push(startPrice === undefined ? `${code}@${window.start}` : `${code}@${window.end}`);
      continue;
    }
    const legNotional = Math.round(notionalCents * weight);
    const quantity = Math.floor(legNotional / (startPrice * 100));
    if (quantity <= 0) { missing.push(`${code}:notional_too_small`); continue; }
    const gross = Math.round(quantity * startPrice * 100);
    grossTotal += gross;
    feeTotal += entryFeeCents(gross, fees);
    legs.push({ series, quantity });
    legViews.push({
      ts_code: code,
      name: series.name,
      weight,
      start_quantity: quantity,
      start_price_milli: Math.round(startPrice * 1000),
      end_price_milli: Math.round(endPrice * 1000),
      total_return_pct: r2((endPrice / startPrice - 1) * 100),
      bars_used: series.bars.length,
      price_basis: series.basis,
    });
  }
  if (missing.length > 0) {
    return unavailableBenchmark(id, label, 'leg_not_cached',
      `篮子成分在窗口两端缺行情：${missing.join(', ')}；不缩短窗口、不用替代标的`, missing, weights);
  }
  const { values, carried } = portfolioSeries(legs, dates);
  const invested = grossTotal + feeTotal;
  const endValue = values.at(-1)!;
  const bases = new Set(legViews.map(leg => leg.price_basis));
  return {
    id,
    label,
    status: 'OK',
    reason: null,
    detail: `按常量权重建仓；实际投入 ${(grossTotal / 100).toFixed(2)} 元（权重取整后不足部分留作现金 0），费用 ${(feeTotal / 100).toFixed(2)} 元`
      + (carried.length > 0 ? `；${carried.length} 个交易日沿用上一已知价估值` : ''),
    total_return_pct: r2(((endValue - invested) / invested) * 100),
    max_drawdown_pct: drawdownPct(values.map(value => value / invested)),
    annualized_vol_pct: annualizedVolPct(values.map(value => value / invested)),
    end_value_cents: Math.round(endValue),
    start_value_cents: invested,
    entry_fee_cents: feeTotal,
    window: { ...window },
    legs: legViews,
    price_basis: bases.size === 1 ? [...bases][0] : 'mixed',
    valuation_quality: carried.length > 0 ? 'carried_forward' : 'exact',
    carried_forward_dates: carried,
    cash_cents: 0,
    weights,
    weights_status: FROZEN_BASKET_WEIGHTS_STATUS,
    missing_codes: [],
  };
}

// ---------------------------------------------------------------- 五只静态基线

function benchmarkFiveStatic(
  db: DatabaseSync | null,
  tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean },
  dates: string[],
  window: { start: string; end: string; trading_days: number } | null,
): BenchmarkResult {
  const id: BenchmarkResult['id'] = 'initial_five_etf_basket';
  const label = '初始五只 ETF 按固定起始数量持有（不交易）';
  if (!db || !window) {
    return unavailableBenchmark(id, label, 'window_unavailable', '没有可用的市场缓存或交易日窗口', [...ETF_UNIVERSE]);
  }
  // 该基准锚定在用户确认的 2026-10-16 基线：数量与现金都是当时的事实，
  // 而不是用某个合成窗口的起点重新建仓。
  const anchoredDates = dates.filter(date => date >= FROZEN_FIVE_START_DATE);
  const start = anchoredDates[0];
  if (!start || window.end < FROZEN_FIVE_START_DATE) {
    return unavailableBenchmark(id, label, 'start_before_baseline',
      `窗口 ${window.start}-${window.end} 不包含基线日 ${FROZEN_FIVE_START_DATE}，无法从实际持仓出发`,
      [...ETF_UNIVERSE]);
  }
  const anchoredWindow = { start, end: window.end, trading_days: anchoredDates.length };
  const legs: { series: PriceSeries; quantity: number }[] = [];
  const legViews: BenchmarkLeg[] = [];
  const missing: string[] = [];
  let securitiesStart = 0;
  for (const code of ETF_UNIVERSE) {
    const quantity = FROZEN_FIVE_QUANTITIES[code];
    if (!Number.isInteger(quantity) || quantity <= 0) {
      missing.push(`${code}:quantity_not_declared`);
      continue;
    }
    const series = loadSeries(db, code, start, window.end, tables);
    const startPrice = series.byDate.get(start);
    const endPrice = series.byDate.get(window.end);
    if (startPrice === undefined || endPrice === undefined) {
      missing.push(startPrice === undefined ? `${code}@${start}` : `${code}@${window.end}`);
      continue;
    }
    securitiesStart += Math.round(quantity * startPrice * 100);
    legs.push({ series, quantity });
    legViews.push({
      ts_code: code,
      name: series.name,
      weight: null,
      start_quantity: quantity,
      start_price_milli: Math.round(startPrice * 1000),
      end_price_milli: Math.round(endPrice * 1000),
      total_return_pct: r2((endPrice / startPrice - 1) * 100),
      bars_used: series.bars.length,
      price_basis: series.basis,
    });
  }
  if (missing.length > 0) {
    return unavailableBenchmark(id, label, 'leg_not_cached',
      `五只持仓在窗口两端缺行情：${missing.join(', ')}；不缩短窗口、不用替代标的`, missing, null);
  }
  // 归一权重（按起始证券市值），仅用于展示；现金单独披露。
  for (const leg of legViews) {
    leg.weight = securitiesStart > 0 ? r6((leg.start_quantity! * leg.start_price_milli! / 10) / securitiesStart) : null;
  }
  const { values, carried } = portfolioSeries(legs, anchoredDates);
  const cash = FROZEN_FIVE_CASH_CENTS;
  // 已持有：没有建仓费用。起始价值 = 实际证券市值 + 账户现金。
  const invested = securitiesStart + cash;
  const endSecurities = values.at(-1)!;
  const endValue = endSecurities + cash;
  const bases = new Set(legViews.map(leg => leg.price_basis));
  return {
    id,
    label,
    status: 'OK',
    reason: null,
    detail: `从 ${start} 的实际持仓出发（证券 ${(securitiesStart / 100).toFixed(2)} 元 + 现金 ${(cash / 100).toFixed(2)} 元）；`
      + `已持有，不再计建仓费用；区间内不交易`
      + (carried.length > 0 ? `；${carried.length} 个交易日沿用上一已知价估值` : ''),
    total_return_pct: r2(((endValue - invested) / invested) * 100),
    max_drawdown_pct: drawdownPct(values.map(value => (value + cash) / invested)),
    annualized_vol_pct: annualizedVolPct(values.map(value => (value + cash) / invested)),
    end_value_cents: Math.round(endValue),
    start_value_cents: invested,
    entry_fee_cents: 0,
    window: { ...anchoredWindow },
    legs: legViews,
    price_basis: bases.size === 1 ? [...bases][0] : 'mixed',
    valuation_quality: carried.length > 0 ? 'carried_forward' : 'exact',
    carried_forward_dates: carried,
    cash_cents: cash,
    weights: null,
    weights_status: null,
    missing_codes: [],
  };
}
