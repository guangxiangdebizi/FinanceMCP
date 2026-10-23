import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb } from '../build/ashare/db.js';
import { weekdays, seedReferenceUniverse } from './ashare-fixture.mjs';
import {
  sealShadowDecision, readShadowDecision, evaluateSealedDecision,
  appendShadowEvaluation, SHADOW_DECISION_SCHEMA,
} from '../build/ashare/shadowSeal.js';

/** Phase 6 — the sealing invariant for daily shadow decisions.
 *
 * The task spec's acceptance criterion for Phase 6 is that a decision must be
 * sealed "before the subsequent price/execution outcome is observable". That
 * sentence is easy to nod along to and hard to enforce, because nothing in a
 * filesystem or a database naturally prevents it: a process that computes a
 * decision at 21:00 and writes it at 23:00 produces the same row, with the same
 * fields, as one that computed and wrote it at 21:00. The row cannot tell you
 * when the computation happened.
 *
 * So the invariant has to be carried explicitly, and the tests below are built
 * around the four ways it can be violated:
 *
 * 1. A decision sealed for date D must not be able to cite data from after D.
 *    This is the one that catches a "recompute in hindsight" run: if the seal
 *    records which cutoff it used, a decision that quietly used a later cutoff
 *    is detectable rather than invisible.
 * 2. Re-sealing the same decision must be idempotent — a restart must not
 *    produce a duplicate event (the spec asks for this explicitly).
 * 3. Re-sealing with DIFFERENT content must be refused. Idempotency that
 *    silently overwrites is worse than no idempotency: it lets a later, better
 *    informed decision replace an earlier honest one while keeping the same ID.
 * 4. A decision whose horizon has not matured must be absent, never zero.
 *
 * Each of these failed on the code as I first wrote it.
 */

/** A fixture with a clean signal date and enough forward days to mature h=20. */
const HISTORY = weekdays('20240102', 140);
const AS_OF = HISTORY.at(-1);
const FORWARD = weekdays(AS_OF, 40).slice(1);

function fixture(t) {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  // The exchange calendar has to exist for the maturity arithmetic to mean
  // anything: `hasMatured` counts open days between the cutoff and the horizon,
  // and without `trade_cal` every horizon is trivially unmatured — which would
  // make the "absent, never zero" assertions pass for the wrong reason.
  //
  // Two stocks, not 1100. Sealing is a property of dates and hashes, not of the
  // universe; the 1100-stock fixture costs ~4s per test here and buys nothing.
  seedReferenceUniverse(db, [...HISTORY, ...FORWARD], { stocks: 2 });
  db.exec(SHADOW_DECISION_SCHEMA);
  return db;
}

const decision = (over = {}) => ({
  decision_id: 'shadow-20240101-0001',
  account_id: 'real-main',
  as_of_trade_date: AS_OF,
  horizon_days: 20,
  /** The cutoff the decision was computed against. */
  data_cutoff: AS_OF,
  candidate_id: 'S4C_R2',
  bundle_id: 'bundle-test',
  judgement: { action: 'HOLD', rationale: 'no evidence of improvement' },
  ...over,
});

test('a sealed decision records the cutoff it was computed against, so a later recompute is detectable', t => {
  const db = fixture(t);
  const { decision: d } = sealShadowDecision(db, decision());
  assert.equal(d.data_cutoff, AS_OF, 'the seal must carry its own cutoff');
  assert.equal(d.as_of_trade_date, AS_OF);
  assert.ok(d.content_hash.length === 64, 'a seal without a hash cannot be checked');
  assert.ok(d.sealed_at, 'a seal without a timestamp cannot be ordered against outcomes');

  // The invariant that makes "sealed before the outcome was observable"
  // checkable rather than merely asserted: the cutoff may never be later than
  // the trade date the decision claims to speak for.
  assert.ok(d.data_cutoff <= d.as_of_trade_date,
    'a decision dated D that used data from after D is not a decision made on D');
});

test('a decision cannot be sealed with a cutoff after the date it speaks for', t => {
  const db = fixture(t);
  // This is the shape of the "recompute in hindsight" run: the row still says
  // as_of_trade_date = AS_OF, but the numbers were produced with a later cutoff.
  assert.throws(
    () => sealShadowDecision(db, decision({ data_cutoff: FORWARD[5] })),
    /cutoff/i,
    'sealing a decision whose data postdates its own as-of date must be refused, not recorded',
  );
  assert.equal(readCount(db), 0, 'a refused seal must leave no row behind');
});

