import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-snapshot-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { generateReport } = await import('../build/ashare/report.js');
const { runResearchSnapshot, runResearchEvaluate, researchSnapshotDbPath } = await import('../build/ashare/snapshot.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const sha = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => sha(readFileSync(path));

// 230 weekdays: enough history for the >=130-bar eligibility rule, plus a tail
// of future bars used only by the mature-evaluation test.
const ALL = weekdays('20250901', 250);
const DATE = ALL[200];
const BEFORE = ALL[199];
const after = n => ALL[201 + n];
const SNAPSHOT_DB = researchSnapshotDbPath();

function seedLive({ reports = [DATE], fina = true } = {}) {
  const db = openAshareDb();
  seedMarket(db, ALL);
  if (fina) {
    upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'],
      STOCKS.map((s, i) => ({ ts_code: s.ts_code, end_date: '20241231', ann_date: '20250330', roe: 10, netprofit_yoy: 12, ocf_to_profit: i % 2 ? 20 : 115.11, debt_to_assets: 30, eps: 1 })));
  }
  for (const date of reports) generateReport(db, date, 'live');
  return db;
}

/** Live-derived state that a snapshot must never change. */
function liveState() {
  const db = new DatabaseSync(process.env.ASHARE_DB_PATH, { readOnly: true });
  try {
    const counts = Object.fromEntries(['report', 'watchlist', 'watchlist_change', 'stock_score', 'quality_check', 'daily', 'daily_basic', 'adj_factor', 'stk_limit', 'sync_log', 'sync_history']
      .map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    const digest = sha(JSON.stringify({
      watchlist: db.prepare('SELECT * FROM watchlist ORDER BY trade_date, ts_code').all(),
      report: db.prepare('SELECT * FROM report ORDER BY report_id').all(),
      scores: db.prepare('SELECT trade_date, ts_code, score, rank FROM stock_score ORDER BY trade_date, ts_code').all(),
    }));
    return { counts, digest };
  } finally {
    db.close();
  }
}

function assertNoSnapshotDb() {
  if (!existsSync(SNAPSHOT_DB)) return;
  const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshot').get().n, 0, 'no snapshot rows written');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pool_state').get().n, 0, 'no pool state written');
  } finally {
    db.close();
  }
}

const live = seedLive();

test('a. non-trade day returns NOT_TRADE_DAY and writes nothing', () => {
  const before = liveState();
  // The fixture only stores open days, so add an explicit closed weekend day.
  const weekend = '20260905';
  live.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, 0)').run(weekend);
  const date = weekend;
  assert.equal(live.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(date).is_open, 0);
  const result = runResearchSnapshot({ date, dbPath: SNAPSHOT_DB });
  assert.equal(result.status, 'NOT_TRADE_DAY');
  assert.equal(result.date, date);
  assertNoSnapshotDb();
  assert.deepEqual(liveState(), before);
  // A date the calendar does not know is also not a trade day.
  assert.equal(runResearchSnapshot({ date: '20270101', dbPath: SNAPSHOT_DB }).status, 'NOT_TRADE_DAY');
  assertNoSnapshotDb();
});

test('b. a date beyond cached data returns PENDING and writes nothing', () => {
  const before = liveState();
  const beyond = ALL.at(-1);
  // ALL covers every date in the cache; move the requested date one weekday later.
  const later = weekdays('20250901', 251).at(-1);
  const db = new DatabaseSync(process.env.ASHARE_DB_PATH);
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, 1)').run(later);
  db.close();
  const result = runResearchSnapshot({ date: later, dbPath: SNAPSHOT_DB });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reason, 'date_after_data_cutoff');
  assert.equal(result.data_cutoff, beyond);
  assertNoSnapshotDb();
  // Removing the synthetic calendar row keeps the live state comparable.
  const db2 = new DatabaseSync(process.env.ASHARE_DB_PATH);
  db2.prepare('DELETE FROM trade_cal WHERE cal_date = ?').run(later);
  db2.close();
  assert.deepEqual(liveState(), before);
});

