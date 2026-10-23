import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb } from '../build/ashare/db.js';
import { weekdays, seedReferenceUniverse } from './ashare-fixture.mjs';
import { SHADOW_DECISION_SCHEMA } from '../build/ashare/shadowSeal.js';
import {
  runDailyShadow, exchangeDaysBetween, sessionState, shadowEnabled,
  DEFAULT_SHADOW_HORIZON, SHADOW_ORCHESTRATION_VERSION, DEFAULT_SHADOW_RUNTIME_BUDGET_MS,
  DEFAULT_SHADOW_HEAP_BUDGET_BYTES,
} from '../build/ashare/shadowRun.js';

/** Phase 6 — the daily orchestration entry for the shadow loop.
 *
 * `ashare-shadow-seal.test.mjs` proves one seal is correct. This file proves the
 * run that produces many of them behaves, and specifically that it fails in the
 * ways that matter for a research loop rather than in the ways that are
 * convenient:
 *
 * 1. **An absent result is never a zero.** A horizon that has not matured is
 *    pending with a null return. The dangerous failure is a loop that reports
 *    "evaluated 0, return 0.00" on a day whose prices had not landed — that
 *    writes a negative finding which is really an outage.
 * 2. **A non-trading day and an unclosed session are different skips.** They are
 *    reported as different reasons because they mean different things: the first
 *    is the calendar, the second is the clock. Collapsing them hides a stall.
 * 3. **Re-running a day is idempotent.** Same input, same output, one row.
 * 4. **A dry run writes nothing but still reports the decision ID it would
 *    write**, so the plan can be checked against what is already sealed.
 * 5. **Disabled is the default.** The loop itself refuses to run unless
 *    `RESEARCH_SHADOW_ENABLED=1`, so the default is inert rather than merely
 *    unchecked.
 *
 * The `env` on the helper is not incidental. `runDailyShadow` reads the switch
 * itself now, so every test here that wants the loop to act has to opt in. That
 * is deliberate: when the switch was only checked by a helper nobody called, a
 * production caller would have written decisions while believing the default was
 * safe. Enforcing it here is what made those eleven tests need an explicit opt-in.
 */

/** Enough history to seal and enough forward sessions to mature h=20. */
const HISTORY = weekdays('20240102', 60);
const SESSIONS = weekdays(HISTORY.at(-1), 30).slice(1);
/** The evaluation cutoff is a closed session well past the maturity horizon. */
const CUTOFF = SESSIONS.at(-1);

function fixture(t) {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  seedReferenceUniverse(db, [...HISTORY, ...SESSIONS], { stocks: 2 });
  db.exec(SHADOW_DECISION_SCHEMA);
  return db;
}

const candidates = (ids = ['S4C_R2']) => ({ candidates: () => ids });
const prices = (returns = {}) => ({
  outcome: ({ decision_id }) => (decision_id in returns ? returns[decision_id] : { net_return: 0.01, excess: -0.02 }),
});

/** The explicit opt-in. Every test below that expects the loop to act passes it. */
const ENABLED = { RESEARCH_SHADOW_ENABLED: '1' };

const run = (db, over = {}) => runDailyShadow({
  db,
  accountId: 'real-main',
  asOfTradeDates: [SESSIONS[0]],
  candidates: candidates(),
  prices: prices(),
  cutoff: CUTOFF,
  env: ENABLED,
  ...over,
});

test('the default horizon is the one the seal module matures on', () => {
  // If these two disagreed, every horizon would look unmatured forever and the
  // loop would report "pending" for the rest of time.
  assert.equal(DEFAULT_SHADOW_HORIZON, 20);
});

