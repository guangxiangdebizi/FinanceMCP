#!/usr/bin/env node
// Exact frozen-V1 regression. The market snapshot is immutable; only private in-memory
// state databases receive stock_score/watchlist writes. No builds or upstream calls.
// Usage: node deploy/ashare/verify-v1-parity.mjs SNAPSHOT BASELINE_BUILD CANDIDATE_BUILD OUTPUT.json
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_DATES = ['20250102', '20260331', '20260430', '20261016'];
const LEGACY_ROW_FIELDS = [
  'ts_code', 'name', 'industry', 'close', 'pct_chg', 'amount20_yi', 'circ_mv_yi',
  'pe_ttm', 'pb', 'turnover_rate', 'state', 'ma20_rising', 'ma60_rising', 'ma20',
  'ma60', 'atr14', 'high20_prior', 'bars', 'signals', 'fundamentals', 'risk_flags',
  'eligible', 'ineligible_reason', 'components', 'score', 'rank',
];

// Preserve distinctions that JSON.stringify normally discards (null/NaN/undefined/-0).
export function canonical(value) {
  if (value === undefined) return '["undefined"]';
  if (typeof value === 'number') return `["number",${JSON.stringify(Object.is(value, -0) ? '-0' : String(value))}]`;
  if (Array.isArray(value)) return `["array",[${value.map(canonical).join(',')}]]`;
  if (value !== null && typeof value === 'object') {
    return `["object",[${Object.keys(value).sort().map(k => `[${JSON.stringify(k)},${canonical(value[k])}]`).join(',')}]]`;
  }
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export function differences(expected, actual, limit = 12) {
  const out = [];
  const printable = value => value === undefined ? '<undefined>' : typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
  const visit = (a, b, path) => {
    if (out.length >= limit || isDeepStrictEqual(a, b)) return;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      if (Array.isArray(a) && a.length !== b.length) out.push({ path: `${path}.length`, baseline: a.length, candidate: b.length });
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (out.length >= limit) break;
        if (Object.hasOwn(a, k) !== Object.hasOwn(b, k)) out.push({ path: `${path}.${k}`, baseline: printable(a[k]), candidate: printable(b[k]), presence_mismatch: true });
        else visit(a[k], b[k], `${path}.${k}`);
      }
    } else out.push({ path, baseline: printable(a), candidate: printable(b) });
  };
  visit(expected, actual, '$');
  return out;
}

export function projectScan(scan) {
  return {
    trade_date: scan.trade_date,
    rows: scan.rows.map(r => Object.fromEntries(LEGACY_ROW_FIELDS.map(k => [k, r[k]]))),
    suspended_or_missing: scan.suspended_or_missing,
    signal_counts: scan.signal_counts,
    pct_above_ma20: scan.pct_above_ma20,
    pct_above_ma60: scan.pct_above_ma60,
    sectors: scan.sectors,
  };
}

function moduleDir(input) {
  for (const p of [resolve(input, 'ashare'), resolve(input, 'build/ashare'), resolve(input)]) {
    if (existsSync(join(p, 'analysis.js')) && existsSync(join(p, 'watchlist.js'))) return p;
  }
  throw new Error(`No built ashare modules found under ${input}`);
}

function treeHash(dir) {
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

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

async function engine(input) {
  const dir = moduleDir(input);
  const mod = name => import(pathToFileURL(join(dir, `${name}.js`)).href);
  const [analysis, db, watchlist, signals, evidence] = await Promise.all(['analysis', 'db', 'watchlist', 'signals', 'evidence'].map(mod));
  return { dir, analysis, db, watchlist, versions: {
    score: analysis.SCORE_VERSION, signal: signals.SIGNAL_VERSION,
    watchlist: watchlist.WATCHLIST_VERSION, evidence: evidence.EVIDENCE_VERSION,
  }, build_sha256: treeHash(dir) };
}

function stateDb(e, calendar) {
  const db = e.db.openAshareDb(':memory:');
  const ins = db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, ?, ?)');
  for (const row of calendar) ins.run(row.cal_date, row.is_open, row.pretrade_date);
  return db;
}

