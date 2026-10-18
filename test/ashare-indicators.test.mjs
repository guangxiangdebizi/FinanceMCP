import assert from 'node:assert/strict';
import test from 'node:test';

import { sma, ema, rsi, macd, boll, cci, atr, computeIndicators } from '../build/ashare/indicators.js';
import { detectSignals } from '../build/ashare/signals.js';
import { filterRowsAndIndicators } from '../build/tools/stockDataDetail/index.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Wilder's RSI reference series (StockCharts "RSI" tutorial sample).
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  46.00, 46.03, 46.41, 46.22, 45.64];

test('RSI uses Wilder smoothing (hand-computed) and tracks the published reference values', () => {
  const out = rsi(WILDER, 14);
  assert.ok(out.slice(0, 14).every(Number.isNaN), 'no value before 14 changes exist');
  // Seed: average gain 3.34/14 and average loss 1.40/14 over the first 14 changes.
  let g = 3.34 / 14;
  let l = 1.40 / 14;
  assert.ok(close(out[14], 100 - 100 / (1 + g / l), 1e-6));
  // Wilder step for the next change (-0.28).
  g = (g * 13 + 0) / 14;
  l = (l * 13 + 0.28) / 14;
  assert.ok(close(out[15], 100 - 100 / (1 + g / l), 1e-6));
  // Published values (computed from unrounded closes) agree within 0.1.
  [70.53, 66.32, 66.55, 69.41].forEach((ref, k) => assert.ok(Math.abs(out[14 + k] - ref) < 0.1, `RSI[${14 + k}]=${out[14 + k]} vs ${ref}`));
});

test('RSI is 100 for a strictly rising series and 50 for a flat one', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8], 5).at(-1), 100);
  assert.equal(rsi([3, 3, 3, 3, 3, 3, 3], 5).at(-1), 50);
});

test('MACD DEA stays aligned with DIF (regression for the 25-bar shift)', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 10 + Math.sin(i / 6) * 2 + i * 0.03);
  const m = macd(prices, 12, 26, 9);
  assert.equal(m.dea.length, prices.length);
  const expectedDea = ema(m.dif, 9);
  for (let i = 0; i < prices.length; i++) {
    assert.ok(close(m.dea[i], expectedDea[i]), `DEA misaligned at ${i}`);
    assert.ok(close(m.macd[i], 2 * (m.dif[i] - m.dea[i])), `histogram wrong at ${i}`);
  }
  const fast = ema(prices, 12);
  const slow = ema(prices, 26);
  assert.ok(close(m.dif[80], fast[80] - slow[80]));
});

test('SMA, BOLL (population sd), CCI and ATR follow their documented formulas', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
  const b = boll([1, 2, 3, 4, 5], 5, 2);
  const sd = Math.sqrt(((1 - 3) ** 2 + (2 - 3) ** 2 + 0 + 1 + 4) / 5);
  assert.ok(close(b.middle[4], 3));
  assert.ok(close(b.upper[4], 3 + 2 * sd));

  const high = [10, 11, 12, 13, 14];
  const low = [8, 9, 10, 11, 12];
  const cl = [9, 10, 11, 12, 13];
  const c = cci(high, low, cl, 5);
  const tp = cl.map((x, i) => (high[i] + low[i] + x) / 3);
  const mean = tp.reduce((s, v) => s + v, 0) / 5;
  const md = tp.reduce((s, v) => s + Math.abs(v - mean), 0) / 5;
  assert.ok(close(c[4], (tp[4] - mean) / (0.015 * md)));

  const a = atr([10, 11, 12, 11, 13], [9, 10, 10, 9, 11], [9.5, 10.5, 11, 10, 12.5], 3);
  const tr = [1, 1.5, 2, 2, 3];
  assert.ok(close(a[2], (tr[0] + tr[1] + tr[2]) / 3));
  assert.ok(close(a[3], (a[2] * 2 + tr[3]) / 3));
  assert.ok(close(a[4], (a[3] * 2 + tr[4]) / 3));
});

test('stock_data range filtering keeps indicator rows aligned with price rows', () => {
  const rows = [{ trade_date: '20260105' }, { trade_date: '20260104' }, { trade_date: '20260103' }, { trade_date: '20260102' }];
  const indicators = { rsi: [5, 4, 3, 2], macd: { dif: [50, 40, 30, 20], dea: [0.5, 0.4, 0.3, 0.2] } };
  const kept = filterRowsAndIndicators(rows, indicators, '20260103', '20260104');
  assert.deepEqual(kept.map(r => r.trade_date), ['20260104', '20260103']);
  assert.deepEqual(indicators.rsi, [4, 3]);
  assert.deepEqual(indicators.macd.dif, [40, 30]);
  assert.deepEqual(indicators.macd.dea, [0.4, 0.3]);
});

function barsFrom(closes, vols) {
  const n = closes.length;
  const dates = Array.from({ length: n }, (_, i) => String(20250101 + i));
  return {
    dates,
    open: closes.map((c, i) => (i ? closes[i - 1] : c)),
    high: closes.map(c => c * 1.005),
    low: closes.map(c => c * 0.995),
    close: closes,
    vol: vols ?? closes.map(() => 1000),
    amount: closes.map(() => 1e5),
    rawOpen: closes,
    rawClose: closes,
    upLimit: closes.map(() => NaN),
  };
}

test('breakout and trend signals fire on their rule definitions only', () => {
  const closes = Array.from({ length: 100 }, (_, i) => 10 + Math.sin(i / 3) * 0.2);
  const vols = closes.map(() => 1000);
  closes.push(11.5);
  vols.push(2000);
  const b = barsFrom(closes, vols);
  const x = computeIndicators(b);
  const i = closes.length - 1;
  assert.ok(detectSignals(b, x, i).includes('breakout_20d'));

  const weak = barsFrom(closes.slice(0, -1).concat([11.5]), vols.slice(0, -1).concat([1200]));
  assert.ok(!detectSignals(weak, computeIndicators(weak), i).includes('breakout_20d'), 'volume below 1.5x must not trigger');
});

test('signals only read data up to the evaluated bar', () => {
  const closes = Array.from({ length: 160 }, (_, i) => 10 + Math.sin(i / 7) + i * 0.01);
  const full = barsFrom(closes);
  const cut = barsFrom(closes.slice(0, 130));
  const fx = computeIndicators(full);
  const cx = computeIndicators(cut);
  for (let i = 61; i < 130; i++) {
    assert.deepEqual(detectSignals(full, fx, i), detectSignals(cut, cx, i), `look-ahead at bar ${i}`);
  }
});
