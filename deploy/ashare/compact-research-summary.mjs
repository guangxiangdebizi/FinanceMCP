#!/usr/bin/env node
// Build the compact, reviewable research-evidence file kept in the repository.
//
// The full experiment result (per-date/per-stock detail, all 111 largest-rank-change
// lists, the complete correlation matrix and full quality records) is preserved
// outside the repository and is byte-reproducible from the frozen research
// database: experiment.result for the run is exactly the summary.json written by
// run-research.mjs. This script only re-shapes that result; it never recomputes
// scores, returns or statistics, so trimming cannot change any documented number.
//
// Usage:
//   node deploy/ashare/compact-research-summary.mjs FULL_SUMMARY.json OUTPUT.json [--source-label <text>] [--audit AUDIT.json]
//   node deploy/ashare/compact-research-summary.mjs --research-db RESEARCH.sqlite --run-id PHB-... OUTPUT.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 'phaseb-research-evidence-1.0.0';
export const BY_DATE_COLUMNS = [
  'date', 'n', 'entered', 'completed', 'unresolved_after_entry', 'not_entered', 'open_at_cutoff', 'censored',
  'entry_date', 'exit_date', 'net_return', 'excess_equal_market', 'excess_csi300', 'excess_industry',
];
export const QUALITY_COLUMNS = [
  'status', 'daily', 'daily_basic', 'adj_factor', 'stk_limit', 'prev_daily', 'listed',
  'daily_vs_prev', 'daily_vs_listed', 'daily_basic_vs_daily', 'adj_factor_vs_daily', 'stk_limit_vs_daily',
  'bad_close', 'ohlc_inconsistent', 'zero_amount', 'extreme_move',
];
export const COMPARISON_COLUMNS = [
  'date', 'segment', 'scanned', 'eligible', 'v1_score_mean', 'v1_score_median', 'v2_score_mean', 'v2_score_median',
  'score_delta_mean', 'score_delta_median', 'changed_scores', 'rank_correlation',
  'top40_hhi_v1', 'top40_hhi_v2', 'pool_hhi_v1', 'pool_hhi_v2',
  'pool_v1', 'pool_v2', 'pool_common', 'pool_v1_only', 'pool_v2_only',
];

const round = (value, digits = 6) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(value * 10 ** digits) / 10 ** digits : value;
const roundDeep = (value, digits = 6) => {
  if (Array.isArray(value)) return value.map(item => roundDeep(item, digits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v, digits)]));
  return round(value, digits);
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Compact distribution: location and spread only; full quantiles stay in the outside file. */
const compactDistribution = d => d == null ? null : Object.fromEntries(
  ['n', 'mean', 'median', 'win_rate', 'volatility'].filter(k => k in d).map(k => [k, round(d[k])]));

/**
 * Per-date cross-version comparison as a columnar table. Full per-date
 * distributions, per-date industry counts and the top-20 rank-change lists stay
 * in the outside full file; one complete date is kept in `sample`.
 */
const compactComparisons = rows => ({
  columns: COMPARISON_COLUMNS,
  rows: (rows ?? []).map(c => [
    c.date, c.segment, c.scanned, c.eligible,
    round(c.v1_scores?.mean), round(c.v1_scores?.median), round(c.v2_scores?.mean), round(c.v2_scores?.median),
    round(c.score_delta?.mean), round(c.score_delta?.median), c.changed_scores, round(c.rank_correlation?.correlation),
    round(c.top40_industries?.[0]?.hhi), round(c.top40_industries?.[1]?.hhi),
    round(c.pool_industries?.[0]?.hhi), round(c.pool_industries?.[1]?.hhi),
    c.pool_membership.v1, c.pool_membership.v2, c.pool_membership.common,
    Array.isArray(c.pool_membership.v1_only) ? c.pool_membership.v1_only.length : c.pool_membership.v1_only,
    Array.isArray(c.pool_membership.v2_only) ? c.pool_membership.v2_only.length : c.pool_membership.v2_only,
  ]),
  largest_rank_changes: 'Only the largest per-date rank change is kept in `sample.comparison`; the top-20 list for every date is in the outside full file.',
});

