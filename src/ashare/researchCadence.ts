/** Phase 6 — weekly research diagnosis and monthly experiment review orchestration.
 *
 * The task spec asks for two cadences beyond the daily loop:
 *
 *   每周研究诊断 — stock-pool failure and style attribution, ETF strategy and
 *   risk-config performance, candidate maturity, the main sources of return and
 *   risk, data gaps, fees and execution deviation, and a priority order for new
 *   research hypotheses.
 *
 *   每月实验评审 — Champion vs Challenger, the fixed passive benchmarks, forward
 *   sample maturity, risk/turnover/execution cost, failed candidates and
 *   counter-evidence, and a recommendation to keep observing, retire, or submit
 *   for approval.
 *
 * Both cadences already have the substance: `researchDiagnosis.ts` produces the
 * weekly claims and `forwardReview.ts` produces the monthly verdict. What was
 * missing is the *entry* — something that runs on a cadence, reports why it did
 * or did not produce anything, and never lets a missing input look like a
 * finding. This module is that entry.
 *
 * ## Why this is a composition and not new logic
 *
 * The spec's own rule is that no second matching or portfolio-accounting engine
 * may be introduced. The weekly and monthly cadences must therefore be a
 * scheduler-shaped wrapper over the existing two functions, adding no scoring,
 * no ranking, and no verdict of its own. Where this module does add something, it
 * is only the discipline the spec asks for and the underlying functions cannot
 * supply from inside:
 *
 *   - **An absent result is never a zero.** No input, no window, or a dry run
 *     produces a record that says so, with a reason. There is no path here that
 *     returns "0 findings" for "I was given nothing".
 *   - **A dry run writes nothing and reports the plan.**
 *   - **Disabled is the default**, and the switch is read by the entry itself,
 *     not by the caller. (The same defect that made the daily loop's switch
 *     decorative is not repeated here.)
 *   - **Every record carries the schema, the account, and what it was derived
 *     from**, so two runs can be diffed rather than trusted.
 *
 * It does not schedule itself. The spec is explicit that a new production timer
 * requires approval, so this is an entry a human or an approved timer may call,
 * and nothing in this repo wires one up.
 */

/** The research cadence this entry runs. */
export type ResearchCadence = 'weekly' | 'monthly';

export const RESEARCH_CADENCE_VERSION = 'research-cadence-1.0.0';

/** Why a cadence run produced no report. Every skip carries one. */
export type CadenceSkipReason =
  | 'disabled'
  | 'not_enough_history'
  | 'no_candidates'
  | 'diagnosis_unavailable'
  | 'review_unavailable';

export interface CadenceRunResult {
  schema: string;
  cadence: ResearchCadence;
  account_id: string;
  /** The as-of the report speaks for. */
  as_of: string;
  /** True when a report was produced (or already existed unchanged). */
  produced: boolean;
  /** Why no report was produced, when none was. Never null alongside a report. */
  skip_reason: CadenceSkipReason | null;
  /**
   * The producer's own words for why it declined, when it declined.
   *
   * This is carried through rather than invented here, because the producer is
   * the only component that knows the real cause. An earlier version dropped it:
   * the reason enum survived and the explanation did not, so an operator saw
   * `review_unavailable` and had to go read the source to learn it meant
   * "no matured forward window".
   */
  detail?: string;
  /** The report itself, or null when skipped. Never a synthetic stand-in. */
  report: unknown | null;
  /** Where the report was persisted, or null on a dry run or a skip. */
  written_to: string | null;
  /** True when the run was a dry run: the plan is computed, nothing is written. */
  dry_run: boolean;
  /** Wall-clock milliseconds, so a regression is visible. */
  ms: number;
}

export interface CadenceOptions {
  accountId: string;
  asOf: string;
  /** The disabled-by-default switch. Unset means disabled. */
  env?: Record<string, string | undefined>;
  /** When true, compute the plan and write nothing. */
  dryRun?: boolean;
  /**
   * Minimum closed sessions required before a cadence report is meaningful.
   *
   * This may only *raise* the floor, never lower it. A caller that could pass 5
   * for a monthly cadence could turn a week of data into a month's authority,
   * which is the exact failure the floor exists to prevent — so the floor is a
   * minimum, and an override below it is ignored rather than honoured.
   */
  minSessions?: number;
  /** Injected for tests. */
  now?: Date;
}

/** The environment switch. Unset means disabled, and disabled is the default. */
export function cadenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RESEARCH_CADENCE_ENABLED === '1';
}

/** The default floors. A week is five sessions; a month is twenty. */
export const DEFAULT_MIN_SESSIONS: Record<ResearchCadence, number> = { weekly: 5, monthly: 20 };

