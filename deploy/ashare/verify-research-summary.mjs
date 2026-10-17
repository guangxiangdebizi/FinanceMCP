#!/usr/bin/env node
// Audit the Phase B research evidence against the frozen research database.
//
// Every documented Phase B statistic is re-derived here from the full experiment
// result (experiment.result in the frozen research DB, or a supplied summary.json)
// and, where relevant, from the per-event table. The script fails (non-zero exit)
// if a documented number is not what the code produced, so the compact evidence
// file and the acceptance doc cannot silently drift.
//
// Read-only throughout: the research DB is opened with readOnly + query_only,
// its SHA256 and the frozen market snapshot's SHA256 are checked before and after,
// and only the JSON output path is written.
//
// Usage:
//   node deploy/ashare/verify-research-summary.mjs --summary docs/ashare-samples/phaseb-research-evidence.json \
//     [--full-summary /path/to/summary.json] [--research-db /path/to/research.sqlite] [--run-id PHB-...] \
//     [--snapshot /path/to/ashare-20261016.sqlite] --output audit.json
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const EXPECTED = {
  run_id: 'PHB-2853b1b630df4bcc98c4',
  data_cutoff: '20261016',
  source_sha256: 'ac31a9eb0b65c756758e2af6bb97ec718775ae030454fbcadfc5a8d19e234dd1',
  split: '20260331',
  formation_dates: 84,
  simulation_dates: 27,
  total_dates: 111,
  stride: 5,
  warmup_trade_days: 130,
  horizon: 10,
  non_overlapping_formation_dates: 36,
  non_overlapping_simulation_dates: 12,
  versions: ['score-1.0.0', 'score-2.0.0'],
  // Acceptance-doc table values, expressed exactly as the summary stores them.
  table: {
    'score-1.0.0': {
      formation: { completed: 2895, net_mean: 0.011683, net_median: -0.003719, win_rate: 0.480484, non_overlap_dates: 36, non_overlap_market_excess: -0.005973640856655983 },
      historical_simulation: { events: 863, entered: 831, completed: 770, unresolved_after_entry: 61, not_entered: 32, net_mean: -0.003586, net_median: -0.020029, win_rate: 0.415584, non_overlap_dates: 12, non_overlap_market_excess: 0.005085391500612675 },
    },
    'score-2.0.0': {
      formation: { completed: 2847, net_mean: 0.009096, net_median: -0.0038, win_rate: 0.481911, non_overlap_dates: 36, non_overlap_market_excess: -0.009990202468028968 },
      historical_simulation: { events: 876, entered: 841, completed: 773, unresolved_after_entry: 68, not_entered: 35, net_mean: -0.003188, net_median: -0.018283, win_rate: 0.419146, non_overlap_dates: 12, non_overlap_market_excess: 0.0030534786209185766 },
    },
  },
};

const round = (v, d = 9) => typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v;
const median = values => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const k = (v.length - 1) / 2;
  return (v[Math.floor(k)] + v[Math.ceil(k)]) / 2;
};
const mean = values => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null;

export async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/**
 * Common-comparable-event sensitivity: events whose (date, ts_code) is in BOTH
 * V1 and V2 sampled pools. Because the evaluation function and as-of cutoff are
 * identical, an event present in both pools has exactly the same net return
 * (the score version cannot change prices); the paired delta is therefore a
 * mechanism check, not an alternative strategy return. Composition means show
 * what actually differs between the two completed sets.
 */
