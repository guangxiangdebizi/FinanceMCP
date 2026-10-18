import { createHash } from 'node:crypto';
import type { AccountSummary, PositionWeight, SnapshotPosition } from './account.js';
import { THEME_BY_CODE, THEME_LABELS, round, valueCents } from './account.js';
import type { ResolvedInstrument } from './instrument.js';
import { checkInstrumentClaim, normalizeClaimKind } from './instrument.js';
import {
  DEFAULT_FEE_RULES, DEFAULT_LOT_RULES, DEFAULT_STOCK_RULES, DEFAULT_STRESS_RULES,
  describeRules, describeStockRules, inferBoard, tradabilityOf,
  type FeeRules, type InstrumentInfo, type InstrumentKind,
  type LotRules, type StockRules, type StressRules,
} from './rules.js';

/**
 * 静态情景引擎（PRD §6/§7，验收 AC-02/AC-03/AC-07/AC-09/AC-10）。
 *
 * 设计约束：
 * - 完全确定性：同一输入（含报价、规则、证据标记）必然得到同一 `decision_id`；
 *   哈希输入中不含任何时间戳。
 * - 只读演示：本模块不写账户库、不写市场库、不访问券商、不下单。
 * - 不预测：`scenario_loss` 是**声明式压力假设**（默认全部权益 ETF −10%），
 *   不是收益预测，也不是历史回撤；`max_drawdown` 永远 `available: false`。
 * - 费用与交易单位全部是假设（见 rules.ts），输出中逐项标注 `assumed: true`。
 *
 * 价格单位：输入报价是**元/份**的浮点数，进入计算前统一四舍五入到整数**厘**
 * （0.001 元，A 股 ETF 最小变动价位）；市值 = round(份数 × 厘 / 10) 分。
 */

// ---------------------------------------------------------------- 输入类型

/** 报价质量。由 etf.ts 的数据填充；缺失时按日期回退推断，见 normalizeQuote。 */
export type QuoteQuality = 'READY' | 'STALE' | 'NOT_READY';

/** 与 ashare/etf.ts 对齐的结构型报价；字段宽松以便调用方直接传入。 */
export interface EtfQuoteInput {
  ts_code?: string;
  code?: string;
  name?: string;
  /** 行情交易日 YYYYMMDD。 */
  trade_date?: string;
  quote_date?: string;
  /** 收盘价，元/份（未复权）。 */
  close?: number;
  price?: number;
  quality?: QuoteQuality;
  /** L 上市 / D 退市 / P 暂停上市。 */
  list_status?: string;
  status?: string;
  /** 当日是否停牌。 */
  suspended?: boolean;
  /** 报价来源。只有 `market_cache` 才是服务端可信报价；缺省按调用方自填处理。 */
  source?: QuoteSource;
}

export interface NormalizedQuote {
  ts_code: string;
  trade_date: string | null;
  /** 整数厘。 */
  price_milli: number | null;
  /** 元/份，展示用。 */
  price: number | null;
  quality: QuoteQuality;
  list_status: string | null;
  suspended: boolean;
  /** 报价来源。缺省视为调用方自填（不可信）。 */
  source: QuoteSource;
  /** 质量不是 READING 时的可读说明。 */
  detail?: string;
}

/** 报价来源：服务端只读缓存 vs 调用方自填。 */
export type QuoteSource = 'market_cache' | 'caller_supplied';

/**
 * 相对优势证据（PRD §6）。布尔 `advantage` 本身不是信号：
 * 只有 `source:'RESEARCH_VERIFIED'` 且带非空 `evidence_id` 才可能支持可执行预案；
 * 其余一律按 UNVERIFIED 处理，结果最多是 NO_ACTION 或 ILLUSTRATIVE。
 */
export interface ScenarioEvidence {
  /** 候选标的相对现有持仓是否有可证明的相对优势。由上游研究提供，本模块不计算。 */
  advantage: boolean;
  /** 优势依据的说明，原样透传。 */
  basis: string;
  source?: 'RESEARCH_VERIFIED' | 'UNVERIFIED';
  /** 研究证据的唯一标识；RESEARCH_VERIFIED 时必须非空。 */
  evidence_id?: string;
  /** 证据对应的研究日期 YYYYMMDD。 */
  as_of?: string;
}

export type ScenarioAction =
  | { type: 'HOLD' }
  | {
      type: 'SELL_AND_BUY';
      sell_code: string;
      sell_shares: number;
      buy_code: string;
      /** 可选：候选最后收盘价，仅在 quotes 缺失时作为兜底并被标记为 ERROR。 */
      buy_instrument?: InstrumentInfo;
    };

export interface ScenarioInput {
  snapshot: AccountSummary;
  /** 行情所属交易日（来自 etf.ts 的 as_of）。 */
  as_of_trade_date: string;
  quotes: Map<string, EtfQuoteInput> | Record<string, EtfQuoteInput>;
  action: ScenarioAction;
  rules?: { fees?: FeeRules; lots?: LotRules; stress?: StressRules; stock?: StockRules };
  /** 候选相对优势证据；缺省视为"无证据"。 */
  evidence?: ScenarioEvidence | null;
  /** 本次情景是否读取到了 ETF 份额数据；R0 默认为 false，会写入 warning。 */
  share_data_available?: boolean;
  /**
   * 服务端解析的标的身份（来自 instrument.ts）。缺省时买入标的只能按
   * 调用方声明 + 代码前缀处理，此时**不可能**得到 EXECUTABLE。
   */
  resolved?: { sell?: ResolvedInstrument; buy?: ResolvedInstrument };
  /**
   * 调用方（工具层）已经确认的前置原因，例如"as_of 不是交易日"或"账户快照不是当前"。
   * 引擎把它们并入 reasons 后统一分类，避免工具层和引擎各写一套状态机。
   */
  preconditions?: Reason[];
}

export type ScenarioStatus = 'EXECUTABLE' | 'ILLUSTRATIVE' | 'NO_ACTION' | 'NOT_EXECUTABLE' | 'DATA_INSUFFICIENT';

