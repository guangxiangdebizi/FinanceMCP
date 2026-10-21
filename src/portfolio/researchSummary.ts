import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  THEME_BY_CODE, THEME_LABELS, accountSummary, latestSnapshot, readSnapshot, round, valueCents,
  type AccountSnapshot, type AccountSummary,
} from './account.js';
import { realAccountGate, settlementCalendarFromDb, type RealAccountStatus } from './ledger.js';
import { resolveAccountState } from './accounts.js';
import {
  ASSET_CLASSES, ASSET_CLASS_LABELS, INDUSTRY_BY_CODE, buildDecision, classifyAssetClass,
  loadEtfQuote, normalizeSecurityCode,
  type AssetClass, type DecisionAction, type DecisionOption, type TradeLeg,
} from './decision.js';
import { resolveInstrument } from './instrument.js';
import { loadServerQuote, tradeCalendar } from './quotes.js';
import { DEFAULT_LOT_RULES } from './rules.js';
import { latestReportMeta, loadReport, type ReportMeta } from '../ashare/report.js';

/**
 * 研究模式账户晚间摘要（R2 工作包 B）。
 *
 * 设计边界（PRD §3/§6/§8）：
 * - 这是**研究材料**，不是交易计划：状态永远是 RESEARCH_ONLY / ILLUSTRATIVE /
 *   NO_ACTION / DATA_INSUFFICIENT 之一，绝不返回 ACTIONABLE，也没有主展示的可执行数量。
 * - 两个库都只读：账户库只读快照 / 账本门控，市场库只读 `fund_basic` / `fund_daily` /
 *   `trade_cal` / `report`。不写任一数据库，不访问网络。
 * - 行情只来自服务端只读缓存；缺 bar / 旧 bar / OHLC 异常都必须显式出现在
 *   `holdings` 与 `data_quality` 中，缺失时回退到快照参考价并标注来源，绝不静默替换。
 * - 市场环境复用现有 `ashare_daily_report`（`report` 表 + `loadReport`），不另造行情管线。
 * - 市场证据（AC-04）只列事实与方向，不把任何固定阈值写成“反弹已确认”，整体标记
 *   `research_status:'UNVERIFIED'`，前瞻检验留待后续。
 */

export const RESEARCH_SUMMARY_SCHEMA = 'ashare-portfolio-research-summary/1.0';

export const RESEARCH_SUMMARY_DISCLAIMER =
  '研究模式摘要：市场研究与账户交易决定分开表述；本输出不是交易建议，永远不是 ACTIONABLE，也不含可直接下单的数量。行情只来自本地只读缓存，缺失或过期会显式标注。';

export type ResearchSummaryStatus = 'RESEARCH_ONLY' | 'ILLUSTRATIVE' | 'NO_ACTION' | 'DATA_INSUFFICIENT';

export interface ResearchSummaryInput {
  portfolioDb: DatabaseSync;
  /** 只读市场缓存；缺失时返回 DATA_INSUFFICIENT，不伪造行情。 */
  marketDb: DatabaseSync | null | undefined;
  accountId: string;
  /** 目标交易日 YYYYMMDD。 */
  asOfTradeDate: string;
  snapshotId?: string;
  /** 候选 ETF；允许在现有五只持仓之外，但只做研究对照。 */
  candidateCode?: string;
  /** 拟卖出的持仓与份数；与候选一起才构成轮动示意。 */
  sell?: { code: string; shares: number } | null;
}

export type EvidenceDirection = 'support' | 'contradiction' | 'neutral';

export interface MarketEvidenceItem {
  id: string;
  statement: string;
  value: number | string | boolean | null;
  unit?: string;
  as_of: string;
  source: string;
  direction: EvidenceDirection;
}

export type ConstraintState = 'satisfied' | 'unsatisfied' | 'candidate_required' | 'not_applicable' | 'unknown';

export interface DecisionConstraint {
  id: string;
  requirement: string;
  state: ConstraintState;
  detail: string;
}

export interface ConstraintOption {
  action: 'HOLD' | 'REDUCE_EQUITY' | 'SELL_AND_BUY' | 'NO_ACTION';
  label: string;
  /** buildDecision 给出的原始状态，仅用于审计；本摘要不会升级为 ACTIONABLE。 */
  decision_status: string;
  executable: false;
  constraints: DecisionConstraint[];
  /** 只放非执行示意腿；每条腿 executable 恒为 false。 */
  illustrative_legs: TradeLeg[];
  note: string;
}

export interface ResearchHolding {
  ts_code: string;
  name: string;
  quantity: number;
  /** 以重估后总资产为分母的权重。 */
  weight: number;
  weight_of_securities: number;
  market_value_cents: number;
  asset_class: AssetClass;
  asset_class_basis: string;
  theme: string;
  theme_label: string;
  industry: string;
  /** 截至 as_of 的最新一根 bar 日期；无 bar 为 null。 */
  latest_bar_date: string | null;
  /** READY / STALE / NOT_READY / MISSING。 */
  bar_quality: 'READY' | 'STALE' | 'NOT_READY' | 'MISSING';
  bar_reasons: string[];
  /** 用于估值的价格（厘）；缺失时是快照参考价，见 price_source。 */
  price_milli: number;
  price_source: 'server_cache_close' | 'snapshot_reference_price';
  price_used_for_revaluation: boolean;
  source: 'server_cache' | 'snapshot_reference';
}

export interface ReasonCode {
  code: string;
  detail: string;
}

// ---------------------------------------------------------------- 小工具