test('c. a trade day without a formal live report returns PENDING and writes nothing', () => {
  const before = liveState();
  const result = runResearchSnapshot({ date: BEFORE, dbPath: SNAPSHOT_DB });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reason, 'no_live_report');
  assertNoSnapshotDb();
  assert.deepEqual(liveState(), before);
});

let first;
test('d. a successful snapshot records V1 parity and leaves the live database untouched', () => {
  const bytesBefore = fileHash(process.env.ASHARE_DB_PATH);
  const before = liveState();
  first = runResearchSnapshot({ date: DATE, dbPath: SNAPSHOT_DB });
  assert.equal(first.status, 'ORIGINAL', JSON.stringify(first));
  assert.match(first.snapshot_id, new RegExp(`^FWD-${DATE}-[0-9a-f]{16}$`));
  assert.equal(first.data_cutoff, ALL.at(-1));
  assert.equal(first.quality_status, 'READY');
  assert.ok(first.report_id.startsWith(`ASR-${DATE}-`));
  assert.equal(first.v1_parity.ok, true);
  assert.equal(first.v1_pool.source, 'formal_live_watchlist');
  assert.equal(first.v2_pool.source, 'research_v2_sequential');
  assert.ok(first.changed_scores > 0, 'V2 cash threshold changes some scores');

  assert.equal(fileHash(process.env.ASHARE_DB_PATH), bytesBefore, 'live database bytes unchanged');
  assert.deepEqual(liveState(), before, 'report/watchlist/stock_score rows unchanged');

  const snap = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    const row = snap.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id);
    const content = JSON.parse(row.content);
    assert.equal(content.snapshot_id, first.snapshot_id);
    assert.equal(content.status, 'ORIGINAL');
    assert.equal(content.revises, null);
    assert.equal(content.report.report_id, first.report_id);
    assert.equal(content.quality.checked_at, undefined, 'wall-clock checked_at excluded');
    assert.ok(content.data_snapshot.written_at);
    assert.equal(content.versions.score_v1, 'score-1.0.0');
    assert.equal(content.versions.score_v2, 'score-2.0.0');
    assert.equal(content.versions.watchlist, 'wl-1.0.0');
    assert.match(content.build_sha256, /^[0-9a-f]{64}$/);
    assert.equal(content.parameters.horizon, 10);
    assert.equal(content.parameters.buy_fee_bps, 3);
    assert.equal(content.parameters.sell_fee_bps, 8);
    assert.equal(content.parameters.slippage_bps, 5);
    assert.equal(content.parameters.max_exit_delay, 5);
    assert.equal(content.future_returns.status, 'PENDING');
    assert.equal(content.future_returns.horizon, 10);
    assert.ok(content.future_returns.planned_exit_date);
    assert.equal(content.universe.eligible, first.v1_parity.eligible);
    assert.equal(content.v1_pool.count, snap.prepare("SELECT COUNT(*) n FROM snapshot_member WHERE snapshot_id = ? AND version = 'score-1.0.0'").get(first.snapshot_id).n);
    assert.equal(content.v2_pool.count, snap.prepare("SELECT COUNT(*) n FROM snapshot_member WHERE snapshot_id = ? AND version = 'score-2.0.0'").get(first.snapshot_id).n);
    // V1 pool equals the formal live watchlist, member for member.
    const formal = live.prepare('SELECT ts_code, score, rank, entered_on FROM watchlist WHERE trade_date = ? ORDER BY ts_code').all(DATE);
    assert.deepEqual(content.v1_pool.members.map(m => ({ ts_code: m.ts_code, score: m.score, rank: m.rank, entered_on: m.entered_on })).sort((a, b) => a.ts_code.localeCompare(b.ts_code)),
      formal.map(r => ({ ...r })));
    // Per-stock factors exist for every eligible stock and keep missing values null.
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM snapshot_factor WHERE snapshot_id = ?').get(first.snapshot_id).n, content.universe.eligible);
    const factor = JSON.parse(snap.prepare('SELECT * FROM snapshot_factor WHERE snapshot_id = ? ORDER BY ts_code LIMIT 1').get(first.snapshot_id).v1);
    assert.ok('components' in factor && 'normalized' in factor && 'factor_contributions' in factor);
    // V2 pool state was persisted for the date.
    assert.equal(snap.prepare("SELECT COUNT(*) n FROM pool_state WHERE version = 'score-2.0.0' AND trade_date = ?").get(DATE).n, content.v2_pool.count);
  } finally {
    snap.close();
  }
});

