import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AccountSummary } from './account.js';
import { THEME_BY_CODE, THEME_LABELS, currentSnapshot, round, valueCents } from './account.js';
import {
  DEFAULT_FEE_RULES, DEFAULT_LOT_RULES, DEFAULT_STOCK_RULES, FEE_RULE_VERSION, LOT_RULE_VERSION, tradabilityOf,
  type FeeRules, type InstrumentInfo, type LotRules, type StockRules,
} from './rules.js';
import { affordableLots, computeFees, type FeeBreakdown } from './scenario.js';
import {
  checkInstrumentClaim, normalizeSecurityCode, resolveInstrument,
  type InstrumentClaim, type ResolvedInstrument,
} from './instrument.js';
import { assessQuoteIntegrity, suspensionSynced } from './quotes.js';
import { verifyResearchEvidence, type EvidenceReason } from './evidence.js';
import { readBaseline, realAccountGate, replayAccount } from './ledger.js';

// 保持既有导出名：代码归一化是决策层的公开辅助函数。
export { normalizeSecurityCode } from './instrument.js';

/**
 * R1 条件化配置比较（工作包 C）。与 scenario.ts 的区别：
 *
 * - 行情**只**来自服务端只读市场缓存（fund_basic / fund_daily / daily / trade_cal），
 *   绝不接受调用方自填价格。候选不在缓存里就返回 DATA_INSUFFICIENT，而不是让用户
 *   输入一个"当前价"。
 * - 压力按资产类别分别施加（权益/债券/黄金/跨境/未分类），统一 −10% 只作为明确
 *   标注的演示对照，不冒充主要风险数字。
 * - 轮动优势必须来自 `RESEARCH_VERIFIED` 且带 `evidence_id` 的研究证据；布尔值
 *   或 `UNVERIFIED` 只能得到 ILLUSTRATIVE / NO_ACTION。
 * - 新建主板个股按净资产 0.5% 的单笔计划风险校验；失效价不保证成交。
 *
 * 全部计算确定性：同一输入（含行情与规则）得到同一 decision_id，哈希里没有时间戳。
 */

// ---------------------------------------------------------------- 资产类别与行业

export type AssetClass = 'EQUITY' | 'BOND' | 'GOLD' | 'CROSS_BORDER' | 'UNKNOWN';

export const ASSET_CLASSES: readonly AssetClass[] = ['EQUITY', 'BOND', 'GOLD', 'CROSS_BORDER', 'UNKNOWN'];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  EQUITY: '权益',
  BOND: '债券',
  GOLD: '黄金/贵金属',
  CROSS_BORDER: '跨境',
  UNKNOWN: '未分类',
};

export interface FundBasicLike {
  name?: string | null;
  fund_type?: string | null;
  invest_type?: string | null;
  benchmark?: string | null;
  type?: string | null;
  status?: string | null;
}

export interface AssetClassResult {
  asset_class: AssetClass;
  /** 判定依据，原样写入输出，便于复核。 */
  basis: string;
  /** false 时压力按权益处理，并打上 stress_assumption_unclassified。 */
  classified: boolean;
}

const CROSS_BORDER_RE = /QDII|纳斯达克|NASDAQ|标普|S&P|道琼斯|Dow\s*Jones|恒生指数|恒生科技|恒生中国企业|恒生国企|恒生港股|港股|香港|日经|Nikkei|德国|DAX|法国|CAC|亚太|美国|跨境|全球|海外|MSCI/i;
const GOLD_RE = /黄金|Gold|Au99|上海金|COMEX|伦敦金/i;
const BOND_RE = /债券|国债|信用债|可转债|金融债|政金债|Bond|短融|中票/i;
const COMMODITY_RE = /商品|期货|Commodity/i;
const EQUITY_RE = /股票|权益|Equity/i;

/**
 * “恒生A股…”“恒生沪深港通AH…”这类指数是中国内地 A 股/互联互通口径，名称里带
 * “恒生”但不是跨境资产。判定跨境前先剔掉这些国内口径短语，避免靠“恒生”单词误判。
 */
const DOMESTIC_INDEX_RE = /恒生沪深港通AH|恒生A股/g;

/**
 * 用 fund_basic 的 fund_type / invest_type / benchmark / 名称判定资产类别。
 * 判定顺序：黄金 → 债券 → 跨境 → 权益 → 未分类。跨境优先于权益，避免把纳指
 * ETF 当成 A 股权益；非黄金商品无法可靠归类，返回 UNKNOWN 而不是猜。
 */
export function classifyAssetClass(basic: FundBasicLike | null | undefined): AssetClassResult {
  if (!basic) return { asset_class: 'UNKNOWN', basis: 'fund_basic_missing', classified: false };
  const ft = String(basic.fund_type ?? '');
  const it = String(basic.invest_type ?? '');
  const bm = String(basic.benchmark ?? '');
  const nm = String(basic.name ?? '');
  const ty = String(basic.type ?? '');
  const all = [ft, it, bm, nm, ty].join(' ');

  if (GOLD_RE.test(`${bm} ${nm}`) || GOLD_RE.test(ft)) {
    return { asset_class: 'GOLD', basis: 'fund_basic.benchmark_or_name_gold', classified: true };
  }
  if (BOND_RE.test(`${ft} ${it} ${bm} ${nm}`)) {
    return { asset_class: 'BOND', basis: 'fund_basic.bond_type_or_benchmark', classified: true };
  }
  // 剔除国内口径后再看跨境标记：560390.SH（易方达恒生A股电网设备ETF）是 EQUITY。
  const crossBorderText = all.replace(DOMESTIC_INDEX_RE, ' ');
  const domesticIndex = crossBorderText !== all;
  if (CROSS_BORDER_RE.test(crossBorderText)) {
    return { asset_class: 'CROSS_BORDER', basis: 'fund_basic.cross_border_benchmark', classified: true };
  }
  if (EQUITY_RE.test(`${ft} ${it}`)) {
    return { asset_class: 'EQUITY', basis: 'fund_basic.equity_fund_type', classified: true };
  }
  if (domesticIndex) {
    // 明确标注为恒生A股 / 恒生沪深港通AH 等国内口径指数：即使 fund_type 缺失，
    // 也是国内权益，而不是跨境。
    return { asset_class: 'EQUITY', basis: 'fund_basic.domestic_a_share_index', classified: true };
  }
  if (COMMODITY_RE.test(ft)) {
    // 豆粕/有色等非黄金商品没有合适的声明冲击，按未分类处理并显式标注。
    return { asset_class: 'UNKNOWN', basis: 'fund_basic.commodity_non_gold_unclassified', classified: false };
  }
  return { asset_class: 'UNKNOWN', basis: 'fund_basic_unrecognized', classified: false };
}

/**
 * 行业归类。这是**声明式**映射，不是上游事实；未列出的代码一律 unclassified，
 * 不做关键词猜测。版本号随输出返回，便于审计口径变化。
 */
export const INDUSTRY_MAP_VERSION = 'r1-industry-map-1.0.0';
export const INDUSTRY_BY_CODE: Record<string, string> = {
  '159558.SZ': '半导体',
  '159241.SZ': '国防军工',
  '159278.SZ': '机械设备',
  '516080.SH': '医药生物',
  '560390.SH': '电力设备',
};

// ---------------------------------------------------------------- 压力规则

export interface AssetClassStressRules {
  version: string;
  /** 负数表示下跌。 */
  shocks: Record<AssetClass, number>;
  provenance: Record<AssetClass, { assumed: true; source: string }>;
  /** 仅作为明确标注的演示对照，不参与主要风险数字。 */
  uniform_demo_shock_pct: number;
}

const P = (source: string) => ({ assumed: true as const, source });

export const ASSET_CLASS_STRESS_VERSION = 'r1-asset-stress-1.0.0';

export const DEFAULT_ASSET_CLASS_STRESS: AssetClassStressRules = {
  version: ASSET_CLASS_STRESS_VERSION,
  shocks: { EQUITY: -0.10, BOND: -0.01, GOLD: -0.05, CROSS_BORDER: -0.12, UNKNOWN: -0.10 },
  provenance: {
    EQUITY: P('declared: 权益类声明压力 −10%，是情景假设，不是预测，也不是历史回撤'),
    BOND: P('declared: 债券类声明压力 −1%，仅用于区分资产类别，不是久期/信用模型'),
    GOLD: P('declared: 黄金类声明压力 −5%，是情景假设，不是预测'),
    CROSS_BORDER: P('declared: 跨境类声明压力 −12%，未包含汇率与溢价收敛的独立建模'),
    UNKNOWN: P('declared: 无法分类时按权益 −10% 处理，并在输出中标记 stress_assumption_unclassified'),
  },
  uniform_demo_shock_pct: -0.10,
};

// ---------------------------------------------------------------- 报价（只来自服务端缓存）

export type QuoteMissReason =
  | 'candidate_not_cached'
  | 'candidate_bar_missing'
  | 'market_cache_unavailable'
  | 'instrument_unknown'
  | 'as_of_not_trading_day'
  | 'trade_calendar_missing'
  | 'invalid_close'
  | 'ohlc_missing'
  | 'ohlc_inconsistent'
  | 'volume_invalid'
  | 'amount_invalid'
  | 'list_status_unknown'
  | 'instrument_not_tradable'
  | 'suspension_unknown'
  | 'instrument_suspended'
  | 'bar_not_latest_trade_day';

export interface CachedQuote {
  ts_code: string;
  available: true;
  name: string | null;
  /** 缓存里的真实行情交易日。 */
  trade_date: string;
  price_milli: number;
  asset_class: AssetClass;
  classification: AssetClassResult;
  fund_type: string | null;
  invest_type: string | null;
  benchmark: string | null;
  list_status: string | null;
  suspended: boolean;
  quality: 'READY' | 'STALE';
  source: 'server_cache';
  warnings: string[];
}

