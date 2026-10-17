import test from 'node:test';
import assert from 'node:assert/strict';
import { openAshareDb, upsertRows } from '../build/ashare/db.js';
import { evaluateEvents, distribution, correlation, summarizeEvaluation } from '../build/ashare/evaluation.js';

const dates = ['20260105', '20260106', '20260107', '20260109', '20260112', '20260113', '20260114'];
const options = { asOf: dates.at(-1), horizon: 2, buyFeeBps: 0, sellFeeBps: 0, slippageBps: 0, maxExitDelay: 2 };
const event = (date = dates[0], ts_code = '600001.SH', extra = {}) => ({ date, ts_code, ...extra });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
function fixture(t) {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], dates.map(cal_date => ({ cal_date, is_open: 1 })));
  // Jan 8 is deliberately not an exchange day.
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], [{ cal_date: '20260108', is_open: 0 }]);
  const stocks = [
    { ts_code: '600001.SH', industry: 'A', list_date: '20200101' },
    { ts_code: '600002.SH', industry: 'A', list_date: '20200101' },
    { ts_code: '600003.SH', industry: 'B', list_date: '20200101' },
  ];
  upsertRows(db, 'stock_basic', ['ts_code', 'industry', 'list_date'], stocks);
  for (let i = 0; i < dates.length; i++) {
    for (const [j, stock] of stocks.entries()) {
      const price = 10 + j * 10 + i;
      upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'close', 'vol'],
        [{ ts_code: stock.ts_code, trade_date: dates[i], open: price, close: price + 0.5, vol: 1000 }]);
      upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
        [{ ts_code: stock.ts_code, trade_date: dates[i], adj_factor: 1 }]);
      upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'],
        [{ ts_code: stock.ts_code, trade_date: dates[i], up_limit: price * 1.2, down_limit: price * 0.8 }]);
    }
    upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'close'],
      [{ ts_code: '000300.SH', trade_date: dates[i], open: 100 + i, close: 100.5 + i }]);
  }
  return db;
}

