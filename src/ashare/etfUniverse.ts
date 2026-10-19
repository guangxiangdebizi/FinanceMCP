import type { DatabaseSync } from 'node:sqlite';
import { ETF_UNIVERSE, fundBaseFactor } from './etf.js';
import {
  ETF_CANDIDATE_CATEGORIES, ETF_CANDIDATE_CATEGORY_LABELS, ETF_CANDIDATE_DECLARATIONS,
  type EtfCandidateCategory, type EtfCandidateDeclaration,
} from './etfDeclarations.js';
import { adjustmentRatio } from './data.js';

// 声明式候选池在 etfDeclarations.ts 中定义（无依赖），这里原样再导出，保持既有调用方不变。
export const ETF_UNIVERSE_VERSION = 'r2-etf-candidates-1.0.0';

export {
  ETF_CANDIDATE_CATEGORIES, ETF_CANDIDATE_CATEGORY_LABELS, ETF_CANDIDATE_DECLARATIONS,
  type EtfCandidateCategory, type EtfCandidateDeclaration,
};

/**
 * C2 候选 ETF 研究池（可复选、只读、确定性）。
 *
 * 定位（PRD §6 / §11）：
 * - 这是**研究候选筛选**，不是买入信号、不是交易计划。输出的分数是启发式排序，
 *   不是收益预测，也没有经过前瞻检验。
 * - 只读本地市场缓存（`fund_basic` / `fund_daily` / `fund_adj` / `fund_share` /
 *   `trade_cal` / `index_daily`），不访问网络、不写任何库。
 * - 生产缓存当前**没有** fund_* 表。缺表不是"候选不存在"，而是无法评估：本模块
 *   必须把每一行标为 DEGRADED 并写出原因，绝不静默丢弃，
 *   也绝不用成交额、份额变化或估计值冒充"资金净流入"。
 * - 五只真实持仓永远入选，永远不被流动性/规模过滤掉（`held: true`）。
 */

// ---------------------------------------------------------------- 声明式候选池

// 声明式候选池见 etfDeclarations.ts（无依赖，供 etf.ts 与 etfUniverse.ts 共用）。

// ---------------------------------------------------------------- 阈值（全部为声明值）

/** 流动性窗口（交易日）。 */
export const ETF_SCREEN_LIQUIDITY_WINDOW = 20;
/** 波动/回撤窗口（交易日）。 */
export const ETF_SCREEN_RISK_WINDOW = 60;
/** 评估流动性所需的最少行情根数；低于此值无法评估，按失败处理并写出原因。 */
export const ETF_SCREEN_MIN_LIQUIDITY_BARS = 10;
/** 20 日成交额中位数下限（千元）——unit 与 fund_daily.amount 一致。 */
export const ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY = 500;
/** 20 日成交额均值下限（千元）。 */
export const ETF_SCREEN_MIN_MEAN_AMOUNT_KCY = 300;
/** 规模下限（万元）：份额（万份）× 收盘价（元/份）。 */
export const ETF_SCREEN_MIN_SIZE_WAN_CNY = 20000;
/** 年化实现波动率上限（%）。 */
export const ETF_SCREEN_MAX_VOL_PCT = 60;
/** 最大回撤下限（负百分数；−55 表示回撤不超过 55%）。 */
export const ETF_SCREEN_MAX_DRAWDOWN_PCT = -55;
/** 评估波动/回撤所需的最少行情根数。 */
export const ETF_SCREEN_MIN_RISK_BARS = 21;
/** 年化跟踪误差上限（%）。 */
export const ETF_SCREEN_MAX_TRACKING_ERROR_PCT = 8;
/** 与基准指数的相关系数下限。 */
export const ETF_SCREEN_MIN_CORRELATION = 0.8;
/** 默认返回条数上限（五只持仓始终保留）。 */
export const ETF_CANDIDATE_DEFAULT_LIMIT = 20;
/** 年化交易日数（与项目其他模块一致的声明值）。 */
export const ETF_SCREEN_TRADING_DAYS_PER_YEAR = 252;

/** 启发式打分权重。分数只用于排序，不是收益预测、不是买入信号。 */
export const ETF_SCREEN_SCORE_WEIGHTS = {
  liquidity: 0.35,
  size: 0.25,
  risk: 0.25,
  tracking: 0.05,
  coverage: 0.10,
} as const;

export const ETF_UNIVERSE_DISCLAIMER =
  '本候选池是**研究候选筛选**，不是买入信号，也不是交易计划：分数是启发式排序，未经前瞻检验，'
  + '不保证收益。所有数字只来自本地只读缓存，缺表/缺字段一律显式标为 DEGRADED 或 unavailable，'
  + '不臆造溢价折价、净流入或规模。成交额（fund_daily.amount，千元）与份额变化都不是“资金净流入”。'
  + 'ETF 交易由用户自行决定并在券商手动执行。';

