/** Phase 6 — daily research orchestration (NOT wired to any scheduler).
 *
 * Phase 6's acceptance criterion is that a decision must be sealed before the
 * outcome it will be judged against is observable. `shadowSeal.ts` provides that
 * for one decision. This module is the daily entry that produces and evaluates
 * those decisions across a run of sessions.
 *
 * The task spec asks for seven properties of that entry:
 *
 *   idempotency, bounded runtime, bounded resource use, failure visibility,
 *   restart-recovery, status reporting, dry-run, disabled-by-default.
 *
 * Seven properties, and only the first and the last two are about the happy
 * path. The middle three are about what happens when something goes wrong, and
 * they are the ones a research loop needs most, because the thing most likely to
 * go wrong is not the loop — it is the data. A missing session, a stale cutoff,
 * a hole in the calendar: all of these are ordinary. A loop that reports
 * "evaluated: 0, return: null" for a day whose prices simply had not landed yet
 * has just written a negative result that is really a data outage.
 *
 * So the design here is: **every step reports a reason, and an absent result is
 * never a zero.** `runDailyShadow` returns a per-session record of what it did,
 * why it skipped what it skipped, and how long it took. A caller can diff two
 * runs of the same day and get the same answer — that is the idempotency
 * property, stated so it can be tested rather than hoped for.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not read prices. The maturity question is answered from the caller's
 * `trade_cal` and an injected `priceOutcome`, so the seal can be tested without
 * an engine. It does not write a real position or a real order. It does not
 * touch the live market cache: the databases it opens are the ones passed in.
 * It does not schedule itself — the task spec forbids activating a new
 * production timer without approval, so the activation is a human decision and
 * this module stays an entry, not a cron job.
 *
 * ## The disabled-by-default switch
 *
 * `RESEARCH_SHADOW_ENABLED` defaults to unset, and unset means disabled. The
 * spec is explicit that research scheduling may be built and tested but must
 * not go live without approval, so the safe default is the one that cannot act.
 * Setting it to `1` is the human's decision; nothing in this repo does it.
 */

import type { DatabaseSync } from 'node:sqlite';

export const SHADOW_ORCHESTRATION_VERSION = 'shadow-orchestration-1.0.0';

/** Default horizon in exchange days for a shadow decision. */
export const DEFAULT_SHADOW_HORIZON = 20;

/**
 * Why a session produced no shadow decision. Every skip carries one.
 *
 * `'disabled'` was on this list from the start while nothing could ever produce
 * it — the loop never consulted `shadowEnabled()`. An unreachable reason is
 * worse than a missing one: it reads as coverage. A `'below_maturity_floor'`
 * was declared here too and removed, because no floor is checked here and
 * inventing one would have meant checking the same maturity twice.
 */
export type SkipReason =
  | 'not_a_trading_day'
  | 'session_not_closed'
  | 'no_price_cutoff'
  | 'no_candidates'
  | 'disabled';

export interface ShadowSessionResult {
  as_of_trade_date: string;
  /** Whether a decision was sealed this session (as opposed to already sealed). */
  created: boolean;
  decision_id: string | null;
  /** Why no decision was produced, when none was. Never null alongside a decision. */
  skip_reason: SkipReason | null;
  /** The cutoff the decision was computed against, when one was sealed. */
  data_cutoff: string | null;
  /** Matured horizons evaluated this session, and how many were still pending. */
  evaluated: number;
  pending: number;
  /** Wall-clock milliseconds for this session, so a regression is visible. */
  ms: number;
}

export interface DailyShadowRun {
  schema: string;
  account_id: string;
  /** Sessions requested, in the order they were processed. */
  as_of_trade_dates: string[];
  sessions: ShadowSessionResult[];
  totals: {
    requested: number;
    sealed: number;
    already_sealed: number;
    skipped: number;
    evaluated: number;
    pending: number;
    /** Sum of the skip reasons, so a run dominated by one cause is legible. */
    skipped_by_reason: Record<string, number>;
  };
  /** True when the run was a dry run: the plan is computed, nothing is written. */
  dry_run: boolean;
  ms: number;
}

export interface ShadowCandidateSource {
  /** The candidate IDs available for shadowing on this session, or empty. */
  candidates(asOf: string): Promise<string[]> | string[];
}

export interface PriceOutcomeSource {
  /**
   * The observed outcome for a decision at a cutoff, or null when the horizon has
   * not matured. Never a zero: an unmatured horizon is an absence, and an absent
   * price is not a flat window.
   */
  outcome(input: { decision_id: string; as_of_trade_date: string; data_cutoff: string; horizon_days: number; cutoff: string }): Promise<{ net_return: number | null; excess: number | null } | null> | { net_return: number | null; excess: number | null } | null;
}

