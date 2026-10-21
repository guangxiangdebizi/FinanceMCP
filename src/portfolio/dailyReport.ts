import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { valueCents, THEME_BY_CODE, type AccountSnapshot } from './account.js';
import { resolveAccountSnapshot } from './accounts.js';
import { ASSET_CLASSES, DEFAULT_ASSET_CLASS_STRESS, INDUSTRY_BY_CODE, classifyAssetClass, type AssetClass } from './decision.js';
import { calculateFees, resolveFeeRules, type FeeBreakdown } from './fees.js';
import { loadServerQuote } from './quotes.js';
import { resolveInstrument, normalizeSecurityCode } from './instrument.js';
import { buildResearchSummary } from './researchSummary.js';
import { evaluateAccountStatus, type AccountStatusEvaluation } from './decision.js';
import { DEFAULT_FEE_RULES, DEFAULT_LOT_RULES, type FeeRules, type LotRules } from './rules.js';
import { screenEtfCandidates, type EtfCandidateRow, type EtfCandidateScreenResult } from '../ashare/etfUniverse.js';
import { fundBaseFactor } from '../ashare/etf.js';
import { adjustmentRatio } from '../ashare/data.js';

/**
 * D1 收盘日报：先给“下一交易日最值得做的 0–3 个动作及理由”。
 *
 * 设计边界（PRD §9 / §10 / §13）：
 * - 所有事实（持仓、行情、市场环境、数据质量）都来自 `buildResearchSummary`，
 *   本模块**不重复实现**估值/取价/市场证据。
 * - 所有金额、费用与风险数字由程序计算；研究数量只接受显式参数，价格只取缓存。
 * - 研究情景与账户执行门控独立：即使资金与可卖性满足，未接入独立优势证据或
 *   用户已确认的持久风险策略时，也不生成交易动作；所有比较 executable:false。
 * - 没有证据支持的动作时返回 `NO_ACTION`，并给出明确的观察触发条件与失效条件。
 * - 研究性主张一律 `UNVERIFIED`；数据质量不足时不给“假装可执行的精确建议”。
 * - 只读：账户库与市场库都只读；历史预案跟踪读 `plan_tracking` 表（若存在），
 *   缺表时降级为 `not_available`，不写库、不补造历史。
 */

export const DAILY_REPORT_SCHEMA = 'ashare-daily-action-report/1.0';

export const DAILY_REPORT_DISCLAIMER =
  '收盘日报是研究材料，不是投资建议，也不是下单指令。所有买卖由用户最终决定并在券商手动执行。'
  + '价格只来自本地只读缓存的收盘价，不是下一交易日可成交价；费用与交易单位均为假设值。'
  + '研究性主张标记为 UNVERIFIED，未经前瞻检验。';

