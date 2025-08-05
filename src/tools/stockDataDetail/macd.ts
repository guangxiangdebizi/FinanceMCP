// MACD 技术指标计算模块

/**
 * 计算指数移动平均线 (EMA) - 内部使用
 */
function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      ema.push(prices[i]);
    } else {
      ema.push((prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier)));
    }
  }
  return ema;
}

/**
 * 计算MACD指标
 * @param prices 价格数组
 * @param fastPeriod 快线周期，默认12
 * @param slowPeriod 慢线周期，默认26  
 * @param signalPeriod 信号线周期，默认9
 */
export function calculateMACD(prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(prices, fastPeriod);
  const emaSlow = calculateEMA(prices, slowPeriod);
  
  const dif = emaFast.map((fast, i) => fast - emaSlow[i]);
  
  // Calculate DEA from the start of valid DIF values (after slowPeriod-1)
  const validDifStartIndex = slowPeriod - 1;
  const validDif = dif.slice(validDifStartIndex);
  const dea = calculateEMA(validDif, signalPeriod);
  
  // Create full-length DEA array with proper NaN padding
  const fullDea: number[] = [];
  const deaNanCount = validDifStartIndex + signalPeriod - 1;
  for (let i = 0; i < deaNanCount; i++) {
    fullDea.push(NaN);
  }
  fullDea.push(...dea);
  
  // Ensure arrays are same length before calculating MACD
  const macd = dif.map((d, i) => {
    const deaValue = i < fullDea.length ? fullDea[i] : NaN;
    return isNaN(d) || isNaN(deaValue) ? NaN : (d - deaValue) * 2;
  });
  
  return {
    dif,
    dea: fullDea,
    macd
  };
} 