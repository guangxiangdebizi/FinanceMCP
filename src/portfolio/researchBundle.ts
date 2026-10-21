import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolveResearchDate } from '../ashare/researchDate.js';
import { latestReportMeta, loadReport } from '../ashare/report.js';
import { checkQuality } from '../ashare/ingest.js';
import { etfStatus } from '../ashare/etf.js';
import { screenEtfCandidates, ETF_UNIVERSE_VERSION } from '../ashare/etfUniverse.js';
import { buildBenchmarkComparison, BENCHMARK_DEFINITION_VERSION } from './benchmarks.js';
import { buildDailyReport } from './dailyReport.js';
import { resolveAccountId, resolveAccountSnapshot } from './accounts.js';
import { listResearchJournal, evaluateResearchJournal, journalFeeEstimator } from './researchJournal.js';
import { loadFeeContext, feeRulesFor } from './fees.js';
import { resolveInstrument } from './instrument.js';
import { loadValidationSummary } from '../ashare/validation.js';

export const RESEARCH_BUNDLE_SCHEMA = 'ashare-investment-research-bundle/1.0';
export interface ResearchBundleInput {
  portfolioDb: DatabaseSync;
  marketDb: DatabaseSync | null;
  accountId?: string;
  asOfTradeDate?: string;
  now?: Date;
  maxCandidates?: number;
}

