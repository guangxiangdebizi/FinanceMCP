import type { DatabaseSync } from 'node:sqlite';
import { SCORE_RULES, SCORE_VERSION, scanMarket, scoreRows, sectorRank, type StockRow } from './analysis.js';
import { evaluateEvents } from './evaluation.js';

/**
 * Phase 5 Experiment A: does the production stock-pool score actually select?
 *
 * The Champion is `score-1.0.0`, frozen in production. Its 35/15/30/10/10
 * weights are NOT tuned here — the task spec is explicit that repeatedly
 * adjusting those weights to chase in-sample return is forbidden. What is
 * tested instead is whether the *ordering* the Champion produces carries
 * information that simple passive and single-factor orderings do not.
 *
 * Every arm is computed from the same full-market scan on the same date,
 * so the only difference between arms is the ranking rule. Forward returns
 * are realised strictly after the ranking date.
 *
 * `NO_MECHANISM` is a legitimate outcome. The score's own documentation
 * says it "orders stocks for research attention; it is not a probability
 * of profit and has not been validated as a return forecast." If the data
 * says the Champion does not beat equal weight, that is the finding.
 */

/** Fixed. Not searched, not tuned, not widened to find a favourable horizon. */
export const HORIZONS = [5, 10, 20] as const;
export type Horizon = typeof HORIZONS[number];

export const SELECTION_ARMS = [
  'CHAMPION_SCORE_1_0_0',
  'EQUAL_WEIGHT',
  'SINGLE_FACTOR_ROE',
  'SINGLE_FACTOR_MOMENTUM',
  'DROP_VALUATION',
  'INDUSTRY_NEUTRAL',
] as const;
export type SelectionArm = typeof SELECTION_ARMS[number];

/** How many names each arm holds. Equal across arms, fixed in advance. */
export const POOL_SIZE = 30;

export interface ArmSelection {
  arm: SelectionArm;
  as_of: string;
  /** Eligible universe size on that date. A pool drawn from 40 names is not comparable to one drawn from 2000. */
  universe_size: number;
  pool: string[];
  /** Mean of the ranking statistic, for the record. Not used to pick a winner. */
  mean_score: number;
}

/**
 * The ranking statistic for each arm, as a map from ts_code to "higher is
 * better".
 *
 * `scoreRows` is called EXACTLY ONCE per selection. I first believed twice was
 * dangerous, because `scoreRows` writes `r.score`, `r.rank` and `r.components`
 * onto the very row objects it is given (analysis.ts:334-339) and sorts its
 * `eligible` array in place — a second call reading back what the first wrote
 * looked like it would rank an ablation arm by the full Champion score. I
 * tested that belief before writing it down, and it is FALSE: the function is
 * a pure function of its inputs plus the rows it overwrites, so a second call
 * recomputes the same values and is idempotent (verified on the fixture, and
 * `scan.rows`' own order is untouched because `eligible` is a fresh filtered
 * array). Keeping one call anyway, because the second one would be dead work
 * on a whole-market scan — but it is a cost argument, not a correctness one,
 * and the comment now says which.
 */