test('re-sealing the identical decision is idempotent — a restart must not duplicate it', t => {
  const db = fixture(t);
  const first = sealShadowDecision(db, decision());
  const second = sealShadowDecision(db, decision());
  assert.equal(second.created, false, 'the same decision must not be inserted twice');
  assert.equal(second.decision.content_hash, first.decision.content_hash);
  assert.equal(readCount(db), 1, 'idempotency must be one row, not two');
});

test('re-sealing with DIFFERENT content is refused — idempotency must not become an overwrite', t => {
  const db = fixture(t);
  sealShadowDecision(db, decision());
  // Same ID, better-informed judgement. If this were allowed, a process that
  // recomputed after seeing the outcome would silently replace the honest
  // earlier decision while keeping its ID — the record would look like it had
  // always known.
  assert.throws(
    () => sealShadowDecision(db, decision({ judgement: { action: 'BUY', rationale: 'it went up' } })),
    /conflict|immutable|differ/i,
    'a different decision under the same ID must be refused',
  );
  const kept = readDecision(db, 'shadow-20240101-0001');
  assert.equal(kept.judgement.action, 'HOLD', 'the originally sealed judgement must survive');
});

test('re-sealing with a LATER but still-legal cutoff is refused — the cutoff is part of the identity', t => {
  const db = fixture(t);
  sealShadowDecision(db, decision());
  // The attack this closes: the judgement is identical, the ID is identical, the
  // as-of date is identical — only the cutoff moved forward. A hash that omits
  // the cutoff accepts this silently, and the record then claims a decision made
  // on AS_OF while carrying numbers computed with later data. Nothing else in
  // the row distinguishes it from the honest version.
  assert.throws(
    () => sealShadowDecision(db, decision({ data_cutoff: FORWARD[5] })),
    /conflict|immutable|differ|cutoff/i,
    'the same decision sealed against a later cutoff is a different decision and must be refused',
  );
  const kept = readDecision(db, 'shadow-20240101-0001');
  assert.equal(kept.data_cutoff, AS_OF, 'the originally sealed cutoff must survive');
});

test('the cutoff is part of the content hash — two seals differing only in cutoff hash differently', t => {
  const db = fixture(t);
  const a = sealShadowDecision(db, decision({ decision_id: 'a' })).decision;
  const b = sealShadowDecision(db, decision({ decision_id: 'b', data_cutoff: HISTORY[100] })).decision;
  assert.notEqual(a.content_hash, b.content_hash,
    'a hash that ignores the cutoff cannot tell an honest seal from a hindsight one');
  // And the honest one must not be reusable under the other's identity.
  assert.throws(
    () => sealShadowDecision(db, decision({ decision_id: 'a', data_cutoff: HISTORY[100] })),
    /conflict|immutable|differ|cutoff/i,
  );
});

test('maturity is measured in exchange days, and one day short is not mature', t => {
  const db = fixture(t);
  sealShadowDecision(db, decision());
  // Count the exchange days after the signal date from the fixture's own
  // calendar, so the boundary is derived rather than assumed.
  const calendar = db.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date>? ORDER BY cal_date',
  ).all(AS_OF).map(r => r.cal_date);
  assert.ok(calendar.length >= 21, 'the fixture must have enough forward days to test h=20');
  // Exactly 20 exchange days after the signal date matures h=20.
  const atBoundary = evaluateSealedDecision(db, 'shadow-20240101-0001', { cutoff: calendar[19] });
  assert.equal(atBoundary.matured, true, 'h=20 must mature at exactly 20 exchange days after the signal date');
  // 19 does not. This is what makes an off-by-one in the maturity arithmetic
  // visible: the verdict flips, rather than shifting by one quiet day.
  const oneShort = evaluateSealedDecision(db, 'shadow-20240101-0001', { cutoff: calendar[18] });
  assert.equal(oneShort.matured, false, 'h=20 must NOT mature one exchange day early');
  assert.equal(oneShort.net_return, null);
  assert.equal(oneShort.excess, null);
});

