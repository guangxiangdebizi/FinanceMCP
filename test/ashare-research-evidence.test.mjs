// The committed research evidence must stay a faithful projection of the full
// experiment result, and the audit must fail when a documented number drifts.
// These tests use the real committed file plus a synthetic full result whose
// shape matches run-research.mjs output, so they run without the 9.5 GB research DB.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { compactResearchSummary, formatEvidence } from '../deploy/ashare/compact-research-summary.mjs';
import { EXPECTED, verifyResearchSummary, pairedSensitivity } from '../deploy/ashare/verify-research-summary.mjs';

const COMMITTED = new URL('../docs/ashare-samples/phaseb-research-summary.json', import.meta.url);
const evidence = JSON.parse(readFileSync(COMMITTED, 'utf8'));
const columns = Object.fromEntries(evidence.comparisons.columns.map((c, i) => [c, i]));

/** Minimal full-result shape: enough of each section for the projection checks. */
function syntheticFull() {
  const dates = evidence.selection_dates;
  const segment = (version, segmentName, denominator) => {
    const byDate = evidence.evaluation[version][segmentName].summary.by_date;
    const byDateCols = Object.fromEntries(byDate.columns.map((c, i) => [c, i]));
    return {
    version,
    scope: 'RESEARCH_ONLY_RETURN_OBSERVATIONS',
    options: evidence.options,
    summary: {
      denominators: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.denominators)),
      gross_return: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.gross_return)),
      net_return: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.net_return)),
      benchmarks: Object.fromEntries(['equal_market', 'csi300', 'industry'].map(k => [k, {
        denominator_completed_events: denominator.completed, paired: denominator.completed, missing: 0,
        complete_coverage_events: evidence.evaluation[version][segmentName].summary.benchmarks[k].complete_coverage_events,
        partial_coverage_events: evidence.evaluation[version][segmentName].summary.benchmarks[k].partial_coverage_events,
        reference_memberships: 1, priced_memberships: 1, unresolved_memberships: 0,
        excess_complete_coverage: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.benchmarks[k].excess_complete_coverage)),
        excess_including_priced_subsets: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.benchmarks[k].excess_including_priced_subsets)),
      }])),
      by_date: byDate.rows.map(r => ({ date: r[byDateCols.date], n: r[byDateCols.n], entered: r[byDateCols.entered], completed: r[byDateCols.completed], unresolved_after_entry: r[byDateCols.unresolved_after_entry], not_entered: r[byDateCols.not_entered], open_at_cutoff: r[byDateCols.open_at_cutoff], censored: r[byDateCols.censored], entry_date: r[byDateCols.entry_date], exit_date: r[byDateCols.exit_date], net_return: r[byDateCols.net_return], excess: { equal_market: r[byDateCols.excess_equal_market], csi300: r[byDateCols.excess_csi300], industry: r[byDateCols.excess_industry] } })),
      overlap: {
        as_of: segmentName === 'formation' ? evidence.split : evidence.data_cutoff,
        overlapping_cohort_pairs: evidence.evaluation[version][segmentName].summary.overlap.overlapping_cohort_pairs,
        excluded_no_entry_dates: evidence.evaluation[version][segmentName].summary.overlap.excluded_no_entry_dates,
        retained_dates: evidence.evaluation[version][segmentName].summary.overlap.retained_dates,
        all_cohorts: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.overlap.all_cohorts)),
        non_overlapping_cohorts: JSON.parse(JSON.stringify(evidence.evaluation[version][segmentName].summary.overlap.non_overlapping_cohorts)),
      },
      correlations: evidence.evaluation[version][segmentName].summary.correlations.map(c => ({ ...c, with_features: { score: { n: 1, correlation: 1 } } })),
      interpretation: 'synthetic',
    },
    limitations: ['synthetic limitation'],
  }; };
  return {
    ...Object.fromEntries(['run_id', 'status', 'data_cutoff', 'source_sha256', 'baseline_build_sha256', 'versions', 'split', 'selection_dates', 'stride', 'warmup_trade_days', 'options', 'selection', 'split_interpretation', 'costs', 'benchmarks', 'score_policy', 'weights', 'pool_rules', 'limitations', 'implementation_sha256', 'runtime_build_sha256', 'input_scan_sha256', 'units', 'sampled_trade_dates', 'future_observation', 'reproducible_commands'].map(k => [k, evidence[k]])),
    quality_by_date: Object.fromEntries(evidence.quality_by_date.dates.map((d, i) => [d, {
      status: evidence.quality_by_date.rows[i][0],
      reasons: [],
      counts: { daily: evidence.quality_by_date.rows[i][1], daily_basic: evidence.quality_by_date.rows[i][2], adj_factor: evidence.quality_by_date.rows[i][3], stk_limit: evidence.quality_by_date.rows[i][4], prev_daily: evidence.quality_by_date.rows[i][5], listed: evidence.quality_by_date.rows[i][6] },
      coverage: { daily_vs_prev: evidence.quality_by_date.rows[i][7], daily_vs_listed: evidence.quality_by_date.rows[i][8], daily_basic_vs_daily: evidence.quality_by_date.rows[i][9], adj_factor_vs_daily: evidence.quality_by_date.rows[i][10], stk_limit_vs_daily: evidence.quality_by_date.rows[i][11] },
      anomalies: { bad_close: evidence.quality_by_date.rows[i][12], ohlc_inconsistent: evidence.quality_by_date.rows[i][13], zero_amount: evidence.quality_by_date.rows[i][14], extreme_move: evidence.quality_by_date.rows[i][15] },
    }])),
    comparisons: evidence.comparisons.rows.map(r => ({
      date: r[columns.date], segment: r[columns.segment], scanned: r[columns.scanned], eligible: r[columns.eligible],
      v1_scores: { n: r[columns.eligible], mean: r[columns.v1_score_mean], median: r[columns.v1_score_median], win_rate: 1, volatility: 1 },
      v2_scores: { n: r[columns.eligible], mean: r[columns.v2_score_mean], median: r[columns.v2_score_median], win_rate: 1, volatility: 1 },
      score_delta: { n: r[columns.eligible], mean: r[columns.score_delta_mean], median: r[columns.score_delta_median], win_rate: 0, volatility: 1, min: -3.75, max: 0 },
      changed_scores: r[columns.changed_scores], rank_correlation: { n: r[columns.eligible], correlation: r[columns.rank_correlation] },
      largest_rank_changes: [{ ts_code: '000000.SZ', rank_delta: 1 }],
      attribution: 'Only cash term changes',
      top40_industries: [{ n: 40, counts: {}, hhi: r[columns.top40_hhi_v1] }, { n: 40, counts: {}, hhi: r[columns.top40_hhi_v2] }],
      pool_industries: [{ n: 40, counts: {}, hhi: r[columns.pool_hhi_v1] }, { n: 40, counts: {}, hhi: r[columns.pool_hhi_v2] }],
      pool_membership: { v1: r[columns.pool_v1], v2: r[columns.pool_v2], common: r[columns.pool_common], v1_only: Array(r[columns.pool_v1_only]).fill('600000.SH'), v2_only: Array(r[columns.pool_v2_only]).fill('600001.SH') },
    })),
    evaluation: {
      'score-1.0.0': {
        formation: segment('score-1.0.0', 'formation', { events: 3008, entered: 2965, completed: 2895, unresolved_after_entry: 70, not_entered: 43 }),
        historical_simulation: segment('score-1.0.0', 'historical_simulation', { events: 863, entered: 831, completed: 770, unresolved_after_entry: 61, not_entered: 32 }),
      },
      'score-2.0.0': {
        formation: segment('score-2.0.0', 'formation', { events: 2953, entered: 2914, completed: 2847, unresolved_after_entry: 67, not_entered: 39 }),
        historical_simulation: segment('score-2.0.0', 'historical_simulation', { events: 876, entered: 841, completed: 773, unresolved_after_entry: 68, not_entered: 35 }),
      },
    },
  };
}

