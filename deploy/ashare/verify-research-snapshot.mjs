#!/usr/bin/env node
// Forward research snapshot evidence on the frozen real-cache snapshot.
// Opens the snapshot read-only, writes only to a temporary research snapshot
// database, and proves:
//   - the source file SHA256 is unchanged before/after;
//   - a 20261016 snapshot matches the formal live stock_score exactly (V1 parity);
//   - a second run returns EXISTS with identical stored JSON and the same id;
//   - research-evaluate at asOf=20261016 stays PENDING for the 10-day horizon;
//   - 20261019 is PENDING (after the data cutoff) and writes nothing.
//
// Usage: node deploy/ashare/verify-research-snapshot.mjs SNAPSHOT OUTPUT.json
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

const EXPECTED_SHA = 'ac31a9eb0b65c756758e2af6bb97ec718775ae030454fbcadfc5a8d19e234dd1';
const DATE = '20261016';
const NEXT = '20261019';
const REPORT_ID = 'ASR-20261016-20261016163620-ddd0d0';
const HORIZON = 10;

const snapshotPath = resolve(process.argv[2] ?? '/home/jcshi/ashare-research/ashare-20261016.sqlite');
const outputPath = resolve(process.argv[3] ?? 'docs/ashare-samples/phaseb-forward-snapshot-real-cache.json');
if (!existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

const workDir = mkdtempSync(join(tmpdir(), 'fwd-snapshot-'));
process.env.ASHARE_DB_PATH = snapshotPath;
process.env.ASHARE_DATA_DIR = workDir;
const { runResearchSnapshot, runResearchEvaluate, researchSnapshotDbPath } = await import(new URL('../../build/ashare/snapshot.js', import.meta.url).href);
const snapDb = join(workDir, 'forward-observations.sqlite');

const out = { snapshot: snapshotPath, expected_sha256: EXPECTED_SHA, started_at: new Date().toISOString(), checks: {} };
const pass = (name, ok, detail = {}) => {
  out.checks[name] = { ok: !!ok, ...detail };
  console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 1000)}`);
};

const shaBefore = await fileHash(snapshotPath);
const statBefore = statSync(snapshotPath);
out.snapshot_sha256_before = shaBefore;
pass('source_sha256_matches_frozen_snapshot', shaBefore === EXPECTED_SHA, { actual: shaBefore });

const readonly = new DatabaseSync(snapshotPath, { readOnly: true });
let writeRefused = false;
try { readonly.exec('CREATE TABLE __probe (x INTEGER)'); } catch { writeRefused = true; }
readonly.close();
pass('snapshot_write_refused', writeRefused);

// ---------------------------------------------------------------- snapshot
const t0 = Date.now();
const first = runResearchSnapshot({ date: DATE, dbPath: snapDb, horizon: HORIZON });
out.snapshot_seconds = Math.round((Date.now() - t0) / 1000);
out.snapshot = { ...first };
pass('snapshot_original', first.status === 'ORIGINAL', { status: first.status, snapshot_id: first.snapshot_id });
pass('snapshot_report_reference', first.report_id === REPORT_ID, { report_id: first.report_id, expected: REPORT_ID });
pass('snapshot_quality_ready', first.quality_status === 'READY', { quality_status: first.quality_status });
pass('v1_parity_against_live_stock_score', first.v1_parity?.ok === true, { ...first.v1_parity });

const read = new DatabaseSync(snapDb, { readOnly: true });
const storedRow = read.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id);
const content = JSON.parse(storedRow.content);
read.close();
out.snapshot.content_digest = storedRow.content_digest;
out.snapshot.content_bytes = Buffer.byteLength(storedRow.content);
pass('v1_pool_is_formal_live_watchlist', content.v1_pool.source === 'formal_live_watchlist' && content.v1_pool.count > 0,
  { source: content.v1_pool.source, count: content.v1_pool.count });
pass('v2_pool_is_research_sequential', content.v2_pool.source === 'research_v2_sequential' && content.v2_pool.count > 0,
  { source: content.v2_pool.source, count: content.v2_pool.count, previous_date: content.v2_pool.previous_date });
out.snapshot.pool_diff = { common: content.pool_diff.common.length, v1_only: content.pool_diff.v1_only.length, v2_only: content.pool_diff.v2_only.length };
out.snapshot.v1_v2 = { changed_scores: content.v1_v2.changed_scores, score_delta: content.v1_v2.score_delta, rank_correlation: content.v1_v2.rank_correlation };
out.snapshot.universe = content.universe;
out.snapshot.versions = content.versions;
out.snapshot.build_sha256 = content.build_sha256;
out.snapshot.future_returns = content.future_returns;

// ---------------------------------------------------------------- determinism
const second = runResearchSnapshot({ date: DATE, dbPath: snapDb, horizon: HORIZON });
pass('second_run_exists', second.status === 'EXISTS', { status: second.status, snapshot_id: second.snapshot_id });
pass('snapshot_id_deterministic', second.snapshot_id === first.snapshot_id && second.recomputed_snapshot_id === first.snapshot_id,
  { stored: second.snapshot_id, recomputed: second.recomputed_snapshot_id });
pass('stored_content_identical', second.content_matches_stored === true && second.content_digest === first.content_digest,
  { stored: second.content_digest, recomputed: first.content_digest });

const afterExists = new DatabaseSync(snapDb, { readOnly: true });
const rows = afterExists.prepare('SELECT * FROM snapshot').all();
const memberCount = afterExists.prepare('SELECT version, COUNT(*) n FROM snapshot_member GROUP BY version ORDER BY version').all().map(r => ({ ...r }));
const factorCount = afterExists.prepare('SELECT COUNT(*) n FROM snapshot_factor').get().n;
afterExists.close();
pass('single_snapshot_row_after_rerun', rows.length === 1, { rows: rows.length });
out.snapshot.member_counts = memberCount;
out.snapshot.factor_rows = factorCount;

// ---------------------------------------------------------------- evaluate (pending)
const pending = runResearchEvaluate({ date: DATE, dbPath: snapDb, asOf: DATE, horizon: HORIZON });
const pendingVersions = pending.snapshots.map(s => Object.entries(s.versions).map(([version, v]) => ({
  snapshot_id: s.snapshot_id, version, status: v.status, completed: v.denominators.completed,
  entered: v.denominators.entered, events: v.denominators.events, net_return_mean: v.net_return.mean,
})));
out.evaluate_as_of_cutoff = { status: pending.status, as_of: pending.as_of, horizon: pending.horizon, matured: pending.matured,
  planned_exit_date: pending.planned_exit_date, versions: pendingVersions.flat() };
pass('evaluate_pending_before_horizon', pending.matured === false
  && pendingVersions.flat().length === 2
  && pendingVersions.flat().every(v => v.status === 'PENDING' && v.completed === 0 && v.net_return_mean === null),
  { planned_exit_date: pending.planned_exit_date, versions: pendingVersions.flat() });

// ---------------------------------------------------------------- 20261019 pending
const evalDb = new DatabaseSync(snapDb, { readOnly: true });
const rowsBefore = evalDb.prepare('SELECT COUNT(*) n FROM snapshot').get().n;
const poolBefore = evalDb.prepare('SELECT COUNT(*) n FROM pool_state').get().n;
evalDb.close();
const future = runResearchSnapshot({ date: NEXT, dbPath: snapDb, horizon: HORIZON });
const evalDb2 = new DatabaseSync(snapDb, { readOnly: true });
const rowsAfter = evalDb2.prepare('SELECT COUNT(*) n FROM snapshot').get().n;
const poolAfter = evalDb2.prepare('SELECT COUNT(*) n FROM pool_state').get().n;
evalDb2.close();
out.pending_20261019 = future;
pass('future_trade_day_pending', future.status === 'PENDING' && future.data_cutoff === DATE, future);
pass('pending_writes_nothing', rowsBefore === rowsAfter && poolBefore === poolAfter, { rows: [rowsBefore, rowsAfter], pool_state: [poolBefore, poolAfter] });

// ---------------------------------------------------------------- immutability of source
const shaAfter = await fileHash(snapshotPath);
const statAfter = statSync(snapshotPath);
out.snapshot_sha256_after = shaAfter;
pass('source_sha256_unchanged', shaAfter === shaBefore, { before: shaBefore, after: shaAfter });
pass('source_file_stat_unchanged', statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs,
  { size: [statBefore.size, statAfter.size], mtime_ms: [statBefore.mtimeMs, statAfter.mtimeMs] });

out.ok = Object.values(out.checks).every(c => c.ok);
out.finished_at = new Date().toISOString();
out.temp_snapshot_db = snapDb;
out.reproduce = `node deploy/ashare/verify-research-snapshot.mjs ${snapshotPath} ${outputPath}`;
writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.error(`${out.ok ? 'ALL PASS' : 'FAILURES'} ${outputPath}`);
if (!out.ok) process.exitCode = 1;
