import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb } from '../build/ashare/db.js';
import { seedReferenceUniverse, weekdays } from './ashare-fixture.mjs';
import { SCORE_VERSION, SCORE_RULES, scanMarket, scoreRows } from '../build/ashare/analysis.js';
import {
  checkChampionConsistency, checkProductionChampion, FROZEN_CHAMPION,
} from '../build/ashare/championCheck.js';

/** Phase 6 step 2 — "验证 Champion 规则与当前实现一致".
 *
 * The production Champion is `score-1.0.0`, frozen. The risk this file guards
 * against is not that someone deliberately changes it — the task spec forbids
 * tuning the weights, and everyone knows that. The risk is drift nobody chose:
 * a percentile helper gets fixed, a component gets renamed, a leg stops being
 * read, and the frozen declaration quietly stops describing the code. When that
 * happens every experiment that says "we tested the Champion" tested something
 * else, and those experiments are the only evidence behind the research
 * conclusions.
 *
 * So the checks are written to be *wrong* in the interesting direction: each one
 * is fed an implementation that differs from the frozen declaration in exactly
 * one way, and must say so. A check that passes on every input is not a check.
 *
 * The one that matters most is the last: the weights must be shown to be used,
 * not merely declared. A constant that is never read produces correct-looking
 * scores and a completely wrong identity claim, and nothing in the type system
 * or the test suite notices it.
 */

const FROZEN = FROZEN_CHAMPION.weights;
const RULES = FROZEN_CHAMPION.rules;

/** The honest implementation, built from the real module's published constants. */
const honest = (rows = []) => ({
  version: SCORE_VERSION,
  weights: { ...SCORE_RULES.weights },
  // Only the eligibility floors. Passing all of SCORE_RULES here would include
  // the nested `weights` object, and the rules check would then be comparing a
  // map with an extra key — a false failure that hides the real ones.
  rules: { ...RULES },
  score: () => rows,
});

/** One scored row, with contributions that imply exactly the frozen weights. */
const consistentRow = (over = {}) => {
  const components = { technical: 0.4, liquidity: 0.6, fundamental: 0.5, valuation: 0.3, sector: 0.7, ...over.components };
  const weights = over.weights ?? FROZEN;
  const contributions = Object.fromEntries(Object.keys(components).map(k => [k, components[k] * weights[k]]));
  return { components, contributions: { ...contributions, ...over.contributions } };
};

test('the real production Champion passes every check', async t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  const dates = weekdays('20240102', 160);
  seedReferenceUniverse(db, dates, { stocks: 40, industries: 5 });
  const result = await checkProductionChampion(db, dates.at(-1));
  assert.equal(result.consistent, true, JSON.stringify(result.checks, null, 2));
  assert.equal(result.checks.version_matches_frozen.ok, true);
  assert.equal(result.checks.weights_match_frozen_leg_by_leg.ok, true);
  assert.equal(result.checks.rules_match_frozen.ok, true);
  assert.equal(result.checks.weights_are_actually_used.ok, true, result.checks.weights_are_actually_used.detail);
  assert.ok(result.rows_inspected > 0, 'the real scan must produce scored rows to inspect');
  assert.equal(result.implementation_version, 'score-1.0.0');
});

test('a version that changed is a different scorer, and the check says so', () => {
  const result = checkChampionConsistency(honest([consistentRow()]).version
    ? { ...honest([consistentRow()]), version: 'score-2.0.0' }
    : honest([consistentRow()]));
  assert.equal(result.consistent, false);
  assert.equal(result.checks.version_matches_frozen.ok, false);
  assert.match(result.checks.version_matches_frozen.detail, /score-2\.0\.0/);
  // The other checks still pass: only the identity claim failed.
  assert.equal(result.checks.weights_are_actually_used.ok, true);
});

test('weights are compared leg by leg, not as a total', () => {
  // 40/15/30/10/5 sums to the same 100 as 35/15/30/10/10 and is a different
  // scorer. A total-only comparison would call these equal.
  const shifted = { technical: 40, liquidity: 15, fundamental: 30, valuation: 10, sector: 5 };
  const result = checkChampionConsistency({ ...honest([consistentRow()]), weights: shifted });
  assert.equal(result.consistent, false);
  assert.equal(result.checks.weights_match_frozen_leg_by_leg.ok, false,
    'a weight shift that preserves the total must still fail');
  assert.match(result.checks.weights_match_frozen_leg_by_leg.detail, /leg by leg/);
});

