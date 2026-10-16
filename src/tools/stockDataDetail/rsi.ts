// RSI 技术指标计算模块

/**
 * 计算RSI指标（Wilder 平滑，与通达信/同花顺 SMA(X,N,1) 口径一致）
 * @param prices 按时间正序排列的价格数组
 * @param period 计算周期，默认14
 */
export function calculateRSI(prices: number[], period = 14): number[] {
  const rsi: number[] = new Array(prices.length).fill(NaN);
  if (prices.length <= period) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  const toRsi = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  rsi[period] = toRsi();
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    rsi[i] = toRsi();
  }
  return rsi;
}
