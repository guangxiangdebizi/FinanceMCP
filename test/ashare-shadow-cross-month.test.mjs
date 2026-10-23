import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb } from '../build/ashare/db.js';
import { weekdays, seedReferenceUniverse } from './ashare-fixture.mjs';
import { SHADOW_DECISION_SCHEMA } from '../build/ashare/shadowSeal.js';
import { runDailyShadow, sessionState, shadowEnabled } from '../build/ashare/shadowRun.js';

/** Phase 6 acceptance — the cross-month, multi-session run.
 *
 * `ashare-shadow-run.test.mjs` proves one session behaves. The task spec's
 * acceptance for Phase 6 is stronger than that, and deliberately so:
 *
 *   "在模拟多个交易日及跨月的时间序列中，证明：
 *     决策在结果之前封存。
 *     重启不会产生重复事件。
 *     迟到的数据不会生成伪前瞻记录。
 *     缺数据不会触发错误评价。
 *     研究任务失败不影响市场生产日报。
 *     旧记录可以复核，不能静默更新。"
 *
 * Five of those six are about a *run of days*, not one day. A single-session
 * fixture cannot express them, which is why this file exists: the defects that
 * matter here are about what happens on day 40 of a loop that started on day 1.
 *
 * The calendar deliberately spans a month boundary (2024-01 into 2024-02) with a
 * holiday seeded in it, because every date-handling bug in this loop lives at a
 * boundary: a month end, a holiday, or the exact 20th open session. A fixture of
 * 30 consecutive weekdays would pass a run that mishandled all three.
 *
 * One test here was red when written: `runDailyShadow` declared a `'disabled'`
 * skip reason that **nothing could ever produce**, because the loop never called
 * `shadowEnabled()`. The switch that is supposed to make the loop inert by
 * default was unit-tested only in isolation, so a caller who forgot to check it
 * would write decisions anyway. That is the shape of a safety property that
 * looks done — tested somewhere, enforced nowhere.
 */

/** 90 exchange days starting 2024-01-02: crosses January into February. */
const CALENDAR = weekdays('20240102', 90);
/** The first month of sessions is what gets sealed; the rest matures them. */
const MONTH_ONE = CALENDAR.slice(0, 40);
const CUTOFF = CALENDAR.at(-1);

function fixture(t) {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  seedReferenceUniverse(db, CALENDAR, { stocks: 2 });
  db.exec(SHADOW_DECISION_SCHEMA);
  return db;
}

const candidates = (ids = ['S4C_R2']) => ({ candidates: () => ids });
const prices = (returns = {}) => ({
  outcome: ({ decision_id }) => (
    decision_id in returns ? returns[decision_id] : { net_return: 0.01, excess: -0.02 }
  ),
});

/** The switch is on in these tests unless a test says otherwise. */
const ON = { RESEARCH_SHADOW_ENABLED: '1' };

const run = (db, over = {}) => runDailyShadow({
  db,
  accountId: 'real-main',
  asOfTradeDates: MONTH_ONE,
  candidates: candidates(),
  prices: prices(),
  cutoff: CUTOFF,
  env: ON,
  ...over,
});

test('the calendar really does cross a month boundary and carry a holiday', t => {
  // Guard the fixture itself. If a future edit collapses the range into a single
  // month, the boundary assertions below would pass without testing a boundary.
  // 90 weekdays span five calendar months. What matters is not the count but
  // that the range crosses a month boundary: a bug in the date arithmetic shows
  // up at the seam, not in the middle of a month.
  const months = [...new Set(CALENDAR.map(d => d.slice(0, 6)))].sort();
  assert.ok(months.includes('202401') && months.includes('202402'),
    `the calendar must cross the January/February boundary, got ${months.join(',')}`);
  assert.ok(months.length >= 3, 'the range must be long enough to mature h=20 across a boundary');
  const db = fixture(t);
  const holiday = '20240101';
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date,is_open,pretrade_date) VALUES (?,0,NULL)').run(holiday);
  assert.equal(sessionState(db, holiday, CUTOFF).is_trading_day, false,
    'a seeded holiday must be a non-trading day');
});