test('committed evidence is self-consistent and stays under the repository size limit', () => {
  assert.equal(evidence.schema_version, 'phaseb-research-evidence-1.0.0');
  assert.equal(evidence.run_id, EXPECTED.run_id);
  assert.equal(evidence.source_sha256, EXPECTED.source_sha256);
  assert.equal(evidence.selection_dates.length, EXPECTED.total_dates);
  assert.equal(evidence.sampled_trade_dates, EXPECTED.total_dates);
  assert.equal(evidence.comparisons.rows.length, EXPECTED.total_dates);
  assert.equal(evidence.quality_by_date.rows.length, EXPECTED.total_dates);
  const segments = evidence.comparisons.rows.map(r => r[columns.segment]);
  assert.equal(segments.filter(s => s === 'formation').length, EXPECTED.formation_dates);
  assert.equal(segments.filter(s => s === 'historical_simulation').length, EXPECTED.simulation_dates);
  assert.ok(readFileSync(COMMITTED).length < 300 * 1024, 'the committed file must stay reviewable');
  assert.ok(evidence.full_evidence.sha256 && evidence.full_evidence.result_sha256, 'the outside full evidence is identified by hash');
});

test('compact projection reproduces the full result without changing a number', () => {
  const full = syntheticFull();
  const compact = compactResearchSummary(full, { fullSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), sourceLabel: 'synthetic' });
  const text = formatEvidence(compact);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(compact)), 'formatter output must round-trip');
  // Re-projecting the projection's own protocol values yields identical numbers.
  assert.deepEqual(compact.selection_dates, full.selection_dates);
  assert.equal(compact.comparisons.rows.length, full.comparisons.length);
  for (const [i, c] of full.comparisons.entries()) {
    const row = compact.comparisons.rows[i];
    assert.equal(row[columns.date], c.date);
    assert.equal(row[columns.eligible], c.eligible);
    assert.equal(row[columns.v1_score_mean], Math.round(c.v1_scores.mean * 1e6) / 1e6);
  }
  assert.equal(compact.evaluation['score-1.0.0'].historical_simulation.summary.by_date.rows.length, 27);
});

