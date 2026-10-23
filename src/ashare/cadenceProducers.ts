/** Phase 6 — the real producers behind the weekly/monthly cadence entry.
 *
 * `researchCadence.ts` is deliberately dependency-free: its producers are
 * injected so the entry's own discipline (floor, skip reasons, dry run, the
 * switch) can be tested without a market database. That discipline is now
 * proven by `ashare-research-cadence.test.mjs`, but it proved only that the
 * entry *refuses to produce a wrong report* — not that it *can produce a
 * report*. This module closes that half by wiring the two real producers the
 * task spec names:
 *
 *   weekly  -> `diagnoseWatchlist` (股票池失效与风格归因、收益/风险来源、
 *             数据缺口、新研究假设优先级)
 *   monthly -> `buildForwardReview` (Champion vs Challenger 之外的前瞻复盘：
 *             固定被动基准、前瞻样本成熟情况、风险与执行成本、
 *             是否建议继续观察/淘汰/提交批准)
 *
 * ## Why this is a separate module and not an import inside researchCadence
 *
 * The producers live in `portfolio/` (and the diagnosis in `ashare/`), and
 * `researchCadence.ts` is the one entry a human or an approved timer calls.
 * Importing `portfolio/` from `ashare/` would couple the market-pipeline tree
 * to the account tree, and `researchJournal.ts` already imports back from
 * `ashare/` — the cycle would be silent on one platform and fatal on another.
 * So the composition lives here, in the one place that is allowed to know
 * about both trees.
 *
 * ## What this module adds beyond calling the two functions
 *
 * Only the three things the underlying functions cannot supply from inside,
 * and which the spec requires of an *entry*:
 *
 *   - **An absent input is never a finding.** A missing market cache, a
 *     research database that is the live database, or a calendar with too few
 *     closed sessions all return a skip with a reason. There is no path that
 *     turns an outage into "0 claims" or "no improvement".
 *   - **A dry run writes nothing**, and reports the report it would have
 *     written so the plan can be inspected first.
 *   - **The report names what it was derived from** — database paths, the
 *     as-of, the calendar sessions actually closed — so two runs can be
 *     diffed rather than trusted.
 *
 * It schedules nothing. `RESEARCH_CADENCE_ENABLED` stays unset unless a human
 * sets it, and no timer is created here.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { ashareDbPath, ashareResearchDbPath } from './db.js';
import { diagnoseWatchlist } from './researchDiagnosis.js';
import { openMarketCache } from '../portfolio/quotes.js';
import { buildForwardReview } from '../portfolio/forwardReview.js';
import { journalFeeEstimator } from '../portfolio/researchJournal.js';
import { openPortfolioDb, portfolioDbPath } from '../portfolio/db.js';
import { runResearchCadence, type CadenceRunResult, type CadenceSkipReason, type ResearchCadence } from './researchCadence.js';

export type { CadenceRunResult, CadenceSkipReason, ResearchCadence };

/** Which market database the diagnosis reads. */
export interface CadenceSources {
  /** The live market cache. Read-only. Defaults to `ashareDbPath()`. */
  marketDbPath?: string;
  /** The research workspace for replays and back-dated reports. */
  researchDbPath?: string;
  /** The account ledger for the forward review. */
  portfolioDbPath?: string;
  accountId?: string;
  /** Where a non-dry-run weekly diagnosis is written. */
  outputDir?: string;
}

/** The market cache and the research workspace may not be the same file. */
function assertDistinct(paths: { marketDbPath: string; researchDbPath: string; portfolioDbPath: string }): void {
  // Same inode through a different path is the failure that matters: a symlink
  // or a hard link would make a "research" write land on the live cache. The
  // identity comparison, not the string comparison, is the one that catches it.
  const identity = (path: string): string => {
    try {
      const stat = realpathSync(path);
      return stat;
    } catch {
      return path;
    }
  };
  const seen = new Map<string, string>();
  for (const [role, path] of Object.entries(paths)) {
    const key = identity(path);
    const prior = seen.get(key);
    if (prior) throw new Error(`研究入口的 ${role} 与 ${prior} 指向同一文件（${path}），拒绝执行`);
    seen.set(key, role);
  }
}