test('a decision is sealed against the cutoff of its own day, never the evaluation cutoff', async t => {
  const db = fixture(t);
  const result = await run(db);
  assert.equal(result.totals.requested, MONTH_ONE.length);
  assert.equal(result.totals.sealed, MONTH_ONE.length, 'every closed trading session seals');

  // Every decision's data_cutoff is its own trade date. A run that sealed day 3
  // against the final cutoff would produce byte-identical rows with the wrong
  // lineage — precisely the "recompute in hindsight" shape the seal module
  // refuses when it can see it. Here the caller would be the liar.
  for (const session of result.sessions) {
    assert.equal(session.skip_reason, null);
    assert.equal(session.data_cutoff, session.as_of_trade_date,
      `session ${session.as_of_trade_date} must cite its own cutoff, not ${CUTOFF}`);
  }
  const rows = db.prepare('SELECT as_of_trade_date, data_cutoff FROM shadow_decisions ORDER BY as_of_trade_date').all();
  assert.equal(rows.length, MONTH_ONE.length);
  for (const row of rows) {
    assert.equal(row.data_cutoff, row.as_of_trade_date,
      `stored decision ${row.as_of_trade_date} cites cutoff ${row.data_cutoff}`);
  }
});

test('restarting the whole run does not duplicate or overwrite anything', async t => {
  const db = fixture(t);
  const first = await run(db);
  const decisionsBefore = db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get().n;
  const evaluationsBefore = db.prepare('SELECT COUNT(*) n FROM shadow_evaluations').get().n;

  // A restart is the same call again: same sessions, same cutoff. The spec asks
  // for "重启不会产生重复事件", and the way to prove it is to run twice and count
  // rows rather than trust a return value that says "already sealed".
  const second = await run(db);
  assert.equal(first.totals.sealed, MONTH_ONE.length);
  assert.equal(second.totals.sealed, 0, 'the second run must not seal again');
  assert.equal(second.totals.already_sealed, MONTH_ONE.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get().n, decisionsBefore,
    'one row per session, not two');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shadow_evaluations').get().n, evaluationsBefore,
    'evaluations are also idempotent — a restart must not double-count');

  // And the decision IDs are a function of the day, so a restart reproduces the
  // same identity rather than minting a new one.
  assert.deepEqual(
    first.sessions.map(s => s.decision_id),
    second.sessions.map(s => s.decision_id),
  );
});

test("a second month's cutoff matures the first month's decisions", async t => {
  // The cross-month point. Month one's decisions are sealed; the cutoff at the
  // end of month two is what matures them. If maturity were computed from the
  // wrong end of the window — from the evaluation cutoff instead of from the
  // decision's own cutoff — the second month would either evaluate nothing or
  // evaluate things that had not had their horizon.
  const db = fixture(t);
  const result = await run(db);

  // CUTOFF is 50 exchange days past MONTH_ONE.at(-1), so h=20 has matured for
  // every month-one decision. Every one must be evaluated, none pending.
  assert.equal(result.totals.evaluated, MONTH_ONE.length,
    'every month-one horizon has matured by the final cutoff');
  assert.equal(result.totals.pending, 0, 'none of them may still be pending');

  const stored = db.prepare('SELECT COUNT(*) n FROM shadow_evaluations').get().n;
  assert.equal(stored, MONTH_ONE.length, 'one evaluation row per matured decision');
  // The fixture's default outcome is a real number, so a null here would mean
  // the loop recorded something it did not observe.
  const nulls = db.prepare('SELECT COUNT(*) n FROM shadow_evaluations WHERE net_return IS NULL').get().n;
  assert.equal(nulls, 0, 'a matured horizon with an available outcome must not be recorded as null');
});