// ---------------------------------------------------------------- 类型

export type ScreenFilterState = 'pass' | 'fail' | 'unavailable' | 'not_applicable';
/** 行状态只有两种：数据齐全 OK；缺任一来源 DEGRADED（绝不静默丢弃）。 */
export type CandidateStatus = 'OK' | 'DEGRADED';
export type CoverageStatus = 'READY' | 'DEGRADED' | 'NOT_READY';

export interface FilterOutcome {
  state: ScreenFilterState;
  /** 通过或失败时都要说明依据；unavailable 时说明缺什么。 */
  detail: string;
  /** state==='fail' 时的机器可读原因码。 */
  reason?: string;
  /** state==='unavailable' 时的机器可读原因码（行因此降级，但不被丢弃）。 */
  degrade_reason?: string;
}

export interface EtfCandidateData {
  /** 行情根数（截至 asOf，最多 risk 窗口）。 */
  bars_used: number;
  latest_bar_date: string | null;
  latest_close_milli: number | null;
  /** 价格口径：复权（有 fund_adj）或原始收盘（缺因子，显式标注）。 */
  price_basis: 'qfq_adjusted' | 'raw_close_no_adj_factor';
  adj_base: { trade_date: string; adj_factor: number } | null;
  adj_missing_bars: number;
  share: { fd_share_wan: number | null; trade_date: string | null };
  /** 份额 × 最新收盘 = 万元；缺份额或收盘时为 null，不补 0。 */
  size_wan_cny: number | null;
  coverage: {
    fund_basic: boolean;
    fund_daily: boolean;
    fund_adj: boolean;
    fund_share: boolean;
    latest_trade_date: string | null;
  };
}

export interface EtfCandidateFilters {
  liquidity: FilterOutcome & {
    window: number;
    unit: string;
    median_amount_kcy: number | null;
    mean_amount_kcy: number | null;
    median_amount_cny: number | null;
    zero_volume_days: number;
    threshold: { min_bars: number; min_median_amount_kcy: number; min_mean_amount_kcy: number };
  };
  size: FilterOutcome & {
    unit: string;
    size_wan_cny: number | null;
    threshold_wan_cny: number;
  };
  /** 溢价折价：缓存没有净值/IOPV 字段时恒为 unavailable，绝不用估算值代替。 */
  premium_discount: FilterOutcome & { value_pct: number | null };
  tracking: FilterOutcome & {
    benchmark_index_code: string | null;
    tracking_error_pct: number | null;
    correlation: number | null;
    observations: number;
    threshold: { max_tracking_error_pct: number; min_correlation: number };
  };
  risk: FilterOutcome & {
    window: number;
    bars_used: number;
    realized_vol_pct: number | null;
    max_drawdown_pct: number | null;
    threshold: { max_vol_pct: number; max_drawdown_pct: number; min_bars: number };
  };
}

export interface EtfCandidateRow {
  rank: number;
  ts_code: string;
  category: EtfCandidateCategory;
  category_label: string;
  name: string | null;
  /** 名称来源：缓存事实 / 声明提示。绝不能把 hint 当成 fund_basic 的事实。 */
  name_source: 'fund_basic' | 'declared_hint' | 'unavailable';
  /** true = 用户真实持仓；永远入选、永远不被流动性/规模过滤。 */
  held: boolean;
  included: boolean;
  status: CandidateStatus;
  status_reasons: string[];
  as_of_trade_date: string;
  filters: EtfCandidateFilters;
  data: EtfCandidateData;
  /** 所有失败过滤器的显式排除原因（持仓也会列出，但不因此被排除）。 */
  exclusions: { filter: string; reason: string; detail: string }[];
  /** 启发式分（0–1）；无法评估时为 null。 */
  score: number | null;
  score_components: Record<string, number | null>;
  source: 'server_cache';
}

export interface EtfCandidateScreenResult {
  schema: 'ashare-etf-candidate-screen/1.0';
  as_of_trade_date: string;
  universe_version: string;
  categories_requested: EtfCandidateCategory[];
  limit: number;
  data_coverage: {
    tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean; fund_share: boolean; index_daily: boolean; trade_cal: boolean };
    missing_tables: string[];
    latest: { fund_daily: string | null; fund_adj: string | null; fund_share: string | null };
    expected_trade_date: string | null;
    status: CoverageStatus;
    reasons: string[];
  };
  declared: number;
  evaluated: number;
  included: number;
  excluded: { ts_code: string; category: EtfCandidateCategory; reasons: string[] }[];
  degraded: string[];
  held: string[];
  candidates: EtfCandidateRow[];
  units: Record<string, string>;
  score_weights: typeof ETF_SCREEN_SCORE_WEIGHTS;
  held_policy: string;
  disclaimer: string;
}

