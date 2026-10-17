#!/usr/bin/env node
// Measure `ashare_factor_snapshot` latency, CPU and response size on the frozen
// real cache. This only measures: it adds no cache layer and changes no scan
// code. Each call recomputes the full-market universe (about 5.5k scanned
// stocks) before filtering to the requested 1/5/20 codes, so the per-call cost
// is expected to be roughly flat in the requested count.
//
// Read-only: getAshareDb() opens the snapshot readOnly, a write is asserted to
// be refused, and the whole-file SHA256 is compared before and after.
//
// Usage: node deploy/ashare/verify-factor-performance.mjs SNAPSHOT OUTPUT.json [DATE]
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATE = '20261016';
const LIVE_DIR = /finance-mcp-ashare\/?$/;
const COUNTS = [1, 5, 20];
const WARMUPS = 1;
const RUNS = 3;

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
const round = (v, d = 2) => typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v;
const median = values => {
  const v = [...values].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const maxRssMb = () => process.resourceUsage().maxRSS / 1024;

export async function verifyFactorPerformance({ snapshot, output, date = DEFAULT_DATE, counts = COUNTS }) {
  snapshot = resolve(snapshot);
  output = resolve(output);
  if (!existsSync(snapshot)) throw new Error(`Snapshot not found: ${snapshot}`);
  if (LIVE_DIR.test(resolve(snapshot, '..'))) throw new Error('Refusing to run against the live data directory; supply the frozen research snapshot');
  if (existsSync(`${snapshot}-wal`) && statSync(`${snapshot}-wal`).size !== 0) throw new Error('Snapshot has an uncheckpointed WAL; supply a frozen, checkpointed database');

  const result = {
    schema_version: 'factor-performance-evidence-1.0.0',
    status: 'PENDING',
    date,
    command: `node deploy/ashare/verify-factor-performance.mjs '${snapshot}' '${output}' '${date}'`,
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu_model: (await import('node:os')).cpus()[0]?.model ?? null,
    method: {
      warmup_runs: WARMUPS, measured_runs: RUNS, statistic: 'median of measured runs',
      cpu: 'process.cpuUsage() delta (user + system) around each call; single-threaded Node process',
      peak_rss: 'process.resourceUsage().maxRSS high-water mark of this process (Linux: KiB -> MB)',
      response_bytes: 'UTF-8 byte length of the MCP tool result text (JSON, include_components=true)',
      caveat: 'Each call recomputes the full-market scan and normalization (~5.5k stocks) before filtering to the requested codes; per-call cost is therefore dominated by the universe, not the requested count.',
    },
    snapshot: { path: snapshot, file: basename(snapshot), bytes: statSync(snapshot).size, sha256_before: await fileHash(snapshot) },
    requests: [],
    checks: {},
    failures: [],
  };
  const check = (name, ok, detail) => {
    result.checks[name] = ok;
    if (!ok) result.failures.push({ check: name, ...detail });
    return ok;
  };

  process.env.ASHARE_DB_PATH = snapshot;
  const buildDir = new URL('../../build/ashare/', import.meta.url);
  const { getAshareDb, closeAshareDb } = await import(new URL('db.js', buildDir).href);
  const { runAshareTool } = await import(new URL('tools.js', buildDir).href);
  const { SCORE_VERSION } = await import(new URL('analysis.js', buildDir).href);
  const { ENGINE_VERSION, FACTOR_VERSION, FACTOR_SNAPSHOT_MAX_CODES } = await import(new URL('engine.js', buildDir).href);
  result.versions = { score_version: SCORE_VERSION, engine_version: ENGINE_VERSION, factor_version: FACTOR_VERSION };

  const db = getAshareDb();
  try {
    // Deterministic code list: liquid stocks with a valuation observation, in ts_code order.
    const universe = db.prepare('SELECT ts_code FROM daily_basic WHERE trade_date = ? AND pe_ttm IS NOT NULL ORDER BY ts_code')
      .all(date).map(r => r.ts_code);
    if (universe.length < Math.max(...counts)) throw new Error(`Not enough priced stocks on ${date}`);
    result.universe = { priced_on_date: universe.length };

    const measure = async (tsCodes, { measured }) => {
      const before = process.cpuUsage();
      const rssBefore = maxRssMb();
      const started = process.hrtime.bigint();
      const response = await runAshareTool('ashare_factor_snapshot', { date, ts_codes: tsCodes, score_version: SCORE_VERSION, include_components: true });
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const cpu = process.cpuUsage(before);
      const text = response.content[0].text;
      return {
        measured, wall_ms: round(wallMs), cpu_ms: round((cpu.user + cpu.system) / 1000),
        cpu_user_ms: round(cpu.user / 1000), cpu_system_ms: round(cpu.system / 1000),
        rss_mb_before: round(rssBefore), rss_peak_mb: round(maxRssMb()),
        response_bytes: Buffer.byteLength(text), response_sha256: createHash('sha256').update(text).digest('hex'),
        returned: JSON.parse(text).count,
      };
    };

    const totalChangesBefore = db.prepare('SELECT total_changes() n').get().n;
    for (const count of counts) {
      const tsCodes = universe.slice(0, count);
      const request = { count, ts_codes: tsCodes, warmup: [], runs: [], median: null };
      for (let i = 0; i < WARMUPS; i++) request.warmup.push(await measure(tsCodes, { measured: false }));
      for (let i = 0; i < RUNS; i++) request.runs.push(await measure(tsCodes, { measured: true }));
      const wall = request.runs.map(r => r.wall_ms), cpu = request.runs.map(r => r.cpu_ms), bytes = request.runs.map(r => r.response_bytes);
      request.median = {
        wall_ms: round(median(wall)), cpu_ms: round(median(cpu)), response_bytes: Math.round(median(bytes)),
        wall_ms_min: round(Math.min(...wall)), wall_ms_max: round(Math.max(...wall)),
        peak_rss_mb: round(Math.max(...request.runs.map(r => r.rss_peak_mb))),
      };
      request.deterministic = new Set(request.runs.map(r => r.response_sha256)).size === 1 && new Set(bytes).size === 1;
      request.returned_matches = request.runs.every(r => r.returned === count);
      check(`deterministic:${count}`, request.deterministic, { sha256: [...new Set(request.runs.map(r => r.response_sha256))] });
      check(`returned_count:${count}`, request.returned_matches, { returned: request.runs.map(r => r.returned) });
      result.requests.push(request);
      console.error(`${count} codes: median ${request.median.wall_ms} ms wall, ${request.median.cpu_ms} ms CPU, ${request.median.response_bytes} bytes`);
    }

    check('bounded_max_codes', FACTOR_SNAPSHOT_MAX_CODES === 20, { constant: FACTOR_SNAPSHOT_MAX_CODES });
    check('no_database_writes', db.prepare('SELECT total_changes() n').get().n === totalChangesBefore, { total_changes: db.prepare('SELECT total_changes() n').get().n });
    let refused = null;
    try { db.prepare("INSERT INTO suspend_d (ts_code, trade_date) VALUES ('000000.SZ', '19000101')").run(); refused = 'write accepted'; } catch (error) { refused = error.message; }
    check('write_refused', /readonly/i.test(String(refused)), { write_attempt: refused });
  } finally {
    closeAshareDb();
  }

  result.snapshot.sha256_after = await fileHash(snapshot);
  check('source_sha256_unchanged', result.snapshot.sha256_before === result.snapshot.sha256_after, { before: result.snapshot.sha256_before, after: result.snapshot.sha256_after });
  const sidecar = `${snapshot}.sha256`;
  if (existsSync(sidecar)) {
    const recorded = (await import('node:fs')).readFileSync(sidecar, 'utf8').split(/\s+/)[0];
    result.snapshot.sidecar = { recorded };
    check('snapshot_matches_recorded_sha256', recorded === result.snapshot.sha256_before, { recorded });
  }

  // Plain-language acceptance: the full-universe recomputation dominates, so cost
  // should be roughly flat across requested counts.
  const medians = result.requests.map(r => r.median.wall_ms);
  result.acceptance = {
    full_market_recompute: 'Every call scans and normalizes the full market before filtering; a 20-code request is not 20x a 1-code request.',
    wall_ms_by_count: Object.fromEntries(result.requests.map(r => [r.count, r.median.wall_ms])),
    cpu_ms_by_count: Object.fromEntries(result.requests.map(r => [r.count, r.median.cpu_ms])),
    response_bytes_by_count: Object.fromEntries(result.requests.map(r => [r.count, r.median.response_bytes])),
    flatness_ratio_20_over_1: medians.length ? round(medians.at(-1) / medians[0], 3) : null,
    judgement: medians.at(-1) <= 15000
      ? 'ACCEPTABLE for an interactive research tool: worst measured median stays under 15 s, and the 20-code call costs about the same as a 1-code call because the full market is always recomputed. No cache layer is warranted for this research-only interface.'
      : 'NOT ACCEPTABLE as an interactive call: the worst measured median exceeds 15 s. Reducing it would require changing the scan/normalization engine, which is out of scope for this freeze; document the limit instead.',
  };
  result.status = result.failures.length ? 'FAIL' : 'PASS';
  result.completed_at = new Date().toISOString();
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.error(`${result.status}: ${result.failures.length} failures; evidence ${output}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [snapshot, output, date] = process.argv.slice(2);
  if (!snapshot || !output) throw new Error('Usage: node verify-factor-performance.mjs SNAPSHOT OUTPUT.json [DATE]');
  const result = await verifyFactorPerformance({ snapshot, output, date: date || DEFAULT_DATE });
  if (result.status !== 'PASS') process.exitCode = 1;
}
