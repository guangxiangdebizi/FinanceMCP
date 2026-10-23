import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The env must be set before the modules that read it at import time are loaded.
const dir = mkdtempSync(join(tmpdir(), 'ashare-cadence-prod-'));
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
process.env.PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { cadenceProducers, runRealCadence } = await import('../build/ashare/cadenceProducers.js');
const { openAshareDb } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');

/** Each test gets its own market cache, because the cache is a real file and a
 * shared one makes the second fixture's watchlist row collide with the first's.
 * A collision here would be a test artifact, not a finding about the code. */
let counter = 0;
const freshPaths = () => {
  counter += 1;
  return {
    live: join(dir, `live-${counter}.sqlite`),
    portfolio: join(dir, `portfolio-${counter}.sqlite`),
  };
};

/** Phase 6 — the real producers behind the weekly/monthly cadence entry.
 *
 * `ashare-research-cadence.test.mjs` proves the entry's discipline with injected
 * producers. This file proves the *actual* producers, which is the other half of
 * the same requirement and the half that was missing: a tested orchestration
 * over producers that have never been run is a guarantee that nothing wrong gets
 * reported, not a guarantee that anything gets reported.
 *
 * The failure modes under test are the ones that turn an outage into a finding:
 *
 * 1. **A missing market cache becomes a skip, not an empty report.** "The cache
 *    is not there yet" and "the diagnosis found nothing" must be different
 *    records, or a deploy-day outage reads as a quiet negative result.
 * 2. **The market cache and the research workspace are not the same file.** A
 *    symlink or a hard link would put a "research" write on the live cache. The
 *    identity check is the one that catches it; a path-string check does not.
 * 3. **The account ledger is opened read-only.** A cadence report is an
 *    observation, and an observation must not be able to append to what it reads.
 * 4. **A dry run writes nothing and reports where it would have written.** The
 *    plan has to be inspectable against what is already on disk.
 * 5. **A report is never overwritten.** A changed diagnosis for the same as-of
 *    is a different file, so the earlier one stays auditable.
 * 6. **The producer's own reason survives.** A skip that loses its explanation
 *    sends the operator to read the source.
 */

const LIVE = process.env.ASHARE_DB_PATH;
const RESEARCH = process.env.ASHARE_RESEARCH_DB_PATH;
const PORTFOLIO = process.env.PORTFOLIO_DB_PATH;
const ON = { RESEARCH_CADENCE_ENABLED: '1' };

/** 40 closed sessions, enough to clear both floors. */
const CALENDAR = weekdays('20240102', 40);
const AS_OF = CALENDAR.at(-1);

/** A market cache with a calendar and a priced watchlist. */
function marketFixture(t) {
  const { live } = freshPaths();
  const db = openAshareDb(live);
  seedReferenceUniverse(db, CALENDAR, { stocks: 3 });
  // A watchlist row is what `hasCandidates` keys on: without one there is
  // nothing to diagnose, and "no pool" must not read as "no findings".
  db.prepare(`INSERT INTO watchlist(trade_date,ts_code,score,rank,industry,status,reason,entered_on)
    VALUES(?,?,?,?,?,?,?,?)`).run(AS_OF, '600000.SH', 50, 1, '行业0', 'active', 'test', AS_OF);
  // Closed now rather than in `t.after`: several tests need to open the same file
  // again with a different journal mode or from a different connection, and a
  // handle still held open makes SQLite report "database is locked" for the
  // second opener. The fixture's job is to leave a file on disk.
  db.close();
  return live;
}

/** An account ledger with the schema created but no records. */
function portfolioFixture(t, marketPath) {
  const { portfolio } = freshPaths();
  // Create it first: a read-only open of a file that does not exist fails, and
  // "the ledger is absent" is the case the *other* test is for. Here the ledger
  // exists and is empty, which is a different fact.
  const seed = openPortfolioDb(portfolio, { writable: true, marketPath: marketPath });
  seed.close();
  // Force rollback mode. A writable open sets WAL and leaves it set, so a ledger
  // fresh from the fixture is already WAL and a writable open during the run
  // would leave it WAL — indistinguishable. Starting from `delete` makes the
  // flip the read-only assertion looks for.
  forceRollbackJournal(portfolio);
  return portfolio;
}