export function pairedSensitivity(events) {
  const index = new Map(events.map(e => [`${e.version}|${e.segment}|${e.date}|${e.ts_code}`, e]));
  const out = {};
  for (const segment of ['formation', 'historical_simulation']) {
    const pairs = [];
    const common = [];
    let v1Only = [], v2Only = [];
    for (const e of events) {
      if (e.segment !== segment) continue;
      const other = index.get(`${e.version === 'score-1.0.0' ? 'score-2.0.0' : 'score-1.0.0'}|${segment}|${e.date}|${e.ts_code}`);
      if (e.version === 'score-1.0.0' && !other) v1Only.push(e);
      if (e.version === 'score-2.0.0' && !other) v2Only.push(e);
      if (e.version !== 'score-1.0.0' || !other) continue;
      common.push(e);
      if (e.status === 'completed' && other.status === 'completed' && e.net_return !== null && other.net_return !== null) {
        pairs.push({ date: e.date, ts_code: e.ts_code, v1: e.net_return, v2: other.net_return, delta: e.net_return - other.net_return });
      }
    }
    const deltas = pairs.map(p => p.delta);
    out[segment] = {
      label: 'DESCRIPTIVE_SENSITIVITY_ONLY: not a strategy return difference and not used to tune parameters',
      common_pool_events: common.length,
      v1_pool_events: common.length + v1Only.length,
      v2_pool_events: common.length + v2Only.length,
      v1_only_events: v1Only.length,
      v2_only_events: v2Only.length,
      common_completed_pairs: pairs.length,
      paired_delta: {
        n: deltas.length,
        mean: round(mean(deltas)),
        median: round(median(deltas)),
        min: deltas.length ? round(Math.min(...deltas)) : null,
        max: deltas.length ? round(Math.max(...deltas)) : null,
        nonzero: deltas.filter(d => Math.abs(d) > 1e-12).length,
      },
      // Composition: what the two completed sets contain beyond their shared events.
      completed_net_return: {
        common_v1: round(mean(common.filter(e => e.status === 'completed' && e.net_return !== null).map(e => e.net_return))),
        v1_only: round(mean(v1Only.filter(e => e.status === 'completed' && e.net_return !== null).map(e => e.net_return))),
        v2_only: round(mean(v2Only.filter(e => e.status === 'completed' && e.net_return !== null).map(e => e.net_return))),
      },
      v1_only_completed: v1Only.filter(e => e.status === 'completed').length,
      v2_only_completed: v2Only.filter(e => e.status === 'completed').length,
      interpretation: 'The paired delta is expected to be exactly zero because the evaluation function reads the same frozen prices for the same event under both versions. Differences between the two versions therefore come only from different pool membership, not from different return computation.',
    };
  }
  return out;
}

function readEvents(db, runId) {
  const rows = db.prepare('SELECT version, segment, date, ts_code, status, detail FROM event WHERE run_id=?').all(runId);
  return rows.map(r => {
    const detail = JSON.parse(r.detail);
    return { version: r.version, segment: r.segment, date: r.date, ts_code: r.ts_code, status: r.status, net_return: detail.net_return ?? null };
  });
}

