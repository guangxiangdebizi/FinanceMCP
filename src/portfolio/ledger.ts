import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { inPortfolioTransaction, ledgerTablesPresent } from './db.js';
import { readSnapshot, round, valueCents } from './account.js';

/**
 * P2 最小真实账户账本（PRD §8）。
 *
 * 设计边界：
 * - **事实行只追加**。成交/出入金/分红/费用/拆分一经记录永不删除、永不覆盖经济字段；
 *   纠错只能追加一条 REVERSE 撤销分录。注意：撤销时会更新**原记录**的 `reversed_by`
 *   列，这是"状态索引更新"，不是追加一行；因此不要声称整张表每一列都完全不可变。
 *   追加式事件行、`event_id` 幂等、冲突表留痕与撤销语义保持不变。
 * - **派生而非存储**。持仓、可用现金、成本、已实现盈亏全部由
 *   `account_baseline + account_event` 确定性重放得出，库里不存余额，避免两份真相。
 * - **幂等**。`event_id` 由调用方（券商流水号/导入行号）提供；同一 id 同一内容
 *   只算一次，同一 id 不同内容写冲突表并拒绝覆盖。
 * - **整数口径**。金额整数分，价格整数厘，数量整数份/股；净值与均价是派生比例，
 *   单独用小数并在字段名上标注。
 *
 * 明确不是：事件溯源框架、撮合引擎、券商对接。就是几张表和几个纯函数。
 *
 * 未与券商核对的假设（输出中逐条带 `assumptions`）：
 * - 交收规则按品种分类：股票、股票/权益 ETF → T+1；债券 ETF、黄金 ETF 与规则内
 *   跨境 QDII ETF → T+0；无法分类的标的保守按 T+1 并标注 `settlement_rule_assumed`。
 * - 交收日优先取本地 `trade_cal` 的下一个开市日；日历缺失时退回"只跳周末"的
 *   `nextBusinessDay` 并标注 `calendar_assumed:true`。
 * - 卖出款在交收前可用于买入但不可提取（A 股常见规则，模型假设）：
 *   `buying_power_cents` 含未交收，`withdrawable_cents` 只含已交收。
 * - 平均成本法：买入费用计入成本；卖出费用与税费冲减卖出收入。
 * - 撤销按已结算现金立即回退。
 */

// ---------------------------------------------------------------- 常量与类型

export const LEDGER_EVENT_TYPES = [
  'TRADE_BUY', 'TRADE_SELL', 'CASH_DEPOSIT', 'CASH_WITHDRAW', 'DIVIDEND', 'FEE', 'SPLIT', 'REVERSE',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];
export type EventSource = 'synthetic' | 'broker_statement';
export type RecordMode = 'live' | 'dry_run';

/** REAL_ACCOUNT_PENDING 状态常量：未经用户显式确认，绝不把账本数据称作"真实账户业绩"。 */
export const REAL_ACCOUNT_PENDING = 'REAL_ACCOUNT_PENDING' as const;
export const REAL_ACCOUNT_VERIFIED = 'REAL_ACCOUNT_VERIFIED' as const;
export type RealAccountStatus = typeof REAL_ACCOUNT_PENDING | typeof REAL_ACCOUNT_VERIFIED;

export const ASSUMPTIONS: readonly string[] = [
  '交收规则：股票与股票/权益 ETF 卖出 T+1；债券 ETF、黄金 ETF 及规则内的跨境 QDII ETF 卖出 T+0（未与券商交割单核对）',
  '交收日优先取本地 trade_cal 的下一个开市日；日历缺失时退回只跳周末的下一个工作日并标注 calendar_assumed',
  'A 股卖出款在交收前通常可用于买入但不可提取：buying_power 含未交收，withdrawable 只含已交收（模型假设）',
  '无法识别的标的按保守的 T+1 处理，并标注 settlement_rule_assumed',
  '成本采用平均成本法：买入佣金与税费计入成本，卖出费用与印花税冲减卖出收入',
  '撤销（REVERSE）立即按已结算现金回退，不恢复原卖出的未交收状态；reversed_by 是对原行的状态索引更新',
  '净值按单位净值法（unitisation）处理外部现金流：采用日终现金流口径，按当日扣流前估值折算，初始单位净值 1.00 元',
];

/** 事件输入：派生字段可省略，由 `normalizeEvent` 校验后补齐。 */
export interface LedgerEventInput {
  event_id: string;
  account_id: string;
  event_type: LedgerEventType | string;
  occurred_on: string;
  settled_on?: string | null;
  ts_code?: string | null;
  quantity?: number | null;
  price_milli?: number | null;
  gross_cents?: number | null;
  fee_cents?: number | null;
  tax_cents?: number | null;
  cash_delta_cents?: number | null;
  ratio_num?: number | null;
  ratio_den?: number | null;
  reverses_event_id?: string | null;
  note?: string;
  source?: EventSource | string;
  /** 仅元数据，不参与内容哈希，也不影响重放结果。 */
  recorded_at?: string;
}

export interface NormalizedEvent {
  event_id: string;
  account_id: string;
  event_type: LedgerEventType;
  occurred_on: string;
  settled_on: string | null;
  ts_code: string | null;
  quantity: number | null;
  price_milli: number | null;
  gross_cents: number | null;
  fee_cents: number;
  tax_cents: number;
  cash_delta_cents: number;
  ratio_num: number | null;
  ratio_den: number | null;
  reverses_event_id: string | null;
  note: string;
  source: EventSource;
  recorded_at: string;
  /**
   * TRADE_SELL 的交收推导元数据（规则、是否假设、日历是否假设）。
   * 仅用于记录/输出，**不参与内容哈希**，也不写入事件表（事件表只存最终 `settled_on`）。
   */
  settlement_info?: SettlementInfo;
}

/** 卖出交收的推导结果，随 `RecordResult` 返回；重放时按代码重新推导规则部分。 */
export interface SettlementInfo {
  rule: SettlementRule;
  kind: SettlementInstrumentKind;
  /** settlement_rule_assumed：品种无法可靠分类，按保守 T+1。 */
  assumed: boolean;
  /** calendar_assumed：未使用真实 trade_cal，而是退回只跳周末的工作日。 */
  calendar_assumed: boolean;
  reason: string;
}

export type RecordResult =
  | {
    status: 'RECORDED'; event_id: string; event_type: LedgerEventType; cash_delta_cents: number;
    settled_on: string | null; content_hash: string;
    /** TRADE_SELL 才有：交收规则与假设标注。 */
    settlement?: SettlementInfo;
  }
  | { status: 'DUPLICATE'; event_id: string; event_type: LedgerEventType; content_hash: string }
  | { status: 'CONFLICT'; event_id: string; reason: string; existing_hash: string; incoming_hash: string };

export interface LedgerViolation {
  code: string;
  severity: 'error' | 'warning';
  date: string | null;
  event_id: string | null;
  detail: string;
}

export interface PositionState {
  ts_code: string;
  quantity: number;
  /** 整数厘；含买入费用的总成本。 */
  cost_milli_total: number;
  /** 派生均价（厘），保留 6 位小数；总额始终为整数厘。 */
  cost_milli_avg: number;
  realized_pnl_cents: number;
}

export interface ReplayResult {
  account_id: string;
  as_of: string | null;
  source: 'ledger_replay';
  data_source: 'synthetic' | 'broker_statement' | 'mixed' | 'baseline_only';
  baseline: { as_of: string; snapshot_id: string; cash_cents: number; note: string };
  positions: PositionState[];
  cash: {
    balance_cents: number;
    /** 已交收现金（模型里等价于可提取基数）。 */
    settled_cents: number;
    /** 已卖出但尚未到交收日的现金。 */
    unsettled_cents: number;
    /**
     * 可提取现金 = 已交收。未交收的卖出款不能提取（模型假设，未考虑冻结/在途）。
     * 现金为负时如实返回负数，由 validateLedger 报出。
     */
    withdrawable_cents: number;
    /**
     * 可用于买入的现金 = 已交收 + 未交收卖出款。A 股卖出款在交收前通常可用于
     * 继续买入（模型假设）；实际券商规则可能不同。
     */
    buying_power_cents: number;
  };
  totals: {
    securities_cost_cents: number;
    realized_pnl_cents: number;
    dividends_cents: number;
    fees_cents: number;
    taxes_cents: number;
    external_flow_cents: number;
  };
  pending_settlement: {
    ts_code: string; cents: number; settles_on: string;
    /** 由代码重新推导的交收规则（事件表只存 settled_on）。 */
    settlement_rule: SettlementRule;
    /** 品种无法可靠分类时为 true。 */
    settlement_rule_assumed: boolean;
  }[];
  events_applied: number;
  last_event_date: string | null;
  /** 账本数据是否已被用户确认为真实账户；未确认时为 REAL_ACCOUNT_PENDING。 */
  real_account_status: RealAccountStatus;
  assumptions: readonly string[];
}

export interface ValidateResult {
  ok: boolean;
  account_id: string;
  violations: LedgerViolation[];
  min_cash_balance_cents: number;
  events_checked: number;
  conflicts_recorded: number;
  assumptions: readonly string[];
}

/** 价格表：**按日期**组织 `{ "YYYYMMDD": { "代码": 厘价 } }`；缺某日即为缺价。 */
export type PriceTable = Record<string, Record<string, number>>;