export interface MissingQuote {
  ts_code: string;
  available: false;
  reason: QuoteMissReason;
  detail: string;
  source: 'server_cache';
}

export type QuoteLookup = CachedQuote | MissingQuote;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

interface TradeDayCheck {
  /** as_of 当日是否开市；日历缺失或没有该日期时为 null。 */
  isOpen: boolean | null;
  calendarKnown: boolean;
  expected: string | null;
}

/** 统一交易日历检查：as_of 必须是日历中的开市日。 */
function tradeDayCheck(db: DatabaseSync, asOf: string): TradeDayCheck {
  if (!tableExists(db, 'trade_cal')) return { isOpen: null, calendarKnown: false, expected: null };
  const row = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(asOf) as any;
  const latest = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1').get(asOf) as any;
  return {
    isOpen: row ? row.is_open === 1 : null,
    calendarKnown: true,
    expected: latest?.cal_date ?? null,
  };
}

function missing(code: string, reason: QuoteMissReason, detail: string): MissingQuote {
  return { ts_code: code, available: false, reason, detail, source: 'server_cache' };
}

/**
 * ETF 与个股共用的只读报价加载器。所有质量口径（OHLC 完整性、上市状态、停牌可证性、
 * 交易日历、bar 日期）走同一套 `assessQuoteIntegrity`；任一阻塞项都返回 available:false，
 * 不携带价格。
 */
function loadDecisionQuote(
  db: DatabaseSync | null | undefined, rawCode: string, asOfTradeDate: string, kind: 'ETF' | 'STOCK',
): QuoteLookup {
  const code = normalizeSecurityCode(rawCode);
  if (!db) return missing(code, 'market_cache_unavailable', '未提供只读市场缓存');
  const barTable = kind === 'ETF' ? 'fund_daily' : 'daily';
  const basicTable = kind === 'ETF' ? 'fund_basic' : 'stock_basic';
  if (!tableExists(db, barTable)) return missing(code, 'market_cache_unavailable', `缓存缺少 ${barTable} 表`);

  const cal = tradeDayCheck(db, asOfTradeDate);
  if (!cal.calendarKnown) return missing(code, 'trade_calendar_missing', '缓存缺少 trade_cal，无法确认交易日');
  if (cal.isOpen !== true) return missing(code, 'as_of_not_trading_day', `${asOfTradeDate} 不在交易日历中或不是开市日`);

  const basic = tableExists(db, basicTable)
    ? (db.prepare(`SELECT name, ${kind === 'ETF' ? 'fund_type, invest_type, benchmark, type, status AS list_status' : 'list_status'} FROM ${basicTable} WHERE ts_code = ?`).get(code) as any)
    : undefined;
  if (!basic) return missing(code, 'candidate_not_cached', `${code} 不在 ${basicTable}/${barTable} 缓存中`);

  const bar = db.prepare(`
    SELECT trade_date, open, high, low, close, vol, amount FROM ${barTable}
    WHERE ts_code = ? AND trade_date <= ?
    ORDER BY trade_date DESC LIMIT 1`).get(code, asOfTradeDate) as any;
  if (!bar) return missing(code, 'candidate_bar_missing', `${code} 在 ${asOfTradeDate} 及之前没有日线`);

  let suspended = false;
  let suspensionKnown = kind === 'ETF';
  if (kind === 'STOCK') {
    const row = tableExists(db, 'suspend_d')
      ? db.prepare('SELECT 1 FROM suspend_d WHERE ts_code = ? AND trade_date = ?').get(code, asOfTradeDate)
      : undefined;
    suspended = !!row;
    suspensionKnown = !!row || suspensionSynced(db, asOfTradeDate);
  }

  const integrity = assessQuoteIntegrity({
    kind,
    code,
    asOf: asOfTradeDate,
    expected: cal.expected,
    tradeDate: String(bar.trade_date),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    vol: bar.vol,
    amount: bar.amount,
    listStatus: basic.list_status ?? null,
    suspensionKnown,
    suspended,
  });
  if (integrity.blocking.length > 0) {
    return missing(code, integrity.blocking[0] as QuoteMissReason, `${code} 行情不可用：${integrity.blocking.join(', ')}`);
  }

  const classification: AssetClassResult = kind === 'ETF'
    ? classifyAssetClass({ name: basic.name, fund_type: basic.fund_type, invest_type: basic.invest_type, benchmark: basic.benchmark, type: basic.type })
    : { asset_class: 'EQUITY', basis: 'stock_basic_and_daily', classified: true };
  return {
    ts_code: code,
    available: true,
    name: basic.name ?? null,
    trade_date: String(bar.trade_date),
    price_milli: Math.round(Number(bar.close) * 1000),
    asset_class: classification.asset_class,
    classification,
    fund_type: basic.fund_type ?? null,
    invest_type: basic.invest_type ?? null,
    benchmark: basic.benchmark ?? null,
    list_status: basic.list_status ?? null,
    suspended,
    quality: integrity.warnings.length > 0 ? 'STALE' : 'READY',
    source: 'server_cache',
    warnings: integrity.warnings,
  };
}

/**
 * 从只读市场缓存取 ETF 报价。价格永远来自 fund_daily.close（元/份 → 厘），
 * 调用方提供的任何价格都不会进入本函数。
 */
export function loadEtfQuote(db: DatabaseSync | null | undefined, rawCode: string, asOfTradeDate: string): QuoteLookup {
  return loadDecisionQuote(db, rawCode, asOfTradeDate, 'ETF');
}

/** 主板/其他个股的只读报价：来自 `daily` 与 `suspend_d`（并需停牌同步证明）。 */
export function loadStockQuote(db: DatabaseSync | null | undefined, rawCode: string, asOfTradeDate: string): QuoteLookup {
  return loadDecisionQuote(db, rawCode, asOfTradeDate, 'STOCK');
}

// ---------------------------------------------------------------- 输入 / 输出类型

export type DecisionStatus = 'ACTIONABLE' | 'ILLUSTRATIVE' | 'NO_ACTION' | 'DATA_INSUFFICIENT';

export type OptionAction = 'HOLD' | 'REDUCE_EQUITY' | 'SELL_AND_BUY' | 'NO_ACTION';

export type DecisionAction =
  | { type: 'HOLD' }
  | { type: 'REDUCE_EQUITY'; sell_code: string; sell_shares: number }
  | { type: 'SELL_AND_BUY'; sell_code: string; sell_shares: number; buy_code: string; buy_kind?: 'ETF' | 'STOCK'; buy_board?: string }
  | { type: 'NO_ACTION'; reason?: string };

export interface RotationClaim {
  claim: string;
  source: 'RESEARCH_VERIFIED' | 'UNVERIFIED';
  evidence_id?: string;
  as_of?: string;
}

export interface StockPlanInput {
  ts_code: string;
  /** 股数；缺省时用本次可买整手数。 */
  quantity?: number;
  /** 计划失效价，厘。 */
  invalidation_milli: number;
}

export interface DecisionInput {
  account_id: string;
  snapshot: AccountSummary;
  as_of_trade_date: string;
  /** 只读市场缓存（fund_basic/fund_daily/daily/trade_cal）。 */
  market_db?: DatabaseSync | null;
  /**
   * 只读账户库。研究证据（research_evidence）与真实账户门控都必须从这里复核；
   * 不提供时证据一律未验证、账户一律不可执行——没有匿名自认批准的通道。
   */
  portfolio_db?: DatabaseSync | null;
  action: DecisionAction;
  evidence?: RotationClaim | null;
  stock_plan?: StockPlanInput | null;
  rules?: { fees?: FeeRules; lots?: LotRules; stock?: StockRules; stress?: AssetClassStressRules };
  /** 仅当 action 为 HOLD 时可选给出一个降低权益敞口的对照腿。 */
  reduce?: { sell_code: string; sell_shares: number } | null;
}

export type DecisionReasonCode =
  | 'hold_requested'
  | 'no_action_requested'
  | 'candidate_not_cached'
  | 'candidate_bar_missing'
  | 'market_cache_unavailable'
  | 'quote_stale'
  | 'instrument_not_tradable'
  | 'instrument_suspended'
  | 'instrument_unknown'
  | 'instrument_claim_mismatch'
  | 'permission_restricted'
  | 'insufficient_position'
  | 'invalid_input'
  | 'invalid_invalidation'
  | 'lot_rule'
  | 'same_instrument'
  | 'insufficient_cash_for_one_lot'
  | 'rotation_advantage_unverified'
  | 'no_demonstrated_advantage'
  | 'account_not_current'
  | 'account_not_verified'
  | 'account_gate_unavailable'
  | 'account_snapshot_mismatch'
  | 'account_snapshot_stale'
  | 'account_settlement_pending'
  | 'as_of_not_trading_day'
  | 'risk_budget_exceeded'
  | 'stock_not_cached'
  | 'stress_assumption_unclassified'
  | 'reduce_leg_not_specified'
  | 'ohlc_missing'
  | 'ohlc_inconsistent'
  | 'invalid_close'
  | 'volume_invalid'
  | 'amount_invalid'
  | 'list_status_unknown'
  | 'suspension_unknown'
  | 'trade_calendar_missing'
  | 'bar_not_latest_trade_day'
  | 'evidence_not_found'
  | 'evidence_revoked'
  | 'evidence_code_mismatch'
  | 'evidence_expired'
  | 'evidence_not_yet_valid'
  | 'evidence_status_not_verified';

export interface Reason {
  code: DecisionReasonCode;
  detail: string;
}