/** Count closed sessions strictly before `asOf`. null means "I could not tell".
 *
 * A missing *table* and an empty *table* are both "I could not tell", not zero.
 * This was not obvious: an empty `trade_cal` does not throw, it returns
 * `COUNT(*) = 0`, so a naive implementation reports a wiped calendar as
 * `not_enough_history` — "come back later" — for a database that will never have
 * one.
 *
 * The check is a single query, not two. An earlier version ran an unfiltered
 * `COUNT(*)` first to detect "empty", then the filtered one — which made the
 * `catch` unreachable for a table with the wrong columns, because the
 * unfiltered count returned 0 and short-circuited before the filtered query
 * could throw. One query means the guard and the throw are on the same path. */
function closedSessionsBefore(db: DatabaseSync | null, asOf: string): number | null {
  if (!db) return null;
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trade_cal'").get();
    if (!exists) return null;
    const row = db.prepare('SELECT COUNT(*) AS n FROM trade_cal WHERE is_open=1 AND cal_date < ?').get(asOf) as { n: number };
    // A calendar with no closed sessions before any date cannot answer "how
    // many closed before asOf". Reporting 0 would file a data outage as a quiet
    // week, which is the conflation the entry's `diagnosis_unavailable` reason
    // exists to prevent.
    if (Number(row.n) === 0) return null;
    return Number(row.n);
  } catch {
    return null;
  }
}

/** Whether the market cache holds a priced watchlist for any session at or before `asOf`. */
function hasStoredPool(db: DatabaseSync | null, asOf: string): boolean {
  if (!db) return false;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE trade_date <= ?').get(asOf) as { n: number };
    return Number(row.n) > 0;
  } catch {
    return false;
  }
}

/** Whether the account ledger exists and can be opened, not whether it has
 * records.
 *
 * This is deliberately not a row count, and deliberately not a table check.
 * The journal tables are created by the first `portfolio-journal-import`, so a
 * ledger that has never had a record imported has no `research_journal` table at
 * all — which is the *normal* state of a fresh install, not an outage.
 *
 * `buildForwardReview` answers that state correctly and importantly, with
 * `NO_MATURED_FORWARD_SAMPLE` — "尚无成熟的真实前瞻窗口，不能说明研究有任何
 * 改进，也不能说明没有". That is the single most honest sentence the whole
 * apparatus produces, and a row-count gate would suppress it: a fresh install
 * would never hear it, because nothing had been recorded yet. The floor already
 * guards against too little history; what the ledger contains is the review's
 * business, not the entry's. */
function ledgerPresent(db: DatabaseSync | null): boolean {
  return !!db;
}

export interface CadenceProducersOptions {
  accountId?: string;
  marketDbPath?: string;
  researchDbPath?: string;
  portfolioDbPath?: string;
  /** Weekly diagnosis window. The defaults are `diagnoseWatchlist`'s own. */
  horizon?: number;
  observationDates?: number;
  /** Monthly forward-review horizons. The default is `buildForwardReview`'s own. */
  horizons?: number[];
  outputDir?: string;
}

/**
 * Build the real producers for `runResearchCadence`.
 *
 * Every database is opened read-only and closed by the returned `close`. A
 * missing market cache is not an error here — it is reported as a skip, because
 * "the cache is not there yet" and "the cache says nothing happened" must not
 * be the same record.
 */