export interface NavPoint {
  date: string;
  /** 元/份，保留 6 位小数；无法可靠估值时为 null（绝不编造）。 */
  nav_per_unit: number | null;
  total_value_cents: number;
  units: number;
  cash_cents: number;
  /**
   * - `ok`：全部持仓当日有价；
   * - `no_price`：有持仓缺当日价，按最近已知价/成本兜底（见 confidence）；
   * - `unitisation_skipped`：当日有外部现金流，但扣流前估值 <= 0 或份额为 0，无法可靠折算；
   * - `insufficient_valuation`：总估值 <= 0 或份额 <= 0，无法给出单位净值。
   */
  status: 'ok' | 'no_price' | 'unitisation_skipped' | 'insufficient_valuation';
  /**
   * 该估值点的可信程度：
   * - `exact`：每个持仓当日都有真实价格；
   * - `carried_forward`：部分持仓沿用最近已知价（缺价/停牌）；
   * - `cost_fallback`：部分持仓从未有过价格，按成本兜底；
   * - `incomplete`：无法可靠估值（单位净值不可计算）。
   */
  confidence: 'exact' | 'carried_forward' | 'cost_fallback' | 'incomplete';
  no_price_codes: string[];
  carried_forward_codes: string[];
  /** 从未有过价格、只能按成本兜底估值的代码（估值不是市价，单独标出）。 */
  cost_fallback_codes: string[];
  external_flow_cents: number;
}

export interface NavSeries {
  account_id: string;
  /** 未确认为真实账户时为 REAL_ACCOUNT_PENDING（PRD §8：不把账本算术当真实业绩）。 */
  status: RealAccountStatus;
  /** 只有 status 为 REAL_ACCOUNT_VERIFIED 时才为 true；否则序列只是已记录数据的算术结果。 */
  performance_available: boolean;
  data_source: ReplayResult['data_source'];
  from: string;
  to: string;
  points: NavPoint[];
  /**
   * 最大回撤：只用基线之后的估值点。少于两个点 → `insufficient_history`（绝不回填历史）。
   * 该数值是所给价格与事件的算术结果，是否可当作"真实账户业绩"由上面的 status 决定。
   * `valuation_quality` 只在所有参与点都是 `exact` 时为 `exact`；任一缺价、
   * 沿用价格或成本兜底都降级为 `incomplete` 并列出日期，绝不把不完整估值
   * 报告成精确真实回撤。
   */
  max_drawdown:
    | {
      available: true; value: number; from: string | null; to: string | null;
      valuation_quality: 'exact' | 'incomplete';
      incomplete_dates: string[];
      note: string | null;
    }
    | { available: false; reason: 'insufficient_history' | 'no_baseline' };
  assumptions: readonly string[];
  note: string;
}

// ---------------------------------------------------------------- 基础校验

const YMD = /^\d{8}$/;

/** 6 位代码按前缀识别 ETF。识别不出来时按股票（T+1）处理，属于保守方向。 */
export function isEtfCode(tsCode: string): boolean {
  const digits = tsCode.split('.')[0].replace(/[^0-9]/g, '');
  if (digits.length !== 6) return false;
  return /^(15|16|18|50|51|52|56|58)/.test(digits);
}

/**
 * 卖出交收规则（T+0 / T+1）。
 *
 * 口径（最小、可复核的规则，不是完整交易所规则库）：
 * - 债券 ETF（511xxx）、黄金 ETF（518xxx、159934/159937）、规则内的跨境 QDII ETF
 *   （513xxx、159920、159941）→ T+0；
 * - 其余股票/权益 ETF（15/16/18/50/51/52/56/58 前缀）与所有股票 → T+1；
 * - 无法分类 → T+1（保守方向），并置 `assumed:true`。
 *
 * `kind`/`name` 只是**无法由代码判定时**的兜底提示；已识别的代码永远优先，
 * 避免把名称含"恒生"的境内权益 ETF 误判为跨境（A2 的同类陷阱）。
 */
export type SettlementRule = 'T+0' | 'T+1';
export type SettlementInstrumentKind =
  | 'STOCK' | 'EQUITY_ETF' | 'BOND_ETF' | 'GOLD_ETF' | 'CROSS_BORDER_ETF' | 'UNKNOWN';

export interface SettlementDecision {
  ts_code: string;
  rule: SettlementRule;
  kind: SettlementInstrumentKind;
  /** 是否因无法可靠分类而按保守 T+1 假设（settlement_rule_assumed）。 */
  assumed: boolean;
  reason: string;
}

const GOLD_ETF_CODES = new Set(['159934', '159937']);
const CROSS_BORDER_ETF_CODES = new Set(['159920', '159941']);

function digitsOf(tsCode: string): string {
  return (tsCode.split('.')[0] ?? '').replace(/[^0-9]/g, '');
}

/** 股票代码前缀（沪深主板、科创板、创业板、北交所）。全部 T+1。 */
const STOCK_PREFIX = /^(600|601|603|605|688|689|000|001|002|003|300|301|4\d{2}|8\d{2}|920)/;

function kindFromHint(hint: string | undefined): SettlementInstrumentKind | null {
  const text = (hint ?? '').trim().toUpperCase();
  if (!text) return null;
  if (/^(STOCK|SHARE|EQUITY_STOCK)$/.test(text) || text === '股票') return 'STOCK';
  if (/^(BOND|BOND_ETF|FIXED_INCOME)$/.test(text) || /债/.test(hint!)) return 'BOND_ETF';
  if (/^(GOLD|GOLD_ETF|COMMODITY)$/.test(text) || /黄金|白银/.test(hint!)) return 'GOLD_ETF';
  if (/^(CROSS_BORDER|QDII|CROSS_BORDER_ETF)$/.test(text) || /跨境|QDII/i.test(hint!)) return 'CROSS_BORDER_ETF';
  if (/^(EQUITY|EQUITY_ETF|ETF|FUND)$/.test(text) || /ETF|基金/.test(hint!)) return 'EQUITY_ETF';
  return null;
}

function decision(
  tsCode: string, kind: SettlementInstrumentKind, rule: SettlementRule, assumed: boolean, reason: string,
): SettlementDecision {
  return { ts_code: tsCode, rule, kind, assumed, reason };
}

/** 由代码前缀（必要时用 kind/name 兜底）判定卖出交收规则。纯函数。 */
export function settlementRuleFor(
  tsCode: string, hints: { kind?: string; name?: string } = {},
): SettlementDecision {
  const digits = digitsOf(tsCode);
  if (digits.length !== 6) {
    return decision(tsCode, 'UNKNOWN', 'T+1', true, '代码不是 6 位数字，无法分类，按保守 T+1 处理');
  }

  if (isEtfCode(tsCode)) {
    if (/^511/.test(digits)) return decision(tsCode, 'BOND_ETF', 'T+0', false, '债券 ETF（511 前缀）支持 T+0 回转');
    if (/^518/.test(digits) || GOLD_ETF_CODES.has(digits)) {
      return decision(tsCode, 'GOLD_ETF', 'T+0', false, '黄金 ETF 支持 T+0 回转');
    }
    if (/^513/.test(digits) || CROSS_BORDER_ETF_CODES.has(digits)) {
      return decision(tsCode, 'CROSS_BORDER_ETF', 'T+0', false, '规则内跨境 QDII ETF 支持 T+0 回转');
    }
    // 其余 15/16/18/50/51/52/56/58 前缀按权益 ETF 处理；已知代码分类成立，不算假设。
    return decision(tsCode, 'EQUITY_ETF', 'T+1', false, '股票/权益 ETF 按 T+1 交收');
  }

  if (STOCK_PREFIX.test(digits)) {
    return decision(tsCode, 'STOCK', 'T+1', false, '股票按 T+1 交收');
  }

  // 代码无法判定时才看调用方的声明；声明也不足则保守 T+1。
  const hinted = kindFromHint(hints.kind) ?? kindFromHint(hints.name);
  if (hinted) {
    const rule: SettlementRule = hinted === 'EQUITY_ETF' || hinted === 'STOCK' ? 'T+1' : 'T+0';
    const Chinese = hinted === 'BOND_ETF' ? '债券 ETF' : hinted === 'GOLD_ETF' ? '黄金 ETF'
      : hinted === 'CROSS_BORDER_ETF' ? '跨境 QDII ETF' : hinted === 'STOCK' ? '股票' : '权益 ETF';
    return decision(tsCode, hinted, rule, true, `代码无法分类，按调用方声明的${Chinese}推断 ${rule}`);
  }
  return decision(tsCode, 'UNKNOWN', 'T+1', true, '代码与声明都无法分类，按保守 T+1 处理');
}

/** 交易日历的最小抽象：只要"下一个开市日"。缺失/无法回答时返回 undefined。 */
export interface SettlementCalendar {
  nextOpenDay(ymd: string): string | undefined;
}

/**
 * 从只读市场库的 `trade_cal` 构造交收日历。库内没有 `trade_cal` 或查询失败时
 * 一律返回 undefined，由 `normalizeEvent` 退回 `nextBusinessDay` 并标注假设。
 */