/** The database's journal mode, read from a throwaway read-only connection.
 *
 * This is the observable that actually distinguishes a read-only open from a
 * writable one. A writable open executes `PRAGMA journal_mode = WAL`, and that
 * flip is written into the database file and persists; a read-only connection
 * cannot change it. A byte comparison cannot tell the two apart — a writable open
 * of a valid ledger runs `CREATE TABLE IF NOT EXISTS` against tables that already
 * exist and changes nothing, which is exactly why a `writable: true` mutation
 * survived every byte-comparison assertion in this file. */
function journalMode(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('PRAGMA journal_mode').get().journal_mode;
  } finally {
    db.close();
  }
}

/** Put the database into rollback journalling.
 *
 * A writable open sets WAL and leaves it set, so a database fresh from a
 * writable fixture is already WAL — and a writable open during the run would
 * leave it WAL, indistinguishable from before. Starting from `delete` is what
 * makes the flip the read-only assertion looks for. */
function forceRollbackJournal(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
}

test('a missing market cache is a skip with a reason, not an empty report', async () => {
  // This is the deploy-day case: the cadence runs before the cache exists. An
  // entry that returned "0 claims" here would file an outage as a finding.
  const result = await runRealCadence('weekly', { asOf: AS_OF, env: ON, marketDbPath: join(dir, 'absent.sqlite') });
  assert.equal(result.produced, false);
  // The reason is asserted, not just the fact of skipping. `no_candidates` is
  // the tempting substitution because it is also a skip — but it says "there was
  // nothing to report on", which is a quiet week, while this is an outage. A
  // mutation that swapped the reason while keeping the detail survived the
  // first version of this test.
  assert.equal(result.skip_reason, 'diagnosis_unavailable',
    'a missing cache is an outage, not a quiet week');
  assert.notEqual(result.skip_reason, 'no_candidates');
  assert.match(result.detail ?? '', /行情缓存不存在/);
  assert.equal(result.report, null, 'a skip must not carry a report');
});

test('a market cache without a calendar is an outage, not a short history', async (t) => {
  // `closedSessionsBefore` catches a query failure and returns null, which the
  // entry reports as `diagnosis_unavailable`. Returning 0 instead would report
  // `not_enough_history` — "come back later" — for a database that will never
  // have a calendar. The mutation was killed by this test, not by the earlier
  // ones: every other fixture has a working calendar, so only this one reaches
  // the catch.
  const { live } = freshPaths();
  // An empty database: the schema exists, the calendar does not.
  const db = openAshareDb(live);
  t.after(() => db.close());
  db.exec('DELETE FROM trade_cal');
  const result = await runRealCadence('weekly', {
    asOf: AS_OF, env: ON, marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite'),
  });
  assert.equal(result.skip_reason, 'diagnosis_unavailable',
    'a calendar that cannot be read is an outage, not a shortage of history');
  assert.notEqual(result.skip_reason, 'not_enough_history');
});

test('a market cache whose calendar cannot be queried is an outage, not zero history', async (t) => {
  // A relation that passes the table-exists guard and then throws is the case the
  // `catch` is for. The wiped-calendar test above covers an empty table; this
  // covers one that cannot answer at all. Returning 0 here would file an outage
  // as `not_enough_history`, which reads as "come back later" for a database
  // that will never have a calendar.
  const { live } = freshPaths();
  const db = openAshareDb(live);
  t.after(() => db.close());
  // A table with the wrong columns: `sqlite_master` reports it, so the
  // table-exists guard passes, and the aggregate then throws on the missing
  // column. That is the only way to reach the `catch` — a view is registered as
  // type='view' and short-circuits to null first, which is how the first
  // version of this fixture failed to kill the mutant.
  db.exec('DROP TABLE trade_cal');
  db.exec('CREATE TABLE trade_cal (wrong_name TEXT)');
  const result = await runRealCadence('weekly', {
    asOf: AS_OF, env: ON, marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite'),
  });
  assert.equal(result.skip_reason, 'diagnosis_unavailable',
    'an unqueryable calendar is an outage, not a shortage of history');
  assert.notEqual(result.skip_reason, 'not_enough_history');
});

