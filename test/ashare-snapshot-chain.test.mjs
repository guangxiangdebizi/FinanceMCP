import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// The ORIGINAL V2 pool state chain and the prospective/backfilled observation
// attribute. A revision appends evidence and must never move the chain that
// later dates inherit; a missing trade day is a hard CHAIN_GAP, not a silent
// continuation from an older date.
const dir = mkdtempSync(join(tmpdir(), 'ashare-snapshot-chain-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { generateReport } = await import('../build/ashare/report.js');
const {
  runResearchSnapshot, runResearchEvaluate, classifyObservation, prospectiveSnapshots,
  PROSPECTIVE_START, PROSPECTIVE_WINDOW_HOURS,
} = await import('../build/ashare/snapshot.js');
const { seedMarket, addMarketDays, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const ALL = weekdays('20250901', 250);
const T = ALL[200];
const T1 = ALL[201];
const T2 = ALL[202];
const T3 = ALL[203];
const DB = join(dir, 'chain.sqlite');
const FINA = STOCKS.map((s, i) => ({
  ts_code: s.ts_code, end_date: '20241231', ann_date: '20250330', roe: 10, netprofit_yoy: 12,
  ocf_to_profit: i % 2 ? 20 : 115.11, debt_to_assets: 30, eps: 1,
}));

function seedLive() {
  const db = openAshareDb();
  seedMarket(db, ALL);
  upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'], FINA);
  for (const date of [T, T1, T2, T3]) generateReport(db, date, 'live');
  return db;
}

function readSnap(fn, path = DB) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

const poolRows = (date, path = DB) => readSnap(db => db.prepare('SELECT * FROM pool_state WHERE version = ? AND trade_date = ? ORDER BY ts_code')
  .all('score-2.0.0', date), path);
const contentOf = id => readSnap(db => JSON.parse(db.prepare('SELECT content FROM snapshot WHERE snapshot_id = ?').get(id).content));
const snapshotCount = (path = DB) => readSnap(db => db.prepare('SELECT COUNT(*) n FROM snapshot').get().n, path);
const originalId = (date, path = DB) => readSnap(db => db.prepare('SELECT snapshot_id FROM snapshot WHERE trade_date = ? AND status = ?').get(date, 'ORIGINAL')?.snapshot_id, path);

const live = seedLive();

test('chain: ORIGINAL snapshots record the ORIGINAL predecessor they inherited', () => {
  const t = runResearchSnapshot({ date: T, dbPath: DB });
  assert.equal(t.status, 'ORIGINAL', JSON.stringify(t));
  assert.equal(t.chain.previous_state_source, 'chain_start');
  assert.equal(t.chain.previous_snapshot_id, null);
  assert.equal(t.chain.previous_date, null);
  assert.equal(t.chain.chain_updated, true);
  const tContent = contentOf(t.snapshot_id);
  assert.equal(tContent.v2_pool.previous_snapshot_id, null);
  assert.equal(tContent.v2_pool.seed.source, 'chain_start');
  assert.equal(tContent.comparison_baseline, null);

  const t1 = runResearchSnapshot({ date: T1, dbPath: DB });
  assert.equal(t1.status, 'ORIGINAL', JSON.stringify(t1));
  assert.equal(t1.chain.previous_date, T);
  assert.equal(t1.chain.previous_snapshot_id, t.snapshot_id, 'records the ORIGINAL snapshot it inherited');
  assert.equal(contentOf(t1.snapshot_id).v2_pool.previous_snapshot_id, t.snapshot_id);
  const rows = poolRows(T1);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.previous_snapshot_id === t.snapshot_id));
  assert.ok(rows.every(r => r.state_source === 'original_snapshot' && r.source_id === t1.snapshot_id));
});

test('chain: --revise appends evidence and leaves the ORIGINAL state chain byte-identical', () => {
  const t = originalId(T);
  const t1 = originalId(T1);
  const poolTBefore = poolRows(T);
  const poolT1Before = poolRows(T1);
  const t1ContentBefore = contentOf(t1);
  const countBefore = snapshotCount();

  const revised = runResearchSnapshot({ date: T, dbPath: DB, revise: true });
  assert.equal(revised.status, 'REVISED', JSON.stringify(revised));
  assert.equal(revised.revises, t);
  assert.equal(revised.chain.chain_updated, false, 'a revision never updates the chain');

  assert.deepEqual(poolRows(T), poolTBefore, 'T pool_state rows unchanged');
  assert.deepEqual(poolRows(T1), poolT1Before, 'T+1 pool_state rows unchanged');
  assert.equal(contentOf(t1).v2_pool.previous_snapshot_id, t, 'T+1 still points at the ORIGINAL snapshot');
  assert.deepEqual(contentOf(t1).v2_pool.members, t1ContentBefore.v2_pool.members, 'T+1 members unchanged');
  assert.equal(snapshotCount(), countBefore + 1, 'only the revision row was appended');
  assert.equal(readSnap(db => db.prepare('SELECT COUNT(*) n FROM snapshot WHERE trade_date = ?').get(T).n), 2);
});

test('chain: a later date still inherits the ORIGINAL state, not the revision', () => {
  const t = originalId(T);
  const t1 = originalId(T1);
  const t2 = runResearchSnapshot({ date: T2, dbPath: DB });
  assert.equal(t2.status, 'ORIGINAL', JSON.stringify(t2));
  const content = contentOf(t2.snapshot_id);
  assert.equal(content.v2_pool.previous_date, T1);
  assert.equal(content.v2_pool.previous_snapshot_id, t1);
  // Revisions are never referenced by any pool_state row.
  const referenced = readSnap(db => db.prepare('SELECT DISTINCT previous_snapshot_id p FROM pool_state').all().map(r => r.p).filter(Boolean));
  assert.ok(!referenced.includes(`${t}-R1`));
  // Re-running T without --revise still returns EXISTS and changes nothing.
  const countBefore = snapshotCount();
  const exists = runResearchSnapshot({ date: T, dbPath: DB });
  assert.equal(exists.status, 'EXISTS');
  assert.equal(exists.snapshot_id, t);
  assert.equal(snapshotCount(), countBefore);
});

test('chain: skipping the immediately preceding trade day is CHAIN_GAP and writes nothing', () => {
  const gapDb = join(dir, 'gap.sqlite');
  assert.equal(runResearchSnapshot({ date: T, dbPath: gapDb }).status, 'ORIGINAL');
  const snapshotsBefore = snapshotCount(gapDb);
  const poolBefore = readSnap(db => db.prepare('SELECT * FROM pool_state ORDER BY trade_date, ts_code').all(), gapDb);

  // T+2 requested while T+1 is absent: the latest state is T, which is not the
  // immediately preceding trade day. No silent continuation is allowed.
  const gap = runResearchSnapshot({ date: T2, dbPath: gapDb });
  assert.equal(gap.status, 'CHAIN_GAP', JSON.stringify(gap));
  assert.equal(gap.date, T2);
  assert.equal(gap.expected_previous_trade_date, T1);
  assert.equal(gap.found_state_date, T, 'names the older state it refused to reuse');
  assert.equal(gap.missing, 'original_snapshot');
  assert.equal(gap.note, '按顺序补齐缺失交易日后再继续');

  const gap3 = runResearchSnapshot({ date: T3, dbPath: gapDb });
  assert.equal(gap3.status, 'CHAIN_GAP');
  assert.equal(gap3.expected_previous_trade_date, T2);

  assert.equal(snapshotCount(gapDb), snapshotsBefore, 'no snapshot written');
  assert.deepEqual(readSnap(db => db.prepare('SELECT * FROM pool_state ORDER BY trade_date, ts_code').all(), gapDb), poolBefore, 'no state written');
  // Filling the gap in order then works and links the chain.
  assert.equal(runResearchSnapshot({ date: T1, dbPath: gapDb }).status, 'ORIGINAL');
  const filled = runResearchSnapshot({ date: T2, dbPath: gapDb });
  assert.equal(filled.status, 'ORIGINAL', JSON.stringify(filled));
  assert.equal(filled.chain.previous_snapshot_id, originalId(T1, gapDb));
});

test('chain: an out-of-order chain start is refused once a later ORIGINAL snapshot exists', () => {
  const gapDb = join(dir, 'gap2.sqlite');
  assert.equal(runResearchSnapshot({ date: T1, dbPath: gapDb }).status, 'ORIGINAL');
  const before = snapshotCount(gapDb);
  const result = runResearchSnapshot({ date: T, dbPath: gapDb });
  assert.equal(result.status, 'CHAIN_GAP');
  assert.equal(result.missing, 'preceding_original_snapshot');
  assert.match(result.note, /按交易日顺序补齐/);
  assert.equal(snapshotCount(gapDb), before);
});

test('observation: classification is deterministic from stored facts', () => {
  const generated = '2026-10-19T16:36:20.909+08:00';
  const within = new Date(Date.parse(generated) + 2 * 3600_000).toISOString();
  const beyond = new Date(Date.parse(generated) + (PROSPECTIVE_WINDOW_HOURS + 1) * 3600_000).toISOString();
  const pick = o => ({ type: o.type, reason: o.reason });

  // (a) before the prospective start -> BACKFILLED, even when created promptly.
  assert.deepEqual(pick(classifyObservation({ tradeDate: '20261016', dataCutoff: '20261016', reportGeneratedAt: generated, createdAt: within })),
    { type: 'BACKFILLED', reason: 'before_prospective_start' });
  // (b) on/after the start, within the window, cutoff == trade date -> PROSPECTIVE.
  assert.deepEqual(pick(classifyObservation({ tradeDate: PROSPECTIVE_START, dataCutoff: PROSPECTIVE_START, reportGeneratedAt: generated, createdAt: within })),
    { type: 'PROSPECTIVE', reason: null });
  // The +08:00 offset is honoured, and the boundary is exclusive at 24h.
  const exactly = new Date(Date.parse(generated) + PROSPECTIVE_WINDOW_HOURS * 3600_000).toISOString();
  assert.equal(pick(classifyObservation({ tradeDate: PROSPECTIVE_START, dataCutoff: PROSPECTIVE_START, reportGeneratedAt: generated, createdAt: exactly })).type, 'PROSPECTIVE');
  // (c) beyond the window -> BACKFILLED / created_after_window.
  assert.deepEqual(pick(classifyObservation({ tradeDate: PROSPECTIVE_START, dataCutoff: PROSPECTIVE_START, reportGeneratedAt: generated, createdAt: beyond })),
    { type: 'BACKFILLED', reason: 'created_after_window' });
  // Later data used -> BACKFILLED / data_cutoff_after_trade_date.
  assert.deepEqual(pick(classifyObservation({ tradeDate: PROSPECTIVE_START, dataCutoff: '20261020', reportGeneratedAt: generated, createdAt: within })),
    { type: 'BACKFILLED', reason: 'data_cutoff_after_trade_date' });
  // Unparseable report time -> BACKFILLED / report_time_unknown.
  assert.deepEqual(pick(classifyObservation({ tradeDate: PROSPECTIVE_START, dataCutoff: PROSPECTIVE_START, reportGeneratedAt: 'not-a-time', createdAt: within })),
    { type: 'BACKFILLED', reason: 'report_time_unknown' });
  assert.equal(PROSPECTIVE_START, '20261019');
});

test('observation: stored snapshots carry the attribute and a revision keeps it', () => {
  const first = readSnap(db => db.prepare('SELECT * FROM snapshot WHERE trade_date = ? AND status = ?').get(T, 'ORIGINAL'));
  // The synthetic fixture is far before PROSPECTIVE_START.
  assert.equal(first.observation_type, 'BACKFILLED');
  assert.equal(first.observation_reason, 'before_prospective_start');
  assert.equal(first.prospective_start, PROSPECTIVE_START);
  assert.equal(first.window_hours, PROSPECTIVE_WINDOW_HOURS);
  assert.ok(first.report_generated_at);
  const revised = readSnap(db => db.prepare('SELECT * FROM snapshot WHERE trade_date = ? AND status = ?').get(T, 'REVISED'));
  assert.equal(revised.observation_type, 'BACKFILLED');
  assert.equal(revised.observation_reason, 'before_prospective_start');
  // Re-running --revise only appends another row with the same attribute; there
  // is no API that can relabel an existing observation.
  const again = runResearchSnapshot({ date: T, dbPath: DB, revise: true });
  assert.equal(again.status, 'REVISED');
  assert.equal(again.observation.type, 'BACKFILLED');
  assert.equal(again.observation.reason, 'before_prospective_start');
  // research-evaluate exposes observation per snapshot.
  const evaluated = runResearchEvaluate({ date: T, dbPath: DB, asOf: T });
  assert.equal(evaluated.status, 'EVALUATED');
  assert.ok(evaluated.snapshots.every(s => s.observation.type === 'BACKFILLED'));
  assert.deepEqual(prospectiveSnapshots(DB), [], 'no prospective observations in this fixture');
});

test('observation: a genuinely prospective snapshot stays PROSPECTIVE through a revision', (t) => {
  // A separate fixture whose dates fall inside the prospective window.
  const prospectiveDir = mkdtempSync(join(tmpdir(), 'ashare-prospective-'));
  const livePath = join(prospectiveDir, 'live.sqlite');
  const dbPath = join(prospectiveDir, 'chain.sqlite');
  const ALL2 = weekdays('20250901', 296); // ends on 20261019
  const D = '20261019';
  const D1 = '20261020';
  const D2 = '20261021';
  assert.equal(ALL2.at(-1), D);

  const saved = { db: process.env.ASHARE_DB_PATH, dir: process.env.ASHARE_DATA_DIR };
  process.env.ASHARE_DB_PATH = livePath;
  process.env.ASHARE_DATA_DIR = prospectiveDir;
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T15:00:00+08:00') });
    const ldb = openAshareDb();
    seedMarket(ldb, ALL2);
    upsertRows(ldb, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'], FINA);
    generateReport(ldb, D, 'live'); // generated_at = 2026-10-19T15:00+08:00

    t.mock.timers.setTime(Date.parse('2026-10-19T16:00:00+08:00'));
    const first = runResearchSnapshot({ date: D, dbPath, liveDbPath: livePath });
    assert.equal(first.status, 'ORIGINAL', JSON.stringify(first));
    assert.equal(first.observation.type, 'PROSPECTIVE', JSON.stringify(first.observation));
    assert.equal(first.observation.reason, null);
    assert.equal(first.observation.report_generated_at, '2026-10-19T15:00:00.000+08:00');

    // (d) a revision of a PROSPECTIVE snapshot stays PROSPECTIVE with status REVISED.
    t.mock.timers.setTime(Date.parse('2026-10-19T17:00:00+08:00'));
    const revised = runResearchSnapshot({ date: D, dbPath, liveDbPath: livePath, revise: true });
    assert.equal(revised.status, 'REVISED');
    assert.equal(revised.observation.type, 'PROSPECTIVE');
    assert.equal(revised.observation.reason, null);

    // Next trade day, created promptly -> PROSPECTIVE.
    addMarketDays(ldb, [D1], [...ALL2, D1]);
    t.mock.timers.setTime(Date.parse('2026-10-20T15:30:00+08:00'));
    generateReport(ldb, D1, 'live');
    t.mock.timers.setTime(Date.parse('2026-10-20T16:30:00+08:00'));
    const second = runResearchSnapshot({ date: D1, dbPath, liveDbPath: livePath });
    assert.equal(second.status, 'ORIGINAL', JSON.stringify(second));
    assert.equal(second.observation.type, 'PROSPECTIVE');

    // A backfill three days later cannot become prospective.
    addMarketDays(ldb, [D2], [...ALL2, D1, D2]);
    t.mock.timers.setTime(Date.parse('2026-10-21T15:30:00+08:00'));
    generateReport(ldb, D2, 'live');
    t.mock.timers.setTime(Date.parse('2026-10-24T15:30:00+08:00'));
    const backfilled = runResearchSnapshot({ date: D2, dbPath, liveDbPath: livePath });
    assert.equal(backfilled.status, 'ORIGINAL');
    assert.equal(backfilled.observation.type, 'BACKFILLED');
    assert.equal(backfilled.observation.reason, 'created_after_window');
    ldb.close();

    // Only the genuine prospective observations are listed.
    const listed = prospectiveSnapshots(dbPath);
    assert.deepEqual(listed.map(r => r.snapshot_id).sort(), [first.snapshot_id, second.snapshot_id, revised.snapshot_id].sort());
    assert.ok(listed.every(r => r.observation_type === 'PROSPECTIVE'));
  } finally {
    process.env.ASHARE_DB_PATH = saved.db;
    process.env.ASHARE_DATA_DIR = saved.dir;
  }
});

test('migration: a database written by the previous build is upgraded in place', () => {
  const legacy = join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE snapshot (snapshot_id TEXT PRIMARY KEY, trade_date TEXT NOT NULL, status TEXT NOT NULL,
      revises TEXT, created_at TEXT NOT NULL, content_digest TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE pool_state (version TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, entered_on TEXT NOT NULL,
      PRIMARY KEY (version, trade_date, ts_code)) WITHOUT ROWID;`);
  const legacyContent = { snapshot_id: 'FWD-20261016-legacy', data_cutoff: '20261016', report: { generated_at: '2026-10-17T00:36:20.909+08:00' } };
  db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?)')
    .run('FWD-20261016-legacy', '20261016', 'ORIGINAL', null, '2026-10-17T18:24:00.000Z', 'digest', JSON.stringify(legacyContent));
  db.prepare('INSERT INTO pool_state VALUES (?,?,?,?)').run('score-2.0.0', '20261016', '600000.SH', '20260701');
  db.close();

  const rows = prospectiveSnapshots(legacy); // opens and migrates
  assert.deepEqual(rows, []);
  const after = new DatabaseSync(legacy, { readOnly: true });
  try {
    const row = after.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get('FWD-20261016-legacy');
    assert.equal(row.observation_type, 'BACKFILLED', 'classified from the facts the old row already stored');
    assert.equal(row.observation_reason, 'before_prospective_start');
    assert.equal(row.report_generated_at, '2026-10-17T00:36:20.909+08:00');
    assert.equal(row.content, JSON.stringify(legacyContent), 'stored content untouched');
    const pool = after.prepare('SELECT * FROM pool_state').get();
    assert.equal(pool.state_source, 'original_snapshot');
    assert.equal(pool.source_id, 'FWD-20261016-legacy');
  } finally {
    after.close();
  }
});

test.after(() => live.close());