export function settlementCalendarFromDb(db: DatabaseSync): SettlementCalendar {
  let ready = false;
  try {
    ready = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_cal'").get();
  } catch {
    ready = false;
  }
  return {
    nextOpenDay(ymd: string): string | undefined {
      if (!ready) return undefined;
      try {
        const row = db.prepare(
          'SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date > ? ORDER BY cal_date ASC LIMIT 1',
        ).get(ymd) as any;
        return row?.cal_date ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** 下一个工作日（只跳周末，不跳节假日）。纯函数，不读当前时间。 */
export function nextBusinessDay(ymd: string): string {
  assertYmd(ymd, '日期');
  let y = Number(ymd.slice(0, 4));
  let m = Number(ymd.slice(4, 6));
  let d = Number(ymd.slice(6, 8));
  for (;;) {
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + 1);
    y = at.getUTCFullYear(); m = at.getUTCMonth() + 1; d = at.getUTCDate();
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) break;
  }
  return `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

function assertYmd(value: string | null | undefined, label: string): string {
  if (!value || !YMD.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 不能为空`);
  return value.trim();
}

/** 金额/价格/数量必须是安全整数：账本里不允许浮点分。 */
function intOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} 必须是整数`);
  return value;
}

function nonNegative(value: number | null, label: string): number {
  const v = value ?? 0;
  if (v < 0) throw new Error(`${label} 不能为负数`);
  return v;
}

// ---------------------------------------------------------------- 归一化与哈希

export interface NormalizeOptions {
  /** 真实交易日历；缺失时退回 `nextBusinessDay` 并标注 calendar_assumed。 */
  calendar?: SettlementCalendar;
}

/**
 * 把调用方输入整理成唯一确定的事件形态：补齐派生金额、推导交收日、统一 null。
 * 任何不合规输入都在这里拒绝，写库前就不会有半成品。
 *
 * 卖出交收：T+0 当日交收；T+1 优先用真实 `trade_cal` 的下一个开市日，
 * 日历缺失时退回 `nextBusinessDay`（只跳周末）并在 `settlement_info.calendar_assumed` 标注。
 */
export function normalizeEvent(input: LedgerEventInput, options: NormalizeOptions = {}): NormalizedEvent {
  const eventId = requireText(input.event_id, 'event_id');
  const accountId = requireText(input.account_id, 'account_id');
  const eventType = input.event_type as LedgerEventType;
  if (!LEDGER_EVENT_TYPES.includes(eventType)) throw new Error(`未知事件类型：${String(input.event_type)}`);
  const occurredOn = assertYmd(input.occurred_on, 'occurred_on');

  const source = (input.source ?? 'synthetic') as EventSource;
  if (source !== 'synthetic' && source !== 'broker_statement') throw new Error('source 需要 synthetic 或 broker_statement');

  const quantity = intOrNull(input.quantity, 'quantity');
  const priceMilli = intOrNull(input.price_milli, 'price_milli');
  const grossInput = intOrNull(input.gross_cents, 'gross_cents');
  const fee = nonNegative(intOrNull(input.fee_cents, 'fee_cents'), 'fee_cents');
  const tax = nonNegative(intOrNull(input.tax_cents, 'tax_cents'), 'tax_cents');
  const ratioNum = intOrNull(input.ratio_num, 'ratio_num');
  const ratioDen = intOrNull(input.ratio_den, 'ratio_den');
  const tsCode = input.ts_code === null || input.ts_code === undefined ? null : requireText(input.ts_code, 'ts_code');
  const note = input.note === undefined || input.note === null ? '' : String(input.note);

  let settledOn: string | null = input.settled_on ? assertYmd(input.settled_on, 'settled_on') : null;
  let cashDelta: number;
  let gross: number | null = grossInput;
  let settlementInfo: SettlementInfo | undefined;

  const forbid = (fields: [unknown, string][]) => {
    for (const [value, label] of fields) {
      if (value !== null && value !== undefined) throw new Error(`${eventType} 不接受字段 ${label}`);
    }
  };
  const requireTrade = () => {
    if (!tsCode) throw new Error(`${eventType} 需要 ts_code`);
    if (quantity === null || quantity <= 0) throw new Error(`${eventType} 的 quantity 必须是正整数`);
    if (priceMilli === null || priceMilli <= 0) throw new Error(`${eventType} 的 price_milli 必须是正整数（厘）`);
    if (gross !== null) {
      if (gross < 0) throw new Error('gross_cents 不能为负数');
      const derived = valueCents(quantity, priceMilli);
      if (Math.abs(gross - derived) > 1) {
        throw new Error(`gross_cents=${gross} 与 数量×价格=${derived} 分不符（容差 1 分）`);
      }
    } else {
      gross = valueCents(quantity, priceMilli);
    }
  };

  switch (eventType) {
    case 'TRADE_BUY': {
      requireTrade();
      const derived = -(gross! + fee + tax);
      cashDelta = input.cash_delta_cents === undefined || input.cash_delta_cents === null
        ? derived : intOrNull(input.cash_delta_cents, 'cash_delta_cents')!;
      if (cashDelta !== derived) throw new Error(`TRADE_BUY 的 cash_delta_cents 必须等于 -(gross+fee+tax)=${derived}`);
      if (settledOn && settledOn !== occurredOn) throw new Error('TRADE_BUY 的 settled_on 只能是 occurred_on（现金当日划出）');
      break;
    }
    case 'TRADE_SELL': {
      requireTrade();
      const derived = gross! - fee - tax;
      cashDelta = input.cash_delta_cents === undefined || input.cash_delta_cents === null
        ? derived : intOrNull(input.cash_delta_cents, 'cash_delta_cents')!;
      if (cashDelta !== derived) throw new Error(`TRADE_SELL 的 cash_delta_cents 必须等于 gross-fee-tax=${derived}`);
      const decisionInfo = settlementRuleFor(tsCode!);
      let calendarAssumed = false;
      if (!settledOn) {
        if (decisionInfo.rule === 'T+0') {
          settledOn = occurredOn;
        } else {
          const fromCalendar = options.calendar?.nextOpenDay(occurredOn);
          if (fromCalendar) {
            settledOn = fromCalendar;
          } else {
            settledOn = nextBusinessDay(occurredOn);
            calendarAssumed = true;
          }
        }
      }
      if (settledOn < occurredOn) throw new Error('settled_on 不能早于 occurred_on');
      settlementInfo = {
        rule: decisionInfo.rule,
        kind: decisionInfo.kind,
        assumed: decisionInfo.assumed,
        calendar_assumed: decisionInfo.rule === 'T+0' ? false : calendarAssumed,
        reason: decisionInfo.reason,
      };
      break;
    }
    case 'CASH_DEPOSIT': {
      forbid([[tsCode, 'ts_code'], [quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents'], [ratioNum, 'ratio_num']]);
      cashDelta = intOrNull(input.cash_delta_cents ?? 0, 'cash_delta_cents')!;
      if (cashDelta <= 0) throw new Error('CASH_DEPOSIT 的 cash_delta_cents 必须为正数');
      if (fee !== 0 || tax !== 0) throw new Error('CASH_DEPOSIT 不接受 fee_cents/tax_cents');
      break;
    }
    case 'CASH_WITHDRAW': {
      forbid([[tsCode, 'ts_code'], [quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents'], [ratioNum, 'ratio_num']]);
      cashDelta = intOrNull(input.cash_delta_cents ?? 0, 'cash_delta_cents')!;
      if (cashDelta >= 0) throw new Error('CASH_WITHDRAW 的 cash_delta_cents 必须为负数');
      if (fee !== 0 || tax !== 0) throw new Error('CASH_WITHDRAW 不接受 fee_cents/tax_cents');
      break;
    }
    case 'DIVIDEND': {
      if (!tsCode) throw new Error('DIVIDEND 需要 ts_code');
      forbid([[quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents'], [ratioNum, 'ratio_num']]);
      cashDelta = intOrNull(input.cash_delta_cents ?? 0, 'cash_delta_cents')!;
      if (cashDelta <= 0) throw new Error('DIVIDEND 的 cash_delta_cents 必须为正数');
      break;
    }
    case 'FEE': {
      forbid([[quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents'], [ratioNum, 'ratio_num']]);
      cashDelta = intOrNull(input.cash_delta_cents ?? 0, 'cash_delta_cents')!;
      if (cashDelta >= 0) throw new Error('FEE 的 cash_delta_cents 必须为负数');
      if (fee !== 0 || tax !== 0) throw new Error('FEE 的费用写在 cash_delta_cents 里，不再接受 fee_cents/tax_cents');
      break;
    }
    case 'SPLIT': {
      if (!tsCode) throw new Error('SPLIT 需要 ts_code');
      forbid([[quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents']]);
      if (ratioNum === null || ratioDen === null) throw new Error('SPLIT 需要 ratio_num 与 ratio_den');
      if (ratioNum <= 0 || ratioDen <= 0) throw new Error('SPLIT 的比例必须为正整数');
      if (ratioNum === ratioDen) throw new Error('SPLIT 比例不能是 1:1（无意义事件）');
      if (fee !== 0 || tax !== 0) throw new Error('SPLIT 不接受费用');
      const raw = intOrNull(input.cash_delta_cents, 'cash_delta_cents');
      if (raw !== null && raw !== 0) throw new Error('SPLIT 的 cash_delta_cents 必须为 0');
      cashDelta = 0;
      break;
    }
    case 'REVERSE': {
      const target = requireText(input.reverses_event_id, 'reverses_event_id');
      forbid([[tsCode, 'ts_code'], [quantity, 'quantity'], [priceMilli, 'price_milli'], [gross, 'gross_cents'], [ratioNum, 'ratio_num'], [settledOn, 'settled_on']]);
      if (fee !== 0 || tax !== 0) throw new Error('REVERSE 不接受费用');
      const raw = intOrNull(input.cash_delta_cents, 'cash_delta_cents');
      if (raw !== null && raw !== 0) throw new Error('REVERSE 的 cash_delta_cents 必须为 0（由原事件推导）');
      cashDelta = 0;
      return {
        event_id: eventId, account_id: accountId, event_type: eventType, occurred_on: occurredOn,
        settled_on: null, ts_code: null, quantity: null, price_milli: null, gross_cents: null,
        fee_cents: 0, tax_cents: 0, cash_delta_cents: 0, ratio_num: null, ratio_den: null,
        reverses_event_id: target, note, source, recorded_at: input.recorded_at ?? new Date().toISOString(),
      };
    }
    default:
      throw new Error(`未知事件类型：${String(eventType)}`);
  }

  return {
    event_id: eventId,
    account_id: accountId,
    event_type: eventType,
    occurred_on: occurredOn,
    settled_on: settledOn ?? null,
    ts_code: tsCode,
    quantity,
    price_milli: priceMilli,
    gross_cents: gross,
    fee_cents: fee,
    tax_cents: tax,
    cash_delta_cents: cashDelta,
    ratio_num: ratioNum,
    ratio_den: ratioDen,
    reverses_event_id: null,
    note,
    source,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    ...(settlementInfo ? { settlement_info: settlementInfo } : {}),
  };
}

/**
 * 内容哈希：只覆盖经济事实，不覆盖 `note`、`recorded_at`、`reversed_by`。
 * 因此同一条券商流水重复导入是幂等，而金额/日期/代码被改动则是冲突。
 */
export function eventContentHash(e: NormalizedEvent): string {
  const canonical = JSON.stringify([
    e.event_id, e.account_id, e.event_type, e.occurred_on, e.settled_on, e.ts_code,
    e.quantity, e.price_milli, e.gross_cents, e.fee_cents, e.tax_cents, e.cash_delta_cents,
    e.ratio_num, e.ratio_den, e.reverses_event_id, e.source,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------- 表准备

/**
 * 读路径：库内没有账本表时给出明确错误，而不是自动建表。
 * 只读连接（MCP 工具、只读 CLI）不得改写用户数据库 schema。
 */
function requireLedgerTables(db: DatabaseSync): void {
  if (!ledgerTablesPresent(db)) {
    throw new Error('账户库中没有 P2 账本表（account_event/account_baseline），请先运行 finance-ashare portfolio-ledger-init');
  }
}

// ---------------------------------------------------------------- 基线

export interface BaselineRow {
  account_id: string;
  as_of: string;
  snapshot_id: string;
  cash_cents: number;
  note: string;
  created_at: string;
}

export function readBaseline(db: DatabaseSync, accountId: string): BaselineRow | undefined {
  if (!ledgerTablesPresent(db)) return undefined;
  const row = db.prepare('SELECT * FROM account_baseline WHERE account_id = ?').get(accountId) as any;
  return row ? {
    account_id: row.account_id, as_of: row.as_of, snapshot_id: row.snapshot_id,
    cash_cents: row.cash_cents, note: row.note, created_at: row.created_at,
  } : undefined;
}

export interface InitBaselineOptions {
  asOf: string;
  /** 引用已有快照：持仓与默认现金来自该快照。 */
  snapshotId?: string;
  /** 显式现金（分）；给出时覆盖快照现金。 */
  cashCents?: number;
  note?: string;
}

/**
 * 建立账户重建起点。幂等：完全相同的基线重复建立返回 created:false；
 * 内容不同则拒绝覆盖（起点被静默改写会让全部历史重放失真）。
 */
export function initBaseline(db: DatabaseSync, accountId: string, options: InitBaselineOptions) {
  const id = requireText(accountId, 'account_id');
  const asOf = assertYmd(options.asOf, 'as_of');
  const snapshotId = options.snapshotId?.trim() ?? '';
  let cash: number;
  let positions = 0;

  if (snapshotId) {
    const snapshot = readSnapshot(db, snapshotId);
    if (!snapshot) throw new Error(`账户快照 ${snapshotId} 不存在`);
    positions = snapshot.positions.filter(p => p.quantity !== 0).length;
    cash = options.cashCents ?? snapshot.totals.cash_cents;
    if (snapshot.as_of.replace(/-/g, '') !== asOf) {
      throw new Error(`基线日期 ${asOf} 与快照日期 ${snapshot.as_of} 不一致`);
    }
  } else {
    if (options.cashCents === undefined) throw new Error('未指定快照时必须用 --cash 给出起始现金（分）');
    cash = options.cashCents;
  }
  if (!Number.isSafeInteger(cash)) throw new Error('起始现金必须是整数分');

  const existing = readBaseline(db, id);
  if (existing) {
    const same = existing.as_of === asOf && existing.snapshot_id === snapshotId && existing.cash_cents === cash;
    if (!same) throw new Error(`账户 ${id} 的基线已存在且内容不同，拒绝覆盖`);
    return { created: false, account_id: id, as_of: asOf, snapshot_id: snapshotId, cash_cents: cash, positions };
  }

  inPortfolioTransaction(db, () => {
    db.prepare(`INSERT INTO account_baseline (account_id, as_of, snapshot_id, cash_cents, note, created_at)
      VALUES (?,?,?,?,?,?)`).run(id, asOf, snapshotId, cash, options.note ?? '', new Date().toISOString());
  });
  return { created: true, account_id: id, as_of: asOf, snapshot_id: snapshotId, cash_cents: cash, positions };
}

// ---------------------------------------------------------------- 记录事件

interface EventRow {
  event_id: string; account_id: string; event_type: LedgerEventType; occurred_on: string;
  settled_on: string | null; ts_code: string | null; quantity: number | null; price_milli: number | null;
  gross_cents: number | null; fee_cents: number; tax_cents: number; cash_delta_cents: number;
  ratio_num: number | null; ratio_den: number | null; reverses_event_id: string | null;
  reversed_by: string | null; note: string; source: EventSource; recorded_at: string;
}

function rowFromDb(row: any): EventRow {
  return {
    event_id: row.event_id, account_id: row.account_id, event_type: row.event_type, occurred_on: row.occurred_on,
    settled_on: row.settled_on ?? null, ts_code: row.ts_code ?? null, quantity: row.quantity ?? null,
    price_milli: row.price_milli ?? null, gross_cents: row.gross_cents ?? null,
    fee_cents: row.fee_cents, tax_cents: row.tax_cents, cash_delta_cents: row.cash_delta_cents,
    ratio_num: row.ratio_num ?? null, ratio_den: row.ratio_den ?? null,
    reverses_event_id: row.reverses_event_id ?? null, reversed_by: row.reversed_by ?? null,
    note: row.note, source: row.source, recorded_at: row.recorded_at,
  };
}

function normalizedFromRow(row: EventRow): NormalizedEvent {
  return {
    event_id: row.event_id, account_id: row.account_id, event_type: row.event_type, occurred_on: row.occurred_on,
    settled_on: row.settled_on, ts_code: row.ts_code, quantity: row.quantity, price_milli: row.price_milli,
    gross_cents: row.gross_cents, fee_cents: row.fee_cents, tax_cents: row.tax_cents,
    cash_delta_cents: row.cash_delta_cents, ratio_num: row.ratio_num, ratio_den: row.ratio_den,
    reverses_event_id: row.reverses_event_id, note: row.note, source: row.source, recorded_at: row.recorded_at,
  };
}

function recordConflict(
  db: DatabaseSync, eventId: string, accountId: string, existingHash: string, incomingHash: string, reason: string,
): void {
  db.prepare(`INSERT INTO account_event_conflict (event_id, account_id, existing_hash, incoming_hash, reason, recorded_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET account_id = excluded.account_id, existing_hash = excluded.existing_hash,
      incoming_hash = excluded.incoming_hash, reason = excluded.reason, recorded_at = excluded.recorded_at`)
    .run(eventId, accountId, existingHash, incomingHash, reason, new Date().toISOString());
}

/** 单条记录的真正写入逻辑；调用方负责事务与提交/回滚。 */
function recordOne(db: DatabaseSync, event: NormalizedEvent): RecordResult {
  const baseline = readBaseline(db, event.account_id);
  if (!baseline) throw new Error(`账户 ${event.account_id} 没有基线，请先运行 portfolio-ledger-init`);
  if (event.occurred_on < baseline.as_of) {
    throw new Error(`事件日期 ${event.occurred_on} 早于基线 ${baseline.as_of}：基线已包含该日之前的影响，重复计入会失真`);
  }

  const incomingHash = eventContentHash(event);
  const existing = db.prepare('SELECT * FROM account_event WHERE event_id = ?').get(event.event_id) as any;

  if (existing) {
    const row = rowFromDb(existing);
    const existingHash = eventContentHash(normalizedFromRow(row));
    if (existingHash === incomingHash) {
      return { status: 'DUPLICATE', event_id: event.event_id, event_type: row.event_type, content_hash: incomingHash };
    }
    recordConflict(db, event.event_id, event.account_id, existingHash, incomingHash, 'content_mismatch');
    return { status: 'CONFLICT', event_id: event.event_id, reason: 'content_mismatch', existing_hash: existingHash, incoming_hash: incomingHash };
  }

  let reversedTarget: EventRow | null = null;
  if (event.event_type === 'REVERSE') {
    const targetRow = db.prepare('SELECT * FROM account_event WHERE event_id = ?').get(event.reverses_event_id!) as any;
    if (!targetRow) throw new Error(`撤销目标 ${event.reverses_event_id} 不存在`);
    reversedTarget = rowFromDb(targetRow);
    if (reversedTarget.account_id !== event.account_id) throw new Error('撤销目标不属于同一账户');
    if (reversedTarget.event_type === 'REVERSE') throw new Error('不能撤销一个撤销分录');
    if (reversedTarget.reversed_by) {
      // 重复撤销同一笔：拒绝，并把拒绝原因留痕；既不新增事件也不改写原记录。
      const priorHash = eventContentHash(normalizedFromRow(reversedTarget));
      recordConflict(db, event.event_id, event.account_id, priorHash, incomingHash, 'already_reversed');
      return {
        status: 'CONFLICT', event_id: event.event_id, reason: 'already_reversed',
        existing_hash: priorHash, incoming_hash: incomingHash,
      };
    }
  }

  db.prepare(`INSERT INTO account_event
    (event_id, account_id, event_type, occurred_on, settled_on, ts_code, quantity, price_milli,
     gross_cents, fee_cents, tax_cents, cash_delta_cents, ratio_num, ratio_den,
     reverses_event_id, reversed_by, note, source, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    event.event_id, event.account_id, event.event_type, event.occurred_on, event.settled_on, event.ts_code,
    event.quantity, event.price_milli, event.gross_cents, event.fee_cents, event.tax_cents,
    event.cash_delta_cents, event.ratio_num, event.ratio_den, event.reverses_event_id,
    null, event.note, event.source, event.recorded_at,
  );

  if (reversedTarget) {
    db.prepare('UPDATE account_event SET reversed_by = ? WHERE event_id = ?').run(event.event_id, reversedTarget.event_id);
  }

  return {
    status: 'RECORDED', event_id: event.event_id, event_type: event.event_type,
    cash_delta_cents: event.cash_delta_cents, settled_on: event.settled_on, content_hash: incomingHash,
    ...(event.settlement_info ? { settlement: event.settlement_info } : {}),
  };
}

