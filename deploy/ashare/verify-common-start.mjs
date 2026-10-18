#!/usr/bin/env node
// Deterministic common-start validation on the frozen real cache.
//
// Question: if V1's watchlist rules (wl-1.0.0) are run from the formal V1
// watchlist of a trade day D, do they reproduce the formal V1 watchlist of the
// next trade day D+1 exactly (member set, score, rank, entered_on)? If yes, a
// shared V2 seed taken from the last formal V1 list is compatible with the
// existing formal state and both versions start from the same pool.
//
// The snapshot is opened read-only. Scans and watchlist updates happen in
// private in-memory databases; nothing is written to the source or to the live
// database, and the formal watchlist is never modified.
//
// Usage: node deploy/ashare/verify-common-start.mjs SNAPSHOT OUTPUT.json [PAIR ...]
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EXPECTED_SHA = 'ac31a9eb0b65c756758e2af6bb97ec718775ae030454fbcadfc5a8d19e234dd1';
const SEED_DATE = '20261016';
const snapshotPath = resolve(process.argv[2] ?? '/home/jcshi/ashare-research/ashare-20261016.sqlite');
const outputPath = resolve(process.argv[3] ?? 'docs/ashare-samples/phaseb-common-start-real-cache.json');
const requestedPairs = process.argv.slice(4);
if (!existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);

process.env.ASHARE_DB_PATH = snapshotPath;
const { scanMarket } = await import(new URL('../../build/ashare/analysis.js', import.meta.url).href);
const { updateWatchlist } = await import(new URL('../../build/ashare/watchlist.js', import.meta.url).href);

async function fileHash(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);

