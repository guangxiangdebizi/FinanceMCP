import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runResearchCadence, cadenceEnabled, DEFAULT_MIN_SESSIONS, RESEARCH_CADENCE_VERSION,
} from '../build/ashare/researchCadence.js';

/** Phase 6 — the weekly/monthly research cadence entry.
 *
 * The substance of both cadences already exists: `researchDiagnosis.ts` produces
 * the weekly claims, `forwardReview.ts` produces the monthly verdict. What this
 * file tests is the *entry* around them, and specifically the four ways a
 * cadence entry goes wrong in production:
 *
 * 1. **It produces a report from nothing.** Three sessions of data, an empty
 *    candidate set, or an unavailable calendar must not become "0 findings" —
 *    that is a negative result manufactured from an outage.
 * 2. **Its switch is decorative.** The daily loop had exactly this defect: a
 *    documented, unit-tested disabled-by-default switch that the entry never
 *    consulted. Here the switch is asserted at the entry, not on the predicate.
 * 3. **Its dry run writes.** A dry run that persists has stopped being a dry run,
 *    and the person who ran it believes nothing happened.
 * 4. **A failure is silent.** A producer that cannot answer must produce a skip
 *    reason a human can act on, not a null in a JSON field.
 *
 * The producers are injected, which is what makes these testable without a
 * market database — and, more importantly, without a *real* diagnosis that
 * happens to work on the fixture and would mask a broken entry.
 */

const ON = { RESEARCH_CADENCE_ENABLED: '1' };
const REPORT = { schema: 'diagnosis-1.0.0', verdict: 'NO_MECHANISM', claims: [] };

/** A producer set that succeeds. Overridden per test. */
const producers = (over = {}) => ({
  closedSessions: () => 30,
  hasCandidates: () => true,
  produce: () => ({ report: REPORT }),
  write: () => {},
  ...over,
});

const run = (cadence, over = {}, prod = producers()) => runResearchCadence(cadence, {
  accountId: 'real-main',
  asOf: '20240228',
  env: ON,
  ...over,
}, prod);

test('the floors are the ones the cadence names, not an invented number', () => {
  // A week is five sessions and a month is twenty. A floor that silently became
  // "whatever the caller passed" would make every cadence report unverifiable.
  assert.equal(DEFAULT_MIN_SESSIONS.weekly, 5);
  assert.equal(DEFAULT_MIN_SESSIONS.monthly, 20);
});

test('a caller may raise the floor but never lower it', async () => {
  // The floor exists to stop a report being produced from too little evidence.
  // If `minSessions` could lower it, a monthly cadence could be handed five
  // sessions and produce a report with a month's authority on a week's data.
  const lowered = await run('monthly', { minSessions: 5 }, producers({ closedSessions: () => 6 }));
  assert.equal(lowered.skip_reason, 'not_enough_history',
    'an override below the cadence floor must be ignored, not honoured');
  assert.equal(lowered.produced, false);

  // Raising it still works: a caller who wants more evidence can ask for more.
  const raised = await run('weekly', { minSessions: 30 }, producers({ closedSessions: () => 10 }));
  assert.equal(raised.skip_reason, 'not_enough_history', 'a raised floor must be honoured');
  const satisfied = await run('weekly', { minSessions: 30 }, producers({ closedSessions: () => 30 }));
  assert.equal(satisfied.produced, true);
});

test('disabled is the default, and the entry enforces it rather than trusting the caller', async () => {
  const result = await run('weekly', { env: {} });
  assert.equal(cadenceEnabled({}), false, 'unset must be disabled');
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'disabled');
  assert.equal(result.report, null, 'a disabled run must not carry a report');

  // The producers must not even be consulted. If they were, a disabled run would
  // still have done the work it was about to refuse.
  let consulted = 0;
  const counting = producers({
    closedSessions: () => { consulted += 1; return 30; },
    hasCandidates: () => { consulted += 1; return true; },
    produce: () => { consulted += 1; return { report: REPORT }; },
  });
  await run('weekly', { env: {} }, counting);
  assert.equal(consulted, 0, 'a disabled run must not touch the producers');

  // And the explicit opt-in works, so the switch is a switch and not a wall.
  const enabled = await run('weekly', {}, producers());
  assert.equal(enabled.produced, true);
});

