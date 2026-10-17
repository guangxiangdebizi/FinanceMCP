#!/usr/bin/env node
// Phase B P0 (OHLC NULL detection) evidence against the frozen real-cache snapshot.
//
// Read-only: the snapshot is hashed before and after, opened with
// SQLite mode=ro&immutable=1 and query_only=ON. Nothing is written to it and no
// upstream request is made.
//
// Usage: node deploy/ashare/verify-ohlc-audit.mjs SNAPSHOT BASELINE_BUILD OUTPUT.json [DAYS]
//   SNAPSHOT        frozen, checkpointed cache (e.g. ashare-20261016.sqlite)
//   BASELINE_BUILD  pre-fix build compiled from e8cbe4a (has ashare/analysis.js)
//   OUTPUT          JSON evidence file
//   DAYS            optional, default 10 recent trade days to audit
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const build = name => new URL(`../../build/ashare/${name}`, import.meta.url).href;

/** Baseline builds predate engine.js; find the directory holding analysis.js. */
function moduleDir(input) {
  for (const p of [resolve(input, 'ashare'), resolve(input, 'build/ashare'), resolve(input)]) {
    if (existsSync(join(p, 'analysis.js'))) return p;
  }
  throw new Error(`No built ashare modules found under ${input}`);
}

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

