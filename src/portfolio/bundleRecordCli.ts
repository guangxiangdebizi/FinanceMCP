import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ashareDbPath } from '../ashare/db.js';
import type { CliHelpers } from '../ashare/commands.js';
import { portfolioDbPath, openPortfolioDb } from './db.js';
import { openMarketCache } from './quotes.js';
import { buildInvestmentResearchBundle } from './researchBundle.js';
import { recordResearchJournal, readResearchJournal, canonicalJson, JOURNAL_VERSION } from './researchJournal.js';

/** Explicit scheduled write path. Stores only authentic VPS output in the private account volume. */
export function runBundleRecordCommand(h: CliHelpers): void {
  const path = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error('private portfolio database unavailable; refusing to create empty account');
  const portfolio = openPortfolioDb(path, { writable: true });
  const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
  try {
    const bundle = buildInvestmentResearchBundle({ portfolioDb: portfolio, marketDb: market,
      accountId: h.arg('account'), asOfTradeDate: h.arg('date') });
    if (!bundle.as_of_trade_date || bundle.session.status !== 'READY') {
      h.print({ status: 'NOT_READY', recorded: false, session: bundle.session });
      process.exitCode = 1;
      return;
    }
    // Only acquisition time is excluded; prices, facts and all rule versions participate in identity.
    // The bundle ID binds semantic facts and versions, excluding acquisition clocks and prior history.
    const id = `VPS-${bundle.report_id}`;
    const existing = readResearchJournal(portfolio, id);
    const record = existing ? { created: false, record: existing } : recordResearchJournal(portfolio, {
      record_id: id, account_id: bundle.account_id, source: 'vps', as_of_trade_date: bundle.as_of_trade_date,
      bundle_id: bundle.report_id, generated_at: bundle.generated_at,
      versions: { journal: JOURNAL_VERSION, bundle: bundle.schema, rules_hash: createHash('sha256').update(canonicalJson(bundle.rules)).digest('hex') },
      judgement: { status: bundle.status, market: bundle.market, decision: bundle.portfolio?.status ?? 'DATA_INSUFFICIENT' },
      candidates: bundle.etf_candidates?.candidates ?? [], evidence: bundle.technical_signals?.current ?? [],
      // Observing existing holdings does not manufacture new trades or a funded strategy.
      observations: (bundle.portfolio?.holdings ?? []).filter((holding: any) => holding.bar_quality === 'READY')
        .map((holding: any) => ({ ts_code: holding.ts_code, quantity: holding.quantity, direction: 'observe' as const, benchmark_code: '510300.SH' })),
      payload: bundle,
    });
    const folder = h.arg('output-dir') ?? join(dirname(path), 'research-bundles');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const target = join(folder, `${id}.json`);
    if (!existsSync(target)) writeFileSync(target, JSON.stringify(record.record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    h.print({ status: bundle.status, recorded: record.created, record_id: id, bundle_id: bundle.report_id,
      as_of_trade_date: bundle.as_of_trade_date, source: 'vps', private_output: target,
      account_status: bundle.account_status, evidence_status: bundle.evidence_status });
    // Data gaps are recorded honestly, but the scheduler must still expose failure to operators.
    if (bundle.status === 'DATA_INSUFFICIENT') process.exitCode = 1;
  } finally { market?.close(); portfolio.close(); }
}
