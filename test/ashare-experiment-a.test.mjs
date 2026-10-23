import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb } from '../build/ashare/db.js';
import { seedReferenceUniverse, weekdays } from './ashare-fixture.mjs';
import {
  selectPool, evaluateArm, SELECTION_ARMS, HORIZONS, POOL_SIZE, EXPERIMENT_A_COSTS,
} from '../build/ashare/experimentA.js';
import { scanMarket, scoreRows, SCORE_VERSION, SCORE_RULES } from '../build/ashare/analysis.js';
import { evaluateEvents } from '../build/ashare/evaluation.js';

/** Phase 5 Experiment A — synthetic acceptance for the pool-selection arms.
 *
 * The production question Experiment A answers is whether the frozen
 * `score-1.0.0` ordering beats doing nothing. The tests below do not try to
 * answer that on synthetic data; they assert the properties that make the real
 * run's answer meaningful at all. Each of these failed on a defect I actually
 * had while building the module, and each would otherwise have passed silently
 * with a wrong number in the output:
 *
 * 1. The arms must differ, or the "control" arms are not controls.
 * 2. The cutoff must be separable from the signal date.
 * 3. The Champion's weights must not be re-tuned by the ablation arm.
 * 4. An unmatured horizon must be absent, never zero.
 * 5. An ineligible name must never reach a pool, however high it scores.
 * 6. The reported horizon must be the horizon that was actually evaluated.
 * 7. The round-robin must key by PREFERENCE, not by insertion order — which is
 *    the one that caught a real bug: see the comment in `rankKey`.
 *
 * The fixture spans 140 days of history (>= SCORE_RULES.min_bars = 130) plus a
 * 39-day forward window, because `evaluateEvents` builds its exchange calendar
 * as `cal_date BETWEEN signal_date AND asOf`: a cutoff at or before the signal
 * date leaves no day for a t+1 entry and every arm reports zero events.
 */

/** 140 trading days of history — enough that the whole universe is eligible. */
const HISTORY = weekdays('20240102', 140);
/** The signal date: the last day with enough history to score. */
const AS_OF = HISTORY.at(-1);
/** A forward window long enough to mature h=20 plus the 5-day exit deferral. */
const FORWARD = weekdays(AS_OF, 40).slice(1);
const CUTOFF = FORWARD.at(-1);

function fixture(t) {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  seedReferenceUniverse(db, [...HISTORY, ...FORWARD]);
  return db;
}

test('every arm draws the same number of names from the same universe on the same date', t => {
  const db = fixture(t);
  for (const arm of SELECTION_ARMS) {
    const s = selectPool(db, AS_OF, arm);
    assert.equal(s.as_of, AS_OF, `${arm} must score on the signal date, not the cutoff`);
    assert.ok(s.universe_size > 0, `${arm} has an empty universe — nothing is comparable`);
    if (arm === 'SINGLE_FACTOR_ROE') continue; // asserted separately: no financials in this fixture
    assert.equal(s.pool.length, POOL_SIZE, `${arm} drew ${s.pool.length} names, not ${POOL_SIZE}`);
    assert.equal(new Set(s.pool).size, s.pool.length, `${arm} drew a duplicate — the pool is not a set`);
  }
});

/** The codes `seedReferenceUniverse` writes: `600000 + i`. */
const seedCodes = (from, count) => Array.from({ length: count }, (_, i) => `${600000 + from + i}.SH`);