test('the shadow loop is disabled unless the environment says otherwise', () => {
  // The task spec forbids activating a new production timer without approval, so
  // the default must be the one that cannot act. Unset, empty, and "true" are
  // all disabled: only the explicit "1" turns it on.
  assert.equal(shadowEnabled({}), false, 'unset must be disabled');
  assert.equal(shadowEnabled({ RESEARCH_SHADOW_ENABLED: '' }), false);
  assert.equal(shadowEnabled({ RESEARCH_SHADOW_ENABLED: 'true' }), false, 'a truthy word is not the opt-in value');
  assert.equal(shadowEnabled({ RESEARCH_SHADOW_ENABLED: '0' }), false);
  assert.equal(shadowEnabled({ RESEARCH_SHADOW_ENABLED: '1' }), true);
});

test('a sealed session records the cutoff it was computed against, not the evaluation cutoff', async t => {
  const db = fixture(t);
  const result = await run(db);
  assert.equal(result.totals.sealed, 1);
  const session = result.sessions[0];
  // The decision speaks for SESSIONS[0], so its cutoff must be SESSIONS[0] even
  // though the run evaluates against CUTOFF. A decision dated D that cites data
  // through CUTOFF is the hindsight shape shadowSeal refuses — and it would be a
  // bug in this caller, not in the seal.
  assert.equal(session.data_cutoff, SESSIONS[0]);
  assert.notEqual(session.data_cutoff, CUTOFF);
  assert.equal(session.skip_reason, null);
  // CUTOFF is 29 exchange days past SESSIONS[0], so h=20 HAS matured by the time
  // this run evaluates. The horizon is measured from the decision's own cutoff,
  // not from the evaluation cutoff, so a session sealed today can be evaluated
  // today if enough sessions closed in between.
  assert.equal(session.evaluated, 1, 'the horizon matured, so it is evaluated');
  assert.equal(session.pending, 0);
});

test('a horizon that has not matured is pending with a null return, never a zero', async t => {
  const db = fixture(t);
  // Evaluate only a few sessions past the decision: not enough to mature h=20.
  const result = await run(db, { cutoff: SESSIONS[3] });
  const session = result.sessions[0];
  assert.equal(session.skip_reason, null, 'the seal itself succeeded');
  assert.equal(session.evaluated, 0);
  assert.equal(session.pending, 1, 'an immature horizon is pending, not evaluated');
  assert.equal(result.totals.evaluated, 0);
  // And the sealed decision reports the horizon as absent, not flat.
  const { evaluateSealedDecision } = await import('../build/ashare/shadowSeal.js');
  const evaluation = evaluateSealedDecision(db, session.decision_id, { cutoff: SESSIONS[3] });
  assert.equal(evaluation.matured, false);
  assert.equal(evaluation.net_return, null, 'an unmatured horizon must not read as a 0% return');
  assert.equal(evaluation.excess, null);
});

test('a matured horizon with no available outcome stays pending — a data gap is not a flat window', async t => {
  const db = fixture(t);
  // The horizon has matured (CUTOFF is far past SESSIONS[0]) but the price source
  // has no outcome. The loop must not write a zero and must not claim an
  // evaluation: that is how a data outage becomes a negative finding.
  const result = await run(db, { prices: { outcome: () => null } });
  const session = result.sessions[0];
  assert.equal(session.evaluated, 0, 'no outcome means no evaluation');
  assert.equal(session.pending, 1, 'and it must remain pending rather than be recorded as zero');
  const { evaluateSealedDecision } = await import('../build/ashare/shadowSeal.js');
  const evaluation = evaluateSealedDecision(db, session.decision_id, { cutoff: CUTOFF });
  assert.equal(evaluation.matured, true, 'the horizon really did mature');
  assert.equal(evaluation.net_return, null, 'a mature horizon with no data is still absent, not zero');
});

