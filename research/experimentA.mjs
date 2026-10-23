// Phase 5 Experiment A: does the production stock-pool score actually select?
//
// Run against a READ-ONLY copy of the frozen research snapshot. No production
// database is opened, no live API is called, and nothing is written.
//
//   node research/experimentA.mjs --db PATH --as-of YYYYMMDD [--cutoff YYYYMMDD]
//
// Every arm is drawn from the same full-market scan on the same date, so the
// only difference between arms is the ranking rule. The Champion's
// 35/15/30/10/10 weights are frozen and are NOT searched here.

import { DatabaseSync } from 'node:sqlite';
// Imports come from `build/`, not `src/`: this is a compiled TypeScript
// project and the runner must exercise the same artefacts the tests and the
// CLI do. Importing from `src/` would require --experimental-strip-types and
// would silently skip the type errors the build catches.
import { selectPool, evaluateArm, SELECTION_ARMS, HORIZONS, EXPERIMENT_A_COSTS } from '../build/ashare/experimentA.js';
import { SCORE_RULES } from '../build/ashare/analysis.js';

/** Read from the module rather than restated, so the evidence cannot drift from the frozen weights. */
const SCORE_WEIGHTS = SCORE_RULES.weights;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const db = arg('db');
const asOf = arg('as-of');
if (!db || !asOf) {
  console.error('usage: node research/experimentA.mjs --db PATH --as-of YYYYMMDD [--cutoff YYYYMMDD]');
  process.exit(2);
}

// Read-only: `mode=ro` refuses to create the file and refuses any write.
const ro = new DatabaseSync(`file:${db}?mode=ro`, { readOnly: true });

/** The cache's last daily bar, used as the default evaluation cutoff. */
function lastBar(handle) {
  const row = handle.prepare('SELECT MAX(trade_date) AS d FROM daily').get();
  return row?.d ?? '';
}

// The evaluation cutoff: the last date whose prices may be read. It is a
// SEPARATE argument from `as-of` (the signal date) and must be later, or the
// forward window has nothing to measure. Defaults to the cache's last bar.
//
// Conflating the two is the bug this argument exists to prevent: passing the
// signal date as the cutoff makes every dated query stop at the signal date,
// so the exit price is unreachable and every arm reports `unavailable` with
// zero entries — a silent "no data" that looks exactly like a real result.
const cutoff = arg('cutoff') ?? lastBar(ro);
if (cutoff <= asOf) {
  console.error(`--cutoff (${cutoff}) must be later than --as-of (${asOf}); the forward window would be empty.`);
  process.exit(2);
}

const rows = [];
for (const arm of SELECTION_ARMS) {
  const selection = selectPool(ro, asOf, arm);
  for (const horizon of HORIZONS) {
    rows.push(evaluateArm(ro, selection, horizon, cutoff));
  }
}

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(3)}%`);
console.log(`Experiment A · signal date ${asOf} · cutoff ${cutoff} · Champion score-1.0.0 · costs ${JSON.stringify(EXPERIMENT_A_COSTS)}`);
console.log('arm                       h   net        market     excess     coverage  entered completed');
for (const r of rows) {
  console.log(
    r.arm.padEnd(26),
    String(r.horizon).padStart(2),
    pct(r.net_return).padStart(10),
    pct(r.market_return).padStart(10),
    pct(r.excess).padStart(10),
    r.coverage.padStart(9),
    String(r.entered).padStart(7),
    String(r.completed).padStart(9),
  );
}

// The comparison that answers the question: does the Champion beat doing
// nothing? Taken at the longest MATURED horizon, not the longest declared one.
//
// Filtering on `coverage === 'complete'` here would be wrong, and it is the
// mistake this loop exists to avoid: the equal-market reference is the whole
// listed universe, so its coverage is `partial` whenever any stock in the
// market is suspended or newly listed on those dates. That is a property of
// the reference, not of the arm, and demanding `complete` would discard every
// real result in favour of "INSUFFICIENT_DATA".
//
// What matters is that the ARM's own pool is fully priced. A matured horizon
// with an unpriced member is the honest "cannot conclude" case.
const matured = rows.filter(r => r.excess != null);
const longest = matured.reduce((m, r) => (r.horizon > m ? r.horizon : m), 0);
const head = matured.filter(r => r.horizon === longest);
const champion = head.find(r => r.arm === 'CHAMPION_SCORE_1_0_0');
const equal = head.find(r => r.arm === 'EQUAL_WEIGHT');
const edge = champion && equal ? champion.excess - equal.excess : null;
console.log('');
if (!champion || !equal) {
  console.log(`CONCLUSION: INSUFFICIENT_DATA — no matured horizon (longest matured: ${longest || 'none'}).`);
} else {
  console.log(`At the longest matured horizon h=${longest}:`);
  console.log(`  Champion excess   ${pct(champion.excess)} (${champion.completed}/${champion.entered} priced)`);
  console.log(`  Equal-weight excess ${pct(equal.excess)} (${equal.completed}/${equal.entered} priced)`);
  console.log(`  Edge over doing nothing: ${pct(edge)}`);
  console.log('');
  console.log(
    edge > 0
      ? 'NOTE: a positive edge on ONE date is descriptive only. One date is not a forward sample, and this run makes no claim about statistical significance.'
      : 'CONCLUSION: NO_MECHANISM — on this date the Champion ordering did not beat equal weight.',
  );
  console.log('Unmatured horizons are reported as n/a above and are NOT counted as zero.');
}

// `--json` writes the same run as machine-readable evidence. Without it the
// numbers exist only in a terminal scrollback, and a result that cannot be
// diffed cannot be audited — the Phase 5 acceptance doc has to be able to point
// at a file whose sha256 anyone can recompute.
const jsonOut = arg('json');
if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const sha256 = (p) => createHash('sha256').update(execFileSync('cat', [p], { encoding: 'utf-8' })).digest('hex');
  const payload = {
    experiment: 'A',
    signal_date: asOf,
    cutoff,
    champion: { score_version: 'score-1.0.0', weights: SCORE_WEIGHTS },
    costs: EXPERIMENT_A_COSTS,
    hypothesis: 'The frozen score-1.0.0 ordering selects a pool whose after-cost forward return beats an equal-weight pool from the same universe on the same date.',
    longest_matured_horizon: longest,
    champion_excess: champion?.excess ?? null,
    equal_weight_excess: equal?.excess ?? null,
    edge_over_equal_weight: edge,
    arms: rows,
    code: {
      code_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim(),
      source_sha256: sha256(fileURLToPath(new URL('../src/ashare/experimentA.ts', import.meta.url))),
      runner_sha256: sha256(fileURLToPath(import.meta.url)),
    },
  };
  writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + '\n');
  console.log(`JSON evidence written to ${jsonOut}`);
}