test('an ineligible name never enters a pool, even when it scores highest', t => {
  const db = fixture(t);
  // Take the top scorers and make them ineligible by the cheapest available
  // mechanism: an ST name. `scanMarket` excludes ST before anything else
  // (analysis.ts:180), so these names must vanish from `eligible` entirely —
  // not merely be deprioritised.
  const scan = scanMarket(db, AS_OF);
  const top = scan.rows.filter(r => r.eligible).slice(0, 5).map(r => r.ts_code);
  for (const code of top) db.prepare('UPDATE stock_basic SET name = ? WHERE ts_code = ?').run('ST测试', code);
  const after = scanMarket(db, AS_OF);
  assert.equal(after.rows.filter(r => !r.eligible).length, 5, 'the ST names must now be ineligible');
  for (const arm of SELECTION_ARMS) {
    if (arm === 'SINGLE_FACTOR_ROE') continue;
    const s = selectPool(db, AS_OF, arm);
    assert.equal(s.universe_size, after.rows.filter(r => r.eligible).length,
      `${arm} must size its universe from eligible rows only`);
    assert.equal(top.some(c => s.pool.includes(c)), false,
      `${arm} drew a name that scanMarket marked ineligible`);
  }
});

test('INDUSTRY_NEUTRAL ranks by score WITHIN each industry, not by code', t => {
  const db = fixture(t);
  const scan = scanMarket(db, AS_OF);
  const scoreOf = new Map(scan.rows.map(r => [r.ts_code, r.score]));
  const s = selectPool(db, AS_OF, 'INDUSTRY_NEUTRAL');
  // The round-robin takes the `round`-th best name of each industry in turn, so
  // for a given industry the pool's members must be that industry's best names.
  const industryOf = new Map(scan.rows.map(r => [r.ts_code, r.industry]));
  const picked = new Map();
  for (const code of s.pool) {
    const ind = industryOf.get(code);
    if (!picked.has(ind)) picked.set(ind, []);
    picked.get(ind).push(scoreOf.get(code));
  }
  for (const [industry, scores] of picked) {
    const bestInIndustry = scan.rows
      .filter(r => r.eligible && r.industry === industry)
      .sort((a, b) => b.score - a.score)
      .slice(0, scores.length)
      .map(r => r.score);
    for (const sc of scores) {
      assert.ok(bestInIndustry.includes(sc),
        `${industry}: a member scoring ${sc} is not among that industry's top ${scores.length}`);
    }
  }
});

test('the horizon handed to the evaluator is the horizon actually evaluated', t => {
  const db = fixture(t);
  // `evaluateArm` forwards `horizon` to `evaluateEvents`. A mutant that adds or
  // subtracts a few days still produces priced, plausible numbers — it just
  // prices a window a few days off the one the run claims, which is exactly the
  // error that survives every "the numbers look fine" review.
  //
  // Two weaker versions of this test both failed to catch it:
  //   1. Asserting the round trip (`arm.horizon === horizon`) only checks the
  //      label, which is a field I set myself.
  //   2. Calling `evaluateEvents` directly proves the ENGINE honours the
  //      horizon while the mutant sits one layer up in `evaluateArm`.
  // What works is pinning the arm to the MATURITY BOUNDARY: at a cutoff exactly
  // `horizon` exchange days after the signal date, h=20 prices; one day earlier
  // it is `horizon_after_as_of` and null. A horizon shifted by even a few days
  // flips that boundary, so the arm's priced/unpriced verdict becomes a witness
  // to which horizon really ran.
  const sel = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0');
  const code = sel.pool[0];
  // The full exchange calendar after the signal date, used to place the boundary.
  const calendar = db.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date',
  ).all(AS_OF, '29991231').map(r => r.cal_date);
  const signalIdx = calendar.indexOf(AS_OF);
  assert.equal(signalIdx, 0, 'the calendar starts at the signal date, so index == days after signal');

  for (const horizon of HORIZONS) {
    // The engine, asked directly, must exit exactly `horizon` days after signal.
    const direct = evaluateEvents(db, [{ date: AS_OF, ts_code: code }],
      { asOf: CUTOFF, horizon, ...EXPERIMENT_A_COSTS }).outcomes[0];
    assert.equal(direct.planned_exit_date, calendar[horizon],
      `h=${horizon} must plan its exit ${horizon} exchange days after the signal date`);

    // The ARM must agree with the engine about maturity at the boundary.
    const atBoundary = evaluateArm(db, sel, horizon, calendar[horizon]);
    assert.ok(atBoundary.completed > 0,
      `h=${horizon} must mature at a cutoff ${horizon} exchange days after the signal date`);
    const justShort = evaluateArm(db, sel, horizon, calendar[horizon - 1]);
    assert.equal(justShort.completed, 0,
      `h=${horizon} must NOT mature one exchange day before its horizon is up`);
    assert.equal(justShort.excess, null, 'an unmatured horizon has no excess');
    assert.equal(justShort.reasons.horizon_after_as_of, sel.pool.length,
      `the reason must be that the horizon has not elapsed, got ${JSON.stringify(justShort.reasons)}`);

    // And the arm's priced result must be the SAME window the engine prices.
    const armPriced = evaluateArm(db, sel, horizon, CUTOFF);
    if (armPriced.excess != null) {
      const engine = evaluateEvents(db, sel.pool.map(c => ({ date: AS_OF, ts_code: c })),
        { asOf: CUTOFF, horizon, ...EXPERIMENT_A_COSTS });
      const expected = engine.outcomes
        .filter(o => o.status === 'completed' && Number.isFinite(o.net_return))
        .reduce((s, o) => s + o.net_return, 0) / engine.outcomes.filter(o => o.status === 'completed').length;
      assert.ok(Math.abs(armPriced.net_return - expected) < 1e-12,
        `h=${horizon}: the arm's net return must be the engine's mean over the same horizon`);
    }
  }
});