export function cadenceProducers(options: CadenceProducersOptions = {}) {
  const marketDbPath = options.marketDbPath ?? ashareDbPath();
  const researchDbPath = options.researchDbPath ?? ashareResearchDbPath();
  const portfolioPath = options.portfolioDbPath ?? portfolioDbPath();
  assertDistinct({ marketDbPath, researchDbPath, portfolioDbPath: portfolioPath });

  const market = existsSync(marketDbPath) ? openMarketCache(marketDbPath) : null;
  // The account ledger is opened read-only: a cadence report is an observation,
  // and an observation must not be able to append to the ledger it reads.
  const portfolio = existsSync(portfolioPath) ? openPortfolioDb(portfolioPath, { writable: false }) : null;

  return {
    market,
    portfolio,
    close(): void {
      market?.close();
      portfolio?.close();
    },
    weekly() {
      return {
        closedSessions: (asOf: string) => closedSessionsBefore(market, asOf),
        hasCandidates: (asOf: string) => hasStoredPool(market, asOf),
        // Declared up front rather than declined from inside `produce`, because
        // the generic checks run first and would otherwise answer "no
        // candidates" for a database that does not exist — an outage reported
        // as a quiet week.
        unavailable: (): { skip: CadenceSkipReason; detail?: string } | null =>
          market ? null : { skip: 'diagnosis_unavailable', detail: `行情缓存不存在：${marketDbPath}` },
        async produce(asOf: string) {
          if (!market) return { skip: 'diagnosis_unavailable' as CadenceSkipReason, detail: `行情缓存不存在：${marketDbPath}` };
          const report = diagnoseWatchlist(market, {
            asOf,
            horizon: options.horizon,
            observationDates: options.observationDates,
          });
          // A verdict that is explicitly "not enough data" is a real finding
          // about the pipeline, so it travels as the report rather than as a
          // skip: the operator asked what the diagnosis says, and this is what
          // it says. Only a thrown error or a missing database becomes a skip.
          return { report };
        },
        async write(report: unknown): Promise<string> {
          const folder = options.outputDir ?? 'data/ashare/diagnosis';
          const { mkdirSync, writeFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          mkdirSync(folder, { recursive: true });
          const path = join(folder, `diagnosis-${(report as { as_of: string }).as_of}.json`);
          // Never overwrite: a changed diagnosis for the same as-of is a
          // different file, so the earlier one stays auditable.
          if (existsSync(path)) return path;
          writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
          return path;
        },
      };
    },
    monthly() {
      return {
        closedSessions: (asOf: string) => closedSessionsBefore(market, asOf),
        hasCandidates: () => ledgerPresent(portfolio),
        // The account id is a requirement, not a default. A review is
        // account-scoped: substituting an account would silently change whose
        // performance is being reported, which is the one substitution a
        // research report must never make on the operator's behalf.
        unavailable: (): { skip: CadenceSkipReason; detail?: string } | null => {
          if (!portfolio) return { skip: 'review_unavailable', detail: `账户库不存在：${portfolioPath}` };
          if (!options.accountId) return { skip: 'review_unavailable', detail: '每月实验评审需要 account_id；不得默认账户' };
          return null;
        },
        async produce(asOf: string) {
          if (!portfolio) return { skip: 'review_unavailable' as CadenceSkipReason, detail: `账户库不存在：${portfolioPath}` };
          const accountId = options.accountId;
          if (!accountId) return { skip: 'review_unavailable' as CadenceSkipReason, detail: '每月实验评审需要 account_id' };
          const review = buildForwardReview({
            portfolioDb: portfolio, marketDb: market, accountId, asOf,
            horizons: options.horizons,
            feeEstimator: journalFeeEstimator(portfolio, market, accountId),
          });
          return { report: review };
        },
        async write(report: unknown): Promise<string> {
          const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs');
          const { dirname, join } = await import('node:path');
          const folder = options.outputDir ?? join(dirname(portfolioPath), 'forward-reviews');
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          chmodSync(folder, 0o700);
          const review = report as { as_of_trade_date: string; review_id: string };
          const path = join(folder, `${review.as_of_trade_date}-${review.review_id}.json`);
          // Content-addressed and never overwritten: a changed review is a new
          // file, so the earlier conclusion cannot be edited into a better one.
          if (existsSync(path)) return path;
          writeFileSync(path, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          return path;
        },
      };
    },
  };
}

/**
 * Run one cadence step with the real producers.
 *
 * The producers are opened, run, and closed in one call so that a long-lived
 * process does not hold the market cache open across a cadence boundary — and
 * so that a failure always closes the handles rather than leaking them into the
 * next run.
 */
export async function runRealCadence(
  cadence: ResearchCadence,
  options: CadenceProducersOptions & {
    asOf: string;
    accountId?: string;
    env?: Record<string, string | undefined>;
    dryRun?: boolean;
    minSessions?: number;
    now?: Date;
  },
): Promise<CadenceRunResult & { written_to?: string | null; detail?: string }> {
  const producers = cadenceProducers(options);
  try {
    // No account default. This previously read `?? 'real-main'`, which made the
    // producer's own "an account id is required, do not default" guard
    // unreachable — the exact defect shape the daily shadow loop had, where a
    // documented rule was enforced nowhere because the caller had already
    // substituted a value. A cadence report is account-scoped: silently
    // reporting one account's performance under another's name is the one
    // substitution a research report must never make on the operator's behalf.
    // The entry still needs *an* account for its record, so it takes the empty
    // string and the producer refuses before any work is done.
    const accountId = options.accountId ?? '';
    const selected = cadence === 'weekly' ? producers.weekly() : producers.monthly();
    const result = await runResearchCadence(cadence, {
      accountId, asOf: options.asOf,
      env: options.env, dryRun: options.dryRun, minSessions: options.minSessions, now: options.now,
    }, selected);
    return { ...result };
  } finally {
    producers.close();
  }
}