test('a non-trading day and an unclosed session are different skips', async t => {
  const db = fixture(t);
  const saturday = '20240106'; // 2024-01-06 is a Saturday
  // SESSIONS[5] is a real trading day that lies after the evaluation cutoff
  // SESSIONS[1], so it has not closed yet — a different condition from Saturday.
  const result = await run(db, {
    asOfTradeDates: [SESSIONS[5], saturday],
    cutoff: SESSIONS[1],
  });
  const byDate = new Map(result.sessions.map(s => [s.as_of_trade_date, s]));
  assert.equal(byDate.get(SESSIONS[5]).skip_reason, 'session_not_closed',
    'a session after the evaluation cutoff has not closed yet');
  assert.equal(byDate.get(saturday).skip_reason, 'not_a_trading_day',
    'a Saturday is not a trading day, which is a calendar fact, not a stall');
  // Collapsing the two would hide a stall: "no decisions today" would look the
  // same whether the calendar said so or the pipeline simply had not caught up.
  assert.equal(result.totals.skipped_by_reason.session_not_closed, 1);
  assert.equal(result.totals.skipped_by_reason.not_a_trading_day, 1);
  assert.equal(result.totals.skipped, 2);
});

test('re-running the same day is idempotent — a restart must not duplicate or overwrite', async t => {
  const db = fixture(t);
  const first = await run(db);
  const second = await run(db);
  assert.equal(first.totals.sealed, 1);
  assert.equal(second.totals.sealed, 0, 'the second run must not seal again');
  assert.equal(second.totals.already_sealed, 1);
  assert.equal(first.sessions[0].decision_id, second.sessions[0].decision_id,
    'the decision ID must be a function of the day, not of the run');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n, 1,
    'one session, one row');
  // The evaluation is also idempotent, so a restart does not double-count it.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_evaluations').get().n, 1);
});

test('a dry run reports the decision ID it would write and writes nothing', async t => {
  const db = fixture(t);
  const plan = await run(db, { dryRun: true });
  assert.equal(plan.dry_run, true);
  assert.equal(plan.sessions[0].decision_id, `shadow-real-main-${SESSIONS[0]}`);
  assert.equal(plan.totals.sealed, 0, 'a dry run must not write');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_evaluations').get().n, 0);
  // And the ID it reports is the one a real run would use, so the plan is
  // checkable against what is already sealed before anything is written.
  const real = await run(db);
  assert.equal(real.sessions[0].decision_id, plan.sessions[0].decision_id);
});

test('a session with no candidates is skipped with a reason, not sealed empty', async t => {
  const db = fixture(t);
  const result = await run(db, { candidates: candidates([]) });
  assert.equal(result.sessions[0].skip_reason, 'no_candidates');
  assert.equal(result.totals.sealed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n, 0,
    'a decision with no candidate is not a decision');
});

test('an empty calendar produces no decisions and says why', async t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  db.exec(SHADOW_DECISION_SCHEMA);
  // No trade_cal at all: every session is unmatured and there is no cutoff to
  // evaluate against. The run must report that rather than invent one.
  //
  // This one is asked for WITHOUT the switch on, which is the stronger statement:
  // a disabled run must not even reach the calendar lookup.
  const result = await runDailyShadow({
    db, accountId: 'real-main', asOfTradeDates: ['20240102'], candidates: candidates(), prices: prices(),
    env: {},
  });
  assert.equal(result.totals.sealed, 0);
  assert.equal(result.totals.skipped, 1);
  assert.equal(result.sessions[0].skip_reason, 'disabled',
    'the switch is off, so the run stops before it ever asks about a calendar');

  // And with it on, the same empty calendar is reported as a missing cutoff
  // rather than as a refusal — a different reason, because it means something
  // different: there is nothing to evaluate against, not that we may not run.
  const enabled = await runDailyShadow({
    db, accountId: 'real-main', asOfTradeDates: ['20240102'], candidates: candidates(), prices: prices(),
    env: ENABLED,
  });
  assert.equal(enabled.totals.sealed, 0);
  assert.equal(enabled.totals.skipped, 1);
  assert.equal(enabled.sessions[0].skip_reason, 'no_price_cutoff');
});

