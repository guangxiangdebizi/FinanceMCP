// MA 移动平均线技术指标计算模块
/**
 * 计算简单移动平均线 (SMA)
 * @param prices 价格数组
 * @param period 计算周期
 */
export function calculateSMA(prices, period) {
    const sma = [];
    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            sma.push(NaN);
        }
        else {
            const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
            sma.push(sum / period);
        }
    }
    return sma;
}
/**
 * 计算指数移动平均线 (EMA)
 * @param prices 价格数组
 * @param period 计算周期
 */
export function calculateEMA(prices, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    for (let i = 0; i < prices.length; i++) {
        if (i === 0) {
            ema.push(prices[i]);
        }
        else {
            ema.push((prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier)));
        }
    }
    return ema;
}
//# sourceMappingURL=ma.js.map