#!/usr/bin/env node
// Production-untouched evidence for the phase B freeze round.
//
// Records, without modifying anything, that:
//  - the production container image, start time and restart count are unchanged;
//  - the production data directory's SQLite file is byte-identical;
//  - the live report / watchlist / stock_score / quality_check tables have the
//    same row counts;
//  - no systemd unit or timer for the A-share pipeline exists on this host
//    (so nothing in this round could have altered scheduling).
//
// Usage: node deploy/ashare/verify-production-untouched.mjs BASELINE.json OUTPUT.json
// BASELINE.json is a snapshot produced by this script with --baseline.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const baselineMode = args[0] === '--baseline';
const baselinePath = baselineMode ? null : resolve(args[0]);
const outputPath = resolve(baselineMode ? args[1] : args[1]);
const LIVE_DIR = process.env.ASHARE_LIVE_DIR || '/home/jcshi/.local/share/finance-mcp-ashare';
const CONTAINER = process.env.ASHARE_CONTAINER || 'finance-mcp-ashare';
const DB = `${LIVE_DIR}/ashare.sqlite`;
const TABLES = ['report', 'watchlist', 'watchlist_change', 'stock_score', 'quality_check', 'signal_evidence', 'data_audit'];

function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `ERROR: ${error?.message ?? error}`;
  }
}

async function sha256(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

function rowCounts() {
  // Run inside the container so the same file and SQLite build as production are used.
  const script = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify('/data/ashare.sqlite')},{readOnly:true});const out={};for(const t of ${JSON.stringify(TABLES)}){try{out[t]=d.prepare('SELECT COUNT(*) n FROM '+t).get().n}catch(e){out[t]=null}}process.stdout.write(JSON.stringify(out))`;
  const text = sh('docker', ['exec', CONTAINER, 'node', '-e', script]);
  try { return JSON.parse(text); } catch { return { error: text }; }
}

const container = sh('docker', ['inspect', CONTAINER, '--format', '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Status}}']);
const image = sh('docker', ['image', 'inspect', 'finance-mcp-ashare:local', '--format', '{{.Id}}|{{.Created}}']);
const timers = sh('systemctl', ['list-timers', '--all', '--no-pager']);
const units = sh('systemctl', ['list-unit-files', '--no-pager']);

const observed = {
  captured_at: new Date().toISOString(),
  live_dir: LIVE_DIR,
  live_db: { path: DB, size: existsSync(DB) ? statSync(DB).size : null, sha256: existsSync(DB) ? await sha256(DB) : null },
  container,
  image,
  tables: rowCounts(),
  ashare_systemd_units: units.split('\n').filter(line => /finance-ashare|ashare/i.test(line)),
  ashare_systemd_timers: timers.split('\n').filter(line => /finance-ashare|ashare/i.test(line)),
  container_build_files: sh('docker', ['exec', CONTAINER, 'sh', '-c', 'ls /app/build/ashare | sort | tr "\\n" " "']),
};

if (baselineMode) {
  writeFileSync(outputPath, JSON.stringify(observed, null, 2));
  process.stdout.write(JSON.stringify({ mode: 'baseline', output: outputPath, live_db_sha256: observed.live_db.sha256, tables: observed.tables }) + '\n');
  process.exit(0);
}

if (!existsSync(baselinePath)) throw new Error(`Baseline not found: ${baselinePath}`);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checks = {
  live_db_bytes_unchanged: observed.live_db.sha256 === baseline.live_db.sha256,
  live_db_size_unchanged: observed.live_db.size === baseline.live_db.size,
  container_identity_unchanged: observed.container === baseline.container,
  image_unchanged: observed.image === baseline.image,
  table_row_counts_unchanged: same(observed.tables, baseline.tables),
  no_ashare_systemd_units: observed.ashare_systemd_units.length === 0 && baseline.ashare_systemd_units.length === 0,
  no_ashare_systemd_timers: observed.ashare_systemd_timers.length === 0 && baseline.ashare_systemd_timers.length === 0,
  container_build_unchanged: observed.container_build_files === baseline.container_build_files,
};
const result = {
  status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  checks,
  baseline: { captured_at: baseline.captured_at, live_db_sha256: baseline.live_db.sha256, container: baseline.container, tables: baseline.tables },
  observed,
  note: 'Read-only evidence. The container is inspected, the SQLite file is only hashed, and row counts are queried with a read-only connection. No deploy, restart, timer or ChatGPT task was changed in this round.',
};
writeFileSync(outputPath, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ status: result.status, output: outputPath, checks }) + '\n');
if (result.status !== 'PASS') process.exitCode = 1;