/**
 * 记录一条事件。`mode: 'dry_run'` 完成全部校验与冲突判定后回滚，用于导入预演。
 * 三种结果：RECORDED / DUPLICATE（同 id 同内容）/ CONFLICT（同 id 不同内容，原记录不动）。
 */
export function recordEvent(
  db: DatabaseSync, input: LedgerEventInput,
  options: { mode?: RecordMode; calendar?: SettlementCalendar } = {},
): RecordResult {
  const event = normalizeEvent(input, { calendar: options.calendar });
  const mode = options.mode ?? 'live';
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = recordOne(db, event);
    if (mode === 'dry_run') db.exec('ROLLBACK');
    else db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已自行结束 */ }
    throw error;
  }
}

export interface ImportResult {
  account_id: string;
  aborted: boolean;
  abort_reason: string | null;
  counts: { recorded: number; duplicate: number; conflict: number };
  results: RecordResult[];
  dry_run: boolean;
}

/**
 * 批量导入。默认任何一条冲突都整体回滚（不产生半批写入）；
 * `continueOnConflict` 才逐条继续，但冲突仍只落冲突表、不覆盖原事件。
 */
export function importEvents(
  db: DatabaseSync, accountId: string, inputs: LedgerEventInput[],
  options: { continueOnConflict?: boolean; mode?: RecordMode; calendar?: SettlementCalendar } = {},
): ImportResult {
  const id = requireText(accountId, 'account_id');
  const continueOnConflict = options.continueOnConflict === true;
  const dryRun = (options.mode ?? 'live') === 'dry_run';
  const normalized: NormalizedEvent[] = [];
  for (const [index, input] of inputs.entries()) {
    if (input.account_id && input.account_id !== id) {
      throw new Error(`第 ${index + 1} 条事件的 account_id=${input.account_id} 与 --account ${id} 不一致`);
    }
    try {
      normalized.push(normalizeEvent({ ...input, account_id: id }, { calendar: options.calendar }));
    } catch (error: any) {
      throw new Error(`第 ${index + 1} 条事件校验失败：${error?.message ?? error}`);
    }
  }

  const results: RecordResult[] = [];
  const counts = { recorded: 0, duplicate: 0, conflict: 0 };
  let aborted = false;
  let abortReason: string | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of normalized) {
      const result = recordOne(db, event);
      results.push(result);
      if (result.status === 'CONFLICT' && !continueOnConflict) {
        aborted = true;
        abortReason = `事件 ${result.event_id} 冲突（${result.reason}），整批回滚`;
        break;
      }
      if (result.status === 'RECORDED') counts.recorded += 1;
      else if (result.status === 'DUPLICATE') counts.duplicate += 1;
      else counts.conflict += 1;
    }
    if (aborted || dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }

  if (aborted) {
    // 账本事件零部分写入；但冲突本身是要留痕的审计事实，回滚后单独补记一条，
    // 便于排查"这份对账单为什么没导进去"。它不属于账本事件表。
    counts.recorded = 0;
    counts.duplicate = 0;
    const conflict = results.find(r => r.status === 'CONFLICT') as Extract<RecordResult, { status: 'CONFLICT' }> | undefined;
    counts.conflict = conflict ? 1 : 0;
    if (conflict && !dryRun) {
      recordConflict(db, conflict.event_id, id, conflict.existing_hash, conflict.incoming_hash, conflict.reason);
    }
  }
  return { account_id: id, aborted, abort_reason: abortReason, counts, results, dry_run: dryRun };
}