/**
 * Run one cadence step.
 *
 * The two producers are injected rather than imported so that this entry can be
 * tested without a market database, and so that the cadence's own discipline —
 * skip reasons, dry run, the switch — is testable independently of whether
 * `diagnoseWatchlist` happens to work on the fixture.
 */
export async function runResearchCadence(
  cadence: ResearchCadence,
  options: CadenceOptions,
  producers: {
    /** Count closed sessions at or before `asOf`, or null when the calendar is unavailable. */
    closedSessions(asOf: string): Promise<number | null> | number | null;
    /** Whether any candidate exists to report on. */
    hasCandidates(asOf: string): Promise<boolean> | boolean;
    /**
     * An up-front reason this producer cannot run at all, when it knows one
     * before doing any work.
     *
     * This exists because the earlier shape lost the producer's explanation.
     * A producer that could only decline from inside `produce` had its reason
     * flattened into `no_candidates` or `not_enough_history` whenever an
     * earlier step short-circuited first — so an operator saw "no candidates"
     * for a database that did not exist, which is an outage wearing the
     * costume of a quiet week. The producer is still the only component that
     * knows the real cause; this hook is how that knowledge reaches the caller
     * without being pre-empted by the ordering of the generic checks.
     */
    unavailable?(asOf: string): { skip: CadenceSkipReason; detail?: string } | null;
    /**
     * Produce the report, or decline with a reason. Returning `{ skip }` means
     * "I could not produce one, and here is why"; this entry propagates that
     * reason unchanged rather than inventing one of its own, because the
     * producer is the only component that knows the real cause.
     */
    produce(asOf: string): Promise<{ report: unknown } | { skip: CadenceSkipReason; detail?: string }>;
    /** Persist the report. Not called on a dry run. */
    write?(report: unknown): Promise<string | void> | string | void;
  },
): Promise<CadenceRunResult> {
  const started = Date.now();
  const dryRun = options.dryRun ?? false;
  const skip = (reason: CadenceSkipReason, detail?: string): CadenceRunResult => ({
    schema: RESEARCH_CADENCE_VERSION, cadence, account_id: options.accountId, as_of: options.asOf,
    produced: false, skip_reason: reason, ...(detail === undefined ? {} : { detail }), report: null,
    written_to: null, dry_run: dryRun, ms: Date.now() - started,
  });

  // The switch is read here, on every call, before anything else. A cadence that
  // consults its caller for permission is a cadence whose default is whatever
  // the caller forgot.
  if (!cadenceEnabled(options.env ?? process.env)) return skip('disabled');

  // The producer's own "I cannot run" is asked for before the generic checks,
  // because it is the only answer that distinguishes an outage from a quiet
  // week. Asking afterwards would mean `hasCandidates` had already answered
  // "no" for a database that does not exist.
  const unavailable = await producers.unavailable?.(options.asOf);
  if (unavailable) return skip(unavailable.skip, unavailable.detail);

  // The floor is a minimum, not a setting. `Math.max` means an override can ask
  // for more evidence than the cadence requires, but never less: a monthly report
  // built on a week of sessions would carry a month's authority on a week's data.
  const floor = Math.max(options.minSessions ?? 0, DEFAULT_MIN_SESSIONS[cadence]);
  const sessions = await producers.closedSessions(options.asOf);
  if (sessions === null || sessions === undefined) return skip('diagnosis_unavailable');
  if (sessions < floor) return skip('not_enough_history');
  if (!(await producers.hasCandidates(options.asOf))) return skip('no_candidates');

  const produced = await producers.produce(options.asOf);
  if ('skip' in produced) return skip(produced.skip, produced.detail);

  if (dryRun) {
    // A dry run reports the report it would write, so the plan can be inspected
    // against what already exists before anything is persisted.
    return {
      schema: RESEARCH_CADENCE_VERSION, cadence, account_id: options.accountId, as_of: options.asOf,
      produced: false, skip_reason: null, report: produced.report, written_to: null,
      dry_run: true, ms: Date.now() - started,
    };
  }
  // The write reports where it landed. An entry that persisted a report without
  // saying where would leave the operator guessing, and "did that actually save"
  // is exactly the question a cadence report has to answer for itself.
  const written = await producers.write?.(produced.report);
  return {
    schema: RESEARCH_CADENCE_VERSION, cadence, account_id: options.accountId, as_of: options.asOf,
    produced: true, skip_reason: null, report: produced.report,
    written_to: typeof written === 'string' ? written : null, dry_run: false, ms: Date.now() - started,
  };
}