/** 历史预案跟踪表（本模块定义；只读消费，缺表即降级）。 */
export const PLAN_TRACKING_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_tracking (
  plan_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  as_of_trade_date TEXT NOT NULL,
  generated_at TEXT,
  status TEXT NOT NULL,
  action_code TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  legs_json TEXT NOT NULL DEFAULT '[]',
  observation_triggers_json TEXT NOT NULL DEFAULT '[]',
  invalidation_conditions_json TEXT NOT NULL DEFAULT '[]',
  expected_by TEXT,
  note TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_tracking_account_date
  ON plan_tracking (account_id, as_of_trade_date);
`;

export type DailyReportStatus = 'ACTIONABLE' | 'ILLUSTRATIVE' | 'NO_ACTION' | 'DATA_INSUFFICIENT';

export interface DailyReportInput {
  portfolioDb: DatabaseSync;
  /** 只读市场缓存；缺失时返回 DATA_INSUFFICIENT，不伪造行情。 */
  marketDb: DatabaseSync | null | undefined;
  accountId: string;
  /** accountId 是调用方显式给出，还是由本部署唯一真实账户推导（C1）。 */
  accountIdSource?: 'explicit' | 'default';
  /** 目标交易日 YYYYMMDD（收盘日报即该交易日）。 */
  asOfTradeDate: string;
  snapshotId?: string;
  /** 账户确认时间（用户确认当前账户的 ISO 时间）；缺省取快照记录。 */
  accountConfirmedAt?: string | null;
  /** 行情更新时间（ISO）；缺省取缓存同步日志，缺失时 null。 */
  quoteUpdatedAt?: string | null;
  /** 生成时间（ISO）；默认当前时间，仅展示，不进入报告哈希。 */
  generatedAt?: string | null;
  /** 候选池筛选类别；缺省全部。 */
  categories?: readonly string[];
  /** 动作上限（0–3），默认 3。 */
  maxActions?: number;
  /** 费用/交易单位假设；缺省 rules.ts 的默认值。 */
  fees?: FeeRules;
  lots?: LotRules;
  /** Explicit hypothetical quantities; never approval of a strategy or an order. */
  researchScenario?: { sellCode: string; sellQuantity: number; buyCode?: string; buyQuantity?: number };
}

export type ActionKind = 'REDUCE' | 'ROTATE';

export interface FactMeta {
  as_of: string | null;
  source: string;
  quality: 'OK' | 'DEGRADED' | 'MISSING';
  /** 研究性主张一律 UNVERIFIED；账户/行情事实为 FACT。 */
  claim_status: 'FACT' | 'UNVERIFIED';
  detail?: string;
}

export interface ActionLeg {
  side: 'SELL' | 'BUY';
  ts_code: string;
  name: string | null;
  quantity: number | null;
  lot_size: number;
  lots: number | null;
  price_milli: number | null;
  gross_cents: number | null;
  fees_cents: number | null;
  net_cents: number | null;
  quote_trade_date: string | null;
  /** 只有账户门控全满足时才可能为 true；否则恒为 false。 */
  executable: boolean;
  /** 不可执行原因码。 */
  reason: string | null;
}

export interface ActionPlan {
  code: string;
  kind: ActionKind;
  rank: number;
  title: string;
  /** 为什么做：来自 buildResearchSummary 的证据与持仓事实。 */
  reasons: string[];
  /** 反证 / 机会成本 / 风险。 */
  counter_evidence: string[];
  legs: ActionLeg[];
  /** 非可执行腿的示意块；与 legs 内容相同但显式标注 illustrative。 */
  illustrative: { executable: false; legs: ActionLeg[] } | null;
  fees_cents: number | null;
  fees_assumed: true;
  /** 条件化执行：触发条件 + 失效条件。 */
  triggers: string[];
  invalidation_conditions: string[];
  risk_impact: string[];
  fact_meta: FactMeta;
}

export interface HoldingAssessment {
  ts_code: string;
  name: string;
  quantity: number;
  weight: number;
  market_value_cents: number;
  price_milli: number;
  price_source: string;
  latest_bar_date: string | null;
  bar_quality: string;
  stance: 'HOLD' | 'REDUCE' | 'ROTATE' | 'WAIT';
  reasons: string[];
  counter_evidence: string[];
  /** 单只 ETF 的研究切片（D3）：当日行情、趋势/相对强弱/风险、条件与失效。 */
  research: HoldingResearch;
  fact_meta: FactMeta;
}

/**
 * 单只持仓的研究切片（任务书 D3）。所有数字都由本地只读缓存计算：
 * - 不使用宽泛行业中位收益替代 ETF 自身收益；
 * - 数据缺失时字段为 null 并在 `unavailable` 说明，而不是补 0 或沿用旧值。
 */
export interface HoldingResearch {
  /** 切片依据的行情日期与可用性；与 as_of 不同即过期。 */
  data: {
    bar_date: string | null;
    as_of_trade_date: string;
    fresh: boolean;
    /** 用于计算的 bar 根数（最多61；60个收益区间）。 */
    bars_used: number;
    price_basis: 'qfq_adjusted' | 'unavailable_adjustment';
  };
  /** 1. 当日行情。 */
  quote: {
    close_cny: number | null;
    pct_chg: number | null;
    amount_cny: number | null;
    vol_shares: number | null;
    /** 一手成本（100 份，分）。 */
    one_lot_cents: number | null;
  };
  /** 2. 趋势 / 相对强弱 / 波动与风险。 */
  trend: {
    ret5_pct: number | null;
    ret20_pct: number | null;
    ret60_pct: number | null;
    ma20_cny: number | null;
    ma60_cny: number | null;
    above_ma20: boolean | null;
    above_ma60: boolean | null;
    /** 相对沪深300（或可用宽基）的同窗口超额收益，单位百分点。 */
    excess_ret20_vs_broad_pct: number | null;
    /** 相对持有主题行业 20 日中位收益的差额，单位百分点（ETF 自身收益，不是行业中位）。 */
    excess_ret20_vs_theme_pct: number | null;
    realized_vol_60d_pct: number | null;
    max_drawdown_60d_pct: number | null;
    /** 最新 bar 距最近 20 日最低收盘的距离（%），用于观察触发。 */
    distance_to_20d_low_pct: number | null;
  };
  /** 3. 与相关行业/宽基的对比对象（真实代码与窗口，便于复核）。 */
  comparison: { kind: 'index' | 'sector' | 'benchmark'; reference: string; window_bars: number; as_of: string | null }[];
  /** 4. 投资逻辑与反证。 */
  investment_thesis: string[];
  counter_thesis: string[];
  /** 5. 持有 / 观察 / 减仓 / 轮动的研究条件（条件化，不是指令）。 */
  conditions: { stance: 'HOLD' | 'WATCH' | 'REDUCE' | 'ROTATE'; when: string[] }[];
  /** 6. 数据日期、可用性与失效条件。 */
  availability: { available: boolean; unavailable: string[]; invalid_if: string[] };
}

/**
 * 主动轮动与风险比较（任务书 D4）。
 *
 * 这不是收益预测，也不是下单计划：五个方案并列给出同一套可复核的数字
 * （资金来源、可卖数量、一手金额、费用、交易前后集中度、压力情景），
 * 并各自说明“为什么当前不可执行”。没有 RESEARCH_VERIFIED 证据时，
 * REDUCE / ROTATE / DEFENSIVE 一律只是研究比较，绝不自动生成卖出指令。
 */
export type RotationScenario = 'HOLD' | 'REDUCE' | 'ROTATE' | 'DEFENSIVE' | 'NO_ACTION';

export interface DecisionComparison {
  as_of_trade_date: string;
  /** 研究起点：集中度最高的持仓（不是“必须卖出的标的”）。 */
  focus: { ts_code: string; name: string | null; weight: number; market_value_cents: number; quantity: number } | null;
  cash: { before_cents: number; min_equity_lot_cents: number | null; sufficient_for_one_lot: boolean | null };
  concentration_before: { hhi: number | null; effective_positions: number | null; top_weight: number | null; equity_weight: number | null };
  /** 卖出资金的来源与可卖性（来自账本门控；缺失时为 null）。 */
  sellable: Record<string, { quantity: number; sellable_quantity: number; settlement_rule: string }>;
  options: {
    action: RotationScenario;
    label: string;
    summary: string;
    executable: false;
    not_actionable_because: string[];
    cash_after_cents: number | null;
    total_assets_after_cents: number | null;
    fees_cents: number;
    fee_breakdowns: { ts_code: string; side: 'BUY' | 'SELL'; breakdown: FeeBreakdown }[];
    quantity_basis: 'user_research_parameter' | 'no_trade' | 'equity_liquidation_stress_only' | 'not_provided';
    funding_status: 'NO_TRADE' | 'QUANTITY_REQUIRED' | 'INVALID_QUANTITY' | 'PRICE_UNAVAILABLE' | 'SELLABILITY_UNKNOWN' | 'NOT_SELLABLE' | 'INSUFFICIENT_CASH' | 'FUNDED';
    by_asset_class_after: { asset_class: AssetClass; market_value_cents: number; weight: number }[];
    theme_exposure_after: { key: string; market_value_cents: number; weight: number }[];
    industry_exposure_after: { key: string; market_value_cents: number; weight: number }[];
    concentration_after: { hhi: number | null; effective_positions: number | null };
    exposure_after: { equity_weight: number | null };
    stress_after: { equity_shock_pct: number; loss_cents: number | null; note: string } | null;
    opportunity_cost: string;
    sell_plan: {
      ts_code: string; quantity: number; sellable_quantity: number; settlement_rule: string;
      one_lot_cents: number; gross_cents: number; fees_cents: number; net_cents: number; cash_after_cents: number;
    } | null;
    rotation_plan: {
      buy_code: string; buy_name: string | null; category: string; price_milli: number | null;
      one_lot_cents: number | null; cash_sufficient_for_one_lot: boolean | null;
      quantity: number | null; fees_cents: number | null;
      spend_cents: number | null; cash_after_cents: number | null; advantage_status: 'UNVERIFIED';
    } | null;
    invalidation_conditions: string[];
    fact_meta: FactMeta;
  }[];
  note: string;
}

export interface CandidateCashCompetition {
  available: boolean;
  cash_cents: number | null;
  /** 一手候选所需金额（分）与现金比较；只在候选有价时计算。 */
  entries: {
    ts_code: string;
    name: string | null;
    category: string;
    status: string;
    score: number | null;
    price_milli: number | null;
    one_lot_cents: number | null;
    one_lot_total_cents: number | null;
    fees_cents: number | null;
    cash_sufficient_for_one_lot: boolean | null;
    note: string;
    /** 每个候选事实都带 as_of / 来源 / 质量状态。 */
    fact_meta: FactMeta;
  }[];
  screening: EtfCandidateScreenResult | null;
  note: string;
}

export interface PlanTrackingEntry {
  plan_id: string;
  as_of_trade_date: string;
  status: string;
  action_code: string;
  action_summary: string;
  expected_by: string | null;
  outcome: 'unknown' | 'triggered' | 'invalidated' | 'not_applicable';
  outcome_basis: string;
}

export interface PlanTracking {
  available: boolean;
  reason: string | null;
  entries: PlanTrackingEntry[];
  note: string;
}

export interface DailyReportResult {
  schema: typeof DAILY_REPORT_SCHEMA;
  report_id: string;
  status: DailyReportStatus;
  actionable: boolean;
  /** 报告第一节，永远是这一项。 */
  first_section: {
    heading: '下一交易日最值得做的 0-3 个动作及理由';
    count: number;
    actions: ActionPlan[];
    no_action_reason: string | null;
    observation_triggers: string[];
  };
  as_of_trade_date: string;
  expected_next_trade_date: string | null;
  /** 各时间戳：日报目标日、账户确认、行情更新、生成时间。 */
  timestamps: {
    as_of_trade_date: string;
    account_confirmed_at: string | null;
    quote_updated_at: string | null;
    generated_at: string | null;
  };
  account_status: string;
  /** 本次日报实际使用的账户标识，以及它来自显式参数还是默认解析（C1）。 */
  account_id: string;
  account_id_source: 'explicit' | 'default';
  /** 账户口径对照：快照参考价 vs 当日收盘重估（C4）。 */
  account_view: ReturnType<typeof buildAccountView>;
  /** 主动轮动与风险比较：五个方案并列，全部不可执行（D4）。 */
  decision_comparison: DecisionComparison;
  data_quality: {
    status: 'OK' | 'DEGRADED' | 'INSUFFICIENT';
    summary_status: string;
    missing_fields: string[];
    quotes: { ready: string[]; stale: string[]; not_ready: string[]; missing: string[] };
    market_report: { available: boolean; report_id: string | null; as_of_trade_date: string | null; freshness: string };
    screening: { status: string; missing_tables: string[] };
    /** 市场 / ETF 价格 / ETF 份额与复权 / 账户身份 / 交易完整性 / 研究证据 / 可执行性。 */
    tiers: {
      market_data: { status: string; as_of: string | null; detail: string };
      etf_price: { status: string; ready: string[]; not_ready: string[]; detail: string };
      etf_share_adjustment: { status: string; detail: string };
      account_identity: { status: string; verified: boolean; detail: string };
      account_trade_completeness: { status: string; detail: string };
      research_evidence: { status: string; detail: string };
      trade_plan_executability: { status: string; detail: string };
    };
    notes: string[];
  };
  market_judgement: {
    available: boolean;
    regime: string | null;
    regime_label: string | null;
    tone: string | null;
    judgement: string[];
    counter_evidence: { id: string; statement: string; as_of: string; source: string }[];
    support_evidence: { id: string; statement: string; as_of: string; source: string }[];
    research_status: 'UNVERIFIED';
    fact_meta: FactMeta;
  };
  holdings: HoldingAssessment[];
  candidate_vs_cash: CandidateCashCompetition;
  concentration: {
    hhi: number | null;
    effective_positions: number | null;
    top_position: { ts_code: string; name: string; weight: number } | null;
    equity_weight: number | null;
    cash_ratio: number | null;
    disclosure: string[];
  };
  drawdown: {
    available: false;
    reason: 'no_history';
    disclosure: string;
  };
  plan_tracking: PlanTracking;
  gate: {
    satisfied: boolean;
    is_current: boolean;
    account_status: string;
    /** 与 decision.ts 同源：same_day_snapshot / ledger_reconstruction / none。 */
    state_basis: 'same_day_snapshot' | 'ledger_reconstruction' | 'none';
    snapshot_as_of: string | null;
    reported_events_through: string | null;
    last_user_reconciled_at: string | null;
    unreported_trade_risk: boolean;
    reasons: { code: string; detail: string }[];
    warnings: { code: string; detail: string }[];
    note: string;
  };
  fact_register: { id: string; value: string | number | boolean | null; as_of: string | null; source: string; quality: string; claim_status: 'FACT' | 'UNVERIFIED' }[];
  assumptions: {
    fees: { assumed: true; values: FeeRules };
    lots: { assumed: true; values: LotRules };
    note: string;
  };
  not_covered: string[];
  disclaimer: string;
}

// ---------------------------------------------------------------- 小工具

const YMD = /^\d{8}$/;
const r2 = (value: number): number => Math.round(value * 100) / 100;
const r6 = (value: number): number => Math.round(value * 1000000) / 1000000;

function tableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

/** 下一交易日：交易日历里严格大于 asOf 的第一个开市日；日历缺失为 null。 */
function nextTradeDay(marketDb: DatabaseSync | null | undefined, asOf: string): string | null {
  if (!marketDb || !tableExists(marketDb, 'trade_cal')) return null;
  try {
    const row = marketDb.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date > ? ORDER BY cal_date LIMIT 1').get(asOf) as any;
    return row?.cal_date ?? null;
  } catch {
    return null;
  }
}

/** 行情缓存最近一次 fund_daily 同步时间；缺失为 null。 */
function quoteUpdatedAt(marketDb: DatabaseSync | null | undefined): string | null {
  if (!marketDb || !tableExists(marketDb, 'fund_sync_log')) return null;
  try {
    const row = marketDb.prepare("SELECT MAX(synced_at) AS t FROM fund_sync_log WHERE dataset = 'fund_daily'").get() as any;
    return row?.t ? String(row.t) : null;
  } catch {
    return null;
  }
}

/** 单个 ETF 的一手成本（分）；价格来自 researchSummary 的持仓/候选事实。 */
function oneLotCents(priceMilli: number | null, lotSize: number): number | null {
  return priceMilli === null ? null : valueCents(lotSize, priceMilli);
}

// ---------------------------------------------------------------- 单只持仓研究（D3）

const RESEARCH_WINDOW_BARS = 61; // 60 returns require 61 price observations.
const BROAD_INDEX_CODES = ['000300.SH', '000905.SH', '000852.SH', '000001.SH'];

function pctChange(from: number, to: number): number | null {
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return r2((to / from - 1) * 100);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function maxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return r2(worst * 100);
}

/**
 * 单只 ETF 的研究切片。价格口径与候选筛选一致：有复权因子时用 qfq（基准 = as_of
 * 之前最后一个因子），缺因子时显式退化为原始收盘并标注。
 *
 * 关键约束（D3）：不使用宽泛行业中位收益替代 ETF 自身收益。相对强弱分两部分：
 * 1) ETF 自身 20 日收益 vs 宽基指数 20 日收益；
 * 2) ETF 自身 20 日收益 vs 其主题行业 20 日中位收益（行业数字只作为对照，不是 ETF 的收益）。
 */
function buildHoldingResearch(
  marketDb: DatabaseSync | null | undefined,
  holding: any,
  asOf: string,
  market: any,
  lots: LotRules,
): HoldingResearch {
  const code = String(holding.ts_code);
  const unavailable: string[] = [];
  const empty: HoldingResearch = {
    data: { bar_date: holding.latest_bar_date ?? null, as_of_trade_date: asOf, fresh: false, bars_used: 0, price_basis: 'unavailable_adjustment' },
    quote: { close_cny: null, pct_chg: null, amount_cny: null, vol_shares: null, one_lot_cents: null },
    trend: {
      ret5_pct: null, ret20_pct: null, ret60_pct: null, ma20_cny: null, ma60_cny: null,
      above_ma20: null, above_ma60: null, excess_ret20_vs_broad_pct: null, excess_ret20_vs_theme_pct: null,
      realized_vol_60d_pct: null, max_drawdown_60d_pct: null, distance_to_20d_low_pct: null,
    },
    comparison: [],
    investment_thesis: [],
    counter_thesis: [],
    conditions: [],
    availability: { available: false, unavailable, invalid_if: [] },
  };
  if (!marketDb) {
    unavailable.push('市场缓存不可用');
    return empty;
  }
  let bars: any[];
  try {
    bars = marketDb.prepare(`
      SELECT trade_date, open, high, low, close, pct_chg, vol, amount
      FROM fund_daily WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT ?`)
      .all(code, asOf, RESEARCH_WINDOW_BARS) as any[];
  } catch {
    unavailable.push('fund_daily 不可读');
    return empty;
  }
  bars.reverse();
  if (!bars.length) {
    unavailable.push('窗口内没有基金日线');
    return empty;
  }
  const validOhlc = (bar: any) => [bar.open, bar.high, bar.low, bar.close].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high);
  const base = safeFundBaseFactor(marketDb, code, asOf);
  const factors = new Map<string, number>();
  if (base) for (const row of marketDb.prepare('SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0')
    .all(code, asOf) as any[]) factors.set(String(row.trade_date), Number(row.adj_factor));
  // Preserve every observation and its date. Missing factors/OHLC invalidate a
  // window; dropping rows would silently change its holding period.
  const priced = bars.map(bar => {
    const factor = factors.get(String(bar.trade_date));
    const valid = validOhlc(bar);
    if (!valid) unavailable.push(`OHLC异常:${bar.trade_date}`);
    if (!base || !factor || !Number.isFinite(factor)) unavailable.push(`复权因子缺失:${bar.trade_date}`);
    const ratio = base && factor && Number.isFinite(factor) ? adjustmentRatio('qfq', factor, base.adj_factor) : Number.NaN;
    return { ...bar, price: valid && Number.isFinite(ratio) && ratio > 0 ? bar.close * ratio : null };
  });
  const closes = priced.map(bar => bar.price ?? Number.NaN);
  const last = priced.at(-1)!;
  const lastBar = bars.at(-1)!;
  const expectedDates = tableExists(marketDb, 'trade_cal')
    ? (marketDb.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date<=? ORDER BY cal_date DESC LIMIT 61').all(asOf) as any[])
      .reverse().map(row => String(row.cal_date)) : [];
  const window = (n: number): number[] | null => {
    const values = closes.slice(-n);
    const actualDates = priced.slice(-n).map(bar => String(bar.trade_date));
    const dates = expectedDates.slice(-n);
    return values.length === n && values.every(Number.isFinite) && dates.length === n
      && actualDates.every((date, i) => date === dates[i]) ? values : null;
  };
  if (priced.length && expectedDates.length && priced.slice(-expectedDates.length).some((bar, i, rows) =>
    String(bar.trade_date) !== expectedDates.slice(-rows.length)[i])) unavailable.push('交易日日线缺口：不得压缩收益窗口');
  const retOver = (n: number): number | null => { const values = window(n + 1); return values ? pctChange(values[0], values.at(-1)!) : null; };
  const ma = (n: number): number | null => { const values = window(n); return values ? mean(values) : null; };
  const ma20 = ma(20);
  const ma60 = ma(60);
  const riskWindow = window(61);
  const returns = riskWindow ? riskWindow.slice(1).map((price, index) => price / riskWindow[index] - 1) : [];
  const lowWindow = window(20);
  const low20 = lowWindow ? Math.min(...lowWindow) : null;

  // 对照：真实的宽基指数与主题行业；只用缓存里确实存在的数据。
  const comparison: HoldingResearch['comparison'] = [];
  let broadRet20: number | null = null;
  let broadName: string | null = null;
  for (const indexCode of BROAD_INDEX_CODES) {
    try {
      const rows = (marketDb.prepare('SELECT trade_date, close FROM index_daily WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 21')
        .all(indexCode, asOf) as any[]).reverse();
      const own = priced.slice(-21);
      if (rows.length !== 21 || own.length !== 21 || !rows.every((row, i) => row.trade_date === own[i].trade_date
        && typeof row.close === 'number' && Number.isFinite(row.close) && row.close > 0)
        || own.at(-1)?.trade_date !== asOf) continue;
      broadRet20 = pctChange(rows[0].close, rows.at(-1)!.close);
      broadName = indexCode;
      comparison.push({ kind: 'index', reference: indexCode, window_bars: 20, as_of: rows.at(-1)!.trade_date });
      break;
    } catch { /* Missing index cache remains explicitly unavailable. */ }
  }
  if (broadRet20 === null) unavailable.push('index_daily 缺少与ETF窗口日期一致的宽基指数窗口，无法计算相对宽基强弱');

  const themeIndustry = holding.industry && holding.industry !== 'unclassified' ? String(holding.industry) : null;
  const sector = themeIndustry && market?.sectors?.all
    ? market.sectors.all.find((row: any) => row.industry === themeIndustry) ?? null
    : null;
  if (sector) comparison.push({ kind: 'sector', reference: String(sector.industry), window_bars: 20, as_of: market?.as_of_trade_date ?? null });
  else if (themeIndustry) unavailable.push('市场日报缺少该持仓行业的中位收益，无法做行业对照');

  const ret20 = retOver(20);
  const excessBroad = ret20 != null && broadRet20 != null ? r2(ret20 - broadRet20) : null;
  const excessTheme = ret20 != null && sector && market?.as_of_trade_date === lastBar.trade_date && typeof sector.ret20_median_pct === 'number'
    ? r2(ret20 - sector.ret20_median_pct) : null;

  const priceBasis: HoldingResearch['data']['price_basis'] = base ? 'qfq_adjusted' : 'unavailable_adjustment';
  if (!base) unavailable.push('缺少 fund_adj 因子，复权收益不可用，不回退混合原始收盘');
  if (closes.length < 61) unavailable.push(`可比收益序列只有 ${closes.length} 根（60日收益和风险需要61根）`);

  const closeCny = validOhlc(lastBar) ? lastBar.close : null;
  const oneLot = closeCny === null ? null : valueCents(lots.etf_lot_size, Math.round(closeCny * 1000));
  const fresh = holding.bar_quality === 'READY';
  if (!fresh) unavailable.push(`行情质量 ${holding.bar_quality}：目标交易日收盘行情不可用`);

  const themeLabel = holding.theme_label ?? holding.theme;
  const investmentThesis = [
    `持仓 ${holding.name ?? code}（${themeLabel}）当前权重 ${(holding.weight * 100).toFixed(2)}%`,
    ...(excessBroad != null
      ? [`ETF 自身 20 日收益 ${ret20?.toFixed(2)}%，相对 ${broadName} ${excessBroad >= 0 ? '高' : '低'} ${Math.abs(excessBroad).toFixed(2)} 个百分点`]
      : []),
    ...(excessTheme != null
      ? [`ETF 自身 20 日收益相对其行业（${themeIndustry}）中位收益 ${excessTheme >= 0 ? '高' : '低'} ${Math.abs(excessTheme).toFixed(2)} 个百分点`]
      : []),
    ...(ma20 != null && last.price != null ? [`收盘 ${ma20 === null ? '' : last.price >= ma20 ? '站上' : '低于'} 20 日均价`] : []),
  ];
  const counterThesis = [
    '20 日相对强弱只描述过去，不预测未来；ETF 收益不能由行业中位收益代替。',
    ...(excessBroad != null && excessBroad < 0 ? ['ETF 自身 20 日收益弱于宽基：持有它的机会成本仍在。'] : []),
    ...(ma60 != null && last.price != null && last.price < ma60 ? ['收盘低于 60 日均价：中期趋势尚未修复。'] : []),
    '没有 RESEARCH_VERIFIED 级别的轮动证据，任何减仓/轮动都只是研究比较。',
  ];

  const conditions: HoldingResearch['conditions'] = [
    {
      stance: 'HOLD',
      when: fresh && excessBroad != null && excessBroad >= 0
        ? ['行情 READY 且 20 日相对宽基不落后时，继续持有；每次收盘后按同一口径复核。']
        : ['在行情 READY 之前不改变研究结论：当前数据不足以证明继续持有或卖出更优。'],
    },
    {
      stance: 'WATCH',
      when: [
        `收盘跌破最近 20 日最低收盘（${low20 === null ? '不可用' : low20.toFixed(4)} 元）后，重新评估。`,
        ...(ma20 === null ? [] : [`收盘持续低于 20 日均价（${ma20.toFixed(4)} 元）且相对宽基继续走弱。`]),
      ],
    },
    {
      stance: 'REDUCE',
      when: [
        '集中度风险 + 自身趋势转弱 + 存在同类别中数据更优的候选，三者同时成立时研究减仓。',
        '不设置机械的固定仓位阈值；减仓数量必须经过账户门控与可卖数量核对。',
      ],
    },
    {
      stance: 'ROTATE',
      when: [
        '只有当候选具备同日可校验行情、可比的自身收益/风险指标，且存在可追溯的 RESEARCH_VERIFIED 证据时，才研究轮动。',
        '轮动需要同时核对卖出资金来源、费用、一手金额和换仓后的集中度。',
      ],
    },
  ];

  const invalidIf = [
    `数据失效：${asOf} 之后出现新的交易日而本切片未更新。`,
    '复权因子发生变化（拆分/份额折算）：复权前后收益不可直接比较，必须重算。',
    '持仓数量或账户现金发生变化：集中度与可执行数量需要重新计算。',
    '行情被更正（上游修订）：本切片的收益与均线全部失效。',
  ];

  return {
    data: { bar_date: lastBar.trade_date ? String(lastBar.trade_date) : null, as_of_trade_date: asOf, fresh, bars_used: closes.length, price_basis: priceBasis },
    quote: {
      close_cny: closeCny,
      pct_chg: typeof lastBar.pct_chg === 'number' ? lastBar.pct_chg : null,
      amount_cny: typeof lastBar.amount === 'number' ? Math.round(lastBar.amount * 1000 * 100) / 100 : null,
      vol_shares: typeof lastBar.vol === 'number' ? Math.round(lastBar.vol * 100 * 100) / 100 : null,
      one_lot_cents: oneLot,
    },
    trend: {
      ret5_pct: retOver(5),
      ret20_pct: ret20,
      ret60_pct: retOver(60),
      ma20_cny: ma20 === null ? null : r2(ma20 * 1000) / 1000,
      ma60_cny: ma60 === null ? null : r2(ma60 * 1000) / 1000,
      above_ma20: ma20 === null || last.price === null ? null : last.price >= ma20,
      above_ma60: ma60 === null || last.price === null ? null : last.price >= ma60,
      excess_ret20_vs_broad_pct: excessBroad,
      excess_ret20_vs_theme_pct: excessTheme,
      realized_vol_60d_pct: returns.length === 60 ? r2(stdev(returns)! * Math.sqrt(252) * 100) : null,
      max_drawdown_60d_pct: riskWindow ? maxDrawdown(riskWindow) : null,
      distance_to_20d_low_pct: low20 && last.price ? r2((last.price / low20 - 1) * 100) : null,
    },
    comparison,
    investment_thesis: investmentThesis,
    counter_thesis: counterThesis,
    conditions,
    availability: { available: unavailable.length === 0, unavailable: [...new Set(unavailable)], invalid_if: invalidIf },
  };
}

/** 与 etf.ts 的 qfq 基准同源：asOf 之前最后一个正因子；表缺失时返回 null。 */
function safeFundBaseFactor(db: DatabaseSync, code: string, asOf: string): { trade_date: string; adj_factor: number } | null {
  try {
    return fundBaseFactor(db, code, asOf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 数据质量分层

/**
 * 独立披露的数据质量维度（任务书 D1）。市场 READY 不代表 ETF READY；
 * 账户 VERIFIED 不代表当天成交已确认；候选分数高不代表存在已验证的换仓优势。
 */
function buildQualityTiers(
  summary: any, screening: EtfCandidateScreenResult | null, gateSatisfied: boolean,
  accountStatus: string, gateReasons: { code: string }[], holdingsCount: number,
  accountEvaluation: AccountStatusEvaluation | null,
): {
  market_data: { status: string; as_of: string | null; detail: string };
  etf_price: { status: string; ready: string[]; not_ready: string[]; detail: string };
  etf_share_adjustment: { status: string; detail: string };
  account_identity: { status: string; verified: boolean; detail: string };
  account_trade_completeness: { status: string; detail: string };
  research_evidence: { status: string; detail: string };
  trade_plan_executability: { status: string; detail: string };
} {
  const marketReport = summary?.data_quality?.market_report ?? {};
  const quotes = summary?.data_quality?.quotes ?? {};
  const ready: string[] = quotes.ready ?? [];
  const notReady: string[] = [...(quotes.stale ?? []), ...(quotes.not_ready ?? []), ...(quotes.missing ?? [])];
  const shareReasons: string[] = (summary?.holdings ?? []).flatMap((holding: any) => (holding.bar_reasons ?? [])
    .filter((reason: string) => /share_|adj_factor/.test(String(reason))));
  if (screening?.data_coverage.status !== 'READY') shareReasons.push('候选筛选的份额或复权覆盖未全部READY');
  return {
    market_data: {
      status: marketReport.available ? (marketReport.freshness === 'same_day' ? 'READY' : 'STALE') : 'MISSING',
      as_of: marketReport.as_of_trade_date ?? null,
      detail: marketReport.available
        ? `A 股市场日报 ${marketReport.report_id}（${marketReport.as_of_trade_date}，${marketReport.freshness}）`
        : '没有可用的市场日报',
    },
    etf_price: {
      status: notReady.length === 0 && ready.length > 0 ? 'READY' : ready.length > 0 ? 'PARTIAL' : 'NOT_READY',
      ready,
      not_ready: [...new Set(notReady)],
      detail: `逐只 ETF 收盘行情：READY ${ready.length}/${holdingsCount}，其余 ${[...new Set(notReady)].join('、') || '无'}`,
    },
    etf_share_adjustment: {
      status: shareReasons.length === 0 ? 'OK' : 'DEGRADED',
      detail: shareReasons.length === 0
        ? '缓存未报告份额或复权缺口；逐只研究窗口仍需分别检查，份额不用于持仓估值'
        : `复权/份额存在缺口：${[...new Set(shareReasons)].join('; ')}`,
    },
    account_identity: {
      status: accountStatus,
      verified: accountStatus === 'REAL_ACCOUNT_VERIFIED',
      detail: accountStatus === 'REAL_ACCOUNT_VERIFIED'
        ? '账户身份已由用户确认为真实账户'
        : '账户身份未确认，账户数字只能作为研究数据',
    },
    account_trade_completeness: {
      status: accountEvaluation?.ok && !accountEvaluation.unreported_trade_risk ? 'CONFIRMED_THROUGH_TARGET_DATE' : 'UNCONFIRMED_RISK',
      detail: accountEvaluation?.ok && !accountEvaluation.unreported_trade_risk
        ? '完整性声明覆盖目标交易日且账本门控通过'
        : `账户完整性或账本门控未满足：${gateReasons.map(reason => reason.code).join('、') || '未知'}`,
    },
    research_evidence: {
      status: 'UNVERIFIED',
      detail: '没有经过前瞻检验的 RESEARCH_VERIFIED 证据；候选分数是启发式排序，不是换仓优势',
    },
    trade_plan_executability: {
      status: 'NOT_EXECUTABLE',
      detail: '本日报没有独立复核的优势证据或用户已确认的风险策略约束；账户与行情就绪仅是前提，研究情景始终不可执行。',
    },
  };
}

// ---------------------------------------------------------------- 主动轮动比较（D4）

/**
 * 五个方案的资金/风险测算。每个数字都可从当日缓存与快照独立复算：
 * - 卖出：可卖数量来自账本门控（T+1 由 replayAccount 决定），费用用 rules.ts 的假设值；
 * - 轮动：候选来自同一套 ETF 候选筛选，一手金额 = 100 × 收盘价；
 * - 集中度：HHI = Σ(持仓市值 / 总资产)²，交易后按“卖出所得现金 + 买入支出”重算；
 * - 压力：全部权益仓位施加声明式冲击（默认 −10%），不是历史回撤。
 *
 * 所有方案恒为 `executable: false`：本模块没有经过验证的轮换优势，也不替用户下单。
 */
function buildDecisionComparison(input: {
  asOf: string; holdings: HoldingAssessment[]; summary: any;
  accountView: ReturnType<typeof buildAccountView>; accountEvaluation: AccountStatusEvaluation | null;
  screening: EtfCandidateScreenResult | null; fees: FeeRules; lots: LotRules;
  gateReasons: { code: string; detail: string }[]; gateSatisfied: boolean;
  portfolioDb: DatabaseSync; marketDb: DatabaseSync | null | undefined; accountId: string;
  feeOverride?: FeeRules; scenario?: DailyReportInput['researchScenario'];
}): DecisionComparison {
  const { asOf, holdings, summary, accountView, accountEvaluation, lots, scenario } = input;
  type Option = DecisionComparison['options'][number];
  type Position = { ts_code: string; value: number; asset_class: AssetClass; theme: string; industry: string };
  const cash = accountView.revalued_basis.cash_cents;
  const wealth = summary.portfolio?.wealth_cents ?? 0;
  const facts = new Map<string, any>((summary.holdings ?? []).map((row: any) => [row.ts_code, row]));
  const positions: Position[] = holdings.map(h => ({
    ts_code: h.ts_code, value: h.market_value_cents,
    asset_class: facts.get(h.ts_code)?.asset_class ?? 'UNKNOWN',
    theme: facts.get(h.ts_code)?.theme ?? 'unknown', industry: facts.get(h.ts_code)?.industry ?? 'unclassified',
  }));
  const feeFor = (code: string, gross: number, side: 'buy' | 'sell') => {
    const kind = input.marketDb && resolveInstrument(input.marketDb, code).kind === 'STOCK' ? 'STOCK' : 'ETF';
    return calculateFees(gross, side, input.feeOverride ?? resolveFeeRules({
      db: input.portfolioDb, accountId: input.accountId, code, kind, asOf,
    }));
  };
  const metrics = (rows: Position[], nextCash: number) => {
    const total = rows.reduce((sum, p) => sum + p.value, 0) + nextCash + wealth;
    const hhi = total > 0 ? r6(rows.reduce((sum, p) => sum + (p.value / total) ** 2, 0)) : null;
    const byClass = ASSET_CLASSES.map(asset_class => {
      const value = rows.filter(p => p.asset_class === asset_class).reduce((sum, p) => sum + p.value, 0);
      return { asset_class, market_value_cents: value, weight: total > 0 ? r6(value / total) : 0 };
    });
    const exposure = (key: 'theme' | 'industry') => {
      const groups = new Map<string, number>();
      for (const p of rows) groups.set(p[key], (groups.get(p[key]) ?? 0) + p.value);
      return [...groups].map(([key, value]) => ({ key, market_value_cents: value, weight: total > 0 ? r6(value / total) : 0 }));
    };
    return {
      cash_after_cents: nextCash, total_assets_after_cents: total,
      concentration_after: { hhi, effective_positions: hhi && hhi > 0 ? r6(1 / hhi) : null },
      exposure_after: { equity_weight: byClass.find(row => row.asset_class === 'EQUITY')!.weight },
      by_asset_class_after: byClass, theme_exposure_after: exposure('theme'), industry_exposure_after: exposure('industry'),
      stress_after: {
        equity_shock_pct: DEFAULT_ASSET_CLASS_STRESS.shocks.EQUITY,
        loss_cents: rows.reduce((sum, p) => sum + Math.round(p.value * DEFAULT_ASSET_CLASS_STRESS.shocks[p.asset_class]), 0),
        note: `按资产类别施加声明式压力（${DEFAULT_ASSET_CLASS_STRESS.version}）：权益-10%、债券-1%、黄金-5%、跨境-12%、未知-10%；现金与理财不计冲击，非预测或历史回撤。`,
      },
    };
  };
  const baseline = metrics(positions, cash);
  const focus = holdings.length ? holdings.reduce((best, h) => h.weight > best.weight ? h : best) : null;
  const sellable: DecisionComparison['sellable'] = {};
  for (const [code, row] of Object.entries(accountEvaluation?.sellable ?? {})) sellable[code] = { ...row };
  const noExecution = [
    ...input.gateReasons.map(reason => `${reason.code}: ${reason.detail}`),
    '相对优势 UNVERIFIED；本次研究数量不是用户确认的策略约束或交易授权。',
  ];
  const option = (action: RotationScenario, label: string, text: string): Option => ({
    action, label, summary: text, executable: false, not_actionable_because: [...noExecution],
    ...baseline, fees_cents: 0, fee_breakdowns: [], quantity_basis: 'no_trade', funding_status: 'NO_TRADE',
    opportunity_cost: '保留当前暴露会承担下行风险；卖出或换仓可能放弃后续上涨，并产生费用。',
    sell_plan: null, rotation_plan: null,
    invalidation_conditions: ['持仓、现金、费用模型、行情或可卖数量变化后重算；出现独立复核的相对优势证据后重新研究。'],
    fact_meta: { as_of: asOf, source: 'research_summary + server_cache + portfolio_fee_model', quality: 'OK', claim_status: 'UNVERIFIED' },
  });
  const hold = option('HOLD', '继续持有，不交易', '保留现有持仓和现金；不把集中度或启发式分数当作卖出理由。');
  const reduce = option('REDUCE', '显式数量减仓研究', '需要用户提供研究标的和数量；不按固定50%阈值生成卖量。');
  const rotate = option('ROTATE', '显式数量轮动研究', '需要用户提供卖出、买入标的和整手数量；没有优势证据时不产生动作。');
  const defensive = option('DEFENSIVE', '权益清零压力对照', '仅作权益清零压力对照，保留债券、黄金和跨境资产；受可卖数量与费用约束。');
  const noAction = option('NO_ACTION', '没有充分证据时不操作', '缺少经过复核的相对优势证据或用户已确认的风险策略约束，明确不操作。');
  reduce.quantity_basis = rotate.quantity_basis = scenario ? 'user_research_parameter' : 'not_provided';
  reduce.funding_status = rotate.funding_status = 'QUANTITY_REQUIRED';
  const reject = (target: Option, status: Option['funding_status'], detail: string) => {
    target.funding_status = status;
    target.summary = detail;
    target.not_actionable_because.push(detail);
    target.fact_meta.quality = 'DEGRADED';
  };
  let soldRows: Position[] | null = null;
  if (scenario) {
    const code = normalizeSecurityCode(scenario.sellCode);
    const holding = holdings.find(h => h.ts_code === code);
    const quantity = scenario.sellQuantity;
    const availability = sellable[code];
    if (!holding || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity % lots.etf_sell_multiple !== 0 || quantity > holding.quantity) {
      reject(reduce, 'INVALID_QUANTITY', '研究卖量必须是持仓以内的正整数整手，不自动截断或补足。');
    } else if (!availability) {
      reject(reduce, 'SELLABILITY_UNKNOWN', '账本未提供可卖数量，不能假设全部持仓可卖。');
    } else if (quantity > availability.sellable_quantity) {
      reject(reduce, 'NOT_SELLABLE', `研究卖量超过截至${asOf}的可卖数量${availability.sellable_quantity}。`);
    } else if (holding.bar_quality !== 'READY' || holding.latest_bar_date !== asOf || holding.price_source !== 'server_cache_close') {
      reject(reduce, 'PRICE_UNAVAILABLE', '卖出标的缺少目标交易日可校验行情。');
    } else {
      const gross = valueCents(quantity, holding.price_milli);
      const fee = feeFor(code, gross, 'sell');
      const nextCash = cash + gross - fee.total_cents;
      if (nextCash < 0) reject(reduce, 'INSUFFICIENT_CASH', '卖出后现金不足支付费用。');
      else {
        soldRows = positions.map(p => p.ts_code === code ? { ...p, value: valueCents(holding.quantity - quantity, holding.price_milli) } : { ...p });
        Object.assign(reduce, metrics(soldRows, nextCash));
        reduce.funding_status = 'FUNDED'; reduce.fees_cents = fee.total_cents;
        reduce.fee_breakdowns = [{ ts_code: code, side: 'SELL', breakdown: fee }];
        reduce.sell_plan = { ts_code: code, quantity, sellable_quantity: availability.sellable_quantity,
          settlement_rule: availability.settlement_rule, one_lot_cents: valueCents(lots.etf_lot_size, holding.price_milli),
          gross_cents: gross, fees_cents: fee.total_cents, net_cents: gross - fee.total_cents, cash_after_cents: nextCash };
        reduce.summary = `研究卖出${quantity}份${code}，费用及滑点估计${fee.total_cents}分，现金${nextCash}分；仅示意。`;
      }
    }
    if (!soldRows) reject(rotate, reduce.funding_status, reduce.summary);
    else if (scenario.buyCode) {
      const buyCode = normalizeSecurityCode(scenario.buyCode);
      const resolved = input.marketDb ? resolveInstrument(input.marketDb, buyCode) : null;
      const quote = input.marketDb && resolved?.kind === 'ETF' ? loadServerQuote(input.marketDb, buyCode, asOf, 'ETF') : null;
      const quantity = scenario.buyQuantity ?? lots.etf_lot_size;
      if (!Number.isSafeInteger(quantity) || quantity < lots.etf_min_buy || quantity % lots.etf_lot_size !== 0) {
        reject(rotate, 'INVALID_QUANTITY', '研究买量必须满足最小买入份数和整手规则。');
      } else if (!quote || quote.quality !== 'READY' || quote.trade_date !== asOf || quote.price === null) {
        reject(rotate, 'PRICE_UNAVAILABLE', '候选必须是具有同日可校验行情的场内ETF。');
      } else {
        const price = Math.round(quote.price * 1000);
        const basic = input.marketDb!.prepare('SELECT * FROM fund_basic WHERE ts_code=?').get(buyCode) as any;
        const assetClass = classifyAssetClass(basic).asset_class;
        const oneLot = valueCents(lots.etf_lot_size, price);
        const gross = valueCents(quantity, price);
        const buyFee = feeFor(buyCode, gross, 'buy');
        const budget = reduce.cash_after_cents!;
        const oneLotCost = oneLot + feeFor(buyCode, oneLot, 'buy').total_cents;
        const funded = budget >= gross + buyFee.total_cents;
        rotate.rotation_plan = {
          buy_code: buyCode, buy_name: basic?.name ?? null, category: assetClass,
          price_milli: price, one_lot_cents: oneLot, cash_sufficient_for_one_lot: budget >= oneLotCost,
          quantity: funded ? quantity : null, fees_cents: funded ? buyFee.total_cents : null,
          spend_cents: funded ? gross + buyFee.total_cents : null, cash_after_cents: funded ? budget - gross - buyFee.total_cents : null,
          advantage_status: 'UNVERIFIED',
        };
        if (!funded) reject(rotate, 'INSUFFICIENT_CASH', '卖出净回款与原现金不足支付候选整手金额及买入费用；整个轮动情景保持HOLD。');
        else {
          const rows = soldRows.map(p => ({ ...p }));
          const existing = rows.find(p => p.ts_code === buyCode);
          if (existing) existing.value += gross;
          else rows.push({ ts_code: buyCode, value: gross, asset_class: assetClass, theme: THEME_BY_CODE[buyCode] ?? 'unknown', industry: INDUSTRY_BY_CODE[buyCode] ?? 'unclassified' });
          Object.assign(rotate, metrics(rows, budget - gross - buyFee.total_cents));
          rotate.funding_status = 'FUNDED'; rotate.sell_plan = reduce.sell_plan;
          rotate.fees_cents = reduce.fees_cents + buyFee.total_cents;
          rotate.fee_breakdowns = [...reduce.fee_breakdowns, { ts_code: buyCode, side: 'BUY', breakdown: buyFee }];
          rotate.summary = `研究卖出${scenario.sellQuantity}份${code}并买入${quantity}份${buyCode}；双边费用及滑点估计${rotate.fees_cents}分，优势UNVERIFIED。`;
        }
      }
    }
  }
  // A named stress comparison, never an automatically generated sell instruction.
  defensive.quantity_basis = 'equity_liquidation_stress_only';
  let defensiveCash = cash;
  let defensiveStatus: Option['funding_status'] = 'FUNDED';
  const defensiveFees: Option['fee_breakdowns'] = [];
  for (const position of positions.filter(p => p.asset_class === 'EQUITY' && p.value > 0)) {
    const holding = holdings.find(h => h.ts_code === position.ts_code)!;
    const available = sellable[position.ts_code];
    if (!available) defensiveStatus = 'SELLABILITY_UNKNOWN';
    else if (available.sellable_quantity < holding.quantity || holding.quantity % lots.etf_sell_multiple !== 0) defensiveStatus = 'NOT_SELLABLE';
    else if (holding.bar_quality !== 'READY' || holding.latest_bar_date !== asOf) defensiveStatus = 'PRICE_UNAVAILABLE';
    const fee = feeFor(position.ts_code, position.value, 'sell');
    defensiveCash += position.value - fee.total_cents;
    defensiveFees.push({ ts_code: position.ts_code, side: 'SELL', breakdown: fee });
  }
  if (defensiveCash < 0) defensiveStatus = 'INSUFFICIENT_CASH';
  if (defensiveStatus === 'FUNDED') {
    Object.assign(defensive, metrics(positions.map(p => p.asset_class === 'EQUITY' ? { ...p, value: 0 } : p), defensiveCash));
    defensive.fees_cents = defensiveFees.reduce((sum, row) => sum + row.breakdown.total_cents, 0);
    defensive.fee_breakdowns = defensiveFees;
    defensive.funding_status = 'FUNDED';
  } else reject(defensive, defensiveStatus, '权益清零对照因可卖性、行情或费用约束无法成立；保持HOLD，不伪造清仓回款。');
  const equityLots = holdings.filter(h => facts.get(h.ts_code)?.asset_class === 'EQUITY' && h.bar_quality === 'READY')
    .map(h => { const gross = valueCents(lots.etf_lot_size, h.price_milli); return gross + feeFor(h.ts_code, gross, 'buy').total_cents; });
  const minLot = equityLots.length ? Math.min(...equityLots) : null;
  return {
    as_of_trade_date: asOf,
    focus: focus ? { ts_code: focus.ts_code, name: focus.name, weight: focus.weight, market_value_cents: focus.market_value_cents, quantity: focus.quantity } : null,
    cash: { before_cents: cash, min_equity_lot_cents: minLot, sufficient_for_one_lot: minLot === null ? null : cash >= minLot },
    concentration_before: { hhi: baseline.concentration_after.hhi, effective_positions: baseline.concentration_after.effective_positions,
      top_weight: focus?.weight ?? null, equity_weight: baseline.exposure_after.equity_weight },
    sellable, options: [hold, reduce, rotate, defensive, noAction],
    note: '五方案均为非执行研究比较。HHI仅累加证券权重平方，分母含现金与理财；现金不作为证券加入分子。数量来自显式研究参数，费用采用账户/代码模型；缺乏优势与已确认风险策略时不生成交易动作。',
  };
}

// ---------------------------------------------------------------- 账户口径对照

/**
 * 账户口径对照（任务书 C4）。同一真实账户分别从 CLI、私有 MCP 与日报查询时，
 * 必须能解释“证券数量 / 现金 / 证券市值 / 总资产 / 集中度”是否一致。
 *
 * 生产上出现过的真实差异：`ashare_portfolio_summary` 用**快照参考价**计算市值与 HHI，
 * 日报用**当日收盘价**重估持仓，因此同一账户得到 HHI 0.557087 与 0.540059。
 * 两者都不算错，但必须并列披露并说明差异来源，否则会被读成账户数据矛盾。
 */
function buildAccountView(
  snapshot: AccountSnapshot | undefined, accountId: string, holdings: HoldingAssessment[],
  concentration: { hhi: number | null; effective_positions: number | null }, asOf: string,
  portfolio: any,
): {
  as_of_trade_date: string;
  account_id_in_report: string;
  snapshot_id: string | null;
  snapshot_as_of: string | null;
  snapshot_basis: { securities_mv_cents: number; cash_cents: number; total_assets_cents: number; hhi: number | null };
  revalued_basis: {
    securities_mv_cents: number; cash_cents: number; total_assets_cents: number; hhi: number | null;
    price_source: 'server_cache_close' | 'snapshot_reference_price' | 'mixed';
    codes_from_snapshot_price: string[];
  };
  quantity_consistent: boolean;
  reconciliation: { field: string; snapshot: number | null; revalued: number | null; explanation: string }[];
  note: string;
} {
  const positions = snapshot?.positions ?? [];
  const snapshotSecurities = snapshot?.totals.securities_mv_cents ?? 0;
  const snapshotCash = snapshot?.totals.cash_cents ?? 0;
  const snapshotTotal = snapshot?.totals.total_assets_cents ?? 0;
  const snapshotHhi = snapshotTotal > 0 && positions.length
    ? r6(positions.reduce((sum, position) => sum + (position.market_value_cents / snapshotTotal) ** 2, 0))
    : null;
  const revaluedSecurities = holdings.reduce((sum, holding) => sum + holding.market_value_cents, 0);
  const revaluedCash = portfolio?.cash_cents ?? 0;
  const revaluedWealth = portfolio?.wealth_cents ?? 0;
  const revaluedTotal = revaluedSecurities + revaluedCash + revaluedWealth;
  const fallbackCodes = holdings.filter(holding => holding.price_source !== 'server_cache_close').map(holding => holding.ts_code);
  const quantityByCode = new Map(positions.map(position => [position.ts_code, position.quantity]));
  const quantityConsistent = holdings.length === positions.length && holdings.every(holding => quantityByCode.get(holding.ts_code) === holding.quantity);
  return {
    as_of_trade_date: asOf,
    account_id_in_report: accountId,
    snapshot_id: snapshot?.snapshot_id ?? null,
    snapshot_as_of: snapshot?.as_of ?? null,
    snapshot_basis: {
      securities_mv_cents: snapshotSecurities,
      cash_cents: snapshotCash,
      total_assets_cents: snapshotTotal,
      hhi: snapshotHhi,
    },
    revalued_basis: {
      securities_mv_cents: revaluedSecurities,
      cash_cents: revaluedCash,
      total_assets_cents: revaluedTotal,
      hhi: concentration.hhi,
      price_source: fallbackCodes.length === 0
        ? 'server_cache_close'
        : fallbackCodes.length === holdings.length ? 'snapshot_reference_price' : 'mixed',
      codes_from_snapshot_price: fallbackCodes,
    },
    quantity_consistent: quantityConsistent,
    reconciliation: [
      {
        field: 'cash_cents', snapshot: snapshotCash, revalued: revaluedCash,
        explanation: '重估现金来自目标交易日账户状态（基线及已记录事件）；快照现金保留作对照。',
      },
      {
        field: 'securities_mv_cents', snapshot: snapshotSecurities, revalued: revaluedSecurities,
        explanation: '快照是用户确认时的市值；日报按目标交易日收盘价重估（行情缺失的代码回退到快照参考价）。',
      },
      {
        field: 'total_assets_cents', snapshot: snapshotTotal, revalued: revaluedTotal,
        explanation: '目标日账户持仓按收盘重估，加目标日现金与理财；与基线差异可来自事件及价格。',
      },
      {
        field: 'hhi', snapshot: snapshotHhi, revalued: concentration.hhi,
        explanation: 'HHI = Σ(持仓市值/总资产)²；两者的分母不同（快照总资产 vs 重估后总资产），因此数值不同不是账户矛盾。',
      },
    ],
    note: quantityConsistent
      ? '证券数量与参考快照一致；现金、市值和HHI按目标日账户状态与收盘行情计算。'
      : '目标日证券数量与参考快照不同；差异须结合已记录账户事件核对，不把旧快照当作重建后的余额。',
  };
}

// ---------------------------------------------------------------- 历史预案跟踪

function loadPlanTracking(portfolioDb: DatabaseSync, accountId: string, asOf: string): PlanTracking {
  if (!tableExists(portfolioDb, 'plan_tracking')) {
    return {
      available: false,
      reason: 'plan_tracking_table_missing',
      entries: [],
      note: '账户库没有 plan_tracking 表：历史预案的触发/失效无法核对。本模块只读，不会建表或补造历史。',
    };
  }
  let rows: any[];
  try {
    rows = portfolioDb.prepare(`
      SELECT * FROM plan_tracking
      WHERE account_id = ? AND as_of_trade_date < ?
      ORDER BY as_of_trade_date DESC LIMIT 10`).all(accountId, asOf) as any[];
  } catch (error: any) {
    return {
      available: false,
      reason: 'plan_tracking_unreadable',
      entries: [],
      note: `plan_tracking 读取失败：${error?.message ?? error}`,
    };
  }
  return {
    available: true,
    reason: null,
    entries: rows.map(row => ({
      plan_id: String(row.plan_id),
      as_of_trade_date: String(row.as_of_trade_date),
      status: String(row.status),
      action_code: String(row.action_code),
      action_summary: String(row.action_summary),
      expected_by: row.expected_by ?? null,
      // 没有后续行情/成交核对时一律 unknown，绝不臆断已触发或已失效。
      outcome: 'unknown' as const,
      outcome_basis: '只读历史预案记录；没有可核对的后续行情或真实成交，结果保持 unknown。',
    })),
    note: rows.length === 0
      ? '暂无更早的预案记录。'
      : `读取到 ${rows.length} 条更早的预案；结果未经后续行情核对。`,
  };
}

// ---------------------------------------------------------------- 动作构造

interface ActionContext {
  summary: any;
  asOf: string;
  gateSatisfied: boolean;
  fees: FeeRules;
  lots: LotRules;
  candidates: EtfCandidateScreenResult | null;
}

/** Research scores and concentration do not authorize a sale. Until a persisted,
 * user-confirmed risk policy or independently verified advantage is available,
 * the action section must explicitly conclude NO_ACTION. Scenario quantities
 * live in decision_comparison and never become executable legs. */
function buildActions(ctx: ActionContext): { actions: ActionPlan[]; blockers: string[] } {
  const stale = (ctx.summary.holdings ?? []).filter((holding: any) => holding.bar_quality !== 'READY');
  return {
    actions: [],
    blockers: stale.length ? [
      `${stale.map((holding: any) => holding.ts_code).join('、')} 缺少目标交易日可校验行情。`,
      '触发条件：补齐收盘行情和复权数据后重算。',
      '失效条件：目标交易日、账户状态或行情被更正。',
    ] : [],
  };
}

// ---------------------------------------------------------------- 候选 vs 现金

function buildCandidateCashCompetition(
  summary: any, screening: EtfCandidateScreenResult | null, lots: LotRules,
  context: { portfolioDb: DatabaseSync; accountId: string; asOf: string; feeOverride?: FeeRules },
): CandidateCashCompetition {
  const cashCents: number | null = typeof summary?.portfolio?.cash_cents === 'number' ? summary.portfolio.cash_cents : null;
  if (!screening) {
    return {
      available: false,
      cash_cents: cashCents,
      entries: [],
      screening: null,
      note: '没有候选池筛选结果（缓存缺少 fund_* 表或未提供市场缓存）；不臆造候选。',
    };
  }
  const entries = screening.candidates.slice(0, 8).map((candidate: EtfCandidateRow) => {
    const priceMilli = candidate.data.latest_close_milli;
    const lotCost = oneLotCents(priceMilli, lots.etf_lot_size);
    const fees = lotCost === null ? null : calculateFees(lotCost, 'buy', context.feeOverride ?? resolveFeeRules({
      db: context.portfolioDb, accountId: context.accountId, code: candidate.ts_code, kind: 'ETF', asOf: context.asOf,
    })).total_cents;
    const totalCost = lotCost === null || fees === null ? null : lotCost + fees;
    const fresh = candidate.data.latest_bar_date === context.asOf;
    return {
      ts_code: candidate.ts_code,
      name: candidate.name,
      category: candidate.category,
      status: candidate.status,
      score: candidate.score,
      price_milli: priceMilli,
      one_lot_cents: lotCost,
      one_lot_total_cents: totalCost,
      fees_cents: fees,
      cash_sufficient_for_one_lot: !fresh || totalCost === null || cashCents === null ? null : cashCents >= totalCost,
      note: candidate.status === 'DEGRADED'
        ? `候选数据降级：${candidate.status_reasons.join('; ') || '缓存缺表或字段'}`
        : `一手 ${lots.etf_lot_size} 份；价格为 ${candidate.data.latest_bar_date ?? '缺失'} 的缓存收盘`,
      fact_meta: {
        as_of: candidate.data.latest_bar_date,
        source: 'fund_daily + fund_share（候选池筛选）',
        quality: candidate.status === 'OK' ? 'OK' as const : 'DEGRADED' as const,
        claim_status: 'FACT' as const,
        detail: `价格口径 ${candidate.data.price_basis}；筛选分是启发式排序（UNVERIFIED），不是买入信号。`,
      },
    };
  });
  return {
    available: true,
    cash_cents: cashCents,
    entries,
    screening,
    note: '候选筛选是研究排序，不是买入信号；现金是否足够只回答“买得起一手”，不回答“该不该买”。',
  };
}

// ---------------------------------------------------------------- 主入口

export function buildDailyReport(input: DailyReportInput): DailyReportResult {
  const asOf = String(input.asOfTradeDate ?? '').trim();
  if (!YMD.test(asOf)) throw new Error('as_of_trade_date 需要 YYYYMMDD 格式');
  const parsedDate = new Date(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10).replace(/-/g, '') !== asOf) throw new Error('as_of_trade_date 不是有效日期');
  if (input.generatedAt != null && !Number.isFinite(Date.parse(input.generatedAt))) throw new Error('generatedAt 需要有效ISO时间');
  const { portfolioDb, marketDb, accountId } = input;
  const fees = input.fees ?? DEFAULT_FEE_RULES;
  const lots = input.lots ?? DEFAULT_LOT_RULES;
  for (const size of [lots.etf_lot_size, lots.etf_sell_multiple, lots.etf_min_buy]) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('交易单位必须为正整数');
  }
  const maxActions = input.maxActions === undefined ? 3 : Math.max(0, Math.min(3, Math.trunc(input.maxActions)));

  // 复用研究摘要：持仓、行情质量、市场环境与证据都来自这里，不重复实现。
  const summary = buildResearchSummary({
    portfolioDb,
    marketDb,
    accountId,
    asOfTradeDate: asOf,
    snapshotId: input.snapshotId,
  });

  const snapshot: AccountSnapshot | undefined = resolveAccountSnapshot(portfolioDb, accountId, input.snapshotId).snapshot;

  // 账户门控：必须与 decision.ts 的 evaluateAccountStatus 同源，否则会出现
  // "决策说可执行、日报说不可执行"两套口径。这里直接调用同一个门控函数。
  const accountStatus: string = summary.account_status ?? 'REAL_ACCOUNT_PENDING';
  const gateReasons: { code: string; detail: string }[] = [];
  const snapshotIsCurrent = snapshot?.is_current === true;
  let accountEvaluation: AccountStatusEvaluation | null = null;
  if (snapshot) {
    accountEvaluation = evaluateAccountStatus(
      portfolioDb,
      {
        snapshot_id: snapshot.snapshot_id,
        as_of: snapshot.as_of,
        is_current: snapshot.is_current,
        positions: snapshot.positions.map(p => ({ ts_code: p.ts_code, quantity: p.quantity, ref_price_milli: p.ref_price_milli })),
        totals: { cash_cents: snapshot.totals.cash_cents, securities_mv_cents: snapshot.totals.securities_mv_cents },
      },
      accountId,
      asOf,
    );
    for (const reason of accountEvaluation.reasons) gateReasons.push({ code: reason.code, detail: reason.detail });
    // 与 decision.ts 同口径：未上报交易风险下，可执行腿是对当前现金/份额的承诺，
    // 未上报成交可能已使其失效。日报与决策必须给出一致的 executable。
    if (accountEvaluation.unreported_trade_risk) {
      gateReasons.push({
        code: 'unreported_trade_risk',
        detail: '账户存在未上报交易的风险：可执行数量依赖当前现金与份额，未上报成交可能已使其失效，因此只给示意。',
      });
    }
  } else {
    gateReasons.push({ code: 'account_gate_unavailable', detail: '账户库中没有任何快照' });
  }
  const gateSatisfied = gateReasons.length === 0 && summary.status !== 'DATA_INSUFFICIENT';

  // 候选池：缓存缺 fund_* 表时返回 DEGRADED 行，而不是空列表。
  let screening: EtfCandidateScreenResult | null = null;
  try {
    screening = screenEtfCandidates(marketDb, { asOf, categories: input.categories });
  } catch {
    screening = null;
  }

  const ctx: ActionContext = { summary, asOf, gateSatisfied, fees, lots, candidates: screening };
  const built = maxActions === 0 ? { actions: [] as ActionPlan[], blockers: [] as string[] } : buildActions(ctx);
  const actions = built.actions;

  // ---- 状态：只有账户门控满足且有动作时才可能 ACTIONABLE；否则最多 ILLUSTRATIVE。
  const insufficient = summary.status === 'DATA_INSUFFICIENT';
  // ---- 语义修复（D2）：行情缺失是“数据不足”，不是“已证明继续持有最优”。
  // 修复前：五只持仓全部 NOT_READY 时，没有动作 → 返回 NO_ACTION，读起来像
  // “数据完整但没有可靠优势”。现在只有**行情完整**时才允许 NO_ACTION。
  // 顶层状态必须由**真实的腿**决定，不能只看账户门控：
  // 门控通过但没有任何可执行腿时，声称 ACTIONABLE 会让调用方以为可以下单。
  const anyExecutableLeg = actions.some(action => action.legs.some(leg => leg.executable === true));
  const quotesReady = summary.data_quality?.quotes?.ready ?? [];
  const quotesNotReady = [...new Set([...(summary.data_quality?.quotes?.stale ?? []), ...(summary.data_quality?.quotes?.not_ready ?? []), ...(summary.data_quality?.quotes?.missing ?? [])])];
  const quotesComplete = quotesNotReady.length === 0 && quotesReady.length > 0;
  let status: DailyReportStatus;
  if (insufficient) status = 'DATA_INSUFFICIENT';
  else if (actions.length === 0) status = quotesComplete ? 'NO_ACTION' : 'DATA_INSUFFICIENT';
  else status = gateSatisfied && anyExecutableLeg ? 'ACTIONABLE' : 'ILLUSTRATIVE';

  // 动作序号按最终顺序重排，保证 rank 连续（1..n）。
  actions.forEach((action, index) => { action.rank = index + 1; });

  // 任何非 ACTIONABLE 状态下，所有腿都必须是 executable:false。
  const normalizedActions: ActionPlan[] = actions.map(action => {
    const legs = action.legs.map(leg => (status === 'ACTIONABLE' ? leg : { ...leg, executable: false, reason: leg.reason ?? 'report_status_not_actionable' }));
    return {
      ...action,
      legs,
      illustrative: status === 'ACTIONABLE'
        ? null
        : { executable: false, legs: legs.map(leg => ({ ...leg, executable: false })) },
    };
  });

  // ---- 观察触发条件：NO_ACTION 时由“阻塞原因”与持仓质量共同给出，而不是空话。
  // DATA_INSUFFICIENT 时也保留阻塞原因，便于说明“为什么今天没有动作”。
  const observationTriggers = status === 'NO_ACTION'
    ? [
        ...built.blockers,
        '任一只持仓的缓存收盘跌破最近 20 日最低收盘（需在下一交易日收盘后核对）',
        '市场反证项数量超过支持项数量（见 market_judgement.counter_evidence）',
        '持仓行情质量从 READY 降为 STALE/NOT_READY',
        '账户快照被用户确认为当前账户且与目标交易日同日',
      ]
    : status === 'DATA_INSUFFICIENT'
      ? [
          ...built.blockers,
          ...(() => {
            const notReady = [...(summary.data_quality?.quotes?.stale ?? []), ...(summary.data_quality?.quotes?.not_ready ?? []), ...(summary.data_quality?.quotes?.missing ?? [])];
            return notReady.length
              ? [`触发条件：${[...new Set(notReady)].join('、')} 的目标交易日 fund_daily 收盘 bar 落库且通过 OHLC 校验；此前不把“继续持有”当作已证明的最优选择。`]
              : [];
          })(),
          '失效条件：出现新的、可复核的重大持仓风险事实时，本“数据不足”结论立即失效并重新评估。',
        ]
      : built.blockers;

  const market = summary.market_context ?? {};
  const evidence = summary.market_evidence ?? { support: [], contradiction: [] };
  const holdings: HoldingAssessment[] = (summary.holdings ?? []).map((holding: any) => {
    const stance: HoldingAssessment['stance'] = holding.bar_quality !== 'READY' ? 'WAIT' : 'HOLD';
    const themeEvidence = evidence.contradiction.find((item: any) => item.id === `theme_relative_strength:${holding.theme}`);
    const supportEvidence = evidence.support.find((item: any) => item.id === `theme_relative_strength:${holding.theme}`);
    const research = buildHoldingResearch(marketDb, holding, asOf, market, lots);
    return {
      ts_code: holding.ts_code,
      name: holding.name,
      quantity: holding.quantity,
      weight: holding.weight,
      market_value_cents: holding.market_value_cents,
      price_milli: holding.price_milli,
      price_source: holding.price_source,
      latest_bar_date: holding.latest_bar_date,
      bar_quality: holding.bar_quality,
      stance,
      reasons: [
        `权重 ${(holding.weight * 100).toFixed(2)}%，市值 ${(holding.market_value_cents / 100).toFixed(2)} 元`,
        `价格来源 ${holding.price_source}，bar 日期 ${holding.latest_bar_date ?? '缺失'}`,
        ...(supportEvidence ? [`支持：${supportEvidence.statement}`] : []),
      ],
      counter_evidence: [
        ...(themeEvidence ? [themeEvidence.statement] : []),
        '行业相对强弱只反映近 20 日，不预测未来。',
      ],
      research,
      fact_meta: {
        as_of: holding.latest_bar_date, source: `research_summary:${holding.source}`, quality: holding.bar_quality === 'READY' ? 'OK' : 'DEGRADED', claim_status: 'FACT',
      },
    };
  });

  // 独立数据质量维度（D1）：在持仓与门控都算完之后统一生成。
  const qualityTiers = buildQualityTiers(summary, screening, gateSatisfied, accountStatus, gateReasons, holdings.length, accountEvaluation);

  const dataQualityNotes: string[] = [];
  if (!screening) dataQualityNotes.push('候选池筛选不可用（缓存缺少 fund_* 表或未提供市场缓存）');
  else if (screening.data_coverage.status !== 'READY') {
    dataQualityNotes.push(`候选池数据覆盖 ${screening.data_coverage.status}：${screening.data_coverage.reasons.join('; ')}`);
  }
  if (summary.data_quality?.market_report?.freshness && summary.data_quality.market_report.freshness !== 'same_day') {
    dataQualityNotes.push('市场日报不是目标交易日当天（使用前一交易日报告）');
  }
  if (!snapshot) dataQualityNotes.push('账户库中没有快照');

  const factRegister: DailyReportResult['fact_register'] = [
    {
      id: 'account_snapshot', value: snapshot?.snapshot_id ?? null,
      as_of: snapshot?.as_of ?? null, source: 'portfolio.account_snapshot', quality: snapshot ? 'OK' : 'MISSING', claim_status: 'FACT',
    },
    {
      id: 'account_gate', value: gateSatisfied, as_of: asOf, source: 'portfolio.ledger.realAccountGate',
      quality: gateReasons.length === 0 ? 'OK' : 'DEGRADED', claim_status: 'FACT',
    },
    {
      id: 'market_report', value: summary.data_quality?.market_report?.report_id ?? null,
      as_of: summary.data_quality?.market_report?.as_of_trade_date ?? null, source: 'ashare.report',
      quality: summary.data_quality?.market_report?.available ? 'OK' : 'MISSING', claim_status: 'FACT',
    },
    {
      id: 'candidate_screen', value: screening?.data_coverage.status ?? 'UNAVAILABLE',
      as_of: asOf, source: 'ashare.etfUniverse', quality: screening?.data_coverage.status === 'READY' ? 'OK' : 'DEGRADED', claim_status: 'FACT',
    },
    {
      id: 'market_judgement', value: market.regime ?? null,
      as_of: market.as_of_trade_date ?? null, source: 'ashare_daily_report.market',
      quality: market.available ? 'OK' : 'MISSING', claim_status: 'UNVERIFIED',
    },
  ];

  const reportTotal = summary.portfolio?.total_assets_cents ?? 0;
  const reportHhi = reportTotal > 0 ? r6(holdings.reduce((sum, h) => sum + (h.market_value_cents / reportTotal) ** 2, 0)) : null;
  const concentration = { hhi: reportHhi, effective_positions: reportHhi && reportHhi > 0 ? r6(1 / reportHhi) : null };
  const equityClass = (summary.portfolio?.by_asset_class ?? []).find((row: any) => row.asset_class === 'EQUITY');
  // 与私有 MCP / CLI 的账户口径保持一致：集中度用**同一份快照**（持仓数量 × 当前收盘价）
  // 计算。`mergeAccountViews` 会同时返回账户汇总口径与日报口径，并显式说明差异来源
  // （是否使用当日收盘重估、是否含现金/理财），避免同一个账户在两处出现相互矛盾的 HHI
  // 或“证券数量 / 现金 / 总资产”不一致（任务书 C4）。
  const accountView = buildAccountView(snapshot, accountId, holdings, concentration, asOf, summary.portfolio);
  const decisionComparison = buildDecisionComparison({
    asOf, holdings, summary, accountView, accountEvaluation: accountEvaluation ?? null, screening, fees, lots,
    gateReasons, gateSatisfied, portfolioDb, marketDb, accountId, feeOverride: input.fees, scenario: input.researchScenario,
  });
  const reportId = createHash('sha256').update(JSON.stringify({
    schema: DAILY_REPORT_SCHEMA, account_id: accountId, as_of_trade_date: asOf,
    summary_id: summary.summary_id, status,
    gate: accountEvaluation ? { state_basis: accountEvaluation.state_basis, reasons: accountEvaluation.reasons,
      completeness: accountEvaluation.completeness, unreported_trade_risk: accountEvaluation.unreported_trade_risk,
      sellable: accountEvaluation.sellable } : null,
    holdings, market, screening, decision_comparison: decisionComparison, lots,
  })).digest('hex');

  return {
    schema: DAILY_REPORT_SCHEMA,
    report_id: reportId,
    status,
    actionable: status === 'ACTIONABLE',
    first_section: {
      heading: '下一交易日最值得做的 0-3 个动作及理由',
      count: normalizedActions.length,
      actions: normalizedActions,
      no_action_reason: status === 'NO_ACTION'
        ? built.blockers.length > 0
          ? `没有可复核的证据支持下一交易日的交易动作：${built.blockers[0]}`
          : '没有可复核的证据支持下一交易日的交易动作：行情质量、市场证据与候选比较都没有形成可执行的优势。'
        : status === 'DATA_INSUFFICIENT'
          ? (() => {
              const notReady = [...new Set([...(summary.data_quality?.quotes?.stale ?? []), ...(summary.data_quality?.quotes?.not_ready ?? []), ...(summary.data_quality?.quotes?.missing ?? [])])];
              return notReady.length
                ? `DATA_INSUFFICIENT：${notReady.join('、')} 在 ${asOf} 没有可校验的收盘行情，无法估值或比较；行情缺失不等于已证明继续持有最优。`
                : 'DATA_INSUFFICIENT：核心市场或账户数据不足，无法给出动作。';
            })()
          : null,
      observation_triggers: observationTriggers,
    },
    as_of_trade_date: asOf,
    expected_next_trade_date: nextTradeDay(marketDb, asOf),
    timestamps: {
      as_of_trade_date: asOf,
      account_confirmed_at: input.accountConfirmedAt ?? snapshot?.is_current_confirmed_at ?? null,
      quote_updated_at: input.quoteUpdatedAt ?? quoteUpdatedAt(marketDb),
      generated_at: input.generatedAt ?? new Date().toISOString(),
    },
    account_status: accountStatus,
    /** 账户身份是显式提供还是按本部署唯一真实账户推导（C1）。 */
    account_id: accountId,
    account_id_source: input.accountIdSource ?? 'explicit',
    account_view: accountView,
    decision_comparison: decisionComparison,
    data_quality: {
      status: summary.data_quality?.status ?? 'INSUFFICIENT',
      summary_status: summary.status,
      missing_fields: summary.data_quality?.missing_fields ?? [],
      quotes: {
        ready: summary.data_quality?.quotes?.ready ?? [],
        stale: summary.data_quality?.quotes?.stale ?? [],
        not_ready: summary.data_quality?.quotes?.not_ready ?? [],
        missing: summary.data_quality?.quotes?.missing ?? [],
      },
      market_report: {
        available: !!summary.data_quality?.market_report?.available,
        report_id: summary.data_quality?.market_report?.report_id ?? null,
        as_of_trade_date: summary.data_quality?.market_report?.as_of_trade_date ?? null,
        freshness: summary.data_quality?.market_report?.freshness ?? 'missing',
      },
      screening: {
        status: screening?.data_coverage.status ?? 'UNAVAILABLE',
        missing_tables: screening?.data_coverage.missing_tables ?? ['fund_basic', 'fund_daily', 'fund_adj', 'fund_share'],
      },
      /** 独立维度（D1）：任何一个 READY 都不代表其他维度也 READY。 */
      tiers: qualityTiers,
      notes: dataQualityNotes,
    },
    market_judgement: {
      available: !!market.available,
      regime: market.regime?.value ?? null,
      regime_label: market.regime?.label ?? null,
      tone: market.regime?.tone ?? null,
      judgement: market.judgement ?? [],
      counter_evidence: (evidence.contradiction ?? []).map((item: any) => ({
        id: item.id, statement: item.statement, as_of: item.as_of, source: item.source,
      })),
      support_evidence: (evidence.support ?? []).map((item: any) => ({
        id: item.id, statement: item.statement, as_of: item.as_of, source: item.source,
      })),
      research_status: 'UNVERIFIED',
      fact_meta: {
        as_of: market.as_of_trade_date ?? null,
        source: 'ashare_daily_report',
        quality: market.available ? 'OK' : 'MISSING',
        claim_status: 'UNVERIFIED',
        detail: evidence.threshold_policy ?? '方向只是可复核的事实现象，不是“反弹已确认”。',
      },
    },
    holdings,
    candidate_vs_cash: buildCandidateCashCompetition(summary, screening, lots, { portfolioDb, accountId, asOf, feeOverride: input.fees }),
    concentration: {
      hhi: concentration.hhi ?? null,
      effective_positions: concentration.effective_positions ?? null,
      top_position: summary.portfolio?.top_position ?? null,
      equity_weight: equityClass?.weight ?? null,
      cash_ratio: summary.portfolio?.cash_ratio ?? null,
      disclosure: [
        `HHI ${concentration.hhi}，有效持仓数 ${concentration.effective_positions}；HHI 越高越集中。`,
        `权益类权重 ${equityClass ? (equityClass.weight * 100).toFixed(2) : '不可用'}%，现金比例 ${summary.portfolio ? (summary.portfolio.cash_ratio * 100).toFixed(2) : '不可用'}%。`,
        '集中度是风险披露，不是卖出指令。',
      ],
    },
    drawdown: {
      available: false,
      reason: 'no_history',
      disclosure: '没有真实账户的历史净值与出入金流水，无法计算历史最大回撤；持仓浮亏不是历史最大回撤（PRD §8）。',
    },
    plan_tracking: loadPlanTracking(portfolioDb, accountId, asOf),
    gate: {
      satisfied: gateSatisfied,
      is_current: snapshotIsCurrent,
      account_status: accountStatus,
      state_basis: accountEvaluation?.state_basis ?? 'none',
      snapshot_as_of: accountEvaluation?.snapshot_as_of ?? null,
      reported_events_through: accountEvaluation?.reported_events_through ?? null,
      last_user_reconciled_at: accountEvaluation?.last_user_reconciled_at ?? null,
      unreported_trade_risk: accountEvaluation?.unreported_trade_risk ?? true,
      reasons: gateReasons,
      warnings: accountEvaluation?.warnings ?? [],
      note: '可执行要求：账本可重建的账户状态（同日快照或基线+增量事件）+ REAL_ACCOUNT_VERIFIED + '
        + '无未交收卖出 + 覆盖决策日的完整性声明。未满足时每个腿 executable=false；'
        + 'unreported_trade_risk=true 表示可能存在未录入交易，不能声称与券商实时一致。',
    },
    fact_register: factRegister,
    assumptions: {
      fees: { assumed: true, values: { ...fees } },
      lots: { assumed: true, values: { ...lots } },
      note: '费率、最低佣金、滑点与交易单位均为假设值，未与券商核对；输出中的费用不是真实成交成本。',
    },
    not_covered: [
      '盘中实时价格与可成交性：只有日线缓存收盘价',
      '真实账户历史收益与最大回撤：缺少完整出入金/成交流水',
      '候选池的前瞻有效性：筛选分数是启发式排序，未经检验',
      '历史预案的触发/失效结果：plan_tracking 只读，未与后续行情核对',
      '沪深主板个股的新增机会比较：本轮候选池只覆盖 ETF',
    ],
    disclaimer: DAILY_REPORT_DISCLAIMER,
  };
}