test('appending an evaluation writes a separate row and leaves the sealed decision untouched', t => {
  const db = fixture(t);
  const { decision: sealed } = sealShadowDecision(db, decision());
  const judgementBefore = sealed.judgement_json;
  const hashBefore = sealed.content_hash;
  // Append an outcome directly through the append path.
  appendShadowEvaluation(db, sealed.decision_id, {
    cutoff: FORWARD.at(-1), matured: true, net_return: 0.0123, excess: -0.0456,
  });
  const after = readDecision(db, sealed.decision_id);
  assert.equal(after.judgement_json, judgementBefore,
    'an evaluation is a separate fact; it must not edit the decision it evaluates');
  assert.equal(after.content_hash, hashBefore, 'the sealed hash must not move');
  const evalCount = db.prepare('SELECT COUNT(*) AS n FROM shadow_evaluations').get().n;
  assert.equal(evalCount, 1, 'the evaluation must be its own row');
  // And re-appending the same outcome is idempotent, so a restart does not double it.
  appendShadowEvaluation(db, sealed.decision_id, {
    cutoff: FORWARD.at(-1), matured: true, net_return: 0.0123, excess: -0.0456,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_evaluations').get().n, 1,
    'a repeated evaluation of the same cutoff must not duplicate');
});

test('appending a DIFFERENT outcome for the same cutoff is refused', t => {
  const db = fixture(t);
  const { decision: sealed } = sealShadowDecision(db, decision());
  appendShadowEvaluation(db, sealed.decision_id, {
    cutoff: FORWARD.at(-1), matured: true, net_return: 0.0123, excess: -0.0456,
  });
  assert.throws(
    () => appendShadowEvaluation(db, sealed.decision_id, {
      cutoff: FORWARD.at(-1), matured: true, net_return: 0.9999, excess: 0.5,
    }),
    /conflict/i,
    'the same cutoff cannot carry two different outcomes',
  );
});

test('a decision whose horizon has not matured is absent, never zero', t => {
  const db = fixture(t);
  sealShadowDecision(db, decision());
  // h=20 needs 20 exchange days after the signal date. FORWARD[19] is the 20th,
  // so it MATURES — the honest "not yet" cutoff is one earlier.
  const justShort = evaluateSealedDecision(db, 'shadow-20240101-0001', { cutoff: FORWARD[18] });
  assert.equal(justShort.matured, false);
  assert.equal(justShort.net_return, null, 'an unmatured horizon must be null, not 0');
  assert.equal(justShort.excess, null);
  assert.notEqual(justShort.excess, 0, 'rendering absent as zero would invent a flat forward window');

  // And the cutoff that DOES mature it must report matured, so the null above is
  // a real absence rather than a horizon that can never mature.
  const matured = evaluateSealedDecision(db, 'shadow-20240101-0001', { cutoff: FORWARD[19] });
  assert.equal(matured.matured, true, 'h=20 must mature at the 20th exchange day after the signal date');
});

test('evaluating a decision that was never sealed must not invent one', t => {
  const db = fixture(t);
  assert.equal(evaluateSealedDecision(db, 'never-sealed', { cutoff: FORWARD.at(-1) }), null,
    'there is nothing to evaluate, and inventing a record would be the worst answer');
});

test('late data must not be able to reach back into an already-sealed decision', t => {
  const db = fixture(t);
  const { decision: sealed } = sealShadowDecision(db, decision());
  // Simulate the outcome arriving and being appended. The sealed row must be
  // byte-identical afterwards: an evaluation is a separate fact, not an edit.
  const evaluation = evaluateSealedDecision(db, sealed.decision_id, { cutoff: FORWARD.at(-1) });
  assert.ok(evaluation, 'the fixture must be long enough to mature h=20 for this to mean anything');
  const after = readDecision(db, sealed.decision_id);
  assert.equal(after.content_hash, sealed.content_hash,
    'appending an evaluation must not change the sealed decision it evaluates');
  assert.equal(after.judgement.action, 'HOLD');
});

test('a cutoff EARLIER than the trade date is legal — the guard rejects only hindsight, not lag', t => {
  const db = fixture(t);
  // The cutoff guard is `cutoff > as_of`, not `cutoff !== as_of`. A decision
  // made on AS_OF using data only through the previous close is the normal case,
  // and a guard that rejected it would be worse than no guard: it would force
  // every seal to claim it saw same-day data it did not have.
  const { created, decision: lagging } = sealShadowDecision(db, decision({ data_cutoff: HISTORY.at(-2) }));
  assert.equal(created, true, 'a lagging cutoff is the honest case and must be accepted');
  assert.equal(lagging.data_cutoff, HISTORY.at(-2));
  // And it still matures on the horizon counted from the cutoff it declared.
  const notYet = evaluateSealedDecision(db, lagging.decision_id, { cutoff: lagging.data_cutoff });
  assert.equal(notYet.matured, false, 'a horizon cannot mature at its own cutoff');
});

function readCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM shadow_decisions').get().n;
}
// Read through the public accessor, not the raw row: the stored column is
// `judgement_json`, and reaching into it here would assert against the storage
// format rather than against the decision the module actually returns.
function readDecision(db, id) {
  return readShadowDecision(db, id);
}
