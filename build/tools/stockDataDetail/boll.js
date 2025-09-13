// BOLL 布林带技术指标计算模块
/**
 * 计算简单移动平均线 (SMA) - 内部使用
 */
function calculateSMA(prices, period) {
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
 * 计算布林带指标
 * @param prices 价格数组
 * @param period 计算周期，默认20
 * @param stdDev 标准差倍数，默认2
 */
export function calculateBOLL(prices, period = 20, stdDev = 2) {
    const sma = calculateSMA(prices, period);
    const upper = [];
    const lower = [];
    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            upper.push(NaN);
            lower.push(NaN);
        }
        else {
            const periodPrices = prices.slice(i - period + 1, i + 1);
            const mean = sma[i];
            const variance = periodPrices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
            const standardDeviation = Math.sqrt(variance);
            upper.push(mean + (standardDeviation * stdDev));
            lower.push(mean - (standardDeviation * stdDev));
        }
    }
    return {
        middle: sma,
        upper,
        lower
    };
}
//# sourceMappingURL=boll.js.map