export interface TradeLeg {
  side: 'SELL' | 'BUY';
  ts_code: string;
  name: string | null;
  quantity: number;
  lot_size: number;
  lots: number;
  price_milli: number;
  gross_cents: number;
  fees: FeeBreakdown;
  /** 卖出 = 毛收入 − 费用（正）；买入 = −(毛支出 + 费用)（负）。 */
  net_cents: number;
  cash_delta_cents: number;
  quote_trade_date: string;
  funding_source: string;
  min_trade_unit: { lot_size: number; unit: 'share' };
  /** 该腿适用个股规则还是 ETF 规则（来自服务端身份解析）。 */
  instrument_kind: 'ETF' | 'STOCK';
  /** 个股 T+1 标记；ETF 为 false。仅提示，不用于撮合。 */
  t_plus_one: boolean;
  executable: boolean;
}

export interface Exposure {
  total_assets_cents: number;
  securities_mv_cents: number;
  cash_cents: number;
  cash_ratio: number;
  equity_weight: number;
  by_asset_class: { asset_class: AssetClass; label: string; weight: number; market_value_cents: number }[];
  theme_weight: { theme: string; label: string; weight: number }[];
  industry_weight: { industry: string; weight: number; basis: string }[];
  unclassified_theme_weight: number;
  unclassified_industry_weight: number;
  concentration: { hhi: number; effective_positions: number };
  top_position: { ts_code: string; name: string; weight: number } | null;
  positions: { ts_code: string; name: string; quantity: number; market_value_cents: number; weight: number; asset_class: AssetClass; theme: string; industry: string }[];
  /** 估值依据：全部缓存收盘 / 混合 / 全部快照参考价。 */
  basis: 'server_cache_close' | 'snapshot_reference_price' | 'mixed';
  /** true 表示该投影不是可执行结果，只是示意。 */
  illustrative: boolean;
  note: string;
}

export interface StressResult {
  kind: 'asset_class_declared_stress';
  version: string;
  assumed: true;
  by_asset_class: { asset_class: AssetClass; label: string; shock_pct: number; exposure_cents: number; loss_cents: number; assumed: true }[];
  total_loss_cents: number;
  loss_pct_of_total: number;
  unclassified_codes: string[];
  warnings: string[];
  /** 统一 −10% 只作为演示对照。 */
  uniform_demo: { shock_pct: number; loss_cents: number; loss_pct_of_total: number; label: 'demo_only'; note: string };
  note: string;
}

export interface FeeSummary {
  assumed_cents: number;
  /** 未获得券商真实费率数据时为 null，绝不填 0 冒充。 */
  real_cents: number | null;
  real_available: false;
  version: string;
  assumed: true;
  note: string;
}

export interface DecisionOption {
  action: OptionAction;
  label: string;
  available: boolean;
  status: DecisionStatus;
  executable: boolean;
  reasons: Reason[];
  /** 只有 executable 时才给出可直接对照的下单腿。 */
  legs: TradeLeg[];
  /** 非可执行时，计算值放在这里，并显式 executable:false。 */
  illustrative_legs: TradeLeg[];
  cash: { before_cents: number; change_cents: number; after_cents: number; legs_sum_cents: number; reconciliation_ok: boolean };
  exposure: Exposure | null;
  stress: StressResult | null;
  fees: FeeSummary;
  funding_source: string;
  min_trade_unit: { lot_size: number; unit: 'share'; note: string };
  quote_dates: Record<string, string | null>;
  invalidation_conditions: string[];
  notes: string[];
  /** 本次对照是否涉及个股 T+1（卖出或买入任一是个股）。 */
  t_plus_one: boolean;
}

export interface StockPlanCheck {
  ts_code: string;
  quantity: number;
  lot_size: number;
  entry_milli: number | null;
  entry_source: 'server_cache' | 'not_available';
  invalidation_milli: number;
  planned_risk_cents: number | null;
  net_assets_cents: number;
  budget_cents: number;
  risk_ratio: number | null;
  ok: boolean;
  reasons: Reason[];
  note: string;
}

export interface DecisionResult {
  schema: 'ashare-portfolio-decision/1.0';
  decision_id: string;
  account_id: string;
  snapshot_id: string;
  snapshot_as_of: string;
  snapshot_is_current: boolean;
  as_of_trade_date: string;
  requested_action: OptionAction;
  status: DecisionStatus;
  reasons: Reason[];
  warnings: string[];
  quotes: {
    source: 'server_cache';
    as_of_trade_date: string;
    entries: QuoteLookup[];
    stale_codes: string[];
    missing_codes: string[];
  };
  options: DecisionOption[];
  stock_plan: StockPlanCheck | null;
  evidence: {
    supplied: boolean;
    source: 'RESEARCH_VERIFIED' | 'UNVERIFIED' | null;
    verified: boolean;
    evidence_id: string | null;
    as_of: string | null;
    claim: string | null;
    /** 未通过时的具体原因；通过时为 null。 */
    reason: EvidenceReason | 'evidence_source_unverified' | null;
    /** 记录里的状态（只读展示，不能由调用方改写）。 */
    record_status: string | null;
    strategy_id: string | null;
    valid_until: string | null;
    note: string;
  };
  /** 账户可执行门控的判定明细（只读、可审计）。 */
  account_status: AccountStatusEvaluation;
  valuation: {
    basis: 'server_cache_close_with_snapshot_fallback';
    repriced_codes: string[];
    snapshot_price_codes: string[];
    note: string;
  };
  rules: {
    fees: { version: string; assumed: true; values: FeeRules };
    lots: { version: string; assumed: true; values: LotRules };
    stock: {
      version: string;
      kind: 'STOCK';
      assumed: true;
      t_plus_one: boolean;
      values: StockRules;
      note: string;
    };
    stress: { version: string; assumed: true; shocks: Record<AssetClass, number>; provenance: AssetClassStressRules['provenance'] };
    industry_map: { version: string; assumed: true; map: Record<string, string> };
  };
  historical_performance: { available: false; reason: 'no_history' };
  max_drawdown: { available: false; reason: 'no_history' };
  disclaimer: string;
}

// ---------------------------------------------------------------- 账户状态门控

/**
 * 账户可执行与否的统一门控（R2 A1.5）。必须同时满足：
 * 1. 快照 `is_current === true`（用户确认过的当前账户）；
 * 2. 账户库存在，且该 account_id 的账本门控为 REAL_ACCOUNT_VERIFIED；
 * 3. 快照日期与决策日**同一交易日**（0 天容忍；不同日 → account_snapshot_stale）；
 * 4. 账本在该日没有未交收卖出（否则现金口径有歧义）。
 * 任一不满足即不可执行。快照对象无法自证“当前”，gate 也无法从快照推断。
 */
export interface AccountStatusEvaluation {
  ok: boolean;
  is_current: boolean;
  gate: 'VERIFIED' | 'PENDING' | 'UNAVAILABLE';
  gate_confirmed_at: string | null;
  snapshot_as_of: string;
  as_of: string;
  pending_settlement_cents: number;
  reasons: Reason[];
  note: string;
}

export function evaluateAccountStatus(
  portfolioDb: DatabaseSync | null | undefined,
  snapshot: AccountSummary,
  accountId: string,
  asOf: string,
): AccountStatusEvaluation {
  const reasons: Reason[] = [];
  const snapshotYmd = String(snapshot.as_of ?? '').replace(/-/g, '');
  let gate: AccountStatusEvaluation['gate'] = 'UNAVAILABLE';
  let confirmedAt: string | null = null;
  let pendingSettlement = 0;

  if (snapshot.is_current !== true) {
    reasons.push({ code: 'account_not_current', detail: '账户快照 is_current=false，只能作为对照，不能作为可执行预案' });
  }
  if (!portfolioDb) {
    reasons.push({ code: 'account_gate_unavailable', detail: '未提供只读账户库，无法复核真实账户确认状态与研究证据' });
  } else {
    const evaluated = realAccountGate(portfolioDb, accountId);
    gate = evaluated.verified ? 'VERIFIED' : 'PENDING';
    confirmedAt = evaluated.confirmed_at;
    // 快照必须是账户库里“当前”的那一条，调用方不能拿一个自制的 AccountSummary 冒充。
    let storedCurrent: ReturnType<typeof currentSnapshot>;
    try {
      storedCurrent = currentSnapshot(portfolioDb);
    } catch {
      storedCurrent = undefined;
    }
    if (!storedCurrent) {
      reasons.push({ code: 'account_not_current', detail: '账户库中没有用户确认的当前快照（is_current=1）' });
    } else if (storedCurrent.snapshot_id !== snapshot.snapshot_id) {
      reasons.push({
        code: 'account_snapshot_mismatch',
        detail: `传入快照 ${snapshot.snapshot_id} 不是账户库当前快照 ${storedCurrent.snapshot_id}，不能作为可执行依据`,
      });
    }
    if (!evaluated.verified) {
      reasons.push({ code: 'account_not_verified', detail: `账户 ${accountId} 的账本门控为 ${evaluated.status}，未确认为真实账户` });
    } else {
      const baseline = readBaseline(portfolioDb, accountId);
      if (!baseline) {
        gate = 'PENDING';
        reasons.push({ code: 'account_gate_unavailable', detail: `账户 ${accountId} 没有账本基线，无法核对现金与持仓` });
      } else {
        try {
          const replay = replayAccount(portfolioDb, accountId, { asOf });
          pendingSettlement = replay.cash.unsettled_cents;
          if (pendingSettlement !== 0 || replay.pending_settlement.length > 0) {
            reasons.push({
              code: 'account_settlement_pending',
              detail: `账户 ${accountId} 在 ${asOf} 仍有未交收卖出 ${(pendingSettlement / 100).toFixed(2)} 元，可用现金口径有歧义`,
            });
          }
        } catch (error) {
          reasons.push({ code: 'account_gate_unavailable', detail: `账本重放失败：${(error as Error).message}` });
        }
      }
    }
  }
  // 0 天容忍：快照必须与决策日是同一天（YYYYMMDD）。
  if (!/^\d{8}$/.test(snapshotYmd) || snapshotYmd !== asOf) {
    reasons.push({
      code: 'account_snapshot_stale',
      detail: `账户快照日期 ${snapshot.as_of} 与决策日 ${asOf} 不是同一交易日（0 天容忍），现金与持仓可能已变化`,
    });
  }

  return {
    ok: reasons.length === 0,
    is_current: snapshot.is_current === true,
    gate,
    gate_confirmed_at: confirmedAt,
    snapshot_as_of: snapshotYmd,
    as_of: asOf,
    pending_settlement_cents: pendingSettlement,
    reasons,
    note: '可执行要求：当前确认快照 + 账本 REAL_ACCOUNT_VERIFIED + 同一交易日 + 无未交收卖出。',
  };
}