test('the real weekly diagnosis produces a report naming what it was derived from', async (t) => {
  const live = marketFixture(t);
  const result = await runRealCadence('weekly', {
    asOf: AS_OF, env: ON, dryRun: true,
    outputDir: join(dir, 'out'), marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite'),
  });
  assert.equal(result.skip_reason, null, `unexpected skip: ${result.skip_reason} ${result.detail ?? ''}`);
  assert.equal(result.dry_run, true);
  // The report is the diagnosis's own, not a stand-in: it carries the version and
  // the as-of the diagnosis actually used.
  assert.equal(result.report.version, 'diagnosis-1.0.0');
  assert.equal(result.report.as_of, AS_OF);
  assert.equal(result.written_to, null, 'a dry run persists nothing');
  assert.equal(existsSync(join(dir, 'out', `diagnosis-${AS_OF}.json`)), false,
    'the dry run must not have left a file behind');
});

test('a weekly report that is written is never overwritten', async (t) => {
  const live = marketFixture(t);
  const absent = join(dir, 'p-absent.sqlite');
  const out = join(dir, 'out2');
  const first = await runRealCadence('weekly', { asOf: AS_OF, env: ON, outputDir: out, marketDbPath: live, portfolioDbPath: absent });
  assert.equal(first.produced, true, `expected a report, got ${first.skip_reason} ${first.detail ?? ''}`);
  const path = first.written_to;
  assert.ok(path && existsSync(path), 'the write must report where it landed');
  // Corrupting the file and re-running must not replace it: the earlier
  // diagnosis is the auditable one, and a later run must not rewrite history.
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, '{"tampered":true}', 'utf8');
  const second = await runRealCadence('weekly', { asOf: AS_OF, env: ON, outputDir: out, marketDbPath: live, portfolioDbPath: absent });
  assert.equal(second.produced, true);
  assert.equal(second.written_to, path, 'the same as-of maps to the same file');
  assert.equal(readFileSync(path, 'utf8'), '{"tampered":true}',
    'an existing report must not be overwritten by a later run');
  writeFileSync(path, before, 'utf8');
});

test('the market cache and the research workspace may not be the same file', async (t) => {
  const live = marketFixture(t);
  // A symlink to the live cache is a "research" path that is the live cache. The
  // identity check, not the string comparison, is what has to reject it — the
  // strings are obviously different.
  const alias = join(dir, 'alias-to-live.sqlite');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(live, alias);
  t.after(() => { try { require('node:fs').unlinkSync(alias); } catch {} });
  await assert.rejects(
    () => runRealCadence('weekly', { asOf: AS_OF, env: ON, marketDbPath: alias, researchDbPath: alias, portfolioDbPath: join(dir, 'p-absent.sqlite') }),
    /指向同一文件/,
    'a research path that resolves to the live cache must be refused',
  );
});

test('the monthly review needs the account ledger and an account id', async (t) => {
  const live = marketFixture(t);
  // No ledger: this is a skip that names the missing file, not a review that
  // reports "no improvement" because it had nothing to look at.
  const noLedger = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, portfolioDbPath: join(dir, 'absent-portfolio.sqlite'), marketDbPath: live,
  });
  assert.equal(noLedger.produced, false);
  assert.equal(noLedger.skip_reason, 'review_unavailable');
  assert.match(noLedger.detail ?? '', /账户库不存在/);

  // A ledger that exists but no account id: the review is account-scoped, and
  // defaulting to some account would silently change whose performance is
  // being reported. The assertion is on the *up-front* refusal specifically —
  // both the guard and the producer's internal check mention `account_id`, so
  // matching that substring cannot tell them apart, which is exactly how a
  // mutation deleting the guard stayed green.
  const portfolio = portfolioFixture(t, live);
  const noAccount = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, accountId: undefined, portfolioDbPath: portfolio, marketDbPath: live,
  });
  assert.equal(noAccount.produced, false);
  assert.equal(noAccount.skip_reason, 'review_unavailable');
  assert.equal(noAccount.detail, '每月实验评审需要 account_id；不得默认账户',
    'the refusal must come from the up-front guard, before any ledger work');
});

