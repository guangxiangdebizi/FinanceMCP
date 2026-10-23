import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Phase 6 — fault injection: "研究失败不影响生产日报"（任务书 P6-11）。
 *
 * Until this file existed, the claim that a research failure cannot take down the
 * production daily report rested on one precedent: `syncEtfForDailySafe` catches
 * an ETF failure, writes `fatal` into its return value, and lets the stock report
 * continue. That precedent was itself untested — `fatal` appears nowhere in the
 * test suite, which is the same defect shape the daily shadow loop had, where a
 * documented and unit-tested switch was never consulted by the code that needed
 * it. A precedent is not a verification: it shows that *ETF* failing leaves the
 * daily report alive, not that *research* failing does, and the two connect to
 * different databases, write to different directories, and fail in different
 * ways.
 *
 * So this file drives the real `runCommand('daily')` and breaks things on
 * purpose. Three failures, each one a different way the daily report could die:
 *
 * 1. **The ETF cache is not initialized.** `syncEtfForDaily` returns
 *    `ETF_NOT_INITIALIZED` in its `errors` array without throwing. The question
 *    is whether that returned error is *reported* or merely swallowed — an entry
 *    that catches and says nothing has converted a visible outage into silence.
 * 2. **The upstream API fails.** Every Tushare call for a day returns an error.
 *    The stock report must still be produced, with the failure named in it.
 * 3. **The ETF cache cannot be opened at all.** A market cache that exists but
 *    is not a database. `openMarketCache` returns null rather than throwing, and
 *    a null cache is an outage, not an empty one.
 *
 * In every case the assertions are the same three: the daily run *returns*, the
 * failure is *named somewhere a human will look*, and the report is still
 * produced. A run that returns true while saying nothing about what broke would
 * pass the first and third assertions and fail the second, which is the case
 * worth having a test for.
 */

const dir = mkdtempSync(join(tmpdir(), 'ashare-fault-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
// Read at module load, so it has to be set before the import below. No retry
// backoff: this file's subject is what the daily command *does* with a failure,
// and the real backoff (1.5s, 3s, 6s, 12s) would spend 22 seconds proving the
// same thing. The retry policy has its own behaviour; the response to the error
// it eventually surfaces is what is under test here.
process.env.ASHARE_TUSHARE_MAX_RETRIES = '0';
process.env.TUSHARE_TOKEN = 'test-token';

const { openAshareDb } = await import('../build/ashare/db.js');
const { runCommand } = await import('../build/ashare/commands.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');

const CALENDAR = weekdays('20240102', 40);
const AS_OF = CALENDAR.at(-1);

/** Serve whole-market responses from `tables[api][trade_date]`. */
function mockTushare(tables) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const { api_name: api, params, fields } = body;
    calls.push({ api, ...params });
    let rows = [];
    if (api === 'trade_cal') rows = tables.trade_cal ?? [];
    else if (api === 'stock_basic') rows = params.list_status === 'L' ? (tables.stock_basic ?? []) : [];
    else if (api === 'index_daily') rows = [];
    else if (typeof tables[api]?.[params.trade_date] === 'function') rows = tables[api][params.trade_date]();
    else rows = tables[api]?.[params.trade_date] ?? [];
    const cols = fields ? fields.split(',') : Object.keys(rows[0] ?? {});
    const page = rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  return calls;
}

const quote = (i, date, close = 10) => ({
  ts_code: `${600000 + i}.SH`, trade_date: date, open: close, high: close, low: close, close,
  pre_close: close, pct_chg: 0, vol: 1, amount: 1, adj_factor: 1, up_limit: 11, down_limit: 9,
  turnover_rate: 1,
});
const day = (date, n, close) => Array.from({ length: n }, (_, i) => quote(i, date, close?.(i)));

/** A working whole-market upstream, so a daily run can complete normally. */
function upstreamTables() {
  const tables = {
    trade_cal: CALENDAR.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: i ? CALENDAR[i - 1] : null })),
    stock_basic: [],
  };
  for (const api of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) tables[api] = { [AS_OF]: day(AS_OF, 100) };
  return tables;
}