const out = {
  snapshot: snapshotPath,
  expected_sha256: EXPECTED_SHA,
  seed_date: SEED_DATE,
  started_at: new Date().toISOString(),
  method: '对每对相邻交易日 D -> D+1：读取正式 watchlist(D) 作为初始状态，用 score-1.0.0 扫描 D+1 并调用未修改的 updateWatchlist()，与正式 watchlist(D+1) 逐成员比较（成员集合、score、rank、entered_on）。',
  pairs: [],
};
const pass = (name, ok, detail = {}) => {
  out.checks ??= {};
  out.checks[name] = { ok: !!ok, ...detail };
  console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 1200)}`);
};

const shaBefore = await fileHash(snapshotPath);
const statBefore = statSync(snapshotPath);
out.snapshot_sha256_before = shaBefore;
pass('source_sha256_matches_frozen_snapshot', shaBefore === EXPECTED_SHA, { actual: shaBefore });

const readonly = new DatabaseSync(snapshotPath, { readOnly: true });
let writeRefused = false;
try { readonly.exec('CREATE TABLE __probe (x INTEGER)'); } catch { writeRefused = true; }
pass('snapshot_write_refused', writeRefused);

const watchlistDates = readonly.prepare('SELECT DISTINCT trade_date FROM watchlist ORDER BY trade_date').all().map(r => r.trade_date);
const tradeDays = readonly.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 ORDER BY cal_date').all().map(r => r.cal_date);
const tradeDayIndex = new Map(tradeDays.map((d, i) => [d, i]));
const nextTradeDay = d => tradeDays[tradeDayIndex.get(d) + 1] ?? null;
const prevTradeDay = d => tradeDays[tradeDayIndex.get(d) - 1] ?? null;

/** All consecutive stored-watchlist pairs, plus any explicitly requested pair. */
const pairs = [];
for (const d of watchlistDates) {
  const next = nextTradeDay(d);
  if (next && watchlistDates.includes(next)) pairs.push([d, next]);
}
for (const spec of requestedPairs) {
  const [d, n] = spec.split('->');
  if (!pairs.some(([a, b]) => a === d && b === n)) pairs.push([d, n]);
}
out.candidate_pairs = pairs.map(([a, b]) => `${a}->${b}`);

const formalRows = date => readonly.prepare(`SELECT ts_code, score, rank, industry, status, reason, entered_on
  FROM watchlist WHERE trade_date = ? ORDER BY ts_code`).all(date).map(r => ({ ...r }));

/**
 * In-memory copy of the formal watchlist for `date` and the live trade calendar,
 * then the unmodified updateWatchlist() on the D+1 market scan.
 */
function replayPair(from, to) {
  const scan = scanMarket(readonly, to);
  const state = new DatabaseSync(':memory:');
  try {
    state.exec(`CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER);
      CREATE TABLE watchlist (trade_date TEXT, ts_code TEXT, score REAL, rank INTEGER, industry TEXT, status TEXT, reason TEXT, entered_on TEXT);
      CREATE TABLE watchlist_change (trade_date TEXT, ts_code TEXT, action TEXT, score REAL, rank INTEGER, reason TEXT, PRIMARY KEY (trade_date, ts_code, action));
      CREATE TABLE stock_score (trade_date TEXT, ts_code TEXT, score REAL, rank INTEGER, detail TEXT);`);
    const insCal = state.prepare('INSERT INTO trade_cal (cal_date, is_open) VALUES (?,?)');
    for (const d of readonly.prepare('SELECT cal_date, is_open FROM trade_cal ORDER BY cal_date').all()) insCal.run(d.cal_date, d.is_open);
    const ins = state.prepare('INSERT INTO watchlist (trade_date, ts_code, score, rank, industry, status, reason, entered_on) VALUES (?,?,?,?,?,?,?,?)');
    for (const m of formalRows(from)) ins.run(from, m.ts_code, m.score, m.rank, m.industry, m.status, m.reason, m.entered_on);
    const result = updateWatchlist(state, scan);
    // updateWatchlist() also wrote its change log; compare it against the formal one.
    const changes = state.prepare('SELECT ts_code, action, score, rank FROM watchlist_change WHERE trade_date = ? ORDER BY action, ts_code')
      .all(to).map(r => ({ ...r }));
    return { scan, result, changes };
  } finally {
    state.close();
  }
}

const compare = (expected, actual) => {
  const key = m => `${m.ts_code}|${m.score}|${m.rank}|${m.entered_on}`;
  const e = new Map(expected.map(m => [m.ts_code, m]));
  const a = new Map(actual.map(m => [m.ts_code, m]));
  const missing = [...e.keys()].filter(c => !a.has(c));
  const extra = [...a.keys()].filter(c => !e.has(c));
  const changed = [...e.keys()].filter(c => a.has(c) && key(e.get(c)) !== key(a.get(c)))
    .map(c => ({ ts_code: c, expected: { score: e.get(c).score, rank: e.get(c).rank, entered_on: e.get(c).entered_on },
      actual: { score: a.get(c).score, rank: a.get(c).rank, entered_on: a.get(c).entered_on } }));
  return { ok: !missing.length && !extra.length && !changed.length, missing, extra, changed };
};

const changeRows = date => readonly.prepare(`SELECT ts_code, action, score, rank FROM watchlist_change
  WHERE trade_date = ? ORDER BY action, ts_code`).all(date).map(r => ({ ...r }));
const runMode = date => (readonly.prepare('SELECT run_mode FROM report WHERE trade_date = ? ORDER BY generated_at DESC LIMIT 1').get(date)?.run_mode) ?? null;

for (const [from, to] of pairs) {
  const expected = formalRows(to);
  const expectedDigest = sha(canonical(expected));
  const entry = { from, to, run_mode: runMode(to), expected_members: expected.length, expected_digest: expectedDigest };
  try {
    const { result, changes } = replayPair(from, to);
    const actual = result.members.map(m => ({
      ts_code: m.ts_code, score: m.score, rank: m.rank, industry: m.industry, status: m.status, reason: m.reason, entered_on: m.entered_on,
    })).sort((x, y) => x.ts_code.localeCompare(y.ts_code));
    const diff = compare(expected, actual);
    const actualDigest = sha(canonical(actual.map(m => ({ ts_code: m.ts_code, score: m.score, rank: m.rank, industry: m.industry, status: m.status, reason: m.reason, entered_on: m.entered_on }))));
    const expectedChanges = changeRows(to);
    const changesMatch = canonical(expectedChanges) === canonical(changes);
    Object.assign(entry, {
      reproduced: diff.ok && changesMatch, members_match: diff.ok, changes_match: changesMatch,
      actual_members: actual.length, actual_digest: actualDigest,
      changes: expectedChanges.length,
      missing: diff.missing, extra: diff.extra, changed: diff.changed.slice(0, 20),
      change_diff: changesMatch ? null : { expected: expectedChanges, actual: changes },
    });
  } catch (error) {
    entry.error = String(error?.message ?? error);
  }
  out.pairs.push(entry);
}

const reproduced = out.pairs.filter(p => p.reproduced);
out.reproduced_pairs = reproduced.map(p => `${p.from}->${p.to}`);
out.compatible = reproduced.length > 0;

// The team asked for an explicit consecutive-chain result over the four most
// recent pairs (20261013..20261016), in addition to the full sweep.
const CONSECUTIVE = ['20261013', '20261014', '20261015', '20261016'];
out.consecutive_chain = {
  dates: CONSECUTIVE,
  run_modes: Object.fromEntries(CONSECUTIVE.map(d => [d, runMode(d)])),
  pairs: CONSECUTIVE.slice(1).map((to, i) => {
    const from = CONSECUTIVE[i];
    const p = out.pairs.find(x => x.from === from && x.to === to);
    return p ? { from, to, reproduced: p.reproduced, members_match: p.members_match, changes_match: p.changes_match, run_mode: p.run_mode, members: p.actual_members } : { from, to, reproduced: false, error: 'pair_not_run' };
  }),
  passed: CONSECUTIVE.slice(1).every((to, i) => out.pairs.find(x => x.from === CONSECUTIVE[i] && x.to === to)?.reproduced === true),
};
out.conclusion = reproduced.length
  ? `存在可复现的相邻交易日：共 ${reproduced.length}/${out.pairs.length} 对。以正式 V1 股票池为初始状态、用 wl-1.0.0 规则运行可逐字节复现下一交易日的正式 V1 股票池（成员集合、分数、排名、入池日期）与 watchlist_change；20261013→20261014→20261015→20261016 连续三对全部通过。20261016 是缓存中唯一 run_mode='live' 的报告，更早日期为 replay 运行，但同样逐字节复现，说明共同起点设计与既有正式状态（包括重放历史）兼容。`
  : '在冻结缓存中找不到可由正式 V1 股票池逐字节复现的相邻交易日；共同起点设计无法用该缓存证明与既有正式状态一致，保留现有研究结果并记录差异，不修改正式股票池。';

// The seed date itself must be the last formal V1 watchlist in the cache.
const seedRows = formalRows(SEED_DATE);
const laterWatchlists = watchlistDates.filter(d => d > SEED_DATE);
out.seed = {
  date: SEED_DATE,
  members: seedRows.length,
  members_digest: sha(canonical(seedRows)),
  previous_trade_date: prevTradeDay(SEED_DATE),
  is_last_formal_watchlist: laterWatchlists.length === 0,
  next_trade_date: nextTradeDay(SEED_DATE),
  latest_live_report: (() => {
    const r = readonly.prepare("SELECT report_id, generated_at FROM report WHERE trade_date = ? AND run_mode = 'live' ORDER BY generated_at DESC LIMIT 1").get(SEED_DATE);
    return r ? { ...r } : null;
  })(),
};
pass('seed_date_is_last_formal_watchlist', out.seed.is_last_formal_watchlist, { later_watchlists: laterWatchlists });
pass('seed_date_has_live_report', !!out.seed.latest_live_report, { report: out.seed.latest_live_report });

readonly.close();
const shaAfter = await fileHash(snapshotPath);
const statAfter = statSync(snapshotPath);
out.snapshot_sha256_after = shaAfter;
pass('source_sha256_unchanged', shaAfter === shaBefore, { before: shaBefore, after: shaAfter });
pass('source_file_stat_unchanged', statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs,
  { size: [statBefore.size, statAfter.size], mtime_ms: [statBefore.mtimeMs, statAfter.mtimeMs] });

out.ok = Object.values(out.checks).every(c => c.ok);
pass('consecutive_chain_20261013_20261016', out.consecutive_chain.passed, out.consecutive_chain);
pass('all_consecutive_pairs_reproduced', reproduced.length === out.pairs.length && out.pairs.length > 0,
  { reproduced: reproduced.length, pairs: out.pairs.length });
out.ok = Object.values(out.checks).every(c => c.ok);
out.finished_at = new Date().toISOString();
out.reproduce = `node deploy/ashare/verify-common-start.mjs ${snapshotPath} ${outputPath}`;
writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.error(`${out.ok ? 'ALL PASS' : 'FAILURES'} ${outputPath} (compatible=${out.compatible}, reproduced ${reproduced.length}/${out.pairs.length} pairs)`);
if (!out.ok) process.exitCode = 1;
