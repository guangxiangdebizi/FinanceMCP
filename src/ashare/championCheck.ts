/** Phase 6 — Champion rule vs implementation consistency check.
 *
 * The task spec's step 2 of "每个交易日" is:
 *
 *   2. 验证 Champion 规则与当前实现一致。
 *
 * That sentence hides a decision. "The Champion rule" is a frozen declaration —
 * `score-1.0.0` with 35/15/30/10/10 weights — and "the current implementation"
 * is whatever `analysis.ts` happens to say today. The two can drift apart
 * without anyone touching either deliberately: someone fixes an unrelated bug in
 * a percentile helper, or a component is renamed, and the declaration no longer
 * describes what the code computes. When that happens, every experiment that
 * says "we tested the Champion" has actually tested something else — and the
 * experiments are the only thing standing behind the research conclusions.
 *
 * So this module makes the check mechanical and answerable in one call. It
 * answers four questions and reports a verdict for each:
 *
 *   1. **Does the declared version match the frozen one?** A version string that
 *      changed is not a subtle drift; it is a different scorer wearing the
 *      Champion's name.
 *   2. **Do the weights match the frozen declaration leg by leg?** Compared leg
 *      by leg, not as a total: 35+15+30+10+10 and 40+15+30+10+5 both sum to 100
 *      and are different scorers.
 *   3. **Do the eligibility floors match?** A looser floor admits names the
 *      Champion was never validated on.
 *   4. **Does the implementation's arithmetic actually use those weights?**
 *
 * Check 4 is the one that cannot be answered by reading a constant, and it is
 * the one that matters. A weight that is declared and then never read is exactly
 * the failure this check exists for.
 *
 * I first wrote check 4 by perturbing the weights and re-scoring, which is the
 * obvious shape. It does not work here: `scoreRows` closes over
 * `SCORE_RULES.weights` directly, so there is no injection point, and the only
 * way to perturb it would be to mutate the module's own constant — which tests
 * the mutation, not the implementation. The honest version reads what the
 * implementation actually publishes: `ScoreBreakdown.contributions` carries
 * `technical: W.technical * technical`, so `contribution / component` must equal
 * the frozen weight. That is a real property of real output, and it is checkable
 * without touching anything.
 *
 * This module deliberately does NOT judge whether the Champion is any good.
 * That was Phase 5's job and its experiments already did it. This check is about
 * identity, not quality: it says "the thing you are about to call the Champion is
 * the thing that was frozen", and nothing more.
 *
 * Nothing here writes, opens a database, or reads the environment. It is a pure
 * function of what it is handed, so the daily entry can call it before any seal
 * is attempted and report a refusal that names the cause.
 */

/** The frozen Champion declaration, verbatim from the production contract. */
export const FROZEN_CHAMPION = {
  version: 'score-1.0.0',
  weights: { technical: 35, liquidity: 15, fundamental: 30, valuation: 10, sector: 10 },
  /** The eligibility floors the frozen rules carry alongside the weights. */
  rules: {
    min_listed_days: 250,
    min_bars: 130,
    min_amount20_yi: 1,
    min_circ_mv_yi: 50,
  },
} as const;

export type ChampionCheckName =
  | 'version_matches_frozen'
  | 'weights_match_frozen_leg_by_leg'
  | 'rules_match_frozen'
  | 'weights_are_actually_used';

export interface ChampionConsistencyResult {
  /** True only when every check passed. A false here must stop the day's loop. */
  consistent: boolean;
  checks: Record<ChampionCheckName, { ok: boolean; detail: string }>;
  /** The version the implementation declared, for the record. */
  implementation_version: string;
  /** How many scored rows the "actually used" check could inspect. */
  rows_inspected: number;
}

/**
 * The shape of the implementation this check needs. Deliberately narrow: it
 * takes the published constants and a way to score real rows, so a test can
 * hand it a lie and watch the verdict flip.
 */
export interface ChampionImplementation {
  version: string;
  weights: Record<string, number>;
  rules: Record<string, number>;
  /**
   * Score a real set of rows with the unmodified implementation and return what
   * it publishes for each: the per-leg component and the per-leg contribution.
   * Empty is allowed and makes the "actually used" check report insufficient
   * evidence rather than pass by default.
   */
  score(): { components: Record<string, number>; contributions: Record<string, number> }[];
}

/** Compare two weight maps leg by leg. Equal totals are not equal weights. */
function mapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every(k => Number(a[k]) === Number(b[k]));
}

const LEGS = Object.keys(FROZEN_CHAMPION.weights) as (keyof typeof FROZEN_CHAMPION.weights)[];

/**
 * Check the implementation against the frozen Champion.
 *
 * The fourth check is the load-bearing one. For each scored row it derives the
 * weight the implementation must have used, `contribution / component`, and
 * requires it to equal the frozen weight. Rows whose component is zero are
 * skipped: a zero component carries no information about its weight, and
 * including them would either divide by zero or, worse, hide a mismatch behind
 * a rounding artefact.
 */
