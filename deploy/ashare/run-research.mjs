#!/usr/bin/env node
// Reproducible paired V1/V2 study. Reads frozen scans and an immutable market snapshot;
// writes only <output>/research.sqlite and <output>/summary.json.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log = () => {};
const { scoreRows, SCORE_VERSION, RESEARCH_SCORE_VERSION, SCORE_RULES } = await import('../../build/ashare/analysis.js');
const { rawFactors, sourceQualityForDate, applyObservationQuality, FACTOR_VERSION, ENGINE_VERSION, SCORING_POLICY, FACTOR_UNITS } = await import('../../build/ashare/engine.js');
const { updateWatchlist, WATCHLIST_VERSION, WATCHLIST_RULES } = await import('../../build/ashare/watchlist.js');
const { checkQuality } = await import('../../build/ashare/ingest.js');
const { evaluateEvents, distribution, correlation, EVALUATION_VERSION } = await import('../../build/ashare/evaluation.js');
const { DATA_CONTRACT } = await import('../../build/ashare/data.js');
const has = key => process.argv.includes(`--${key}`);
const arg = (key, fallback) => has(key) ? process.argv[process.argv.indexOf(`--${key}`) + 1] : fallback;
const output = resolve(arg('output', 'data/ashare/research-v2'));
const inputsDir = resolve(arg('inputs', output));
const manifest = JSON.parse(readFileSync(join(inputsDir, 'inputs.json'), 'utf8'));
if (!Array.isArray(manifest.dates) || !manifest.dates.length || manifest.dates.some((d, i) => !/^\d{8}$/.test(d) || d > manifest.data_cutoff || (i && d <= manifest.dates[i - 1]))) throw new Error('Input dates must be unique, increasing and no later than data_cutoff');
const source = resolve(arg('source', manifest.source));
mkdirSync(output, { recursive: true });
const researchPath = join(output, 'research.sqlite');
if (existsSync(researchPath)) {
  const a = statSync(researchPath), b = statSync(source);
  if (realpathSync(researchPath) === realpathSync(source) || (a.dev === b.dev && a.ino === b.ino)) throw new Error('Source and research database must differ');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = hash(readFileSync(source));
if (sourceHash !== manifest.source_sha256) throw new Error('Market snapshot differs from frozen scan manifest');
const split = arg('split', '20260331');
if (split !== '20260331') throw new Error('This experiment fixes split=20260331; create a new explicit protocol for another split');
const options = { asOf: manifest.data_cutoff, horizon: Number(arg('horizon', '10')), buyFeeBps: Number(arg('buy-fee-bps', '3')),
  sellFeeBps: Number(arg('sell-fee-bps', '8')), slippageBps: Number(arg('slippage-bps', '5')), maxExitDelay: Number(arg('max-exit-delay', '5')) };
const versions = [SCORE_VERSION, RESEARCH_SCORE_VERSION];
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const implementationFiles = ['src/ashare/analysis.ts', 'src/ashare/engine.ts', 'src/ashare/evaluation.ts', 'src/ashare/watchlist.ts', 'src/ashare/ingest.ts',
  'deploy/ashare/harvest-research.mjs', 'deploy/ashare/run-research.mjs'];
const implementation = Object.fromEntries(implementationFiles.map(p => [p, hash(readFileSync(join(root, p)))]));
const runtimeHash = createHash('sha256');
for (const file of readdirSync(join(root, 'build/ashare')).filter(f => f.endsWith('.js')).sort()) runtimeHash.update(file).update('\0').update(readFileSync(join(root, 'build/ashare', file))).update('\0');
const inputScanHashes = Object.fromEntries(manifest.dates.map(date => [date, hash(readFileSync(join(inputsDir, 'scans', `${date}.json`)))]));
const protocol = {
  status: 'RESEARCH_ONLY', data_cutoff: manifest.data_cutoff, source_sha256: sourceHash, baseline_build_sha256: manifest.baseline_build_sha256 ?? null,
  versions: { engine: ENGINE_VERSION, factor: FACTOR_VERSION, scores: versions, evaluation: EVALUATION_VERSION, watchlist: WATCHLIST_VERSION },
  split, selection_dates: manifest.dates, stride: manifest.stride, warmup_trade_days: manifest.warmup_trade_days, options,
  selection: 'Same wl-1.0.0 membership rules updated on sampled dates only. This is a sampled rebalance scenario with its own initial pool, not the deployed daily watchlist history.',
  split_interpretation: 'Rules formed through 20260331. 20260401..20261016 is historical simulation, partially observed before this experiment; never untouched out-of-sample. Formation returns are censored at the split.',
  costs: 'Buy fee 3bps, sell fee 8bps, adverse slippage 5bps each side by default; configurable scenarios, not a universal historical tax schedule.',
  benchmarks: ['Signal-date full listed universe equal-weight gross endpoint observations, with unresolved denominator', 'CSI300 gross price index t+1 open to actual exit close', 'Current-industry matched gross endpoint observations, with unresolved denominator'],
  score_policy: SCORING_POLICY, weights: SCORE_RULES.weights, pool_rules: WATCHLIST_RULES,
  limitations: [...DATA_CONTRACT.availability.not_point_in_time,
    'Score inputs use last 130..260 traded bars, including a bar only when available at signal close; warmup starts in 2024. Current historical source revisions are not recoverable.',
    'No cash-constrained funded portfolio is simulated. Unfilled and unpriced events remain in denominators; conditional means do not imply all events could be traded.',
    'Nonoverlap cohorts and factor correlations are descriptive sensitivity checks, not significance tests or parameter optimization.'],
  implementation_sha256: implementation, runtime_build_sha256: runtimeHash.digest('hex'), input_scan_sha256: inputScanHashes,
};
const runId = `PHB-${hash(JSON.stringify(protocol)).slice(0, 20)}`;
const db = new DatabaseSync(source, { readOnly: true });
db.exec('PRAGMA mmap_size=2147483648; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;');
const research = new DatabaseSync(researchPath);
research.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS experiment (run_id TEXT PRIMARY KEY, protocol TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS factor (run_id TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, eligible INTEGER NOT NULL, raw TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(run_id,trade_date,ts_code)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS score_version (run_id TEXT NOT NULL, version TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, score REAL, rank INTEGER, detail TEXT NOT NULL, PRIMARY KEY(run_id,version,trade_date,ts_code)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pool (run_id TEXT NOT NULL, version TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(run_id,version,trade_date,ts_code)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event (run_id TEXT NOT NULL, version TEXT NOT NULL, segment TEXT NOT NULL, date TEXT NOT NULL, ts_code TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(run_id,version,segment,date,ts_code)) WITHOUT ROWID;`);
// A content-addressed run is replaced atomically within this independent research DB only.
research.exec('BEGIN IMMEDIATE');
for (const table of ['experiment', 'factor', 'score_version', 'pool', 'event']) research.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
research.prepare('INSERT INTO experiment VALUES (?,?,NULL,?)').run(runId, JSON.stringify(protocol), new Date().toISOString());
const insertFactor = research.prepare('INSERT INTO factor VALUES (?,?,?,?,?,?)');
const insertScore = research.prepare('INSERT INTO score_version VALUES (?,?,?,?,?,?,?)');
const insertPool = research.prepare('INSERT INTO pool VALUES (?,?,?,?,?)');
const insertEvent = research.prepare('INSERT INTO event VALUES (?,?,?,?,?,?,?)');
const states = versions.map(() => {
  const state = new DatabaseSync(':memory:');
  state.exec(`CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY,is_open INTEGER);
  CREATE TABLE watchlist (trade_date TEXT,ts_code TEXT,score REAL,rank INTEGER,industry TEXT,status TEXT,reason TEXT,entered_on TEXT);
  CREATE TABLE watchlist_change (trade_date TEXT,ts_code TEXT,action TEXT,score REAL,rank INTEGER,reason TEXT,PRIMARY KEY(trade_date,ts_code,action));
  CREATE TABLE stock_score (trade_date TEXT,ts_code TEXT,score REAL,rank INTEGER,detail TEXT);`);
  const ins = state.prepare('INSERT INTO trade_cal VALUES (?,?)');
  for (const d of db.prepare('SELECT cal_date,is_open FROM trade_cal WHERE cal_date<=?').all(manifest.data_cutoff)) ins.run(d.cal_date, d.is_open);
  return state;
});
const events = versions.map(() => []);
const comparisons = [];
const scanDigests = {};
const quality = {};
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const industryDistribution = rows => {
  const counts = {};
  for (const r of rows) counts[r.industry] = (counts[r.industry] ?? 0) + 1;
  return { n: rows.length, counts, hhi: rows.length ? Object.values(counts).reduce((s, n) => s + (n / rows.length) ** 2, 0) : null };
};
for (const date of manifest.dates) {
  const input = readFileSync(join(inputsDir, 'scans', `${date}.json`));
  scanDigests[date] = hash(input);
  if (scanDigests[date] !== inputScanHashes[date]) throw new Error(`Input scan changed during run: ${date}`);
  const scan = JSON.parse(input);
  if (scan.trade_date !== date) throw new Error(`Input scan date mismatch: ${date}`);
  // Observation quality comes from the source rows, not from legacy scan fields, which coerce NULL OHLC/amount to zero.
  const sourceQuality = sourceQualityForDate(db, date);
  const qualityOf = code => sourceQuality.get(code) ?? {};
  const observedFactors = row => rawFactors(row, qualityOf(row.ts_code));
  // Restore NaN only on numeric fields whose legacy representation used NaN;
  // financial missing values remain null and retain the original scoring defaults.
  for (const r of scan.rows) {
    for (const k of ['close','pct_chg','amount20_yi','ma20','ma60','atr14','high20_prior']) if (r[k] === null) r[k] = NaN;
    for (const k of ['ret5','ret20','ret60','rsi14','atr_pct','vol_ratio']) if (r.state[k] === null) r.state[k] = NaN;
    const raw = observedFactors(r);
    const q = qualityOf(r.ts_code);
    insertFactor.run(runId, date, r.ts_code, Number(r.eligible), JSON.stringify(raw), JSON.stringify({ factor_version: FACTOR_VERSION, ineligible_reason: r.ineligible_reason ?? null,
      financial_report: r.fundamentals ? { end_date: r.fundamentals.end_date, ann_date: r.fundamentals.ann_date } : null, risk_flags: r.risk_flags,
      source_quality: { amount20_missing: !!q.amount20_missing, technical_invalid: !!q.technical_invalid, close_invalid: !!q.close_invalid },
      signals: q.technical_invalid ? [] : r.signals }));
  }
  const scored = versions.map(() => structuredClone(scan));
  const breakdowns = versions.map((version, k) => scoreRows(scored[k].rows, scored[k].sectors, version));
  for (const details of breakdowns) for (const [code, q] of sourceQuality) applyObservationQuality(details.get(code), q);
  const pools = versions.map((version, k) => {
    for (const r of scored[k].rows) insertScore.run(runId, version, date, r.ts_code, r.score ?? null, r.rank ?? null, JSON.stringify(breakdowns[k].get(r.ts_code) ?? { normalized: null, reason: r.ineligible_reason }));
    const pool = updateWatchlist(states[k], scored[k]);
    const byCode = new Map(scored[k].rows.map(r => [r.ts_code, r]));
    for (const m of pool.members) {
      insertPool.run(runId, version, date, m.ts_code, JSON.stringify(m));
      const r = byCode.get(m.ts_code);
      const raw = observedFactors(r);
      const q = qualityOf(m.ts_code);
      events[k].push({ date, ts_code: m.ts_code, score: r.score, industry: r.industry,
        factors: Object.fromEntries(Object.entries(raw).filter(([key]) => typeof FACTOR_UNITS[key] === 'string' && key !== 'industry').map(([key, v]) => [key, typeof v === 'boolean' ? Number(v) : numeric(v)])),
        signals: q.technical_invalid ? [] : r.signals });
    }
    return pool;
  });
  const v2 = new Map(scored[1].rows.filter(r => r.eligible).map(r => [r.ts_code, r]));
  const baselineByCode = new Map(scan.rows.map(r => [r.ts_code, r]));
  const eligible = scored[0].rows.filter(r => r.eligible);
  const changes = eligible.map(a => {
    const b = v2.get(a.ts_code);
    const x = breakdowns[0].get(a.ts_code), y = breakdowns[1].get(a.ts_code);
    const attribution = Object.fromEntries(Object.keys(x.factor_contributions).map(key => [key, y.factor_contributions[key] - x.factor_contributions[key]]));
    if (Object.entries(attribution).some(([key, d]) => key !== 'cash' && Math.abs(d) > 1e-10)) throw new Error(`Unexpected non-cash score change ${date} ${a.ts_code}`);
    if (Math.abs((b.score - a.score) - attribution.cash) > 0.010001) throw new Error(`Unattributed score delta ${date} ${a.ts_code}`);
    const baseline = baselineByCode.get(a.ts_code);
    if (a.score !== baseline.score || a.rank !== baseline.rank || JSON.stringify(a.components) !== JSON.stringify(baseline.components)) throw new Error(`V1 baseline mismatch ${date} ${a.ts_code}`);
    return { ts_code: a.ts_code, industry: a.industry, cash_pct: a.fundamentals?.ocf_to_profit ?? null,
      v1_score: a.score, v2_score: b.score, score_delta: b.score - a.score, v1_rank: a.rank, v2_rank: b.rank, rank_delta: b.rank - a.rank,
      cash_contribution_delta: attribution.cash };
  });
  const pool0 = new Set(pools[0].members.map(m => m.ts_code)), pool1 = new Set(pools[1].members.map(m => m.ts_code));
  const { checked_at, ...q } = checkQuality(db, date, false);
  quality[date] = q;
  comparisons.push({ date, segment: date <= split ? 'formation' : 'historical_simulation', scanned: scan.rows.length, eligible: eligible.length,
    v1_scores: distribution(eligible.map(r => r.score)), v2_scores: distribution([...v2.values()].map(r => r.score)),
    rank_correlation: correlation(changes.map(c => [c.v1_rank, c.v2_rank])), changed_scores: changes.filter(c => c.score_delta !== 0).length,
    score_delta: distribution(changes.map(c => c.score_delta)), largest_rank_changes: changes.sort((a, b) => Math.abs(b.rank_delta) - Math.abs(a.rank_delta) || a.ts_code.localeCompare(b.ts_code)).slice(0, 20),
    attribution: 'Only cash term changes; all other factor contributions verified identical for every eligible stock',
    top40_industries: scored.map(s => industryDistribution(s.rows.filter(r => r.eligible).sort((a,b) => a.rank-b.rank).slice(0,40))),
    pool_industries: pools.map(p => industryDistribution(p.members)),
    pool_membership: { v1: pool0.size, v2: pool1.size, common: [...pool0].filter(c => pool1.has(c)).length,
      v1_only: [...pool0].filter(c => !pool1.has(c)), v2_only: [...pool1].filter(c => !pool0.has(c)) } });
  console.error(`[research] scored ${date} eligible=${eligible.length} changed=${comparisons.at(-1).changed_scores}`);
}
const evaluation = {};
for (const [k, version] of versions.entries()) {
  evaluation[version] = {};
  for (const [segment, asOf, selected] of [
    ['formation', split, events[k].filter(e => e.date <= split)],
    ['historical_simulation', options.asOf, events[k].filter(e => e.date > split)],
  ]) {
    console.error(`[research] evaluate ${version} ${segment} events=${selected.length}`);
    const result = evaluateEvents(db, selected, { ...options, asOf });
    for (const o of result.outcomes) insertEvent.run(runId, version, segment, o.event.date, o.event.ts_code, o.status, JSON.stringify(o));
    evaluation[version][segment] = { ...result, outcomes: undefined };
  }
}
const result = { run_id: runId, ...protocol, units: { returns: 'decimal ratios; 0.01=1%', score: '0..100 heuristic points', normalized: '0..1', factors: FACTOR_UNITS },
  input_scan_sha256: scanDigests, sampled_trade_dates: comparisons.length, quality_by_date: quality, comparisons, evaluation,
  future_observation: { status: 'PENDING', start: '20261019', note: 'No future/live performance fabricated; new actual trading days must be accumulated after rule freeze and production acceptance.' },
  reproducible_commands: [
    'npm ci && npm run build',
    'node deploy/ashare/harvest-research.mjs --source <frozen-ashare.sqlite> --build <baseline-build> --output <independent-research-dir> --workers 2',
    'node deploy/ashare/run-research.mjs --source <frozen-ashare.sqlite> --inputs <independent-research-dir> --output <independent-research-dir>',
  ] };
research.prepare('UPDATE experiment SET result=? WHERE run_id=?').run(JSON.stringify(result), runId);
research.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2));
for (const s of states) s.close();
research.close();
db.close();
process.stdout.write(JSON.stringify({ run_id: runId, status: 'RESEARCH_ONLY', research_db: researchPath, summary: join(output, 'summary.json'), dates: comparisons.length, versions }) + '\n');