export interface DailyShadowOptions {
  db: any;
  accountId: string;
  asOfTradeDates: string[];
  candidates: ShadowCandidateSource;
  prices: PriceOutcomeSource;
  /** Cutoff to evaluate against. Defaults to the latest closed session. */
  cutoff?: string;
  horizonDays?: number;
  /** When true, compute the plan and write nothing. */
  dryRun?: boolean;
  /** Injected for tests; the run's own clock is not used for the plan. */
  now?: Date;
  /**
   * The environment to read the switch from. Defaults to `process.env`, and is
   * injected by tests so the default can be proven without a subprocess.
   *
   * The switch is read **here**, on every call, rather than by the caller. That
   * is the whole point: `shadowEnabled()` existed and was unit-tested, but
   * nothing called it, so a caller who forgot would write decisions while
   * believing the default was inert. A safety property that lives only in a
   * helper nobody invokes is documentation, not a guard.
   */
  env?: Record<string, string | undefined>;
}

/** The environment switch. Unset means disabled, and disabled is the default. */
export function shadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RESEARCH_SHADOW_ENABLED === '1';
}

/**
 * Count open exchange days strictly after `from` up to and including `to`.
 *
 * Zero is a meaningful answer and is returned as zero: it says "no session has
 * closed since the cutoff", which is exactly the state a horizon that has not
 * matured is in. It is never coerced to a maturity.
 */
export function exchangeDaysBetween(db: any, from: string, to: string): number {
  // No `?? 0` default: COUNT(*) always returns a row, so the fallback is
  // unreachable. It survived mutation testing as a no-op — replacing it with 1
  // killed nothing, because no input can reach it — which is what dead defensive
  // code looks like. Removing it also removes a place where a future reader
  // might assume a missing calendar is possible here.
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM trade_cal WHERE is_open=1 AND cal_date>? AND cal_date<=?',
  ).get(from, to);
  return Number(row.n);
}

/** Whether the session exists in the calendar and had closed by the cutoff. */
export function sessionState(db: any, asOf: string, cutoff: string): { is_trading_day: boolean; closed: boolean } {
  const row = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date=?').get(asOf) as any;
  const isTradingDay = row?.is_open === 1;
  // A session is closed once the cutoff has reached or passed it. String
  // comparison is correct for YYYYMMDD and avoids a timezone moving a same-day
  // comparison across a midnight boundary.
  return { is_trading_day: isTradingDay, closed: asOf <= cutoff };
}

/**
 * Run one day of the shadow loop: decide, seal, then evaluate matured horizons.
 *
 * Order matters and is the whole point: the decision is sealed from the cutoff
 * the decision actually used, and only horizons that have matured by the
 * evaluation cutoff are asked for an outcome. A horizon that has not matured is
 * reported as pending with a null return, never as a zero return.
 */