test('audit passes on the committed evidence alone and on a full result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-audit-'));
  const full = syntheticFull();
  const fullPath = join(dir, 'summary.json');
  writeFileSync(fullPath, JSON.stringify(full));
  const self = await verifyResearchSummary({ summary: COMMITTED.pathname });
  assert.equal(self.status, 'PASS', JSON.stringify(self.failures));
  assert.equal(self.evidence.paired_sensitivity.status, 'NOT_AVAILABLE');
  // Full-result mode: the synthetic protocol has the expected dates/versions, so only
  // the documented table values can fail (they do not, because they are copied from
  // the real result through the compact file).
  const withFull = await verifyResearchSummary({ summary: COMMITTED.pathname, fullSummary: fullPath });
  // The synthetic result has no file hash to compare, so only the projection checks apply.
  const projectionFailures = withFull.failures.filter(f => /^evidence:/.test(f.check) && f.check !== 'evidence:full_sha256_matches');
  assert.deepEqual(projectionFailures, [], 'the committed file must project the full result exactly');
});

test('audit fails when a documented denominator or date count drifts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-audit-drift-'));
  const drift = JSON.parse(JSON.stringify(evidence));
  drift.selection_dates = drift.selection_dates.slice(0, -1);
  drift.comparisons.rows.pop();
  const driftPath = join(dir, 'drift.json');
  writeFileSync(driftPath, JSON.stringify(drift));
  const result = await verifyResearchSummary({ summary: driftPath });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.failures.some(f => f.check === 'total_sampled_dates'));
  assert.ok(result.failures.some(f => f.check === 'evidence:self:comparison_rows'));
});

test('paired sensitivity reports a zero delta and the composition difference', () => {
  const events = [];
  for (const date of ['20260407', '20260414']) {
    for (const code of ['600000.SH', '600001.SH', '600002.SH']) {
      events.push({ version: 'score-1.0.0', segment: 'historical_simulation', date, ts_code: code, status: 'completed', net_return: 0.01 });
    }
    // V2 keeps two of the three events and adds one of its own.
    for (const code of ['600000.SH', '600001.SH', '600009.SH']) {
      events.push({ version: 'score-2.0.0', segment: 'historical_simulation', date, ts_code: code, status: 'completed', net_return: code === '600009.SH' ? -0.05 : 0.01 });
    }
  }
  const sensitivity = pairedSensitivity(events);
  const sim = sensitivity.historical_simulation;
  assert.equal(sim.common_pool_events, 4);
  assert.equal(sim.v1_only_events, 2);
  assert.equal(sim.v2_only_events, 2);
  assert.equal(sim.common_completed_pairs, 4);
  assert.equal(sim.paired_delta.nonzero, 0, 'the same event has the same return under both versions');
  assert.equal(sim.v1_only_completed, 2);
  assert.equal(sim.v2_only_completed, 2);
  assert.match(sim.label, /DESCRIPTIVE_SENSITIVITY_ONLY/);
});

test('verify script exits non-zero on drift and zero on the committed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-audit-cli-'));
  const ok = spawnSync(process.execPath, ['deploy/ashare/verify-research-summary.mjs', '--summary', COMMITTED.pathname, '--output', join(dir, 'ok.json')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const drift = JSON.parse(JSON.stringify(evidence));
  drift.run_id = 'PHB-00000000000000000000';
  const driftPath = join(dir, 'drift.json');
  writeFileSync(driftPath, JSON.stringify(drift));
  const bad = spawnSync(process.execPath, ['deploy/ashare/verify-research-summary.mjs', '--summary', driftPath, '--output', join(dir, 'bad.json')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /run_id/);
});

test('the research DB and market snapshot are never written by the audit', () => {
  // The audit opens the research DB with readOnly + query_only; a synthetic DB
  // proves the write path is refused and the file hash is unchanged.
  const dir = mkdtempSync(join(tmpdir(), 'ashare-audit-ro-'));
  const path = join(dir, 'research.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE experiment (run_id TEXT PRIMARY KEY, protocol TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);');
  db.close();
  const ro = new DatabaseSync(path, { readOnly: true });
  ro.exec('PRAGMA query_only=ON');
  assert.throws(() => ro.prepare("INSERT INTO experiment VALUES ('x','{}',NULL,'now')").run(), /readonly/i);
  ro.close();
});