test('research evaluator uses exact next exchange open, t+h exchange close, adjustment factors and explicit two-sided costs', t => {
  const db = fixture(t);
  db.prepare('UPDATE adj_factor SET adj_factor=2 WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[3]);
  const opts = { ...options, horizon: 3, buyFeeBps: 10, sellFeeBps: 20, slippageBps: 30 };
  const r = evaluateEvents(db, [event()], opts);
  const o = r.outcomes[0];
  assert.equal(o.status, 'completed');
  assert.equal(o.entry_date, dates[1]);
  assert.equal(o.planned_exit_date, dates[3]);
  closeTo(o.gross_return, 13.5 * 2 / 11 - 1);
  closeTo(o.net_return, (13.5 * 2 / 11) * 0.997 * 0.998 / (1.003 * 1.001) - 1);
  closeTo(o.references.csi300.observed_return, 103.5 / 101 - 1);
  assert.equal(r.scope, 'RESEARCH_ONLY_RETURN_OBSERVATIONS');
  assert.equal(r.summary.denominators.events, 1);
  assert.equal(r.summary.denominators.entered, 1);
  assert.ok(o.net_return < o.gross_return);
});

test('a missing t+1 entry is unpriced and never moved to the next available stock bar', t => {
  const db = fixture(t);
  db.prepare('DELETE FROM daily WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[1]);
  const o = evaluateEvents(db, [event()], options).outcomes[0];
  assert.equal(o.status, 'unpriced');
  assert.equal(o.reason, 'missing_entry_open');
  assert.equal(o.entry_date, dates[1]);
  assert.equal(o.entered, false);
  assert.equal(o.net_return, null);
});

test('suspension, zero-volume and open at up-limit block entry conservatively', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO suspend_d(ts_code,trade_date) VALUES (?,?)').run('600001.SH', dates[1]);
  db.prepare('UPDATE daily SET vol=0 WHERE ts_code=? AND trade_date=?').run('600002.SH', dates[1]);
  db.prepare('UPDATE stk_limit SET up_limit=31 WHERE ts_code=? AND trade_date=?').run('600003.SH', dates[1]);
  const r = evaluateEvents(db, [event(), event(dates[0], '600002.SH'), event(dates[0], '600003.SH')], options);
  assert.deepEqual(r.outcomes.map(o => o.reason), ['entry_suspended', 'entry_zero_volume', 'entry_open_at_up_limit']);
  assert.equal(r.summary.denominators.statuses.entry_blocked, 3);
  assert.equal(r.summary.net_return.n, 0);
});

test('missing entry limits and missing volume are unknown, not fillable or blocked', t => {
  const db = fixture(t);
  db.prepare('DELETE FROM stk_limit WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[1]);
  db.prepare('UPDATE daily SET vol=NULL WHERE ts_code=? AND trade_date=?').run('600002.SH', dates[1]);
  const r = evaluateEvents(db, [event(), event(dates[0], '600002.SH')], options);
  assert.deepEqual(r.outcomes.map(o => o.reason), ['entry_limit_unknown', 'entry_volume_unknown']);
  assert.equal(r.summary.denominators.statuses.entry_unknown, 2);
});

test('down-limit sales and suspension defer by bounded exchange days; references match actual delayed exit', t => {
  const db = fixture(t);
  db.prepare('UPDATE stk_limit SET down_limit=12.5 WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[2]);
  db.prepare('INSERT INTO suspend_d(ts_code,trade_date) VALUES (?,?)').run('600001.SH', dates[3]);
  const r = evaluateEvents(db, [event()], options);
  const o = r.outcomes[0];
  assert.equal(o.status, 'completed');
  assert.equal(o.exit_date, dates[4]);
  assert.equal(o.exit_delay, 2);
  assert.deepEqual(o.exit_obstacles.map(x => x.reason), ['exit_close_at_down_limit', 'exit_suspended']);
  closeTo(o.references.csi300.observed_return, 104.5 / 101 - 1);
  closeTo(o.net_return, 14.5 / 11 - 1);
  const exhausted = evaluateEvents(db, [event()], { ...options, maxExitDelay: 1 }).outcomes[0];
  assert.equal(exhausted.status, 'unexited');
  assert.equal(exhausted.reason, 'exit_delay_exhausted');
  assert.equal(exhausted.net_return, null);
});

test('missing exit limits remain unexited instead of assuming a later fill', t => {
  const db = fixture(t);
  db.prepare('DELETE FROM stk_limit WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[2]);
  const o = evaluateEvents(db, [event()], options).outcomes[0];
  assert.equal(o.status, 'unexited');
  assert.equal(o.reason, 'exit_limit_unknown');
  assert.equal(o.exit_date, null);
  assert.equal(o.entered, true);
});

test('delisted and missing-price events remain in denominators and reference membership', t => {
  const db = fixture(t);
  db.prepare('UPDATE stock_basic SET delist_date=? WHERE ts_code=?').run(dates[2], '600003.SH');
  db.prepare('DELETE FROM daily WHERE ts_code=? AND trade_date>=?').run('600003.SH', dates[2]);
  const r = evaluateEvents(db, [event(), event(dates[0], '600003.SH'), event(dates[0], '999999.SZ')], options);
  assert.equal(r.outcomes.length, 3);
  assert.deepEqual(r.outcomes.map(o => o.status), ['completed', 'unexited', 'unpriced']);
  assert.equal(r.outcomes[1].reason, 'delisted_missing_exit_close');
  assert.equal(r.summary.denominators.reasons.delisted_missing_exit_close, 1);
  assert.equal(r.summary.denominators.entered, 2);
  assert.equal(r.summary.denominators.unresolved_after_entry, 1);
  assert.equal(r.summary.denominators.not_entered, 1);
  const ref = r.outcomes[0].references.equal_market;
  assert.equal(ref.status, 'partial');
  assert.equal(ref.eligible, 3);
  assert.equal(ref.priced, 2);
  assert.equal(ref.unresolved, 1);
  const stats = r.summary.benchmarks.equal_market;
  assert.equal(stats.complete_coverage_events, 0);
  assert.equal(stats.partial_coverage_events, 1);
  assert.equal(stats.excess_complete_coverage.n, 0);
  assert.equal(stats.excess_including_priced_subsets.n, 1);
});

test('delisting reasons use execution-date diagnostics, and signal-date benchmark membership excludes the delisting date', t => {
  const db = fixture(t);
  db.prepare('UPDATE stock_basic SET delist_date=? WHERE ts_code=?').run(dates[1], '600002.SH');
  db.prepare('DELETE FROM daily WHERE ts_code=? AND trade_date>=?').run('600002.SH', dates[1]);
  const entry = evaluateEvents(db, [event(dates[0], '600002.SH')], options).outcomes[0];
  assert.equal(entry.reason, 'delisted_missing_entry_open');
  assert.equal(entry.status, 'unpriced');
  // Delisting later than the attempted exit is not retrospectively used to explain an earlier gap.
  db.prepare('UPDATE stock_basic SET delist_date=? WHERE ts_code=?').run(dates[4], '600003.SH');
  db.prepare('DELETE FROM daily WHERE ts_code=? AND trade_date=?').run('600003.SH', dates[2]);
  const earlierGap = evaluateEvents(db, [event(dates[0], '600003.SH')], options).outcomes[0];
  assert.equal(earlierGap.reason, 'missing_exit_close');
  db.prepare('UPDATE stock_basic SET delist_date=? WHERE ts_code=?').run(dates[0], '600003.SH');
  const benchmark = evaluateEvents(db, [event()], options).outcomes[0].references.equal_market;
  assert.equal(benchmark.eligible, 2);
  assert.equal(benchmark.priced, 1);
  assert.equal(benchmark.unresolved, 1);
});

test('missing factors and missing CSI300 are explicit and do not silently drop observations', t => {
  const db = fixture(t);
  db.prepare('DELETE FROM adj_factor WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[2]);
  db.prepare('DELETE FROM index_daily WHERE trade_date=?').run(dates[2]);
  const r = evaluateEvents(db, [event(), event(dates[0], '600002.SH')], options);
  assert.equal(r.outcomes[0].status, 'unpriced');
  assert.equal(r.outcomes[0].reason, 'adjustment_factor_missing');
  assert.equal(r.outcomes[0].entered, true);
  assert.equal(r.outcomes[1].status, 'completed');
  assert.equal(r.outcomes[1].references.csi300.unresolved, 1);
  assert.equal(r.outcomes[1].excess.csi300, null);
  assert.equal(r.summary.benchmarks.csi300.missing, 1);
});

test('market references fix universe at signal date, include missing members and match same industry', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO stock_basic(ts_code,industry,list_date) VALUES (?,?,?)').run('NEW.SH', 'A', dates[1]);
  db.prepare('INSERT INTO stock_basic(ts_code,industry,list_date) VALUES (?,?,?)').run('MISSING.SH', 'B', '20200101');
  const o = evaluateEvents(db, [event()], options).outcomes[0];
  assert.equal(o.references.equal_market.eligible, 4);
  assert.equal(o.references.equal_market.priced, 3);
  assert.equal(o.references.equal_market.unresolved, 1);
  closeTo(o.references.equal_market.observed_return, ((12.5 / 11 - 1) + (22.5 / 21 - 1) + (32.5 / 31 - 1)) / 3);
  assert.equal(o.references.industry.eligible, 2);
  closeTo(o.references.industry.observed_return, ((12.5 / 11 - 1) + (22.5 / 21 - 1)) / 2);
  assert.equal(evaluateEvents(db, [event(dates[0], '600001.SH', { industry: null })], options).outcomes[0].references.industry.status, 'not_applicable');
});

test('strict cutoff leaves pending horizons and does not change when future bars, limits, factors or calendar arrive', t => {
  const db = fixture(t);
  const opts = { ...options, asOf: dates[2], horizon: 3 };
  const before = evaluateEvents(db, [event(), event(dates[2])], opts);
  assert.deepEqual(before.outcomes.map(o => o.reason), ['horizon_after_as_of', 'entry_after_as_of']);
  db.prepare('UPDATE daily SET open=9999, close=9999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('UPDATE adj_factor SET adj_factor=999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('DELETE FROM stk_limit WHERE trade_date>?').run(opts.asOf);
  db.prepare('DELETE FROM trade_cal WHERE cal_date>?').run(opts.asOf);
  assert.deepEqual(evaluateEvents(db, [event(), event(dates[2])], opts), before);
  assert.throws(() => evaluateEvents(db, [event(dates[3])], opts), /after asOf/);
});

test('completed results are reproducible on read-only connections and identical for V1/V2 event selection', t => {
  const db = fixture(t);
  const opts = { ...options, asOf: dates[2] };
  db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES (?,?,?,?,?,?,?)')
    .run(dates[0], '600001.SH', 42, 1, 'active', 'live fixture', dates[0]);
  const beforeState = db.prepare('SELECT * FROM watchlist').all();
  const v1 = evaluateEvents(db, [event()], opts);
  db.prepare('UPDATE daily SET open=9999, close=9999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('UPDATE index_daily SET open=9999, close=9999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('UPDATE adj_factor SET adj_factor=999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('UPDATE stk_limit SET up_limit=999,down_limit=999 WHERE trade_date>?').run(opts.asOf);
  db.prepare('INSERT INTO suspend_d(ts_code,trade_date) VALUES (?,?)').run('600001.SH', dates[3]);
  db.prepare('DELETE FROM trade_cal WHERE cal_date>?').run(opts.asOf);
  db.exec('PRAGMA query_only=ON');
  const v2 = evaluateEvents(db, [event()], opts);
  assert.deepEqual(v2, v1);
  assert.deepEqual(db.prepare('SELECT * FROM watchlist').all(), beforeState);
});

test('known blocked exit beyond cutoff stays pending, not exhausted using a future calendar', t => {
  const db = fixture(t);
  db.prepare('UPDATE stk_limit SET down_limit=12.5 WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[2]);
  const o = evaluateEvents(db, [event()], { ...options, asOf: dates[2] }).outcomes[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.reason, 'exit_delay_after_as_of');
  assert.equal(o.entered, true);
});

test('overlap sensitivity retains whole date cohorts; correlations have pairwise null counts and no significance claims', t => {
  const db = fixture(t);
  const events = [
    event(dates[0], '600001.SH', { score: 10, factors: { quality: 1, absent: null }, signals: ['x'] }),
    event(dates[0], '600002.SH', { score: 20, factors: { quality: 2, absent: null }, signals: [] }),
    event(dates[1], '600001.SH', { score: null, factors: { quality: 3 }, signals: ['x'] }),
    event(dates[2], '600001.SH', { score: 40, factors: { quality: 4 }, signals: [] }),
  ];
  const r = evaluateEvents(db, events, { ...options, horizon: 3 });
  const s = r.summary;
  assert.equal(s.overlap.all_cohorts.events, 4);
  assert.equal(s.overlap.all_cohorts.dates, 3);
  assert.equal(s.overlap.overlapping_cohort_pairs, 3);
  assert.deepEqual(s.overlap.retained_dates, [dates[0]]);
  assert.equal(s.overlap.non_overlapping_cohorts.events, 2);
  assert.deepEqual(s.correlations.find(x => x.feature === 'factor:absent').with_net_return, { n: 0, correlation: null });
  assert.equal(s.correlations.find(x => x.feature === 'score').with_net_return.n, 3);
  assert.equal(s.correlations.find(x => x.feature === 'signal:x').with_net_return.n, 4);
  assert.ok(!JSON.stringify(s).includes('t_stat'));
  assert.match(s.interpretation, /not funded portfolio/);
  assert.deepEqual(summarizeEvaluation(r.outcomes, options.asOf), s);
});

test('A-share T+1 rejects horizon=1 before reading or executing any event', () => {
  const db = { prepare() { throw new Error('must not query before horizon validation'); } };
  // A throwing query stub proves validation runs before any attempted entry/query.
  assert.throws(() => evaluateEvents(db, [event()], { ...options, horizon: 1 }), /horizon.*>=2.*T\+1/);
  assert.throws(() => evaluateEvents(db, [], { ...options, horizon: 1 }), /horizon.*>=2.*T\+1/);
});

test('nonoverlap retains whole cohorts with unresolved entered stocks censored at cutoff and counts no-entry dates', t => {
  const db = fixture(t);
  // A completes Jan 7; B entered with A remains unexited. Jan 8 is a later signal date.
  db.prepare('UPDATE trade_cal SET is_open=1 WHERE cal_date=?').run('20260108');
  db.prepare('DELETE FROM stk_limit WHERE ts_code=? AND trade_date=?').run('600002.SH', dates[2]);
  const events = [event(), event(dates[0], '600002.SH'), event('20260108'), event(dates.at(-1))];
  const r = evaluateEvents(db, events, options);
  assert.deepEqual(r.outcomes.map(o => o.status), ['completed', 'unexited', 'completed', 'pending']);
  const s = r.summary;
  const first = s.by_date[0];
  assert.equal(first.n, 2);
  assert.equal(first.entered, 2);
  assert.equal(first.completed, 1);
  assert.equal(first.unresolved_after_entry, 1);
  assert.equal(first.open_at_cutoff, 1);
  assert.equal(first.censored, true);
  assert.equal(first.exit_date, options.asOf);
  assert.equal(s.overlap.overlapping_cohort_pairs, 1);
  assert.deepEqual(s.overlap.retained_dates, [dates[0]]);
  assert.equal(s.overlap.non_overlapping_cohorts.events, 2);
  assert.equal(s.overlap.non_overlapping_cohorts.completed, 1);
  assert.equal(s.overlap.non_overlapping_cohorts.unresolved_after_entry, 1);
  assert.equal(s.overlap.all_cohorts.events, 4);
  assert.equal(s.overlap.all_cohorts.entered, 3);
  assert.equal(s.overlap.all_cohorts.completed, 2);
  assert.equal(s.overlap.all_cohorts.not_entered, 1);
  assert.deepEqual(s.overlap.excluded_no_entry_dates, [dates.at(-1)]);
  assert.equal(s.by_date.at(-1).net_return, null);
  assert.equal(s.by_date.at(-1).entry_date, null);
  assert.deepEqual(summarizeEvaluation(r.outcomes, options.asOf), s);
});

test('an entirely unresolved cohort still blocks later cohorts; an observed exit missing adjustment data does not stay open', t => {
  const db = fixture(t);
  db.prepare('DELETE FROM daily WHERE ts_code=? AND trade_date=?').run('600002.SH', dates[2]);
  const open = evaluateEvents(db, [event(dates[0], '600002.SH'), event(dates[3])], options);
  assert.deepEqual(open.summary.overlap.retained_dates, [dates[0]]);
  assert.equal(open.summary.overlap.non_overlapping_cohorts.completed, 0);
  assert.equal(open.summary.overlap.non_overlapping_cohorts.net_return.mean, null);
  assert.equal(open.summary.overlap.non_overlapping_cohorts.synthetic_observation_drawdown, null);
  db.prepare('DELETE FROM adj_factor WHERE ts_code=? AND trade_date=?').run('600001.SH', dates[2]);
  const exited = evaluateEvents(db, [event(), event(dates[3])], options);
  assert.equal(exited.outcomes[0].reason, 'adjustment_factor_missing');
  assert.equal(exited.summary.by_date[0].open_at_cutoff, 0);
  assert.equal(exited.summary.by_date[0].exit_date, dates[2]);
  assert.deepEqual(exited.summary.overlap.retained_dates, [dates[0], dates[3]]);
});

test('correlation and distributions preserve nulls, sample volatility and decimal units', () => {
  assert.deepEqual(correlation([[null, 1], [2, 2], [3, 4], [undefined, 5]]), { n: 2, correlation: 1 });
  assert.deepEqual(correlation([[1, 2], [1, 4]]), { n: 2, correlation: null });
  const d = distribution([-0.1, 0, 0.1, null, NaN]);
  assert.equal(d.n, 3);
  closeTo(d.mean, 0);
  closeTo(d.median, 0);
  closeTo(d.volatility, 0.1);
  closeTo(d.win_rate, 1 / 3);
  assert.equal(distribution([]).mean, null);
});

test('invalid options and non-exchange signal dates fail explicitly', t => {
  const db = fixture(t);
  for (const bad of [{ horizon: 0 }, { horizon: 1.1 }, { maxExitDelay: -1 }, { sellFeeBps: 10000 }, { slippageBps: NaN }, { asOf: '20260230' }]) {
    assert.throws(() => evaluateEvents(db, [event()], { ...options, ...bad }));
  }
  assert.equal(evaluateEvents(db, [event('20260108')], options).outcomes[0].reason, 'signal_not_in_exchange_calendar');
  const empty = evaluateEvents(db, [], options);
  assert.equal(empty.summary.denominators.events, 0);
  assert.equal(empty.summary.net_return.mean, null);
});