test('a holiday inside the run is skipped as a calendar fact, not treated as a stall', async t => {
  const db = fixture(t);
  const holiday = '20240101';
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date,is_open,pretrade_date) VALUES (?,0,NULL)').run(holiday);
  const result = await run(db, { asOfTradeDates: [holiday, ...MONTH_ONE] });
  const byDate = new Map(result.sessions.map(s => [s.as_of_trade_date, s]));
  assert.equal(byDate.get(holiday).skip_reason, 'not_a_trading_day');
  assert.equal(result.totals.skipped, 1, 'only the holiday is skipped');
  assert.equal(result.totals.sealed, MONTH_ONE.length, 'the real sessions are unaffected');
});

test('late data reaching back into a sealed decision is refused, not merged', async t => {
  const db = fixture(t);
  await run(db);
  const decisionId = `shadow-real-main-${MONTH_ONE.at(-1)}`;
  const sealed = db.prepare('SELECT content_hash, judgement_json FROM shadow_decisions WHERE decision_id=?').get(decisionId);

  // The storage layer refuses the update outright. This is the "旧记录可以复核，
  // 不能静默更新" half: a trigger fires regardless of which code path tries it,
  // so a later caller cannot "fix" a sealed decision.
  assert.throws(
    () => db.prepare('UPDATE shadow_decisions SET candidate_id=? WHERE decision_id=?').run('LATE_ARRIVAL', decisionId),
    /immutable/,
    'a sealed decision must not be updatable',
  );
  const after = db.prepare('SELECT content_hash, judgement_json FROM shadow_decisions WHERE decision_id=?').get(decisionId);
  assert.deepEqual(after, sealed, 'the row must be byte-identical after the refused write');

  // And an evaluation appended with a different outcome for the same cutoff is
  // refused rather than overwriting the first one. The cutoff has to be one the
  // run did NOT already evaluate at, or the assertion would be testing the run's
  // own write rather than the conflict guard.
  const { appendShadowEvaluation } = await import('../build/ashare/shadowSeal.js');
  const freeCutoff = '20991231';
  appendShadowEvaluation(db, decisionId, { cutoff: freeCutoff, matured: true, net_return: 0.5, excess: 0.4 });
  assert.throws(
    () => appendShadowEvaluation(db, decisionId, { cutoff: freeCutoff, matured: true, net_return: -0.5, excess: -0.4 }),
    /conflict/,
    'a second, different outcome for the same cutoff must be refused',
  );
  const kept = db.prepare('SELECT net_return FROM shadow_evaluations WHERE evaluation_id=?').get(`${decisionId}@${freeCutoff}`);
  assert.equal(kept.net_return, 0.5, 'the refused write must leave the first outcome intact');
});

test('a data gap in the second month does not turn into a negative finding', async t => {
  const db = fixture(t);
  // Month one is sealed; the price source then goes dark for part of the
  // window. A matured horizon with no outcome must stay pending with no number.
  // The dangerous failure is a loop that writes 0.00 for the outage, which reads
  // as "the strategy lost money" rather than "we could not measure".
  const gapAt = 20;
  const result = await run(db, {
    prices: prices(Object.fromEntries(
      MONTH_ONE.map((d, i) => [`shadow-real-main-${d}`, i < gapAt ? { net_return: 0.01, excess: -0.02 } : null]),
    )),
  });
  assert.equal(result.totals.evaluated, gapAt, 'the first twenty horizons matured and were evaluated');
  assert.equal(result.totals.pending, MONTH_ONE.length - gapAt,
    'the rest must be pending, not evaluated as zero');

  const zeros = db.prepare('SELECT COUNT(*) n FROM shadow_evaluations WHERE net_return=0').get().n;
  assert.equal(zeros, 0, 'a data outage must never be written as a 0% return');
  const rows = db.prepare('SELECT COUNT(*) n FROM shadow_evaluations').get().n;
  assert.equal(rows, gapAt, 'only the horizons with real outcomes are recorded');
});