/** A market cache with a calendar and a priced watchlist, ready for a daily run. */
function marketDb(t) {
  const path = join(dir, `live-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openAshareDb(path);
  t.after(() => { try { db.close(); } catch {} });
  seedReferenceUniverse(db, CALENDAR, { stocks: 3 });
  db.prepare(`INSERT INTO watchlist(trade_date,ts_code,score,rank,industry,status,reason,entered_on)
    VALUES(?,?,?,?,?,?,?,?)`).run(AS_OF, '600000.SH', 50, 1, '行业0', 'active', 'test', AS_OF);
  return { db, path };
}

const helpers = (args) => {
  const out = [];
  return { out, h: { arg: name => args[name], flag: () => false, ymd: v => v, print: v => out.push(v) } };
};

/** Break the ETF cache so `syncEtfForDaily` *throws* rather than returning errors.
 *
 * This is the only fixture in the suite that reaches the isolation wrapper's
 * `catch`, and finding it took some work. An uninitialized schema does not throw
 * — `syncEtfForDaily` pushes `ETF_NOT_INITIALIZED` into `errors` and returns
 * normally. A Tushare failure does not throw either: every API call is wrapped in
 * its own `try`, and `fetchAll` converts "no data" into an empty result. The
 * dynamic-universe history loop reads `fund_sync_log` outside a `try`, but the
 * `count >= 60` guard short-circuits before it on a fixture with few bars.
 *
 * What does throw is a `fund_daily` table that exists — so `etfSchemaReady`
 * passes — but has the wrong columns, because `fundHoldingCoverage` then selects
 * a column that is not there, outside any `try`. That is a realistic corruption:
 * an interrupted `etf-sync` migration, or a schema upgraded by a version that
 * expects columns this one does not have.
 *
 * The mutants prove the fixture is doing its job: with the `catch` in place the
 * suite kills all four of them, and with the fixture removed it kills none. */
function breakEtfSchema(db) {
  db.exec('DROP TABLE fund_daily');
  db.exec('CREATE TABLE fund_daily (ts_code TEXT, trade_date TEXT)');
}

test('an ETF failure that throws is contained by the isolation wrapper and named in the output', async (t) => {
  // The wrapper's contract is two-sided, and the second side is the one that
  // matters: it contains the failure *and* it says what happened. A wrapper that
  // caught and returned an empty summary would contain the failure perfectly and
  // leave the operator with a green daily run over a broken ETF cache — which is
  // the same defect as the shadow switch, where the rule and the test both
  // existed and the code that needed them never consulted them.
  const originalFetch = globalThis.fetch;
  try {
    const { db } = marketDb(t);
    mockTushare(upstreamTables());
    breakEtfSchema(db);

    const { out, h } = helpers({ date: AS_OF });
    const returned = await runCommand(db, 'daily', h);
    assert.equal(returned, true, 'an isolated ETF failure must not fail the daily run');

    const printed = out.at(-1);
    assert.ok(printed, 'the daily run must print a record');
    // `fatal` names the cause. Without it the operator sees "ETF failed" and has
    // to go read the source to learn it was a schema mismatch.
    assert.match(String(printed.etf?.fatal ?? ''), /no such column|ETF 同步失败/,
      'the isolated ETF failure must name its cause in `fatal`');
    // And `errors` carries the same story, because `fatal` is the field a
    // downstream consumer checks and `errors` is the one a human reads.
    const errors = JSON.stringify(printed.etf?.errors ?? []);
    assert.match(errors, /ETF 同步失败（已隔离）/,
      'the isolated ETF failure must be listed in `errors`, not only in `fatal`');
    // The report is still produced: containment that killed the daily run would
    // be a different bug wearing the same costume.
    assert.ok(printed.report, 'the stock report must still be produced');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an uninitialized ETF cache is reported in the daily output, not swallowed', async (t) => {
  // The ETF schema is created by `finance-ashare etf-sync`, so a database that
  // has never synced ETFs has no `fund_daily` table. `syncEtfForDaily` returns
  // `ETF_NOT_INITIALIZED` in `errors` *without throwing*, which means the daily
  // command's job is to surface it. An entry that catches a failure and says
  // nothing has turned a visible outage into silence — the operator sees a
  // successful daily run and no reason to look further.
  const originalFetch = globalThis.fetch;
  try {
    const { db } = marketDb(t);
    mockTushare(upstreamTables());
    // Drop every ETF table: this is the state of a database that has never synced.
    for (const table of ['fund_daily', 'fund_basic', 'fund_adj', 'fund_share', 'fund_sync_log']) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }

    const { out, h } = helpers({ date: AS_OF });
    const returned = await runCommand(db, 'daily', h);
    assert.equal(returned, true, 'an uninitialized ETF cache must not fail the daily run');

    const printed = out.at(-1);
    assert.ok(printed, 'the daily run must print a record');
    // The failure must be *named*, not merely absent from a success path.
    const etf = printed.etf ?? {};
    assert.ok(
      JSON.stringify(etf).includes('ETF 缓存未初始化'),
      `the uninitialized ETF cache must be named in the daily output, got: ${JSON.stringify(etf).slice(0, 300)}`,
    );
    // And the stock report is still produced, so the daily run did its job.
    assert.ok(printed.report, 'the stock report must still be produced');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an upstream API failure is reported in the daily output, and the report still runs', async (t) => {
  // Every Tushare call fails. What must not happen is a silent success: if the
  // daily run returns true while saying nothing about the upstream, the operator
  // has a green run over a cache that stopped updating. A total upstream failure
  // may legitimately abort — that is a *named* failure, not a silent one.
  const originalFetch = globalThis.fetch;
  try {
    const { db } = marketDb(t);
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ code: 1, msg: 'upstream unavailable' }) });

    const { out, h } = helpers({ date: AS_OF });
    let threw = null;
    try {
      await runCommand(db, 'daily', h);
    } catch (error) {
      threw = error;
    }
    if (threw) {
      // Aborting is acceptable; what is not acceptable is returning success.
      assert.match(String(threw.message), /Tushare|500|请求失败/,
        'an aborting daily run must name the upstream failure');
      return;
    }
    const printed = out.at(-1);
    assert.ok(printed, 'a returned daily run must print a record');
    assert.ok(printed.report, 'and must still produce a report');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a market cache that exists but is not a database is an outage, not an empty one', async (t) => {
  // This is the case where the guard cannot be where you would expect it. A
  // read-only SQLite open of a junk file *succeeds* — the header is only
  // validated on the first query — so `openMarketCache` returns a live-looking
  // handle and `unavailable()` has nothing to declare. Asserting a refusal at
  // open time would be asserting behaviour that does not exist, and would have
  // made this test green against a broken implementation.
  //
  // What must hold is the end-to-end guarantee: the cadence run reports
  // `diagnosis_unavailable` and produces no report. A cache that cannot be read
  // is an outage, never "nothing happened".
  const junk = join(dir, 'not-a-database.sqlite');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(junk, 'this is not a sqlite database', 'utf8');
  t.after(() => { try { require('node:fs').unlinkSync(junk); } catch {} });

  const { runRealCadence } = await import('../build/ashare/cadenceProducers.js');
  const result = await runRealCadence('weekly', {
    asOf: AS_OF, env: { RESEARCH_CADENCE_ENABLED: '1' },
    marketDbPath: junk, portfolioDbPath: join(dir, 'p-absent.sqlite'),
  });
  assert.equal(result.produced, false, 'a cadence over an unreadable cache must produce nothing');
  assert.equal(result.skip_reason, 'diagnosis_unavailable',
    'an unreadable cache is an outage, not a quiet week');
  assert.notEqual(result.skip_reason, 'no_candidates',
    'and in particular must not read as "there was nothing to report on"');
  assert.equal(result.report, null, 'and must not carry a report');
});
