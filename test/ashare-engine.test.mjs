import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-engine-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'cache.sqlite');
const { openAshareDb, upsertRows, closeAshareDb } = await import('../build/ashare/db.js');
const { scanMarket, scoreRows, cashScore, SCORE_VERSION, RESEARCH_SCORE_VERSION } = await import('../build/ashare/analysis.js');
const { analyzeMarket, factorSnapshot, rawFactors, missingAmount20Codes, sourceQualityForDate, applyObservationQuality, FACTOR_UNITS } = await import('../build/ashare/engine.js');
const { runAshareTool, ashareToolDefinitions } = await import('../build/ashare/tools.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

function row(cash, extra = {}) {
  return {
    ts_code: '600000.SH', name: '样本', industry: '制造业', close: 12, pct_chg: 1,
    amount20_yi: 2, circ_mv_yi: 100, pe_ttm: 10, pb: 1, turnover_rate: 1,
    state: { trend: 'up', above_ma20: true, above_ma60: true, ret5: .05, ret20: .1, ret60: .2, rsi14: 60, atr_pct: .04, vol_ratio: 1 },
    ma20_rising: true, ma60_rising: true, ma20: 11, ma60: 10, atr14: .48, high20_prior: 12,
    bars: 150, signals: [], risk_flags: [], eligible: true,
    fundamentals: { ts_code: '600000.SH', end_date: '20260331', ann_date: '20260430', roe: 10, roe_dt: null, netprofit_yoy: 10, dt_netprofit_yoy: null, or_yoy: null, grossprofit_margin: null, debt_to_assets: 40, ocf_to_profit: cash, ocfps: null, eps: 1 },
    ...extra,
  };
}

const db = openAshareDb();
const dates = weekdays('20260105', 150);
const date = dates.at(-1);
seedMarket(db, dates);
const finaCols = ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'];
upsertRows(db, 'fina_indicator', finaCols, [
  ...[115.11, 20, -10, null].map((cash, i) => ({ ts_code: STOCKS[i].ts_code, end_date: '20260331', ann_date: '20260430', roe: 10, netprofit_yoy: 10, ocf_to_profit: cash, debt_to_assets: 40, eps: 1 })),
  { ts_code: STOCKS[4].ts_code, end_date: '20260331', ann_date: '20260430', roe: -5, netprofit_yoy: -20, ocf_to_profit: 115.11, debt_to_assets: 40, eps: -1 },
  { ts_code: STOCKS[5].ts_code, end_date: '20260331', ann_date: '20260430', roe: 10, netprofit_yoy: 10, ocf_to_profit: 20, debt_to_assets: 40, eps: 0 },
]);

test('cash percent threshold regression: 115.11%, 20%, -10%, zero and missing', () => {
  for (const [cash, v1, v2] of [[115.11, 1, 1], [20, 1, .5], [-10, 0, 0], [0, 0, 0], [null, .5, .5]]) {
    assert.equal(cashScore(cash, SCORE_VERSION), v1);
    assert.equal(cashScore(cash, RESEARCH_SCORE_VERSION), v2);
  }
  assert.throws(() => cashScore(20, 'other'), /Unsupported/);
});

test('V1 exact formula and V2 per-factor attribution preserve all other weights', () => {
  const a = row(20), b = row(20);
  const v1 = scoreRows([a], [], SCORE_VERSION).get(a.ts_code);
  const v2 = scoreRows([b], [], RESEARCH_SCORE_VERSION).get(b.ts_code);
  // Singleton PR=.5; technical=.75; fundamental=.75/.625; sector=.5.
  assert.equal(a.score, 66.25);
  assert.equal(b.score, 62.5);
  assert.equal(a.rank, 1);
  assert.equal(v1.normalized.cash, 1);
  assert.equal(v2.normalized.cash, .5);
  assert.equal(v1.factor_contributions.cash - v2.factor_contributions.cash, 3.75);
  for (const factor of Object.keys(v1.factor_contributions)) if (factor !== 'cash') assert.equal(v1.factor_contributions[factor], v2.factor_contributions[factor], factor);
  assert.ok(Math.abs(Object.values(v2.factor_contributions).reduce((a, b) => a + b, 0) - b.score) < 1e-10);
  const again = structuredClone(a);
  assert.deepEqual(scoreRows([again], []).get(a.ts_code), v1);
  assert.deepEqual(again, a);
});

test('missing financial observations stay null while scoring defaults are explicit', () => {
  const a = row(null);
  a.fundamentals.roe = null;
  a.fundamentals.netprofit_yoy = null;
  a.fundamentals.debt_to_assets = null;
  const detail = scoreRows([a], [], RESEARCH_SCORE_VERSION).get(a.ts_code);
  for (const key of ['roe', 'growth', 'cash', 'leverage', 'sector']) assert.equal(detail.normalized[key], null);
  assert.equal(detail.scoring_factors.cash, .5);
  assert.equal(detail.scoring_factors.roe, .3);
  assert.ok(detail.imputations.cash);
  const b = row(20, { fundamentals: undefined });
  const missing = scoreRows([b], [], RESEARCH_SCORE_VERSION).get(b.ts_code);
  assert.equal(missing.components.fundamental, .3);
  assert.equal(missing.normalized.cash, null);
  assert.equal(missing.factor_contributions.cash, 2.25);
});

test('financial industry cash policy is explicit and leverage stays neutral', () => {
  const a = row(20, { industry: '银行' });
  const detail = scoreRows([a], [], RESEARCH_SCORE_VERSION).get(a.ts_code);
  assert.equal(detail.scoring_factors.cash, .5);
  assert.equal(detail.scoring_factors.leverage, .5);
  assert.equal(detail.normalized.leverage, null);
  assert.match(detail.imputations.leverage, /Financial industry/);
});

test('snapshots are deterministic, read-only, and normalize subsets against the full market', () => {
  const changesBefore = db.prepare('SELECT total_changes() n').get().n;
  const first = analyzeMarket(db, { date, score_version: RESEARCH_SCORE_VERSION });
  assert.deepEqual(analyzeMarket(db, { date, score_version: RESEARCH_SCORE_VERSION }), first);
  const subset = analyzeMarket(db, { date, score_version: RESEARCH_SCORE_VERSION, ts_codes: [STOCKS[1].ts_code] });
  assert.deepEqual(subset.rows[0], first.rows.find(r => r.ts_code === STOCKS[1].ts_code));
  assert.equal(subset.normalization_scope, 'full_market_eligible');
  assert.equal(first.universe.scanned, 60);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changesBefore, 'does not persist scores, quality checks or reports');
  assert.equal(FACTOR_UNITS.ret20, 'ratio (0.20 = 20%)');
  assert.match(FACTOR_UNITS.ocf_to_profit, /115.11/);
  assert.equal(subset.rows[0].raw.ocf_to_profit, 20);
  const noReport = first.rows.find(r => r.ts_code === STOCKS[6].ts_code);
  assert.equal(noReport.raw.ocf_to_profit, null);
  assert.equal(noReport.normalized.cash, null);
  assert.equal(noReport.scoring_factors.cash, .3);
});