test('a weight that is declared but never used fails the arithmetic check', () => {
  // This is the failure that nothing else catches. The constants are perfect and
  // the implementation ignores them: `technical` contributes 10, not 35.
  const row = consistentRow({ contributions: { technical: 10 * 0.4 } });
  const result = checkChampionConsistency(honest([row]));
  assert.equal(result.consistent, false);
  assert.equal(result.checks.weights_are_actually_used.ok, false,
    'a declared weight the code does not use must not pass');
  assert.match(result.checks.weights_are_actually_used.detail, /technical/);
  assert.match(result.checks.weights_are_actually_used.detail, /not use the frozen weights/);
  // And the constant check still passes — which is the point: reading the
  // declaration alone would have called this consistent.
  assert.equal(result.checks.weights_match_frozen_leg_by_leg.ok, true,
    'the constants are right; only the arithmetic is wrong');
});

test('a looser eligibility floor is a different Champion', () => {
  const result = checkChampionConsistency({
    ...honest([consistentRow()]),
    rules: { ...RULES, min_bars: 60 },
  });
  assert.equal(result.consistent, false);
  assert.equal(result.checks.rules_match_frozen.ok, false);
  assert.match(result.checks.rules_match_frozen.detail, /min_bars/);
});

test('no scored rows means the weights were not shown to be used, not that they were', () => {
  // The tempting shortcut is to return ok when there is nothing to inspect. That
  // would make the check pass on exactly the days it cannot answer — an empty
  // scan, a data outage, a wrong as-of date.
  const result = checkChampionConsistency(honest([]));
  assert.equal(result.consistent, false);
  assert.equal(result.checks.weights_are_actually_used.ok, false);
  assert.match(result.checks.weights_are_actually_used.detail, /no scored rows/);
});

test('a row whose every component is zero cannot vouch for its weights', () => {
  // `contribution / component` is undefined at zero. Skipping zero components is
  // right; skipping *all* of them must not read as success.
  const zero = { components: { technical: 0, liquidity: 0, fundamental: 0, valuation: 0, sector: 0 },
    contributions: { technical: 0, liquidity: 0, fundamental: 0, valuation: 0, sector: 0 } };
  const result = checkChampionConsistency(honest([zero]));
  assert.equal(result.consistent, false);
  assert.equal(result.checks.weights_are_actually_used.ok, false);
  assert.match(result.checks.weights_are_actually_used.detail, /zero/);
  assert.equal(result.rows_inspected, 0);
});

test('a row with one zero component is still checked on its other legs', () => {
  // The zero-skip must be per leg, not per row. Dropping the whole row would
  // silently shrink the evidence without saying so.
  const row = consistentRow({ components: { valuation: 0 } });
  const result = checkChampionConsistency(honest([row]));
  assert.equal(result.consistent, true, result.checks.weights_are_actually_used.detail);
  assert.equal(result.rows_inspected, 4, 'four legs carry information; the zero leg does not');
});

test('the recovered weights come from the implementation, not from the constants', () => {
  // Feed it rows whose contributions imply *different* weights per row, and the
  // check must notice — proving the arithmetic really is inverted rather than
  // the frozen table being read back.
  const rows = [
    consistentRow(),
    consistentRow({ contributions: { technical: 0.5 * 40 } }),
  ];
  const result = checkChampionConsistency(honest(rows));
  assert.equal(result.consistent, false);
  assert.match(result.checks.weights_are_actually_used.detail, /technical/);
});

test('the real breakdown implies exactly the frozen weights, leg by leg', t => {
  // The property the production check rests on, asserted directly against
  // `scoreRows` output so a future change to the breakdown shape breaks here
  // rather than silently in the daily entry.
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  const dates = weekdays('20240102', 160);
  seedReferenceUniverse(db, dates, { stocks: 40, industries: 5 });
  const scan = scanMarket(db, dates.at(-1));
  const breakdowns = [...scoreRows(scan.rows, scan.sectors, SCORE_VERSION).values()];
  assert.ok(breakdowns.length > 0, 'the fixture must produce scored rows');
  let checked = 0;
  for (const b of breakdowns) {
    for (const [leg, weight] of Object.entries(FROZEN)) {
      const component = b.components[leg];
      const contribution = b.contributions[leg];
      if (!component) continue;
      assert.ok(
        Math.abs(contribution / component - weight) < 1e-9,
        `${leg}: contribution ${contribution} / component ${component} does not imply the frozen weight ${weight}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'at least one leg must have been recoverable');
});

test('the check reads nothing and writes nothing', async t => {
  // Phase 6 runs this before sealing. If it could mutate the database it would be
  // able to change the thing it is certifying.
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  const dates = weekdays('20240102', 160);
  seedReferenceUniverse(db, dates, { stocks: 40, industries: 5 });
  const before = db.prepare('SELECT COUNT(*) n FROM stock_score').get().n;
  const decisionsBefore = () => {
    try { return db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get().n; } catch { return 0; }
  };
  const sealedBefore = decisionsBefore();
  await checkProductionChampion(db, dates.at(-1));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_score').get().n, before,
    'the check must not write scores into the database it certifies');
  assert.equal(decisionsBefore(), sealedBefore, 'and it must not seal anything');
});
