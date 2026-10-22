import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { FROZEN_FIVE_QUANTITIES } = await import('../build/portfolio/benchmarks.js');
const { recordResearchJournal } = await import('../build/portfolio/researchJournal.js');
const { buildForwardReview, classifyRecord, TRUE_FORWARD_START, MIN_NON_OVERLAPPING_WINDOWS } = await import('../build/portfolio/forwardReview.js');

const dir = mkdtempSync(join(tmpdir(), 'forward-review-'));
let seq = 0;
const feeEstimator = () => ({ total_cents: 10, estimated: true, version: 'synthetic-v1' });
const BENCH = ['510300.SH', '511010.SH', '518880.SH', '513100.SH'];

function weekdays(from, n) {
  const out = [];
  for (let d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}T00:00:00Z`); out.length < n; d = new Date(+d + 86400000)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
}
function market(dates, growth) {
  const db = openAshareDb(join(dir, `m-${seq += 1}.sqlite`));
  const codes = [...new Set(['510500.SH', ...BENCH, ...Object.keys(FROZEN_FIVE_QUANTITIES)])];
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], dates.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: dates[i - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    codes.map(ts_code => ({ ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' })));
  for (const ts_code of codes) dates.forEach((trade_date, i) => {
    const close = 1 * (1 + growth(ts_code) * i);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code, trade_date, adj_factor: 1 }]);
  });
  return db;
}
function recordAt(db, input, at) {
  const Actual = globalThis.Date;
  globalThis.Date = class extends Actual {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return Actual.parse(at); }
  };
  try { return recordResearchJournal(db, input); } finally { globalThis.Date = Actual; }
}
const entry = (id, date, extra = {}) => ({
  record_id: id, account_id: 'synthetic', source: 'vps', as_of_trade_date: date, bundle_id: `b-${id}`,
  generated_at: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T21:15:00+08:00`, versions: { rules: 'v1' },
  judgement: { c: 'observe' }, candidates: [], evidence: [],
  observations: [{ ts_code: '510500.SH', quantity: 10000, direction: 'observe', benchmark_code: '510300.SH' }], ...extra,
});
const at = date => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T21:20:00+08:00`;
const review = (portfolioDb, marketDb, asOf, horizons) => buildForwardReview({ portfolioDb, marketDb, accountId: 'synthetic', asOf, horizons, feeEstimator });

test('pre-forward and retrospective records are counted but never enter forward statistics', () => {
  const dates = weekdays('20261016', 12);
  const m = market(dates, code => code === '510500.SH' ? 0.2 : 0.001);
  const p = new DatabaseSync(':memory:');
  try {
    recordAt(p, entry('hist', '20261016'), at('20261016'));
    recordAt(p, entry('late', '20261022'), '2026-10-30T10:00:00+08:00');
    recordAt(p, entry('fwd', '20261022'), at('20261022'));
    const r = review(p, m, '20261029', [5]);
    assert.equal(TRUE_FORWARD_START, '20261022');
    assert.deepEqual(r.records.by_class, { TRUE_FORWARD: 1, PRE_FORWARD_HISTORICAL: 1, RETROSPECTIVE_RECORD: 1 });
    assert.deepEqual(r.pre_forward_excluded.map(x => x.record_id).sort(), ['hist', 'late']);
    const h = r.by_source.vps['5'];
    assert.equal(h.matured, 1);
    assert.equal(h.verdict, 'INSUFFICIENT_SAMPLE');
    assert.equal(r.conclusion, 'INSUFFICIENT_FORWARD_SAMPLE');
    for (const id of ['csi300_etf_buy_hold', 'frozen_multi_asset_basket', 'initial_five_etf_basket']) assert.ok(Number.isFinite(h.excess_vs[id].mean_excess_pct_points), id);
    assert.ok(h.excess_vs.csi300_etf_buy_hold.mean_excess_pct_points > 0);
    assert.equal(h.failed_predictions.windows_underperforming_csi300, 0);
    assert.equal(classifyRecord({ ...entry('x', '20261021'), recorded_at: at('20261021') }), 'PRE_FORWARD_HISTORICAL');
  } finally { p.close(); m.close(); }
});

test('windows that have not matured stay pending and produce no verdict', () => {
  const dates = weekdays('20261016', 12);
  const m = market(dates, () => 0.001);
  const p = new DatabaseSync(':memory:');
  try {
    recordAt(p, entry('fwd', '20261022'), at('20261022'));
    const r = review(p, m, '20261028', [5, 10]);
    assert.equal(r.by_source.vps['5'].pending, 1);
    assert.equal(r.by_source.vps['5'].verdict, 'NO_MATURED_SAMPLE');
    assert.equal(r.conclusion, 'NO_MATURED_FORWARD_SAMPLE');
    assert.match(r.statement, /不能说明/);
  } finally { p.close(); m.close(); }
});

function manyWindows(growth) {
  const dates = weekdays('20261016', 8 + MIN_NON_OVERLAPPING_WINDOWS + 3);
  const m = market(dates, growth);
  const p = new DatabaseSync(':memory:');
  const forward = dates.filter(d => d >= TRUE_FORWARD_START).slice(0, MIN_NON_OVERLAPPING_WINDOWS + 1);
  for (const d of forward) recordAt(p, entry(`f-${d}`, d), at(d));
  return { m, p, asOf: dates.at(-1) };
}

test('enough non-overlapping windows with no after-fee edge are reported as no improvement', () => {
  const { m, p, asOf } = manyWindows(code => code === '510500.SH' ? 0.0005 : 0.01);
  try {
    const r = review(p, m, asOf, [1]);
    const h = r.by_source.vps['1'];
    assert.ok(h.non_overlapping_windows >= MIN_NON_OVERLAPPING_WINDOWS);
    assert.equal(h.verdict, 'NO_IMPROVEMENT');
    assert.equal(r.conclusion, 'NO_IMPROVEMENT_DEMONSTRATED');
    assert.ok(h.failed_predictions.windows_underperforming_csi300 > 0);
    assert.equal(JSON.stringify(r), JSON.stringify(review(p, m, asOf, [1])), 'review is deterministic');
  } finally { p.close(); m.close(); }
});

test('a positive average is still labelled not significant', () => {
  const { m, p, asOf } = manyWindows(code => code === '510500.SH' ? 0.05 : 0.002);
  try {
    const r = review(p, m, asOf, [1]);
    assert.equal(r.by_source.vps['1'].verdict, 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT');
    assert.equal(r.conclusion, 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT');
    assert.match(r.statement, /不构成前瞻有效性/);
  } finally { p.close(); m.close(); }
});

test('ChatGPT records stay a separate source and need real provenance; no MCP tool writes the journal', () => {
  const dates = weekdays('20261016', 12);
  const m = market(dates, () => 0.001);
  const p = new DatabaseSync(':memory:');
  try {
    assert.throws(() => recordAt(p, entry('chat', '20261022', { source: 'chatgpt' }), at('20261022')), /provenance/);
    recordAt(p, entry('chat', '20261022', { source: 'chatgpt', provenance: { author: 'external', source_reference: 'conversation-export', obtained_at: '2026-10-22T20:00:00+08:00' } }), at('20261022'));
    const r = review(p, m, '20261029', [5]);
    assert.deepEqual(Object.keys(r.by_source), ['chatgpt']);
    assert.equal(r.records.by_source.vps, undefined);
  } finally { p.close(); m.close(); }
  for (const file of ['src/portfolio/researchTools.ts', 'src/portfolio/tools.ts', 'src/oauth/router.ts']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /recordResearchJournal|research_journal/, `${file} must not expose a journal write`);
  }
});

test('the scheduled account service records, reviews and reports failure of either step', () => {
  const script = readFileSync('deploy/ashare/run-account-daily.sh', 'utf8');
  assert.match(script, /investment-research-record/);
  assert.match(script, /portfolio-journal-review --record --confirm/);
  assert.match(script, /exit 77/);
  assert.match(readFileSync('deploy/ashare/run-daily.sh', 'utf8'), /validation observation SKIPPED/);
});