test('negative ROE remains excluded; zero EPS flags profit interpretation without new scoring rules', () => {
  const snapshot = analyzeMarket(db, { date, score_version: RESEARCH_SCORE_VERSION, ts_codes: [STOCKS[4].ts_code, STOCKS[5].ts_code] });
  assert.equal(snapshot.rows[0].eligible, false);
  assert.equal(snapshot.rows[0].score, null);
  assert.match(snapshot.rows[0].ineligible_reason, /亏损/);
  assert.equal(snapshot.rows[1].eligible, true);
  assert.ok(snapshot.rows[1].quality.risk_flags.some(f => /Nonpositive EPS/.test(f)));
  assert.equal(snapshot.rows[1].normalized.cash, .5);
});

test('V1 engine matches legacy scan exactly and future financial announcements do not leak', () => {
  const baseline = scanMarket(db, date);
  const snapshot = analyzeMarket(db, { date, score_version: SCORE_VERSION });
  for (const r of baseline.rows) {
    const factor = snapshot.rows.find(x => x.ts_code === r.ts_code);
    assert.equal(factor.score, r.score ?? null);
    assert.equal(factor.rank, r.rank ?? null);
    if (r.components) for (const key of Object.keys(r.components)) assert.equal(Math.round(factor.components[key] * 1000) / 1000, r.components[key]);
  }
  upsertRows(db, 'fina_indicator', finaCols, [{ ts_code: STOCKS[1].ts_code, end_date: '20260630', ann_date: '20261231', roe: 999, netprofit_yoy: 999, ocf_to_profit: 999, debt_to_assets: 99, eps: 999 }]);
  assert.deepEqual(analyzeMarket(db, { date, score_version: SCORE_VERSION }), snapshot);
});