test('a seal refusal names the session that caused it', async t => {
  const db = fixture(t);
  // A candidate source that makes the seal conflict: pre-seal the same decision
  // ID with different content, so the run's seal is refused.
  const { sealShadowDecision } = await import('../build/ashare/shadowSeal.js');
  sealShadowDecision(db, {
    decision_id: `shadow-real-main-${SESSIONS[0]}`, account_id: 'real-main',
    as_of_trade_date: SESSIONS[0], data_cutoff: SESSIONS[0], horizon_days: 20,
    candidate_id: 'OTHER', bundle_id: 'x', judgement: { action: 'BUY', rationale: 'already here' },
  });
  await assert.rejects(
    () => run(db),
    new RegExp(`shadow_seal_failed: ${SESSIONS[0]}`),
    'a refused seal must name the day, not just fail',
  );
});

test('every run carries the schema version and the account it ran for', async t => {
  const db = fixture(t);
  const result = await run(db);
  assert.equal(result.schema, SHADOW_ORCHESTRATION_VERSION);
  assert.equal(result.account_id, 'real-main');
  assert.equal(result.totals.requested, 1);
  assert.ok(result.ms >= 0, 'the run reports its own wall clock so a regression is visible');
});

test('exchangeDaysBetween counts strictly after the cutoff, and zero is a real answer', t => {
  const db = fixture(t);
  // Zero is meaningful: no session has closed since `from`. It must be returned as
  // zero rather than coerced into a maturity.
  assert.equal(exchangeDaysBetween(db, SESSIONS[0], SESSIONS[0]), 0);
  assert.equal(exchangeDaysBetween(db, SESSIONS[0], SESSIONS[1]), 1);
  assert.equal(exchangeDaysBetween(db, SESSIONS[0], CUTOFF), SESSIONS.length - 1);
  // And a cutoff before the range is zero, not a negative count.
  assert.equal(exchangeDaysBetween(db, CUTOFF, SESSIONS[0]), 0);
});

test('the maturity boundary is derived from the calendar, not assumed — one day short does not mature', async t => {
  const db = fixture(t);
  // h=20 matures at exactly 20 open sessions after the decision's own cutoff.
  // Counting from the fixture's calendar rather than assuming makes an off-by-one
  // in the arithmetic flip a verdict instead of shifting it by one quiet day.
  const calendar = db.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date>? ORDER BY cal_date',
  ).all(SESSIONS[0]).map(r => r.cal_date);
  assert.ok(calendar.length >= 21, 'the fixture must have enough forward sessions to test h=20');
  const atBoundary = calendar[19];
  const oneShort = calendar[18];

  const atMaturity = await runDailyShadow({
    db, accountId: 'real-main', asOfTradeDates: [SESSIONS[0]], candidates: candidates(),
    prices: prices(), cutoff: atBoundary, env: ENABLED,
  });
  assert.equal(atMaturity.sessions[0].evaluated, 1,
    'h=20 must evaluate at exactly the 20th open session after the decision date');
  assert.equal(atMaturity.sessions[0].pending, 0);

  // The same decision one open session earlier. Its horizon is 19 days from
  // oneShort, so it must NOT mature — this is what kills an off-by-one that
  // counts the cutoff day itself, because that mutant would report 20 here.
  const short = await runDailyShadow({
    db, accountId: 'real-main', asOfTradeDates: [SESSIONS[0]], candidates: candidates(),
    prices: prices(), cutoff: oneShort, env: ENABLED,
  });
  assert.equal(short.sessions[0].evaluated, 0, 'h=20 must NOT evaluate one open session early');
  assert.equal(short.sessions[0].pending, 1);
  assert.equal(short.totals.evaluated, 0);
  const { evaluateSealedDecision } = await import('../build/ashare/shadowSeal.js');
  const evaluation = evaluateSealedDecision(db, short.sessions[0].decision_id, { cutoff: oneShort });
  assert.equal(evaluation.matured, false);
  assert.equal(evaluation.net_return, null, 'an immature horizon is absent, never a 0% return');
});

