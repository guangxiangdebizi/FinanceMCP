import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Fair V1/V2 starting point: the research V2 pool is seeded once from the last
// formal V1 watchlist before the prospective window, keeping each member's
// entry date. V1 stays the formal live list; V2 advances from the shared start.
const dir = mkdtempSync(join(tmpdir(), 'ashare-research-seed-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { generateReport } = await import('../build/ashare/report.js');
const { runResearchSeed, runResearchSnapshot } = await import('../build/ashare/snapshot.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const ALL = weekdays('20250901', 250);
const S = ALL[200];
const S1 = ALL[201];
const S2 = ALL[202];
const DB = join(dir, 'seed.sqlite');

function seedLive() {
  const db = openAshareDb();
  seedMarket(db, ALL);
  upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'],
    STOCKS.map((s, i) => ({ ts_code: s.ts_code, end_date: '20241231', ann_date: '20250330', roe: 10, netprofit_yoy: 12, ocf_to_profit: i % 2 ? 20 : 115.11, debt_to_assets: 30, eps: 1 })));
  for (const date of [S, S1, S2]) generateReport(db, date, 'live');
  return db;
}

const live = seedLive();
const readSnap = (fn, path = DB) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
};
const formal = date => live.prepare('SELECT ts_code, score, rank, industry, status, reason, entered_on FROM watchlist WHERE trade_date = ? ORDER BY ts_code').all(date);
let seeded;

test('seed: writes the one-time common start from the formal V1 watchlist', () => {
  seeded = runResearchSeed({ date: S, dbPath: DB });
  assert.equal(seeded.status, 'SEEDED', JSON.stringify(seeded));
  assert.match(seeded.seed_id, /^SEED-\d{8}-[0-9a-f]{16}$/);
  assert.equal(seeded.trade_date, S);
  assert.equal(seeded.member_count, formal(S).length);
  assert.ok(seeded.member_count > 0);
  assert.ok(seeded.source_report_id.startsWith(`ASR-${S}-`));

  const rows = readSnap(db => db.prepare('SELECT * FROM pool_state WHERE version = ? AND trade_date = ? ORDER BY ts_code').all('score-2.0.0', S));
  assert.equal(rows.length, seeded.member_count);
  assert.ok(rows.every(r => r.state_source === 'seed' && r.seed_id === seeded.seed_id && r.previous_snapshot_id === null));
  // Members keep the formal score, rank, industry and entry date.
  const expected = formal(S);
  assert.deepEqual(rows.map(r => ({ ts_code: r.ts_code, score: r.score, rank: r.rank, industry: r.industry, entered_on: r.entered_on })),
    expected.map(r => ({ ts_code: r.ts_code, score: r.score, rank: r.rank, industry: r.industry, entered_on: r.entered_on })));
  const seedRow = readSnap(db => db.prepare('SELECT * FROM pool_seed WHERE seed_id = ?').get(seeded.seed_id));
  assert.equal(seedRow.members_digest, seeded.members_digest);
  assert.equal(JSON.parse(seedRow.content).members.length, seeded.member_count);
});

test('seed: is idempotent and refuses a second, different seed', () => {
  const again = runResearchSeed({ date: S, dbPath: DB });
  assert.equal(again.status, 'EXISTS');
  assert.equal(again.seed_id, seeded.seed_id);
  assert.equal(again.members_digest, seeded.members_digest);
  assert.equal(readSnap(db => db.prepare('SELECT COUNT(*) n FROM pool_seed').get().n), 1);
});

test('seed: the first snapshot after the seed inherits it with previous_snapshot_id null', () => {
  const first = runResearchSnapshot({ date: S1, dbPath: DB });
  assert.equal(first.status, 'ORIGINAL', JSON.stringify(first));
  assert.equal(first.chain.previous_state_source, 'seed');
  assert.equal(first.chain.previous_snapshot_id, null);
  assert.equal(first.chain.previous_date, S);
  assert.equal(first.chain.seed_id, seeded.seed_id);

  const content = readSnap(db => JSON.parse(db.prepare('SELECT content FROM snapshot WHERE snapshot_id = ?').get(first.snapshot_id).content));
  assert.equal(content.v2_pool.previous_snapshot_id, null);
  assert.equal(content.v2_pool.previous_state_source, 'seed');
  assert.equal(content.v2_pool.seed.source, 'seed');
  assert.equal(content.v2_pool.seed.seed_id, seeded.seed_id);
  assert.equal(content.v2_pool.seed.seed_date, S);
  assert.deepEqual(content.comparison_baseline, {
    seed_date: S,
    seed_report_id: seeded.source_report_id,
    seed_members_digest: seeded.members_digest,
    note: 'V1 与 V2 的共同初始状态；此后两版成员差异只能归因于评分规则与由评分驱动的状态演化。',
  });
  // V1 is still the formal live watchlist of the day.
  assert.deepEqual(content.v1_pool.members.map(m => ({ ts_code: m.ts_code, score: m.score, rank: m.rank, entered_on: m.entered_on }))
    .sort((a, b) => a.ts_code.localeCompare(b.ts_code)),
    formal(S1).map(m => ({ ts_code: m.ts_code, score: m.score, rank: m.rank, entered_on: m.entered_on })));
  // V2 advanced from the seed: kept members keep their formal entry date.
  const seedCodes = new Set(formal(S).map(m => m.ts_code));
  const kept = content.v2_pool.members.filter(m => seedCodes.has(m.ts_code));
  assert.ok(kept.length > 0, 'some seed members carry over');
  assert.ok(kept.every(m => m.entered_on <= S), 'entry dates are preserved from the shared start');
  // The pool rows of S1 point at the seed as their predecessor state.
  const rows = readSnap(db => db.prepare('SELECT * FROM pool_state WHERE version = ? AND trade_date = ?').all('score-2.0.0', S1));
  assert.ok(rows.every(r => r.state_source === 'original_snapshot' && r.previous_snapshot_id === null && r.seed_id === null));
});

test('seed: later snapshots keep the comparison baseline and the shared start', () => {
  const firstId = readSnap(db => db.prepare('SELECT snapshot_id FROM snapshot WHERE trade_date = ? AND status = ?').get(S1, 'ORIGINAL').snapshot_id);
  const second = runResearchSnapshot({ date: S2, dbPath: DB });
  assert.equal(second.status, 'ORIGINAL', JSON.stringify(second));
  assert.equal(second.chain.previous_snapshot_id, firstId);
  assert.equal(second.chain.previous_state_source, 'snapshot');
  const content = readSnap(db => JSON.parse(db.prepare('SELECT content FROM snapshot WHERE snapshot_id = ?').get(second.snapshot_id).content));
  assert.equal(content.comparison_baseline.seed_date, S);
  assert.equal(content.comparison_baseline.seed_report_id, seeded.source_report_id);
  assert.equal(content.comparison_baseline.seed_members_digest, seeded.members_digest);
  // pool_diff is computed against the formal V1 list of the same day.
  assert.equal(content.pool_diff.common.length + content.pool_diff.v1_only.length, content.v1_pool.count);
  assert.equal(content.pool_diff.common.length + content.pool_diff.v2_only.length, content.v2_pool.count);
});

test('seed: refuses once the research chain has started', () => {
  const chainDb = join(dir, 'started.sqlite');
  assert.equal(runResearchSnapshot({ date: S1, dbPath: chainDb }).status, 'ORIGINAL');
  const refused = runResearchSeed({ date: S, dbPath: chainDb });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.reason, 'later_original_snapshot_exists');
  assert.equal(readSnap(db => db.prepare('SELECT COUNT(*) n FROM pool_seed').get().n, chainDb), 0);
  assert.equal(readSnap(db => db.prepare('SELECT COUNT(*) n FROM pool_state WHERE state_source = ?').get('seed').n, chainDb), 0);
});