test('t+1 market inputs and future financial revisions cannot change t selection in either version', () => {
  const beforeScan = scanMarket(db, date);
  const before = [SCORE_VERSION, RESEARCH_SCORE_VERSION].map(score_version => analyzeMarket(db, { date, score_version }));
  const next = weekdays('20260803', 1)[0];
  assert.ok(next > date);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [{ cal_date: next, is_open: 1, pretrade_date: date }]);
  for (const [i, stock] of STOCKS.entries()) {
    const code = stock.ts_code;
    const close = i % 2 ? 999999 : .001;
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], [
      { ts_code: code, trade_date: next, open: close, high: close * 1.1, low: close * .9, close, pre_close: 10, pct_chg: 99999, vol: 1e15, amount: i % 2 ? null : 1e18 },
    ]);
    upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'], [
      { ts_code: code, trade_date: next, turnover_rate: 9999, pe_ttm: i % 2 ? .001 : 99999, pb: 99999, circ_mv: 1, total_mv: 1 },
    ]);
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: code, trade_date: next, adj_factor: 1e9 }]);
    upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], [{ ts_code: code, trade_date: next, up_limit: .01, down_limit: .001 }]);
  }
  // A revision of an already-known period announced at t+1 is unavailable at t.
  upsertRows(db, 'fina_indicator', finaCols, [{ ts_code: STOCKS[1].ts_code, end_date: '20260331', ann_date: next, roe: -999, netprofit_yoy: -999, ocf_to_profit: -999, debt_to_assets: 999, eps: -999 }]);
  assert.deepEqual(scanMarket(db, date), beforeScan, 'entire scan including signals, scores and ranks is unchanged');
  for (const [i, score_version] of [SCORE_VERSION, RESEARCH_SCORE_VERSION].entries()) {
    assert.deepEqual(analyzeMarket(db, { date, score_version }), before[i], `${score_version}: all raw/normalized factors, quality, contributions and selection outputs are unchanged`);
  }
});

test('missing as-of bars never use stale values; incomplete adjustments null derived observations', () => {
  db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run(STOCKS[10].ts_code, date);
  db.prepare('DELETE FROM adj_factor WHERE ts_code = ? AND trade_date = ?').run(STOCKS[11].ts_code, dates[100]);
  const snap = factorSnapshot(db, { date, ts_codes: [STOCKS[10].ts_code, STOCKS[11].ts_code] });
  assert.equal(snap.rows[0].raw.close, null);
  assert.equal(snap.rows[0].eligible, false);
  assert.equal(snap.rows[0].score, null);
  assert.equal(snap.rows[1].raw.ret20, null);
  assert.equal(snap.rows[1].raw.ma20, null);
  assert.equal(snap.rows[1].eligible, false);
  assert.deepEqual(snap.rows[1].signals, []);
});

