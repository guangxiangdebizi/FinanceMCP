#!/usr/bin/env node
// Read-only factor snapshot evidence on the frozen research snapshot.
// Exercises the current observation-quality code (sourceQualityForDate /
// applyObservationQuality) through the real MCP tool entry point and the
// internal engine, and proves the two paths are byte-identical and repeatable.
//
// Nothing is written to the snapshot: getAshareDb() opens it readOnly, the
// script asserts that a write is refused, and the full-file SHA256 is checked
// before and after. The output JSON is the only file written.
//
// Usage: node deploy/ashare/verify-factor-snapshot.mjs SNAPSHOT OUTPUT.json [DATE]
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATE = '20261016';
const MAX_CODES = 20;
const LIVE_DIR = /finance-mcp-ashare\/?$/;
const FIELDS = ['raw', 'normalized', 'score', 'rank', 'eligible', 'ineligible_reason', 'components', 'contributions', 'factor_contributions', 'scoring_factors', 'imputations', 'signals', 'quality', 'financial_report', 'invalidation'];

export const digest = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value);
const round = ms => Math.round(ms);

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/** Hash every built .js file so the evidence is bound to one exact build. */
async function treeHash(dir) {
  const { readdirSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const h = createHash('sha256');
  const walk = p => {
    for (const name of readdirSync(p).sort()) {
      const path = join(p, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) h.update(relative(dir, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** First structural difference, so a failure names the exact path instead of dumping 38 KB. */
function firstDifference(a, b, path = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return { path: `${path}.${key}`, presence: { internal: Object.hasOwn(a, key), mcp: Object.hasOwn(b, key) } };
      const nested = firstDifference(a[key], b[key], `${path}.${key}`);
      if (nested) return nested;
    }
    return { path, note: 'object differs without a named key difference' };
  }
  return { path, internal: a === undefined ? '<undefined>' : a, mcp: b === undefined ? '<undefined>' : b };
}

export async function verifyFactorSnapshot({ snapshot, output, date = DEFAULT_DATE }) {
  snapshot = resolve(snapshot);
  output = resolve(output);
  const started = Date.now();
  if (!existsSync(snapshot)) throw new Error(`Snapshot not found: ${snapshot}`);
  const snapshotDir = resolve(snapshot, '..');
  if (LIVE_DIR.test(snapshotDir)) throw new Error('Refusing to run against the live data directory; supply the frozen research snapshot');
  if (output === snapshot) throw new Error('Output must not overwrite the snapshot');
  const wal = `${snapshot}-wal`;
  if (existsSync(wal) && statSync(wal).size !== 0) throw new Error('Snapshot has an uncheckpointed WAL; supply a frozen, checkpointed database');
  const before = await fileHash(snapshot);

  process.env.ASHARE_DB_PATH = snapshot;
  const buildDir = new URL('../../build/ashare/', import.meta.url);
  const { getAshareDb, closeAshareDb } = await import(new URL('db.js', buildDir).href);
  const { analyzeMarket, FACTOR_VERSION, FACTOR_SNAPSHOT_MAX_CODES } = await import(new URL('engine.js', buildDir).href);
  const { runAshareTool } = await import(new URL('tools.js', buildDir).href);
  const { SCORE_VERSION } = await import(new URL('analysis.js', buildDir).href);

  const result = {
    schema_version: 'factor-snapshot-evidence-1.0.0', status: 'PENDING', date,
    started_at: new Date(started).toISOString(), node_version: process.version,
    command: `node deploy/ashare/verify-factor-snapshot.mjs '${snapshot}' '${output}' '${date}'`,
    snapshot: { path: snapshot, file: basename(snapshot), bytes: statSync(snapshot).size, sha256_before: before,
      access: 'getAshareDb() -> new DatabaseSync(path, { readOnly: true }); PRAGMA query_only=ON; no ASHARE_DATA_DIR writes' },
    versions: { score_version: SCORE_VERSION, factor_version: FACTOR_VERSION, engine_version: undefined, indicator_version: undefined, signal_version: undefined },
    request: { date, ts_codes: [], score_version: SCORE_VERSION, include_components: true },
    checks: {}, coverage: {}, timings_ms: {}, failures: [],
  };
  const check = (name, ok, detail) => {
    result.checks[name] = ok;
    if (!ok) result.failures.push({ check: name, ...detail });
    console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + json(detail).slice(0, 600)}`);
    return ok;
  };

  const db = getAshareDb();
  try {
    result.versions.engine_version = (await import(new URL('engine.js', buildDir).href)).ENGINE_VERSION;
    result.versions.indicator_version = (await import(new URL('indicators.js', buildDir).href)).INDICATOR_VERSION;
    result.versions.signal_version = (await import(new URL('signals.js', buildDir).href)).SIGNAL_VERSION;

    // A suspended stock with no as-of bar must come back as an explicit null row, not stale data.
    const missingRows = db.prepare(`SELECT b.ts_code FROM stock_basic b
      WHERE b.list_date <= ?1 AND (b.delist_date IS NULL OR b.delist_date = '' OR b.delist_date > ?1)
        AND EXISTS (SELECT 1 FROM suspend_d s WHERE s.ts_code = b.ts_code AND s.trade_date = ?1)
        AND NOT EXISTS (SELECT 1 FROM daily d WHERE d.ts_code = b.ts_code AND d.trade_date = ?1)
      ORDER BY b.ts_code`).all(date);
    const missingWithoutSuspension = db.prepare(`SELECT b.ts_code FROM stock_basic b
      WHERE b.list_date <= ?1 AND (b.delist_date IS NULL OR b.delist_date = '' OR b.delist_date > ?1)
        AND NOT EXISTS (SELECT 1 FROM daily d WHERE d.ts_code = b.ts_code AND d.trade_date = ?1)
        AND NOT EXISTS (SELECT 1 FROM suspend_d s WHERE s.ts_code = b.ts_code AND s.trade_date = ?1)
      ORDER BY b.ts_code LIMIT 1`).get(date);
    const liquid = db.prepare('SELECT ts_code FROM daily_basic WHERE trade_date = ? AND pe_ttm IS NOT NULL ORDER BY ts_code LIMIT ?').all(date, MAX_CODES);
    const suspended = missingRows[0]?.ts_code;
    const codes = [...(suspended ? [suspended] : []), ...liquid.map(r => r.ts_code)]
      .filter((code, i, all) => all.indexOf(code) === i).slice(0, MAX_CODES).sort();
    result.request.ts_codes = codes;

    const tInternal = Date.now();
    const internal = analyzeMarket(db, { date, ts_codes: codes, score_version: SCORE_VERSION, parameters: { include_components: true } });
    result.timings_ms.internal = round(Date.now() - tInternal);

    const tMcp = Date.now();
    const mcpText = (await runAshareTool('ashare_factor_snapshot', { date, ts_codes: codes, score_version: SCORE_VERSION, include_components: true })).content[0].text;
    result.timings_ms.mcp = round(Date.now() - tMcp);
    const mcp = JSON.parse(mcpText);

    check('mcp_equals_internal', isDeepStrictEqual(internal, mcp), { difference: firstDifference(internal, mcp) });
    check('mcp_text_equals_internal_json', mcpText === json(internal), { internal_bytes: json(internal).length, mcp_bytes: mcpText.length });

    // Every legacy/observable field of every requested row must agree too.
    const perRow = codes.map(code => {
      const a = internal.rows.find(r => r.ts_code === code), b = mcp.rows.find(r => r.ts_code === code);
      const diffs = FIELDS.filter(key => !isDeepStrictEqual(a?.[key], b?.[key]));
      return { ts_code: code, equal: !!a && !!b && diffs.length === 0, differing_fields: diffs };
    });
    check('row_field_parity', perRow.every(r => r.equal), { rows: perRow.filter(r => !r.equal) });

    const tRepeat = Date.now();
    const repeatText = (await runAshareTool('ashare_factor_snapshot', { date, ts_codes: codes, score_version: SCORE_VERSION, include_components: true })).content[0].text;
    result.timings_ms.mcp_repeat = round(Date.now() - tRepeat);
    check('repeat_bytes_identical', repeatText === mcpText, { first_sha256: digest(mcpText), repeat_sha256: digest(repeatText), first_bytes: mcpText.length, repeat_bytes: repeatText.length });

    // Missing / unknown codes keep explicit nulls and are never back-filled from an older bar.
    const missingRow = suspended ? mcp.rows.find(r => r.ts_code === suspended) : undefined;
    const nullRaw = missingRow ? Object.entries(missingRow.raw).filter(([k]) => k !== 'industry').every(([, v]) => v === null) : false;
    check('explicit_null_missing_rows', !!missingRow && missingRow.eligible === false && missingRow.score === null && missingRow.rank === null
      && nullRaw && missingRow.quality.bars === 0 && missingRow.signals.length === 0 && missingRow.ineligible_reason === 'No as-of bar',
      { code: suspended ?? null, row: missingRow ? { eligible: missingRow.eligible, score: missingRow.score, rank: missingRow.rank, bars: missingRow.quality.bars, reason: missingRow.ineligible_reason } : null });

    check('returned_count', mcp.count === codes.length && mcp.rows.length === codes.length && codes.length === MAX_CODES, { requested: codes.length, returned: mcp.rows.length, count: mcp.count });
    check('bounded_max_codes', FACTOR_SNAPSHOT_MAX_CODES === MAX_CODES && (await import(new URL('definitions.js', buildDir).href)).ashareToolDefinitions.find(d => d.name === 'ashare_factor_snapshot').inputSchema.properties.ts_codes.maxItems === MAX_CODES,
      { constant: FACTOR_SNAPSHOT_MAX_CODES });

    // Observation-quality coverage: the snapshot is clean, so both anomaly masks must be empty and no factor may be nulled by them.
    const quality = internal.rows.filter(r => r.quality.risk_flags.some(f => /Invalid or missing source OHLC|Missing amount in the last 20 bars/.test(f)));
    check('observation_quality_clean_on_frozen_snapshot', quality.length === 0,
      { flagged: quality.map(r => ({ ts_code: r.ts_code, flags: r.quality.risk_flags })) });

    const eligible = mcp.rows.filter(r => r.eligible);
    result.coverage = {
      suspended_code: suspended ?? null, missing_without_suspension_code: missingWithoutSuspension?.ts_code ?? null,
      eligible_count: eligible.length, returned: mcp.rows.length,
      missing_rows: mcp.rows.filter(r => r.ineligible_reason === 'No as-of bar').map(r => ({ ts_code: r.ts_code, eligible: r.eligible, score: r.score, close: r.raw.close, ret20: r.raw.ret20, ineligible_reason: r.ineligible_reason })),
      null_factor_fields: [...new Set(mcp.rows.flatMap(r => r.quality.missing_factors))].sort(),
      normalization_scope: mcp.normalization_scope,
      full_market_universe: mcp.universe,
    };

    // No write can succeed through this connection; total_changes() must stay 0 across the reads above.
    const changes = db.prepare('SELECT total_changes() n').get().n;
    let refused = null;
    try { db.prepare("INSERT INTO suspend_d (ts_code, trade_date) VALUES ('000000.SZ', '19000101')").run(); refused = 'write accepted'; } catch (error) { refused = error.message; }
    check('no_database_writes', changes === 0 && /readonly/i.test(String(refused)), { total_changes: changes, write_attempt: refused });

    result.response = { bytes: mcpText.length, sha256: digest(mcpText), repeat_sha256: digest(repeatText) };
    result.quality_status = mcp.quality.status;
  } finally {
    closeAshareDb();
  }

  result.snapshot.sha256_after = await fileHash(snapshot);
  result.snapshot.unchanged = result.snapshot.sha256_before === result.snapshot.sha256_after;
  check('source_sha256_unchanged', result.snapshot.unchanged, { before, after: result.snapshot.sha256_after });

  // The evidence must describe the build that is currently on disk.
  const moduleDir = fileURLToPath(new URL('../../build/ashare/', import.meta.url));
  const buildSha = await treeHash(moduleDir);
  result.build = { modules: moduleDir, tree_sha256: buildSha };
  const shaSidecar = `${snapshot}.sha256`;
  result.snapshot.sidecar = existsSync(shaSidecar) ? { path: shaSidecar, recorded: readFileSync(shaSidecar, 'utf8').split(/\s+/)[0] } : null;
  check('snapshot_matches_recorded_sha256', !result.snapshot.sidecar || result.snapshot.sidecar.recorded === result.snapshot.sha256_before,
    { recorded: result.snapshot.sidecar?.recorded, actual: result.snapshot.sha256_before });

  result.status = result.failures.length ? 'FAIL' : 'PASS';
  result.completed_at = new Date().toISOString();
  result.timings_ms.total = round(Date.now() - started);
  result.method = 'getAshareDb() opened the frozen snapshot read-only (ASHARE_DB_PATH, PRAGMA query_only=ON). Picked one suspended listed stock with no as-of bar plus liquid stocks to reach 20 codes. Compared runAshareTool(\'ashare_factor_snapshot\') JSON against analyzeMarket(db, {date, ts_codes, score_version, parameters:{include_components:true}}) with strict deep equality, field by field. Repeated the identical MCP request and compared exact text bytes and SHA256. Asserted missing-bar rows are explicit nulls with eligible=false and no signals, that the bounded tool accepts at most 20 codes, that the current observation-quality masks flag nothing on this clean snapshot, that a write is refused and total_changes() stays 0, and that the full-file SHA256 is unchanged. No build or source modification; the snapshot is never the live database.';
  writeFileSync(output, `${json(result, null, 2)}\n`);
  console.error(`${result.status}: ${result.failures.length} failures; ${result.response.bytes} bytes; ${result.timings_ms.mcp} ms MCP, ${result.timings_ms.internal} ms internal; evidence ${output}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [snapshot, output, date] = process.argv.slice(2);
  if (!snapshot || !output) throw new Error('Usage: node verify-factor-snapshot.mjs SNAPSHOT OUTPUT.json [DATE]');
  const result = await verifyFactorSnapshot({ snapshot, output, date: date || DEFAULT_DATE });
  if (result.status !== 'PASS') process.exitCode = 1;
}