export async function verifyResearchSummary(options) {
  const started = Date.now();
  const result = {
    schema_version: 'phaseb-research-audit-1.0.0',
    status: 'PENDING',
    started_at: new Date(started).toISOString(),
    command: 'node deploy/ashare/verify-research-summary.mjs',
    run_id: null, inputs: {}, checks: {}, failures: [], evidence: {},
  };
  const check = (name, ok, detail) => {
    result.checks[name] = ok;
    if (!ok) result.failures.push({ check: name, detail });
    return ok;
  };

  // ---- inputs: the committed compact evidence, and the full result (DB or file)
  let compact = null;
  if (options.summary) {
    compact = JSON.parse(readFileSync(options.summary, 'utf8'));
    result.inputs.evidence = { path: resolve(options.summary), bytes: statSync(options.summary).size, sha256: await fileHash(options.summary), schema_version: compact.schema_version, run_id: compact.run_id };
  }
  let full = null;
  let db = null;
  if (options.researchDb) {
    const dbPath = resolve(options.researchDb);
    result.inputs.research_db = { path: dbPath, bytes: statSync(dbPath).size, sha256_before: await fileHash(dbPath) };
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    const row = options.runId
      ? db.prepare('SELECT run_id, result, created_at FROM experiment WHERE run_id=?').get(options.runId)
      : db.prepare('SELECT run_id, result, created_at FROM experiment WHERE result IS NOT NULL ORDER BY created_at DESC LIMIT 1').get();
    if (!row?.result) throw new Error(`No experiment result in ${dbPath} for ${options.runId ?? '<latest>'}`);
    result.inputs.research_db.run_id = row.run_id;
    result.inputs.research_db.created_at = row.created_at;
    result.inputs.research_db.result_bytes = Buffer.byteLength(row.result);
    result.inputs.research_db.result_sha256 = createHash('sha256').update(row.result).digest('hex');
    full = JSON.parse(row.result);
  }
  if (!full && options.fullSummary) {
    const text = readFileSync(options.fullSummary);
    result.inputs.full_summary = { path: resolve(options.fullSummary), bytes: text.length, sha256: createHash('sha256').update(text).digest('hex') };
    full = JSON.parse(text.toString('utf8'));
  }
  if (!full && compact) {
    // Without the full result the audit still re-checks the committed file's internal consistency.
    full = null;
  }
  if (!full && !compact) throw new Error('Supply --summary, --full-summary or --research-db');

  const source = full ?? compact;
  result.run_id = source.run_id;
  const isCompact = source === compact && !full;

  // ---- 1. protocol identity
  check('run_id', source.run_id === EXPECTED.run_id, { expected: EXPECTED.run_id, actual: source.run_id });
  check('data_cutoff', source.data_cutoff === EXPECTED.data_cutoff, { expected: EXPECTED.data_cutoff, actual: source.data_cutoff });
  check('source_sha256', source.source_sha256 === EXPECTED.source_sha256, { expected: EXPECTED.source_sha256, actual: source.source_sha256 });
  check('split', source.split === EXPECTED.split, { expected: EXPECTED.split, actual: source.split });
  check('stride', source.stride === EXPECTED.stride, { expected: EXPECTED.stride, actual: source.stride });
  check('warmup_trade_days', source.warmup_trade_days === EXPECTED.warmup_trade_days, { expected: EXPECTED.warmup_trade_days, actual: source.warmup_trade_days });
  check('horizon', source.options?.horizon === EXPECTED.horizon, { expected: EXPECTED.horizon, actual: source.options?.horizon });
  check('versions', JSON.stringify(source.versions?.scores) === JSON.stringify(EXPECTED.versions), { expected: EXPECTED.versions, actual: source.versions?.scores });

  // ---- 2. sampled dates
  const dates = source.selection_dates ?? [];
  const formation = dates.filter(d => d <= EXPECTED.split);
  const simulation = dates.filter(d => d > EXPECTED.split);
  check('total_sampled_dates', dates.length === EXPECTED.total_dates, { expected: EXPECTED.total_dates, actual: dates.length });
  check('formation_sampled_dates', formation.length === EXPECTED.formation_dates, { expected: EXPECTED.formation_dates, actual: formation.length });
  check('simulation_sampled_dates', simulation.length === EXPECTED.simulation_dates, { expected: EXPECTED.simulation_dates, actual: simulation.length });
  check('selection_dates_sorted_unique', dates.every((d, i) => /^\d{8}$/.test(d) && (!i || d > dates[i - 1])), { first: dates[0], last: dates.at(-1) });
  check('selection_dates_include_split_and_cutoff', dates.includes(EXPECTED.split) && dates.includes(EXPECTED.data_cutoff), { split: dates.includes(EXPECTED.split), cutoff: dates.includes(EXPECTED.data_cutoff) });
  const scanHashes = source.input_scan_sha256 ?? {};
  check('input_scan_sha256_per_date', dates.every(d => /^[0-9a-f]{64}$/.test(scanHashes[d] ?? '')), { expected: dates.length, actual: Object.keys(scanHashes).length });
  result.evidence.dates = { formation: formation.length, simulation: simulation.length, first: dates[0], last: dates.at(-1) };

  // ---- 3. per-version/segment denominators and return metrics
  const table = {};
  for (const version of EXPECTED.versions) {
    table[version] = {};
    for (const segment of ['formation', 'historical_simulation']) {
      const seg = source.evaluation?.[version]?.[segment];
      const summary = seg?.summary;
      if (!summary) { check(`segment_present:${version}:${segment}`, false, { actual: null }); continue; }
      const d = summary.denominators, expected = EXPECTED.table[version][segment];
      const overlap = summary.overlap?.non_overlapping_cohorts;
      const row = {
        events: d.events, entered: d.entered, completed: d.completed, unresolved_after_entry: d.unresolved_after_entry, not_entered: d.not_entered,
        net_mean: round(summary.net_return.mean), net_median: round(summary.net_return.median), win_rate: round(summary.net_return.win_rate),
        non_overlap_dates: summary.overlap?.retained_dates?.length ?? null,
        non_overlap_market_excess: round(overlap?.excess_including_priced_subsets?.equal_market?.mean),
      };
      table[version][segment] = row;
      for (const [key, want] of Object.entries(expected)) {
        // Counts must match exactly; return metrics are documented to 0.001% (ratio 1e-5), so allow 1e-6.
        const tolerance = key === 'completed' || key === 'non_overlap_dates' ? 0 : 1e-6;
        const actual = row[key];
        check(`${version}:${segment}:${key}`, actual !== undefined && actual !== null && Math.abs(actual - want) <= tolerance,
          { expected: want, actual, tolerance });
      }
      check(`${version}:${segment}:denominators_add_up`, d.events === d.completed + d.unresolved_after_entry + d.not_entered
        && d.entered === d.completed + d.unresolved_after_entry, { denominators: d });
      check(`${version}:${segment}:statuses_sum_to_events`, Object.values(d.statuses).reduce((s, n) => s + n, 0) === d.events, { statuses: d.statuses, events: d.events });
      check(`${version}:${segment}:completed_equals_status`, d.statuses.completed === d.completed, { status_completed: d.statuses.completed, completed: d.completed });
      check(`${version}:${segment}:non_overlap_dates`, (summary.overlap?.retained_dates?.length ?? -1) === expected.non_overlap_dates,
        { expected: expected.non_overlap_dates, actual: summary.overlap?.retained_dates?.length });
      const byDateCount = Array.isArray(summary.by_date) ? summary.by_date.length : summary.by_date?.rows?.length;
      check(`${version}:${segment}:by_date_matches_dates`, byDateCount === (segment === 'formation' ? formation.length : simulation.length),
        { expected: segment === 'formation' ? formation.length : simulation.length, actual: byDateCount });
      check(`${version}:${segment}:benchmark_coverage_reported`, ['equal_market', 'csi300', 'industry'].every(k => {
        const b = summary.benchmarks?.[k];
        return b && b.complete_coverage_events + b.partial_coverage_events === b.paired && b.missing === b.denominator_completed_events - b.paired;
      }), { benchmarks: summary.benchmarks && Object.fromEntries(Object.entries(summary.benchmarks).map(([k, b]) => [k, { complete: b.complete_coverage_events, partial: b.partial_coverage_events, missing: b.missing, paired: b.paired }])) });
    }
  }
  result.evidence.table = table;

  // ---- 4. overlap sensitivity: whole-cohort non-overlap dates and excluded cohorts
  const overlapChecks = {};
  for (const version of EXPECTED.versions) {
    for (const [segment, expectedDates] of [['formation', EXPECTED.non_overlapping_formation_dates], ['historical_simulation', EXPECTED.non_overlapping_simulation_dates]]) {
      const ov = source.evaluation?.[version]?.[segment]?.summary?.overlap;
      if (!ov) continue;
      const retained = ov.retained_dates ?? [];
      const spacings = retained.slice(1).map((d, i) => indexBetween(dates, retained[i]) - indexBetween(dates, retained[i]));
      overlapChecks[`${version}:${segment}`] = {
        as_of: ov.as_of, overlapping_cohort_pairs: ov.overlapping_cohort_pairs, retained: retained.length,
        excluded_no_entry_dates: ov.excluded_no_entry_dates, all_cohorts: ov.all_cohorts?.dates, non_overlapping_cohorts: ov.non_overlapping_cohorts?.dates,
        retained_dates: retained,
      };
      check(`overlap:${version}:${segment}:retained`, retained.length === expectedDates, { expected: expectedDates, actual: retained.length });
      check(`overlap:${version}:${segment}:cohort_count`, ov.non_overlapping_cohorts?.dates === expectedDates, { expected: expectedDates, actual: ov.non_overlapping_cohorts?.dates });
      check(`overlap:${version}:${segment}:all_cohorts`, ov.all_cohorts?.dates === (segment === 'formation' ? formation.length : simulation.length), { actual: ov.all_cohorts?.dates });
      check(`overlap:${version}:${segment}:retained_dates_subset`, retained.every(d => dates.includes(d)), { retained });
    }
  }
  result.evidence.overlap = overlapChecks;

  // ---- 5. common-comparable-event sensitivity (requires the per-event table)
  if (db && full) {
    const events = readEvents(db, full.run_id);
    const sensitivity = pairedSensitivity(events);
    result.evidence.paired_sensitivity = sensitivity;
    for (const segment of ['formation', 'historical_simulation']) {
      const s = sensitivity[segment];
      check(`paired:${segment}:counts_consistent`, s.v1_pool_events === (EXPECTED.table['score-1.0.0'][segment].events ?? s.v1_pool_events)
        && s.v2_pool_events === (EXPECTED.table['score-2.0.0'][segment].events ?? s.v2_pool_events), { v1: s.v1_pool_events, v2: s.v2_pool_events });
      check(`paired:${segment}:identical_evaluation`, s.paired_delta.nonzero === 0,
        { note: 'A nonzero delta would mean the two versions evaluated the same event with different prices', delta: s.paired_delta });
      check(`paired:${segment}:pairs_present`, s.common_completed_pairs > 0, { pairs: s.common_completed_pairs });
    }
    result.evidence.event_rows = events.length;
  } else {
    result.evidence.paired_sensitivity = {
      status: 'NOT_AVAILABLE',
      reason: 'Per-event net returns are stored in the research DB `event` table; supply --research-db to compute the common-comparable-event sensitivity.',
    };
  }

  // ---- 6. compact evidence must be a faithful projection of the full result
  if (compact && full) {
    const projection = projectionChecks(compact, full);
    result.evidence.projection = projection;
    check('evidence:run_id_matches_full', compact.run_id === full.run_id, { compact: compact.run_id, full: full.run_id });
    const declaredHashes = [compact.full_evidence?.sha256, compact.full_evidence?.result_sha256].filter(Boolean);
    const actualHashes = [result.inputs.research_db?.result_sha256, result.inputs.full_summary?.sha256].filter(Boolean);
    check('evidence:full_sha256_matches', declaredHashes.length > 0 && declaredHashes.some(h => actualHashes.includes(h)),
      { declared: declaredHashes, actual: actualHashes });
    check('evidence:dates_match_full', JSON.stringify(compact.selection_dates) === JSON.stringify(full.selection_dates), { compact: compact.selection_dates?.length, full: full.selection_dates?.length });
    check('evidence:comparisons_rows_match', compact.comparisons?.rows?.length === full.comparisons?.length, { compact: compact.comparisons?.rows?.length, full: full.comparisons?.length });
    check('evidence:quality_rows_match', compact.quality_by_date?.rows?.length === Object.keys(full.quality_by_date).length, { compact: compact.quality_by_date?.rows?.length, full: Object.keys(full.quality_by_date).length });
    for (const [name, ok, detail] of projection) check(`evidence:projection:${name}`, ok, detail);
    check('evidence:size_under_limit', result.inputs.evidence.bytes < 300 * 1024, { bytes: result.inputs.evidence.bytes });
  } else if (compact && !full) {
    // Self-consistency of the committed file alone: a trimmed file cannot silently drift.
    check('evidence:self:dates', compact.selection_dates?.length === EXPECTED.total_dates && compact.sampled_trade_dates === EXPECTED.total_dates, { dates: compact.selection_dates?.length, sampled: compact.sampled_trade_dates });
    check('evidence:self:comparison_rows', compact.comparisons?.rows?.length === EXPECTED.total_dates, { rows: compact.comparisons?.rows?.length });
    check('evidence:self:quality_rows', compact.quality_by_date?.rows?.length === EXPECTED.total_dates, { rows: compact.quality_by_date?.rows?.length });
    check('evidence:self:run_id', compact.run_id === EXPECTED.run_id, { actual: compact.run_id });
    check('evidence:self:source_sha', compact.source_sha256 === EXPECTED.source_sha256, { actual: compact.source_sha256 });
    const rows = compact.comparisons?.rows ?? [];
    const idx = Object.fromEntries((compact.comparisons?.columns ?? []).map((c, i) => [c, i]));
    check('evidence:self:segment_split', rows.filter(r => r[idx.segment] === 'formation').length === EXPECTED.formation_dates
      && rows.filter(r => r[idx.segment] === 'historical_simulation').length === EXPECTED.simulation_dates, { columns: compact.comparisons?.columns });
    result.evidence.self_consistency = true;
  }

  if (db) {
    db.close();
    result.inputs.research_db.sha256_after = await fileHash(options.researchDb);
    check('research_db_unchanged', result.inputs.research_db.sha256_before === result.inputs.research_db.sha256_after,
      { before: result.inputs.research_db.sha256_before, after: result.inputs.research_db.sha256_after });
  }
  if (options.snapshot) {
    const snapshot = resolve(options.snapshot);
    const after = await fileHash(snapshot);
    result.inputs.snapshot = { path: snapshot, bytes: statSync(snapshot).size, sha256: after };
    check('snapshot_sha256', after === EXPECTED.source_sha256, { expected: EXPECTED.source_sha256, actual: after });
  }

  result.status = result.failures.length ? 'FAIL' : 'PASS';
  result.completed_at = new Date().toISOString();
  result.timings_ms = { total: Date.now() - started };
  result.method = 'Re-derived every documented Phase B statistic from the frozen experiment.result and the per-event table (read-only research DB) and compared it with the expected values transcribed from docs/ashare-phaseb-acceptance.md. Recomputed the common-comparable-event paired delta from the event table, verified the committed compact evidence is a faithful projection of the full result, and checked the research DB and market snapshot hashes are unchanged.';
  if (options.output) writeFileSync(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const indexBetween = (dates, d) => dates.indexOf(d);

/** Field-by-field comparison of the compact projection against the full result. */
function projectionChecks(compact, full) {
  const out = [];
  const add = (name, ok, detail) => out.push([name, ok, detail]);
  const eq = (a, b, tol = 1e-6) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol);
  const cols = compact.comparisons.columns;
  const col = Object.fromEntries(cols.map((c, i) => [c, i]));
  const rows = compact.comparisons.rows;
  const byDate = new Map(full.comparisons.map(c => [c.date, c]));
  let comparisonMismatch = null;
  for (const row of rows) {
    const c = byDate.get(row[col.date]);
    if (!c) { comparisonMismatch = { date: row[col.date], reason: 'missing in full' }; break; }
    const want = {
      scanned: c.scanned, eligible: c.eligible, changed_scores: c.changed_scores,
      v1_mean: c.v1_scores.mean, v1_median: c.v1_scores.median, v2_mean: c.v2_scores.mean, v2_median: c.v2_scores.median,
      delta_mean: c.score_delta.mean, delta_median: c.score_delta.median, rank_correlation: c.rank_correlation.correlation,
      top40_v1: c.top40_industries[0].hhi, top40_v2: c.top40_industries[1].hhi,
      pool_hhi_v1: c.pool_industries[0].hhi, pool_hhi_v2: c.pool_industries[1].hhi,
      pool_v1: c.pool_membership.v1, pool_v2: c.pool_membership.v2, common: c.pool_membership.common,
      v1_only: c.pool_membership.v1_only.length, v2_only: c.pool_membership.v2_only.length,
    };
    const got = {
      scanned: row[col.scanned], eligible: row[col.eligible], changed_scores: row[col.changed_scores],
      v1_mean: row[col.v1_score_mean], v1_median: row[col.v1_score_median], v2_mean: row[col.v2_score_mean], v2_median: row[col.v2_score_median],
      delta_mean: row[col.score_delta_mean], delta_median: row[col.score_delta_median], rank_correlation: row[col.rank_correlation],
      top40_v1: row[col.top40_hhi_v1], top40_v2: row[col.top40_hhi_v2],
      pool_hhi_v1: row[col.pool_hhi_v1], pool_hhi_v2: row[col.pool_hhi_v2],
      pool_v1: row[col.pool_v1], pool_v2: row[col.pool_v2], common: row[col.pool_common],
      v1_only: row[col.pool_v1_only], v2_only: row[col.pool_v2_only],
    };
    for (const [k, v] of Object.entries(want)) if (!eq(v, got[k])) { comparisonMismatch = { date: c.date, field: k, expected: v, actual: got[k] }; break; }
    if (comparisonMismatch) break;
  }
  add('comparison_columns', comparisonMismatch === null, { mismatch: comparisonMismatch });

  // denominators and key distributions per version/segment
  let segmentMismatch = null;
  for (const [version, segments] of Object.entries(full.evaluation)) {
    for (const [segment, value] of Object.entries(segments)) {
      const c = compact.evaluation?.[version]?.[segment];
      if (!c) { segmentMismatch = { version, segment, reason: 'missing' }; break; }
      const s = value.summary;
      const checks = [
        ['denominators', JSON.stringify(c.summary.denominators) === JSON.stringify(s.denominators)],
        ['net_mean', eq(c.summary.net_return.mean, s.net_return.mean)],
        ['net_median', eq(c.summary.net_return.median, s.net_return.median)],
        ['win_rate', eq(c.summary.net_return.win_rate, s.net_return.win_rate)],
        ['retained_dates', JSON.stringify(c.summary.overlap.retained_dates) === JSON.stringify(s.overlap.retained_dates)],
        ['by_date_rows', c.summary.by_date.rows.length === s.by_date.length],
        ['benchmark_paired', ['equal_market', 'csi300', 'industry'].every(k => c.summary.benchmarks[k].paired === s.benchmarks[k].paired)],
        ['benchmark_complete_partial', ['equal_market', 'csi300', 'industry'].every(k => c.summary.benchmarks[k].complete_coverage_events === s.benchmarks[k].complete_coverage_events && c.summary.benchmarks[k].partial_coverage_events === s.benchmarks[k].partial_coverage_events)],
        ['score_correlation', eq(c.summary.correlations.find(x => x.feature === 'score')?.with_net_return?.correlation, s.correlations.find(x => x.feature === 'score')?.with_net_return?.correlation)],
      ];
      const bad = checks.find(([, ok]) => !ok);
      if (bad) { segmentMismatch = { version, segment, field: bad[0] }; break; }
    }
    if (segmentMismatch) break;
  }
  add('evaluation_projection', segmentMismatch === null, { mismatch: segmentMismatch });

  // per-date net return series
  const byCol = Object.fromEntries(compact.evaluation['score-1.0.0'].formation.summary.by_date.columns.map((c, i) => [c, i]));
  const dateRows = Object.fromEntries(compact.evaluation['score-1.0.0'].formation.summary.by_date.rows.map(r => [r[byCol.date], r]));
  let dateMismatch = null;
  for (const d of full.evaluation['score-1.0.0'].formation.summary.by_date) {
    const r = dateRows[d.date];
    if (!r || r[byCol.completed] !== d.completed || !eq(r[byCol.net_return], d.net_return)) { dateMismatch = { date: d.date, expected: d.completed, actual: r?.[byCol.completed] }; break; }
  }
  add('by_date_series', dateMismatch === null, { mismatch: dateMismatch });

  // quality table
  const q = compact.quality_by_date;
  const qi = Object.fromEntries(q.columns.map((c, i) => [c, i]));
  let qualityMismatch = null;
  for (const [i, date] of q.dates.entries()) {
    const src = full.quality_by_date[date], row = q.rows[i];
    if (!src || row[qi.status] !== src.status || row[qi.daily] !== src.counts.daily || row[qi.stk_limit] !== src.counts.stk_limit) { qualityMismatch = { date }; break; }
  }
  add('quality_table', qualityMismatch === null && q.dates.length === Object.keys(full.quality_by_date).length, { mismatch: qualityMismatch });

  // input hashes and versions are copied verbatim
  add('input_scan_sha256', JSON.stringify(compact.input_scan_sha256) === JSON.stringify(full.input_scan_sha256), {});
  add('implementation_sha256', JSON.stringify(compact.implementation_sha256) === JSON.stringify(full.implementation_sha256), {});
  add('versions', JSON.stringify(compact.versions) === JSON.stringify(full.versions), {});
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = name => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined;
  const result = await verifyResearchSummary({
    summary: flag('summary'),
    fullSummary: flag('full-summary'),
    researchDb: flag('research-db'),
    runId: flag('run-id'),
    snapshot: flag('snapshot'),
    output: flag('output'),
  });
  for (const [name, ok] of Object.entries(result.checks)) if (!ok) console.error(`FAIL ${name}`);
  if (!result.output_written && result.status === 'PASS') process.stderr.write(`PASS: ${Object.keys(result.checks).length} checks\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
}