function persisted(db, date) {
  return {
    scores: db.prepare('SELECT ts_code, score, rank, detail FROM stock_score WHERE trade_date = ? ORDER BY ts_code').all(date),
    members: db.prepare('SELECT * FROM watchlist WHERE trade_date = ? ORDER BY ts_code').all(date),
    changes: db.prepare('SELECT * FROM watchlist_change WHERE trade_date = ? ORDER BY ts_code, action').all(date),
  };
}

export async function verifyV1Parity({ snapshot, baselineBuild, candidateBuild, output }) {
  snapshot = resolve(snapshot);
  output = resolve(output);
  if (output === snapshot || existsSync(output) && statSync(output).ino === statSync(snapshot).ino && statSync(output).dev === statSync(snapshot).dev) throw new Error('Output must not overwrite the snapshot');
  const wal = `${snapshot}-wal`;
  if (existsSync(wal) && statSync(wal).size !== 0) throw new Error('Snapshot has an uncheckpointed WAL; supply a frozen, checkpointed database');
  const before = await fileHash(snapshot);
  const baseline = await engine(baselineBuild);
  const candidate = await engine(candidateBuild);
  if (baseline.dir === candidate.dir) throw new Error('Baseline and candidate builds must be distinct');
  const uri = pathToFileURL(snapshot);
  uri.search = 'mode=ro&immutable=1';
  const source = new DatabaseSync(uri.href, { readOnly: true });
  source.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 2147483648;');
  const result = {
    schema_version: 'v1-parity-1.0.0', status: 'PENDING', started_at: new Date().toISOString(),
    command: `node deploy/ashare/verify-v1-parity.mjs ${[snapshot, resolve(baselineBuild), resolve(candidateBuild), output].map(x => `'${x.replaceAll("'", "'\\''")}'`).join(' ')}`,
    node_version: process.version, baseline_commit: 'e8cbe4a10061fa567710c1c2f631e4903093457b',
    snapshot: { path: snapshot, bytes: statSync(snapshot).size, sha256_before: before, access: 'SQLite mode=ro&immutable=1; query_only=ON' },
    baseline: { modules: baseline.dir, versions: baseline.versions, build_sha256: baseline.build_sha256 },
    candidate: { modules: candidate.dir, versions: candidate.versions, build_sha256: candidate.build_sha256 },
    comparison: { numeric_tolerance: 0, scope: 'Every scanMarket legacy field, all stocks, components, ranks, sectors, technical state, eligibility, risks and signals; ordered pool output and persisted wl-1 state',
      state: 'Independent empty in-memory databases; identical trade_cal; no original pool history',
      limitation: 'Historical names/industry/ST and financial revisions retain the baseline data limitations; this proves compatibility, not strategy performance' },
    required_dates: REQUIRED_DATES, dates: [], pool_sequence: [], mismatches: [],
  };
  const compare = (name, expected, actual) => {
    const equal = isDeepStrictEqual(expected, actual);
    if (!equal) result.mismatches.push({ check: name, examples: differences(expected, actual) });
    return { equal, baseline_sha256: digest(expected), candidate_sha256: digest(actual) };
  };
  const calendar = source.prepare('SELECT cal_date, is_open, pretrade_date FROM trade_cal ORDER BY cal_date').all();
  // Six consecutive sessions cross wl-1's five-session minimum hold boundary.
  const poolDates = source.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 6').all(REQUIRED_DATES.at(-1)).map(r => r.cal_date).reverse();
  if (poolDates.length !== 6) { source.close(); throw new Error('Six trading days required for stateful pool regression'); }
  const dates = [...new Set([...REQUIRED_DATES, ...poolDates])].sort();
  const bState = stateDb(baseline, calendar), cState = stateDb(candidate, calendar);
  try {
    const expectedVersions = { score: 'score-1.0.0', signal: 'sig-1.0.0', watchlist: 'wl-1.0.0', evidence: 'evi-1.0.0' };
    result.versions_match = compare('versions', expectedVersions, baseline.versions).equal && compare('candidate_versions', expectedVersions, candidate.versions).equal;
    result.rules = compare('score_and_watchlist_rules', { score: baseline.analysis.SCORE_RULES, pool: baseline.watchlist.WATCHLIST_RULES }, { score: candidate.analysis.SCORE_RULES, pool: candidate.watchlist.WATCHLIST_RULES });
    for (const date of dates) {
      const t = Date.now();
      if (!source.prepare('SELECT 1 FROM daily WHERE trade_date = ? LIMIT 1').get(date)) throw new Error(`No snapshot market data for ${date}`);
      const bScan = baseline.analysis.scanMarket(source, date);
      const cScan = candidate.analysis.scanMarket(source, date);
      const bProjected = projectScan(bScan), cProjected = projectScan(cScan);
      const scores = scan => scan.rows.filter(r => r.eligible).map(r => ({ ts_code: r.ts_code, components: r.components, score: r.score, rank: r.rank }));
      const signals = scan => ({ counts: scan.signal_counts, stocks: scan.rows.map(r => ({ ts_code: r.ts_code, signals: r.signals })) });
      const checks = {
        full_scan: compare(`${date}.full_scan`, bProjected, cProjected),
        scores: compare(`${date}.scores`, scores(bScan), scores(cScan)),
        sectors: compare(`${date}.sectors`, bScan.sectors, cScan.sectors),
        signals: compare(`${date}.signals`, signals(bScan), signals(cScan)),
      };
      if (date === REQUIRED_DATES.at(-1)) checks.repeat_candidate = compare(`${date}.repeat_candidate`, cProjected, projectScan(candidate.analysis.scanMarket(source, date)));
      result.dates.push({ date, required: REQUIRED_DATES.includes(date), counts: { baseline: { stocks: bScan.rows.length, eligible: bScan.rows.filter(r => r.eligible).length, sectors: bScan.sectors.length, signals: Object.values(bScan.signal_counts).reduce((a, b) => a + b, 0) }, candidate: { stocks: cScan.rows.length, eligible: cScan.rows.filter(r => r.eligible).length, sectors: cScan.sectors.length, signals: Object.values(cScan.signal_counts).reduce((a, b) => a + b, 0) } }, checks });
      if (poolDates.includes(date)) {
        const bPool = baseline.watchlist.updateWatchlist(bState, bScan);
        const cPool = candidate.watchlist.updateWatchlist(cState, cScan);
        result.pool_sequence.push({ date, previous_date: bPool.previous_date, members: bPool.members.length,
          adds: bPool.changes.filter(c => c.action === 'add').length, removes: bPool.changes.filter(c => c.action === 'remove').length,
          output: compare(`${date}.pool_output`, bPool, cPool),
          persisted: compare(`${date}.pool_persisted`, persisted(bState, date), persisted(cState, date)) });
      }
      console.error(`${date}: ${bScan.rows.length} stocks, ${bScan.rows.filter(r => r.eligible).length} eligible; ${checks.full_scan.equal ? 'EXACT MATCH' : 'MISMATCH'} (${Date.now() - t} ms)`);
    }
  } finally {
    bState.close(); cState.close(); source.close();
  }
  result.snapshot.sha256_after = await fileHash(snapshot);
  result.snapshot.unchanged = before === result.snapshot.sha256_after;
  if (!result.snapshot.unchanged) result.mismatches.push({ check: 'market_snapshot_unchanged' });
  for (const [name, e] of [['baseline', baseline], ['candidate', candidate]]) {
    result[name].build_sha256_after = treeHash(e.dir);
    if (e.build_sha256 !== result[name].build_sha256_after) result.mismatches.push({ check: `${name}_build_changed_during_verification` });
  }
  result.status = result.mismatches.length ? 'FAIL' : 'PASS';
  result.completed_at = new Date().toISOString();
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.error(`${result.status}: ${result.dates.length} exact full-market comparisons; ${result.pool_sequence.length} sequential pool dates; ${result.mismatches.length} mismatches; evidence ${output}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [snapshot, baselineBuild, candidateBuild, output] = process.argv.slice(2);
  if (!snapshot || !baselineBuild || !candidateBuild || !output || process.argv.length !== 6) throw new Error('Usage: node verify-v1-parity.mjs SNAPSHOT BASELINE_BUILD CANDIDATE_BUILD OUTPUT.json');
  const result = await verifyV1Parity({ snapshot, baselineBuild, candidateBuild, output });
  if (result.status !== 'PASS') process.exitCode = 1;
}