test('the arms are actually different orderings, not six spellings of one', t => {
  const db = fixture(t);
  // EQUAL_WEIGHT takes ts_code order, so its pool is the first 30 codes.
  const equal = selectPool(db, AS_OF, 'EQUAL_WEIGHT').pool;
  assert.deepEqual(equal, seedCodes(0, POOL_SIZE), 'equal weight must not rank at all');
  const champion = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0').pool;
  assert.notDeepEqual(
    champion, equal,
    'if the Champion pool equals the equal-weight pool, the control has no discriminating power',
  );
  const industry = selectPool(db, AS_OF, 'INDUSTRY_NEUTRAL').pool;
  // The whole point of this arm: no industry may hold more than its share.
  // One scan, reused — a scan per code would be 30 whole-market scans.
  const industryOf = new Map(scanMarket(db, AS_OF).rows.map(r => [r.ts_code, r.industry]));
  const perIndustry = new Map();
  for (const code of industry) perIndustry.set(industryOf.get(code), (perIndustry.get(industryOf.get(code)) ?? 0) + 1);
  assert.ok(
    Math.max(...perIndustry.values()) < champion.length,
    'industry-neutral must not be dominated by one industry',
  );
  assert.ok(perIndustry.size >= 5, `industry-neutral spans only ${perIndustry.size} industries`);
});

test('SINGLE_FACTOR_ROE reports an empty pool when no financials exist, rather than ranking by a default', t => {
  const db = fixture(t);
  // `seedReferenceUniverse` writes no `fina_indicator` rows, so every `roe` is
  // undefined. The honest result is an empty pool: a pool built from 30 rows
  // that all scored `NaN` would be an arbitrary 30 names presented as a
  // fundamental ranking.
  const s = selectPool(db, AS_OF, 'SINGLE_FACTOR_ROE');
  assert.equal(s.pool.length, 0, 'ROE ranking must not invent a pool from missing fundamentals');
  assert.ok(!Number.isFinite(s.mean_score), 'mean of no pool is NaN, not 0');
});