test('a closed calendar day (is_open=0) is not a trading day — a holiday is not a stall', async t => {
  const db = fixture(t);
  // The fixture only ever seeds is_open=1 rows, so every untested date is simply
  // ABSENT from trade_cal. A real production calendar also carries is_open=0 rows
  // for holidays, and `sessionState` must treat those as closed rather than
  // unknown. This is the case the fixture cannot express, so it is seeded here.
  const holiday = '20240101'; // inside HISTORY, never a session the run asks for
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date,is_open,pretrade_date) VALUES (?,0,NULL)').run(holiday);
  const state = sessionState(db, holiday, CUTOFF);
  assert.equal(state.is_trading_day, false,
    'a day the calendar marks closed must not be treated as a trading day');
  // And it must be distinguishable from an absent date: a holiday is a known
  // non-trading day, whereas a date outside the calendar is unknown.
  const absent = sessionState(db, '20991231', CUTOFF);
  assert.equal(absent.is_trading_day, false, 'an unknown date is also not a trading day');

  const result = await run(db, { asOfTradeDates: [holiday] });
  assert.equal(result.sessions[0].skip_reason, 'not_a_trading_day');
  assert.equal(result.totals.sealed, 0, 'a holiday must not produce a decision');
});

test('sessionState separates "not a trading day" from "not closed yet"', t => {
  const db = fixture(t);
  const trading = sessionState(db, SESSIONS[0], CUTOFF);
  assert.equal(trading.is_trading_day, true);
  assert.equal(trading.closed, true);
  const future = sessionState(db, SESSIONS[0], HISTORY.at(-1));
  assert.equal(future.is_trading_day, true);
  assert.equal(future.closed, false, 'a session after the cutoff has not closed');
  const saturday = sessionState(db, '20240106', CUTOFF);
  assert.equal(saturday.is_trading_day, false);
});

/** Bounded runtime.
 *
 * This module long reported `ms` on every session and the run itself while
 * nothing ever compared those numbers to a limit. The spec asks for bounded
 * runtime as a property, and a duration nobody checks is instrumentation.
 * These tests assert the enforcement.
 *
 * The timing is injected, not slept on. A first version asserted that a 0 ms
 * budget means no candidate lookups, and it failed at 2 of 20 on roughly one
 * run in three: `Date.now()` has millisecond resolution and the work before
 * the first check is sub-millisecond, so "elapsed > 0" was false whenever both
 * reads landed in the same millisecond. An intermittently-passing assertion
 * is worse than a failing one, because it reads as a real bound. Advancing a
 * clock the run itself reads makes the assertion exact.
 */
const steppingClock = (steps = []) => {
  let now = 1_000_000;
  let i = 0;
  return () => {
    const value = now;
    now += steps[i] ?? 0;
    i += 1;
    return value;
  };
};

test('an over-budget run skips the remaining sessions and never hides the truncation', async t => {
  const db = fixture(t);
  const asked = SESSIONS.slice(0, 4);
  // The clock advances 1 ms on every read, so by the third session's check the
  // 2 ms budget is definitively spent. Sessions 0 and 1 are allowed to run:
  // the guard is a ceiling on the run, not a cap on how many sessions it may
  // attempt, and a budget that stops the very first session would make the
  // guard indistinguishable from "disabled".
  const result = await run(db, {
    asOfTradeDates: asked,
    runtimeBudgetMs: 2,
    clock: steppingClock(Array(96).fill(1)),
  });

  assert.equal(result.runtime.exhausted, true, 'a truncated run must be visible as truncated');
  assert.equal(result.runtime.budget_ms, 2);
  assert.equal(result.sessions.length, asked.length,
    'every requested session must still be reported — a short list would hide the truncation');
  const budgetLimited = result.sessions.filter(s => s.skip_reason === 'runtime_budget_exceeded');
  assert.ok(budgetLimited.length >= 1, 'at least one session must have been stopped by the budget');
  assert.ok(budgetLimited.length < asked.length,
    'the guard must not stop every session, or it is just the disabled switch');
  for (const session of budgetLimited) {
    assert.equal(session.created, false);
    assert.equal(session.decision_id, null);
  }
  assert.equal(result.totals.skipped_by_reason.runtime_budget_exceeded, budgetLimited.length);
  assert.equal(result.totals.sealed, asked.length - budgetLimited.length);
});