test('a monthly review that finds no ledger creates none', async (t) => {
  // The ledger is opened only when it already exists, and read-only when it
  // does. Both halves matter: `openPortfolioDb` with `writable: true` creates
  // the file and its schema, which would turn "the ledger is absent" into "the
  // ledger is empty" — and a later run would then report on a ledger this run
  // invented. The absence is asserted, not just the skip reason.
  const live = marketFixture(t);
  const absent = join(dir, 'never-created.sqlite');
  const result = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, accountId: 'real-main', portfolioDbPath: absent, marketDbPath: live,
  });
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'review_unavailable');
  assert.equal(existsSync(absent), false, 'a cadence run must not create the account ledger');
  assert.equal(existsSync(absent + '-wal'), false, 'and must not leave a WAL beside it');

  // And a ledger that *does* exist is opened without being written. The bytes
  // alone are not enough to prove read-only — a writable open of a valid ledger
  // runs `CREATE TABLE IF NOT EXISTS` against tables that already exist and
  // changes nothing, which is why a `writable` mutation survived every
  // byte-comparison test. The journal mode is what catches it: a writable open
  // sets WAL and that persists, a read-only connection cannot change it.
  const { portfolio } = freshPaths();
  const seed = openPortfolioDb(portfolio, { writable: true, marketPath: live });
  seed.close();
  forceRollbackJournal(portfolio);
  const before = readFileSync(portfolio);
  const modeBefore = journalMode(portfolio);
  const ran = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, accountId: 'real-main', portfolioDbPath: portfolio, marketDbPath: live,
  });
  assert.equal(ran.skip_reason, null, `unexpected skip: ${ran.detail ?? ''}`);
  assert.deepEqual(readFileSync(portfolio), before,
    'an existing ledger must be read, not written, by a cadence run');
  assert.equal(journalMode(portfolio), modeBefore,
    'and must not be switched into WAL mode by the open');

  // A non-database file at the ledger path is opened read-only and then fails
  // loudly inside the review, rather than being opened for writing. The point is
  // that the failure comes from the review refusing a corrupt ledger — a
  // writable open would have thrown "file is not a database" at open time,
  // before any read was attempted, which is the observable that distinguishes
  // the two.
  const junk = join(dir, 'not-a-database.sqlite');
  writeFileSync(junk, 'this is not a sqlite database', 'utf8');
  t.after(() => { try { unlinkSync(junk); } catch {} });
  await assert.rejects(
    () => runRealCadence('monthly', {
      asOf: AS_OF, env: ON, accountId: 'real-main', portfolioDbPath: junk, marketDbPath: live,
    }),
    /file is not a database/,
    'a corrupt ledger must fail inside the review, not be opened for writing',
  );
  // The file is untouched: a writable open would have rewritten its header.
  assert.equal(readFileSync(junk, 'utf8'), 'this is not a sqlite database',
    'the corrupt ledger must not be modified');
});