export type ReasonCode =
  | 'hold_requested'
  | 'lot_rule'
  | 'insufficient_position'
  | 'insufficient_cash_for_one_lot'
  | 'quote_missing'
  | 'quote_stale'
  | 'instrument_not_tradable'
  | 'permission_restricted'
  | 'instrument_unknown'
  | 'instrument_claim_mismatch'
  | 'account_not_current'
  | 'caller_supplied_quote'
  | 'evidence_unverified'
  | 'no_demonstrated_advantage'
  | 'data_insufficient'
  | 'same_instrument'
  | 'invalid_input';

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface FeeBreakdown {
  commission_cents: number;
  transfer_fee_cents: number;
  stamp_duty_cents: number;
  slippage_estimate_cents: number;
  total_cents: number;
  assumed: true;
}

export interface PositionAfter {
  ts_code: string;
  name: string;
  quantity: number;
  market_value_cents: number;
  weight: number;
  theme: string;
}

export interface ScenarioSide {
  total_assets_cents: number;
  securities_mv_cents: number;
  cash_cents: number;
  wealth_cents: number;
  securities_ratio: number;
  cash_ratio: number;
  concentration: { hhi: number; effective_positions: number };
  top_position: { ts_code: string; name: string; weight: number } | null;
  theme_exposure: { theme: string; label: string; weight: number }[];
 /** 半导体设备主题权重，便于直接对照 PRD §3 的单行业集中问题。 */
  semiconductor_equipment_weight: number;
  positions: PositionAfter[];
}

export interface ComparisonRow {
  action: 'HOLD' | 'ROTATE' | 'REDUCE_EQUITY';
  status: ScenarioStatus;
  executable: boolean;
  securities_mv_cents: number;
  cash_cents: number;
  total_assets_cents: number;
  securities_ratio: number;
  cash_ratio: number;
  hhi: number;
  top_position_weight: number | null;
  semiconductor_equipment_weight: number;
  scenario_loss_cents: number;
  scenario_loss_pct_of_total: number;
  fees_cents: number;
  note: string;
}

export interface ScenarioResult {
  schema: 'ashare-portfolio-scenario/1.0';
  decision_id: string;
  snapshot_id: string;
  snapshot_as_of: string;
  as_of_trade_date: string;
  action: { type: string; sell_code?: string; sell_shares?: number; buy_code?: string };
  status: ScenarioStatus;
  reasons: Reason[];
  warnings: string[];
  quotes: {
    required_codes: string[];
    quote_dates: Record<string, string | null>;
    stale_codes: string[];
    missing_codes: string[];
    /** 混合来源时为 `mixed`。 */
    source: 'market_cache' | 'caller_supplied' | 'mixed';
    /** 逐代码来源，便于审计"价格到底来自哪里"。 */
    per_code: Record<string, QuoteSource>;
    /** 是否为服务端只读缓存按真实交易日取出的报价。 */
    server_cache: boolean;
  };
  trade: {
    sell: {
      ts_code: string;
      quantity: number;
      price_milli: number | null;
      gross_cents: number | null;
      fees: FeeBreakdown | null;
      net_proceeds_cents: number | null;
    } | null;
    buy: {
      ts_code: string;
      lots: number;
      lot_size: number;
      quantity: number;
      price_milli: number | null;
      gross_cents: number | null;
      fees: FeeBreakdown | null;
      total_cost_cents: number | null;
    } | null;
    budget_cents: number;
    residual_cash_cents: number | null;
    /** 卖出价与快照参考价不同带来的差额，与费用分开列出。 */
    price_effect_cents: number | null;
    fees_cents: number;
    /** 收盘价不是下一交易日保证成交价；任何价格字段都只是参考。 */
    execution_price_is_reference: true;
    /** 非可执行状态下的计算演示值（executable:false），trade.buy/sell 已归零。 */
    illustrative?: {
      executable: false;
      lots: number;
      price_milli: number | null;
      gross_cents: number;
      total_cost_cents: number;
      sell?: { ts_code: string; quantity: number; price_milli: number | null; gross_cents: number | null; net_proceeds_cents: number | null };
    };
  };
  before: ScenarioSide;
  after: ScenarioSide | null;
  /** 涉及个股时为 true（T+1 假设，仅提示，不用于撮合）。 */
  t_plus_one: boolean;
  risk: {
    kind: 'declared_stress';
    stress: StressRules;
    assumed: true;
    /** 压力冲击后证券市值相对当前的变动（负数）。 */
    scenario_loss_cents: number;
    scenario_loss_pct_of_total: number;
    after_scenario_loss_cents: number | null;
    after_scenario_loss_pct_of_total: number | null;
    note: string;
  };
  comparison: ComparisonRow[];
  rules: ReturnType<typeof describeRules>;
  evidence: {
    supplied: boolean;
    advantage: boolean | null;
    basis: string | null;
    source: 'RESEARCH_VERIFIED' | 'UNVERIFIED';
    evidence_id: string | null;
    as_of: string | null;
    verified: boolean;
    note: string;
  };
  valuation: {
    basis: string;
    revaluation_note: string;
    price_effect_cents: number | null;
  };
  historical_performance: { available: false; reason: 'no_history' };
  max_drawdown: { available: false; reason: 'no_history' };
  disclaimer: string;
}

// ---------------------------------------------------------------- 报价归一化

/** 元 → 厘，唯一舍入点。 */
export function priceToMilli(price: number): number {
  return Math.round(price * 1000);
}

/**
 * 归一化报价。缺 `quality` 时按日期推断：
 * 无价格 → NOT_READY；`trade_date` 缺失或晚于 as_of → NOT_READY；
 * `trade_date` 早于 as_of → STALE；相等 → READY。
 * 显式给出的 quality 优先，避免上游把过期数据标成 READY 时被本模块悄悄"修正"。
 */