/** Per-date series as a columnar table so 111 dates stay reviewable without repeating keys. */
const compactByDate = rows => ({
  columns: BY_DATE_COLUMNS,
  rows: (rows ?? []).map(r => [
    r.date, r.n, r.entered, r.completed, r.unresolved_after_entry, r.not_entered, r.open_at_cutoff, r.censored,
    r.entry_date, r.exit_date, round(r.net_return),
    round(r.excess?.equal_market), round(r.excess?.csi300), round(r.excess?.industry),
  ]),
});

const compactCohortStats = stats => stats == null ? null : ({
  dates: stats.dates, events: stats.events, entered: stats.entered, completed: stats.completed,
  unresolved_after_entry: stats.unresolved_after_entry, not_entered: stats.not_entered,
  open_at_cutoff: stats.open_at_cutoff, dates_with_entries: stats.dates_with_entries,
  dates_with_completed_returns: stats.dates_with_completed_returns,
  net_return: compactDistribution(stats.net_return),
  excess_including_priced_subsets: Object.fromEntries(Object.entries(stats.excess_including_priced_subsets ?? {}).map(([k, v]) => [k, compactDistribution(v)])),
  synthetic_observation_drawdown: round(stats.synthetic_observation_drawdown),
});

const compactBenchmarks = benchmarks => Object.fromEntries(Object.entries(benchmarks ?? {}).map(([key, b]) => [key, {
  denominator_completed_events: b.denominator_completed_events, paired: b.paired, missing: b.missing,
  complete_coverage_events: b.complete_coverage_events, partial_coverage_events: b.partial_coverage_events,
  reference_memberships: b.reference_memberships, priced_memberships: b.priced_memberships, unresolved_memberships: b.unresolved_memberships,
  coverage_status: b.complete_coverage_events === 0 ? 'partial_only' : b.partial_coverage_events === 0 ? 'complete_only' : 'mixed',
  excess_complete_coverage: compactDistribution(b.excess_complete_coverage),
  excess_including_priced_subsets: compactDistribution(b.excess_including_priced_subsets),
}]));

/** Keep the score correlation (quoted in the acceptance doc) plus every feature's return correlation. */
const compactCorrelations = correlations => (correlations ?? []).map(c => ({
  feature: c.feature,
  with_net_return: c.with_net_return ?? null,
  with_excess: c.with_excess ?? null,
}));

const compactSegment = segment => ({
  version: segment.version,
  scope: segment.scope,
  options: segment.options,
  summary: {    denominators: segment.summary.denominators,
    gross_return: compactDistribution(segment.summary.gross_return),
    net_return: compactDistribution(segment.summary.net_return),
    benchmarks: compactBenchmarks(segment.summary.benchmarks),
    by_date: compactByDate(segment.summary.by_date),
    overlap: {
      as_of: segment.summary.overlap.as_of,
      overlapping_cohort_pairs: segment.summary.overlap.overlapping_cohort_pairs,
      excluded_no_entry_dates: segment.summary.overlap.excluded_no_entry_dates,
      retained_dates: segment.summary.overlap.retained_dates,
      all_cohorts: compactCohortStats(segment.summary.overlap.all_cohorts),
      non_overlapping_cohorts: compactCohortStats(segment.summary.overlap.non_overlapping_cohorts),
    },
    correlations: compactCorrelations(segment.summary.correlations),
    interpretation: segment.summary.interpretation,
  },
});

/** Quality-by-date keeps the auditable status/count/coverage/anomaly columns for every sampled date. */
const compactQuality = qualityByDate => {
  const dates = Object.keys(qualityByDate ?? {});
  return {
    columns: QUALITY_COLUMNS,
    dates,
    rows: dates.map(date => {
      const q = qualityByDate[date];
      return [
        q.status,
        q.counts?.daily, q.counts?.daily_basic, q.counts?.adj_factor, q.counts?.stk_limit, q.counts?.prev_daily, q.counts?.listed,
        q.coverage?.daily_vs_prev, q.coverage?.daily_vs_listed, q.coverage?.daily_basic_vs_daily, q.coverage?.adj_factor_vs_daily, q.coverage?.stk_limit_vs_daily,
        q.anomalies?.bad_close, q.anomalies?.ohlc_inconsistent, q.anomalies?.zero_amount, q.anomalies?.extreme_move,
      ];
    }),
    reasons: dates.filter(date => (qualityByDate[date].reasons ?? []).length).map(date => ({ date, reasons: qualityByDate[date].reasons })),
  };
};