test('the loop refuses to run when the disabled-by-default switch is off', async t => {
  // This was red when written, and it is the more serious gap: the loop declared
  // a 'disabled' skip reason nothing could produce, because it never called
  // `shadowEnabled()`. The switch was unit-tested in isolation, so a caller who
  // forgot to check it would write decisions to a production database while
  // believing the default was inert.
  const db = fixture(t);
  const result = await run(db, { env: {} });
  assert.equal(shadowEnabled({}), false, 'the default must be disabled');
  assert.equal(result.totals.sealed, 0,
    'with the switch unset the loop must seal nothing, whatever the caller asked for');
  assert.equal(result.totals.skipped, MONTH_ONE.length, 'every session must be skipped, not sealed');
  for (const session of result.sessions) {
    assert.equal(session.skip_reason, 'disabled', `session ${session.as_of_trade_date} must report disabled`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get().n, 0,
    'nothing may be written when disabled');

  // And the explicit opt-in still works, so the switch is a switch, not a wall.
  const enabled = await run(db);
  assert.equal(enabled.totals.sealed, MONTH_ONE.length, 'the explicit opt-in must run');
});

test('the disabled switch is re-read from the environment on every call', async t => {
  // The switch must be evaluated per call. Capturing it at module load would
  // make it untestable without a subprocess, and would mean a long-lived process
  // could never be turned off without a restart.
  const db = fixture(t);
  const off = await run(db, { env: {} });
  assert.equal(off.totals.sealed, 0);
  const on = await run(db);
  assert.equal(on.totals.sealed, MONTH_ONE.length);
  const offAgain = await run(db, { env: { RESEARCH_SHADOW_ENABLED: '0' } });
  assert.equal(offAgain.totals.sealed, 0, 'turning it off must stop it again, in the same process');
  assert.equal(offAgain.totals.already_sealed, 0,
    'and with it off, previously sealed sessions must not even be re-counted');
});

test('a research failure names the session that caused it and stops there', async t => {
  // The spec asks that "研究任务失败不影响市场生产日报" be proven and that failures
  // be visible. This loop opens only the databases it is handed and reads
  // nothing from the market cache, so the isolation is structural. What must be
  // proven is the other half: a failure inside the loop is reported with the day
  // that caused it rather than swallowed.
  const db = fixture(t);
  const { sealShadowDecision } = await import('../build/ashare/shadowSeal.js');
  // Pre-seal one session with different content, so that session's seal is
  // refused. The run must name the day rather than fail with a bare error.
  const victim = MONTH_ONE[10];
  sealShadowDecision(db, {
    decision_id: `shadow-real-main-${victim}`, account_id: 'real-main',
    as_of_trade_date: victim, data_cutoff: victim, horizon_days: 20,
    candidate_id: 'OTHER', bundle_id: 'x', judgement: { action: 'BUY', rationale: 'already here' },
  });
  await assert.rejects(
    () => run(db),
    new RegExp(`shadow_seal_failed: ${victim}`),
    'a refused seal must name the session that caused it',
  );
  // The run stops at the refusal rather than continuing to write around it.
  // Stopping is right: a loop that skipped a failed day and kept going would
  // silently produce a run with a hole in it that nothing reports.
  const sealedCount = db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get().n;
  assert.ok(sealedCount >= 1 && sealedCount < MONTH_ONE.length,
    `the run must stop at the refusal, not write all sessions; got ${sealedCount}`);
});

test('every session reports its own wall clock so a slow one is visible', async t => {
  const db = fixture(t);
  const result = await run(db);
  for (const session of result.sessions) {
    assert.equal(typeof session.ms, 'number');
    assert.ok(session.ms >= 0, `session ${session.as_of_trade_date} must report elapsed time`);
  }
  assert.ok(result.ms >= 0, 'the run reports its own wall clock');
});