test('the switch is re-read on every call, so a long-lived process can be turned off', async () => {
  const off = await run('weekly', { env: {} });
  assert.equal(off.skip_reason, 'disabled');
  const on = await run('weekly');
  assert.equal(on.produced, true);
  const offAgain = await run('weekly', { env: { RESEARCH_CADENCE_ENABLED: '0' } });
  assert.equal(offAgain.skip_reason, 'disabled', 'turning it off must take effect without a restart');
});

test('three sessions of history is not a weekly report', async () => {
  // The tempting shortcut is to produce whatever the diagnosis returns. A weekly
  // report computed on three days of data is noise wearing a schema, and it
  // would be indistinguishable downstream from a real one.
  const result = await run('weekly', {}, producers({ closedSessions: () => 3 }));
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'not_enough_history');
  assert.equal(result.report, null, 'no report may be produced below the floor');

  // Exactly at the floor is enough: the boundary must be inclusive, or the
  // cadence would skip a day it should have run on.
  const atFloor = await run('weekly', {}, producers({ closedSessions: () => 5 }));
  assert.equal(atFloor.produced, true, 'exactly five sessions satisfies the weekly floor');
});

test('an unavailable calendar is a different failure from a short one', async () => {
  // null means "I could not tell", 3 means "there were three". Collapsing them
  // would report a data outage as a quiet "not enough history yet".
  const result = await run('weekly', {}, producers({ closedSessions: () => null }));
  assert.equal(result.skip_reason, 'diagnosis_unavailable');
  assert.notEqual(result.skip_reason, 'not_enough_history');
});

test('no candidates is a skip with a reason, not an empty report', async () => {
  const result = await run('monthly', {}, producers({ hasCandidates: () => false }));
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'no_candidates');
  assert.equal(result.report, null);
});

test('a producer that cannot answer propagates its own reason', async () => {
  // The producer is the only thing that knows why it could not produce. This
  // entry must not invent a reason of its own, and must not swallow it.
  const result = await run('monthly', {}, producers({
    produce: () => ({ skip: 'review_unavailable', detail: 'no matured forward window' }),
  }));
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'review_unavailable');
  // The explanation is asserted, not just the enum. A mutation that dropped
  // `detail` while keeping the reason left this test green, which is how the
  // gap was found: the enum survived and the operator-facing words did not.
  assert.equal(result.detail, 'no matured forward window',
    'the producer\'s explanation must survive propagation unchanged');
  assert.equal(result.report, null);
});

test('a dry run reports the report it would write and writes nothing', async () => {
  let writes = 0;
  const result = await run('monthly', { dryRun: true }, producers({ write: () => { writes += 1; } }));
  assert.equal(result.dry_run, true);
  assert.equal(writes, 0, 'a dry run must not persist');
  // It still carries the report, so the plan can be checked against what already
  // exists before anything is written.
  assert.deepEqual(result.report, REPORT);
  assert.equal(result.produced, false, 'a dry run did not produce a stored record');

  const real = await run('monthly', {}, producers({ write: () => { writes += 1; } }));
  assert.equal(writes, 1, 'and the same run without dryRun does write');
  assert.equal(real.produced, true);
});

test('every record carries the schema, the account and the as-of it speaks for', async () => {
  const result = await run('weekly');
  assert.equal(result.schema, RESEARCH_CADENCE_VERSION);
  assert.equal(result.account_id, 'real-main');
  assert.equal(result.as_of, '20240228');
  assert.equal(result.cadence, 'weekly');
  assert.equal(typeof result.ms, 'number');
  assert.ok(result.ms >= 0, 'the run reports its own wall clock');
});

