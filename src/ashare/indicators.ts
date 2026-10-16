import { calculateBOLL, calculateEMA, calculateMACD, calculateRSI } from '../tools/stockDataDetail/index.js';

/**
 * Indicator conventions (all inputs are in ascending time order):
 * - MA: simple moving average; NaN until `period` bars exist.
 * - MACD(12,26,9): EMA seeded with the first close, DEA = EMA(DIF, 9),
 *   histogram = 2 × (DIF − DEA) as shown by TDX/THS.
 * - RSI(14): Wilder smoothing, equivalent to TDX SMA(X, N, 1).
 * - BOLL(20,2): middle = MA20, bands use the population standard deviation.
 * - CCI(14): (TP − MA(TP)) / (0.015 × mean absolute deviation), TP = (H+L+C)/3.
 * - ATR(14): Wilder smoothing of the true range; the first value is the mean TR.
 * Prices passed in are forward-adjusted (qfq) so splits do not create gaps.
 */
export const INDICATOR_VERSION = 'ind-1.0.0';

export function sma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export const ema = calculateEMA;
export const rsi = calculateRSI;
export const macd = calculateMACD;
export const boll = calculateBOLL;

export function cci(high: number[], low: number[], close: number[], period = 14): number[] {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const ma = sma(tp, period);
  return tp.map((value, i) => {
    if (i < period - 1) return NaN;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
    md /= period;
    return md === 0 ? 0 : (value - ma[i]) / (0.015 * md);
  });
}

export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const out = new Array(close.length).fill(NaN);
  const tr = close.map((_, i) => i === 0
    ? high[0] - low[0]
    : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  if (close.length < period) return out;
  let value = 0;
  for (let i = 0; i < period; i++) value += tr[i];
  value /= period;
  out[period - 1] = value;
  for (let i = period; i < close.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

export function rollingMax(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN;
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]);
    return m;
  });
}

export function rollingMin(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN;
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, values[j]);
    return m;
  });
}

export interface Bars {
  dates: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  vol: number[];
  amount: number[];
  /** Raw (unadjusted) prices, for display and limit-price checks. */
  rawOpen: number[];
  rawClose: number[];
  upLimit: number[];
}

export interface IndicatorSet {
  ma5: number[]; ma10: number[]; ma20: number[]; ma60: number[]; ma120: number[];
  dif: number[]; dea: number[]; hist: number[];
  rsi6: number[]; rsi14: number[];
  cci14: number[];
  bollUp: number[]; bollMid: number[]; bollLow: number[]; bollWidth: number[];
  atr14: number[];
  volMa5: number[]; volMa20: number[]; amountMa20: number[];
  high20: number[]; low20: number[]; high60: number[];
}

export function computeIndicators(b: Bars): IndicatorSet {
  const m = macd(b.close, 12, 26, 9);
  const bb = boll(b.close, 20, 2);
  return {
    ma5: sma(b.close, 5), ma10: sma(b.close, 10), ma20: sma(b.close, 20), ma60: sma(b.close, 60), ma120: sma(b.close, 120),
    dif: m.dif, dea: m.dea, hist: m.macd,
    rsi6: rsi(b.close, 6), rsi14: rsi(b.close, 14),
    cci14: cci(b.high, b.low, b.close, 14),
    bollUp: bb.upper, bollMid: bb.middle, bollLow: bb.lower,
    bollWidth: bb.upper.map((u, i) => (u - bb.lower[i]) / bb.middle[i]),
    atr14: atr(b.high, b.low, b.close, 14),
    volMa5: sma(b.vol, 5), volMa20: sma(b.vol, 20), amountMa20: sma(b.amount, 20),
    high20: rollingMax(b.high, 20), low20: rollingMin(b.low, 20), high60: rollingMax(b.high, 60),
  };
}