export function normalizeQuote(code: string, raw: EtfQuoteInput | undefined, asOfTradeDate: string): NormalizedQuote {
  if (!raw) {
    return { ts_code: code, trade_date: null, price_milli: null, price: null, quality: 'NOT_READY', list_status: null, suspended: false, source: 'caller_supplied', detail: 'quote absent' };
  }
  const tradeDate = raw.trade_date ?? raw.quote_date ?? null;
  const price = raw.close ?? raw.price;
  const priceMilli = typeof price === 'number' && Number.isFinite(price) && price > 0 ? priceToMilli(price) : null;
  const listStatus = raw.list_status ?? (raw.status === 'L' || raw.status === 'D' || raw.status === 'P' ? raw.status : null);
  const suspended = raw.suspended === true;
  // 只有显式标注为 market_cache 的报价才算服务端来源；其余（含缺省）一律按调用方自填。
  const source: QuoteSource = raw.source === 'market_cache' ? 'market_cache' : 'caller_supplied';
  let quality: QuoteQuality = raw.quality ?? 'READY';
  let detail: string | undefined;
  if (priceMilli === null) {
    quality = 'NOT_READY';
    detail = 'price missing';
  } else if (!tradeDate) {
    quality = 'NOT_READY';
    detail = 'trade_date missing';
  } else if (tradeDate > asOfTradeDate) {
    quality = 'NOT_READY';
    detail = `quote date ${tradeDate} is later than as_of_trade_date ${asOfTradeDate}`;
  } else if (quality === 'READY' && tradeDate !== asOfTradeDate) {
    quality = 'STALE';
    detail = `quote date ${tradeDate} != ${asOfTradeDate}`;
  }
  if (suspended && quality === 'READY') {
    quality = 'STALE';
    detail = 'instrument suspended';
  }
  return {
    ts_code: code, trade_date: tradeDate, price_milli: priceMilli,
    price: priceMilli === null ? null : round(priceMilli / 1000, 3),
    quality, list_status: listStatus, suspended, source, detail,
  };
}

function quoteMap(quotes: ScenarioInput['quotes']): Map<string, EtfQuoteInput> {
  if (quotes instanceof Map) return quotes;
  return new Map(Object.entries(quotes));
}

/** 6 位代码前缀推断品种：1xxxxx（深市基金/债券）与 5xxxxx（沪市基金/债券）按 ETF 处理。 */
export function inferInstrumentKind(code: string): InstrumentKind {
  const digits = code.split('.')[0].replace(/[^0-9]/g, '');
  return digits.startsWith('1') || digits.startsWith('5') ? 'ETF' : 'STOCK';
}

// ---------------------------------------------------------------- 费用

/**
 * 单边费用。逐项舍入（Math.round），并以分为单位累加，避免浮点误差累积。
 * 滑点按估计比例从现金中扣除，是保守成本，不是真实成交价差。
 */
export function computeFees(grossCents: number, side: 'buy' | 'sell', rules: FeeRules): FeeBreakdown {
  const commission = Math.max(Math.round(grossCents * rules.commission_rate), rules.commission_min_cents);
  const transfer = Math.round(grossCents * rules.transfer_fee_rate);
  const stamp = side === 'sell' ? Math.round(grossCents * rules.stamp_duty_rate) : 0;
  const slippage = Math.round(grossCents * rules.slippage_rate_per_side);
  return {
    commission_cents: commission,
    transfer_fee_cents: transfer,
    stamp_duty_cents: stamp,
    slippage_estimate_cents: slippage,
    total_cents: commission + transfer + stamp + slippage,
    assumed: true,
  };
}

/** 一笔买入（含费用）的总现金需求。 */
export function buyTotalCostCents(lots: number, lotCostCents: number, rules: FeeRules): { gross: number; fees: FeeBreakdown; total: number } {
  const gross = lots * lotCostCents;
  const fees = computeFees(gross, 'buy', rules);
  return { gross, fees, total: gross + fees.total_cents };
}

/**
 * 可买手数：先按题面公式 floor(budget / (price × lot × (1 + 费率))) 估算，
 * 再用**真实**的逐笔费用（含最低佣金）向下修正，保证 total_cost ≤ budget。
 * 结果确定，不依赖迭代顺序之外的任何状态。
 */
export function affordableLots(budgetCents: number, lotCostCents: number, rules: FeeRules): number {
  if (lotCostCents <= 0) return 0;
  const rate = rules.commission_rate + rules.transfer_fee_rate + rules.slippage_rate_per_side;
  let lots = Math.max(0, Math.floor(budgetCents / (lotCostCents * (1 + rate))));
  while (lots > 0 && buyTotalCostCents(lots, lotCostCents, rules).total > budgetCents) lots -= 1;
  while (buyTotalCostCents(lots + 1, lotCostCents, rules).total <= budgetCents) lots += 1;
  return lots;
}

// ---------------------------------------------------------------- 组合投影

interface Projection {
  total: number;
  securities: number;
  cash: number;
  wealth: number;
  positions: { ts_code: string; name: string; quantity: number; market_value_cents: number; theme: string }[];
}

function sideOf(p: Projection): ScenarioSide {
  const denom = (v: number) => (p.total > 0 ? round(v / p.total, 6) : 0);
  const positions: PositionAfter[] = p.positions
    .filter(x => x.market_value_cents > 0 && x.quantity > 0)
    .map(x => ({ ...x, weight: denom(x.market_value_cents) }));
  const hhi = round(positions.reduce((a, x) => a + x.weight * x.weight, 0), 6);
  const top = positions.length ? positions.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;
  const themes = new Map<string, number>();
  for (const x of positions) themes.set(x.theme, (themes.get(x.theme) ?? 0) + x.market_value_cents);
  return {
    total_assets_cents: p.total,
    securities_mv_cents: p.securities,
    cash_cents: p.cash,
    wealth_cents: p.wealth,
    securities_ratio: denom(p.securities),
    cash_ratio: denom(p.cash),
    concentration: { hhi, effective_positions: hhi > 0 ? round(1 / hhi, 4) : 0 },
    top_position: top ? { ts_code: top.ts_code, name: top.name, weight: top.weight } : null,
    theme_exposure: [...themes.entries()].sort((a, b) => b[1] - a[1]).map(([theme, mv]) => ({ theme, label: THEME_LABELS[theme] ?? theme, weight: denom(mv) })),
    semiconductor_equipment_weight: denom(themes.get('semiconductor_equipment') ?? 0),
    positions,
  };
}

function projectionOf(summary: AccountSummary): Projection {
  const positions = summary.positions.map((p: PositionWeight) => ({
    ts_code: p.ts_code, name: p.name, quantity: p.quantity, market_value_cents: p.market_value_cents, theme: p.theme,
  }));
  return {
    total: summary.totals.total_assets_cents,
    securities: summary.totals.securities_mv_cents,
    cash: summary.totals.cash_cents,
    wealth: summary.totals.wealth_cents,
    positions,
  };
}

const stressLoss = (securitiesCents: number, stress: StressRules) => Math.round(securitiesCents * stress.shock_pct);

// ---------------------------------------------------------------- 主入口

