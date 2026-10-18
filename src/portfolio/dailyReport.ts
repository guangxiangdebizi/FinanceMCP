import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { latestSnapshot, readSnapshot, valueCents, type AccountSnapshot } from './account.js';
import { buildResearchSummary } from './researchSummary.js';
import { DEFAULT_FEE_RULES, DEFAULT_LOT_RULES, type FeeRules, type LotRules } from './rules.js';
import { screenEtfCandidates, type EtfCandidateRow, type EtfCandidateScreenResult } from '../ashare/etfUniverse.js';

/**
 * D1 收盘日报：先给“下一交易日最值得做的 0–3 个动作及理由”。
 *
 * 设计边界（PRD §9 / §10 / §13）：
 * - 所有事实（持仓、行情、市场环境、数据质量）都来自 `buildResearchSummary`，
 *   本模块**不重复实现**估值/取价/市场证据。
 * - 所有数字都由程序计算：本文件不做任何 LLM 算术，也不接受调用方传入的数量/价格。
 * - 可执行数量只在一个条件下出现：账户门控（当前快照 + REAL_ACCOUNT_VERIFIED +
 *   同一交易日 + 无未交收卖出）**全部**满足。否则每个腿都是 `executable:false`，
 *   放在 `illustrative` 块里。
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
  /** 目标交易日 YYYYMMDD（收盘日报即该交易日）。 */
  asOfTradeDate: string;
  snapshotId?: string;
  /** 账户确认时间（用户确认当前账户的 ISO 时间）；缺省取快照记录。 */
  accountConfirmedAt?: string | null;
  /** 行情更新时间（ISO）；缺省取缓存同步日志，缺失时 null。 */
  quoteUpdatedAt?: string | null;
  /** 生成时间（ISO）；仅作为展示字段，不参与任何计算，也不进入报告哈希。 */
  generatedAt?: string | null;
  /** 候选池筛选类别；缺省全部。 */
  categories?: readonly string[];
  /** 动作上限（0–3），默认 3。 */
  maxActions?: number;
  /** 费用/交易单位假设；缺省 rules.ts 的默认值。 */
  fees?: FeeRules;
  lots?: LotRules;
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
  fact_meta: FactMeta;
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
  data_quality: {
    status: 'OK' | 'DEGRADED' | 'INSUFFICIENT';
    summary_status: string;
    missing_fields: string[];
    quotes: { ready: string[]; stale: string[]; not_ready: string[]; missing: string[] };
    market_report: { available: boolean; report_id: string | null; as_of_trade_date: string | null; freshness: string };
    screening: { status: string; missing_tables: string[] };
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
    reasons: { code: string; detail: string }[];
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

/** 买入腿费用（假设值）：佣金（含最低）+ 过户费 + 单边滑点。 */
function buyFeesCents(grossCents: number, fees: FeeRules): number {
  if (!(grossCents > 0)) return 0;
  return Math.max(fees.commission_min_cents, Math.round(grossCents * fees.commission_rate))
    + Math.round(grossCents * fees.transfer_fee_rate)
    + Math.round(grossCents * fees.slippage_rate_per_side);
}

/** 卖出腿费用（假设值）：佣金（含最低）+ 过户费 + 印花税 + 单边滑点。 */
function sellFeesCents(grossCents: number, fees: FeeRules): number {
  if (!(grossCents > 0)) return 0;
  return Math.max(fees.commission_min_cents, Math.round(grossCents * fees.commission_rate))
    + Math.round(grossCents * fees.transfer_fee_rate)
    + Math.round(grossCents * fees.stamp_duty_rate)
    + Math.round(grossCents * fees.slippage_rate_per_side);
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

function legOf(
  side: 'SELL' | 'BUY', code: string, name: string | null, quantity: number | null,
  priceMilli: number | null, quoteTradeDate: string | null, ctx: ActionContext, gateReason: string | null,
): ActionLeg {
  const lotSize = ctx.lots.etf_lot_size;
  const lots = quantity === null ? null : Math.floor(quantity / lotSize);
  const gross = quantity !== null && priceMilli !== null ? valueCents(quantity, priceMilli) : null;
  const fee = gross === null ? null : side === 'SELL' ? sellFeesCents(gross, ctx.fees) : buyFeesCents(gross, ctx.fees);
  const net = gross === null || fee === null ? null : side === 'SELL' ? gross - fee : -(gross + fee);
  return {
    side, ts_code: code, name, quantity, lot_size: lotSize, lots,
    price_milli: priceMilli, gross_cents: gross, fees_cents: fee, net_cents: net,
    quote_trade_date: quoteTradeDate,
    executable: ctx.gateSatisfied && gateReason === null,
    reason: ctx.gateSatisfied ? gateReason : (gateReason ?? 'account_gate_unsatisfied'),
  };
}

/**
 * 选择动作。优先级（PRD §9）：重大持仓风险 → 现有仓位审视 → 再配置 → 新机会。
 * 本实现只用**可复核的事实**：行情质量、市场证据方向、候选与现金的比较。
 * 没有满足条件的事实时不生成动作，由调用方返回 NO_ACTION。
 *
 * 注意：“等待行情补齐”不是交易动作，不能算作 0–3 个动作之一；它作为
 * `blockers` 返回，由调用方并入 NO_ACTION 的观察触发条件。
 */
function buildActions(ctx: ActionContext): { actions: ActionPlan[]; blockers: string[] } {
  const { summary, asOf } = ctx;
  const actions: ActionPlan[] = [];
  const blockers: string[] = [];
  const holdings: any[] = Array.isArray(summary.holdings) ? summary.holdings : [];
  const evidence = summary.market_evidence ?? { support: [], contradiction: [] };
  const staleHoldings = holdings.filter(holding => holding.bar_quality !== 'READY');
  const topHolding = holdings.length > 0 ? holdings.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;
  const concentration = summary.portfolio?.concentration ?? { hhi: null, effective_positions: null };

  // ---- 行情过期/缺失：任何动作都不可靠 → 不生成动作，只记录阻塞原因。
  if (staleHoldings.length > 0) {
    const codes = staleHoldings.map(holding => holding.ts_code);
    blockers.push(
      `${codes.join('、')} 的最新 bar 不是目标交易日或缺失；行情补齐前不生成任何交易动作。`,
      '触发条件：目标交易日的 fund_daily 收盘 bar 落库且通过 OHLC 校验，行情质量回到 READY。',
      '失效条件：出现新的、可复核的重大持仓风险事实时，本等待结论立即失效并重新评估。',
    );
    return { actions, blockers };
  }

  // ---- 动作 2：集中度 + 市场反证 → 降低单一持仓（只示意，不猜数量）
  const contradictionCount = Array.isArray(evidence.contradiction) ? evidence.contradiction.length : 0;
  const supportCount = Array.isArray(evidence.support) ? evidence.support.length : 0;
  if (topHolding && contradictionCount > supportCount && topHolding.weight >= 0.5) {
    const sellShares = Math.floor(topHolding.quantity / ctx.lots.etf_sell_multiple) * ctx.lots.etf_sell_multiple;
    // 只给“降低到总资产 50% 以下”所需的最小整手数量，作为**示意**，不是建议数量。
    const totalAssetsCents = summary.portfolio?.total_assets_cents ?? 0;
    const targetCents = Math.round(totalAssetsCents * 0.5);
    const excessCents = Math.max(0, topHolding.market_value_cents - targetCents);
    const sharesForExcess = topHolding.price_milli > 0 ? Math.ceil((excessCents * 10) / topHolding.price_milli) : 0;
    const illustrativeShares = Math.min(
      sellShares,
      Math.ceil(sharesForExcess / ctx.lots.etf_sell_multiple) * ctx.lots.etf_sell_multiple,
    );
    const quantity = illustrativeShares > 0 ? illustrativeShares : null;
    const leg = legOf('SELL', topHolding.ts_code, topHolding.name, quantity, topHolding.price_milli,
      topHolding.latest_bar_date, ctx, quantity === null ? 'quantity_unavailable' : null);
    actions.push({
      code: 'REDUCE_CONCENTRATION',
      kind: 'REDUCE',
      rank: 2,
      title: `审视 ${topHolding.name}（${topHolding.ts_code}）的集中度`,
      reasons: [
        `${topHolding.ts_code} 权重 ${(topHolding.weight * 100).toFixed(2)}%，占总资产一半以上`,
        `市场反证 ${contradictionCount} 项多于支持 ${supportCount} 项（见市场证据）`,
        `组合 HHI ${concentration.hhi}，有效持仓数 ${concentration.effective_positions}`,
      ],
      counter_evidence: [
        '集中度本身不是卖出理由；降低集中度也不意味着必须清空该资产（PRD §6）。',
        '若行业相对强弱仍为正，减仓可能带来机会成本。',
        '浮亏状态不构成必须等待回本的理由，也不构成必须卖出的理由。',
      ],
      legs: [leg],
      illustrative: { executable: false, legs: [{ ...leg, executable: false }] },
      fees_cents: leg.fees_cents,
      fees_assumed: true,
      triggers: [
        `下一交易日收盘价仍低于 ${topHolding.latest_bar_date} 的收盘参考，且市场反证未减少`,
        '用户已确认当前账户与可用现金口径',
      ],
      invalidation_conditions: [
        '市场证据转为支持项占多数，且该持仓行业相对强弱转正',
        '出现可复核的重大基本面事实改变集中度判断',
      ],
      risk_impact: [
        '降低单一标的暴露，同时等比例降低上涨参与度',
        '卖出回款进入现金，现金比例上升；不自动买入替代资产',
      ],
      fact_meta: {
        as_of: topHolding.latest_bar_date, source: 'research_summary + fund_daily', quality: 'OK', claim_status: 'FACT',
        detail: '权重、HHI 与证据计数都是程序计算；结论方向是研究判断，标记 UNVERIFIED。',
      },
    });
  }

  // ---- 动作 3：候选 vs 现金 → 轮动示意（只在现金不足/候选更优时提出）
  const competition = buildCandidateCashCompetition(summary, ctx.candidates, ctx.lots);
  const bestCandidate = competition.entries.find(entry =>
    entry.price_milli !== null && entry.cash_sufficient_for_one_lot === false && entry.status !== 'DEGRADED');
  if (bestCandidate && actions.length < 3) {
    const sellHolding = topHolding ?? holdings[0] ?? null;
    const buyLeg = legOf('BUY', bestCandidate.ts_code, bestCandidate.name, bestCandidate.one_lot_cents && bestCandidate.price_milli
      ? Math.floor((bestCandidate.one_lot_cents * 10) / bestCandidate.price_milli / ctx.lots.etf_lot_size) * ctx.lots.etf_lot_size
      : null, bestCandidate.price_milli, null, ctx, 'candidate_quote_date_unknown');
    const sellLeg = sellHolding
      ? legOf('SELL', sellHolding.ts_code, sellHolding.name,
        Math.floor(sellHolding.quantity / ctx.lots.etf_sell_multiple) * ctx.lots.etf_sell_multiple,
        sellHolding.price_milli, sellHolding.latest_bar_date, ctx, 'rotation_advantage_unverified')
      : null;
    actions.push({
      code: 'ROTATE_CANDIDATE_VS_CASH',
      kind: 'ROTATE',
      rank: actions.length + 1,
      title: `比较 ${bestCandidate.name ?? bestCandidate.ts_code} 与现金`,
      reasons: [
        `现金 ${((competition.cash_cents ?? 0) / 100).toFixed(2)} 元不足以买入一手候选（一手约 ${((bestCandidate.one_lot_cents ?? 0) / 100).toFixed(2)} 元）`,
        `候选 ${bestCandidate.ts_code} 的筛选状态 ${bestCandidate.status}，启发式分 ${bestCandidate.score ?? '不可用'}`,
        '候选筛选只是研究排序，不构成相对优势证据。',
      ],
      counter_evidence: [
        '没有可追溯的 RESEARCH_VERIFIED 研究证据，轮动优势按 UNVERIFIED 处理（PRD §6）。',
        '卖出持仓会改变行业暴露，且可能承担冲击成本。',
        '现金本身是合法的防御仓位。',
      ],
      legs: sellLeg ? [sellLeg, buyLeg] : [buyLeg],
      illustrative: { executable: false, legs: (sellLeg ? [sellLeg, buyLeg] : [buyLeg]).map(leg => ({ ...leg, executable: false })) },
      fees_cents: (sellLeg?.fees_cents ?? 0) + (buyLeg.fees_cents ?? 0),
      fees_assumed: true,
      triggers: [
        '候选有与卖出标的同日的缓存行情，且价格未被标记为过期',
        '用户确认当前账户与可用现金',
        '出现可追溯的轮动优势研究证据（evidence_id）',
      ],
      invalidation_conditions: [
        '候选在下一交易日停牌、涨跌停或流动性不足',
        '候选相对持仓的行业相对强弱转为不利',
        '账户现金已足够买入一手候选，无需卖出',
      ],
      risk_impact: [
        '换仓前后行业集中度与资产类别暴露需要重新核对',
        '费用按假设值扣除，真实费用以券商对账单为准',
      ],
      fact_meta: {
        as_of: asOf, source: 'etf_candidate_screen + research_summary', quality: 'DEGRADED', claim_status: 'UNVERIFIED',
        detail: '候选筛选状态与分数是程序计算；相对优势主张未经前瞻检验。',
      },
    });
  }

  return { actions: actions.slice(0, 3), blockers };
}

// ---------------------------------------------------------------- 候选 vs 现金

function buildCandidateCashCompetition(
  summary: any, screening: EtfCandidateScreenResult | null, lots: LotRules,
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
    return {
      ts_code: candidate.ts_code,
      name: candidate.name,
      category: candidate.category,
      status: candidate.status,
      score: candidate.score,
      price_milli: priceMilli,
      one_lot_cents: lotCost,
      cash_sufficient_for_one_lot: lotCost === null || cashCents === null ? null : cashCents >= lotCost,
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
  const { portfolioDb, marketDb, accountId } = input;
  const fees = input.fees ?? DEFAULT_FEE_RULES;
  const lots = input.lots ?? DEFAULT_LOT_RULES;
  const maxActions = input.maxActions === undefined ? 3 : Math.max(0, Math.min(3, Math.trunc(input.maxActions)));

  // 复用研究摘要：持仓、行情质量、市场环境与证据都来自这里，不重复实现。
  const summary = buildResearchSummary({
    portfolioDb,
    marketDb,
    accountId,
    asOfTradeDate: asOf,
    snapshotId: input.snapshotId,
  });

  const snapshot: AccountSnapshot | undefined = input.snapshotId
    ? readSnapshot(portfolioDb, input.snapshotId)
    : latestSnapshot(portfolioDb);

  // 账户门控：与研究摘要/决策一致的硬条件。
  const accountStatus: string = summary.account_status ?? 'REAL_ACCOUNT_PENDING';
  const snapshotIsCurrent = snapshot?.is_current === true;
  const gateReasons: { code: string; detail: string }[] = [];
  if (!snapshotIsCurrent) gateReasons.push({ code: 'account_not_current', detail: '账户快照 is_current=false（PRD §3 截图基线只能研究）' });
  if (accountStatus !== 'REAL_ACCOUNT_VERIFIED') gateReasons.push({ code: 'account_not_verified', detail: `账本门控为 ${accountStatus}，未确认为真实账户` });
  if (snapshot && snapshot.as_of.replace(/-/g, '') !== asOf) {
    gateReasons.push({ code: 'account_snapshot_stale', detail: `快照日期 ${snapshot.as_of} 与目标交易日 ${asOf} 不同（0 天容忍）` });
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
  let status: DailyReportStatus;
  if (insufficient) status = 'DATA_INSUFFICIENT';
  else if (actions.length === 0) status = 'NO_ACTION';
  else status = gateSatisfied ? 'ACTIONABLE' : 'ILLUSTRATIVE';

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
    : built.blockers;

  const market = summary.market_context ?? {};
  const evidence = summary.market_evidence ?? { support: [], contradiction: [] };
  const holdings: HoldingAssessment[] = (summary.holdings ?? []).map((holding: any) => {
    const stance: HoldingAssessment['stance'] = holding.bar_quality !== 'READY' ? 'WAIT' : 'HOLD';
    const themeEvidence = evidence.contradiction.find((item: any) => item.id === `theme_relative_strength:${holding.theme}`);
    const supportEvidence = evidence.support.find((item: any) => item.id === `theme_relative_strength:${holding.theme}`);
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
      fact_meta: {
        as_of: holding.latest_bar_date, source: `research_summary:${holding.source}`, quality: holding.bar_quality === 'READY' ? 'OK' : 'DEGRADED', claim_status: 'FACT',
      },
    };
  });

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

  const reportId = createHash('sha256').update(JSON.stringify({
    schema: DAILY_REPORT_SCHEMA,
    account_id: accountId,
    snapshot_id: snapshot?.snapshot_id ?? null,
    as_of_trade_date: asOf,
    account_status: accountStatus,
    gate_satisfied: gateSatisfied,
    status,
    actions: normalizedActions.map(action => [action.code, action.legs.map(leg => [leg.side, leg.ts_code, leg.quantity, leg.price_milli])]),
    holdings: holdings.map(holding => [holding.ts_code, holding.quantity, holding.price_milli, holding.bar_quality]),
    screening_status: screening?.data_coverage.status ?? null,
  })).digest('hex');

  const concentration = summary.portfolio?.concentration ?? { hhi: null, effective_positions: null };
  const equityClass = (summary.portfolio?.by_asset_class ?? []).find((row: any) => row.asset_class === 'EQUITY');

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
        : status === 'DATA_INSUFFICIENT' ? '数据不足，无法给出动作。' : null,
      observation_triggers: observationTriggers,
    },
    as_of_trade_date: asOf,
    expected_next_trade_date: nextTradeDay(marketDb, asOf),
    timestamps: {
      as_of_trade_date: asOf,
      account_confirmed_at: input.accountConfirmedAt ?? snapshot?.is_current_confirmed_at ?? null,
      quote_updated_at: input.quoteUpdatedAt ?? quoteUpdatedAt(marketDb),
      generated_at: input.generatedAt ?? null,
    },
    account_status: accountStatus,
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
    candidate_vs_cash: buildCandidateCashCompetition(summary, screening, lots),
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
      reasons: gateReasons,
      note: '可执行要求：当前确认快照 + 账本 REAL_ACCOUNT_VERIFIED + 同一交易日 + 无未交收卖出。未满足时每个腿 executable=false。',
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