function rankKey(
  arm: SelectionArm,
  eligible: StockRow[],
  breakdowns: Map<string, ReturnType<typeof scoreRows> extends Map<string, infer V> ? V : never>,
  sectors: ReturnType<typeof sectorRank>,
): Map<string, number> {
  const out = new Map<string, number>();
  const set = (r: StockRow, value: number) => out.set(r.ts_code, value);
  switch (arm) {
    case 'EQUAL_WEIGHT':
      // No ranking at all: every eligible name is equally preferred and the
      // pool is taken in ts_code order. This is the "do nothing" baseline.
      for (const r of eligible) set(r, 0);
      return out;
    case 'SINGLE_FACTOR_ROE':
      // The heaviest fundamental input (30 of the 100 weight points).
      for (const r of eligible) set(r, r.fundamentals?.roe ?? NaN);
      return out;
    case 'SINGLE_FACTOR_MOMENTUM':
      // The heaviest technical input.
      for (const r of eligible) set(r, r.state.ret60 ?? NaN);
      return out;
    case 'DROP_VALUATION': {
      // Ablation: the Champion formula with the 10-point valuation leg
      // removed. Re-scoring with new weights is NOT allowed (that would be
      // tuning the Champion), so this arm ranks by the frozen total score
      // minus the valuation contribution the frozen weights already assign.
      for (const r of eligible) {
        const b = breakdowns.get(r.ts_code);
        if (!b) { set(r, NaN); continue; }
        set(r, b.contributions.technical + b.contributions.liquidity
          + b.contributions.fundamental + b.contributions.sector);
      }
      return out;
    }
    case 'INDUSTRY_NEUTRAL': {
      // Control for "the score is really an industry bet": within each
      // industry, rank by the Champion score, then fill the pool round-robin
      // across industries so no single industry can dominate it. If the
      // Champion's edge disappears here, the edge was sector exposure.
      const byIndustry = new Map<string, StockRow[]>();
      for (const r of eligible) {
        if (r.industry === '未知') continue;
        if (!byIndustry.has(r.industry)) byIndustry.set(r.industry, []);
        byIndustry.get(r.industry)!.push(r);
      }
      for (const group of byIndustry.values()) {
        // `score` is written onto the ROW by `scoreRows` (analysis.ts:335),
        // not onto the breakdown map. Reading it from the breakdown would be
        // a type error today and a silent undefined tomorrow.
        group.sort((a, b) => ((b.score ?? 0) - (a.score ?? 0)) || a.ts_code.localeCompare(b.ts_code));
      }
      // Deterministic industry order: by sector strength, descending.
      // Uses the frozen `sectorRank` strength rather than a re-derived
      // number — re-deriving it would mean two definitions of "industry
      // strength" that can drift apart, and the arm would then be measured
      // against a control nobody else can reproduce.
      const strength = new Map(sectors.map(s => [s.industry, s.strength]));
      const order = [...byIndustry.entries()]
        .map(([industry, group]) => ({ group, strength: strength.get(industry) ?? 0 }))
        .sort((a, b) => b.strength - a.strength || a.group[0].industry.localeCompare(b.group[0].industry));
      // Collect in PREFERENCE order (strongest industry first; within an
      // industry, best score first), then key by reverse insertion index.
      //
      // Keying by `out.size` here was a real bug I shipped: it gives the FIRST
      // pick key 0, and `selectPool` takes the highest keys, so the pool became
      // preference ranks 31-60 instead of 1-30 — on the fixture, a pool whose
      // mean whole-market rank was 1069.9 of 1100 rather than the intended 32.6.
      // The arm still produced plausible, fully priced numbers; it was simply
      // measuring a pool nobody designed. That is the failure mode a control arm
      // must not have, because a wrong control cannot falsify anything.
      const preferred: string[] = [];
      let round = 0;
      let added = true;
      while (added) {
        added = false;
        for (const { group } of order) {
          if (round < group.length) { preferred.push(group[round].ts_code); added = true; }
        }
        round++;
      }
      preferred.forEach((code, i) => out.set(code, preferred.length - 1 - i));
      return out;
    }
    default:
      // CHAMPION_SCORE_1_0_0. The score is on the row (analysis.ts:335).
      for (const r of eligible) set(r, r.score ?? NaN);
      return out;
  }
}