test('bounded MCP snapshot equals internal engine, honors include_components, and rejects invalid input', async () => {
  const args = { date, ts_codes: [STOCKS[1].ts_code], score_version: RESEARCH_SCORE_VERSION, include_components: false };
  const internal = analyzeMarket(db, { date, ts_codes: args.ts_codes, score_version: args.score_version, parameters: { include_components: false } });
  const response = JSON.parse((await runAshareTool('ashare_factor_snapshot', args)).content[0].text);
  assert.deepEqual(response, internal);
  assert.equal('components' in response.rows[0], false);
  assert.equal(response.rows[0].normalized.cash, .5);
  const def = ashareToolDefinitions.find(d => d.name === 'ashare_factor_snapshot');
  assert.equal(def.annotations.readOnlyHint, true);
  assert.equal(def.inputSchema.properties.ts_codes.maxItems, 20);
  assert.throws(() => factorSnapshot(db, { date, ts_codes: [] }), /1–20/);
  assert.throws(() => factorSnapshot(db, { date, ts_codes: Array(21).fill(STOCKS[1].ts_code) }), /1–20/);
  assert.throws(() => factorSnapshot(db, { date, ts_codes: [STOCKS[1].ts_code], include_components: 'false' }), /boolean/);
  assert.throws(() => factorSnapshot(db, { date, ts_codes: [STOCKS[1].ts_code], include_components: null }), /boolean/);
  assert.throws(() => factorSnapshot(db, { date: '20260230', ts_codes: args.ts_codes }), /有效日期/);
  assert.throws(() => factorSnapshot(db, { date, ts_codes: args.ts_codes, score_version: 'other' }), /Unsupported/);
  assert.throws(() => analyzeMarket(db, { date, parameters: { cash_threshold: 20 } }), /Unsupported research parameter/);
});

test('NULL source amounts remain missing observations without changing V1 scoring', () => {
  const code = STOCKS[12].ts_code;
  const oldOnly = STOCKS[13].ts_code;
  const boundary = STOCKS[14].ts_code;
  db.prepare('UPDATE daily SET amount = NULL WHERE ts_code = ? AND trade_date = ?').run(code, dates.at(-3));
  db.prepare('UPDATE daily SET amount = NULL WHERE ts_code = ? AND trade_date = ?').run(oldOnly, dates.at(-21));
  db.prepare('UPDATE daily SET amount = NULL WHERE ts_code = ? AND trade_date = ?').run(boundary, dates.at(-20));
  const missing = missingAmount20Codes(db, date);
  assert.equal(missing.has(code), true);
  assert.equal(missing.has(boundary), true, '20th most recent bar is inside amount average');
  assert.equal(missing.has(oldOnly), false, '21st most recent bar is outside amount average');
  const baseline = scanMarket(db, date).rows.find(r => r.ts_code === code);
  const raw = rawFactors(baseline, { amount20_missing: missing.has(code) });
  assert.equal(raw.amount20_yi, null);
  const snapshot = factorSnapshot(db, { date, ts_codes: [code] }).rows[0];
  assert.equal(snapshot.raw.amount20_yi, null);
  assert.equal(snapshot.normalized.liquidity, null);
  assert.equal(snapshot.score, baseline.score);
  assert.equal(snapshot.rank, baseline.rank);
  assert.equal(snapshot.eligible, baseline.eligible);
  assert.ok(Number.isFinite(snapshot.scoring_factors.liquidity));
  assert.match(snapshot.imputations.liquidity, /substituted zero/);
  assert.ok(snapshot.quality.missing_factors.includes('amount20_yi'));
});

test('unknown codes and dates expose missing rows without substituting cached bars', () => {
  const unknown = factorSnapshot(db, { date, ts_codes: ['699999.SH'] }).rows[0];
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.raw.close, null);
  assert.equal(unknown.raw.amount20_yi, null);
  assert.equal(unknown.score, null);
  const future = factorSnapshot(db, { date: '20261231', ts_codes: [STOCKS[0].ts_code] });
  assert.equal(future.rows[0].raw.close, null);
  assert.equal(future.rows[0].eligible, false);
  assert.equal(future.quality.status, 'NOT_READY');
  assert.throws(() => factorSnapshot(db, { date: '20000101', ts_codes: [STOCKS[0].ts_code] }), /No cached trading calendar/);
});