export function buildScenario(input: ScenarioInput): ScenarioResult {
  const fees = input.rules?.fees ?? DEFAULT_FEE_RULES;
  const lotsRule = input.rules?.lots ?? DEFAULT_LOT_RULES;
  const stress = input.rules?.stress ?? DEFAULT_STRESS_RULES;
  const { snapshot, as_of_trade_date: asOf } = input;
  const quotes = quoteMap(input.quotes);
  const before = sideOf(projectionOf(snapshot));

  const reasons: Reason[] = [];
  const warnings: string[] = [];
  const notExecutable = (code: ReasonCode, detail: string) => reasons.push({ code, detail });

  const action = input.action;
  const isRotate = action.type === 'SELL_AND_BUY';
  const sellCode = isRotate ? action.sell_code : undefined;
  const buyCode = isRotate ? action.buy_code : undefined;

  const requiredCodes = [...new Set([sellCode, buyCode].filter((c): c is string => !!c))];
  const normalized = new Map<string, NormalizedQuote>();
  for (const code of requiredCodes) normalized.set(code, normalizeQuote(code, quotes.get(code), asOf));

  const quoteDates: Record<string, string | null> = {};
  for (const [code, q] of normalized) quoteDates[code] = q.trade_date;
  const staleCodes = [...normalized.values()].filter(q => q.quality === 'STALE').map(q => q.ts_code);
  const missingCodes = [...normalized.values()].filter(q => q.quality === 'NOT_READY').map(q => q.ts_code);
  for (const q of normalized.values()) {
    if (q.quality === 'STALE') warnings.push('quote_stale');
    if (q.quality === 'NOT_READY') warnings.push('quote_missing');
  }

  const emptyFees: FeeBreakdown = { commission_cents: 0, transfer_fee_cents: 0, stamp_duty_cents: 0, slippage_estimate_cents: 0, total_cents: 0, assumed: true };

  // ---------------- HOLD
  if (action.type === 'HOLD') {
    const comparison: ComparisonRow[] = [{
      action: 'HOLD',
      status: 'NO_ACTION',
      executable: false,
      securities_mv_cents: before.securities_mv_cents,
      cash_cents: before.cash_cents,
      total_assets_cents: before.total_assets_cents,
      securities_ratio: before.securities_ratio,
      cash_ratio: before.cash_ratio,
      hhi: before.concentration.hhi,
      top_position_weight: before.top_position?.weight ?? null,
      semiconductor_equipment_weight: before.semiconductor_equipment_weight,
      scenario_loss_cents: stressLoss(before.securities_mv_cents, stress),
      scenario_loss_pct_of_total: round((stressLoss(before.securities_mv_cents, stress) / before.total_assets_cents) * 100, 4),
      fees_cents: 0,
      note: '继续持有：不产生交易，不产生费用。',
    }];
    return {
      schema: 'ashare-portfolio-scenario/1.0',
      decision_id: decisionId(input, normalized, fees, lotsRule, stress),
      snapshot_id: snapshot.snapshot_id,
      snapshot_as_of: snapshot.as_of,
      as_of_trade_date: asOf,
      action: { type: 'HOLD' },
      status: 'NO_ACTION',
      reasons: [{ code: 'hold_requested', detail: '本次情景为继续持有，不产生交易' }],
      warnings: [...new Set(warnings)],
      quotes: { required_codes: [], quote_dates: {}, stale_codes: [], missing_codes: [], source: 'caller_supplied', per_code: {}, server_cache: false },
      trade: {
        sell: null, buy: null, budget_cents: before.cash_cents, residual_cash_cents: before.cash_cents,
        price_effect_cents: null, fees_cents: 0, execution_price_is_reference: true,
      },
      t_plus_one: false,
      before,
      after: null,
      risk: {
        kind: 'declared_stress', stress, assumed: true,
        scenario_loss_cents: stressLoss(before.securities_mv_cents, stress),
        scenario_loss_pct_of_total: round((stressLoss(before.securities_mv_cents, stress) / before.total_assets_cents) * 100, 4),
        after_scenario_loss_cents: null, after_scenario_loss_pct_of_total: null,
        note: `声明式压力假设：全部权益 ETF 下跌 ${(stress.shock_pct * 100).toFixed(0)}%。这是假设，不是预测，也不是历史回撤。`,
      },
      comparison,
      rules: describeRules(fees, lotsRule, stress),
      evidence: { supplied: false, advantage: null, basis: null, source: 'UNVERIFIED', evidence_id: null, as_of: null, verified: false, note: 'HOLD 不需要相对优势证据。' },
      valuation: { basis: 'snapshot_reference_prices', revaluation_note: '未交易；沿用快照参考价。', price_effect_cents: null },
      historical_performance: { available: false, reason: 'no_history' },
      max_drawdown: { available: false, reason: 'no_history' },
      disclaimer: DISCLAIMER,
    };
  }

  // ---------------- SELL_AND_BUY
  const stockRules = input.rules?.stock ?? DEFAULT_STOCK_RULES;
  const sellShares = action.sell_shares;
  const sellPos: PositionWeight | undefined = snapshot.positions.find(p => p.ts_code === sellCode);
  const sellQuote = normalized.get(sellCode!)!;
  const buyQuote = normalized.get(buyCode!)!;

  /** 标的身份：服务端解析（resolved）优先；缺省时按代码前缀与调用方声明交叉核对。 */
  const buyIdentity = identityOfBuy(buyCode!, action.buy_instrument, input.resolved?.buy);
  const sellIdentity = identityOfHeld(sellCode!, input.resolved?.sell);
  if (buyIdentity.unknown) notExecutable('instrument_unknown', buyIdentity.unknown);
  if (buyIdentity.mismatch) notExecutable('instrument_claim_mismatch', buyIdentity.mismatch);
  if (sellIdentity.unknown) notExecutable('instrument_unknown', sellIdentity.unknown);

  const sellIsStock = sellIdentity.kind === 'STOCK';
  const buyIsStock = buyIdentity.kind === 'STOCK';
  const tPlusOne = sellIsStock || buyIsStock;
  const sellFeeRules = sellIsStock ? stockRules.fees : fees;
  const buyFeeRules = buyIsStock ? stockRules.fees : fees;
  const sellLotMultiple = sellIsStock ? stockRules.sell_multiple : lotsRule.etf_sell_multiple;
  const sellAllowOdd = sellIsStock ? stockRules.allow_odd_lot_sell : lotsRule.allow_odd_lot_sell;
  const buyLotSize = buyIsStock ? stockRules.lot_size : lotsRule.etf_lot_size;
  const buyMinBuy = buyIsStock ? stockRules.min_buy : lotsRule.etf_min_buy;
  const unit = buyIsStock ? '股' : '份';

  /** 输入合法性（与行情无关，先判断）。 */
  const integerShares = Number.isFinite(sellShares) && Number.isInteger(sellShares);
  if (!integerShares || sellShares <= 0) {
    notExecutable('invalid_input', `sell_shares 必须为正整数，收到 ${sellShares}`);
  } else if (sellShares % sellLotMultiple !== 0 || (!sellAllowOdd && sellShares < sellLotMultiple)) {
    notExecutable('lot_rule', `卖出 ${sellShares} ${sellIsStock ? '股' : '份'}不是 ${sellLotMultiple} 的整数倍（假设：整手卖出，零股规则未核对）`);
  }
  if (sellCode === buyCode) notExecutable('same_instrument', '卖出与买入为同一标的，不构成轮动');

  /** 权限（PRD §4 / AC-10）：只依据可信身份，绝不依据调用方声明。 */
  if (buyIdentity.kind !== 'UNKNOWN') {
    const tradability = tradabilityOf(buyCode!, { kind: buyIdentity.kind, board: buyIdentity.board ?? undefined });
    if (!tradability.tradable) notExecutable('permission_restricted', tradability.detail ?? `${buyCode} 无交易权限`);
  }

  /** 持仓与行情。 */
  if (!sellPos) {
    notExecutable('insufficient_position', `账户快照不持有 ${sellCode}`);
  } else if (integerShares && sellShares > sellPos.quantity) {
    notExecutable('insufficient_position', `拟卖出 ${sellShares} 份，超过持仓 ${sellPos.quantity} 份`);
  }
  // 上市状态以解析结果为准；解析不到时才退回报价里的字段（此时报价必为调用方自填，不会 EXECUTABLE）。
  const sellListStatus = sellIdentity.list_status ?? sellQuote.list_status;
  const buyListStatus = buyIdentity.list_status ?? buyQuote.list_status;
  if (sellListStatus && sellListStatus !== 'L') {
    notExecutable('instrument_not_tradable', `${sellCode} 上市状态为 ${sellListStatus}，不可交易`);
  }
  if (buyListStatus && buyListStatus !== 'L') {
    notExecutable('instrument_not_tradable', `${buyCode} 上市状态为 ${buyListStatus}，不可交易`);
  }
  if (sellQuote.suspended) notExecutable('instrument_not_tradable', `${sellCode} 停牌`);
  if (buyQuote.suspended) notExecutable('instrument_not_tradable', `${buyCode} 停牌`);
  for (const q of normalized.values()) {
    if (q.quality === 'NOT_READY') notExecutable('quote_missing', `${q.ts_code} 无可用行情：${q.detail ?? q.quality}`);
    // 过期行情可以算，但绝不能被宣称为可执行（验收 AC-06）。
    else if (q.quality === 'STALE') notExecutable('quote_stale', `${q.ts_code} 行情为 ${q.trade_date}，不是 ${asOf}；结果仅供比较，不可执行`);
  }

  /** 交易计算：有价格就计算，无论 status 如何，便于对照。 */
  const canComputeSell = !!sellPos && integerShares && sellShares > 0 && sellQuote.price_milli !== null;
  const sellGross = canComputeSell ? valueCents(sellShares, sellQuote.price_milli!) : null;
  const sellFees = sellGross === null ? null : computeFees(sellGross, 'sell', sellFeeRules);
  const netProceeds = sellGross === null || sellFees === null ? null : sellGross - sellFees.total_cents;
  const budget = netProceeds === null ? null : netProceeds + snapshot.totals.cash_cents;

  const buyPriceMilli = buyQuote.price_milli;
  const lotCost = buyPriceMilli === null ? null : valueCents(buyLotSize, buyPriceMilli);
  let buyLots = 0;
  if (budget !== null && lotCost !== null) {
    buyLots = affordableLots(budget, lotCost, buyFeeRules);
    if (buyLots * buyLotSize < buyMinBuy) {
      buyLots = 0;
      notExecutable('insufficient_cash_for_one_lot', `可用资金 ${(budget / 100).toFixed(2)} 元不足买入一手 ${buyCode}（行情 ${(buyPriceMilli! / 1000).toFixed(3)} 元 × ${buyLotSize} ${unit} = ${(lotCost / 100).toFixed(2)} 元，未计费用）`);
    }
  } else if (budget === null) {
    notExecutable('quote_missing', '卖出价格缺失，无法计算回笼资金');
  } else if (lotCost === null) {
    notExecutable('quote_missing', '买入价格缺失，无法计算一手成本');
  }

  /**
   * 相对优势证据（PRD §6）：布尔 `advantage` 本身不是信号。
   * 只有 RESEARCH_VERIFIED + 非空 evidence_id 才算已证明；其余一律降级。
   */
  const evidence = input.evidence ?? null;
  const evidenceVerified = !!evidence && evidence.advantage === true
    && evidence.source === 'RESEARCH_VERIFIED'
    && typeof evidence.evidence_id === 'string' && evidence.evidence_id.trim() !== '';
  if (!evidence || evidence.advantage !== true) {
    reasons.push({
      code: 'no_demonstrated_advantage',
      detail: evidence
        ? `未证明相对优势：${evidence.basis || '未提供依据'}`
        : '调用方未提供相对优势证据（evidence 缺失）',
    });
  } else if (!evidenceVerified) {
    reasons.push({
      code: 'evidence_unverified',
      detail: `优势声明未经研究验证：需要 source=RESEARCH_VERIFIED 且 evidence_id 非空，收到 source=${evidence.source ?? 'UNVERIFIED'} evidence_id=${evidence.evidence_id ?? '缺失'}`,
    });
  }

  const buyGross = buyLots > 0 ? buyLots * lotCost! : 0;
  const buyFees = buyLots > 0 ? computeFees(buyGross, 'buy', buyFeeRules) : emptyFees;
  const buyTotal = buyGross + buyFees.total_cents;
  const residual = budget === null ? null : budget - buyTotal;
  if (residual !== null && residual < 0) {
    // 理论上一手都买不起时 buyLots 已归零；这里是不可达的兜底，避免出现负剩余现金。
    notExecutable('insufficient_cash_for_one_lot', `可用资金 ${(budget! / 100).toFixed(2)} 元不足以覆盖买入费用`);
  }
  const totalFees = (sellFees?.total_cents ?? 0) + buyFees.total_cents;

  if (sellGross !== null && sellFees) warnings.push('fee_assumed');
  warnings.push('lot_rule_assumed');
  if (tPlusOne) warnings.push('t_plus_one_assumed');
  if (!input.share_data_available) warnings.push('share_data_missing');
  warnings.push('execution_price_is_reference');

  // 工具层已确认的前置条件（如 as_of 非交易日、缓存不可用）并入同一套原因分类。
  for (const r of input.preconditions ?? []) reasons.push(r);
  // 账户币种/时效门控（工作包 A4-3）：不是"当前"快照就永远不能 EXECUTABLE。
  if (snapshot.is_current !== true) {
    reasons.push({
      code: 'account_not_current',
      detail: `账户快照 ${snapshot.snapshot_id}（as_of ${snapshot.as_of}）未标记为当前账户，任何预案最多只能作为演示`,
    });
  }
  // 报价可信级别（工作包 A4-2）：调用方自填报价只能用于研究/演示。
  const callerQuoteCodes = [...normalized.values()].filter(q => q.source === 'caller_supplied').map(q => q.ts_code);
  if (callerQuoteCodes.length > 0) {
    reasons.push({
      code: 'caller_supplied_quote',
      detail: `${callerQuoteCodes.join(', ')} 的价格来自调用方自填，不是服务端缓存行情；仅供研究演示，不可作为可执行预案`,
    });
  }

  /**
   * 状态判定（互斥、按严重度降序）：
   * NOT_EXECUTABLE（规则/权限/行情拒绝）> DATA_INSUFFICIENT（缓存无法回答）
   * > NO_ACTION（无已验证优势）> ILLUSTRATIVE（账户/报价/证据可信度不足）> EXECUTABLE。
   */
  const HARD: ReasonCode[] = ['invalid_input', 'lot_rule', 'insufficient_position', 'insufficient_cash_for_one_lot',
    'quote_missing', 'quote_stale', 'instrument_not_tradable', 'permission_restricted',
    'instrument_unknown', 'instrument_claim_mismatch', 'same_instrument'];
  const DATA: ReasonCode[] = ['data_insufficient'];
  const ILLUSTRATIVE: ReasonCode[] = ['account_not_current', 'caller_supplied_quote', 'evidence_unverified'];
  const has = (codes: ReasonCode[]) => reasons.some(r => codes.includes(r.code));
  const status: ScenarioStatus = has(HARD) ? 'NOT_EXECUTABLE'
    : has(DATA) ? 'DATA_INSUFFICIENT'
    : has(['no_demonstrated_advantage']) ? 'NO_ACTION'
    : has(ILLUSTRATIVE) ? 'ILLUSTRATIVE'
    : 'EXECUTABLE';

  // 非可执行状态绝不能携带一份"看起来能下单"的买卖腿：忽略 status 的消费者只读
  // trade.buy / trade.sell 就会读到价格与手数。两腿因此归零，计算值单独放在
  // illustrative（executable:false）里供人工对照。
  const executable = status === 'EXECUTABLE';
  const illustrative = !executable
    ? {
        executable: false as const,
        lots: buyLots, price_milli: buyPriceMilli, gross_cents: buyGross, total_cost_cents: buyTotal,
        // 费用只属于演示计算；trade.fees_cents 在不可执行状态下为 0。
        fees_cents: (sellFees?.total_cents ?? 0) + buyFees.total_cents,
        ...(sellGross === null ? {} : {
          sell: { ts_code: sellCode!, quantity: sellShares, price_milli: sellQuote.price_milli, gross_cents: sellGross, net_proceeds_cents: netProceeds },
        }),
      }
    : null;
  const illustrativeSell = illustrative?.sell;
  if (!executable) buyLots = 0;
  const buyFeesFinal = buyLots > 0 ? buyFees : emptyFees;
  const buyTotalFinal = buyLots > 0 ? buyTotal : 0;
  const totalFeesFinal = (sellFees?.total_cents ?? 0) + buyFeesFinal.total_cents;

  /** 交易后投影：已卖出部分按快照参考价扣减，买入按成交价计入。 */
  let after: ScenarioSide | null = null;
  let priceEffect: number | null = null;
  if (sellPos && sellGross !== null && integerShares && sellShares > 0) {
    const mvSoldAtSnapshot = Math.round((sellPos.market_value_cents * sellShares) / sellPos.quantity);
    priceEffect = sellGross - mvSoldAtSnapshot;
    // 已卖出的份额按快照市值等比例扣减；买入标的若原本不在持仓中，则新建一行。
    const positions = snapshot.positions.map(p => p.ts_code === sellCode
      ? { ts_code: p.ts_code, name: p.name, quantity: p.quantity - sellShares, market_value_cents: p.market_value_cents - mvSoldAtSnapshot, theme: THEME_BY_CODE[p.ts_code] ?? 'unknown' }
      : { ts_code: p.ts_code, name: p.name, quantity: p.quantity, market_value_cents: p.market_value_cents, theme: THEME_BY_CODE[p.ts_code] ?? 'unknown' });
    // 已持有买入标的时按加仓合并；R0 五只持仓均不在候选内，但保持通用。
    // 非 EXECUTABLE 时 buyLots 已归零，不会把受限标的写进事后投影。
    const existing = positions.find(p => p.ts_code === buyCode);
    if (existing && buyLots > 0) existing.market_value_cents += buyGross;
    else if (buyLots > 0) positions.push({
      ts_code: buyCode!, name: buyQuoteName(buyQuote, quotes.get(buyCode!)), quantity: buyLots * buyLotSize,
      market_value_cents: buyGross, theme: THEME_BY_CODE[buyCode!] ?? 'unknown',
    });
    const cash = snapshot.totals.cash_cents + (netProceeds ?? 0) - buyTotalFinal;
    const securities = positions.reduce((a, p) => a + p.market_value_cents, 0);
    after = sideOf({ positions, cash, wealth: snapshot.totals.wealth_cents, securities, total: securities + cash + snapshot.totals.wealth_cents });
  }
  // 不可执行的情景没有"交易后"状态；保留 null，避免与真实成交混淆。
  if (!executable) after = null;

  const holdRow = comparisonRow('HOLD', 'NO_ACTION', before, 0, stress, '继续持有：不产生交易，不产生费用。');
  const rotateRow = comparisonRow('ROTATE', status, after ?? before, totalFeesFinal, stress,
    status === 'EXECUTABLE' ? `卖出 ${sellCode} ${sellShares} 份，买入 ${buyCode} ${buyLots} 手。`
      : `拟执行换仓，但当前状态为 ${status}，不可作为可执行预案。`);
  const reducePositions = snapshot.positions.map(p => ({
    ts_code: p.ts_code, name: p.name, quantity: p.quantity,
    market_value_cents: p.market_value_cents, theme: THEME_BY_CODE[p.ts_code] ?? 'unknown',
  }));
  if (sellPos && sellGross !== null && integerShares && sellShares > 0) {
    const mvSoldAtSnapshot = Math.round((sellPos.market_value_cents * sellShares) / sellPos.quantity);
    const reduced = reducePositions.find(p => p.ts_code === sellCode);
    if (reduced) reduced.market_value_cents -= mvSoldAtSnapshot;
  }
  const reduceCash = snapshot.totals.cash_cents + (netProceeds ?? 0);
  const reduceSecurities = reducePositions.reduce((a, p) => a + p.market_value_cents, 0);
  const reduceSide = sideOf({
    positions: reducePositions, cash: reduceCash, wealth: snapshot.totals.wealth_cents,
    securities: reduceSecurities, total: reduceSecurities + reduceCash + snapshot.totals.wealth_cents,
  });
  const reduceRow = comparisonRow('REDUCE_EQUITY', 'NOT_EXECUTABLE', reduceSide, sellFees?.total_cents ?? 0, stress,
    '只卖出、不买入：降低权益敞口，保留现金。R0 只作为情景对照，不构成建议。');

  const quoteSources = [...normalized.values()].map(q => q.source);
  const quoteSource: 'market_cache' | 'caller_supplied' | 'mixed' =
    quoteSources.length === 0 ? 'caller_supplied'
      : quoteSources.every(s => s === 'market_cache') ? 'market_cache'
      : quoteSources.every(s => s === 'caller_supplied') ? 'caller_supplied'
      : 'mixed';

  return {
    schema: 'ashare-portfolio-scenario/1.0',
    decision_id: decisionId(input, normalized, fees, lotsRule, stress),
    snapshot_id: snapshot.snapshot_id,
    snapshot_as_of: snapshot.as_of,
    as_of_trade_date: asOf,
    action: { type: 'SELL_AND_BUY', sell_code: sellCode, sell_shares: sellShares, buy_code: buyCode },
    status,
    reasons,
    warnings: [...new Set(warnings)],
    quotes: {
      required_codes: requiredCodes,
      quote_dates: quoteDates,
      stale_codes: staleCodes,
      missing_codes: missingCodes,
      source: quoteSource,
      per_code: Object.fromEntries([...normalized.values()].map(q => [q.ts_code, q.source])),
      server_cache: quoteSource === 'market_cache',
    },
    trade: {
      sell: executable
        ? {
            ts_code: sellCode!, quantity: sellShares, price_milli: sellQuote.price_milli,
            gross_cents: sellGross, fees: sellFees, net_proceeds_cents: netProceeds,
          }
        : {
            ts_code: sellCode!, quantity: 0, price_milli: null, gross_cents: null, fees: null, net_proceeds_cents: null,
          },
      buy: {
        ts_code: buyCode!, lots: buyLots, lot_size: buyLotSize,
        quantity: buyLots * buyLotSize,
        // 不可执行时价格必须为 null：不能让只读 trade.buy 的消费者看到一份可下单的报价。
        price_milli: executable ? buyPriceMilli : null,
        gross_cents: buyLots > 0 ? buyGross : 0, fees: buyFeesFinal,
        total_cost_cents: buyTotalFinal,
      },
      budget_cents: budget ?? 0,
      residual_cash_cents: executable ? residual : (budget === null ? null : budget),
      price_effect_cents: priceEffect,
      // 不可执行时没有交易，因此汇总费用为 0；明细见 trade.illustrative.fees_cents。
      fees_cents: executable ? totalFeesFinal : 0,
      execution_price_is_reference: true,
      ...(illustrative ? { illustrative } : {}),
    },
    t_plus_one: tPlusOne,
    before,
    after,
    risk: {
      kind: 'declared_stress', stress, assumed: true,
      scenario_loss_cents: stressLoss(before.securities_mv_cents, stress),
      scenario_loss_pct_of_total: round((stressLoss(before.securities_mv_cents, stress) / before.total_assets_cents) * 100, 4),
      after_scenario_loss_cents: after ? stressLoss(after.securities_mv_cents, stress) : null,
      after_scenario_loss_pct_of_total: after ? round((stressLoss(after.securities_mv_cents, stress) / after.total_assets_cents) * 100, 4) : null,
      note: `声明式压力假设：全部权益 ETF 下跌 ${(stress.shock_pct * 100).toFixed(0)}%。这是假设，不是预测，也不是历史回撤；真实损失可能更大。`,
    },
    comparison: [holdRow, rotateRow, reduceRow],
    rules: describeRules(fees, lotsRule, stress, stockRules),
    evidence: evidence
      ? {
          supplied: true, advantage: evidence.advantage, basis: evidence.basis,
          source: evidence.source ?? 'UNVERIFIED', evidence_id: evidence.evidence_id ?? null,
          as_of: evidence.as_of ?? null, verified: evidenceVerified,
          note: '相对优势由调用方研究提供，本模块不计算胜率或上涨概率；只有 RESEARCH_VERIFIED 且带 evidence_id 才算已证明。',
        }
      : { supplied: false, advantage: null, basis: null, source: 'UNVERIFIED', evidence_id: null, as_of: null, verified: false, note: '未提供相对优势证据；按 PRD §6 返回 NO_ACTION。' },
    valuation: {
      basis: 'snapshot_reference_prices_except_new_buy',
      revaluation_note: '交易前按快照参考价；卖出部分按快照市值等比例扣减；新买入按本次行情价计入。卖出价与快照参考价的差额单列在 price_effect_cents，不与费用混同。行情收盘价不是下一交易日的保证成交价。',
      price_effect_cents: priceEffect,
    },
    historical_performance: { available: false, reason: 'no_history' },
    max_drawdown: { available: false, reason: 'no_history' },
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------- 标的身份核对

interface IdentityResult {
  kind: InstrumentKind | 'UNKNOWN';
  board: string | null;
  list_status: string | null;
  /** 调用方声明与解析结果/代码前缀矛盾。 */
  mismatch?: string;
  /** 无法确认品种。 */
  unknown?: string;
}

/**
 * 买入标的身份。`resolved`（来自 instrument.ts 的服务端解析）是权威；缺省时用代码
 * 前缀与调用方声明交叉核对，任何与前缀矛盾的声明都被拒绝，绝不因为调用方写了
 * `buy_kind='etf'` 就把 688/689/300/301/8/4 的个股当成 ETF。
 */
function identityOfBuy(code: string, claim: InstrumentInfo | undefined, resolved: ResolvedInstrument | undefined): IdentityResult {
  const prefixKind = inferInstrumentKind(code);
  const prefixBoard = inferBoard(code) ?? null;
  if (resolved) {
    if (!resolved.found || resolved.kind === 'UNKNOWN') {
      return { kind: 'UNKNOWN', board: null, list_status: resolved.list_status, unknown: `${code} 无法从本地市场缓存确认品种：${resolved.detail}` };
    }
    const check = checkInstrumentClaim({ kind: claim?.kind, board: claim?.board }, resolved);
    if (!check.ok) return { kind: resolved.kind, board: resolved.board, list_status: resolved.list_status, mismatch: check.detail };
    return { kind: resolved.kind, board: resolved.board, list_status: resolved.list_status };
  }
  if (claim?.kind && claim.kind !== prefixKind) {
    return {
      kind: prefixKind, board: prefixBoard, list_status: null,
      mismatch: `调用方声明 buy_kind=${claim.kind}，但 ${code} 的代码前缀表明是 ${prefixKind}（未提供服务端解析时按前缀保守判定）`,
    };
  }
  if (claim?.board && prefixKind === 'STOCK' && prefixBoard && claim.board !== prefixBoard) {
    return {
      kind: 'STOCK', board: prefixBoard, list_status: null,
      mismatch: `调用方声明 buy_board=${claim.board}，但 ${code} 的代码前缀属于 ${prefixBoard}`,
    };
  }
  return { kind: prefixKind, board: prefixBoard, list_status: null };
}

/** 持仓标的身份：只用于选择费用/交易单位与上市状态，不涉及买入权限。 */
function identityOfHeld(code: string, resolved: ResolvedInstrument | undefined): IdentityResult {
  if (!resolved) return { kind: inferInstrumentKind(code), board: inferBoard(code) ?? null, list_status: null };
  if (!resolved.found || resolved.kind === 'UNKNOWN') {
    return { kind: 'UNKNOWN', board: null, list_status: resolved.list_status, unknown: `${code} 无法从本地市场缓存确认品种：${resolved.detail}` };
  }
  return { kind: resolved.kind, board: resolved.board, list_status: resolved.list_status };
}

const DISCLAIMER = '本情景为只读演示账户上的静态确定性计算，不构成投资建议、不预测收益、不代表任何策略有效；费用、交易单位与压力参数均为假设值，交易由用户本人在券商手动执行。';

function buyQuoteName(quote: NormalizedQuote, raw: EtfQuoteInput | undefined): string {
  return raw?.name ?? quote.ts_code;
}

function comparisonRow(
  action: ComparisonRow['action'], status: ScenarioStatus, side: ScenarioSide,
  feesCents: number, stress: StressRules, note: string,
): ComparisonRow {
  const loss = stressLoss(side.securities_mv_cents, stress);
  return {
    action, status, executable: status === 'EXECUTABLE',
    securities_mv_cents: side.securities_mv_cents,
    cash_cents: side.cash_cents,
    total_assets_cents: side.total_assets_cents,
    securities_ratio: side.securities_ratio,
    cash_ratio: side.cash_ratio,
    hhi: side.concentration.hhi,
    top_position_weight: side.top_position?.weight ?? null,
    semiconductor_equipment_weight: side.semiconductor_equipment_weight,
    scenario_loss_cents: loss,
    scenario_loss_pct_of_total: side.total_assets_cents > 0 ? round((loss / side.total_assets_cents) * 100, 4) : 0,
    fees_cents: feesCents,
    note,
  };
}

/**
 * decision_id：对不含时间戳的规范化输入做 sha256。同一快照、同一行情、同一动作、
 * 同一规则与证据必然得到同一 ID，便于审计与复盘。
 */
function decisionId(
  input: ScenarioInput,
  quotes: Map<string, NormalizedQuote>,
  fees: FeeRules, lots: LotRules, stress: StressRules,
): string {
  const action = input.action.type === 'HOLD'
    ? { type: 'HOLD' }
    : { type: 'SELL_AND_BUY', sell_code: input.action.sell_code, sell_shares: input.action.sell_shares, buy_code: input.action.buy_code, buy_instrument: input.action.buy_instrument ?? null };
  const canonical = JSON.stringify({
    schema: 'ashare-portfolio-scenario/1.0',
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_totals: input.snapshot.totals,
    snapshot_is_current: input.snapshot.is_current === true,
    positions: input.snapshot.positions.map(p => [p.ts_code, p.quantity, p.market_value_cents]),
    as_of_trade_date: input.as_of_trade_date,
    action,
    quotes: [...quotes.values()].sort((a, b) => a.ts_code.localeCompare(b.ts_code))
      .map(q => [q.ts_code, q.trade_date, q.price_milli, q.quality, q.list_status, q.suspended, q.source]),
    resolved: {
      sell: input.resolved?.sell ? [input.resolved.sell.kind, input.resolved.sell.board, input.resolved.sell.list_status] : null,
      buy: input.resolved?.buy ? [input.resolved.buy.kind, input.resolved.buy.board, input.resolved.buy.list_status] : null,
    },
    preconditions: (input.preconditions ?? []).map(r => r.code).sort(),
    evidence: input.evidence
      ? { advantage: input.evidence.advantage, basis: input.evidence.basis, source: input.evidence.source ?? 'UNVERIFIED', evidence_id: input.evidence.evidence_id ?? null }
      : null,
    shares: input.share_data_available === true,
    rules: { fees, lots, stress },
  });
  return createHash('sha256').update(canonical).digest('hex');
}
