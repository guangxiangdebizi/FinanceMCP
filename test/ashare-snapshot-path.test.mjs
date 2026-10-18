import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-snapshot-path-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || 'test-token';

const { openAshareDb } = await import('../build/ashare/db.js');
const { generateReport } = await import('../build/ashare/report.js');
const {
  runResearchSnapshot, runResearchEvaluate, researchSnapshotDbPath, assertSeparateFromLive,
} = await import('../build/ashare/snapshot.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIVE = process.env.ASHARE_DB_PATH;
const SNAPSHOT_DB = researchSnapshotDbPath();
const ALL = weekdays('20250901', 250);
const DATE = ALL[200];

const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Live state a rejected research command must not change. */
function liveState() {
  const db = new DatabaseSync(LIVE, { readOnly: true });
  try {
    const counts = Object.fromEntries(['report', 'watchlist', 'stock_score', 'daily', 'trade_cal']
      .map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    return { counts, digest: fileHash(LIVE) };
  } finally {
    db.close();
  }
}

// Seed the live cache exactly as the live pipeline would: one formal report.
const seed = openAshareDb();
seedMarket(seed, ALL);
generateReport(seed, DATE, 'live');
seed.close();
assert.ok(existsSync(LIVE), 'live database created');

// Path aliases to the live database, all of which must be rejected.
const hardLink = join(dir, 'hardlink.sqlite');
linkSync(LIVE, hardLink);
const symLink = join(dir, 'symlink.sqlite');
symlinkSync(LIVE, symLink);
const dirLink = join(dir, 'dirlink');
symlinkSync(dir, dirLink, 'dir');
const sub = join(dir, 'sub');
mkdirSync(sub);

const ALIASES = [
  ['a. absolute live path', LIVE],
  ['b. relative path from cwd', relative(process.cwd(), LIVE)],
  ['c. path with .. segments', join(sub, '..', 'ashare.sqlite')],
  ['d. symlink to the live file', symLink],
  ['e. hard link to the live file', hardLink],
  ['f. symlink to the live directory', join(dirLink, 'ashare.sqlite')],
];

const guardMessage = /研究快照数据库与正式数据库指向同一文件（.+），拒绝执行/;
const before = liveState();
const entriesBefore = readdirSync(dir).sort();

for (const [label, alias] of ALIASES) {
  test(`${label} is rejected by research-snapshot and research-evaluate`, () => {
    assert.throws(() => runResearchSnapshot({ date: DATE, dbPath: alias }), guardMessage, 'snapshot');
    assert.throws(() => runResearchEvaluate({ date: DATE, dbPath: alias }), guardMessage, 'evaluate');
    // The guard exposes the resolved research file, not the raw alias spelling.
    assert.throws(() => assertSeparateFromLive(alias, LIVE), err => {
      assert.match(err.message, guardMessage);
      assert.ok(err.message.includes(realpathSync(alias)), err.message);
      return true;
    });
    // Nothing about the live database changed, and no research database was created.
    assert.deepEqual(liveState(), before, 'live bytes and row counts unchanged');
    assert.deepEqual(readdirSync(dir).sort(), entriesBefore, 'no files or directories created');
    if (label.startsWith('d.') || label.startsWith('e.') || label.startsWith('f.')) {
      const target = label.startsWith('f.') ? join(dirLink, 'ashare.sqlite') : alias;
      assert.equal(fileHash(target), before.digest, 'alias content is still the live database');
    }
  });
}

test('g. the default research path still succeeds and leaves the live database untouched', () => {
  assert.notEqual(SNAPSHOT_DB, LIVE);
  const result = runResearchSnapshot({ date: DATE });
  assert.equal(result.status, 'ORIGINAL', JSON.stringify(result));
  assert.equal(result.db, SNAPSHOT_DB);
  assert.ok(existsSync(SNAPSHOT_DB), 'research database created');
  assert.deepEqual(liveState(), before, 'live bytes and row counts unchanged');
  const snap = new DatabaseSync(SNAPSHOT_DB, { readOnly: true });
  try {
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM snapshot').get().n, 1);
  } finally { snap.close(); }
});

test('h. an explicit distinct research path still succeeds', () => {
  const other = join(dir, 'other', 'forward.sqlite');
  const result = runResearchSnapshot({ date: DATE, dbPath: other });
  assert.equal(result.status, 'ORIGINAL', JSON.stringify(result));
  assert.ok(existsSync(other), 'research database created at the explicit path');
  assert.deepEqual(liveState(), before, 'live bytes and row counts unchanged');
  // Evaluation reads the same distinct research database without touching live.
  const evaluated = runResearchEvaluate({ date: DATE, dbPath: other, asOf: DATE });
  assert.equal(evaluated.status, 'EVALUATED');
  assert.deepEqual(liveState(), before);
});

test('i. a missing non-live research path keeps the not-found error', () => {
  const missing = join(dir, 'missing', 'forward.sqlite');
  assert.throws(() => runResearchEvaluate({ date: DATE, dbPath: missing }), /快照数据库不存在/);
  assert.equal(existsSync(join(dir, 'missing')), false, 'nothing created for a missing path');
  assert.deepEqual(liveState(), before);
});

test('j. the CLI exits non-zero with the guard error for an aliased --db', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'research-snapshot', '--date', DATE, '--db', 'ashare.sqlite'], {
    cwd: dir, env: process.env, encoding: 'utf8',
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /拒绝执行/);
  assert.equal(run.stdout, '', 'no result printed');
  assert.deepEqual(liveState(), before, 'live bytes and row counts unchanged');
});