test('source NULL/nonpositive OHLC masks technical observations while legacy scores remain exact', () => {
  const mutations = [
    [STOCKS[20].ts_code, 'open', null, dates.at(-3)],
    [STOCKS[21].ts_code, 'high', null, dates.at(-3)],
    [STOCKS[22].ts_code, 'low', null, dates.at(-3)],
    [STOCKS[23].ts_code, 'close', null, dates.at(-3)],
    [STOCKS[24].ts_code, 'close', 0, dates.at(-3)],
    [STOCKS[25].ts_code, 'close', -1, dates.at(-3)],
    [STOCKS[26].ts_code, 'close', null, date],
    [STOCKS[27].ts_code, 'low', null, dates[0]],
  ];
  for (const [code, column, value, day] of mutations) db.prepare(`UPDATE daily SET ${column} = ? WHERE ts_code = ? AND trade_date = ?`).run(value, code, day);
  const scan = scanMarket(db, date);
  const before = structuredClone(scan);
  const quality = sourceQualityForDate(db, date);
  const futureOnly = STOCKS[28].ts_code;
  db.prepare('UPDATE daily SET low = NULL WHERE ts_code = ? AND trade_date = ?').run(futureOnly, '20260803');
  assert.equal(sourceQualityForDate(db, date).has(futureOnly), false, 'future invalid OHLC cannot taint t factors');
  for (const version of [SCORE_VERSION, RESEARCH_SCORE_VERSION]) {
    const scored = structuredClone(scan);
    const details = scoreRows(scored.rows, scored.sectors, version);
    const snapshot = analyzeMarket(db, { date, score_version: version, ts_codes: mutations.map(m => m[0]) });
    for (const observed of snapshot.rows) {
      const legacy = scored.rows.find(row => row.ts_code === observed.ts_code);
      assert.equal(quality.get(observed.ts_code).technical_invalid, true);
      for (const key of ['ret20', 'ret60', 'ma20', 'ma60', 'above_ma20', 'above_ma60', 'ma20_rising', 'ma60_rising', 'rsi14', 'atr_pct']) assert.equal(observed.raw[key], null, `${observed.ts_code}.${key}`);
      for (const key of ['ret60', 'ret20', 'trend', 'rsi_fit', 'volatility_fit']) {
        assert.equal(observed.normalized[key], null);
        assert.match(observed.imputations[key], /source OHLC/);
      }
      if (observed.ts_code === STOCKS[26].ts_code) assert.equal(observed.raw.close, null);
      else assert.ok(observed.raw.close > 0, 'valid current raw close is retained');
      assert.equal(observed.score, legacy.score ?? null);
      assert.equal(observed.rank, legacy.rank ?? null);
      assert.equal(observed.eligible, legacy.eligible);
      assert.deepEqual(observed.signals, []);
      assert.equal(observed.invalidation.price_below_ma60, null);
      assert.ok(observed.quality.risk_flags.some(flag => /source OHLC/.test(flag)));
      const detail = details.get(legacy.ts_code);
      const formula = structuredClone(detail);
      applyObservationQuality(detail, quality.get(legacy.ts_code));
      assert.deepEqual(detail.normalized, observed.normalized, 'research runner helper matches internal engine');
      assert.deepEqual(detail.contributions, formula.contributions);
      assert.deepEqual(detail.factor_contributions, formula.factor_contributions);
      assert.deepEqual(detail.scoring_factors, formula.scoring_factors);
      assert.deepEqual(rawFactors(legacy, quality.get(legacy.ts_code)), observed.raw);
    }
  }
  // node:sqlite rows are null-prototype objects; compare the serialized values instead of prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(scanMarket(db, date))), JSON.parse(JSON.stringify(before)), 'observation quality masking never mutates legacy scan results');
});

test.after(() => closeAshareDb());