test('the session that spends the budget is not the one reported as budget-limited', async t => {
  const db = fixture(t);
  // The first candidate lookup advances the clock by 60 ms against a 30 ms
  // budget. The check runs BEFORE each session's work, so session 1 starts,
  // completes and seals — it is the NEXT session that is skipped. If the check
  // ran after the work instead, session 1 would be recorded as budget-limited,
  // blaming the session for a run that was already over before it began.
  const clock = steppingClock([0, 0, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
  const asked = SESSIONS.slice(0, 3);
  const result = await run(db, { asOfTradeDates: asked, runtimeBudgetMs: 30, clock });

  assert.equal(result.sessions[0].skip_reason, null,
    'the session that spent the budget ran to completion and is not blamed for it');
  assert.equal(result.sessions[0].created, true);
  assert.equal(result.totals.sealed, 1);
  assert.equal(result.sessions[1].skip_reason, 'runtime_budget_exceeded');
  assert.equal(result.sessions[2].skip_reason, 'runtime_budget_exceeded');
  assert.equal(result.runtime.exhausted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n, 1,
    'exactly one decision — the sessions after the budget was spent wrote nothing');
});

test('a run that fits its budget reports it without claiming exhaustion', async t => {
  const db = fixture(t);
  const result = await run(db, { asOfTradeDates: SESSIONS.slice(0, 2) });
  assert.equal(result.runtime.exhausted, false);
  assert.equal(result.runtime.budget_ms, DEFAULT_SHADOW_RUNTIME_BUDGET_MS,
    'the default budget is reported so a caller can see what the run ran under');
  assert.ok(result.runtime.ms >= 0);
  assert.equal(result.totals.skipped_by_reason.runtime_budget_exceeded ?? 0, 0,
    'the reason must be absent, not zero-and-implied');
});

test('a disabled run does not claim a spent budget', async t => {
  const db = fixture(t);
  const disabled = await run(db, { env: {}, asOfTradeDates: SESSIONS.slice(0, 2) });
  assert.equal(disabled.runtime.exhausted, false,
    'a disabled run never started, so it cannot have run out of time');
  assert.equal(disabled.totals.skipped_by_reason.disabled, 2);
});

/** Bounded resource use (heap).
 *
 * The runtime budget above stops a run that has gone wrong on the time axis.
 * This one stops a run that has gone wrong on the memory axis: a caller whose
 * `candidates()` or `prices.outcome()` accumulates state across sessions.
 *
 * The heap reading is injected, not measured, for the same reason the clock is:
 * a real heap cannot be driven over a small budget deterministically, and a
 * test that depends on the runner's actual allocation behavior is a flake, not
 * a bound.
 */

/** Returns `start`, then advances by `step` on every read after the first. */
const growingHeap = (start, step) => {
  let current = start;
  let first = true;
  return () => {
    if (first) { first = false; return current; }
    current += step;
    return current;
  };
};

test('an over-heap-budget run skips the remaining sessions and names memory, not time', async t => {
  const db = fixture(t);
  const asked = SESSIONS.slice(0, 4);
  // The heap check reads once per session BEFORE its work: session 0 sees the
  // first read (0), session 1 sees 3, session 2 sees 6 (over a 4 byte budget),
  // session 3 sees 9. Sessions 0-1 run; 2-3 are skipped as heap-limited.
  const result = await run(db, {
    asOfTradeDates: asked,
    heapBudgetBytes: 4,
    heapUsage: growingHeap(0, 3),
  });

  assert.equal(result.heap.exhausted, true, 'a memory-truncated run must be visible as truncated');
  assert.equal(result.heap.budget_bytes, 4);
  assert.equal(result.sessions.length, asked.length,
    'every requested session must still be reported — a short list would hide the truncation');
  const heapLimited = result.sessions.filter(s => s.skip_reason === 'heap_budget_exceeded');
  assert.ok(heapLimited.length >= 1, 'at least one session must have been stopped by the heap budget');
  assert.ok(heapLimited.length < asked.length,
    'the guard must not stop every session, or it is just the disabled switch');
  for (const session of heapLimited) {
    assert.equal(session.created, false);
    assert.equal(session.decision_id, null);
  }
  assert.equal(result.totals.skipped_by_reason.heap_budget_exceeded, heapLimited.length);
  assert.equal(result.totals.skipped_by_reason.runtime_budget_exceeded, undefined,
    'the reason must be memory, not time — collapsing them hides which axis failed');
  assert.equal(result.runtime.exhausted, false, 'the time budget was not the one spent');
});

test('the session that blows the heap budget is not the one reported as heap-limited', async t => {
  const db = fixture(t);
  // The heap starts at 0 and grows 6 bytes per read after the first, against a
  // 5 byte budget. The check runs BEFORE each session's work, so session 0's
  // check sees 0 (fits), session 1's check sees 6 (does not). Session 0 runs
  // to completion and is not blamed; sessions 1+ are skipped. If the check ran
  // after the work instead, the session whose completion grew the heap would
  // be recorded as heap-limited, blaming it for a run that was already over.
  const asked = SESSIONS.slice(0, 3);
  const result = await run(db, {
    asOfTradeDates: asked,
    heapBudgetBytes: 5,
    heapUsage: growingHeap(0, 6),
  });

  assert.equal(result.sessions[0].skip_reason, null,
    'the session that ran under the budget completed and is not blamed for the truncation');
  assert.equal(result.sessions[0].created, true);
  assert.equal(result.totals.sealed, 1);
  assert.equal(result.sessions[1].skip_reason, 'heap_budget_exceeded');
  assert.equal(result.sessions[2].skip_reason, 'heap_budget_exceeded');
  assert.equal(result.heap.exhausted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n, 1,
    'exactly one decision — the sessions after the budget was spent wrote nothing');
});

test('a run that fits its heap budget reports it without claiming exhaustion', async t => {
  const db = fixture(t);
  const result = await run(db, {
    asOfTradeDates: SESSIONS.slice(0, 2),
    heapBudgetBytes: DEFAULT_SHADOW_HEAP_BUDGET_BYTES,
    heapUsage: () => 1024,
  });
  assert.equal(result.heap.exhausted, false);
  assert.equal(result.heap.budget_bytes, DEFAULT_SHADOW_HEAP_BUDGET_BYTES,
    'the default budget is reported so a caller can see what the run ran under');
  assert.equal(result.heap.used_bytes, 1024);
  assert.equal(result.totals.skipped_by_reason.heap_budget_exceeded, undefined,
    'the reason must be absent, not zero-and-implied');
});

test('a disabled run does not claim a spent heap budget', async t => {
  const db = fixture(t);
  const disabled = await run(db, {
    env: {},
    asOfTradeDates: SESSIONS.slice(0, 2),
    heapUsage: () => DEFAULT_SHADOW_HEAP_BUDGET_BYTES * 2,
  });
  assert.equal(disabled.heap.exhausted, false,
    'a disabled run never started, so it cannot have exhausted a heap budget');
  assert.equal(disabled.totals.skipped_by_reason.disabled, 2);
  assert.equal(disabled.totals.skipped_by_reason.heap_budget_exceeded, undefined);
});