export function compactResearchSummary(full, { sourceLabel = null, fullSha256 = null, fullBytes = null, resultSha256 = null, pairedSensitivity = null } = {}) {
  const protocolKeys = [
    'run_id', 'status', 'data_cutoff', 'source_sha256', 'baseline_build_sha256', 'versions', 'split',
    'split_interpretation', 'selection', 'costs', 'benchmarks', 'score_policy', 'weights', 'pool_rules',
    'limitations', 'implementation_sha256', 'runtime_build_sha256', 'input_scan_sha256', 'units',
    'sampled_trade_dates', 'selection_dates', 'stride', 'warmup_trade_days', 'options',
  ];
  const out = { schema_version: SCHEMA_VERSION };
  for (const key of protocolKeys) out[key] = full[key];
  out.quality_by_date = compactQuality(full.quality_by_date);
  out.comparisons = compactComparisons(full.comparisons);
  out.evaluation = Object.fromEntries(Object.entries(full.evaluation ?? {}).map(([version, segments]) =>
    [version, Object.fromEntries(Object.entries(segments).map(([segment, value]) => [segment, compactSegment(value)]))]));
  // The four segments share one identical limitations list in the full result; keep it once.
  const limitationLists = new Set(Object.values(full.evaluation ?? {}).flatMap(s => Object.values(s).map(v => JSON.stringify(v.limitations ?? []))));
  out.evaluation_limitations = limitationLists.size === 1 ? JSON.parse([...limitationLists][0]) : { by_segment: Object.fromEntries(Object.entries(full.evaluation ?? {}).flatMap(([v, s]) => Object.entries(s).map(([k, x]) => [`${v}.${k}`, x.limitations]))) };
  out.future_observation = full.future_observation;
  out.reproducible_commands = full.reproducible_commands;
  if (pairedSensitivity) {
    out.paired_sensitivity = {
      note: 'Common-comparable-event sensitivity computed read-only from the research DB event table by deploy/ashare/verify-research-summary.mjs. Descriptive only: the paired delta of an event present in both pools is zero by construction because the evaluation function and data cutoff are identical, so it cannot be read as a strategy return difference and is not used to tune parameters.',
      formation: pairedSensitivity.formation,
      historical_simulation: pairedSensitivity.historical_simulation,
    };
  }
  // The audit file records this file's SHA256, so this file must not embed the
  // audit's own hash (that would be circular); it only points at the audit.
  if (pairedSensitivity) out.audit = {
    file: 'docs/ashare-samples/phaseb-research-audit.json',
    command: 'node deploy/ashare/verify-research-summary.mjs --summary docs/ashare-samples/phaseb-research-summary.json --research-db /home/jcshi/ashare-research/phaseb/research.sqlite --run-id PHB-2853b1b630df4bcc98c4 --snapshot /home/jcshi/ashare-research/ashare-20261016.sqlite --output docs/ashare-samples/phaseb-research-audit.json',
  };
  out.full_evidence = {
    note: 'The complete experiment result is preserved outside the repository; this file is a lossless projection of its protocol, per-date metrics, denominators, benchmark coverage and quality status. Per-stock detail, the full quantile/correlation matrix and per-date rank-change lists are only in the full file.',
    source_label: sourceLabel,
    sha256: fullSha256,
    result_sha256: resultSha256,
    bytes: fullBytes,
    rows: full.comparisons?.length ?? null,
  };
  // A small, necessary sample keeps the exact detail format visible in the repository.
  const sampleDate = full.comparisons?.at(-1)?.date;
  const sample = (full.comparisons ?? []).find(c => c.date === sampleDate);
  out.sample = sample ? {
    date: sample.date,
    note: 'Unmodified full record for one date, so the compact per-date fields can be checked against the original format.',
    comparison: roundDeep(sample),
    quality: full.quality_by_date?.[sample.date] ?? null,
  } : null;
  return roundDeep(out);
}

