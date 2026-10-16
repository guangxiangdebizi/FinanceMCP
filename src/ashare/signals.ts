import type { Bars, IndicatorSet } from './indicators.js';

export const SIGNAL_VERSION = 'sig-1.0.0';

export type SignalDirection = 'bullish' | 'bearish';

export interface SignalDefinition {
  id: string;
  name: string;
  direction: SignalDirection;
  trigger: string;
  invalidation: string;
  risk: string;
}

/** Plain-language rule text is part of the report contract; keep it in sync with `detect`. */
export const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    id: 'trend_up',
    name: '多头趋势',
    direction: 'bullish',
    trigger: '收盘价 > MA20 > MA60，且 MA20 高于 5 个交易日前（首次满足当日触发）',
    invalidation: '收盘价跌破 MA60，或 MA20 拐头低于 5 日前',
    risk: '趋势末端追高；震荡市中频繁进出',
  },
  {
    id: 'breakout_20d',
    name: '20日放量突破',
    direction: 'bullish',
    trigger: '收盘价突破此前 20 个交易日最高价，且当日成交量 ≥ 20 日均量 1.5 倍',
    invalidation: '收盘价回落至突破前 20 日最高价下方 3% 以上',
    risk: '假突破；涨停封板次日无法按开盘价成交',
  },
  {
    id: 'macd_golden_cross',
    name: 'MACD金叉',
    direction: 'bullish',
    trigger: 'DIF 上穿 DEA（前一日 DIF ≤ DEA，当日 DIF > DEA）',
    invalidation: 'DIF 重新下穿 DEA',
    risk: '震荡区间内金叉/死叉反复，信号滞后',
  },
  {
    id: 'macd_bull_divergence',
    name: 'MACD底背离',
    direction: 'bullish',
    trigger: '近 10 日最低价低于 20~60 日前区间最低价，但对应 DIF 更高，且当日收阳并站上 MA5',
    invalidation: '收盘价跌破背离低点',
    risk: '下跌趋势中背离可多次出现，需结合市场环境',
  },
  {
    id: 'rsi_oversold_rebound',
    name: 'RSI超卖反弹',
    direction: 'bullish',
    trigger: 'RSI14 由 30 以下上穿 30',
    invalidation: 'RSI14 再次跌破 30 或收盘价创 20 日新低',
    risk: '弱势股超卖后继续超卖',
  },
  {
    id: 'boll_squeeze_breakout',
    name: '布林收口突破',
    direction: 'bullish',
    trigger: '布林带宽处于近 120 日最低 20% 分位后，收盘价上穿上轨',
    invalidation: '收盘价跌回布林中轨下方',
    risk: '收口方向判断错误时回撤较快',
  },
  {
    id: 'trend_breakdown',
    name: '跌破中期均线',
    direction: 'bearish',
    trigger: '收盘价由 MA60 上方跌破 MA60，且当日成交量 ≥ 20 日均量',
    invalidation: '收盘价重新站上 MA60',
    risk: '风险提示信号，不构成做空建议',
  },
  {
    id: 'macd_bear_divergence',
    name: 'MACD顶背离',
    direction: 'bearish',
    trigger: '近 10 日最高价高于 20~60 日前区间最高价，但对应 DIF 更低，且当日收阴',
    invalidation: '收盘价创新高且 DIF 同步创新高',
    risk: '强势趋势中顶背离可能持续',
  },
  {
    id: 'overheated',
    name: '短期过热',
    direction: 'bearish',
    trigger: 'RSI6 > 85 且 CCI14 > 200',
    invalidation: 'RSI6 回落至 70 以下',
    risk: '强势股可持续过热，仅作风险提示',
  },
];

export const SIGNAL_BY_ID = new Map(SIGNAL_DEFINITIONS.map(def => [def.id, def]));

const ok = (...values: number[]) => values.every(v => Number.isFinite(v));

function argMin(values: number[], from: number, to: number): number {
  let best = from;
  for (let i = from; i <= to; i++) if (values[i] < values[best]) best = i;
  return best;
}

function argMax(values: number[], from: number, to: number): number {
  let best = from;
  for (let i = from; i <= to; i++) if (values[i] > values[best]) best = i;
  return best;
}