test('seed: refuses on a date that already has an ORIGINAL snapshot', () => {
  const snapDb = join(dir, 'snapd.sqlite');
  assert.equal(runResearchSnapshot({ date: S, dbPath: snapDb }).status, 'ORIGINAL');
  const refused = runResearchSeed({ date: S, dbPath: snapDb });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.reason, 'original_snapshot_on_seed_date');
});

test('seed: refuses a non-trade day and a date without a formal watchlist', () => {
  const weekend = '20260905';
  live.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, 0)').run(weekend);
  assert.deepEqual(runResearchSeed({ date: weekend, dbPath: DB }), { status: 'REFUSED', reason: 'not_trade_day', trade_date: weekend, db: DB });
  // A trade day without a formal live report/watchlist.
  const noReport = ALL[150];
  const refused = runResearchSeed({ date: noReport, dbPath: join(dir, 'empty.sqlite') });
  assert.equal(refused.status, 'REFUSED');
  assert.ok(['no_formal_watchlist', 'no_live_report'].includes(refused.reason));
});

test('seed: a different formal watchlist for the same date is a hard conflict', () => {
  live.prepare('UPDATE watchlist SET score = score + 1 WHERE trade_date = ? AND ts_code = ?').run(S, formal(S)[0].ts_code);
  try {
    assert.throws(() => runResearchSeed({ date: S, dbPath: DB }), /种子内容冲突/);
    assert.equal(readSnap(db => db.prepare('SELECT COUNT(*) n FROM pool_seed').get().n), 1, 'the original seed is untouched');
    assert.equal(readSnap(db => db.prepare('SELECT * FROM pool_seed WHERE seed_id = ?').get(seeded.seed_id).members_digest), seeded.members_digest);
  } finally {
    live.prepare('UPDATE watchlist SET score = score - 1 WHERE trade_date = ? AND ts_code = ?').run(S, formal(S)[0].ts_code);
  }
});

test.after(() => live.close());
