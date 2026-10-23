/** Phase 6 — daily shadow decision sealing.
 *
 * A shadow decision is a judgement recorded BEFORE the outcome it will be judged
 * against is observable. The task spec asks for that ordering as an acceptance
 * criterion ("决策必须在后续价格/成交结果可观察前封存"), and the whole difficulty
 * is that nothing physical enforces it. A process that decides at 21:00 and
 * writes at 23:00 produces a byte-identical row to one that did both at 21:00.
 *
 * So this module makes the ordering checkable instead of merely asserted, by
 * carrying three things a plain row does not:
 *
 *   - `data_cutoff`: the last date whose data the decision was allowed to see.
 *     Sealing refuses a cutoff later than the trade date the decision speaks
 *     for, which is what turns "recomputed in hindsight" from an invisible
 *     property of the numbers into a refused write.
 *   - `content_hash`: over the canonical JSON of everything above. Idempotency
 *     and immutability both key off it.
 *   - `sealed_at`: when the seal was written, so a decision can be ordered
 *     against the observations appended for it.
 *
 * The evaluation of a matured horizon is a SEPARATE record, appended by
 * `evaluateSealedDecision`. It never edits the sealed row — that separation is
 * what makes the sealed decision still mean "what we thought when we knew less".
 *
 * Scope: research-only. Nothing here writes a real position, a real order, or
 * touches the live market cache. The database it opens is the caller's.
 */

import { createHash as crypto } from 'node:crypto';