// ---------------------------------------------------------------- 组合投影

interface PositionState {
  ts_code: string;
  name: string;
  quantity: number;
  market_value_cents: number;
  asset_class: AssetClass;
  theme: string;
  industry: string;
  basis: 'server_cache_close' | 'snapshot_reference_price';
}

interface PortfolioState {
  positions: PositionState[];
  cash_cents: number;
  wealth_cents: number;
  total_assets_cents: number;
  repriced_codes: string[];
  snapshot_price_codes: string[];
}

function exposureOf(state: PortfolioState, illustrative = false): Exposure {
  const total = state.total_assets_cents;
  const denom = (v: number) => (total > 0 ? round(v / total, 6) : 0);
  const positions = state.positions
    .filter(p => p.quantity > 0 && p.market_value_cents > 0)
    .map(p => ({ ...p, weight: denom(p.market_value_cents) }));

  const byClass = new Map<AssetClass, number>();
  const byTheme = new Map<string, number>();
  const byIndustry = new Map<string, number>();
  for (const p of positions) {
    byClass.set(p.asset_class, (byClass.get(p.asset_class) ?? 0) + p.market_value_cents);
    byTheme.set(p.theme, (byTheme.get(p.theme) ?? 0) + p.market_value_cents);
    byIndustry.set(p.industry, (byIndustry.get(p.industry) ?? 0) + p.market_value_cents);
  }
  const hhi = round(positions.reduce((a, p) => a + p.weight * p.weight, 0), 6);
  const top = positions.length ? positions.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;
  const securities = positions.reduce((a, p) => a + p.market_value_cents, 0);
  const basis: Exposure['basis'] = state.snapshot_price_codes.length === 0
    ? 'server_cache_close'
    : state.repriced_codes.length === 0 ? 'snapshot_reference_price' : 'mixed';

  return {
    total_assets_cents: total,
    securities_mv_cents: securities,
    cash_cents: state.cash_cents,
    cash_ratio: denom(state.cash_cents),
    // 权益敞口 = 权益 + 跨境（跨境 ETF 仍是权益资产）；黄金/债券/未分类单列。
    equity_weight: denom((byClass.get('EQUITY') ?? 0) + (byClass.get('CROSS_BORDER') ?? 0)),
    by_asset_class: ASSET_CLASSES.map(asset_class => ({
      asset_class, label: ASSET_CLASS_LABELS[asset_class],
      weight: denom(byClass.get(asset_class) ?? 0),
      market_value_cents: byClass.get(asset_class) ?? 0,
    })),
    theme_weight: [...byTheme.entries()].sort((a, b) => b[1] - a[1])
      .map(([theme, mv]) => ({ theme, label: THEME_LABELS[theme] ?? theme, weight: denom(mv) })),
    industry_weight: [...byIndustry.entries()].sort((a, b) => b[1] - a[1])
      .map(([industry, mv]) => ({ industry, weight: denom(mv), basis: industry === 'unclassified' ? 'unclassified' : `declared:${INDUSTRY_MAP_VERSION}` })),
    unclassified_theme_weight: denom(byTheme.get('unknown') ?? 0),
    unclassified_industry_weight: denom(byIndustry.get('unclassified') ?? 0),
    concentration: { hhi, effective_positions: hhi > 0 ? round(1 / hhi, 4) : 0 },
    top_position: top ? { ts_code: top.ts_code, name: top.name, weight: top.weight } : null,
    positions: positions.map(p => ({
      ts_code: p.ts_code, name: p.name, quantity: p.quantity, market_value_cents: p.market_value_cents,
      weight: p.weight, asset_class: p.asset_class, theme: p.theme, industry: p.industry,
    })),
    basis,
    illustrative,
    note: illustrative
      ? '示意投影：基于非当前交易状态或快照参考价，不是可执行结果，也不是收益预测。'
      : '按缓存收盘价与快照参考价重估的组合投影；快照参考价不是当前市场价。',
  };
}

function stressOf(state: PortfolioState, rules: AssetClassStressRules): StressResult {
  const exposure = exposureOf(state);
  const warnings: string[] = [];
  const unclassified: string[] = [];
  const byClass = ASSET_CLASSES.map(asset_class => {
    const row = exposure.by_asset_class.find(r => r.asset_class === asset_class)!;
    const shock = rules.shocks[asset_class];
    return {
      asset_class, label: ASSET_CLASS_LABELS[asset_class], shock_pct: shock,
      exposure_cents: row.market_value_cents,
      loss_cents: Math.round(row.market_value_cents * shock),
      assumed: true as const,
    };
  });
  for (const p of state.positions) {
    if (p.asset_class === 'UNKNOWN' && p.market_value_cents > 0) {
      unclassified.push(p.ts_code);
      warnings.push('stress_assumption_unclassified');
    }
  }
  const totalLoss = byClass.reduce((a, r) => a + r.loss_cents, 0);
  const securities = exposure.securities_mv_cents;
  const uniformLoss = Math.round(securities * rules.uniform_demo_shock_pct);
  return {
    kind: 'asset_class_declared_stress',
    version: rules.version,
    assumed: true,
    by_asset_class: byClass,
    total_loss_cents: totalLoss,
    loss_pct_of_total: exposure.total_assets_cents > 0 ? round((totalLoss / exposure.total_assets_cents) * 100, 4) : 0,
    unclassified_codes: unclassified,
    warnings: [...new Set(warnings)],
    uniform_demo: {
      shock_pct: rules.uniform_demo_shock_pct,
      loss_cents: uniformLoss,
      loss_pct_of_total: exposure.total_assets_cents > 0 ? round((uniformLoss / exposure.total_assets_cents) * 100, 4) : 0,
      label: 'demo_only',
      note: `统一 ${(rules.uniform_demo_shock_pct * 100).toFixed(0)}% 冲击只用于演示对照，不是按资产类别的风险差异，也不是预测。`,
    },
    note: '按资产类别分别施加的声明式压力假设；不是预测，也不是历史最大回撤。',
  };
}

// ---------------------------------------------------------------- 计划风险（个股 0.5% NAV）

export const STOCK_PLAN_RISK_PCT = 0.005;
export const STOCK_LOT_SIZE = 100;

export function evaluateStockPlan(
  plan: StockPlanInput,
  opts: { netAssetsCents: number; quote: QuoteLookup; lotSize?: number; quantityOverride?: number },
): StockPlanCheck {
  const lotSize = opts.lotSize ?? STOCK_LOT_SIZE;
  const code = normalizeSecurityCode(plan.ts_code);
  const quantity = opts.quantityOverride ?? plan.quantity ?? 0;
  const entry = opts.quote.available ? opts.quote.price_milli : null;
  const invalidation = plan.invalidation_milli;
  const budget = Math.round(opts.netAssetsCents * STOCK_PLAN_RISK_PCT);
  const reasons: Reason[] = [];

  if (!Number.isInteger(quantity) || quantity <= 0) {
    reasons.push({ code: 'invalid_input', detail: `计划数量必须为正整数，收到 ${quantity}` });
  } else if (quantity % lotSize !== 0) {
    reasons.push({ code: 'lot_rule', detail: `个股数量 ${quantity} 不是 ${lotSize} 股的整数倍` });
  }
  if (!opts.quote.available) {
    reasons.push({ code: 'stock_not_cached', detail: opts.quote.detail });
  }
  if (!Number.isFinite(invalidation) || invalidation <= 0) {
    reasons.push({ code: 'invalid_input', detail: `失效价必须为正数（厘），收到 ${invalidation}` });
  }
  // 做多买入的失效价必须严格低于入场价；高于或等于入场价不是止损预算，直接拒绝。
  const directionInvalid = entry !== null && Number.isFinite(invalidation) && invalidation >= entry;
  if (directionInvalid) {
    reasons.push({
      code: 'invalid_invalidation',
      detail: `做多失效价 ${(invalidation / 1000).toFixed(3)} 元必须严格低于入场价 ${(entry! / 1000).toFixed(3)} 元`,
    });
  }
  const plannedRisk = entry !== null && Number.isFinite(invalidation) && invalidation > 0 && !directionInvalid
    ? Math.round((quantity * (entry - invalidation)) / 10)
    : null;
  if (plannedRisk !== null && plannedRisk > budget) {
    reasons.push({
      code: 'risk_budget_exceeded',
      detail: `计划风险 ${(plannedRisk / 100).toFixed(2)} 元超过净资产 0.5% 上限 ${(budget / 100).toFixed(2)} 元`
        + `（数量 ${quantity} × (入场 ${(entry! / 1000).toFixed(3)} − 失效 ${(invalidation / 1000).toFixed(3)})）`,
    });
  }
  return {
    ts_code: code,
    quantity,
    lot_size: lotSize,
    entry_milli: entry,
    entry_source: entry === null ? 'not_available' : 'server_cache',
    invalidation_milli: invalidation,
    planned_risk_cents: plannedRisk,
    net_assets_cents: opts.netAssetsCents,
    budget_cents: budget,
    risk_ratio: plannedRisk !== null && opts.netAssetsCents > 0 ? round(plannedRisk / opts.netAssetsCents, 6) : null,
    ok: reasons.length === 0,
    reasons,
    note: '计划风险 = 数量 × (入场价 − 失效价)，上限为账户净资产的 0.5%。失效价只是计划参考，不保证成交；跳空、停牌或流动性不足时真实损失可能超过该预算。',
  };
}