function trendUp(b: Bars, x: IndicatorSet, i: number): boolean {
  return i >= 5 && ok(x.ma20[i], x.ma60[i], x.ma20[i - 5])
    && b.close[i] > x.ma20[i] && x.ma20[i] > x.ma60[i] && x.ma20[i] > x.ma20[i - 5];
}

/** Ids of the signals that trigger on bar `i`. Only data up to and including `i` is read. */
export function detectSignals(b: Bars, x: IndicatorSet, i: number): string[] {
  if (i < 61) return [];
  const out: string[] = [];
  const c = b.close;

  if (trendUp(b, x, i) && !trendUp(b, x, i - 1)) out.push('trend_up');

  const priorHigh20 = x.high20[i - 1];
  if (ok(priorHigh20, x.volMa20[i]) && c[i] > priorHigh20 && b.vol[i] >= 1.5 * x.volMa20[i]) out.push('breakout_20d');

  if (ok(x.dif[i], x.dea[i], x.dif[i - 1], x.dea[i - 1]) && x.dif[i - 1] <= x.dea[i - 1] && x.dif[i] > x.dea[i]) {
    out.push('macd_golden_cross');
  }

  // Divergence: compare the extreme of the last 10 bars with the extreme 20~60 bars ago.
  const recentLow = argMin(b.low, i - 9, i);
  const pastLow = argMin(b.low, i - 60, i - 20);
  if (b.low[recentLow] < b.low[pastLow] && x.dif[recentLow] > x.dif[pastLow]
    && c[i] > b.open[i] && ok(x.ma5[i]) && c[i] > x.ma5[i]) {
    out.push('macd_bull_divergence');
  }
  const recentHigh = argMax(b.high, i - 9, i);
  const pastHigh = argMax(b.high, i - 60, i - 20);
  if (b.high[recentHigh] > b.high[pastHigh] && x.dif[recentHigh] < x.dif[pastHigh] && c[i] < b.open[i]) {
    out.push('macd_bear_divergence');
  }

  if (ok(x.rsi14[i], x.rsi14[i - 1]) && x.rsi14[i - 1] < 30 && x.rsi14[i] >= 30) out.push('rsi_oversold_rebound');

  if (i >= 125 && ok(x.bollUp[i], x.bollUp[i - 1])) {
    const window = x.bollWidth.slice(i - 120, i).filter(Number.isFinite).sort((a, b2) => a - b2);
    const squeezeLevel = window[Math.floor(window.length * 0.2)];
    const squeezed = [1, 2, 3, 4, 5].some(k => x.bollWidth[i - k] <= squeezeLevel);
    if (window.length >= 100 && squeezed && c[i] > x.bollUp[i] && c[i - 1] <= x.bollUp[i - 1]) out.push('boll_squeeze_breakout');
  }

  if (ok(x.ma60[i], x.ma60[i - 1], x.volMa20[i]) && c[i - 1] >= x.ma60[i - 1] && c[i] < x.ma60[i] && b.vol[i] >= x.volMa20[i]) {
    out.push('trend_breakdown');
  }

  if (ok(x.rsi6[i], x.cci14[i]) && x.rsi6[i] > 85 && x.cci14[i] > 200) out.push('overheated');

  return out;
}

export interface TechnicalState {
  trend: 'up' | 'down' | 'range';
  above_ma20: boolean;
  above_ma60: boolean;
  ret5: number;
  ret20: number;
  ret60: number;
  rsi14: number;
  atr_pct: number;
  vol_ratio: number;
}

export function technicalState(b: Bars, x: IndicatorSet, i: number): TechnicalState {
  const c = b.close;
  const ret = (k: number) => (i >= k ? c[i] / c[i - k] - 1 : NaN);
  const trend = trendUp(b, x, i)
    ? 'up'
    : ok(x.ma20[i], x.ma60[i]) && c[i] < x.ma20[i] && x.ma20[i] < x.ma60[i] ? 'down' : 'range';
  return {
    trend,
    above_ma20: c[i] > x.ma20[i],
    above_ma60: c[i] > x.ma60[i],
    ret5: ret(5),
    ret20: ret(20),
    ret60: ret(60),
    rsi14: x.rsi14[i],
    atr_pct: x.atr14[i] / c[i],
    vol_ratio: b.vol[i] / x.volMa20[i],
  };
}