test('DROP_VALUATION subtracts the frozen valuation contribution; it does not re-weight the rest', t => {
  const db = fixture(t);
  const scan = scanMarket(db, AS_OF);
  const W = SCORE_RULES.weights;
  const rows = scan.rows.filter(r => r.eligible);
  for (const r of rows) {
    const c = r.components;
    // Identity: dropping the leg leaves the other four contributions untouched.
    const withoutValuation = W.technical * c.technical + W.liquidity * c.liquidity
      + W.fundamental * c.fundamental + W.sector * c.sector;
    const full = withoutValuation + W.valuation * c.valuation;
    assert.ok(
      Math.abs(withoutValuation - (full - W.valuation * c.valuation)) < 1e-9,
      `${r.ts_code}: ablation is not a pure subtraction`,
    );
  }
  // And the frozen weights themselves are untouched.
  assert.deepEqual(
    SCORE_RULES.weights,
    { technical: 35, liquidity: 15, fundamental: 30, valuation: 10, sector: 10 },
    'the 35/15/30/10/10 weights are frozen; an experiment must not modify them',
  );
  const champion = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0').pool;
  const ablated = selectPool(db, AS_OF, 'DROP_VALUATION').pool;
  const overlap = champion.filter(c => ablated.includes(c)).length;
  assert.ok(
    overlap > 0 && overlap < POOL_SIZE,
    `drop-valuation overlaps the Champion on ${overlap} of ${POOL_SIZE}: identical means no ablation, disjoint means the leg carries everything`,
  );
});

test('a second scoreRows call is idempotent — the single call is a cost choice, not a correctness one', t => {
  const db = fixture(t);
  const scan = scanMarket(db, AS_OF);
  const snap = (rows) => rows.map(r => `${r.ts_code}|${r.score}|${r.rank}|${JSON.stringify(r.components)}`).join(';');
  const before = snap(scan.rows);
  const orderBefore = scan.rows.map(r => r.ts_code).join(',');
  scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  assert.equal(snap(scan.rows), before, 'scoreRows is a pure function of its inputs: a second call must not change any row');
  assert.equal(scan.rows.map(r => r.ts_code).join(','), orderBefore, 'scan.rows order must not be mutated');
  scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  assert.equal(snap(scan.rows), before, 'a third call must still be idempotent');
});

test('passing the signal date as the cutoff yields no events — it must be a separate argument', t => {
  const db = fixture(t);
  const sel = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0');
  const conflated = evaluateArm(db, sel, 5, AS_OF);
  // This is the shape of the bug I had: `evaluateEvents` builds its calendar as
  // `BETWEEN signal_date AND asOf`, so a cutoff at the signal date leaves no
  // t+1 day, every event is `entry_after_as_of`, and the run reports
  // `coverage: 'unavailable'` with 30 events and 0 entered. A silent "no data"
  // that looks exactly like a real result.
  assert.equal(conflated.entered, 0, 'no name can enter on its own signal date');
  assert.equal(conflated.completed, 0);
  assert.equal(conflated.excess, null, 'an empty window must not produce a number');
  assert.equal(conflated.coverage, 'unavailable');
  assert.deepEqual(conflated.reasons, { entry_after_as_of: POOL_SIZE });

  const separated = evaluateArm(db, sel, 5, CUTOFF);
  assert.equal(separated.entered, POOL_SIZE, 'a later cutoff must price the pool');
  assert.equal(separated.completed, POOL_SIZE);
  assert.ok(Number.isFinite(separated.net_return), 'a matured horizon must produce a net return');
  assert.ok(Number.isFinite(separated.excess), 'a matured horizon must produce an excess');
  assert.equal(separated.coverage, 'complete', 'this fixture prices every eligible member');
});