function readFull({ summaryPath, researchDb, runId }) {
  if (summaryPath) {
    const text = readFileSync(summaryPath);
    return { full: JSON.parse(text.toString('utf8')), bytes: text.length, sha256: sha256(text) };
  }
  if (!researchDb) throw new Error('Provide FULL_SUMMARY.json or --research-db');
  const db = new DatabaseSync(resolve(researchDb), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const row = runId
      ? db.prepare('SELECT result FROM experiment WHERE run_id=?').get(runId)
      : db.prepare("SELECT result FROM experiment WHERE result IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
    if (!row?.result) throw new Error(`No experiment result for run ${runId ?? '<latest>'}`);
    return { full: JSON.parse(row.result), bytes: Buffer.byteLength(row.result), sha256: sha256(row.result) };
  } finally { db.close(); }
}

/**
 * Readable JSON that keeps short arrays and small flat objects on one line.
 * Indenting every number of a 111x16 table, or every field of a five-key
 * distribution, onto its own line multiplies the file size without adding any
 * information; one row or one distribution per line stays diff-friendly.
 */
export function formatEvidence(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const flat = v => v === null || typeof v !== 'object';
  const oneLine = v => JSON.stringify(v).length <= 160 && !String(JSON.stringify(v)).includes('\n');
  if (Array.isArray(value)) {
    if (value.every(flat)) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
    if (value.every(v => Array.isArray(v) && v.every(flat))) return `[\n${value.map(row => `${inner}${JSON.stringify(row)}`).join(',\n')}\n${pad}]`;
    return `[\n${value.map(v => `${inner}${formatEvidence(v, indent + 2)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const line = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
    if (entries.every(([, v]) => flat(v)) && line.length <= 160) return line;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatEvidence(v, indent + 2)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

export function buildCompact(options) {
  const { full, bytes, sha256: fullSha } = readFull(options);
  // The research DB stores the same result as compact JSON; the file on disk is pretty-printed,
  // so record both hashes and let the audit accept either as proof of the same result.
  const resultSha256 = createHash('sha256').update(JSON.stringify(full)).digest('hex');
  let pairedSensitivity = null;
  let auditSha256 = null;
  if (options.audit) {
    const auditText = readFileSync(resolve(options.audit));
    const audit = JSON.parse(auditText.toString('utf8'));
    if (audit.run_id && audit.run_id !== full.run_id) throw new Error(`Audit ${options.audit} is for ${audit.run_id}, not ${full.run_id}`);
    if (audit.evidence?.paired_sensitivity?.formation) pairedSensitivity = audit.evidence.paired_sensitivity;
    else if (audit.paired_sensitivity?.formation) pairedSensitivity = audit.paired_sensitivity;
    if (!pairedSensitivity) throw new Error(`Audit ${options.audit} has no paired sensitivity evidence`);
  }
  const compact = compactResearchSummary(full, {
    sourceLabel: options.sourceLabel ?? options.summaryPath ?? options.researchDb,
    fullSha256: fullSha, fullBytes: bytes, resultSha256, pairedSensitivity,
  });
  const text = `${formatEvidence(compact)}\n`;
  return { compact, text, fullSha256: fullSha, fullBytes: bytes, runId: full.run_id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = name => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined;
  const positional = argv.filter((v, i) => !v.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const summaryPath = flag('summary') ?? positional[0];
  const output = flag('output') ?? positional[1];
  if (!output) throw new Error('Usage: compact-research-summary.mjs FULL_SUMMARY.json OUTPUT.json | --research-db DB --run-id ID OUTPUT.json');
  const built = buildCompact({ summaryPath, researchDb: flag('research-db'), runId: flag('run-id'), sourceLabel: flag('source-label'), audit: flag('audit') });
  writeFileSync(resolve(output), built.text);
  process.stderr.write(`${built.runId}: ${built.text.length} bytes (from ${built.fullBytes} bytes, sha256 ${built.fullSha256})\n`);
}