test('e. rerunning identical inputs returns EXISTS with the same id and content', () => {
  const before = liveState();
  const stored = (() => {
    const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
    try { return db.prepare('SELECT snapshot_id, content, created_at FROM snapshot WHERE trade_date = ?').all(DATE); } finally { db.close(); }
  })();
  const again = runResearchSnapshot({ date: DATE, dbPath: SNAPSHOT_DB });
  assert.equal(again.status, 'EXISTS');
  assert.equal(again.snapshot_id, first.snapshot_id);
  assert.equal(again.recomputed_snapshot_id, first.snapshot_id, 'deterministic content id');
  assert.equal(again.content_matches_stored, true);
  const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT snapshot_id, content, created_at FROM snapshot WHERE trade_date = ?').all(DATE), stored, 'stored content unchanged');
  } finally { db.close(); }
  assert.deepEqual(liveState(), before);
});

test('f. --revise keeps the original row byte-identical and records a REVISED snapshot', () => {
  const original = (() => {
    const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
    try { return db.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id); } finally { db.close(); }
  })();
  const revised = runResearchSnapshot({ date: DATE, dbPath: SNAPSHOT_DB, revise: true });
  assert.equal(revised.status, 'REVISED');
  assert.equal(revised.revises, first.snapshot_id);
  assert.notEqual(revised.snapshot_id, first.snapshot_id);
  const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id), original, 'original row untouched');
    const row = db.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(revised.snapshot_id);
    assert.equal(row.status, 'REVISED');
    assert.equal(row.revises, first.snapshot_id);
    assert.equal(JSON.parse(row.content).status, 'REVISED');
    assert.equal(JSON.parse(row.content).revises, first.snapshot_id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshot WHERE trade_date = ?').get(DATE).n, 2);
    // Members and factors are stored for the revision too.
    assert.ok(db.prepare('SELECT COUNT(*) n FROM snapshot_member WHERE snapshot_id = ?').get(revised.snapshot_id).n > 0);
  } finally { db.close(); }
  // Without --revise the command keeps refusing to touch the date.
  assert.equal(runResearchSnapshot({ date: DATE, dbPath: SNAPSHOT_DB }).status, 'EXISTS');
});

