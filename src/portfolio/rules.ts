/**
 * R0 静态交易规则与情景假设。
 *
 * 本文件中的每一个数值都是**假设**，不是券商事实。PRD §14 明确把"券商实际费率"
 * 列为待确认项；在用户核对真实对账单之前，任何输出都必须把 assumed 标记透传到
 * 结果里，不能把这里的数字当成真实成交成本。
 *
 * 金额单位：分（整数）。价格单位：厘（0.001 元，即 A 股 ETF 报价的最小变动价位）。
 */

/** 费率规则。所有字段均为假设值，见 FEE_RULE_PROVENANCE。 */
export interface FeeRules {
  /** 佣金费率（单边）。 */
  commission_rate: number;
  /** 单笔最低佣金（分）。 */
  commission_min_cents: number;
  /** 过户费率（单边）。ETF 场内交易按 0 处理。 */
  transfer_fee_rate: number;
  /** 印花税率（仅卖出）。ETF 免征，按 0 处理。 */
  stamp_duty_rate: number;
  /** 滑点估计（单边），作为保守成本从现金中扣除，不是真实成交价。 */
  slippage_rate_per_side: number;
}

/** 交易单位规则。 */
export interface LotRules {
  /** ETF 一手份数。 */
  etf_lot_size: number;
  /** 买入最低份数。 */
  etf_min_buy: number;
  /** 卖出必须是该份数的整数倍；R0 不允许零股卖出。 */
  etf_sell_multiple: number;
  allow_odd_lot_sell: boolean;
}

export const DEFAULT_FEE_RULES: FeeRules = {
  commission_rate: 0.00025,        // 万 2.5
  commission_min_cents: 500,       // 5 元
  transfer_fee_rate: 0,
  stamp_duty_rate: 0,
  slippage_rate_per_side: 0.0005,  // 万 5
};

export const DEFAULT_LOT_RULES: LotRules = {
  etf_lot_size: 100,
  etf_min_buy: 100,
  etf_sell_multiple: 100,
  allow_odd_lot_sell: false,
};

export const FEE_RULE_VERSION = 'r0-fees-1.0.0';
export const LOT_RULE_VERSION = 'r0-lots-1.0.0';
export const STRESS_RULE_VERSION = 'r0-stress-1.0.0';

type Provenance = { assumed: true; source: string };

const P = (source: string): Provenance => ({ assumed: true, source });

/** 每个假设值的来源标注，随每次情景输出一起返回。 */
export const FEE_RULE_PROVENANCE: Record<keyof FeeRules, Provenance> = {
  commission_rate: P('assumed: PRD §14 待确认（券商实际佣金率未核对）'),
  commission_min_cents: P('assumed: PRD §14 待确认（券商最低佣金未核对）'),
  transfer_fee_rate: P('assumed: ETF 场内交易按无过户费处理，PRD §14 未确认'),
  stamp_duty_rate: P('assumed: ETF 按免印花税处理，PRD §14 未确认'),
  slippage_rate_per_side: P('assumed: 滑点为估计值，非真实成交价差'),
};

export const LOT_RULE_PROVENANCE: Record<keyof LotRules, Provenance> = {
  etf_lot_size: P('assumed: PRD §14 待确认（ETF 交易单位未逐只核对）'),
  etf_min_buy: P('assumed: PRD §14 待确认（最小买入份数未核对）'),
  etf_sell_multiple: P('assumed: R0 只允许整手卖出，零股规则未核对'),
  allow_odd_lot_sell: P('assumed: R0 明确不支持零股卖出'),
};

/** 情景压力假设：对所有权益 ETF 统一施加的静态冲击，不是预测。 */
export interface StressRules {
  /** 冲击幅度，负数表示下跌。 */
  shock_pct: number;
  /** 冲击适用的资产范围。 */
  applies_to: string;
}

export const DEFAULT_STRESS_RULES: StressRules = {
  shock_pct: -0.10,
  applies_to: 'equity_etf',
};

export const STRESS_RULE_PROVENANCE: Record<keyof StressRules, Provenance> = {
  shock_pct: P('declared: 静态压力情景参数，不是收益预测，也不是历史回撤'),
  applies_to: P('declared: 五只持仓与候选均为权益行业/主题 ETF，统一施加冲击'),
};

/** 输出用的规则快照：数值 + assumed 标记 + 来源。 */
export function describeRules(
  fees: FeeRules = DEFAULT_FEE_RULES,
  lots: LotRules = DEFAULT_LOT_RULES,
  stress: StressRules = DEFAULT_STRESS_RULES,
) {
  return {
    fees: { version: FEE_RULE_VERSION, assumed: true as const, values: { ...fees }, provenance: FEE_RULE_PROVENANCE },
    lots: { version: LOT_RULE_VERSION, assumed: true as const, values: { ...lots }, provenance: LOT_RULE_PROVENANCE },
    stress: { version: STRESS_RULE_VERSION, assumed: true as const, values: { ...stress }, provenance: STRESS_RULE_PROVENANCE },
    note: '以上费率、交易单位与冲击幅度均为假设值，未与券商或交易所规则核对；输出中的费用不是真实成交成本。',
  };
}

// ---------------------------------------------------------------- 品种权限

export type InstrumentKind = 'ETF' | 'STOCK';

export interface InstrumentInfo {
  kind: InstrumentKind;
  /** 板块标识，如 688 / 300 / 8 / 4 / 主板。缺省时按代码前缀推断。 */
  board?: string;
}

export interface Tradability {
  tradable: boolean;
  /** 不可执行时的原因代码。 */
  reason?: 'permission_restricted';
  detail?: string;
}

/** 从 6 位代码推断板块。仅用于权限判断，不用于行情查询。 */
export function inferBoard(code: string): string | undefined {
  const digits = code.split('.')[0].replace(/[^0-9]/g, '');
  if (digits.length !== 6) return undefined;
  if (digits.startsWith('688') || digits.startsWith('689')) return '688';
  if (digits.startsWith('300') || digits.startsWith('301')) return '300';
  if (digits.startsWith('8')) return '8';
  if (digits.startsWith('4')) return '4';
  return 'main';
}

const RESTRICTED_BOARDS = new Set(['688', '689', '300', '301', '8', '4']);

/**
 * PRD §4：个股的可执行买入建议限于沪深主板 A 股；创业板(300)、科创板(688)、
 * 北交所(8/4) 现阶段只能研究观察。ETF 不受此限制。
 * 返回结构化结果，便于情景把它写成 NOT_EXECUTABLE 原因而不是抛异常。
 */
export function tradabilityOf(code: string, info: InstrumentInfo): Tradability {
  if (info.kind === 'ETF') return { tradable: true };
  const board = info.board ?? inferBoard(code);
  if (board && RESTRICTED_BOARDS.has(board)) {
    return {
      tradable: false,
      reason: 'permission_restricted',
      detail: `${code} 属于受限板块（${board}），PRD §4 只允许研究观察，不能生成可执行买入预案`,
    };
  }
  return { tradable: true };
}

/** 同上，但以抛错方式强制调用方处理权限问题。 */
export function assertTradableInstrument(code: string, info: InstrumentInfo): void {
  const result = tradabilityOf(code, info);
  if (!result.tradable) throw new Error(result.detail ?? `${code} 无交易权限`);
}