const YMD = /^\d{8}$/;

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function latestBarDate(db: DatabaseSync | null | undefined, code: string, asOf: string, kind: 'ETF' | 'STOCK' | 'UNKNOWN'): string | null {
  if (!db || kind === 'UNKNOWN') return null;
  const table = kind === 'STOCK' ? 'daily' : 'fund_daily';
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT MAX(trade_date) AS d FROM ${table} WHERE ts_code = ? AND trade_date <= ?`).get(code, asOf) as any;
  return row?.d ? String(row.d) : null;
}

function sanitizeLegs(legs: TradeLeg[] | undefined): TradeLeg[] {
  // 研究摘要里任何腿都不可执行；即便如此也逐条显式写 executable:false。
  return (legs ?? []).map(leg => ({ ...leg, executable: false }));
}

function optionOf(options: DecisionOption[], action: string): DecisionOption | undefined {
  return options.find(option => option.action === action);
}

// ---------------------------------------------------------------- 市场报告

interface MarketContext {
  available: boolean;
  reason: string | null;
  detail: string | null;
  report_id: string | null;
  as_of_trade_date: string | null;
  status: string | null;
  freshness: 'same_day' | 'prior_day' | 'missing';
  regime: { value: string | null; label: string | null; tone: string | null } | null;
  index_returns: {
    ts_code: string; name: string | null; close: number | null; pct_chg: number | null;
    ret5: number | null; ret20: number | null; above_ma20: boolean | null; above_ma60: boolean | null;
    amount_yi: number | null;
  }[];
  breadth: {
    stocks: number | null; up: number | null; down: number | null; flat: number | null;
    limit_up: number | null; limit_down: number | null; up_ratio: number | null;
    median_pct_chg: number | null; amount_yi: number | null; amount_ma20_yi: number | null;
    amount_vs_ma20: number | null; pct_above_ma20: number | null; pct_above_ma60: number | null;
  };
  sectors: {
    top: { industry: string; rank: number | null; strength: number | null; ret5_median_pct: number | null; ret20_median_pct: number | null; pct_above_ma20: number | null }[];
    bottom: { industry: string; rank: number | null; strength: number | null; ret5_median_pct: number | null; ret20_median_pct: number | null; pct_above_ma20: number | null }[];
    all: { industry: string; ret20_median_pct: number | null }[];
  };
  judgement: string[];
}

const EMPTY_BREADTH: MarketContext['breadth'] = {
  stocks: null, up: null, down: null, flat: null, limit_up: null, limit_down: null,
  up_ratio: null, median_pct_chg: null, amount_yi: null, amount_ma20_yi: null,
  amount_vs_ma20: null, pct_above_ma20: null, pct_above_ma60: null,
};

function sectorView(row: any) {
  return {
    industry: String(row?.industry ?? ''),
    rank: numOf(row?.rank),
    strength: numOf(row?.strength),
    ret5_median_pct: numOf(row?.ret5_median_pct),
    ret20_median_pct: numOf(row?.ret20_median_pct),
    pct_above_ma20: numOf(row?.pct_above_ma20),
  };
}

function loadMarketContext(marketDb: DatabaseSync | null | undefined, asOf: string): {
  context: MarketContext; meta: ReportMeta | null;
} {
  const unavailable = (reason: string, detail: string, meta: ReportMeta | null = null): MarketContext => ({
    available: false, reason, detail,
    report_id: meta?.report_id ?? null, as_of_trade_date: meta?.trade_date ?? null, status: meta?.status ?? null,
    freshness: 'missing', regime: null, index_returns: [], breadth: { ...EMPTY_BREADTH },
    sectors: { top: [], bottom: [], all: [] }, judgement: [],
  });

  if (!marketDb) return { context: unavailable('market_report_missing', '没有可用的只读市场缓存，无法读取日报'), meta: null };
  if (!tableExists(marketDb, 'report')) {
    return { context: unavailable('market_report_missing', '市场缓存没有 report 表'), meta: null };
  }
  const meta = latestReportMeta(marketDb, undefined, true, asOf) ?? null;
  if (!meta) return { context: unavailable('market_report_missing', `${asOf} 及之前没有 READY 日报`), meta: null };

  let report: any;
  try {
    report = loadReport(meta);
  } catch (error: any) {
    return { context: unavailable('market_report_unreadable', `日报文件无法读取：${error?.message ?? error}`, meta), meta };
  }
  if (!report || !report.market) {
    return { context: unavailable('market_report_incomplete', '日报缺少 market 区块，无法给出市场环境', meta), meta };
  }

  const market = report.market ?? {};
  const breadth = market.breadth ?? {};
  const amount = numOf(breadth.amount_yi);
  const amountMa20 = numOf(breadth.amount_ma20_yi);
  const indices = Array.isArray(market.indices) ? market.indices.map((row: any) => ({
    ts_code: String(row?.ts_code ?? ''),
    name: strOf(row?.name),
    close: numOf(row?.close),
    pct_chg: numOf(row?.pct_chg),
    ret5: numOf(row?.ret5),
    ret20: numOf(row?.ret20),
    above_ma20: typeof row?.above_ma20 === 'boolean' ? row.above_ma20 : null,
    above_ma60: typeof row?.above_ma60 === 'boolean' ? row.above_ma60 : null,
    amount_yi: numOf(row?.amount_yi),
  })) : [];
  const top = Array.isArray(report?.sectors?.top) ? report.sectors.top.map(sectorView) : [];
  const bottom = Array.isArray(report?.sectors?.bottom) ? report.sectors.bottom.map(sectorView) : [];
  const all = Array.isArray(report?.sectors?.all)
    ? report.sectors.all.map((row: any) => ({ industry: String(row?.industry ?? ''), ret20_median_pct: numOf(row?.ret20_median_pct) }))
    : [];

  const context: MarketContext = {
    available: true,
    reason: null,
    detail: null,
    report_id: meta.report_id,
    as_of_trade_date: meta.trade_date,
    status: meta.status,
    freshness: meta.trade_date === asOf ? 'same_day' : 'prior_day',
    regime: {
      value: strOf(market.regime),
      label: strOf(market.regime_label),
      tone: strOf(market.tone),
    },
    index_returns: indices,
    breadth: {
      stocks: numOf(breadth.stocks),
      up: numOf(breadth.up),
      down: numOf(breadth.down),
      flat: numOf(breadth.flat),
      limit_up: numOf(breadth.limit_up),
      limit_down: numOf(breadth.limit_down),
      up_ratio: numOf(breadth.up_ratio),
      median_pct_chg: numOf(breadth.median_pct_chg),
      amount_yi: amount,
      amount_ma20_yi: amountMa20,
      amount_vs_ma20: amount != null && amountMa20 != null && amountMa20 > 0 ? round(amount / amountMa20, 4) : null,
      pct_above_ma20: numOf(breadth.pct_above_ma20),
      pct_above_ma60: numOf(breadth.pct_above_ma60),
    },
    sectors: { top, bottom, all },
    judgement: Array.isArray(market.judgement) ? market.judgement.map((line: unknown) => String(line)) : [],
  };
  return { context, meta };
}

// ---------------------------------------------------------------- 市场证据（AC-04 研究切片）

function evidenceItem(
  id: string, statement: string, value: number | string | boolean | null,
  unit: string | undefined, asOf: string, source: string, direction: EvidenceDirection,
): MarketEvidenceItem {
  return { id, statement, value, ...(unit ? { unit } : {}), as_of: asOf, source, direction };
}

function signDirection(value: number | null, positive: EvidenceDirection = 'support', negative: EvidenceDirection = 'contradiction'): EvidenceDirection {
  if (value == null || value === 0) return 'neutral';
  return value > 0 ? positive : negative;
}

function buildMarketEvidence(
  context: MarketContext, asOf: string, holdings: ResearchHolding[], missingFields: string[],
): {
  research_status: 'UNVERIFIED';
  available: boolean;
  forward_validation_required: true;
  threshold_policy: string;
  as_of_trade_date: string;
  support: MarketEvidenceItem[];
  contradiction: MarketEvidenceItem[];
  neutral: MarketEvidenceItem[];
} {
  const items: MarketEvidenceItem[] = [];
  const reportRef = context.report_id ?? 'ashare_daily_report';
  const reportAsOf = context.as_of_trade_date ?? asOf;
  const sourceOf = (field: string) => `ashare_daily_report:${reportRef}:${field}`;

  if (context.available) {
    const b = context.breadth;

    if (b.up_ratio != null) {
      const direction: EvidenceDirection = b.up_ratio >= 0.5 ? 'support' : b.up_ratio <= 0.35 ? 'contradiction' : 'neutral';
      items.push(evidenceItem('breadth_up_ratio', `上涨家数占比 ${(b.up_ratio * 100).toFixed(1)}%（上涨 ${b.up ?? '-'} / 下跌 ${b.down ?? '-'}）`,
        b.up_ratio, 'ratio', reportAsOf, sourceOf('market.breadth.up_ratio'), direction));
    }
    if (b.median_pct_chg != null) {
      items.push(evidenceItem('breadth_median_return', `个股涨跌幅中位数 ${b.median_pct_chg.toFixed(2)}%`,
        b.median_pct_chg, 'pct', reportAsOf, sourceOf('market.breadth.median_pct_chg'), signDirection(b.median_pct_chg)));
    }
    if (b.amount_vs_ma20 != null) {
      const direction: EvidenceDirection = b.amount_vs_ma20 >= 1 ? 'support' : b.amount_vs_ma20 < 0.9 ? 'contradiction' : 'neutral';
      items.push(evidenceItem('breadth_amount_vs_ma20', `两市成交额为 20 日均值的 ${(b.amount_vs_ma20 * 100).toFixed(0)}%（${b.amount_yi ?? '-'} 亿 / ${b.amount_ma20_yi ?? '-'} 亿）`,
        b.amount_vs_ma20, 'x', reportAsOf, sourceOf('market.breadth.amount_ma20_yi'), direction));
    }
    for (const [id, value, label] of [
      ['pct_above_ma20', b.pct_above_ma20, '站上 MA20'],
      ['pct_above_ma60', b.pct_above_ma60, '站上 MA60'],
    ] as const) {
      if (value == null) continue;
      const direction: EvidenceDirection = value >= 50 ? 'support' : value <= 30 ? 'contradiction' : 'neutral';
      items.push(evidenceItem(`breadth_${id}`, `${label} 的个股占比 ${value.toFixed(1)}%`, value, 'pct', reportAsOf, sourceOf(`market.breadth.${id}`), direction));
    }

    for (const index of context.index_returns) {
      const name = index.name ?? index.ts_code;
      if (index.ret5 != null) {
        items.push(evidenceItem(`index_ret5:${index.ts_code}`, `${name} 近 5 日收益 ${index.ret5.toFixed(2)}%`,
          index.ret5, 'pct', reportAsOf, sourceOf('market.indices'), signDirection(index.ret5)));
      }
      if (index.ret20 != null) {
        items.push(evidenceItem(`index_ret20:${index.ts_code}`, `${name} 近 20 日收益 ${index.ret20.toFixed(2)}%`,
          index.ret20, 'pct', reportAsOf, sourceOf('market.indices'), signDirection(index.ret20)));
      }
      for (const [id, value, label] of [
        ['above_ma20', index.above_ma20, 'MA20 之上'],
        ['above_ma60', index.above_ma60, 'MA60 之上'],
      ] as const) {
        if (value == null) continue;
        items.push(evidenceItem(`index_${id}:${index.ts_code}`, `${name} 收盘${value ? '' : '未'}${label}`,
          value, undefined, reportAsOf, sourceOf('market.indices'), value ? 'support' : 'contradiction'));
      }
    }

    for (const [id, row, label] of [
      ['sector_leadership', context.sectors.top[0], '领涨行业'],
      ['sector_weakness', context.sectors.bottom[0], '弱势行业'],
    ] as const) {
      if (!row || row.ret20_median_pct == null) continue;
      items.push(evidenceItem(`${id}:${row.industry}`, `${label} ${row.industry} 20 日中位收益 ${row.ret20_median_pct.toFixed(2)}%`,
        row.ret20_median_pct, 'pct', reportAsOf, sourceOf('sectors'), signDirection(row.ret20_median_pct)));
    }

    // 持有主题相对强弱：用现有日报的行业 20 日中位收益对比宽基指数，不新增数据管线。
    const broad = context.index_returns.find(index => index.ts_code === '000300.SH')
      ?? context.index_returns.find(index => index.ret20 != null);
    const broadRet20 = broad?.ret20 ?? null;
    const seenIndustry = new Set<string>();
    for (const holding of holdings) {
      if (holding.theme === 'unknown' || !holding.industry || holding.industry === 'unclassified') continue;
      if (seenIndustry.has(holding.industry)) continue;
      seenIndustry.add(holding.industry);
      const sector = context.sectors.all.find(row => row.industry === holding.industry);
      if (!sector || sector.ret20_median_pct == null || broadRet20 == null) {
        items.push(evidenceItem(`theme_relative_strength:${holding.theme}`,
          `持有主题 ${holding.theme_label} 缺少行业或宽基收益，无法比较相对强弱`,
          null, undefined, reportAsOf, sourceOf('sectors.all'), 'neutral'));
        continue;
      }
      const diff = round(sector.ret20_median_pct - broadRet20, 2);
      items.push(evidenceItem(`theme_relative_strength:${holding.theme}`,
        `持有主题 ${holding.theme_label}（${holding.industry}）20 日中位收益相对 ${broad?.name ?? broad?.ts_code ?? '宽基'} ${diff >= 0 ? '高' : '低'} ${Math.abs(diff).toFixed(2)} 个百分点`,
        diff, 'pct', reportAsOf, sourceOf('sectors.all'), signDirection(diff)));
    }

    items.push(evidenceItem('data_freshness_report',
      context.freshness === 'same_day'
        ? `市场日报与目标交易日同日（${reportAsOf}）`
        : `市场日报日期 ${reportAsOf} 早于目标交易日 ${asOf}`,
      context.freshness, undefined, reportAsOf, sourceOf('report.trade_date'),
      context.freshness === 'same_day' ? 'neutral' : 'contradiction'));
  } else {
    items.push(evidenceItem('market_report_missing', context.detail ?? '没有可用市场日报', null, undefined,
      asOf, 'ashare_daily_report', 'neutral'));
  }

  const stale = holdings.filter(holding => holding.bar_quality !== 'READY').map(holding => holding.ts_code);
  items.push(evidenceItem('data_freshness_quotes',
    stale.length === 0 ? '全部持仓的最新 bar 与目标交易日一致' : `以下持仓的 bar 过期或缺失：${stale.join(', ')}`,
    stale.length, 'codes', asOf, 'fund_daily', stale.length === 0 ? 'neutral' : 'contradiction'));

  if (missingFields.length > 0) {
    items.push(evidenceItem('data_missing_fields', `缺失字段：${missingFields.join(', ')}`,
      missingFields.join(','), undefined, asOf, 'research_summary', 'neutral'));
  }

  return {
    research_status: 'UNVERIFIED',
    available: context.available,
    forward_validation_required: true,
    threshold_policy: '上述方向只是可复核的事实现象（广度、量能、指数收益、行业相对强弱、数据新鲜度），不把任何固定阈值当作“反弹已确认”；研究有效性必须由后续前瞻检验确认。',
    as_of_trade_date: asOf,
    support: items.filter(item => item.direction === 'support'),
    contradiction: items.filter(item => item.direction === 'contradiction'),
    neutral: items.filter(item => item.direction === 'neutral'),
  };
}

// ---------------------------------------------------------------- 决策约束

interface ConstraintFacts {
  snapshot: AccountSnapshot;
  holdings: ResearchHolding[];
  allHoldingQuotesReady: boolean;
  sellCode: string | null;
  sellShares: number | null;
  sellHolding: ResearchHolding | null;
  candidateCode: string | null;
  candidateResolvedKind: string | null;
  candidateCached: boolean;
  candidateQuoteReady: boolean;
  candidatePriceMilli: number | null;
}

function constraint(
  id: string, requirement: string, state: ConstraintState, detail: string,
): DecisionConstraint {
  return { id, requirement, state, detail };
}

function buildDecisionConstraints(
  facts: ConstraintFacts, decisionOptions: DecisionOption[] | null,
): ConstraintOption[] {
  const { snapshot, holdings } = facts;
  const accountCurrent = snapshot.is_current === true;
  const staleCodes = holdings.filter(holding => holding.bar_quality !== 'READY').map(holding => holding.ts_code);
  const accountConstraint = constraint(
    'account_current', '账户快照必须经用户确认为当前账户',
    accountCurrent ? 'satisfied' : 'unsatisfied',
    accountCurrent ? '快照 is_current=true' : '快照 is_current=false（PRD §3 截图基线只能研究）',
  );

  const selLegState: ConstraintState = facts.sellCode && facts.sellShares != null ? 'satisfied' : 'candidate_required';
  const sellDetail = facts.sellCode && facts.sellShares != null
    ? `${facts.sellCode} × ${facts.sellShares} 份`
    : '未提供 --sell/--shares，不臆造卖出标的与数量';

  const positionOk = !!facts.sellHolding && facts.sellShares != null && facts.sellShares > 0 && facts.sellShares <= facts.sellHolding.quantity;
  const lotRuleOk = facts.sellShares != null && Number.isInteger(facts.sellShares)
    && facts.sellShares > 0 && facts.sellShares % DEFAULT_LOT_RULES.etf_sell_multiple === 0;

  const candidateState: ConstraintState = facts.candidateCode ? 'satisfied' : 'candidate_required';
  const cachedState: ConstraintState = !facts.candidateCode ? 'candidate_required'
    : facts.candidateCached ? 'satisfied' : 'unsatisfied';
  const etfState: ConstraintState = !facts.candidateCode ? 'candidate_required'
    : facts.candidateResolvedKind === 'ETF' ? 'satisfied' : 'unsatisfied';

  const lotCost = facts.candidatePriceMilli != null ? valueCents(DEFAULT_LOT_RULES.etf_lot_size, facts.candidatePriceMilli) : null;
  const sellGross = facts.sellHolding && facts.sellShares != null
    ? valueCents(facts.sellShares, facts.sellHolding.price_milli) : 0;
  const cashAfter = snapshot.totals.cash_cents + sellGross;
  const cashState: ConstraintState = lotCost == null || !facts.candidateCode || !facts.sellCode
    ? 'candidate_required' : cashAfter >= lotCost ? 'satisfied' : 'unsatisfied';

  const quoteStateForSell: ConstraintState = !facts.sellCode ? 'candidate_required'
    : facts.sellHolding?.bar_quality === 'READY' ? 'satisfied' : 'unsatisfied';
  const quoteStateForRotation: ConstraintState = !facts.sellCode || !facts.candidateCode
    ? 'candidate_required'
    : facts.sellHolding?.bar_quality === 'READY' && facts.candidateQuoteReady ? 'satisfied' : 'unsatisfied';

  return [
    {
      action: 'HOLD', label: '继续持有，不交易',
      decision_status: optionOf(decisionOptions ?? [], 'HOLD')?.status ?? 'NO_ACTION',
      executable: false,
      constraints: [
        constraint('snapshot_available', '必须有可读的账户快照', 'satisfied', `快照 ${snapshot.snapshot_id}`),
        accountConstraint,
        constraint('quote_freshness', '持仓 bar 必须与目标交易日一致',
          facts.allHoldingQuotesReady ? 'satisfied' : 'unsatisfied',
          staleCodes.length === 0 ? '全部持仓 bar 就绪' : `过期或缺失：${staleCodes.join(', ')}`),
        constraint('no_trade_required', 'HOLD 不产生交易，也不需要研究证据', 'satisfied', '不增减持仓、不产生费用'),
      ],
      illustrative_legs: sanitizeLegs(optionOf(decisionOptions ?? [], 'HOLD')?.illustrative_legs),
      note: 'HOLD 是研究模式下的默认姿态；它不依赖候选或研究证据。',
    },
    {
      action: 'REDUCE_EQUITY', label: '卖出后只保留现金（降低权益敞口）',
      decision_status: optionOf(decisionOptions ?? [], 'REDUCE_EQUITY')?.status ?? 'DATA_INSUFFICIENT',
      executable: false,
      constraints: [
        constraint('sell_leg_specified', '必须明确卖出标的与份数', selLegState, sellDetail),
        constraint('position_sufficient', '卖出份数不得超过当前持仓', !facts.sellCode ? 'candidate_required' : positionOk ? 'satisfied' : 'unsatisfied',
          facts.sellHolding ? `持有 ${facts.sellHolding.quantity} 份` : '账户不持有该标的'),
        constraint('lot_rule', `卖出份数必须是 ${DEFAULT_LOT_RULES.etf_sell_multiple} 的整数倍`, !facts.sellCode ? 'candidate_required' : lotRuleOk ? 'satisfied' : 'unsatisfied',
          facts.sellShares != null ? `${facts.sellShares} 份` : '未提供份数'),
        constraint('quote_freshness', '卖出标的 bar 必须与目标交易日一致', quoteStateForSell,
          facts.sellHolding ? `${facts.sellHolding.ts_code} bar ${facts.sellHolding.latest_bar_date ?? '缺失'}（${facts.sellHolding.bar_quality}）` : '缺少卖出标的行情'),
        accountConstraint,
      ],
      illustrative_legs: sanitizeLegs(optionOf(decisionOptions ?? [], 'REDUCE_EQUITY')?.illustrative_legs),
      note: '降低权益敞口会同时降低上涨参与度；这是风险方向，不是收益预测。',
    },
    {
      action: 'SELL_AND_BUY', label: '卖出后买入候选（轮动）',
      decision_status: optionOf(decisionOptions ?? [], 'SELL_AND_BUY')?.status ?? 'DATA_INSUFFICIENT',
      executable: false,
      constraints: [
        constraint('candidate_specified', '必须明确候选 ETF', candidateState,
          facts.candidateCode ?? '未提供候选，不臆造标的'),
        constraint('candidate_cached', '候选必须存在于只读市场缓存', cachedState,
          facts.candidateCode ? (facts.candidateCached ? '缓存中存在' : '缓存中没有该候选，不能取价') : '未提供候选'),
        constraint('candidate_is_etf', '候选必须是场内 ETF', etfState,
          facts.candidateResolvedKind ? `resolveInstrument=${facts.candidateResolvedKind}` : '未解析'),
        constraint('sell_leg_specified', '必须明确卖出标的与份数', selLegState, sellDetail),
        constraint('permission', '候选必须未被交易权限限制', facts.candidateResolvedKind === 'ETF' ? 'satisfied' : 'candidate_required',
          'ETF 不受主板/创业板/科创板个股限制'),
        constraint('quote_freshness', '卖出与候选 bar 必须与目标交易日一致', quoteStateForRotation,
          facts.candidateCode ? (facts.candidateQuoteReady ? '候选项行情就绪' : '候选项行情过期或缺失') : '未提供候选'),
        constraint('cash_for_one_lot', '卖出回款 + 现金必须够买一手候选（未计费用）', cashState,
          lotCost != null ? `可用约 ${(cashAfter / 100).toFixed(2)} 元，一手约 ${(lotCost / 100).toFixed(2)} 元` : '缺少候选价格'),
        constraint('research_evidence_verified', '轮动优势必须有可独立复核的持久化研究证据', 'unsatisfied',
          '本次没有提供可追溯研究证据，按 PRD §6 只能研究示意'),
        constraint('risk_budget', '个股才适用净资产 0.5% 计划风险预算', facts.candidateResolvedKind === 'ETF' ? 'not_applicable' : 'unknown',
          facts.candidateResolvedKind === 'ETF' ? 'ETF 轮动不套用个股失效价预算' : '缺少个股失效价，无法校验'),
        accountConstraint,
      ],
      illustrative_legs: sanitizeLegs(optionOf(decisionOptions ?? [], 'SELL_AND_BUY')?.illustrative_legs),
      note: '轮动比较只是非执行示意；没有研究证据与真实账户时不得升级为交易计划。',
    },
    {
      action: 'NO_ACTION', label: '明确不操作',
      decision_status: optionOf(decisionOptions ?? [], 'NO_ACTION')?.status ?? 'NO_ACTION',
      executable: false,
      constraints: [
        constraint('no_action_available', '始终可以选择保留现金与现有持仓', 'satisfied', '不产生交易，也不产生费用'),
      ],
      illustrative_legs: [],
      note: '保留现金与现有持仓；适用于证据不足或数据不完整时。',
    },
  ];
}

// ---------------------------------------------------------------- 导入样例

export const REAL_ACCOUNT_IMPORT_EXAMPLE = {
  note: 'example only; no real trades inferred',
  purpose: '真实券商交割单导入的字段口径样例：只说明字段与单位，不代表用户真实成交、费率、日期或出入金。',
  real_account_import_example: {
    event_id: 'broker-example-0001',
    account_id: 'example-account',
    event_type: 'TRADE_BUY',
    occurred_on: '20260105',
    settled_on: '20260105',
    ts_code: '159558.SZ',
    quantity: 100,
    price_milli: 935,
    gross_cents: 9350,
    fee_cents: 5,
    tax_cents: 0,
    source: 'broker_statement',
  },
  required_fields: [
    'event_id', 'account_id', 'event_type', 'occurred_on', 'ts_code', 'quantity',
    'price_milli', 'gross_cents', 'fee_cents', 'tax_cents', 'source',
  ],
  field_notes: {
    price_milli: '整数厘（0.001 元）；ETF 最小变动价位是 0.001 元，不用浮点分存价',
    gross_cents: '整数分；应与 数量 × 厘价 ÷ 10 相符（容差 1 分）',
    fee_cents: '整数分，由券商交割单直接给出；缺失时不要填 0 冒充真实费用',
    tax_cents: '整数分；ETF 免征印花税，个股按交割单填写',
    source: "必须为 'broker_statement'；synthetic 仅供测试",
  },
  dry_run_command: 'finance-ashare portfolio-ledger-import --account <ACCOUNT_ID> --file <STATEMENT.json> --dry-run',
  warnings: [
    '不要根据截图推断真实成交或账户号码',
    '未知费率保持缺失，不能默认成 0',
    '导入前先用 --dry-run 校验，再用 portfolio-ledger-validate 对账',
  ],
} as const;

// ---------------------------------------------------------------- 主入口

export function buildResearchSummary(input: ResearchSummaryInput): any {
  const asOf = input.asOfTradeDate;
  if (!YMD.test(asOf)) throw new Error('as_of_trade_date 需要 YYYYMMDD 格式');

  const { portfolioDb, marketDb, accountId } = input;
  const fatal: ReasonCode[] = [];
  const warnings: string[] = [];

  const snapshot: AccountSnapshot | undefined = resolveAccountState(portfolioDb, accountId, asOf, input.snapshotId,
    { calendar: marketDb ? settlementCalendarFromDb(marketDb) : undefined }).snapshot;
  if (!snapshot) {
    fatal.push({ code: 'snapshot_missing', detail: input.snapshotId ? `账户快照 ${input.snapshotId} 不存在` : '账户库中没有任何快照' });
  } else if (!snapshot.is_current) {
    warnings.push('snapshot_not_current');
  }

  const gate = realAccountGate(portfolioDb, accountId);
  const accountStatus: RealAccountStatus = gate.status;
  if (accountStatus === 'REAL_ACCOUNT_PENDING') warnings.push('real_account_pending');

  if (!marketDb) fatal.push({ code: 'market_cache_unavailable', detail: '没有可用的只读市场缓存' });

  const calendar = marketDb ? tradeCalendar(marketDb) : null;
  const expectedTradeDate = calendar?.latestTradeDay(asOf) ?? null;
  const isTradeDay = calendar?.isTradeDay(asOf);
  if (marketDb) {
    if (isTradeDay === false) fatal.push({ code: 'as_of_not_trade_day', detail: `${asOf} 不是交易日` });
    else if (isTradeDay === undefined) fatal.push({ code: 'trade_calendar_missing', detail: '交易日历缺失，无法判断目标交易日' });
  }

  const snapshotSummary: AccountSummary | null = snapshot ? accountSummary(snapshot) : null;

  // ---------------------------------------------------------------- 持仓
  const holdings: ResearchHolding[] = [];
  const missingFields: string[] = [];
  if (snapshot) {
    for (const position of snapshot.positions) {
      const code = normalizeSecurityCode(position.ts_code);
      const resolved = marketDb ? resolveInstrument(marketDb, code) : null;
      const kind = resolved?.kind === 'STOCK' ? 'STOCK' : resolved?.kind === 'ETF' ? 'ETF' : 'UNKNOWN';
      const quote = marketDb && kind !== 'UNKNOWN'
        ? loadServerQuote(marketDb, code, asOf, kind, calendar ?? undefined)
        : null;
      const barDate = latestBarDate(marketDb, code, asOf, kind);

      const basic = marketDb && kind === 'ETF' && tableExists(marketDb, 'fund_basic')
        ? (marketDb.prepare('SELECT name, fund_type, invest_type, benchmark, type, status FROM fund_basic WHERE ts_code = ?').get(code) as any)
        : undefined;
      const classification = kind === 'STOCK'
        ? { asset_class: 'EQUITY' as AssetClass, basis: 'stock_basic', classified: true }
        : classifyAssetClass(basic ?? null);
      const theme = THEME_BY_CODE[code] ?? 'unknown';

      const barQuality: ResearchHolding['bar_quality'] = !barDate
        ? 'MISSING'
        : quote?.found
          ? (quote.quality === 'READY' || quote.quality === 'STALE' || quote.quality === 'NOT_READY' ? quote.quality : 'STALE')
          : 'STALE';
      const marketPriceMilli = quote?.found && quote.price !== null && quote.quality !== 'NOT_READY'
        ? Math.round(quote.price * 1000)
        : null;
      const priceUsed = marketPriceMilli !== null;
      const priceMilli = marketPriceMilli ?? position.ref_price_milli;
      const marketValue = priceUsed ? valueCents(position.quantity, priceMilli) : position.market_value_cents;

      if (classification.asset_class === 'UNKNOWN') missingFields.push(`asset_class:${code}`);
      if (theme === 'unknown') missingFields.push(`theme:${code}`);
      if (barQuality === 'MISSING') missingFields.push(`bar_missing:${code}`);

      holdings.push({
        ts_code: code,
        name: position.name,
        quantity: position.quantity,
        weight: 0,
        weight_of_securities: 0,
        market_value_cents: marketValue,
        asset_class: classification.asset_class,
        asset_class_basis: classification.basis,
        theme,
        theme_label: THEME_LABELS[theme] ?? theme,
        industry: INDUSTRY_BY_CODE[code] ?? 'unclassified',
        latest_bar_date: barDate,
        bar_quality: barQuality,
        bar_reasons: quote?.reasons ?? [],
        price_milli: priceMilli,
        price_source: priceUsed ? 'server_cache_close' : 'snapshot_reference_price',
        price_used_for_revaluation: priceUsed,
        source: priceUsed ? 'server_cache' : 'snapshot_reference',
      });
    }
  }

  const securities = holdings.reduce((sum, holding) => sum + holding.market_value_cents, 0);
  const cashCents = snapshot?.totals.cash_cents ?? 0;
  const wealthCents = snapshot?.totals.wealth_cents ?? 0;
  const totalAssets = securities + cashCents + wealthCents;
  for (const holding of holdings) {
    holding.weight = totalAssets > 0 ? round(holding.market_value_cents / totalAssets, 6) : 0;
    holding.weight_of_securities = securities > 0 ? round(holding.market_value_cents / securities, 6) : 0;
  }

  // ---------------------------------------------------------------- 组合指标
  const byClass = new Map<AssetClass, number>();
  const byTheme = new Map<string, number>();
  const byIndustry = new Map<string, number>();
  for (const holding of holdings) {
    byClass.set(holding.asset_class, (byClass.get(holding.asset_class) ?? 0) + holding.market_value_cents);
    byTheme.set(holding.theme, (byTheme.get(holding.theme) ?? 0) + holding.market_value_cents);
    byIndustry.set(holding.industry, (byIndustry.get(holding.industry) ?? 0) + holding.market_value_cents);
  }
  const denom = (value: number) => (totalAssets > 0 ? round(value / totalAssets, 6) : 0);
  const secDenom = (value: number) => (securities > 0 ? round(value / securities, 6) : 0);
  const hhi = round(holdings.reduce((sum, holding) => sum + holding.weight * holding.weight, 0), 6);
  const top = holdings.length > 0 ? holdings.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;

  const portfolio = {
    basis: 'server_cache_close_with_snapshot_fallback' as const,
    total_assets_cents: totalAssets,
    securities_mv_cents: securities,
    cash_cents: cashCents,
    wealth_cents: wealthCents,
    total_assets: round(totalAssets / 100, 2),
    securities_mv: round(securities / 100, 2),
    cash: round(cashCents / 100, 2),
    wealth: round(wealthCents / 100, 2),
    securities_ratio: denom(securities),
    cash_ratio: denom(cashCents),
    wealth_ratio: denom(wealthCents),
    concentration: { hhi, effective_positions: hhi > 0 ? round(1 / hhi, 4) : 0 },
    top_position: top ? { ts_code: top.ts_code, name: top.name, weight: top.weight } : null,
    by_asset_class: ASSET_CLASSES.map(assetClass => ({
      asset_class: assetClass,
      label: ASSET_CLASS_LABELS[assetClass],
      weight: denom(byClass.get(assetClass) ?? 0),
      market_value_cents: byClass.get(assetClass) ?? 0,
    })),
    theme_exposure: [...byTheme.entries()].sort((a, b) => b[1] - a[1]).map(([theme, value]) => ({
      theme,
      label: THEME_LABELS[theme] ?? theme,
      weight: denom(value),
      weight_of_securities: secDenom(value),
      market_value_cents: value,
    })),
    industry_exposure: [...byIndustry.entries()].sort((a, b) => b[1] - a[1]).map(([industry, value]) => ({
      industry,
      weight: denom(value),
      market_value_cents: value,
      basis: industry === 'unclassified' ? 'unclassified' : 'declared:r1-industry-map-1.0.0',
    })),
    unclassified_theme_weight: denom(byTheme.get('unknown') ?? 0),
    unclassified_industry_weight: denom(byIndustry.get('unclassified') ?? 0),
    repriced_codes: holdings.filter(holding => holding.price_used_for_revaluation).map(holding => holding.ts_code).sort(),
    snapshot_price_codes: holdings.filter(holding => !holding.price_used_for_revaluation).map(holding => holding.ts_code).sort(),
    note: '有缓存收盘价的持仓按缓存价重估，其余沿用快照参考价；快照参考价不是当前市场价。',
  };

  // ---------------------------------------------------------------- 市场环境
  const { context: marketContext, meta: reportMeta } = loadMarketContext(marketDb, asOf);
  if (!marketContext.available) {
    fatal.push({ code: marketContext.reason ?? 'market_report_missing', detail: marketContext.detail ?? '没有可用市场日报' });
    missingFields.push('market_report');
  } else if (marketContext.freshness !== 'same_day') {
    warnings.push('market_report_prior_day');
  }

  // ---------------------------------------------------------------- 决策约束（只取非执行示意）
  const candidateCode = input.candidateCode ? normalizeSecurityCode(input.candidateCode) : null;
  const sellCode = input.sell ? normalizeSecurityCode(input.sell.code) : null;
  const sellShares = input.sell?.shares ?? null;
  if (input.sell && (!Number.isInteger(sellShares) || (sellShares ?? 0) <= 0)) {
    fatal.push({ code: 'invalid_input', detail: `卖出份数必须为正整数，收到 ${input.sell.shares}` });
  }

  const candidateResolved = marketDb && candidateCode ? resolveInstrument(marketDb, candidateCode) : null;
  const candidateQuote = marketDb && candidateCode ? loadEtfQuote(marketDb, candidateCode, asOf) : null;
  const candidateCached = !!candidateQuote?.available;
  const candidateQuoteReady = !!candidateQuote?.available && candidateQuote.quality === 'READY';
  const candidatePriceMilli = candidateQuote?.available ? candidateQuote.price_milli : null;
  const sellHolding = sellCode ? holdings.find(holding => holding.ts_code === sellCode) ?? null : null;

  if (candidateCode && !candidateCached) {
    const reason = candidateQuote?.reason ?? 'candidate_not_cached';
    fatal.push({ code: reason, detail: candidateQuote?.detail ?? `候选 ${candidateCode} 不在只读市场缓存中` });
    missingFields.push(`candidate_quote:${candidateCode}`);
  } else if (candidateCode && candidateResolved?.kind !== 'ETF') {
    fatal.push({ code: 'candidate_not_etf', detail: `候选 ${candidateCode} 不是场内 ETF（resolveInstrument=${candidateResolved?.kind ?? 'UNKNOWN'}）` });
  }

  let decisionOptions: DecisionOption[] | null = null;
  if (snapshot && snapshotSummary) {
    const action: DecisionAction = candidateCode && sellCode && sellShares != null
      ? { type: 'SELL_AND_BUY', sell_code: sellCode, sell_shares: sellShares, buy_code: candidateCode, buy_kind: 'ETF' }
      : { type: 'HOLD' };
    const decision = buildDecision({
      account_id: accountId,
      snapshot: snapshotSummary,
      as_of_trade_date: asOf,
      market_db: marketDb ?? null,
      // 新版决策从账户库复核研究证据与真实账户门控；只读句柄不写库。
      portfolio_db: portfolioDb,
      action,
      reduce: sellCode && sellShares != null ? { sell_code: sellCode, sell_shares: sellShares } : null,
    });
    decisionOptions = decision.options;
  }

  const allHoldingQuotesReady = holdings.length > 0 && holdings.every(holding => holding.bar_quality === 'READY');
  const decisionConstraints = snapshot
    ? buildDecisionConstraints({
        snapshot,
        holdings,
        allHoldingQuotesReady,
        sellCode,
        sellShares,
        sellHolding,
        candidateCode,
        candidateResolvedKind: candidateResolved?.kind ?? null,
        candidateCached,
        candidateQuoteReady,
        candidatePriceMilli,
      }, decisionOptions)
    : buildDecisionConstraints({
        snapshot: {
          snapshot_id: '', as_of: '', source: '', note: '', warnings: [], is_current: false,
          positions: [], totals: { total_assets_cents: 0, securities_mv_cents: 0, cash_cents: 0, wealth_cents: 0, unrealized_pnl_cents: 0 },
        },
        holdings,
        allHoldingQuotesReady: false,
        sellCode,
        sellShares,
        sellHolding: null,
        candidateCode,
        candidateResolvedKind: null,
        candidateCached: false,
        candidateQuoteReady: false,
        candidatePriceMilli: null,
      }, null);

  // ---------------------------------------------------------------- 轮动比较
  const rotationOption = optionOf(decisionOptions ?? [], 'SELL_AND_BUY');
  let rotationComparison: any;
  if (!candidateCode) {
    rotationComparison = {
      status: 'not_available_without_candidate',
      executable: false,
      reason_code: 'candidate_required',
      note: '未提供候选 ETF；不臆造轮动标的与数量。',
    };
  } else if (!candidateQuote?.available) {
    rotationComparison = {
      status: 'DATA_INSUFFICIENT',
      executable: false,
      reason_code: candidateQuote?.reason ?? 'candidate_not_cached',
      detail: candidateQuote?.detail ?? `候选 ${candidateCode} 不在只读市场缓存中`,
      candidate: { ts_code: candidateCode, available: false, source: 'server_cache' },
      note: '候选没有可用缓存行情，不伪造价格，也不生成轮动示意。',
    };
  } else if (candidateResolved?.kind !== 'ETF') {
    rotationComparison = {
      status: 'DATA_INSUFFICIENT',
      executable: false,
      reason_code: 'candidate_not_etf',
      detail: `候选 ${candidateCode} 不是场内 ETF`,
      candidate: { ts_code: candidateCode, available: true, source: 'server_cache' },
      note: '研究轮动只接受场内 ETF 候选。',
    };
  } else if (!sellCode || sellShares == null) {
    rotationComparison = {
      status: 'not_available_without_sell_quantity',
      executable: false,
      reason_code: 'sell_leg_required',
      candidate: {
        ts_code: candidateCode, name: candidateQuote.name, trade_date: candidateQuote.trade_date,
        price_milli: candidateQuote.price_milli, quality: candidateQuote.quality,
        asset_class: candidateQuote.asset_class, source: 'server_cache',
      },
      note: '候选已缓存，但未提供 --sell/--shares；不臆造卖出数量。',
    };
  } else {
    rotationComparison = {
      status: 'ILLUSTRATIVE',
      executable: false,
      reason_code: null,
      candidate: {
        ts_code: candidateCode, name: candidateQuote.name, trade_date: candidateQuote.trade_date,
        price_milli: candidateQuote.price_milli, quality: candidateQuote.quality,
        asset_class: candidateQuote.asset_class, source: 'server_cache',
      },
      sell: sellCode ? { ts_code: sellCode, shares: sellShares } : null,
      decision_status: rotationOption?.status ?? 'DATA_INSUFFICIENT',
      illustrative_legs: sanitizeLegs(rotationOption?.illustrative_legs),
      cash: rotationOption?.cash ?? null,
      exposure_after: rotationOption?.exposure ?? null,
      stress_after: rotationOption?.stress ?? null,
      fees: rotationOption?.fees ?? null,
      reasons: rotationOption?.reasons ?? [],
      note: '仅研究示意：每条腿 executable=false；没有独立研究证据、真实账户与盘中报价时不得当作下单计划。',
      assumptions: [
        '价格为缓存收盘价，不是可成交价；滑点与费用为假设值',
        '成交前候选可能停牌、涨跌停或流动性不足',
        '费用未与券商对账，real_cents 保持 null',
      ],
    };
  }

  // ---------------------------------------------------------------- 市场证据
  const marketEvidence = buildMarketEvidence(marketContext, asOf, holdings, missingFields);

  // ---------------------------------------------------------------- 数据质量
  const quoteGroups = {
    ready: holdings.filter(holding => holding.bar_quality === 'READY').map(holding => holding.ts_code),
    stale: holdings.filter(holding => holding.bar_quality === 'STALE').map(holding => holding.ts_code),
    not_ready: holdings.filter(holding => holding.bar_quality === 'NOT_READY').map(holding => holding.ts_code),
    missing: holdings.filter(holding => holding.bar_quality === 'MISSING').map(holding => holding.ts_code),
  };
  const dataQualityStatus: 'OK' | 'DEGRADED' | 'INSUFFICIENT' = fatal.length > 0
    ? 'INSUFFICIENT'
    : quoteGroups.stale.length + quoteGroups.not_ready.length + quoteGroups.missing.length > 0
      || !snapshot?.is_current
      || marketContext.freshness !== 'same_day'
      ? 'DEGRADED'
      : 'OK';

  const dataQuality = {
    status: dataQualityStatus,
    as_of_trade_date: asOf,
    expected_trade_date: expectedTradeDate,
    trade_calendar: {
      available: !!calendar,
      is_trade_day: isTradeDay ?? null,
      latest_trade_day: expectedTradeDate,
    },
    market_report: {
      source: 'report' as const,
      available: marketContext.available,
      report_id: marketContext.report_id,
      as_of_trade_date: marketContext.as_of_trade_date,
      status: marketContext.status,
      freshness: marketContext.freshness,
      reason: marketContext.reason,
    },
    quotes: {
      source: 'fund_daily' as const,
      as_of_trade_date: asOf,
      total: holdings.length,
      ready: quoteGroups.ready,
      stale: quoteGroups.stale,
      not_ready: quoteGroups.not_ready,
      missing: quoteGroups.missing,
    },
    portfolio_snapshot: {
      snapshot_id: snapshot?.snapshot_id ?? null,
      as_of: snapshot?.as_of ?? null,
      is_current: snapshot?.is_current ?? false,
      source: snapshot?.source ?? null,
    },
    real_account: { status: accountStatus, verified: gate.verified, confirmed_at: gate.confirmed_at },
    missing_fields: [...new Set(missingFields)].sort(),
  };

  // ---------------------------------------------------------------- 状态
  let status: ResearchSummaryStatus;
  if (fatal.length > 0) {
    status = 'DATA_INSUFFICIENT';
  } else if (accountStatus === 'REAL_ACCOUNT_PENDING') {
    status = 'RESEARCH_ONLY';
  } else if (!snapshot?.is_current || !allHoldingQuotesReady || marketContext.freshness !== 'same_day' || candidateCode) {
    status = 'ILLUSTRATIVE';
  } else {
    status = 'NO_ACTION';
  }

  const summaryId = createHash('sha256').update(JSON.stringify({
    schema: RESEARCH_SUMMARY_SCHEMA,
    account_id: accountId,
    snapshot_id: snapshot?.snapshot_id ?? null,
    snapshot_as_of: snapshot?.as_of ?? null,
    snapshot_is_current: snapshot?.is_current ?? false,
    as_of_trade_date: asOf,
    account_status: accountStatus,
    holdings: holdings.map(holding => [
      holding.ts_code, holding.quantity, holding.price_milli,
      holding.price_used_for_revaluation, holding.bar_quality,
    ]),
    cash_cents: snapshot?.totals.cash_cents ?? null,
    wealth_cents: snapshot?.totals.wealth_cents ?? null,
    report_id: reportMeta?.report_id ?? null,
    candidate: candidateCode,
    sell: sellCode && sellShares != null ? [sellCode, sellShares] : null,
    status,
  })).digest('hex');

  return {
    schema: RESEARCH_SUMMARY_SCHEMA,
    summary_id: summaryId,
    mode: 'research',
    status,
    actionable: false,
    as_of_trade_date: asOf,
    snapshot_id: snapshot?.snapshot_id ?? null,
    snapshot_as_of: snapshot?.as_of ?? null,
    snapshot_is_current: snapshot?.is_current ?? false,
    account_status: accountStatus,
    reasons: fatal,
    warnings: [...new Set(warnings)],
    data_quality: dataQuality,
    holdings,
    portfolio,
    market_context: marketContext,
    decision_constraints: {
      note: '以下只列客观约束与满足状态；所有选项 executable=false，不构成下单计划。',
      options: decisionConstraints,
    },
    rotation_comparison: rotationComparison,
    market_evidence: marketEvidence,
    account_import_sample: REAL_ACCOUNT_IMPORT_EXAMPLE,
    not_covered: [
      '真实账户业绩与历史回撤：缺少真实账户确认与完整出入金/成交流水',
      '盘中报价与可成交性：只有日线缓存收盘价',
      '研究证据前瞻有效性：只能标记 UNVERIFIED，需后续前瞻检验',
      'AC-04“上涨行情参与重估”的正式验收：本轮只提供证据纵切片与对照场景',
    ],
    disclaimer: RESEARCH_SUMMARY_DISCLAIMER,
  };
}