test('a skipped run still carries the schema and the account', async () => {
  // A skip is a record too. One that lost its identity fields could not be
  // attributed later, and "why did nothing happen on the 14th" would be
  // unanswerable.
  const result = await run('weekly', { env: {} });
  assert.equal(result.schema, RESEARCH_CADENCE_VERSION);
  assert.equal(result.account_id, 'real-main');
  assert.equal(result.as_of, '20240228');
  assert.equal(result.cadence, 'weekly');
});

test('the two cadences are distinct records, not one report relabelled', async () => {
  const weekly = await run('weekly');
  const monthly = await run('monthly');
  assert.equal(weekly.cadence, 'weekly');
  assert.equal(monthly.cadence, 'monthly');
  // And they do not share a floor: a monthly report computed on five sessions
  // would be a week of data with a month's authority.
  const shortMonth = await run('monthly', {}, producers({ closedSessions: () => 6 }));
  assert.equal(shortMonth.skip_reason, 'not_enough_history',
    'six sessions is a week, not a month');
});

test('a producer that throws is not swallowed into a success', async () => {
  // The failure must reach the caller. An entry that caught it and returned
  // "produced: false" with no reason would be indistinguishable from a skip the
  // operator had already accounted for.
  const throwing = producers({ produce: () => { throw new Error('diagnosis_db_locked'); } });
  await assert.rejects(
    () => run('weekly', {}, throwing),
    /diagnosis_db_locked/,
    'a producer failure must propagate rather than become a quiet skip',
  );
});

test('a producer that knows it cannot run says so before the generic checks', async () => {
  // This hook exists because of a real defect the producers exposed. A producer
  // whose database is absent can only decline from inside `produce`, which runs
  // *after* `hasCandidates` has already answered "no" — so the operator saw
  // `no_candidates`, an outage wearing the costume of a quiet week. The
  // producer's own reason must be asked for first.
  const unavailable = producers({
    closedSessions: () => 30,
    hasCandidates: () => false,
    unavailable: () => ({ skip: 'review_unavailable', detail: '账户库不存在：/var/lib/portfolio.sqlite' }),
  });
  const result = await run('monthly', {}, unavailable);
  assert.equal(result.skip_reason, 'review_unavailable',
    'the producer\'s own reason must pre-empt the generic no-candidates answer');
  assert.equal(result.detail, '账户库不存在：/var/lib/portfolio.sqlite',
    'and the producer\'s explanation must survive the propagation');
});

test('a producer with nothing to declare about availability is not second-guessed', async () => {
  // The hook is optional. A producer that does not implement it must fall
  // through to the generic checks unchanged, or adding the hook would silently
  // change the meaning of every existing producer.
  const none = producers({ hasCandidates: () => false });
  const result = await run('weekly', {}, none);
  assert.equal(result.skip_reason, 'no_candidates', 'an undeclared producer still gets the generic answer');
});

test('a produced record reports where it was written', async () => {
  // An entry that persisted a report without saying where would leave the
  // operator asking "did that actually save" — the one question a cadence
  // report has to answer for itself.
  const written = await run('monthly', {}, producers({ write: () => '/var/lib/forward-reviews/20240228-FR-abc.json' }));
  assert.equal(written.produced, true);
  assert.equal(written.written_to, '/var/lib/forward-reviews/20240228-FR-abc.json');

  // A producer that returns nothing from write still produces a record; the
  // path is simply unknown rather than invented.
  const noPath = await run('monthly', {}, producers({ write: () => undefined }));
  assert.equal(noPath.produced, true);
  assert.equal(noPath.written_to, null, 'an unknown path is null, not a guess');

  // And a dry run or a skip never claims a path it did not take.
  const dry = await run('monthly', { dryRun: true }, producers({ write: () => '/should/not/happen.json' }));
  assert.equal(dry.written_to, null, 'a dry run reports no path');
  const skipped = await run('monthly', { env: {} });
  assert.equal(skipped.written_to, null, 'a skip reports no path');
});