// ---------------------------------------------------------------- 重放

interface CashSettlement {
  event_id: string;
  ts_code: string | null;
  original_cents: number;
  /** 已转入可取现金的部分。 */
  settled_part: number;
  /** 仍在未交收池里的部分。 */
  remaining: number;
  settles_on: string;
  released: boolean;
  /** 记录时/重放时推导的交收规则，用于输出标注。 */
  rule: SettlementRule;
  rule_assumed: boolean;
}

interface AppliedEffect {
  ts_code: string | null;
  /** 买为正、卖为负；REVERSE 不产生 effect。 */
  qty_delta: number;
  cost_milli_delta: number;
  realized_cents_delta: number;
  /** 本事件直接改动的可取现金（买为负、卖为已交收时为正）。 */
  settled_cash_delta: number;
  /** 卖出资金进入未交收池时，对应 settlement 记录的事件 id。 */
  settlement_id: string | null;
  /** 拆分：原方向比例；撤销时取倒数。 */
  split: { num: number; den: number } | null;
  totals: { dividends: number; fees: number; taxes: number; external_flow: number };
}

interface Pos {
  quantity: number;
  cost_milli: number;
  realized_cents: number;
}

class LedgerRunner {
  private positions = new Map<string, Pos>();
  private settled = 0;
  private settlements = new Map<string, CashSettlement>();
  private effects = new Map<string, AppliedEffect>();
  private flowByDate = new Map<string, number>();
  private totals = { realized_pnl_cents: 0, dividends_cents: 0, fees_cents: 0, taxes_cents: 0, external_flow_cents: 0 };
  private violations: LedgerViolation[] = [];
  private minCash = Number.POSITIVE_INFINITY;
  private cashFlagged = new Set<string>();
  eventsApplied = 0;
  lastEventDate: string | null = null;

  constructor(private readonly baseline: BaselineRow) {}

  seed(positions: { ts_code: string; quantity: number; ref_cost_milli: number }[]): void {
    for (const p of positions) {
      if (p.quantity === 0) continue;
      this.positions.set(p.ts_code, { quantity: p.quantity, cost_milli: p.quantity * p.ref_cost_milli, realized_cents: 0 });
    }
    this.settled = this.baseline.cash_cents;
    this.minCash = this.settled;
    if (this.settled < 0) {
      this.violation('cash_negative', `基线现金 ${this.settled} 分 < 0`, this.baseline.as_of, null);
    }
  }

  private pos(code: string): Pos {
    let p = this.positions.get(code);
    if (!p) { p = { quantity: 0, cost_milli: 0, realized_cents: 0 }; this.positions.set(code, p); }
    return p;
  }

  private unsettledTotal(): number {
    let sum = 0;
    for (const s of this.settlements.values()) sum += s.remaining;
    return sum;
  }

  cashBalance(): number { return this.settled + this.unsettledTotal(); }

  /** 到达 date：把 settles_on ≤ date 的未交收卖出款转入可取现金。 */
  releaseUpTo(date: string): void {
    for (const s of this.settlements.values()) {
      if (!s.released && s.settles_on <= date) {
        this.settled += s.remaining;
        s.settled_part += s.remaining;
        s.remaining = 0;
        s.released = true;
      }
    }
  }

  /** 花钱：先用可取现金，再用当日卖出所得（可当日买入，不可当日取现）。 */
  private spend(amount: number): void {
    if (amount <= 0) return;
    let rest = amount;
    const fromSettled = Math.min(Math.max(this.settled, 0), rest);
    this.settled -= fromSettled;
    rest -= fromSettled;
    if (rest > 0) {
      const items = [...this.settlements.values()]
        .filter(s => s.remaining > 0)
        .sort((a, b) => (a.settles_on === b.settles_on ? a.event_id.localeCompare(b.event_id) : a.settles_on < b.settles_on ? -1 : 1));
      for (const item of items) {
        if (rest <= 0) break;
        const take = Math.min(item.remaining, rest);
        item.remaining -= take;
        rest -= take;
      }
    }
    if (rest > 0) this.settled -= rest; // 透支：余额转负，交给校验函数如实报出
  }

  private violation(code: string, detail: string, date: string | null, eventId: string | null, severity: 'error' | 'warning' = 'error'): void {
    this.violations.push({ code, severity, date, event_id: eventId, detail });
  }

  private afterEvent(row: EventRow): void {
    const balance = this.cashBalance();
    if (balance < this.minCash) this.minCash = balance;
    if (balance < 0 && !this.cashFlagged.has(row.event_id)) {
      this.cashFlagged.add(row.event_id);
      this.violation('cash_negative', `现金余额 ${balance} 分 < 0`, row.occurred_on, row.event_id);
    }
    for (const [code, p] of this.positions) {
      if (p.quantity < 0) {
        this.violation('quantity_negative', `${code} 数量 ${p.quantity} < 0`, row.occurred_on, row.event_id);
      }
    }
  }