/** Compose facts from existing engines. This path is read-only and never fetches network data. */
export function buildInvestmentResearchBundle(input: ResearchBundleInput): any {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const account = resolveAccountId(input.portfolioDb, input.accountId);
  const snapshot = resolveAccountSnapshot(input.portfolioDb, account.account_id);
  const clock = resolveResearchDate(input.marketDb, input.asOfTradeDate, now);
  const asOf = clock.as_of_trade_date;
  const gaps: { module: string; reason: string; affected: string[] }[] = [];
  const safe = (module: string, fn: () => any): any => {
    try { return fn(); }
    catch (error: any) {
      gaps.push({ module, reason: String(error?.message ?? error), affected: [module] });
      return null;
    }
  };
  const market = input.marketDb;
  const requestedLimit = input.maxCandidates ?? 8;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) throw new Error('max_candidates must be 1..20');
  let quality: any = null;
  let published: any = null;
  let meta: any = null;
  let portfolio: any = null;
  let screening: any = null;
  let benchmarks: any = null;
  let etf: any = null;
  if (clock.status === 'READY' && asOf && market) {
    quality = safe('market_quality', () => checkQuality(market, asOf, false));
    meta = safe('market_report', () => latestReportMeta(market, asOf));
    if (meta && meta.trade_date === asOf) {
      const candidate = safe('market_report', () => loadReport(meta));
      if (candidate?.as_of_trade_date === asOf && candidate.report_id === meta.report_id) published = candidate;
      else gaps.push({ module: 'market_report', reason: 'report_metadata_mismatch', affected: ['market', 'sectors', 'watchlist', 'signals'] });
    }
    if (!published) gaps.push({ module: 'market_report', reason: 'target_date_report_unavailable', affected: ['market', 'sectors', 'watchlist', 'signals'] });
    const coreReady = quality && quality.status !== 'NOT_READY' && published && published.status !== 'NOT_READY';
    portfolio = safe('portfolio', () => buildDailyReport({
      portfolioDb: input.portfolioDb, marketDb: market, accountId: account.account_id, accountIdSource: account.source,
      snapshotId: snapshot.snapshot_id, asOfTradeDate: asOf, generatedAt,
    }));
    // A missing current market report must not be replaced by prior-day judgement inside the composed report.
    if (portfolio && !coreReady) {
      portfolio = { ...portfolio, status: 'DATA_INSUFFICIENT', actionable: false,
        market_judgement: { available: false, as_of_trade_date: asOf, reason: 'target_market_data_unavailable' },
        first_section: { ...portfolio.first_section, count: 0, actions: [], no_action_reason: 'DATA_INSUFFICIENT: target market data unavailable' },
      };
    }
    screening = safe('etf_candidates', () => screenEtfCandidates(market, {
      asOf, limit: requestedLimit, heldCodes: (portfolio?.holdings ?? snapshot.snapshot.positions).map((holding: any) => holding.ts_code),
    }));
    etf = safe('etf_quality', () => etfStatus(market, { date: asOf }));
    const baselineDate = snapshot.snapshot.as_of.replace(/-/g, '');
    benchmarks = safe('benchmarks', () => buildBenchmarkComparison({ marketDb: market, start: baselineDate, end: asOf,
      fee_context: loadFeeContext(input.portfolioDb, account.account_id, asOf),
    }));
  } else {
    gaps.push({ module: 'session', reason: clock.reason ?? 'session_unavailable', affected: ['market', 'portfolio_valuation', 'candidates', 'benchmarks'] });
  }
  const coreReady = clock.status === 'READY' && quality && quality.status !== 'NOT_READY'
    && published && published.status !== 'NOT_READY';
  if (quality?.reasons?.length) gaps.push({ module: 'market_quality', reason: quality.reasons.join('; '), affected: ['market'] });
  const targetReport = coreReady ? published : null;
  const etfNotReady = portfolio?.data_quality?.quotes
    ? [...portfolio.data_quality.quotes.stale, ...portfolio.data_quality.quotes.not_ready, ...portfolio.data_quality.quotes.missing] : [];
  if (etfNotReady.length) gaps.push({ module: 'etf_price', reason: etfNotReady.join(','), affected: ['valuation', 'rotation'] });
  if (portfolio?.gate?.unreported_trade_risk) gaps.push({ module: 'account_completeness', reason: 'unreported_trade_risk', affected: ['executable_quantities'] });
  const versions = {
    bundle: RESEARCH_BUNDLE_SCHEMA, market: targetReport?.versions ?? null,
    etf_universe: ETF_UNIVERSE_VERSION, benchmark: BENCHMARK_DEFINITION_VERSION,
    portfolio: portfolio?.schema ?? null,
  };
  const sync = market && asOf ? safe('sync_times', () => market.prepare(
    'SELECT dataset,key,status,synced_at FROM sync_log WHERE key <= ? ORDER BY synced_at DESC LIMIT 20',
  ).all(asOf)) : null;
  const historical = market && asOf ? safe('research_tracking', () => ({
    legacy_plans: readTracking(input.portfolioDb, account.account_id, asOf),
    records: listResearchJournal(input.portfolioDb, { accountId: account.account_id, asOf, limit: 5 })
      .map(({ payload, ...record }) => record),
    evaluations: evaluateResearchJournal({ portfolioDb: input.portfolioDb, marketDb: market, accountId: account.account_id, asOf, limit: 5,
      feeEstimator: journalFeeEstimator(input.portfolioDb, market, account.account_id),
    }),
  })) : null;
  const candidates = screening?.candidates ?? [];
  // Held instruments stay present even if missing or below any screen threshold.
  const held = candidates.filter((row: any) => row.held);
  const other = candidates.filter((row: any) => !row.held).slice(0, requestedLimit);
  const feeContext = asOf ? loadFeeContext(input.portfolioDb, account.account_id, asOf) : null;
  const feeSummary = feeContext ? (portfolio?.holdings ?? snapshot.snapshot.positions).map((holding: any) => {
    const kind = market ? resolveInstrument(market, holding.ts_code).kind : 'UNKNOWN';
    if (kind === 'UNKNOWN') return { ts_code: holding.ts_code, status: 'UNKNOWN', reason: 'instrument_identity_unavailable' };
    const rules = feeRulesFor(feeContext, holding.ts_code, kind);
    return { ts_code: holding.ts_code, values: { ...rules, fee_context: undefined }, provenance: rules.fee_model };
  }) : null;
  const validation = asOf ? loadValidationSummary({ dbPath: process.env.ASHARE_VALIDATION_DB_PATH, asOf }) : null;
  const facts = {
    schema: RESEARCH_BUNDLE_SCHEMA, as_of_trade_date: asOf, account_id: account.account_id,
    market_report_id: targetReport?.report_id ?? null, market: targetReport,
    portfolio, benchmarks, validation, gaps,
    versions, quality: quality?.status ?? 'NOT_READY', fees: feeSummary,
    candidates: [...held, ...other], account_snapshot_id: snapshot.snapshot_id,
  };
  const reportId = `BUNDLE-${asOf ?? 'UNKNOWN'}-${createHash('sha256').update(stableFacts(facts)).digest('hex').slice(0, 20)}`;
  const status = !coreReady ? 'DATA_INSUFFICIENT' : gaps.length || !portfolio ? 'DEGRADED' : 'READY';
  return {
    schema: RESEARCH_BUNDLE_SCHEMA, report_id: reportId, generated_at: generatedAt,
    as_of_trade_date: asOf, session: clock, account_id: account.account_id, status,
    account_status: portfolio?.account_status ?? 'UNKNOWN', evidence_status: 'UNVERIFIED',
    data_quality: {
      market: { status: quality?.status ?? 'NOT_READY', as_of_trade_date: asOf, reasons: quality?.reasons ?? [clock.reason ?? 'unavailable'] },
      account: portfolio?.data_quality?.tiers ?? { identity: 'UNKNOWN', completeness: 'UNKNOWN', executable: false },
      etf: etf ? { as_of_trade_date: etf.as_of_trade_date, quality: etf.quality, codes: etf.codes } : null,
      synchronized_at: sync,
    },
    market: targetReport?.market ?? { available: false, reason: 'target_market_data_unavailable' },
    sectors: targetReport?.sectors ? { top: targetReport.sectors.top, bottom: targetReport.sectors.bottom } : null,
    watchlist: targetReport?.watchlist ? {
      count: targetReport.watchlist.count, previous_date: targetReport.watchlist.previous_date,
      added: targetReport.watchlist.added, removed: targetReport.watchlist.removed,
      industry_distribution: targetReport.watchlist.industry_distribution,
      historical_effectiveness: targetReport.watchlist.track_record,
      focused_candidates: (targetReport.watchlist.members ?? []).slice(0, 5),
      full_list_tool: 'ashare_watchlist',
    } : null,
    research_validation: validation,
    technical_signals: targetReport?.signals ? {
      research_scope: 'IN_SAMPLE_UNVERIFIED', current: targetReport.signals.market_summary,
      limitation: 'Overlapping historical windows and heuristic rankings are not profit probabilities or validated rotation advantage.',
    } : null,
    etf_candidates: screening ? {
      as_of_trade_date: asOf, data_coverage: screening.data_coverage,
      universe_version: screening.universe_version ?? ETF_UNIVERSE_VERSION,
      candidates: [...held, ...other], total_candidates: candidates.length,
      truncated: other.length < candidates.filter((row: any) => !row.held).length,
      details_tool: 'ashare_etf_candidates', evidence_status: 'UNVERIFIED',
    } : null,
    portfolio,
    transaction_fees: { as_of_trade_date: asOf, securities: feeSummary, accounting: 'actual booked fees remain immutable; slippage estimates are separate' },
    benchmarks,
    research_tracking: historical,
    evidence_gaps: gaps,
    rules: versions,
    markdown_summary: [
      `# 投资研究事实包 ${asOf ?? 'UNKNOWN'} (${status})`,
      `报告 ID: ${reportId}`,
      `市场: ${quality?.status ?? 'NOT_READY'}；账户身份: ${portfolio?.account_status ?? 'UNKNOWN'}；研究优势: UNVERIFIED`,
      `决策: ${portfolio?.status ?? 'DATA_INSUFFICIENT'}；股票池: ${targetReport?.watchlist?.count ?? '不可用'}；ETF持仓报价缺口: ${etfNotReady.join('、') || '无/未评估'}`,
      ...gaps.map(gap => `- ${gap.module}: ${gap.reason}`),
    ].join('\n'),
    boundaries: { read_only: true, execution: 'manual_only', private_endpoint_required: true, external_research: 'NOT_ACQUIRED',
      costs: 'See per-leg fee engine provenance; actual ledger fees are not overwritten.',
      real_account_performance: 'UNKNOWN unless a complete, reconcilable ledger and historical prices exist.' },
  };
}

function stableFacts(value: unknown): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
      .filter(key => !['generated_at', 'checked_at', 'recorded_at', 'last_user_reconciled_at'].includes(key))
      .map(key => [key, normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}

function readTracking(db: DatabaseSync, accountId: string, asOf: string): any[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_tracking'").get()) return [];
  return db.prepare('SELECT plan_id,as_of_trade_date,status,action_code,expected_by,generated_at FROM plan_tracking WHERE account_id=? AND as_of_trade_date <= ? ORDER BY as_of_trade_date DESC LIMIT 5').all(accountId, asOf);
}