test('g. immature horizons stay PENDING; mature ones produce completed returns for both versions', () => {
  const snapshotRow = () => {
    const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
    try { return db.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id); } finally { db.close(); }
  };
  const stored = snapshotRow();
  const pending = runResearchEvaluate({ date: DATE, dbPath: SNAPSHOT_DB, asOf: DATE });
  assert.equal(pending.status, 'EVALUATED');
  assert.equal(pending.matured, false);
  for (const snap of pending.snapshots) {
    assert.equal(snap.matured, false);
    for (const [version, v] of Object.entries(snap.versions)) {
      assert.equal(v.status, 'PENDING', version);
      assert.equal(v.denominators.completed, 0);
      assert.equal(v.net_return.mean, null, 'no fabricated returns');
      assert.equal(v.denominators.statuses.completed, 0);
    }
  }
  // The exit date is reported even while pending, and nothing was fabricated.
  assert.ok(pending.planned_exit_date);
  assert.deepEqual(snapshotRow(), stored, 'original snapshot unchanged by evaluation');

  const exitIndex = ALL.indexOf(DATE) + 10;
  const matured = runResearchEvaluate({ date: DATE, dbPath: SNAPSHOT_DB, asOf: ALL[exitIndex + 5] });
  assert.equal(matured.matured, true);
  for (const snap of matured.snapshots) {
    for (const [version, v] of Object.entries(snap.versions)) {
      assert.equal(v.status, 'MATURED', version);
      assert.ok(v.denominators.completed > 0, `${version} completed observations`);
      assert.ok(Number.isFinite(v.net_return.mean), `${version} net return computed`);
      assert.equal(v.denominators.completed + v.denominators.unresolved_after_entry + v.denominators.not_entered, v.denominators.events);
    }
  }
  // Same method and as-of for both versions; the rows are append-only.
  const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    const rows = db.prepare('SELECT version, as_of, horizon, status FROM snapshot_evaluation WHERE snapshot_id = ? ORDER BY as_of, version').all(first.snapshot_id);
    assert.ok(rows.every(r => r.horizon === 10));
    assert.deepEqual(rows.map(r => r.version), ['score-1.0.0', 'score-2.0.0', 'score-1.0.0', 'score-2.0.0']);
    assert.deepEqual([...new Set(rows.map(r => r.as_of))].sort(), [DATE, ALL[exitIndex + 5]].sort());
  } finally { db.close(); }
  assert.deepEqual(snapshotRow(), stored, 'original snapshot still unchanged');
});

test('h. the V2 pool advances from its stored state on the next snapshot', () => {
  // Append the next trade day and produce its live report so a second snapshot is allowed.
  const next = after(0);
  const db = openAshareDb();
  generateReport(db, next, 'live');
  db.close();
  const second = runResearchSnapshot({ date: next, dbPath: SNAPSHOT_DB });
  assert.equal(second.status, 'ORIGINAL', JSON.stringify(second));
  const snap = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    const content = JSON.parse(snap.prepare('SELECT content FROM snapshot WHERE snapshot_id = ?').get(second.snapshot_id).content);
    assert.equal(content.v1_pool.source, 'formal_live_watchlist');
    assert.equal(content.v2_pool.source, 'research_v2_sequential');
    assert.equal(content.v2_pool.previous_date, DATE, 'advanced from the stored V2 pool, not the formal one');
    const prev = JSON.parse(snap.prepare('SELECT content FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id).content);
    const prevCodes = new Set(prev.v2_pool.members.map(m => m.ts_code));
    // The new V2 pool continues the stored state: at least one member kept its entry date.
    const continued = content.v2_pool.members.filter(m => prevCodes.has(m.ts_code));
    assert.ok(continued.length > 0);
    assert.ok(continued.every(m => m.entered_on <= DATE), 'kept members retain their original entry date');
    assert.equal(snap.prepare("SELECT COUNT(*) n FROM pool_state WHERE version = 'score-2.0.0' AND trade_date = ?").get(next).n, content.v2_pool.count);
    assert.equal(snap.prepare("SELECT COUNT(*) n FROM pool_state WHERE version = 'score-2.0.0' AND trade_date = ?").get(DATE).n, prev.v2_pool.count, 'previous state retained for audit');
    // The two pool sources are distinguishable even if membership overlaps.
    assert.notEqual(content.v1_pool.source, content.v2_pool.source);
  } finally { snap.close(); }
});

test('i. horizon below 2 and malformed dates are rejected before any write', () => {
  assert.throws(() => runResearchSnapshot({ date: DATE, dbPath: SNAPSHOT_DB, horizon: 1 }), /horizon/);
  assert.throws(() => runResearchSnapshot({ date: '2026-13-01', dbPath: SNAPSHOT_DB }), /--date/);
  assert.throws(() => runResearchEvaluate({ date: DATE, dbPath: SNAPSHOT_DB, horizon: 0 }), /horizon/);
  const db = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshot').get().n, 3, 'only ORIGINAL + REVISED + next day');
  } finally { db.close(); }
});

test.after(() => live.close());