  applyEvent(row: EventRow): void {
    this.eventsApplied += 1;
    this.lastEventDate = row.occurred_on;
    const date = row.occurred_on;
    const code = row.ts_code;

    switch (row.event_type) {
      case 'TRADE_BUY': {
        const q = row.quantity!;
        const price = row.price_milli!;
        const gross = row.gross_cents!;
        const cashOut = gross + row.fee_cents + row.tax_cents;
        const p = this.pos(code!);
        const costAdded = q * price + (row.fee_cents + row.tax_cents) * 10;
        p.quantity += q;
        p.cost_milli += costAdded;
        this.spend(cashOut);
        this.totals.fees_cents += row.fee_cents;
        this.totals.taxes_cents += row.tax_cents;
        this.effects.set(row.event_id, {
          ts_code: code, qty_delta: q, cost_milli_delta: costAdded, realized_cents_delta: 0,
          settled_cash_delta: -cashOut, settlement_id: null, split: null,
          totals: { dividends: 0, fees: row.fee_cents, taxes: row.tax_cents, external_flow: 0 },
        });
        break;
      }
      case 'TRADE_SELL': {
        const q = row.quantity!;
        const gross = row.gross_cents!;
        const p = this.pos(code!);
        if (q > p.quantity) {
          this.violation('oversell', `${code} 卖出 ${q} 份 > 持有 ${p.quantity} 份`, date, row.event_id);
        }
        const removed = q >= p.quantity ? p.cost_milli : Math.round((p.cost_milli * q) / Math.max(p.quantity, 1));
        p.quantity -= q;
        p.cost_milli -= removed;
        const proceeds = gross - row.fee_cents - row.tax_cents;
        const realized = proceeds - Math.round(removed / 10);
        p.realized_cents += realized;
        this.totals.realized_pnl_cents += realized;
        this.totals.fees_cents += row.fee_cents;
        this.totals.taxes_cents += row.tax_cents;

        let settlementId: string | null = null;
        let settledDelta = proceeds;
        if (row.settled_on && row.settled_on > row.occurred_on) {
          const ruleInfo = settlementRuleFor(code!);
          settlementId = row.event_id;
          settledDelta = 0;
          this.settlements.set(row.event_id, {
            event_id: row.event_id, ts_code: code, original_cents: proceeds,
            settled_part: 0, remaining: proceeds, settles_on: row.settled_on, released: false,
            rule: ruleInfo.rule, rule_assumed: ruleInfo.assumed,
          });
        } else {
          this.settled += proceeds;
        }
        this.effects.set(row.event_id, {
          ts_code: code, qty_delta: -q, cost_milli_delta: -removed, realized_cents_delta: realized,
          settled_cash_delta: settledDelta, settlement_id: settlementId, split: null,
          totals: { dividends: 0, fees: row.fee_cents, taxes: row.tax_cents, external_flow: 0 },
        });
        break;
      }
      case 'CASH_DEPOSIT':
      case 'CASH_WITHDRAW': {
        const delta = row.cash_delta_cents;
        this.settled += delta;
        this.totals.external_flow_cents += delta;
        this.flowByDate.set(date, (this.flowByDate.get(date) ?? 0) + delta);
        this.effects.set(row.event_id, {
          ts_code: null, qty_delta: 0, cost_milli_delta: 0, realized_cents_delta: 0,
          settled_cash_delta: delta, settlement_id: null, split: null,
          totals: { dividends: 0, fees: 0, taxes: 0, external_flow: delta },
        });
        break;
      }
      case 'DIVIDEND': {
        const delta = row.cash_delta_cents;
        this.settled += delta;
        this.totals.dividends_cents += delta;
        this.effects.set(row.event_id, {
          ts_code: code, qty_delta: 0, cost_milli_delta: 0, realized_cents_delta: 0,
          settled_cash_delta: delta, settlement_id: null, split: null,
          totals: { dividends: delta, fees: 0, taxes: 0, external_flow: 0 },
        });
        break;
      }
      case 'FEE': {
        const delta = row.cash_delta_cents;
        this.spend(-delta);
        this.totals.fees_cents += -delta;
        this.effects.set(row.event_id, {
          ts_code: code, qty_delta: 0, cost_milli_delta: 0, realized_cents_delta: 0,
          settled_cash_delta: delta, settlement_id: null, split: null,
          totals: { dividends: 0, fees: -delta, taxes: 0, external_flow: 0 },
        });
        break;
      }
      case 'SPLIT': {
        const num = row.ratio_num!;
        const den = row.ratio_den!;
        const p = this.pos(code!);
        if (num <= 0 || den <= 0) {
          this.violation('split_ratio_invalid', `${code} 拆分比例 ${num}:${den} 非正`, date, row.event_id);
        } else if (p.quantity > 0) {
          const exact = (p.quantity * num) / den;
          if (!Number.isInteger(exact)) {
            this.violation('split_non_integer_quantity', `${code} ${p.quantity}×${num}/${den} 不是整数份，按向下取整处理`, date, row.event_id);
          }
          // 总成本不变，均价随数量变化：拆分不产生盈亏，也不影响现金。
          p.quantity = Math.floor(exact);
        }
        this.effects.set(row.event_id, {
          ts_code: code, qty_delta: 0, cost_milli_delta: 0, realized_cents_delta: 0,
          settled_cash_delta: 0, settlement_id: null, split: { num, den },
          totals: { dividends: 0, fees: 0, taxes: 0, external_flow: 0 },
        });
        break;
      }
      case 'REVERSE': {
        const targetId = row.reverses_event_id!;
        const eff = this.effects.get(targetId);
        if (!eff) {
          this.violation('reverse_target_not_applied', `撤销目标 ${targetId} 未在重放中生效（可能晚于撤销或早于基线）`, date, row.event_id);
          break;
        }
        if (eff.split) {
          const p = this.pos(eff.ts_code!);
          p.quantity = Math.floor((p.quantity * eff.split.den) / eff.split.num);
        } else if (eff.ts_code) {
          const p = this.pos(eff.ts_code);
          p.quantity -= eff.qty_delta;
          p.cost_milli -= eff.cost_milli_delta;
          p.realized_cents -= eff.realized_cents_delta;
          if (p.quantity < 0) {
            this.violation('reverse_creates_negative_position', `${eff.ts_code} 撤销后数量 ${p.quantity} < 0`, date, row.event_id);
          }
        }
        if (eff.settlement_id) {
          const s = this.settlements.get(eff.settlement_id);
          if (s) {
            this.settled -= s.settled_part; // 已交收部分退回；未交收部分直接消失
            s.remaining = 0;
            s.released = true;
          }
        }
        this.settled -= eff.settled_cash_delta;
        this.totals.realized_pnl_cents -= eff.realized_cents_delta;
        this.totals.dividends_cents -= eff.totals.dividends;
        this.totals.fees_cents -= eff.totals.fees;
        this.totals.taxes_cents -= eff.totals.taxes;
        if (eff.totals.external_flow !== 0) {
          this.totals.external_flow_cents -= eff.totals.external_flow;
          this.flowByDate.set(date, (this.flowByDate.get(date) ?? 0) - eff.totals.external_flow);
        }
        break;
      }
      default:
        this.violation('unknown_event_type', `未知事件类型 ${String(row.event_type)}`, date, row.event_id);
    }
    this.afterEvent(row);
  }

  flowOn(date: string): number { return this.flowByDate.get(date) ?? 0; }