export async function verifyOhlcAudit({ snapshot, baselineBuild, output, days = 10, dates = 2 }) {
  snapshot = resolve(snapshot);
  output = resolve(output);
  const baselineDir = moduleDir(baselineBuild);
  if (baselineDir.startsWith(resolve('build'))) throw new Error('Baseline build must be a distinct pre-fix build');
  if (output === snapshot) throw new Error('Output must not overwrite the snapshot');
  const wal = `${snapshot}-wal`;
  if (existsSync(wal) && statSync(wal).size !== 0) throw new Error('Snapshot has an uncheckpointed WAL; supply a frozen, checkpointed database');

  const { auditDay, AUDIT_VERSION } = await import(build('audit.js'));
  const { checkQuality, INVALID_BAR_SQL, INVALID_BAR_KINDS, recentTradeDays } = await import(build('ingest.js'));
  const { analyzeMarket, sourceQualityForDate } = await import(build('engine.js'));
  const { scanMarket, SCORE_VERSION } = await import(build('analysis.js'));
  const baseline = await import(pathToFileURL(join(baselineDir, 'analysis.js')).href);

  const sha256Before = await fileHash(snapshot);
  const uri = pathToFileURL(snapshot);
  uri.search = 'mode=ro&immutable=1';
  const db = new DatabaseSync(uri.href, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 2147483648;');

  const result = {
    schema_version: 'ohlc-audit-evidence-1.0.0', status: 'PENDING', started_at: new Date().toISOString(),
    command: `node deploy/ashare/verify-ohlc-audit.mjs ${[snapshot, baselineDir, output].map(x => `'${x.replaceAll("'", "'\\''")}'`).join(' ')}`,
    node_version: process.version,
    snapshot: { path: snapshot, bytes: statSync(snapshot).size, sha256_before: sha256Before, access: 'SQLite mode=ro&immutable=1; query_only=ON' },
    candidate: { modules: fileURLToPath(new URL('../../build/ashare/', import.meta.url)), audit_version: AUDIT_VERSION, score_version: SCORE_VERSION },
    baseline: { modules: baselineDir, score_version: baseline.SCORE_VERSION },
    limitations: [
      'The snapshot is the frozen 2026-10-16 cache; this proves the pre-fix V1 output is unchanged where the cache has no NULL/invalid bar, not that no upstream day ever produces one.',
      'NULL detection itself is covered by test/ashare-ohlc-audit.test.mjs on a synthetic market.',
    ],
    audit: { days: [], null_counts: {}, invalid_bars: 0, statuses: {} },
    parity: { dates: [], differences: [], compared_eligible: 0 },
  };
  const fail = reason => { result.status = 'FAIL'; result.reason = reason; };

  try {
    // 1. Recent trade days: no NULL OHLC/vol/amount and no invalid bar.
    const end = (db.prepare('SELECT MAX(trade_date) d FROM daily').get()).d;
    const tradeDays = recentTradeDays(db, end, days);
    result.audit.window = { start: tradeDays[0], end: tradeDays.at(-1), trade_days: tradeDays.length };
    const nullCounts = Object.fromEntries(Object.keys(INVALID_BAR_KINDS).map(k => [k, 0]));
    for (const day of tradeDays) {
      const t = Date.now();
      const a = auditDay(db, day);
      const q = checkQuality(db, day, false);
      const rows = db.prepare('SELECT COUNT(*) n FROM daily WHERE trade_date = ?').get(day).n;
      result.audit.days.push({
        trade_date: day, daily_rows: rows, audit_status: a.status, invalid_bars: a.invalid_bars,
        invalid_bar_kinds: a.invalid_bar_kinds, quality_status: q.status,
        quality_anomalies: { ...q.anomalies }, issues: a.issues, reasons: q.reasons, ms: Date.now() - t,
      });
      result.audit.invalid_bars += a.invalid_bars;
      result.audit.statuses[day] = { audit: a.status, quality: q.status };
      for (const k of Object.keys(nullCounts)) nullCounts[k] += a.invalid_bar_kinds[k];
    }
    result.audit.null_counts = nullCounts;
    const nullTotal = nullCounts.null_open + nullCounts.null_high + nullCounts.null_low + nullCounts.null_close + nullCounts.null_vol + nullCounts.null_amount;
    result.audit.null_total = nullTotal;
    result.audit.sql_invalid_bars_in_window = db.prepare(
      `SELECT COUNT(*) n FROM daily WHERE trade_date BETWEEN ? AND ? AND ${INVALID_BAR_SQL}`).get(result.audit.window.start, end).n;
    if (nullTotal !== 0) fail('NULL OHLC/vol/amount found in the audit window');
    if (result.audit.invalid_bars !== 0) fail('invalid bars found in the audit window');

    // 2. V1 parity: candidate analyzeMarket vs the pre-fix baseline scan, for
    //    every eligible stock, on the most recent dates.
    const parityDates = recentTradeDays(db, end, dates);
    for (const date of parityDates) {
      const t = Date.now();
      const before = baseline.scanMarket(db, date);
      const baselineMs = Date.now() - t;
      const t2 = Date.now();
      const after = analyzeMarket(db, { date, score_version: SCORE_VERSION });
      const candidateMs = Date.now() - t2;
      const eligible = before.rows.filter(r => r.eligible);
      const byCode = new Map(after.rows.map(r => [r.ts_code, r]));
      const differences = [];
      for (const r of eligible) {
        const c = byCode.get(r.ts_code);
        if (!c) { differences.push({ ts_code: r.ts_code, field: 'row', baseline: 'present', candidate: 'missing' }); continue; }
        if (c.score !== r.score) differences.push({ ts_code: r.ts_code, field: 'score', baseline: r.score, candidate: c.score });
        if (c.rank !== r.rank) differences.push({ ts_code: r.ts_code, field: 'rank', baseline: r.rank, candidate: c.rank });
      }
      const candidateEligible = after.rows.filter(r => r.eligible).length;
      result.parity.dates.push({
        trade_date: date,
        scanned: { baseline: before.rows.length, candidate: after.rows.length },
        eligible: { baseline: eligible.length, candidate: candidateEligible },
        baseline_ms: baselineMs, candidate_ms: candidateMs,
        differences: differences.length,
        null_quality_codes: sourceQualityForDate(db, date).size,
      });
      result.parity.differences.push(...differences.map(d => ({ trade_date: date, ...d })));
      result.parity.compared_eligible += eligible.length;
      if (candidateEligible !== eligible.length) fail(`${date}: eligible universe changed`);
    }
    if (result.parity.differences.length) fail('V1 score/rank differences against the pre-fix baseline');
    result.parity.difference_count = result.parity.differences.length;

    // 3. Candidate scanMarket must equal the baseline scan exactly (no scan-level drift).
    result.parity.scan_identical = {};
    for (const date of parityDates) {
      const b = JSON.stringify(baseline.scanMarket(db, date));
      const c = JSON.stringify(scanMarket(db, date));
      result.parity.scan_identical[date] = b === c;
      if (b !== c) fail(`${date}: scanMarket output differs from the pre-fix baseline`);
    }
  } finally {
    db.close();
  }

  result.snapshot.sha256_after = await fileHash(snapshot);
  result.snapshot.unchanged = sha256Before === result.snapshot.sha256_after;
  if (!result.snapshot.unchanged) fail('snapshot hash changed during verification');
  result.completed_at = new Date().toISOString();
  if (result.status === 'PENDING') result.status = 'PASS';
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  const [snapshot, baselineBuild, output, days] = process.argv.slice(2);
  if (!snapshot || !baselineBuild || !output) throw new Error('Usage: node verify-ohlc-audit.mjs SNAPSHOT BASELINE_BUILD OUTPUT.json [DAYS]');
  const result = await verifyOhlcAudit({ snapshot, baselineBuild, output, days: days ? Number(days) : 10 });
  console.error(`${result.status}: ${result.audit.window.trade_days} audit days, null bars ${result.audit.null_total}, ` +
    `V1 parity ${result.parity.difference_count} differences across ${result.parity.compared_eligible} eligible stock-days; evidence ${output}`);
  if (result.status !== 'PASS') process.exitCode = 1;
}