export interface ScreenEtfCandidatesInput {
  /** 目标交易日 YYYYMMDD。 */
  asOf: string;
  /** 只评估这些类别；缺省全部。五只持仓不受该过滤影响。 */
  categories?: readonly string[];
  /** 返回条数上限；五只持仓始终保留，因此实际条数可能大于该值。 */
  limit?: number;
}

// ---------------------------------------------------------------- 小工具

const YMD = /^\d{8}$/;

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function tableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

const r4 = (value: number): number => Math.round(value * 10000) / 10000;
const r6 = (value: number): number => Math.round(value * 1000000) / 1000000;
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 总体标准差（样本）；少于 2 个观测时返回 null。 */
function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function pearson(a: number[], b: number[]): number | null {
  if (a.length < 3 || a.length !== b.length) return null;
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0;
  let da = 0;
  let db2 = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db2 += y * y;
  }
  if (da <= 0 || db2 <= 0) return null;
  return num / Math.sqrt(da * db2);
}

function ok(detail: string): FilterOutcome {
  return { state: 'pass', detail };
}

function fail(reason: string, detail: string): FilterOutcome {
  return { state: 'fail', reason, detail };
}

function unavailable(degradeReason: string, detail: string): FilterOutcome {
  return { state: 'unavailable', detail, degrade_reason: degradeReason };
}

// ---------------------------------------------------------------- 主入口

const HELD_SET = new Set<string>(ETF_UNIVERSE as readonly string[]);

/**
 * 跨类别筛选候选 ETF。确定性：同一缓存 + 同一 asOf + 同一参数得到完全相同的 JSON
 * （无时间戳、无随机、排序有稳定的二级键）。
 *
 * 缺表语义：
 * - 没有 `fund_daily` → 整体 NOT_READY，所有行 DEGRADED，不产生任何排除；
 * - 有 `fund_daily` 但缺 `fund_adj` / `fund_share` / `fund_basic` → DEGRADED，
 *   缺的那一项写成 `unavailable` + 原因，行仍然返回，不被静默丢弃。
 */