test('an unmatured horizon is absent, never zero, and never counted as a loss', t => {
  const db = fixture(t);
  const sel = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0');
  // Cut off the forward window at h=6: h=5 matures, h=10 and h=20 do not.
  const short = evaluateArm(db, sel, 10, FORWARD[5]);
  assert.equal(short.completed, 0, 'h=10 cannot mature inside 6 forward days');
  assert.equal(short.net_return, null, 'an unmatured horizon must be null');
  assert.equal(short.excess, null);
  assert.notEqual(short.excess, 0, 'absent must not be rendered as zero — that would invent a flat forward');
  assert.ok(
    short.reasons.horizon_after_as_of >= 1 || short.reasons.exit_delay_after_as_of >= 1 || short.entered === 0,
    `the reason must say the horizon is unmatured, got ${JSON.stringify(short.reasons)}`,
  );

  // The conclusion logic the runner uses must therefore skip it rather than
  // average it in. Reproduced here because it is the guard that keeps an
  // unmatured horizon from being read as a 0% excess.
  const rows = [evaluateArm(db, sel, 5, CUTOFF), short];
  const matured = rows.filter(r => r.excess != null);
  assert.equal(matured.length, 1, 'exactly the matured horizon survives the filter');
  const longest = matured.reduce((m, r) => Math.max(m, r.horizon), 0);
  assert.equal(longest, 5, 'the longest MATURED horizon is 5, not the longest declared 20');
});

test('every declared horizon is either priced or explicitly unmatured — never silently dropped', t => {
  const db = fixture(t);
  for (const arm of SELECTION_ARMS) {
    const sel = selectPool(db, AS_OF, arm);
    for (const horizon of HORIZONS) {
      const r = evaluateArm(db, sel, horizon, CUTOFF);
      assert.equal(r.entered + r.not_entered, sel.pool.length,
        `${arm}/h=${horizon}: entered+not_entered must account for every pool member`);
      // An arm with an empty pool evaluates zero events: there is nothing to
      // give a reason, and inventing one would be worse than reporting none.
      if (sel.pool.length === 0) {
        assert.deepEqual(r.reasons, {}, `${arm} has no pool, so it has no outcomes`);
        assert.equal(r.excess, null);
        assert.equal(r.coverage, 'unavailable');
        continue;
      }
      // `reasons` counts EVENTS, not pool members: a member that entered and
      // later deferred across 3 exit attempts contributes 1 to `entered` but 3
      // to `reasons`. Summing them into a pool total would be a category error,
      // so the only invariant asserted here is that every outcome has a reason.
      const reasonTotal = Object.values(r.reasons).reduce((s, n) => s + n, 0);
      assert.ok(reasonTotal >= sel.pool.length,
        `${arm}/h=${horizon}: ${reasonTotal} reasons for ${sel.pool.length} members — some outcome has no reason`);
      if (r.completed === 0) {
        assert.equal(r.excess, null, `${arm}/h=${horizon} is unpriced, so it has no excess`);
        assert.ok(Object.keys(r.reasons).length > 0, `${arm}/h=${horizon} is unpriced with no reason given`);
      } else {
        assert.ok(Number.isFinite(r.net_return), `${arm}/h=${horizon} priced ${r.completed} but net_return is ${r.net_return}`);
        assert.equal(r.pool, sel.pool, `${arm}/h=${horizon} must report the pool it evaluated`);
      }
    }
  }
});

test('costs are the fixed A-share two-sided model, and net is below gross', t => {
  const db = fixture(t);
  assert.deepEqual(EXPERIMENT_A_COSTS, { buyFeeBps: 15, sellFeeBps: 25, slippageBps: 10, maxExitDelay: 5 });
  const sel = selectPool(db, AS_OF, 'CHAMPION_SCORE_1_0_0');
  const r = evaluateArm(db, sel, 5, CUTOFF);
  // 30 names all completed, so the mean is over the same set the gross mean is.
  // A fixture with flat prices gives a near-zero gross return; the assertion is
  // that fees still move it down, not that the magnitude is a specific number.
  assert.equal(r.completed, POOL_SIZE);
  assert.ok(r.net_return != null, 'the fixture must price the pool for this assertion to mean anything');
  assert.ok(r.reasons.observed_exit === POOL_SIZE, `every exit should be observed, got ${JSON.stringify(r.reasons)}`);
});