  snapshot(): Omit<ReplayResult, 'account_id' | 'as_of' | 'baseline' | 'events_applied' | 'last_event_date' | 'source' | 'data_source' | 'assumptions' | 'real_account_status'> {
    const positions: PositionState[] = [];
    for (const [tsCode, p] of [...this.positions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (p.quantity === 0) continue; // 零持仓清理：输出里不出现零数量行
      positions.push({
        ts_code: tsCode,
        quantity: p.quantity,
        cost_milli_total: p.cost_milli,
        cost_milli_avg: p.quantity > 0 ? round(p.cost_milli / p.quantity, 6) : 0,
        realized_pnl_cents: p.realized_cents,
      });
    }
    const pending = [...this.settlements.values()]
      .filter(s => s.remaining > 0)
      .map(s => ({
        ts_code: s.ts_code ?? '', cents: s.remaining, settles_on: s.settles_on,
        settlement_rule: s.rule, settlement_rule_assumed: s.rule_assumed,
      }))
      .sort((a, b) => (a.settles_on === b.settles_on ? a.ts_code.localeCompare(b.ts_code) : a.settles_on < b.settles_on ? -1 : 1));
    const securitiesCost = positions.reduce((sum, p) => sum + p.cost_milli_total, 0);
    const unsettled = this.unsettledTotal();
    return {
      positions,
      cash: {
        balance_cents: this.settled + unsettled,
        settled_cents: this.settled,
        unsettled_cents: unsettled,
        withdrawable_cents: this.settled,
        buying_power_cents: this.settled + unsettled,
      },
      totals: {
        securities_cost_cents: Math.round(securitiesCost / 10),
        realized_pnl_cents: this.totals.realized_pnl_cents,
        dividends_cents: this.totals.dividends_cents,
        fees_cents: this.totals.fees_cents,
        taxes_cents: this.totals.taxes_cents,
        external_flow_cents: this.totals.external_flow_cents,
      },
      pending_settlement: pending,
    };
  }

  getViolations(): LedgerViolation[] { return this.violations; }
  getMinCash(): number { return Number.isFinite(this.minCash) ? this.minCash : this.settled; }
}

function requireBaseline(db: DatabaseSync, accountId: string): BaselineRow {
  requireLedgerTables(db);
  const baseline = readBaseline(db, accountId);
  if (!baseline) throw new Error(`账户 ${accountId} 没有基线，请先运行 portfolio-ledger-init`);
  return baseline;
}

/** 按 (occurred_on, recorded_at, event_id) 升序取事件；串行化保证重放唯一。 */
function loadEvents(db: DatabaseSync, accountId: string, asOf?: string): EventRow[] {
  const rows = (asOf
    ? db.prepare(`SELECT * FROM account_event WHERE account_id = ? AND occurred_on <= ?
        ORDER BY occurred_on ASC, recorded_at ASC, event_id ASC`).all(accountId, asOf)
    : db.prepare(`SELECT * FROM account_event WHERE account_id = ?
        ORDER BY occurred_on ASC, recorded_at ASC, event_id ASC`).all(accountId)) as any[];
  return rows.map(rowFromDb);
}

function seedRunner(db: DatabaseSync, baseline: BaselineRow): LedgerRunner {
  const runner = new LedgerRunner(baseline);
  if (baseline.snapshot_id) {
    const snapshot = readSnapshot(db, baseline.snapshot_id);
    if (!snapshot) throw new Error(`基线引用的快照 ${baseline.snapshot_id} 已不存在，无法重放`);
    runner.seed(snapshot.positions.map(p => ({ ts_code: p.ts_code, quantity: p.quantity, ref_cost_milli: p.ref_cost_milli })));
  } else {
    runner.seed([]);
  }
  return runner;
}

function dataSourceOf(rows: EventRow[], _hasBaselineSnapshot: boolean): ReplayResult['data_source'] {
  const sources = new Set(rows.map(r => r.source));
  if (sources.size === 0) return 'baseline_only';
  if (sources.size > 1) return 'mixed';
  return [...sources][0];
}

/**
 * 确定性重放：持仓、现金、成本、已实现盈亏全部从基线 + 事件推导。
 * `asOf` 过滤 `occurred_on <= asOf`；不读当前时间，也没有任何随机性。
 */
export function replayAccount(db: DatabaseSync, accountId: string, options: { asOf?: string } = {}): ReplayResult {
  const id = requireText(accountId, 'account_id');
  const baseline = requireBaseline(db, id);
  const asOf = options.asOf ? assertYmd(options.asOf, 'as_of') : null;

  const rows = loadEvents(db, id, asOf ?? undefined).filter(row => {
    // 基线之前的事件已包含在基线里；再次计入会重复计算。重放时排除（validate 会报出）。
    return row.occurred_on >= baseline.as_of;
  });

  const runner = seedRunner(db, baseline);
  let currentDate: string | null = null;
  for (const row of rows) {
    if (row.occurred_on !== currentDate) {
      runner.releaseUpTo(row.occurred_on);
      currentDate = row.occurred_on;
    }
    runner.applyEvent(row);
  }
  if (asOf) runner.releaseUpTo(asOf);

  const state = runner.snapshot();
  return {
    account_id: id,
    as_of: asOf,
    source: 'ledger_replay',
    data_source: dataSourceOf(rows, Boolean(baseline.snapshot_id)),
    baseline: {
      as_of: baseline.as_of, snapshot_id: baseline.snapshot_id,
      cash_cents: baseline.cash_cents, note: baseline.note,
    },
    ...state,
    events_applied: runner.eventsApplied,
    last_event_date: runner.lastEventDate,
    real_account_status: realAccountGate(db, id).status,
    assumptions: ASSUMPTIONS,
  };
}

// ---------------------------------------------------------------- 校验

/**
 * 账本不变量检查。只报告、不抛错，也不修改任何数据：
 * 现金不得为负、数量不得为负、卖出不得超过持有、拆分比例为正、
 * 撤销不得悬空/重复/撤销撤销、事件 id 不得重复、基线之前不得有事件。
 */
export function validateLedger(db: DatabaseSync, accountId: string): ValidateResult {
  const id = requireText(accountId, 'account_id');
  const baseline = readBaseline(db, id);
  const violations: LedgerViolation[] = [];

  if (!ledgerTablesPresent(db)) {
    return {
      ok: false, account_id: id,
      violations: [{ code: 'no_baseline', severity: 'error', date: null, event_id: null, detail: '账户库中没有 P2 账本表' }],
      min_cash_balance_cents: 0, events_checked: 0, conflicts_recorded: 0, assumptions: ASSUMPTIONS,
    };
  }

  if (!baseline) {
    return {
      ok: false, account_id: id,
      violations: [{ code: 'no_baseline', severity: 'error', date: null, event_id: null, detail: `账户 ${id} 没有基线` }],
      min_cash_balance_cents: 0, events_checked: 0, conflicts_recorded: conflictsCount(db, id), assumptions: ASSUMPTIONS,
    };
  }

  // 结构层检查（SQL），与重放无关。
  const dangling = db.prepare(`SELECT e.event_id, e.occurred_on, e.reverses_event_id
      FROM account_event e LEFT JOIN account_event t ON t.event_id = e.reverses_event_id AND t.account_id = e.account_id
      WHERE e.account_id = ? AND e.event_type = 'REVERSE' AND t.event_id IS NULL`).all(id) as any[];
  for (const row of dangling) {
    violations.push({
      code: 'dangling_reverse', severity: 'error', date: row.occurred_on, event_id: row.event_id,
      detail: `撤销目标 ${row.reverses_event_id} 不存在`,
    });
  }
  const reverseOfReverse = db.prepare(`SELECT e.event_id, e.occurred_on
      FROM account_event e JOIN account_event t ON t.event_id = e.reverses_event_id AND t.account_id = e.account_id
      WHERE e.account_id = ? AND e.event_type = 'REVERSE' AND t.event_type = 'REVERSE'`).all(id) as any[];
  for (const row of reverseOfReverse) {
    violations.push({
      code: 'reverse_of_reverse', severity: 'error', date: row.occurred_on, event_id: row.event_id,
      detail: '撤销分录本身被撤销，语义不成立',
    });
  }
  const badSplit = db.prepare(`SELECT event_id, occurred_on FROM account_event
      WHERE account_id = ? AND event_type = 'SPLIT' AND (ratio_num IS NULL OR ratio_den IS NULL OR ratio_num <= 0 OR ratio_den <= 0)`)
    .all(id) as any[];
  for (const row of badSplit) {
    violations.push({
      code: 'split_ratio_invalid', severity: 'error', date: row.occurred_on, event_id: row.event_id,
      detail: '拆分比例缺失或非正',
    });
  }
  const beforeBaseline = db.prepare('SELECT event_id, occurred_on FROM account_event WHERE account_id = ? AND occurred_on < ?')
    .all(id, baseline.as_of) as any[];
  for (const row of beforeBaseline) {
    violations.push({
      code: 'event_before_baseline', severity: 'error', date: row.occurred_on, event_id: row.event_id,
      detail: `事件日期早于基线 ${baseline.as_of}，重放时已排除（基线已包含其影响）`,
    });
  }
  const dup = db.prepare('SELECT event_id, COUNT(*) AS n FROM account_event WHERE account_id = ? GROUP BY event_id HAVING n > 1')
    .all(id) as any[];
  for (const row of dup) {
    violations.push({
      code: 'duplicate_event_id', severity: 'error', date: null, event_id: row.event_id,
      detail: `event_id 重复 ${row.n} 次（主键约束被外部绕过）`,
    });
  }

  // 行为层检查：完整重放一遍，收集运行期违规。
  const rows = loadEvents(db, id).filter(r => r.occurred_on >= baseline.as_of);
  const runner = seedRunner(db, baseline);
  let currentDate: string | null = null;
  for (const row of rows) {
    if (row.occurred_on !== currentDate) { runner.releaseUpTo(row.occurred_on); currentDate = row.occurred_on; }
    runner.applyEvent(row);
  }
  if (rows.length) runner.releaseUpTo(rows[rows.length - 1].occurred_on);
  violations.push(...runner.getViolations());

  return {
    ok: violations.filter(v => v.severity === 'error').length === 0,
    account_id: id,
    violations,
    min_cash_balance_cents: runner.getMinCash(),
    events_checked: rows.length,
    conflicts_recorded: conflictsCount(db, id),
    assumptions: ASSUMPTIONS,
  };
}

function conflictsCount(db: DatabaseSync, accountId: string): number {
  if (!ledgerTablesPresent(db)) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM account_event_conflict WHERE account_id = ?').get(accountId) as any;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------- 净值序列

const UNITS_SCALE = 1_000_000n; // 1 份 = 1e6 微单位
const INITIAL_NAV_CENTS = 100n; // 初始单位净值 1.00 元

function divRoundHalfUp(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const negative = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA * 2n + absB) / (absB * 2n);
  return negative ? -q : q;
}

/**
 * 构建基线之后的单位净值序列。
 *
 * 外部现金流口径（**日终现金流**）：
 * - 把当日全部出入金视为发生在日终，按**当日扣流前估值**折算份额；
 * - `nav_before = (value − flow) / units`，`new_units = flow / nav_before`，
 *   等价于 `delta_units = flow × units / (value − flow)`；
 * - 因此资金流本身不改变同一时点的单位净值（同一日价格涨跌仍会体现）。
 *
 * 无法可靠折算时不编造净值：扣流前估值 <= 0、份额为 0 或折算后份额 <= 0 时，
 * 该点标记 `unitisation_skipped` / `insufficient_valuation`，`nav_per_unit = null`，
 * 外部现金流仍保留在 `external_flow_cents` 中。
 *
 * 停牌/缺价：沿用上一已知价并标记 `no_price`/`carried_forward`；从未有价时按成本
 * 兜底并标记 `cost_fallback`。绝不插值。最大回撤在所有参与点都精确时才标
 * `valuation_quality:'exact'`，否则标 `incomplete` 并列出不精确日期。
 */
export function buildNavSeries(
  db: DatabaseSync, accountId: string,
  options: { from?: string; to: string; prices?: PriceTable },
): NavSeries {
  const id = requireText(accountId, 'account_id');
  const gate = realAccountGate(db, id);
  const assumptions = [...ASSUMPTIONS, '净值点按 元/份 保留 6 位小数'];
  const pending: NavSeries = {
    account_id: id, status: gate.status, performance_available: gate.verified,
    data_source: 'synthetic', from: '', to: '', points: [],
    max_drawdown: { available: false, reason: 'no_baseline' },
    assumptions,
    note: gate.verified
      ? '口径：单位净值法（日终现金流，按当日扣流前估值折算），外部现金流不改变单位净值；回撤仅覆盖基线之后，估值不完整时标注 valuation_quality。'
      : 'REAL_ACCOUNT_PENDING：账本数据尚未经用户确认为真实账户；序列只是已记录数据的算术结果，不构成真实账户业绩。',
  };

  if (!ledgerTablesPresent(db)) return pending;
  const baseline = readBaseline(db, id);
  if (!baseline) return pending;

  const to = assertYmd(options.to, 'to');
  const from = options.from ? assertYmd(options.from, 'from') : baseline.as_of;
  const prices = options.prices ?? {};
  const rows = loadEvents(db, id, to).filter(r => r.occurred_on >= baseline.as_of);

  const dateSet = new Set<string>([baseline.as_of, from, to]);
  for (const row of rows) dateSet.add(row.occurred_on);
  for (const date of Object.keys(prices)) dateSet.add(date);
  const dates = [...dateSet]
    .filter(d => d >= baseline.as_of && d <= to && d >= from)
    .sort();

  const snapshot = baseline.snapshot_id ? readSnapshot(db, baseline.snapshot_id) : undefined;
  if (baseline.snapshot_id && !snapshot) throw new Error(`基线引用的快照 ${baseline.snapshot_id} 已不存在`);

  const runner = seedRunner(db, baseline);
  const lastKnown = new Map<string, number>();
  if (snapshot) for (const p of snapshot.positions) lastKnown.set(p.ts_code, p.ref_price_milli);

  const points: NavPoint[] = [];
  let index = 0;
  let currentDate: string | null = null;
  let units = 0n;
  let first = true;
  const dataSource = dataSourceOf(rows, Boolean(baseline.snapshot_id));

  const priceDates = Object.keys(prices).sort();
  let priceIndex = 0;

  for (const date of dates) {
    // 把当日及更早的价格并入"最近已知价"。
    while (priceIndex < priceDates.length && priceDates[priceIndex] <= date) {
      const day = priceDates[priceIndex];
      for (const [code, price] of Object.entries(prices[day] ?? {})) lastKnown.set(code, price);
      priceIndex += 1;
    }
    if (currentDate !== date) {
      runner.releaseUpTo(date);
      currentDate = date;
    }
    while (index < rows.length && rows[index].occurred_on <= date) {
      runner.applyEvent(rows[index]);
      index += 1;
    }

    const state = runner.snapshot();
    const exactPrices = new Map<string, number>();
    for (const [code, price] of Object.entries(prices[date] ?? {})) exactPrices.set(code, price);

    let securities = 0;
    const noPrice: string[] = [];
    const carried: string[] = [];
    const costFallback: string[] = [];
    for (const p of state.positions) {
      const exact = exactPrices.get(p.ts_code);
      let price: number;
      if (exact !== undefined) price = exact;
      else {
        noPrice.push(p.ts_code);
        const last = lastKnown.get(p.ts_code);
        if (last !== undefined) { price = last; carried.push(p.ts_code); }
        else {
          // 从未有过价格：按成本兜底，并明确标记估值不是市价（绝不插值或编造价格）。
          price = Math.round(p.cost_milli_avg);
          costFallback.push(p.ts_code);
        }
      }
      securities += valueCents(p.quantity, price);
    }
    const value = state.cash.balance_cents + securities;
    const flow = runner.flowOn(date);
    const isFirstPoint = first;

    if (first) {
      // 初始单位净值 1.00 元；总估值 <= 0 时不折算份额（不编造净值）。
      units = value > 0 ? BigInt(value) * UNITS_SCALE / INITIAL_NAV_CENTS : 0n;
      first = false;
    }

    let unitisationSkipped = false;
    if (!isFirstPoint && flow !== 0) {
      const preFlowValue = value - flow;
      if (units > 0n && preFlowValue > 0 && value > 0) {
        // 日终现金流：按当日扣流前单位净值折算。资金流本身不改变单位净值。
        const delta = divRoundHalfUp(BigInt(flow) * units, BigInt(preFlowValue));
        if (units + delta > 0n) units += delta;
        else unitisationSkipped = true;
      } else {
        unitisationSkipped = true;
      }
    }

    let status: NavPoint['status'];
    if (value <= 0) status = 'insufficient_valuation';
    else if (units <= 0n) status = unitisationSkipped ? 'unitisation_skipped' : 'insufficient_valuation';
    else if (unitisationSkipped) status = 'unitisation_skipped';
    else if (noPrice.length > 0) status = 'no_price';
    else status = 'ok';

    const confidence: NavPoint['confidence'] = status === 'insufficient_valuation' || status === 'unitisation_skipped'
      ? 'incomplete'
      : costFallback.length > 0 ? 'cost_fallback'
        : carried.length > 0 ? 'carried_forward'
          : 'exact';

    const navPerUnit = (status === 'ok' || status === 'no_price') && units > 0n
      ? round(Number(BigInt(value) * UNITS_SCALE) / Number(units) / 100, 6)
      : null;
    points.push({
      date,
      nav_per_unit: navPerUnit,
      total_value_cents: value,
      units: round(Number(units) / 1e6, 6),
      cash_cents: state.cash.balance_cents,
      status,
      confidence,
      no_price_codes: noPrice.sort(),
      carried_forward_codes: carried.sort(),
      cost_fallback_codes: costFallback.sort(),
      external_flow_cents: flow,
    });
  }

  let maxDrawdown: NavSeries['max_drawdown'];
  const usable = points.filter(p => p.nav_per_unit !== null);
  if (usable.length < 2) maxDrawdown = { available: false, reason: 'insufficient_history' };
  else {
    let peak = Number.NEGATIVE_INFINITY;
    let peakDate: string | null = null;
    let worst = 0;
    let ddFrom: string | null = null;
    let ddTo: string | null = null;
    for (const p of usable) {
      if (p.nav_per_unit! > peak) { peak = p.nav_per_unit!; peakDate = p.date; }
      if (peak > 0) {
        const dd = round(p.nav_per_unit! / peak - 1, 6);
        if (dd < worst) { worst = dd; ddFrom = peakDate; ddTo = p.date; }
      }
    }
    const incompleteDates = points.filter(p => p.confidence !== 'exact').map(p => p.date);
    const valuationQuality = incompleteDates.length === 0 ? 'exact' : 'incomplete';
    maxDrawdown = {
      available: true, value: worst, from: ddFrom, to: ddTo,
      valuation_quality: valuationQuality,
      incomplete_dates: incompleteDates,
      note: incompleteDates.length === 0
        ? null
        : `含 ${incompleteDates.length} 个非精确估值点（缺价沿用/成本兜底/无法估值）；`
          + '回撤数值只是现有价格与事件的算术结果，不代表精确真实回撤',
    };
  }

  return {
    ...pending,
    data_source: dataSource,
    from: dates.length ? dates[0] : from,
    to,
    points,
    max_drawdown: maxDrawdown,
  };
}

// ---------------------------------------------------------------- 真实账户门控

/**
 * 真实账户确认开关。`account_meta.real_account_verified:<account>` = '1' 才算确认；
 * 兼容裸键 `real_account_verified`（全局）。只有 CLI 的 `portfolio-ledger-confirm-real --confirm`
 * 会写它，任何导入/计算路径都不会自动置位。
 */
export function metaKeyFor(accountId: string): string {
  return `real_account_verified:${accountId}`;
}

export function realAccountGate(db: DatabaseSync, accountId: string): { verified: boolean; status: RealAccountStatus; confirmed_at: string | null } {
  if (!ledgerTablesPresent(db)) {
    return { verified: false, status: REAL_ACCOUNT_PENDING, confirmed_at: null };
  }
  const row = db.prepare('SELECT key, value FROM account_meta WHERE key IN (?, ?)')
    .all(metaKeyFor(accountId), 'real_account_verified') as any[];
  const scoped = row.find(r => r.key === metaKeyFor(accountId));
  const global = row.find(r => r.key === 'real_account_verified');
  const atRow = db.prepare('SELECT value FROM account_meta WHERE key = ?')
    .get(`real_account_verified_at:${accountId}`) as any;
  const verified = scoped?.value === '1' || global?.value === '1';
  return {
    verified,
    status: verified ? REAL_ACCOUNT_VERIFIED : REAL_ACCOUNT_PENDING,
    confirmed_at: verified ? (atRow?.value ?? null) : null,
  };
}

/** 用户显式确认。没有 `confirm: true` 直接拒绝，不提供任何"默认确认"。 */
export function confirmRealAccount(
  db: DatabaseSync, accountId: string, options: { confirm?: boolean; note?: string },
) {
  const id = requireText(accountId, 'account_id');
  if (options.confirm !== true) {
    throw new Error('确认真实账户需要显式 --confirm；该动作只能由用户本人执行');
  }
  if (!ledgerTablesPresent(db)) throw new Error('账户库中没有 P2 账本表，请先运行 portfolio-ledger-init');
  const baseline = readBaseline(db, id);
  if (!baseline) throw new Error(`账户 ${id} 没有基线，不能确认为真实账户`);
  const at = new Date().toISOString();
  inPortfolioTransaction(db, () => {
    db.prepare(`INSERT INTO account_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(metaKeyFor(id), '1');
    db.prepare(`INSERT INTO account_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`real_account_verified_at:${id}`, at);
    db.prepare(`INSERT INTO account_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`real_account_verified_note:${id}`, options.note ?? '');
  });
  const gate = realAccountGate(db, id);
  return {
    account_id: id,
    status: gate.status,
    verified: gate.verified,
    confirmed_at: at,
    note: options.note ?? '',
    caveat: '确认只表示"用户声明该账本反映真实账户"，不改变账本来源标记；合成数据仍是合成数据。',
  };
}