export function screenEtfCandidates(
  db: DatabaseSync | null | undefined,
  input: ScreenEtfCandidatesInput,
): EtfCandidateScreenResult {
  const asOf = String(input.asOf ?? '').trim();
  if (!YMD.test(asOf)) throw new Error('as_of_trade_date 需要 YYYYMMDD 格式');

  const requestedCategories: EtfCandidateCategory[] = input.categories && input.categories.length > 0
    ? ETF_CANDIDATE_CATEGORIES.filter(category => input.categories!.includes(category))
    : [...ETF_CANDIDATE_CATEGORIES];
  const rawLimit = input.limit;
  const limit = rawLimit === undefined ? ETF_CANDIDATE_DEFAULT_LIMIT
    : Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : ETF_CANDIDATE_DEFAULT_LIMIT;

  // 数据覆盖：先如实报告哪些表存在，绝不假设 fund_* 一定存在。
  const tables = {
    fund_basic: tableExists(db, 'fund_basic'),
    fund_daily: tableExists(db, 'fund_daily'),
    fund_adj: tableExists(db, 'fund_adj'),
    fund_share: tableExists(db, 'fund_share'),
    index_daily: tableExists(db, 'index_daily'),
    trade_cal: tableExists(db, 'trade_cal'),
  };
  const missingTables = (['fund_basic', 'fund_daily', 'fund_adj', 'fund_share'] as const)
    .filter(name => !tables[name]);
  const latestOf = (table: string): string | null => {
    if (!db || !tableExists(db, table)) return null;
    try {
      return (db.prepare(`SELECT MAX(trade_date) AS d FROM ${table}`).get() as any)?.d ?? null;
    } catch {
      return null;
    }
  };
  const expectedTradeDate = db && tables.trade_cal
    ? ((db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1').get(asOf) as any)?.cal_date ?? null)
    : null;

  const coverageReasons: string[] = [];
  if (!db) coverageReasons.push('market_cache_unavailable: 没有提供只读市场缓存');
  for (const name of missingTables) coverageReasons.push(`${name}_table_missing: 缓存中没有 ${name} 表，相关过滤只能标为 unavailable`);
  const coverageStatus: CoverageStatus = !db || !tables.fund_daily
    ? 'NOT_READY'
    : missingTables.length > 0 ? 'DEGRADED' : 'READY';

  const declarations = ETF_CANDIDATE_DECLARATIONS.filter(declaration => requestedCategories.includes(declaration.category));
  // 五只持仓必须始终入选：即使类别被过滤掉，也要在列表里出现。
  for (const declaration of ETF_CANDIDATE_DECLARATIONS) {
    if (HELD_SET.has(declaration.ts_code) && !declarations.includes(declaration)) declarations.push(declaration);
  }
  const ordered = declarations.slice().sort((a, b) => (a.ts_code < b.ts_code ? -1 : a.ts_code > b.ts_code ? 1 : 0));

  // limit 只作用于**排名**：先给全部行排名，再截断展示；入选与否与 limit 无关，
  // 因此 `included` / `excluded` 的统计不会被展示上限改变。
  const allRows: EtfCandidateRow[] = ordered.map(declaration => evaluateCandidate(db, declaration, asOf, tables));
  const rankedAll = allRows.slice().sort((a, b) => {
    if (a.score === null && b.score === null) return a.ts_code < b.ts_code ? -1 : 1;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.ts_code < b.ts_code ? -1 : 1;
  });
  rankedAll.forEach((row, index) => { row.rank = index + 1; });

  const includedRows = rankedAll.filter(row => row.included);
  const excluded = rankedAll.filter(row => !row.included);
  // limit 只截断“OK 的非持仓行”：持仓永远保留；DEGRADED 行也不因展示上限被丢弃，
  // 否则缺数据的候选会从结果里静默消失（任务要求“不静默丢弃”）。
  const mustKeep = includedRows.filter(row => row.held || row.status !== 'OK');
  const optional = includedRows.filter(row => !row.held && row.status === 'OK');
  const capped = mustKeep
    .concat(optional.slice(0, Math.max(0, limit - mustKeep.length)))
    .sort((a, b) => a.rank - b.rank);
  // 被排除的行也保留在结果末尾（included:false + exclusions），便于复核“为什么没入选”，
  // 不因展示上限消失。
  const visible = capped.concat(excluded);

  return {
    schema: 'ashare-etf-candidate-screen/1.0',
    as_of_trade_date: asOf,
    universe_version: ETF_UNIVERSE_VERSION,
    categories_requested: requestedCategories,
    limit,
    data_coverage: {
      tables,
      missing_tables: missingTables,
      latest: { fund_daily: latestOf('fund_daily'), fund_adj: latestOf('fund_adj'), fund_share: latestOf('fund_share') },
      expected_trade_date: expectedTradeDate,
      status: coverageStatus,
      reasons: coverageReasons,
    },
    declared: allRows.length,
    evaluated: allRows.length,
    included: includedRows.length,
    excluded: excluded.map(row => ({
      ts_code: row.ts_code,
      category: row.category,
      reasons: row.exclusions.map(item => `${item.filter}:${item.reason}`),
    })),
    degraded: allRows.filter(row => row.status !== 'OK').map(row => row.ts_code),
    // held 报告的是“结果里实际出现的持仓”，与展示上限无关（持仓永远保留）。
    held: includedRows.filter(row => row.held).map(row => row.ts_code),
    candidates: visible,
    units: {
      amount_kcy: '千元（与 fund_daily.amount 原样一致）',
      amount_cny: '元',
      fd_share_wan: '万份（时点存量，不是资金净流入）',
      price: '元/份（价格字段用整数厘 *_milli 输出）',
      size_wan_cny: '万元（万份 × 元/份）',
      vol_pct: '年化百分数（%），按 252 个交易日',
      drawdown_pct: '百分数（%），负值表示回撤',
    },
    score_weights: ETF_SCREEN_SCORE_WEIGHTS,
    held_policy: '五只真实持仓（' + ETF_UNIVERSE.join('、') + '）永远出现在结果里，永远不被流动性/规模/风险过滤排除；它们的失败项仍会写入 exclusions 以便复核。',
    disclaimer: ETF_UNIVERSE_DISCLAIMER,
  };
}

// ---------------------------------------------------------------- 单只评估

function evaluateCandidate(
  db: DatabaseSync | null | undefined,
  declaration: EtfCandidateDeclaration,
  asOf: string,
  tables: { fund_basic: boolean; fund_daily: boolean; fund_adj: boolean; fund_share: boolean; index_daily: boolean; trade_cal: boolean },
): EtfCandidateRow {
  const code = declaration.ts_code;
  const held = HELD_SET.has(code);
  const statusReasons: string[] = [];
  const exclusions: EtfCandidateRow['exclusions'] = [];

  // ---- fund_basic
  const basic = db && tables.fund_basic
    ? (db.prepare('SELECT name, fund_type, invest_type, benchmark, status, list_date, delist_date, market FROM fund_basic WHERE ts_code = ?').get(code) as any)
    : undefined;
  const name = basic?.name ? String(basic.name) : declaration.name_hint;
  const nameSource: EtfCandidateRow['name_source'] = basic?.name ? 'fund_basic' : 'declared_hint';
  if (!tables.fund_basic) statusReasons.push('fund_basic_table_missing');
  else if (!basic) statusReasons.push('fund_basic_row_missing');

  // ---- fund_daily（最多 risk 窗口根）
  const bars: any[] = db && tables.fund_daily
    ? (db.prepare(`
        SELECT trade_date, close, vol, amount FROM fund_daily
        WHERE ts_code = ? AND trade_date <= ?
        ORDER BY trade_date DESC LIMIT ?`).all(code, asOf, ETF_SCREEN_RISK_WINDOW) as any[])
    : [];
  if (!tables.fund_daily) statusReasons.push('fund_daily_table_missing');
  else if (bars.length === 0) statusReasons.push('fund_daily_row_missing');

  // ---- fund_adj（复权口径；缺因子时显式退化为原始收盘）
  const adjBase = db && tables.fund_adj ? safeFundBaseFactor(db, code, asOf) : null;
  const factors = new Map<string, number>();
  if (db && tables.fund_adj && adjBase) {
    for (const row of db.prepare(`
      SELECT trade_date, adj_factor FROM fund_adj
      WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0`).all(code, asOf) as any[]) {
      factors.set(String(row.trade_date), Number(row.adj_factor));
    }
  }
  const priceBasis: EtfCandidateData['price_basis'] = adjBase ? 'qfq_adjusted' : 'raw_close_no_adj_factor';
  let adjMissingBars = 0;
  // bars 是倒序：先翻正序，再逐根换算复权价（基准 = asOf 之前最后一个因子）。
  const series: { trade_date: string; close: number; vol: number | null; amount: number | null }[] = [];
  for (const bar of bars.slice().reverse()) {
    const close = num(bar.close);
    if (close === null || close <= 0) continue;
    let adjusted = close;
    if (adjBase) {
      const factor = factors.get(String(bar.trade_date));
      if (!(typeof factor === 'number' && factor > 0)) { adjMissingBars += 1; continue; }
      const ratio = adjustmentRatio('qfq', factor, adjBase.adj_factor);
      if (!Number.isFinite(ratio)) { adjMissingBars += 1; continue; }
      adjusted = close * ratio;
    }
    series.push({
      trade_date: String(bar.trade_date),
      close: r4(adjusted),
      vol: num(bar.vol),
      amount: num(bar.amount),
    });
  }
  if (!adjBase) statusReasons.push('fund_adj_unavailable_price_basis_raw');
  if (adjMissingBars > 0) statusReasons.push(`fund_adj_missing_bars:${adjMissingBars}`);

  const latest = series.at(-1) ?? null;

  // ---- fund_share（时点存量，万份）
  const shareRow = db && tables.fund_share
    ? (db.prepare('SELECT trade_date, fd_share FROM fund_share WHERE ts_code = ? AND trade_date <= ? AND fd_share IS NOT NULL ORDER BY trade_date DESC LIMIT 1').get(code, asOf) as any)
    : undefined;
  if (!tables.fund_share) statusReasons.push('fund_share_table_missing');
  else if (!shareRow) statusReasons.push('fund_share_row_missing');
  const fdShareWan = num(shareRow?.fd_share);
  const latestCloseMilli = latest ? Math.round(latest.close * 1000) : null;
  // 万份 × 元/份 = 万元。
  const sizeWan = fdShareWan !== null && latestCloseMilli !== null && fdShareWan > 0
    ? r4(fdShareWan * (latestCloseMilli / 1000))
    : null;

  // ---- 流动性（最近 20 根，单位千元）
  const liquidityBars = series.slice(-ETF_SCREEN_LIQUIDITY_WINDOW);
  const amounts = liquidityBars
    .map(bar => bar.amount)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const medianAmountKcy = amounts.length > 0 ? median(amounts) : null;
  const meanAmountKcy = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : null;
  const zeroVolumeDays = liquidityBars.filter(bar => bar.vol === null || bar.vol === 0).length;
  const liquidityFilter: EtfCandidateFilters['liquidity'] = {
    ...((): FilterOutcome => {
      if (!tables.fund_daily) return unavailable('fund_daily_table_missing', '缓存没有 fund_daily 表，无法计算成交额中位数/均值');
      // 完全没有行情是“数据缺失”，不是“流动性差”：标 unavailable 并降级，不据此排除。
      if (liquidityBars.length === 0) return unavailable('fund_daily_row_missing', '缓存中没有该代码的行情，流动性不可评估');
      if (liquidityBars.length < ETF_SCREEN_MIN_LIQUIDITY_BARS) {
        return fail('liquidity_bars_insufficient',
          `${ETF_SCREEN_LIQUIDITY_WINDOW} 个交易日窗口内只有 ${liquidityBars.length} 根可用行情，低于 ${ETF_SCREEN_MIN_LIQUIDITY_BARS} 根`);
      }
      if (medianAmountKcy === null || meanAmountKcy === null) return unavailable('amount_missing', '窗口内 fund_daily.amount 全为空，无法评估流动性');
      if (medianAmountKcy < ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY) {
        return fail('liquidity_median_below_min',
          `20 日成交额中位数 ${medianAmountKcy} 千元 < 下限 ${ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY} 千元`);
      }
      if (meanAmountKcy < ETF_SCREEN_MIN_MEAN_AMOUNT_KCY) {
        return fail('liquidity_mean_below_min',
          `20 日成交额均值 ${Math.round(meanAmountKcy)} 千元 < 下限 ${ETF_SCREEN_MIN_MEAN_AMOUNT_KCY} 千元`);
      }
      return ok(`20 日成交额中位数 ${medianAmountKcy} 千元、均值 ${Math.round(meanAmountKcy)} 千元，均达到下限`);
    })(),
    window: ETF_SCREEN_LIQUIDITY_WINDOW,
    unit: '千元（fund_daily.amount 原始单位）',
    median_amount_kcy: medianAmountKcy,
    mean_amount_kcy: meanAmountKcy === null ? null : r4(meanAmountKcy),
    median_amount_cny: medianAmountKcy === null ? null : medianAmountKcy * 1000,
    zero_volume_days: zeroVolumeDays,
    threshold: {
      min_bars: ETF_SCREEN_MIN_LIQUIDITY_BARS,
      min_median_amount_kcy: ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY,
      min_mean_amount_kcy: ETF_SCREEN_MIN_MEAN_AMOUNT_KCY,
    },
  };

  // ---- 规模
  const sizeFilter: EtfCandidateFilters['size'] = {
    ...((): FilterOutcome => {
      if (!tables.fund_share) return unavailable('fund_share_table_missing', '缓存没有 fund_share 表，规模只能为 null');
      if (sizeWan === null) return unavailable('size_unavailable', '缺少可比份额或收盘价，规模为 null（不补 0）');
      if (sizeWan < ETF_SCREEN_MIN_SIZE_WAN_CNY) {
        return fail('size_below_min', `规模约 ${sizeWan} 万元 < 下限 ${ETF_SCREEN_MIN_SIZE_WAN_CNY} 万元`);
      }
      return ok(`规模约 ${sizeWan} 万元（份额 ${fdShareWan} 万份 × 收盘 ${(latestCloseMilli! / 1000)} 元）`);
    })(),
    unit: '万元（fund_share.fd_share 万份 × fund_daily.close 元/份）',
    size_wan_cny: sizeWan,
    threshold_wan_cny: ETF_SCREEN_MIN_SIZE_WAN_CNY,
  };

  // ---- 溢价折价：缓存没有净值/IOPV 字段，恒为 unavailable，不臆造。
  const premiumFilter: EtfCandidateFilters['premium_discount'] = {
    ...unavailable('cache_lacks_nav_or_iopv',
      'fund_basic 与 fund_daily 都没有净值（nav/iopv）字段，无法计算溢价折价；此处显式为 unavailable'),
    value_pct: null,
  };

  // ---- 风险：年化实现波动率 + 最大回撤（复权口径，缺因子时用原始收盘并已标注）
  const closes = series.map(bar => bar.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) returns.push(closes[i] / closes[i - 1] - 1);
  const dailyVol = stdev(returns);
  const realizedVolPct = dailyVol === null ? null : r4(dailyVol * Math.sqrt(ETF_SCREEN_TRADING_DAYS_PER_YEAR) * 100);
  const maxDrawdownPct = closes.length >= 2 ? drawdownPct(closes) : null;
  const riskFilter: EtfCandidateFilters['risk'] = {
    ...((): FilterOutcome => {
      if (!tables.fund_daily) return unavailable('fund_daily_table_missing', '缓存没有 fund_daily 表，无法计算波动与回撤');
      if (closes.length < ETF_SCREEN_MIN_RISK_BARS) {
        return unavailable('risk_bars_insufficient',
          `窗口内只有 ${closes.length} 根可比收盘，低于 ${ETF_SCREEN_MIN_RISK_BARS} 根，波动与回撤不可评估（不因缺数据而排除）`);
      }
      if (realizedVolPct !== null && realizedVolPct > ETF_SCREEN_MAX_VOL_PCT) {
        return fail('vol_above_max', `年化实现波动率 ${realizedVolPct}% 高于上限 ${ETF_SCREEN_MAX_VOL_PCT}%`);
      }
      if (maxDrawdownPct !== null && maxDrawdownPct < ETF_SCREEN_MAX_DRAWDOWN_PCT) {
        return fail('drawdown_below_max', `最大回撤 ${maxDrawdownPct}% 低于下限 ${ETF_SCREEN_MAX_DRAWDOWN_PCT}%`);
      }
      return ok(`年化实现波动率 ${realizedVolPct}%，最大回撤 ${maxDrawdownPct}%（区间 ${closes.length} 根）`);
    })(),
    window: ETF_SCREEN_RISK_WINDOW,
    bars_used: closes.length,
    realized_vol_pct: realizedVolPct,
    max_drawdown_pct: maxDrawdownPct,
    threshold: {
      max_vol_pct: ETF_SCREEN_MAX_VOL_PCT,
      max_drawdown_pct: ETF_SCREEN_MAX_DRAWDOWN_PCT,
      min_bars: ETF_SCREEN_MIN_RISK_BARS,
    },
  };

  // ---- 跟踪：只有声明了基准指数且该指数在 index_daily 中有足够重叠才计算
  const tracking = evaluateTracking(db, declaration, series, tables);
  if (tracking.state === 'unavailable') statusReasons.push(tracking.degrade_reason ?? 'tracking_unavailable');
  if (tracking.state === 'fail') statusReasons.push(tracking.reason ?? 'tracking_failed');

  const filters: EtfCandidateFilters = {
    liquidity: liquidityFilter,
    size: sizeFilter,
    premium_discount: premiumFilter,
    tracking,
    risk: riskFilter,
  };

  for (const [key, outcome] of Object.entries(filters) as [keyof EtfCandidateFilters, FilterOutcome][]) {
    if (outcome.state === 'fail' && outcome.reason) {
      exclusions.push({ filter: key, reason: outcome.reason, detail: outcome.detail });
    }
  }

  const data: EtfCandidateData = {
    bars_used: series.length,
    latest_bar_date: latest?.trade_date ?? null,
    latest_close_milli: latestCloseMilli,
    price_basis: priceBasis,
    adj_base: adjBase,
    adj_missing_bars: adjMissingBars,
    share: { fd_share_wan: fdShareWan, trade_date: shareRow?.trade_date ? String(shareRow.trade_date) : null },
    size_wan_cny: sizeWan,
    coverage: {
      fund_basic: !!(tables.fund_basic && basic),
      fund_daily: tables.fund_daily && bars.length > 0,
      fund_adj: !!(tables.fund_adj && adjBase),
      fund_share: !!(tables.fund_share && shareRow),
      latest_trade_date: latest?.trade_date ?? null,
    },
  };

  const { score, components } = scoreCandidate(filters, data);

  // 持仓永远入选；其余行只要有一个排除原因就不入选。
  const included = held || exclusions.length === 0;
  // 缺表/缺行/缺因子/缺份额一律 DEGRADED，并保留 status_reasons；只有全部来源齐全才是 OK。
  const status: CandidateStatus = exclusions.length === 0 && statusReasons.length === 0 ? 'OK' : 'DEGRADED';

  return {
    rank: 0,
    ts_code: code,
    category: declaration.category,
    category_label: ETF_CANDIDATE_CATEGORY_LABELS[declaration.category],
    name,
    name_source: nameSource,
    held,
    included,
    status,
    status_reasons: [...new Set(statusReasons)].sort(),
    as_of_trade_date: asOf,
    filters,
    data,
    exclusions,
    score,
    score_components: components,
    source: 'server_cache',
  };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return r4(value);
}

/** 最大回撤（%），负值。peaks 必须正序且都 > 0。 */
function drawdownPct(closes: number[]): number {
  let peak = closes[0];
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    const dd = close / peak - 1;
    if (dd < worst) worst = dd;
  }
  return r4(worst * 100);
}

function safeFundBaseFactor(db: DatabaseSync, code: string, asOf: string): { trade_date: string; adj_factor: number } | null {
  try {
    return fundBaseFactor(db, code, asOf);
  } catch {
    return null;
  }
}

function evaluateTracking(
  db: DatabaseSync | null | undefined,
  declaration: EtfCandidateDeclaration,
  series: { trade_date: string; close: number }[],
  tables: { index_daily: boolean },
): EtfCandidateFilters['tracking'] {
  const base = {
    benchmark_index_code: declaration.benchmark_index_code,
    tracking_error_pct: null as number | null,
    correlation: null as number | null,
    observations: 0,
    threshold: { max_tracking_error_pct: ETF_SCREEN_MAX_TRACKING_ERROR_PCT, min_correlation: ETF_SCREEN_MIN_CORRELATION },
  };
  if (!declaration.benchmark_index_code) {
    return { ...base, ...unavailable('benchmark_index_not_declared', '该候选未声明可比基准指数，跟踪误差不可计算') };
  }
  if (!db || !tables.index_daily) {
    return { ...base, ...unavailable('index_daily_table_missing', `缓存没有 index_daily 表，无法取得基准 ${declaration.benchmark_index_code}`) };
  }
  const indexRows = db.prepare(`
    SELECT trade_date, close FROM index_daily
    WHERE ts_code = ? AND close > 0 ORDER BY trade_date`).all(declaration.benchmark_index_code) as any[];
  if (indexRows.length < 3) {
    return { ...base, ...unavailable('benchmark_index_not_cached', `index_daily 中没有 ${declaration.benchmark_index_code} 的足够数据（n=${indexRows.length}）`) };
  }
  const indexByDate = new Map<string, number>(indexRows.map(row => [String(row.trade_date), Number(row.close)]));
  const paired: { etf: number; index: number }[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const prevEtf = series[i - 1];
    const curEtf = series[i];
    const prevIndex = indexByDate.get(prevEtf.trade_date);
    const curIndex = indexByDate.get(curEtf.trade_date);
    if (prevIndex === undefined || curIndex === undefined || prevIndex <= 0 || curIndex <= 0) continue;
    paired.push({ etf: curEtf.close / prevEtf.close - 1, index: curIndex / prevIndex - 1 });
  }
  if (paired.length < 3) {
    return { ...base, observations: paired.length, ...unavailable('benchmark_index_overlap_insufficient', `与基准的重叠交易日只有 ${paired.length} 个，无法计算跟踪误差`) };
  }
  const diffs = paired.map(pair => pair.etf - pair.index);
  const diffVol = stdev(diffs);
  const trackingErrorPct = diffVol === null ? null : r4(diffVol * Math.sqrt(ETF_SCREEN_TRADING_DAYS_PER_YEAR) * 100);
  const correlation = pearson(paired.map(pair => pair.etf), paired.map(pair => pair.index));
  const enriched = { ...base, tracking_error_pct: trackingErrorPct, correlation: correlation === null ? null : r4(correlation), observations: paired.length };
  if (trackingErrorPct !== null && trackingErrorPct > ETF_SCREEN_MAX_TRACKING_ERROR_PCT) {
    return { ...enriched, ...fail('tracking_error_above_max', `年化跟踪误差 ${trackingErrorPct}% 高于上限 ${ETF_SCREEN_MAX_TRACKING_ERROR_PCT}%`) };
  }
  if (correlation !== null && correlation < ETF_SCREEN_MIN_CORRELATION) {
    return { ...enriched, ...fail('correlation_below_min', `与基准相关系数 ${r4(correlation)} < 下限 ${ETF_SCREEN_MIN_CORRELATION}`) };
  }
  return {
    ...enriched,
    ...ok(`年化跟踪误差 ${trackingErrorPct}%、相关系数 ${correlation === null ? '不可用' : r4(correlation)}（${paired.length} 个重叠交易日）`),
  };
}

/**
 * 启发式打分（0–1，越高越靠前）。只用可得的分项；缺项不计权，并把权重按可得项归一化。
 * 这不是收益预测，也不是买入信号。
 */
function scoreCandidate(
  filters: EtfCandidateFilters, data: EtfCandidateData,
): { score: number | null; components: Record<string, number | null> } {
  const liquidity = filters.liquidity.median_amount_kcy === null
    ? null
    : clamp01(filters.liquidity.median_amount_kcy / (ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY * 20));
  const size = data.size_wan_cny === null
    ? null
    : clamp01(data.size_wan_cny / (ETF_SCREEN_MIN_SIZE_WAN_CNY * 5));
  const volComponent = filters.risk.realized_vol_pct === null
    ? null
    : clamp01(1 - filters.risk.realized_vol_pct / ETF_SCREEN_MAX_VOL_PCT);
  const ddComponent = filters.risk.max_drawdown_pct === null
    ? null
    : clamp01(1 - Math.abs(filters.risk.max_drawdown_pct) / Math.abs(ETF_SCREEN_MAX_DRAWDOWN_PCT));
  const risk = volComponent === null && ddComponent === null
    ? null
    : volComponent === null ? ddComponent
      : ddComponent === null ? volComponent
        : (volComponent + ddComponent) / 2;
  const tracking = filters.tracking.tracking_error_pct === null
    ? null
    : clamp01(1 - filters.tracking.tracking_error_pct / ETF_SCREEN_MAX_TRACKING_ERROR_PCT);
  const coverageKeys = ['fund_basic', 'fund_daily', 'fund_adj', 'fund_share'] as const;
  const coverage = coverageKeys.filter(key => data.coverage[key]).length / coverageKeys.length;

  const components: Record<string, number | null> = {
    liquidity: liquidity === null ? null : r6(liquidity),
    size: size === null ? null : r6(size),
    risk: risk === null ? null : r6(risk),
    tracking: tracking === null ? null : r6(tracking),
    coverage: r6(coverage),
  };
  const weighted = (Object.keys(ETF_SCREEN_SCORE_WEIGHTS) as (keyof typeof ETF_SCREEN_SCORE_WEIGHTS)[])
    .filter(key => components[key] !== null);
  const weightSum = weighted.reduce((sum, key) => sum + ETF_SCREEN_SCORE_WEIGHTS[key], 0);
  // 只有 coverage 一项可得时不算“可评估”：其余分项全缺 → 分数为 null，避免用 0 冒充评估结果。
  if (weightSum <= 0 || weighted.every(key => key === 'coverage')) return { score: null, components };
  const total = weighted.reduce((sum, key) => sum + ETF_SCREEN_SCORE_WEIGHTS[key] * (components[key] as number), 0);
  return { score: r6(total / weightSum), components };
}