export function checkChampionConsistency(impl: ChampionImplementation): ChampionConsistencyResult {
  const frozenWeights = FROZEN_CHAMPION.weights as unknown as Record<string, number>;
  const frozenRules = FROZEN_CHAMPION.rules as unknown as Record<string, number>;

  const checks: ChampionConsistencyResult['checks'] = {
    version_matches_frozen: {
      ok: impl.version === FROZEN_CHAMPION.version,
      detail: impl.version === FROZEN_CHAMPION.version
        ? `declared version ${impl.version} matches the frozen Champion`
        : `declared version ${impl.version} does not match the frozen ${FROZEN_CHAMPION.version}`,
    },
    weights_match_frozen_leg_by_leg: {
      ok: mapsEqual(impl.weights, frozenWeights),
      detail: mapsEqual(impl.weights, frozenWeights)
        ? 'weights match the frozen 35/15/30/10/10 leg by leg'
        : `weights ${JSON.stringify(impl.weights)} do not match the frozen `
          + `${JSON.stringify(frozenWeights)} leg by leg`,
    },
    rules_match_frozen: {
      ok: mapsEqual(impl.rules, frozenRules),
      detail: mapsEqual(impl.rules, frozenRules)
        ? 'eligibility floors match the frozen rules'
        : `rules ${JSON.stringify(impl.rules)} do not match the frozen ${JSON.stringify(frozenRules)}`,
    },
    weights_are_actually_used: { ok: false, detail: 'not evaluated' },
  };

  // The arithmetic check. `contribution = weight * component` is the identity
  // the implementation publishes, so inverting it recovers the weight actually
  // used. A tolerance of 1e-9 absorbs the rounding the breakdowns carry without
  // being wide enough to let a real substitution through.
  const TOLERANCE = 1e-9;
  const rows = impl.score();
  const mismatches: string[] = [];
  let inspected = 0;
  for (const row of rows) {
    for (const leg of LEGS) {
      const component = row.components?.[leg];
      const contribution = row.contributions?.[leg];
      if (!Number.isFinite(component) || !Number.isFinite(contribution)) continue;
      if (component === 0) continue; // carries no information about its weight
      const implied = contribution / component;
      if (Math.abs(implied - frozenWeights[leg]) > TOLERANCE) {
        mismatches.push(`${leg}: contribution ${contribution} / component ${component} = ${implied}, `
          + `but the frozen weight is ${frozenWeights[leg]}`);
      }
      inspected += 1;
    }
  }
  if (!rows.length) {
    checks.weights_are_actually_used = {
      ok: false,
      detail: 'no scored rows were available, so the weights could not be shown to be used',
    };
  } else if (mismatches.length) {
    checks.weights_are_actually_used = {
      ok: false,
      detail: `the implementation's arithmetic does not use the frozen weights: ${mismatches.slice(0, 4).join('; ')}`,
    };
  } else if (inspected === 0) {
    checks.weights_are_actually_used = {
      ok: false,
      detail: 'every scored component was zero, so no leg could be checked',
    };
  } else {
    checks.weights_are_actually_used = {
      ok: true,
      detail: `recovered the frozen 35/15/30/10/10 weights from the implementation's own `
        + `contributions across ${inspected} leg(s)`,
    };
  }

  return {
    consistent: Object.values(checks).every(c => c.ok),
    checks,
    implementation_version: impl.version,
    rows_inspected: inspected,
  };
}

/**
 * Bind the real `analysis.ts` to the check.
 *
 * This is where the check stops being a unit-testable pure function and becomes
 * the thing Phase 6's step 2 actually calls. The adapter is separate for two
 * reasons: the check itself must be testable with a lying implementation (that
 * is how its verdicts are proven to move), and the daily entry must not have to
 * know the shape of `ScoreBreakdown`.
 *
 * `db` is opened read-only by the caller. Nothing here writes.
 */
export async function checkProductionChampion(db: any, asOf: string): Promise<ChampionConsistencyResult> {
  // Imported lazily, the same way `cli.ts` and `shadowRun.ts` do it: a test of
  // the pure check should not have to load the analysis module and its config
  // side effects, and `import()` is the project's module form (`"type": "module"`).
  const analysis = await import('./analysis.js');
  const scan = analysis.scanMarket(db, asOf);
  const breakdowns = analysis.scoreRows(scan.rows, scan.sectors, analysis.SCORE_VERSION);
  return checkChampionConsistency({
    version: analysis.SCORE_VERSION,
    weights: { ...analysis.SCORE_RULES.weights },
    rules: {
      min_listed_days: analysis.SCORE_RULES.min_listed_days,
      min_bars: analysis.SCORE_RULES.min_bars,
      min_amount20_yi: analysis.SCORE_RULES.min_amount20_yi,
      min_circ_mv_yi: analysis.SCORE_RULES.min_circ_mv_yi,
    },
    score: () => [...breakdowns.values()].map(b => ({
      components: { ...b.components },
      contributions: { ...b.contributions },
    })),
  });
}