// ---------------------------------------------------------------- 主入口

const DISCLAIMER = '本决策对照为只读、确定性的静态计算：不访问券商、不下单、不预测收益。行情只来自服务端只读缓存，压力参数、费用与交易单位均为假设值；用户需自行在券商手动执行。';

export function buildDecision(input: DecisionInput): DecisionResult {
  const fees = input.rules?.fees ?? DEFAULT_FEE_RULES;
  const lots = input.rules?.lots ?? DEFAULT_LOT_RULES;
  const stockRules = input.rules?.stock ?? DEFAULT_STOCK_RULES;
  const stressRules = input.rules?.stress ?? DEFAULT_ASSET_CLASS_STRESS;
  const db = input.market_db ?? null;
  const portfolioDb = input.portfolio_db ?? null;
  const asOf = input.as_of_trade_date;
  const warnings: string[] = [];
  const reasons: Reason[] = [];

  if (!/^\d{8}$/.test(asOf)) throw new Error('as_of_trade_date 需要 YYYYMMDD 格式');

  // 交易日历：必须是当前缓存里的开市日；没有日历或没有该日期都不做可执行计算。
  let tradingDayOk = true;
  if (db) {
    const cal = tradeDayCheck(db, asOf);
    if (!cal.calendarKnown) {
      tradingDayOk = false;
      reasons.push({ code: 'trade_calendar_missing', detail: '缓存缺少 trade_cal，无法确认交易日' });
    } else if (cal.isOpen !== true) {
      tradingDayOk = false;
      reasons.push({ code: 'as_of_not_trading_day', detail: `${asOf} 不在交易日历中或不是开市日` });
    }
  }

  // 标的身份一律以服务端缓存解析为准；调用方的 buy_kind / buy_board 只是待核对声明。
  const resolved = new Map<string, ResolvedInstrument>();
  const resolveFor = (raw: string): ResolvedInstrument => {
    const code = normalizeSecurityCode(raw);
    if (!resolved.has(code)) {
      resolved.set(code, db
        ? resolveInstrument(db, code)
        : {
            found: false, kind: 'UNKNOWN', board: null, list_status: null, name: null,
            source: 'none', as_of: null, detail: '未提供只读市场缓存，无法确认标的身份',
          });
    }
    return resolved.get(code)!;
  };

  const codes = new Set<string>();
  if (input.action.type === 'SELL_AND_BUY' || input.action.type === 'REDUCE_EQUITY') codes.add(input.action.sell_code);
  if (input.action.type === 'SELL_AND_BUY') codes.add(input.action.buy_code);
  for (const p of input.snapshot.positions) codes.add(p.ts_code);
  if (input.reduce) codes.add(input.reduce.sell_code);
  if (input.stock_plan) codes.add(input.stock_plan.ts_code);

  const quotes = new Map<string, QuoteLookup>();
  for (const raw of codes) {
    const code = normalizeSecurityCode(raw);
    if (!db) {
      quotes.set(code, loadEtfQuote(null, code, asOf));
      continue;
    }
    const info = resolveFor(code);
    if (!info.found) {
      quotes.set(code, { ts_code: code, available: false, reason: 'instrument_unknown', detail: info.detail, source: 'server_cache' });
      continue;
    }
    quotes.set(code, info.kind === 'STOCK' ? loadStockQuote(db, code, asOf) : loadEtfQuote(db, code, asOf));
  }

  // 账户门控：当前快照 + 账本 REAL_ACCOUNT_VERIFIED + 同一交易日 + 无未交收卖出。
  const accountStatus = evaluateAccountStatus(portfolioDb, input.snapshot, input.account_id, asOf);
  const accountCurrent = accountStatus.is_current;
  const tradeRequested = input.action.type === 'SELL_AND_BUY' || input.action.type === 'REDUCE_EQUITY';
  if (tradeRequested) {
    for (const r of accountStatus.reasons) {
      if (!reasons.some(x => x.code === r.code && x.detail === r.detail)) reasons.push(r);
    }
  }

  const before = buildState(input, quotes);
  const evidence = normalizeEvidence(input.evidence, {
    portfolioDb,
    asOf,
    buyCode: input.action.type === 'SELL_AND_BUY' ? normalizeSecurityCode(input.action.buy_code) : null,
    sellCode: input.action.type === 'SELL_AND_BUY' ? normalizeSecurityCode(input.action.sell_code) : null,
  });
  if (!evidence.verified && input.action.type === 'SELL_AND_BUY') {
    reasons.push(evidence.supplied
      ? {
          code: 'rotation_advantage_unverified',
          detail: `轮动优势未经验证：source=${evidence.source}，reason=${evidence.reason ?? 'unknown'}${evidence.evidence_id ? '' : '，缺少 evidence_id'}`,
        }
      : { code: 'no_demonstrated_advantage', detail: '未提供轮动优势研究证据' });
  }

  const options: DecisionOption[] = [];
  const hold = optionHold(before, stressRules, fees);
  options.push(hold);

  const reduceSpec = reduceLegOf(input);
  options.push(optionReduce(before, reduceSpec, quotes, resolveFor, asOf, stressRules, fees, lots, stockRules, accountStatus.reasons, tradingDayOk));

  const rotate = optionRotate(input, before, quotes, resolveFor, asOf, stressRules, fees, lots, stockRules, accountStatus.reasons, tradingDayOk, evidence);
  options.push(rotate);

  options.push(optionNoAction(before, input.action.type === 'NO_ACTION' ? (input.action.reason ?? '调用方选择不操作') : '保留现金与现有持仓，不产生交易', stressRules, fees));

  // 个股计划风险：本次买入个股时用可买数量；也允许独立传入计划。
  const buyCode = input.action.type === 'SELL_AND_BUY' ? normalizeSecurityCode(input.action.buy_code) : null;
  const buyIsStock = buyCode !== null && resolveFor(buyCode).kind === 'STOCK';
  let stockPlan: StockPlanCheck | null = null;
  if (input.action.type === 'SELL_AND_BUY' && buyIsStock) {
    const quote = quotes.get(buyCode!)!;
    const target = rotate.illustrative_legs.find(l => l.side === 'BUY') ?? rotate.legs.find(l => l.side === 'BUY');
    const quantity = input.stock_plan?.quantity ?? target?.quantity ?? 0;
    stockPlan = evaluateStockPlan(
      { ts_code: buyCode!, quantity, invalidation_milli: input.stock_plan?.invalidation_milli ?? NaN },
      { netAssetsCents: before.total_assets_cents, quote },
    );
  } else if (input.stock_plan) {
    const code = normalizeSecurityCode(input.stock_plan.ts_code);
    stockPlan = evaluateStockPlan(input.stock_plan, {
      netAssetsCents: before.total_assets_cents,
      quote: quotes.get(code) ?? loadStockQuote(db, code, asOf),
    });
  }
  if (stockPlan && !stockPlan.ok) {
    const rotateIndex = options.findIndex(o => o.action === 'SELL_AND_BUY');
    for (const reason of stockPlan.reasons) {
      reasons.push(reason);
      if (rotateIndex >= 0) options[rotateIndex].reasons.push(reason);
    }
    if (rotateIndex >= 0) {
      // 计划风险超预算时轮动方案必须降级为"不操作"，不能留下可下单的买入腿。
      options[rotateIndex] = degradeOption(options[rotateIndex], 'NO_ACTION', stockPlan.reasons);
    }
  }

  const requested = optionActionOf(input.action.type);
  const primary = options.find(o => o.action === requested)!;
  let status: DecisionStatus = tradingDayOk ? primary.status : 'DATA_INSUFFICIENT';
  // 账户门控失败时，即使某个选项漏判，也不能从公共入口得到 ACTIONABLE。
  if (tradeRequested && !accountStatus.ok && status === 'ACTIONABLE') status = 'ILLUSTRATIVE';

  const allReasons = [...reasons];
  for (const r of primary.reasons) if (!allReasons.some(x => x.code === r.code && x.detail === r.detail)) allReasons.push(r);
  const warningSet = [...new Set([
    ...warnings,
    ...options.flatMap(o => o.stress?.warnings ?? []),
    ...options.flatMap(o => o.notes),
  ])].filter(w => !w.includes(' '));

  const staleCodes = [...quotes.values()].filter(q => q.available && q.quality === 'STALE').map(q => q.ts_code).sort();
  const missingCodes = [...quotes.values()].filter(q => !q.available).map(q => q.ts_code).sort();

  return {
    schema: 'ashare-portfolio-decision/1.0',
    decision_id: decisionId(input, quotes, fees, lots, stressRules, evidence, accountStatus),
    account_id: input.account_id,
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_as_of: input.snapshot.as_of,
    snapshot_is_current: accountCurrent,
    as_of_trade_date: asOf,
    requested_action: requested,
    status,
    reasons: allReasons,
    warnings: warningSet,
    quotes: { source: 'server_cache', as_of_trade_date: asOf, entries: [...quotes.values()], stale_codes: staleCodes, missing_codes: missingCodes },
    options,
    stock_plan: stockPlan,
    evidence,
    account_status: accountStatus,
    valuation: {
      basis: 'server_cache_close_with_snapshot_fallback',
      repriced_codes: before.repriced_codes.slice().sort(),
      snapshot_price_codes: before.snapshot_price_codes.slice().sort(),
      note: '有缓存收盘价的持仓按缓存价重估，其余沿用快照参考价；快照参考价不是当前市场价。',
    },
    rules: {
      fees: { version: FEE_RULE_VERSION, assumed: true, values: fees },
      lots: { version: LOT_RULE_VERSION, assumed: true, values: lots },
      stock: {
        version: stockRules.version,
        kind: 'STOCK',
        assumed: true,
        t_plus_one: stockRules.t_plus_one,
        values: stockRules,
        note: '个股费用、交易单位与 T+1 均为假设值，不是券商事实；本模块不撮合。',
      },
      stress: { version: stressRules.version, assumed: true, shocks: stressRules.shocks, provenance: stressRules.provenance },
      industry_map: { version: INDUSTRY_MAP_VERSION, assumed: true, map: INDUSTRY_BY_CODE },
    },
    historical_performance: { available: false, reason: 'no_history' },
    max_drawdown: { available: false, reason: 'no_history' },
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------- 组合状态

function buildState(input: DecisionInput, quotes: Map<string, QuoteLookup>): PortfolioState {
  const positions: PositionState[] = [];
  const repriced: string[] = [];
  const snapshotPriced: string[] = [];
  for (const p of input.snapshot.positions) {
    const quote = quotes.get(normalizeSecurityCode(p.ts_code));
    let marketValue = p.market_value_cents;
    let basis: PositionState['basis'] = 'snapshot_reference_price';
    if (quote?.available) {
      marketValue = valueCents(p.quantity, quote.price_milli);
      basis = 'server_cache_close';
      repriced.push(p.ts_code);
    } else {
      snapshotPriced.push(p.ts_code);
    }
    positions.push({
      ts_code: p.ts_code,
      name: p.name,
      quantity: p.quantity,
      market_value_cents: marketValue,
      asset_class: quote?.available ? quote.asset_class : 'UNKNOWN',
      theme: THEME_BY_CODE[p.ts_code] ?? 'unknown',
      industry: INDUSTRY_BY_CODE[p.ts_code] ?? 'unclassified',
      basis,
    });
  }
  const securities = positions.reduce((a, p) => a + p.market_value_cents, 0);
  const cash = input.snapshot.totals.cash_cents;
  const wealth = input.snapshot.totals.wealth_cents;
  return { positions, cash_cents: cash, wealth_cents: wealth, total_assets_cents: securities + cash + wealth, repriced_codes: repriced, snapshot_price_codes: snapshotPriced };
}

function cloneState(state: PortfolioState): PortfolioState {
  return {
    positions: state.positions.map(p => ({ ...p })),
    cash_cents: state.cash_cents,
    wealth_cents: state.wealth_cents,
    total_assets_cents: state.total_assets_cents,
    repriced_codes: [...state.repriced_codes],
    snapshot_price_codes: [...state.snapshot_price_codes],
  };
}

function recomputeTotals(state: PortfolioState): void {
  const securities = state.positions.filter(p => p.quantity > 0).reduce((a, p) => a + p.market_value_cents, 0);
  state.total_assets_cents = securities + state.cash_cents + state.wealth_cents;
}

// ---------------------------------------------------------------- 交易腿

function sellLeg(
  code: string, quantity: number, quote: CachedQuote, lotSize: number, fees: FeeRules, kind: 'ETF' | 'STOCK',
): TradeLeg {
  const gross = valueCents(quantity, quote.price_milli);
  const fee = computeFees(gross, 'sell', fees);
  return {
    side: 'SELL', ts_code: code, name: quote.name, quantity, lot_size: lotSize, lots: quantity / lotSize,
    price_milli: quote.price_milli, gross_cents: gross, fees: fee, net_cents: gross - fee.total_cents,
    cash_delta_cents: gross - fee.total_cents, quote_trade_date: quote.trade_date,
    funding_source: `position:${code}`, min_trade_unit: { lot_size: lotSize, unit: 'share' },
    instrument_kind: kind, t_plus_one: kind === 'STOCK', executable: true,
  };
}

function buyLeg(
  code: string, lotsCount: number, quote: CachedQuote, lotSize: number, fees: FeeRules, kind: 'ETF' | 'STOCK',
): TradeLeg {
  const quantity = lotsCount * lotSize;
  const gross = valueCents(quantity, quote.price_milli);
  const fee = computeFees(gross, 'buy', fees);
  return {
    side: 'BUY', ts_code: code, name: quote.name, quantity, lot_size: lotSize, lots: lotsCount,
    price_milli: quote.price_milli, gross_cents: gross, fees: fee, net_cents: -(gross + fee.total_cents),
    cash_delta_cents: -(gross + fee.total_cents), quote_trade_date: quote.trade_date,
    funding_source: 'sell_proceeds_and_cash', min_trade_unit: { lot_size: lotSize, unit: 'share' },
    instrument_kind: kind, t_plus_one: kind === 'STOCK', executable: true,
  };
}

/** 非可执行方案里的计算值：所有腿强制 executable:false，避免被下游误当成下单指令。 */
function asIllustrative(legs: TradeLeg[]): TradeLeg[] {
  return legs.map(l => ({ ...l, executable: false }));
}

function feeSummary(legs: TradeLeg[], fees: FeeRules): FeeSummary {
  return {
    assumed_cents: legs.reduce((a, l) => a + l.fees.total_cents, 0),
    real_cents: null,
    real_available: false,
    version: FEE_RULE_VERSION,
    assumed: true,
    note: `费用按假设费率计算（${FEE_RULE_VERSION}）；未获得券商真实成交费率，real_cents 保持 null 而不是填 0。`,
  };
}

// ---------------------------------------------------------------- 选项构造

const MIN_TRADE_UNIT = { lot_size: 100, unit: 'share' as const, note: 'ETF 1 手 = 100 份；主板个股 1 手 = 100 股（假设值）' };

const HOLD_INVALIDATION = [
  '账户快照不是最新（is_current=false）时，本对照失效。',
  '行情不是 as_of 交易日或缓存缺失时，权重与压力损失需要重算。',
  '资产类别无法判定时，压力按权益处理，可能低估或高估风险。',
];

function emptyCash(before: number) {
  return { before_cents: before, change_cents: 0, after_cents: before, legs_sum_cents: 0, reconciliation_ok: true };
}

function cashOf(before: number, legs: TradeLeg[]) {
  const change = legs.reduce((a, l) => a + l.cash_delta_cents, 0);
  return {
    before_cents: before,
    change_cents: change,
    after_cents: before + change,
    legs_sum_cents: change,
    reconciliation_ok: legs.reduce((a, l) => a + l.cash_delta_cents, 0) === change,
  };
}

function optionHold(state: PortfolioState, stressRules: AssetClassStressRules, fees: FeeRules): DecisionOption {
  return {
    action: 'HOLD',
    label: '继续持有，不交易',
    available: true,
    status: 'NO_ACTION',
    executable: false,
    reasons: [{ code: 'hold_requested', detail: '继续持有：不产生交易，也不产生费用。' }],
    legs: [],
    illustrative_legs: [],
    cash: emptyCash(state.cash_cents),
    exposure: exposureOf(state),
    stress: stressOf(state, stressRules),
    fees: feeSummary([], fees),
    funding_source: 'none',
    min_trade_unit: MIN_TRADE_UNIT,
    quote_dates: {},
    invalidation_conditions: [...HOLD_INVALIDATION],
    notes: [],
    t_plus_one: false,
  };
}

function optionNoAction(state: PortfolioState, detail: string, stressRules: AssetClassStressRules, fees: FeeRules): DecisionOption {
  return {
    action: 'NO_ACTION',
    label: '明确不操作',
    available: true,
    status: 'NO_ACTION',
    executable: false,
    reasons: [{ code: 'no_action_requested', detail }],
    legs: [],
    illustrative_legs: [],
    cash: emptyCash(state.cash_cents),
    exposure: exposureOf(state),
    stress: stressOf(state, stressRules),
    fees: feeSummary([], fees),
    funding_source: 'none',
    min_trade_unit: MIN_TRADE_UNIT,
    quote_dates: {},
    invalidation_conditions: [...HOLD_INVALIDATION],
    notes: [],
    t_plus_one: false,
  };
}

function reduceLegOf(input: DecisionInput): { sell_code: string; sell_shares: number } | null {
  if (input.action.type === 'REDUCE_EQUITY') return { sell_code: input.action.sell_code, sell_shares: input.action.sell_shares };
  if (input.action.type === 'SELL_AND_BUY') return { sell_code: input.action.sell_code, sell_shares: input.action.sell_shares };
  if (input.reduce) return input.reduce;
  return null;
}

// 缺失/不可用类原因：DATA_INSUFFICIENT，不能给出可执行腿。
const DATA_BLOCKING_REASONS = new Set<string>([
  'candidate_not_cached', 'candidate_bar_missing', 'market_cache_unavailable', 'instrument_unknown',
  'as_of_not_trading_day', 'trade_calendar_missing', 'invalid_close', 'ohlc_missing', 'ohlc_inconsistent',
  'volume_invalid', 'amount_invalid', 'list_status_unknown', 'suspension_unknown', 'bar_not_latest_trade_day',
]);
// 约束类原因：NO_ACTION。
const CONSTRAINT_BLOCKING_REASONS = new Set<string>([
  'invalid_input', 'invalid_invalidation', 'lot_rule', 'insufficient_position', 'permission_restricted',
  'instrument_claim_mismatch', 'same_instrument', 'insufficient_cash_for_one_lot', 'instrument_not_tradable',
  'instrument_suspended',
]);
// 软性原因：可以算，但只能是 ILLUSTRATIVE。
const SOFT_REASONS = new Set<string>([
  'quote_stale', 'account_not_current', 'account_not_verified', 'account_gate_unavailable',
  'account_snapshot_stale', 'account_settlement_pending', 'rotation_advantage_unverified', 'no_demonstrated_advantage',
]);

function statusOfReasons(reasons: Reason[], canCompute: boolean): DecisionStatus {
  if (reasons.some(r => DATA_BLOCKING_REASONS.has(r.code))) return 'DATA_INSUFFICIENT';
  if (reasons.some(r => CONSTRAINT_BLOCKING_REASONS.has(r.code))) return 'NO_ACTION';
  if (reasons.some(r => SOFT_REASONS.has(r.code))) return 'ILLUSTRATIVE';
  return canCompute ? 'ACTIONABLE' : 'DATA_INSUFFICIENT';
}

function optionReduce(
  state: PortfolioState,
  spec: { sell_code: string; sell_shares: number } | null,
  quotes: Map<string, QuoteLookup>, resolveFor: (raw: string) => ResolvedInstrument, asOf: string,
  stressRules: AssetClassStressRules, fees: FeeRules, lots: LotRules, stockRules: StockRules,
  accountIssues: Reason[], tradingDayOk: boolean,
): DecisionOption {
  const base = {
    action: 'REDUCE_EQUITY' as const,
    label: '卖出后只保留现金（降低权益敞口）',
    funding_source: 'sell_proceeds_to_cash',
    min_trade_unit: MIN_TRADE_UNIT,
    invalidation_conditions: [
      ...HOLD_INVALIDATION,
      '卖出后组合波动率与回撤可能下降，但上涨参与度也同时下降；这不是收益预测。',
      '若成交价与缓存收盘价偏离超过滑点假设，费用与剩余现金需要重算。',
    ],
    notes: [] as string[],
  };
  if (!spec) {
    return {
      ...base,
      available: false, status: 'DATA_INSUFFICIENT', executable: false,
      reasons: [{ code: 'reduce_leg_not_specified', detail: '未指定卖出标的与数量，无法给出降低权益敞口的对照' }],
      legs: [], illustrative_legs: [],
      cash: emptyCash(state.cash_cents), exposure: exposureOf(state, true), stress: stressOf(state, stressRules),
      fees: feeSummary([], fees), quote_dates: {}, t_plus_one: false,
    };
  }
  const code = normalizeSecurityCode(spec.sell_code);
  const info = resolveFor(code);
  const isStock = info.kind === 'STOCK';
  const lotMultiple = isStock ? stockRules.sell_multiple : lots.etf_sell_multiple;
  const feeRules = isStock ? stockRules.fees : fees;
  const quote = quotes.get(code);
  const position = state.positions.find(p => normalizeSecurityCode(p.ts_code) === code);
  const reasons: Reason[] = [];
  const shares = spec.sell_shares;
  if (!info.found) reasons.push({ code: 'instrument_unknown', detail: info.detail });
  if (!Number.isInteger(shares) || shares <= 0) reasons.push({ code: 'invalid_input', detail: `卖出数量必须为正整数，收到 ${shares}` });
  else if (shares % lotMultiple !== 0) reasons.push({ code: 'lot_rule', detail: `卖出 ${shares} 不是 ${lotMultiple} 的整数倍` });
  if (!position) reasons.push({ code: 'insufficient_position', detail: `账户快照不持有 ${code}` });
  else if (Number.isInteger(shares) && shares > position.quantity) reasons.push({ code: 'insufficient_position', detail: `拟卖出 ${shares}，超过持仓 ${position.quantity}` });
  if (!quote || !quote.available) {
    reasons.push({ code: quote?.reason ?? 'candidate_not_cached', detail: quote?.detail ?? `${code} 无可用缓存行情` });
  } else {
    if (quote.suspended) reasons.push({ code: 'instrument_suspended', detail: `${code} 停牌` });
    if (quote.list_status && quote.list_status !== 'L') reasons.push({ code: 'instrument_not_tradable', detail: `${code} 上市状态 ${quote.list_status}` });
  }
  for (const r of accountIssues) reasons.push(r);
  if (!tradingDayOk) reasons.push({ code: 'as_of_not_trading_day', detail: `${asOf} 不是交易日` });

  const canCompute = !!position && Number.isInteger(shares) && shares > 0 && !!quote?.available;
  const legs = canCompute ? [sellLeg(code, shares, quote as CachedQuote, lotMultiple, feeRules, isStock ? 'STOCK' : 'ETF')] : [];
  const after = cloneState(state);
  if (canCompute) {
    const leg = legs[0];
    const target = after.positions.find(p => normalizeSecurityCode(p.ts_code) === code)!;
    const soldMv = position!.quantity > 0 ? Math.round((target.market_value_cents * shares) / target.quantity) : 0;
    target.quantity -= shares;
    target.market_value_cents -= soldMv;
    after.cash_cents += leg.cash_delta_cents;
    recomputeTotals(after);
  }
  const status = statusOfReasons(reasons, canCompute);
  const executable = status === 'ACTIONABLE' && canCompute;
  return {
    ...base,
    available: true,
    status,
    executable,
    reasons,
    legs: executable ? legs : [],
    illustrative_legs: executable ? [] : asIllustrative(legs),
    cash: cashOf(state.cash_cents, legs),
    exposure: exposureOf(after, !executable),
    stress: stressOf(after, stressRules),
    fees: feeSummary(legs, fees),
    quote_dates: { [code]: quote?.available ? quote.trade_date : null },
    t_plus_one: isStock,
  };
}

function optionRotate(
  input: DecisionInput, state: PortfolioState,
  quotes: Map<string, QuoteLookup>, resolveFor: (raw: string) => ResolvedInstrument, asOf: string,
  stressRules: AssetClassStressRules, fees: FeeRules, lots: LotRules, stockRules: StockRules,
  accountIssues: Reason[], tradingDayOk: boolean, evidence: DecisionResult['evidence'],
): DecisionOption {
  const base = {
    action: 'SELL_AND_BUY' as const,
    label: '卖出后买入候选（轮动）',
    funding_source: 'sell_proceeds_and_cash',
    min_trade_unit: MIN_TRADE_UNIT,
    invalidation_conditions: [
      ...HOLD_INVALIDATION,
      '若买入标的在成交前停牌、退市或流动性不足，预案失效。',
      '若轮动优势证据被撤回、过期或无法复核，转为 NO_ACTION。',
      '若实际成交价与缓存收盘价偏离超过滑点假设，手数、费用与剩余现金需要重算。',
      '失效价不保证成交；跳空或跌停时真实损失可能超过计划风险。',
    ],
    notes: [] as string[],
  };
  if (input.action.type !== 'SELL_AND_BUY') {
    return {
      ...base, available: false, status: 'DATA_INSUFFICIENT', executable: false,
      reasons: [{ code: 'invalid_input', detail: '本次请求未指定卖出与买入标的，无法给出轮动对照' }],
      legs: [], illustrative_legs: [], cash: emptyCash(state.cash_cents),
      exposure: exposureOf(state, true), stress: stressOf(state, stressRules), fees: feeSummary([], fees), quote_dates: {},
      t_plus_one: false,
    };
  }
  const action = input.action;
  const sellCode = normalizeSecurityCode(action.sell_code);
  const buyCode = normalizeSecurityCode(action.buy_code);
  const sellInfo = resolveFor(sellCode);
  const buyInfo = resolveFor(buyCode);
  const sellIsStock = sellInfo.kind === 'STOCK';
  const buyIsStock = buyInfo.kind === 'STOCK';
  const sellFeeRules = sellIsStock ? stockRules.fees : fees;
  const buyFeeRules = buyIsStock ? stockRules.fees : fees;
  const sellMultiple = sellIsStock ? stockRules.sell_multiple : lots.etf_sell_multiple;
  const buyLot = buyIsStock ? stockRules.lot_size : lots.etf_lot_size;
  const buyMin = buyIsStock ? stockRules.min_buy : lots.etf_min_buy;
  const buyUnit = buyIsStock ? '股' : '份';
  const sellQuote = quotes.get(sellCode);
  const buyQuote = quotes.get(buyCode);
  const position = state.positions.find(p => normalizeSecurityCode(p.ts_code) === sellCode);
  const reasons: Reason[] = [];
  const shares = action.sell_shares;

  if (!sellInfo.found) reasons.push({ code: 'instrument_unknown', detail: `卖出标的：${sellInfo.detail}` });
  if (!buyInfo.found) reasons.push({ code: 'instrument_unknown', detail: `买入标的：${buyInfo.detail}` });
  if (!Number.isInteger(shares) || shares <= 0) reasons.push({ code: 'invalid_input', detail: `卖出数量必须为正整数，收到 ${shares}` });
  else if (shares % sellMultiple !== 0) reasons.push({ code: 'lot_rule', detail: `卖出 ${shares} 不是 ${sellMultiple} 的整数倍` });
  if (sellCode === buyCode) reasons.push({ code: 'same_instrument', detail: '卖出与买入为同一标的，不构成轮动' });
  if (!position) reasons.push({ code: 'insufficient_position', detail: `账户快照不持有 ${sellCode}` });
  else if (Number.isInteger(shares) && shares > position.quantity) reasons.push({ code: 'insufficient_position', detail: `拟卖出 ${shares}，超过持仓 ${position.quantity}` });

  // 权限只依据解析结果；调用方的 buy_kind/buy_board 只用来核对是否自相矛盾。
  if (buyInfo.found) {
    const claim: InstrumentClaim = { kind: action.buy_kind, board: action.buy_board };
    const claimCheck = checkInstrumentClaim(claim, buyInfo);
    if (!claimCheck.ok) reasons.push({ code: 'instrument_claim_mismatch', detail: claimCheck.detail ?? '标的声明与缓存不符' });
    const tradability = tradabilityOf(buyCode, { kind: buyInfo.kind as InstrumentInfo['kind'], board: buyInfo.board ?? undefined });
    if (!tradability.tradable) reasons.push({ code: 'permission_restricted', detail: tradability.detail ?? `${buyCode} 无交易权限` });
  }

  for (const [label, quote] of [['sell', sellQuote], ['buy', buyQuote]] as const) {
    if (!quote || !quote.available) {
      reasons.push({ code: quote?.reason ?? 'candidate_not_cached', detail: quote?.detail ?? `${label} 标的无缓存行情` });
      continue;
    }
    if (quote.quality !== 'READY') reasons.push({ code: 'quote_stale', detail: `${quote.ts_code} 缓存行情为 ${quote.trade_date}，不是 ${asOf}` });
    if (quote.suspended) reasons.push({ code: 'instrument_suspended', detail: `${quote.ts_code} 停牌` });
    if (quote.list_status && quote.list_status !== 'L') reasons.push({ code: 'instrument_not_tradable', detail: `${quote.ts_code} 上市状态 ${quote.list_status}` });
  }
  for (const r of accountIssues) reasons.push(r);
  if (!tradingDayOk) reasons.push({ code: 'as_of_not_trading_day', detail: `${asOf} 不是交易日` });
  if (!evidence.verified) {
    reasons.push({
      code: evidence.supplied ? 'rotation_advantage_unverified' : 'no_demonstrated_advantage',
      detail: evidence.supplied ? `轮动优势未通过研究证据校验（${evidence.reason ?? 'unknown'}），只能作为示意` : '未提供轮动优势研究证据',
    });
  }

  const canCompute = !!position && Number.isInteger(shares) && shares > 0
    && !!sellQuote?.available && !!buyQuote?.available;
  let legs: TradeLeg[] = [];
  const after = cloneState(state);
  let sellCashDelta: number | null = null;
  if (canCompute) {
    const sell = sellLeg(sellCode, shares, sellQuote as CachedQuote, sellMultiple, sellFeeRules, sellIsStock ? 'STOCK' : 'ETF');
    legs.push(sell);
    sellCashDelta = sell.cash_delta_cents;
    const budget = state.cash_cents + sell.cash_delta_cents;
    const lotCost = valueCents(buyLot, (buyQuote as CachedQuote).price_milli);
    const buyLots = affordableLots(budget, lotCost, buyFeeRules);
    if (buyLots * buyLot < buyMin) {
      reasons.push({ code: 'insufficient_cash_for_one_lot', detail: `可用资金 ${(budget / 100).toFixed(2)} 元不足买入一手 ${buyCode}（${buyLot} ${buyUnit}）` });
      legs = [];
    } else {
      legs.push(buyLeg(buyCode, buyLots, buyQuote as CachedQuote, buyLot, buyFeeRules, buyIsStock ? 'STOCK' : 'ETF'));
    }
    const target = after.positions.find(p => normalizeSecurityCode(p.ts_code) === sellCode)!;
    const soldMv = target.quantity > 0 ? Math.round((target.market_value_cents * shares) / target.quantity) : 0;
    target.quantity -= shares;
    target.market_value_cents -= soldMv;
    const buy = legs.find(l => l.side === 'BUY');
    if (buy) {
      const existing = after.positions.find(p => normalizeSecurityCode(p.ts_code) === buyCode);
      if (existing) {
        existing.quantity += buy.quantity;
        existing.market_value_cents += buy.gross_cents;
      } else {
        after.positions.push({
          ts_code: buyCode, name: buy.name ?? buyCode, quantity: buy.quantity, market_value_cents: buy.gross_cents,
          asset_class: (buyQuote as CachedQuote).asset_class,
          theme: THEME_BY_CODE[buyCode] ?? 'unknown',
          industry: INDUSTRY_BY_CODE[buyCode] ?? 'unclassified',
          basis: 'server_cache_close',
        });
      }
    }
    if (sellCashDelta !== null) {
      after.cash_cents = state.cash_cents + sellCashDelta - (buy ? buy.gross_cents + buy.fees.total_cents : 0);
    }
    recomputeTotals(after);
  }

  const status = statusOfReasons(reasons, canCompute && legs.length === 2);
  const executable = status === 'ACTIONABLE' && legs.length === 2;

  return {
    ...base,
    available: true,
    status,
    executable,
    reasons,
    legs: executable ? legs : [],
    illustrative_legs: executable ? [] : asIllustrative(legs),
    cash: cashOf(state.cash_cents, legs),
    exposure: exposureOf(after, !executable),
    stress: stressOf(after, stressRules),
    fees: feeSummary(legs, fees),
    quote_dates: {
      [sellCode]: sellQuote?.available ? sellQuote.trade_date : null,
      [buyCode]: buyQuote?.available ? buyQuote.trade_date : null,
    },
    t_plus_one: sellIsStock || buyIsStock,
  };
}

function degradeOption(option: DecisionOption, status: DecisionStatus, reasons: Reason[]): DecisionOption {
  const illustrative = option.legs.length ? option.legs : option.illustrative_legs;
  return {
    ...option,
    status,
    executable: false,
    legs: [],
    illustrative_legs: asIllustrative(illustrative),
    exposure: option.exposure ? { ...option.exposure, illustrative: true, note: '示意投影：基于非当前交易状态或快照参考价，不是可执行结果，也不是收益预测。' } : null,
    reasons: [...option.reasons, ...reasons.filter(r => !option.reasons.some(x => x.code === r.code && x.detail === r.detail))],
  };
}

function optionActionOf(type: DecisionAction['type']): OptionAction {
  switch (type) {
    case 'HOLD': return 'HOLD';
    case 'REDUCE_EQUITY': return 'REDUCE_EQUITY';
    case 'SELL_AND_BUY': return 'SELL_AND_BUY';
    case 'NO_ACTION': return 'NO_ACTION';
  }
}

function normalizeEvidence(
  claim: RotationClaim | null | undefined,
  ctx: { portfolioDb: DatabaseSync | null; asOf: string; buyCode: string | null; sellCode: string | null },
): DecisionResult['evidence'] {
  if (!claim) {
    return {
      supplied: false, source: null, verified: false, evidence_id: null, as_of: null, claim: null,
      reason: null, record_status: null, strategy_id: null, valid_until: null,
      note: '未提供轮动优势研究证据；按 PRD §6 不做交易。',
    };
  }
  const evidenceId = claim.evidence_id?.trim() || null;
  const result = verifyResearchEvidence(ctx.portfolioDb, { evidence_id: evidenceId }, {
    buyCode: ctx.buyCode ?? '',
    sellCode: ctx.sellCode,
    asOf: ctx.asOf,
  });
  const sourceMatches = claim.source === 'RESEARCH_VERIFIED';
  const verified = sourceMatches && result.verified;
  const reason: DecisionResult['evidence']['reason'] = verified
    ? null
    : (!sourceMatches && result.verified ? 'evidence_source_unverified' : result.reason);
  return {
    supplied: true,
    source: claim.source,
    verified,
    evidence_id: evidenceId,
    as_of: result.record?.as_of ?? claim.as_of ?? null,
    claim: claim.claim,
    reason,
    record_status: result.record?.status ?? null,
    strategy_id: result.record?.strategy_id ?? null,
    valid_until: result.record?.valid_until ?? null,
    note: verified
      ? '轮动优势来自账户库中的 VERIFIED 研究记录，代码与日期已复核；仍不构成收益保证。'
      : `轮动优势未通过复核（${reason ?? 'unknown'}）：布尔值、调用方自述或查不到的 evidence_id 都不会转换成交易信号。`,
  };
}

// ---------------------------------------------------------------- decision_id

/**
 * decision_id：对不含时间戳的规范化输入做 sha256。同一账户快照、同一缓存行情、
 * 同一动作、同一证据与同一规则版本必然得到同一 ID。
 */
function decisionId(
  input: DecisionInput, quotes: Map<string, QuoteLookup>,
  fees: FeeRules, lots: LotRules, stress: AssetClassStressRules,
  evidence: DecisionResult['evidence'], accountStatus: AccountStatusEvaluation,
): string {
  const canonical = JSON.stringify({
    schema: 'ashare-portfolio-decision/1.0',
    account_id: input.account_id,
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_as_of: input.snapshot.as_of,
    snapshot_is_current: input.snapshot.is_current === true,
    snapshot_totals: input.snapshot.totals,
    positions: input.snapshot.positions
      .map(p => [p.ts_code, p.quantity, p.market_value_cents])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    as_of_trade_date: input.as_of_trade_date,
    action: input.action,
    reduce: input.reduce ?? null,
    stock_plan: input.stock_plan ?? null,
    quotes: [...quotes.values()]
      .sort((a, b) => a.ts_code.localeCompare(b.ts_code))
      .map(q => [q.ts_code, q.available ? q.trade_date : null, q.available ? q.price_milli : null, q.available ? q.asset_class : null, q.available ? q.quality : q.reason]),
    evidence: {
      source: evidence.source, verified: evidence.verified, evidence_id: evidence.evidence_id,
      as_of: evidence.as_of, claim: evidence.claim, reason: evidence.reason, strategy_id: evidence.strategy_id,
    },
    account_status: {
      ok: accountStatus.ok, gate: accountStatus.gate, is_current: accountStatus.is_current,
      snapshot_as_of: accountStatus.snapshot_as_of, as_of: accountStatus.as_of,
      pending_settlement_cents: accountStatus.pending_settlement_cents,
    },
    rules: {
      fees, lots,
      stress_version: stress.version,
      stress_shocks: stress.shocks,
      industry_map_version: INDUSTRY_MAP_VERSION,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}