test('the monthly review is read-only against the account ledger', async (t) => {
  const live = marketFixture(t);
  const portfolio = portfolioFixture(t, live);
  const before = readFileSync(portfolio);
  // The cadence run must not append: an observation must not be able to write to
  // the ledger it observes. Three assertions, because each one catches a
  // different mutation and the first two are not enough on their own.
  //
  // The journal mode is the one that catches a *writable* open, and it has to be
  // forced to a non-WAL value first: a freshly created ledger is already WAL, so
  // a writable open would leave it WAL and look identical. This is the assertion
  // that killed the `writable: true` mutation the byte comparison could not.
  const modeBefore = journalMode(portfolio);
  assert.equal(modeBefore, 'delete', 'fixture precondition: the ledger starts in rollback mode');
  const result = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, accountId: 'real-main', portfolioDbPath: portfolio, marketDbPath: live,
  });
  assert.equal(result.skip_reason, null, `unexpected skip: ${result.detail ?? ''}`);
  // An empty ledger yields NO_MATURED_FORWARD_SAMPLE. That is the honest answer,
  // and the important part is that it is not "no improvement" — which is what a
  // review with nothing to look at would say if it mistook silence for a result.
  assert.equal(result.report.conclusion, 'NO_MATURED_FORWARD_SAMPLE',
    'an empty ledger must report no matured sample, not no improvement');
  assert.equal(result.report.true_forward_start, '20261022');
  assert.ok(result.written_to && existsSync(result.written_to), 'the review reports where it was written');
  assert.equal(readFileSync(result.written_to, 'utf8').includes('review_id'), true,
    'the written review carries its identity');
  assert.equal(journalMode(portfolio), modeBefore,
    'a read-only open cannot switch the ledger into WAL mode');
  assert.deepEqual(readFileSync(portfolio), before, 'the cadence run must not modify the account ledger');
});

test('the weekly diagnosis reads the live market cache without writing it', async (t) => {
  // The market cache is the live production database. A cadence that opened it
  // writable would be the one failure the task spec most explicitly forbids, and
  // the bytes alone cannot catch it — the same blind spot as the ledger: a
  // writable open of a valid cache runs `CREATE TABLE IF NOT EXISTS` against
  // tables that already exist and changes nothing. The journal mode is the
  // observable that survives.
  const live = marketFixture(t);
  forceRollbackJournal(live);
  const before = readFileSync(live);
  const modeBefore = journalMode(live);
  const result = await runRealCadence('weekly', {
    asOf: AS_OF, env: ON, dryRun: true, outputDir: join(dir, 'out3'),
    marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite'),
  });
  assert.equal(result.skip_reason, null, `unexpected skip: ${result.detail ?? ''}`);
  assert.equal(result.report.version, 'diagnosis-1.0.0');
  assert.equal(journalMode(live), modeBefore,
    'the live market cache must not be switched into WAL mode by a cadence run');
  assert.deepEqual(readFileSync(live), before, 'and must not be modified byte-for-byte');
});

test('a closed run closes the database handles it opened', async (t) => {
  // A cadence that leaks the market cache holds a read lock on the live database
  // across the next run, and the next run is the one that fails mysteriously.
  const live = marketFixture(t);
  const before = process._getActiveHandles().length;
  for (let i = 0; i < 3; i += 1) {
    const result = await runRealCadence('weekly', { asOf: AS_OF, env: {}, marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite') });
    assert.equal(result.skip_reason, 'disabled');
  }
  const after = process._getActiveHandles().length;
  assert.ok(after <= before + 1, `handles grew from ${before} to ${after}; the run is leaking a database`);
});

test('disabled by default, enforced by the real producer path too', async (t) => {
  // The discipline the entry was tested for must hold when the producers are
  // real. A caller who forgets the switch must still get an inert run.
  const live = marketFixture(t);
  const result = await runRealCadence('weekly', { asOf: AS_OF, env: {}, marketDbPath: live, portfolioDbPath: join(dir, 'p-absent.sqlite') });
  assert.equal(result.produced, false);
  assert.equal(result.skip_reason, 'disabled');
  assert.equal(result.report, null);
});

test('the monthly review file is content-addressed and mode 0600', async (t) => {
  const live = marketFixture(t);
  const portfolio = portfolioFixture(t, live);
  const out = join(dir, 'reviews');
  const result = await runRealCadence('monthly', {
    asOf: AS_OF, env: ON, accountId: 'real-main', portfolioDbPath: portfolio, marketDbPath: live, outputDir: out,
  });
  assert.equal(result.skip_reason, null, `unexpected skip: ${result.detail ?? ''}`);
  const path = result.written_to;
  assert.ok(path && existsSync(path));
  // The filename carries the as-of and the review id, so a changed review is a
  // new file rather than an overwrite of a conclusion someone already acted on.
  assert.match(path, new RegExp(`${AS_OF}-FR-[0-9a-f]{24}\\.json$`));
  const { statSync } = await import('node:fs');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'a forward review is private');
});