/** Draw the top `POOL_SIZE` names by the arm's ranking statistic. */
export function selectPool(db: Parameters<typeof scanMarket>[0], asOf: string, arm: SelectionArm): ArmSelection {
  const scan = scanMarket(db, asOf);
  const eligible = scan.rows.filter(r => r.eligible);
  const breakdowns = scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  const keys = rankKey(arm, eligible, breakdowns, scan.sectors);
  const ranked = eligible
    .filter(r => Number.isFinite(keys.get(r.ts_code) ?? NaN))
    .sort((a, b) => (keys.get(b.ts_code) ?? -Infinity) - (keys.get(a.ts_code) ?? -Infinity)
      || a.ts_code.localeCompare(b.ts_code));
  const pool = ranked.slice(0, POOL_SIZE).map(r => r.ts_code);
  const mean_score = pool.length
    ? pool.reduce((s, c) => s + (keys.get(c) ?? 0), 0) / pool.length
    : NaN;
  return { arm, as_of: asOf, universe_size: eligible.length, pool, mean_score };
}

export { SCORE_RULES, SCORE_VERSION, sectorRank };


// ---------------------------------------------------------------- forward evaluation

/**
 * Forward evaluation reuses `evaluateEvents` rather than a hand-rolled
 * return calculation. That module already does the things a hand-rolled
 * version gets wrong: exact t+1 entry (A-share forbids same-day resale),
 * conservative open-up-limit exclusion at entry, close-down-limit and
 * suspension deferral at exit, buy/sell fees plus slippage, and every
 * dated query bounded by `asOf` so no signal can be selected with a
 * forward price.
 *
 * Writing a second one here would create exactly what the task spec
 * forbids: a third matching / portfolio-accounting engine whose numbers
 * disagree with the production one by an amount nobody can explain.
 */
export const EXPERIMENT_A_COSTS = {
  /** A-share stamp duty on the sell side plus commission on both sides. */
  buyFeeBps: 15,
  sellFeeBps: 25,
  slippageBps: 10,
  maxExitDelay: 5,
} as const;

export interface ArmOutcome {
  arm: SelectionArm;
  as_of: string;
  horizon: Horizon;
  pool: string[];
  universe_size: number;
  /** Mean net (after-fee) return of the pool's priced members, decimal. */
  net_return: number | null;
  /** Mean net return of the equal-market reference on the same dates, decimal. */
  market_return: number | null;
  /** Mean net excess over the equal-market reference, decimal. */
  excess: number | null;
  /** Reference coverage: complete means every eligible member was priced. */
  coverage: 'complete' | 'partial' | 'unavailable';
  entered: number;
  completed: number;
  /** Members that never entered (limit-up at the open, suspended, unlisted). */
  not_entered: number;
  reasons: Record<string, number>;
}

/** Evaluate one arm's pool at one as-of date and one horizon. */
export function evaluateArm(
  db: Parameters<typeof scanMarket>[0],
  selection: ArmSelection,
  horizon: Horizon,
  asOf: string,
): ArmOutcome {
  const report = evaluateEvents(
    db,
    selection.pool.map(code => ({ date: selection.as_of, ts_code: code })),
    { asOf, horizon, ...EXPERIMENT_A_COSTS },
  );
  const outcomes = report.outcomes;
  const priced = outcomes.filter(o => o.status === 'completed' && Number.isFinite(o.net_return));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const net = mean(priced.map(o => o.net_return!));
  const marketPaired = priced.filter(o => Number.isFinite(o.excess.equal_market));
  const market = mean(marketPaired.map(o => o.net_return! - o.excess.equal_market!));
  const references = priced.map(o => o.references.equal_market.status);
  const reasons: Record<string, number> = {};
  for (const o of outcomes) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
  return {
    arm: selection.arm,
    as_of: selection.as_of,
    horizon,
    pool: selection.pool,
    universe_size: selection.universe_size,
    net_return: net,
    market_return: market,
    excess: net != null && market != null ? net - market : null,
    coverage: references.length && references.every(s => s === 'complete')
      ? 'complete'
      : references.some(s => s === 'complete' || s === 'partial') ? 'partial' : 'unavailable',
    entered: outcomes.filter(o => o.entered).length,
    completed: priced.length,
    not_entered: outcomes.filter(o => !o.entered).length,
    reasons,
  };
}