export async function runDailyShadow(options: DailyShadowOptions): Promise<DailyShadowRun> {
  const started = Date.now();
  const horizon = options.horizonDays ?? DEFAULT_SHADOW_HORIZON;
  const dryRun = options.dryRun ?? false;
  const { sealShadowDecision, appendShadowEvaluation, evaluateSealedDecision } = await import('./shadowSeal.js');

  // The switch is checked before anything else, including the calendar lookup.
  // Checking it late would mean a disabled run still opened the database, still
  // derived a cutoff, and still did the work it then had to throw away — and
  // would leave the "disabled" reason reachable only on paths that never write,
  // which is how the previous version came to declare an unreachable reason.
  if (!shadowEnabled(options.env ?? process.env)) {
    return {
      schema: SHADOW_ORCHESTRATION_VERSION, account_id: options.accountId,
      as_of_trade_dates: [...options.asOfTradeDates], sessions: options.asOfTradeDates.map(asOf => ({
        as_of_trade_date: asOf, created: false, decision_id: null, skip_reason: 'disabled',
        data_cutoff: null, evaluated: 0, pending: 0, ms: 0,
      })),
      totals: {
        requested: options.asOfTradeDates.length, sealed: 0, already_sealed: 0,
        skipped: options.asOfTradeDates.length, evaluated: 0, pending: 0,
        skipped_by_reason: { disabled: options.asOfTradeDates.length },
      },
      dry_run: dryRun, ms: Date.now() - started,
    };
  }

  // The evaluation cutoff defaults to the latest closed session in the calendar,
  // so a run asked for "today" evaluates against everything actually closed
  // rather than against a date the data has not reached.
  const cutoff = options.cutoff
    ?? (options.db.prepare('SELECT MAX(cal_date) d FROM trade_cal WHERE is_open=1').get() as any)?.d
    ?? null;
  if (!cutoff) {
    return {
      schema: SHADOW_ORCHESTRATION_VERSION, account_id: options.accountId,
      as_of_trade_dates: [...options.asOfTradeDates], sessions: options.asOfTradeDates.map(asOf => ({
        as_of_trade_date: asOf, created: false, decision_id: null, skip_reason: 'no_price_cutoff',
        data_cutoff: null, evaluated: 0, pending: 0, ms: 0,
      })),
      totals: {
        requested: options.asOfTradeDates.length, sealed: 0, already_sealed: 0,
        skipped: options.asOfTradeDates.length, evaluated: 0, pending: 0,
        skipped_by_reason: { no_price_cutoff: options.asOfTradeDates.length },
      },
      dry_run: dryRun, ms: Date.now() - started,
    };
  }

  const sessions: ShadowSessionResult[] = [];
  const skippedByReason: Record<string, number> = {};
  let sealed = 0;
  let alreadySealed = 0;
  let evaluated = 0;
  let pending = 0;

  for (const asOf of options.asOfTradeDates) {
    const t0 = Date.now();
    const state = sessionState(options.db, asOf, cutoff);
    if (!state.is_trading_day) {
      sessions.push(skip(asOf, 'not_a_trading_day', Date.now() - t0));
      bump(skippedByReason, 'not_a_trading_day');
      continue;
    }
    if (!state.closed) {
      sessions.push(skip(asOf, 'session_not_closed', Date.now() - t0));
      bump(skippedByReason, 'session_not_closed');
      continue;
    }
    // The decision's own cutoff is the session it speaks for, not the evaluation
    // cutoff. Sealing a decision dated D against data through E > D is the exact
    // hindsight shape shadowSeal refuses, and it would be a bug here rather than
    // there: this is the caller that would have to lie.
    const dataCutoff = asOf;

    const candidateIds = await options.candidates.candidates(asOf);
    if (!candidateIds.length) {
      sessions.push(skip(asOf, 'no_candidates', Date.now() - t0));
      bump(skippedByReason, 'no_candidates');
      continue;
    }

    const decisionId = `shadow-${options.accountId}-${asOf}`;
    if (dryRun) {
      // A dry run reports the plan it would execute, including the decision ID it
      // would write, so the ID can be checked against what is already sealed.
      sessions.push({
        as_of_trade_date: asOf, created: false, decision_id: decisionId,
        skip_reason: null, data_cutoff: dataCutoff, evaluated: 0, pending: 0,
        ms: Date.now() - t0,
      });
      continue;
    }

    let created: boolean;
    try {
      const result = sealShadowDecision(options.db, {
        decision_id: decisionId,
        account_id: options.accountId,
        as_of_trade_date: asOf,
        data_cutoff: dataCutoff,
        horizon_days: horizon,
        candidate_id: candidateIds[0],
        bundle_id: `shadow-${asOf}`,
        judgement: { action: 'HOLD', candidates: candidateIds, rationale: 'shadow observation; no position taken' },
      });
      created = result.created;
    } catch (error: any) {
      // A seal that throws is a refusal, not a crash to swallow. Re-throw with the
      // session attached so the failure names the day that caused it.
      throw new Error(`shadow_seal_failed: ${asOf}: ${error?.message ?? error}`);
    }
    if (created) sealed += 1;
    else alreadySealed += 1;

    // Evaluation is a separate pass over the SAME cutoff for every session, so a
    // horizon's maturity is a property of the calendar rather than of when the
    // run happened to execute.
    const matured = exchangeDaysBetween(options.db, dataCutoff, cutoff) >= horizon;
    let sessionEvaluated = 0;
    let sessionPending = 0;
    if (matured) {
      const evaluation = evaluateSealedDecision(options.db, decisionId, { cutoff });
      const alreadyRecorded = evaluation?.net_return !== null && evaluation?.net_return !== undefined;
      if (!alreadyRecorded) {
        const outcome = await options.prices.outcome({
          decision_id: decisionId, as_of_trade_date: asOf, data_cutoff: dataCutoff,
          horizon_days: horizon, cutoff,
        });
        if (outcome === null || outcome === undefined) {
          // The horizon is mature but the outcome is unavailable. That is a data
          // gap, not a flat window: it stays pending and carries no number.
          sessionPending += 1;
        } else {
          appendShadowEvaluation(options.db, decisionId, {
            cutoff, matured: true, net_return: outcome.net_return, excess: outcome.excess,
          });
          sessionEvaluated += 1;
        }
      } else {
        sessionEvaluated += 1;
      }
    } else {
      sessionPending += 1;
    }
    evaluated += sessionEvaluated;
    pending += sessionPending;
    sessions.push({
      as_of_trade_date: asOf, created, decision_id: decisionId, skip_reason: null,
      data_cutoff: dataCutoff, evaluated: sessionEvaluated, pending: sessionPending,
      ms: Date.now() - t0,
    });
  }

  return {
    schema: SHADOW_ORCHESTRATION_VERSION, account_id: options.accountId,
    as_of_trade_dates: [...options.asOfTradeDates], sessions,
    totals: {
      requested: options.asOfTradeDates.length, sealed, already_sealed: alreadySealed,
      skipped: sessions.filter(s => s.skip_reason !== null).length, evaluated, pending,
      skipped_by_reason: skippedByReason,
    },
    dry_run: dryRun, ms: Date.now() - started,
  };
}

function skip(asOf: string, reason: SkipReason, ms: number): ShadowSessionResult {
  return { as_of_trade_date: asOf, created: false, decision_id: null, skip_reason: reason, data_cutoff: null, evaluated: 0, pending: 0, ms };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