export const SHADOW_DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_decisions (
 decision_id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 as_of_trade_date TEXT NOT NULL,
 data_cutoff TEXT NOT NULL,
 horizon_days INTEGER NOT NULL,
 candidate_id TEXT NOT NULL,
 bundle_id TEXT NOT NULL,
 judgement_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 sealed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_decisions_account_date
 ON shadow_decisions(account_id, as_of_trade_date);
-- Immutability at the storage layer, not just in the accessor. A trigger fires
-- on UPDATE and DELETE regardless of which code path attempts them, so a future
-- caller cannot quietly "fix" a sealed decision.
CREATE TRIGGER IF NOT EXISTS shadow_decisions_no_update BEFORE UPDATE ON shadow_decisions
 BEGIN SELECT RAISE(ABORT,'shadow_decisions is immutable; append an evaluation instead'); END;
CREATE TRIGGER IF NOT EXISTS shadow_decisions_no_delete BEFORE DELETE ON shadow_decisions
 BEGIN SELECT RAISE(ABORT,'shadow_decisions is immutable'); END;
CREATE TABLE IF NOT EXISTS shadow_evaluations (
 evaluation_id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL,
 evaluated_at TEXT NOT NULL,
 cutoff TEXT NOT NULL,
 matured INTEGER NOT NULL,
 horizon_days INTEGER NOT NULL,
 net_return REAL,
 excess REAL,
 reason TEXT,
 content_hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS shadow_evaluations_no_update BEFORE UPDATE ON shadow_evaluations
 BEGIN SELECT RAISE(ABORT,'shadow_evaluations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS shadow_evaluations_no_delete BEFORE DELETE ON shadow_evaluations
 BEGIN SELECT RAISE(ABORT,'shadow_evaluations is immutable'); END;
`;

export interface ShadowDecisionInput {
  decision_id: string;
  account_id: string;
  as_of_trade_date: string;
  data_cutoff: string;
  horizon_days: number;
  candidate_id: string;
  bundle_id: string;
  judgement: unknown;
}

export interface ShadowDecision extends ShadowDecisionInput {
  judgement_json: string;
  content_hash: string;
  sealed_at: string;
}

export interface ShadowEvaluation {
  decision_id: string;
  matured: boolean;
  horizon_days: number;
  net_return: number | null;
  excess: number | null;
  reason?: string;
}

/** Canonical JSON, so the same decision always hashes the same way. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function sha256Sync(text: string): string {
  return crypto('sha256').update(text, 'utf8').digest('hex');
}

function rowToDecision(row: any): ShadowDecision {
  return {
    decision_id: row.decision_id,
    account_id: row.account_id,
    as_of_trade_date: row.as_of_trade_date,
    data_cutoff: row.data_cutoff,
    horizon_days: row.horizon_days,
    candidate_id: row.candidate_id,
    bundle_id: row.bundle_id,
    judgement: JSON.parse(row.judgement_json),
    judgement_json: row.judgement_json,
    content_hash: row.content_hash,
    sealed_at: row.sealed_at,
  };
}

/**
 * Seal one shadow decision. Idempotent on identical content; refuses a
 * different decision under the same ID, and refuses a cutoff that postdates the
 * trade date the decision claims to speak for.
 *
 * The cutoff check is the load-bearing one. It is the only thing here that can
 * reject a "recomputed in hindsight" decision, and it works because the runner
 * must pass the cutoff it actually used rather than the one that looks right.
 */
export function sealShadowDecision(
  db: any,
  input: ShadowDecisionInput,
  now = new Date(),
): { created: boolean; decision: ShadowDecision } {
  db.exec(SHADOW_DECISION_SCHEMA);
  if (!input.decision_id) throw new Error('shadow_decision_id_required');
  if (!input.as_of_trade_date) throw new Error('shadow_as_of_required');
  if (!input.data_cutoff) throw new Error('shadow_cutoff_required');
  // String comparison is correct for YYYYMMDD / YYYY-MM-DD, which is all this
  // module ever sees. Parsing to Date would introduce a timezone that can move
  // a same-day comparison across a midnight boundary.
  if (input.data_cutoff > input.as_of_trade_date) {
    throw new Error(
      `shadow_cutoff_after_as_of: cutoff ${input.data_cutoff} is later than the trade date `
      + `${input.as_of_trade_date} the decision speaks for; a decision dated ${input.as_of_trade_date} `
      + 'cannot have seen later data',
    );
  }
  if (!Number.isInteger(input.horizon_days) || input.horizon_days <= 0) {
    throw new Error('shadow_horizon_must_be_positive_integer');
  }

  const judgement_json = canonical(input.judgement);
  const digest = sha256Sync(canonical({
    decision_id: input.decision_id,
    account_id: input.account_id,
    as_of_trade_date: input.as_of_trade_date,
    data_cutoff: input.data_cutoff,
    horizon_days: input.horizon_days,
    candidate_id: input.candidate_id,
    bundle_id: input.bundle_id,
    judgement_json,
  }));

  const existing = db.prepare('SELECT * FROM shadow_decisions WHERE decision_id=?').get(input.decision_id);
  if (existing) {
    if (existing.content_hash !== digest) {
      throw new Error(
        `shadow_decision_conflict: ${input.decision_id} is already sealed with different content; `
        + 'append a new decision with a new ID rather than replacing a sealed one',
      );
    }
    return { created: false, decision: rowToDecision(existing) };
  }

  const sealedAt = now.toISOString();
  db.prepare(
    'INSERT INTO shadow_decisions VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    input.decision_id, input.account_id, input.as_of_trade_date, input.data_cutoff,
    input.horizon_days, input.candidate_id, input.bundle_id, judgement_json, digest, sealedAt,
  );
  return {
    created: true,
    decision: {
      ...input, judgement_json, content_hash: digest, sealed_at: sealedAt,
    },
  };
}

export function readShadowDecision(db: any, decisionId: string): ShadowDecision | null {
  const row = db.prepare('SELECT * FROM shadow_decisions WHERE decision_id=?').get(decisionId);
  return row ? rowToDecision(row) : null;
}

/**
 * Append an evaluation for a sealed decision.
 *
 * Returns `null` when the decision was never sealed. That is deliberate: there
 * is nothing to evaluate, and synthesising a record would be the one answer
 * that cannot be corrected later.
 *
 * `priceOutcome` is injected rather than computed here. The decision to keep
 * pricing out of the sealing module is a scope decision: this module's job is
 * the ordering guarantee, and mixing in an engine would mean the seal could
 * only be tested through the engine's calendar.
 */
export function appendShadowEvaluation(
  db: any,
  decisionId: string,
  outcome: { cutoff: string; matured: boolean; net_return: number | null; excess: number | null; reason?: string },
  now = new Date(),
): { created: boolean } {
  const decision = readShadowDecision(db, decisionId);
  if (!decision) return { created: false } as any;
  const evaluationId = `${decisionId}@${outcome.cutoff}`;
  const digest = sha256Sync(canonical({ ...outcome, decision_id: decisionId, horizon_days: decision.horizon_days }));
  const existing = db.prepare('SELECT * FROM shadow_evaluations WHERE evaluation_id=?').get(evaluationId);
  if (existing) {
    if (existing.content_hash !== digest) {
      throw new Error(`shadow_evaluation_conflict: ${evaluationId} already recorded with a different outcome`);
    }
    return { created: false };
  }
  // Column names are spelled out rather than relying on positional VALUES: the
  // table has ten columns and a positional insert with nine placeholders fails
  // at runtime with a message that does not say which column is missing.
  db.prepare(
    'INSERT INTO shadow_evaluations '
    + '(evaluation_id, decision_id, evaluated_at, cutoff, matured, horizon_days, net_return, excess, reason, content_hash) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    evaluationId, decisionId, now.toISOString(), outcome.cutoff,
    outcome.matured ? 1 : 0, decision.horizon_days,
    outcome.net_return, outcome.excess, outcome.reason ?? null, digest,
  );
  return { created: true };
}

/**
 * Evaluate a sealed decision at a cutoff. Kept separate from the append so the
 * maturity question can be asked without writing anything.
 */
export function evaluateSealedDecision(
  db: any,
  decisionId: string,
  opts: { cutoff: string },
): ShadowEvaluation | null {
  const decision = readShadowDecision(db, decisionId);
  if (!decision) return null;
  // The caller supplies the observed forward window; this module does not read
  // prices. A horizon that has not matured is reported as absent, never zero.
  //
  // `hasMatured` alone is sufficient, and I first wrote a redundant conjunct in
  // front of it — `opts.cutoff > decision.data_cutoff` — with a comment claiming
  // it stopped a negative day count from wrapping into a false "matured". That
  // claim is false, and mutation testing is what exposed it: deleting the
  // conjunct killed no test, which is what a provably redundant expression looks
  // like. `exchangeDaysAfter` counts `cal_date > data_cutoff AND cal_date <=
  // cutoff`, so it is 0 for any cutoff at or before data_cutoff, and 0 never
  // satisfies `>= horizon`. The guard is not needed, so it is not here.
  const matured = hasMatured(db, decision, opts.cutoff);
  if (!matured) {
    return {
      decision_id: decisionId,
      matured: false,
      horizon_days: decision.horizon_days,
      net_return: null,
      excess: null,
      reason: 'horizon_after_as_of',
    };
  }
  const row = db.prepare(
    'SELECT net_return, excess FROM shadow_evaluations WHERE decision_id=? ORDER BY cutoff DESC LIMIT 1',
  ).get(decisionId);
  return {
    decision_id: decisionId,
    matured: true,
    horizon_days: decision.horizon_days,
    net_return: row ? row.net_return : null,
    excess: row ? row.excess : null,
  };
}

/** Count exchange days strictly after `from` up to and including `to`. */
function exchangeDaysAfter(db: any, from: string, to: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM trade_cal WHERE is_open=1 AND cal_date>? AND cal_date<=?",
  ).get(from, to);
  return row.n;
}

function hasMatured(db: any, decision: ShadowDecision, cutoff: string): boolean {
  return exchangeDaysAfter(db, decision.data_cutoff, cutoff) >= decision.horizon_days;
}
