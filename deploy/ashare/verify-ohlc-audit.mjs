#!/usr/bin/env node
// Phase B P0 (OHLC NULL detection) evidence against the frozen real-cache snapshot.
//
// Read-only: the snapshot is hashed before and after, opened with
// SQLite mode=ro&immutable=1 and query_only=ON. Nothing is written to it and no
// upstream request is made.
//
// Usage: node deploy/ashare/verify-ohlc-audit.mjs SNAPSHOT BASELINE_BUILD OUTPUT.json [DAYS] [DATES]
//   SNAPSHOT        frozen, checkpointed cache (e.g. ashare-20261016.sqlite)
//   BASELINE_BUILD  Phase B baseline build compiled from fc24fef (has ashare/analysis.js and engine.js)
//   OUTPUT          JSON evidence file
//   DAYS            optional, default 10 recent trade days to audit
//   DATES           optional, default 2 recent trade days for V1 parity
//
// Parity compares both scanMarket() (every row: score, rank, components,
// eligible, signals, state) and analyzeMarket() V1 rows between the baseline
// build and the fixed build. The only expected difference is the new anomaly
// counters in the quality block, which is reported separately and is not a
// scoring difference.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const build = name => new URL(`../../build/ashare/${name}`, import.meta.url).href;

/** Find the directory holding the built ashare modules (baseline may be a repo root). */
function moduleDir(input) {
  for (const p of [resolve(input, 'ashare'), resolve(input, 'build/ashare'), resolve(input)]) {
    if (existsSync(join(p, 'analysis.js')) && existsSync(join(p, 'engine.js'))) return p;
  }
  throw new Error(`No built ashare modules (analysis.js + engine.js) found under ${input}`);
}

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/** Scoring-relevant part of one analyzeMarket row. */
const scoringRow = r => ({
  ts_code: r.ts_code, eligible: r.eligible, ineligible_reason: r.ineligible_reason,
  score: r.score, rank: r.rank, raw: r.raw, normalized: r.normalized,
  components: r.components, contributions: r.contributions, factor_contributions: r.factor_contributions,
  scoring_factors: r.scoring_factors, signals: r.signals,
});

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
  const baseline = {
    analysis: await import(pathToFileURL(join(baselineDir, 'analysis.js')).href),
    engine: await import(pathToFileURL(join(baselineDir, 'engine.js')).href),
  };

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
    baseline: { modules: baselineDir, score_version: baseline.analysis.SCORE_VERSION, commit: 'fc24fefd3a502646b47020947fc13d30f06f908e' },
    limitations: [
      'The snapshot is the frozen 2026-10-16 cache; this proves the pre-fix V1 output is unchanged where the cache has no NULL/invalid bar, not that no upstream day ever produces one.',
      'NULL detection itself is covered by test/ashare-ohlc-audit.test.mjs on a synthetic market.',
      'Parity covers scanMarket rows and analyzeMarket V1 rows; the new quality anomaly counters (null_ohlc, null_vol, null_amount, invalid_bar) are reported separately because they are additive evidence, not scoring output.',
    ],
    audit: { days: [], null_counts: {}, invalid_bars: 0, statuses: {} },
    parity: { scan: {}, analyze: {}, differences: [], compared_eligible: 0 },
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

    // 1b. Whole cache, every stored day: the NULL-safe predicate must not find a
    //     single invalid or NULL bar anywhere. This is a single indexed scan of
    //     `daily`; it proves the clean-data claim for the full history, not just
    //     the recent audit window.
    const whole = db.prepare(`SELECT COUNT(*) n FROM daily WHERE ${INVALID_BAR_SQL}`).get().n;
    result.audit.whole_cache = {
      daily_rows: db.prepare('SELECT COUNT(*) n FROM daily').get().n,
      invalid_bars: whole,
      first_date: db.prepare('SELECT MIN(trade_date) d FROM daily').get().d,
      last_date: db.prepare('SELECT MAX(trade_date) d FROM daily').get().d,
    };
    if (whole !== 0) fail(`${whole} invalid/NULL bars found in the whole cache`);

    // 2. V1 parity against the Phase B baseline build (fc24fef), on the most
    //    recent dates: scanMarket for every row and analyzeMarket V1 rows.
    const parityDates = recentTradeDays(db, end, dates);
    result.parity.scan = {};
    result.parity.analyze = {};
    for (const date of parityDates) {
      const t = Date.now();
      const beforeScan = baseline.analysis.scanMarket(db, date);
      const baselineMs = Date.now() - t;
      const t2 = Date.now();
      const afterScan = scanMarket(db, date);
      const candidateMs = Date.now() - t2;
      const eligible = beforeScan.rows.filter(r => r.eligible);

      // scanMarket: identical serialized output (every row: score, rank,
      // components, eligible, signals, technical state, sectors).
      const scanDifferences = [];
      const scanByCode = new Map(afterScan.rows.map(r => [r.ts_code, JSON.stringify(r)]));
      for (const r of beforeScan.rows) {
        const c = scanByCode.get(r.ts_code);
        if (c === undefined) scanDifferences.push({ ts_code: r.ts_code, field: 'row', baseline: 'present', candidate: 'missing' });
        else if (c !== JSON.stringify(r)) scanDifferences.push({ ts_code: r.ts_code, field: 'row', baseline: 'differs', candidate: 'differs' });
      }
      const scanMeta = {
        rows: beforeScan.rows.length === afterScan.rows.length,
        sectors: JSON.stringify(beforeScan.sectors) === JSON.stringify(afterScan.sectors),
        signal_counts: JSON.stringify(beforeScan.signal_counts) === JSON.stringify(afterScan.signal_counts),
        suspended_or_missing: beforeScan.suspended_or_missing === afterScan.suspended_or_missing,
      };

      // analyzeMarket: V1 scoring rows must be identical; the only expected
      // change in the response is the new anomaly counters in the quality block.
      const t3 = Date.now();
      const beforeSnap = baseline.engine.analyzeMarket(db, { date, score_version: SCORE_VERSION });
      const baselineAnalyzeMs = Date.now() - t3;
      const t4 = Date.now();
      const afterSnap = analyzeMarket(db, { date, score_version: SCORE_VERSION });
      const candidateAnalyzeMs = Date.now() - t4;
      const beforeRows = new Map(beforeSnap.rows.map(r => [r.ts_code, JSON.stringify(scoringRow(r))]));
      const analyzeDifferences = [];
      for (const r of afterSnap.rows) {
        const b = beforeRows.get(r.ts_code);
        if (b === undefined) analyzeDifferences.push({ ts_code: r.ts_code, field: 'row', baseline: 'missing', candidate: 'present' });
        else if (b !== JSON.stringify(scoringRow(r))) analyzeDifferences.push({ ts_code: r.ts_code, field: 'row', baseline: 'differs', candidate: 'differs' });
      }
      for (const code of beforeRows.keys()) if (!afterSnap.rows.some(r => r.ts_code === code)) analyzeDifferences.push({ ts_code: code, field: 'row', baseline: 'present', candidate: 'missing' });
      const qualityKeys = new Set([...Object.keys(beforeSnap.quality.anomalies), ...Object.keys(afterSnap.quality.anomalies)]);
      const addedAnomalyKeys = Object.keys(afterSnap.quality.anomalies).filter(k => !(k in beforeSnap.quality.anomalies));
      const qualityStable = ['status', 'cache_status', 'reasons', 'counts', 'coverage', 'indices_present'].every(k => JSON.stringify(beforeSnap.quality[k]) === JSON.stringify(afterSnap.quality[k]));
      const sharedAnomalies = Object.fromEntries([...qualityKeys].filter(k => k in beforeSnap.quality.anomalies && k in afterSnap.quality.anomalies)
        .map(k => [k, beforeSnap.quality.anomalies[k] === afterSnap.quality.anomalies[k]]));
      const universeStable = JSON.stringify(beforeSnap.universe) === JSON.stringify(afterSnap.universe)
        && beforeSnap.count === afterSnap.count && beforeSnap.score_version === afterSnap.score_version;

      result.parity.scan[date] = {
        trade_date: date,
        scanned: { baseline: beforeScan.rows.length, candidate: afterScan.rows.length },
        eligible: eligible.length,
        differences: scanDifferences.length,
        meta: scanMeta,
        baseline_ms: baselineMs, candidate_ms: candidateMs,
      };
      result.parity.analyze[date] = {
        trade_date: date,
        rows: { baseline: beforeSnap.rows.length, candidate: afterSnap.rows.length },
        eligible: { baseline: beforeSnap.universe.eligible, candidate: afterSnap.universe.eligible },
        differences: analyzeDifferences.length,
        universe_stable: universeStable,
        quality_stable: qualityStable,
        shared_anomalies_equal: Object.values(sharedAnomalies).every(Boolean),
        added_anomaly_keys: addedAnomalyKeys,
        null_quality_codes: sourceQualityForDate(db, date).size,
        baseline_ms: baselineAnalyzeMs, candidate_ms: candidateAnalyzeMs,
      };
      result.parity.differences.push(
        ...scanDifferences.map(d => ({ trade_date: date, api: 'scanMarket', ...d })),
        ...analyzeDifferences.map(d => ({ trade_date: date, api: 'analyzeMarket', ...d })),
      );
      result.parity.compared_eligible += eligible.length;
      if (!scanMeta.rows || !scanMeta.sectors || !scanMeta.signal_counts || !scanMeta.suspended_or_missing) fail(`${date}: scanMarket output differs from the fc24fef baseline`);
      if (scanDifferences.length) fail(`${date}: scanMarket rows differ from the fc24fef baseline`);
      if (analyzeDifferences.length) fail(`${date}: analyzeMarket V1 rows differ from the fc24fef baseline`);
      if (!universeStable) fail(`${date}: analyzeMarket universe/count differs from the fc24fef baseline`);
      if (!qualityStable || !Object.values(sharedAnomalies).every(Boolean)) fail(`${date}: existing quality fields differ from the fc24fef baseline`);
    }
    if (result.parity.differences.length) fail('V1 output differences against the fc24fef baseline');
    result.parity.difference_count = result.parity.differences.length;
    result.parity.difference_sample = result.parity.differences.slice(0, 20);
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
  const [snapshot, baselineBuild, output, days, dates] = process.argv.slice(2);
  if (!snapshot || !baselineBuild || !output) throw new Error('Usage: node verify-ohlc-audit.mjs SNAPSHOT BASELINE_BUILD OUTPUT.json [DAYS] [DATES]');
  const result = await verifyOhlcAudit({ snapshot, baselineBuild, output, days: days ? Number(days) : 10, dates: dates ? Number(dates) : 2 });
  console.error(`${result.status}: ${result.audit.window.trade_days} audit days, null bars ${result.audit.null_total}, ` +
    `V1 parity ${result.parity.difference_count} differences across ${result.parity.compared_eligible} eligible stock-days; evidence ${output}`);
  if (result.status !== 'PASS') process.exitCode = 1;
}
