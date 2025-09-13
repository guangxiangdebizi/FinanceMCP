// MACD 技术指标计算模块
/**
 * 计算指数移动平均线 (EMA) - 内部使用
 */
function calculateEMA(prices, period) {
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
/**
 * 计算MACD指标
 * @param prices 价格数组
 * @param fastPeriod 快线周期，默认12
 * @param slowPeriod 慢线周期，默认26
 * @param signalPeriod 信号线周期，默认9
 */
export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const emaFast = calculateEMA(prices, fastPeriod);
    const emaSlow = calculateEMA(prices, slowPeriod);
    const dif = emaFast.map((fast, i) => fast - emaSlow[i]);
    const dea = calculateEMA(dif.filter(x => !isNaN(x)), signalPeriod);
    // 为了保持数组长度一致，在DEA前面填充NaN
    const fullDea = [];
    const nanCount = slowPeriod - 1;
    for (let i = 0; i < nanCount; i++) {
        fullDea.push(NaN);
    }
    fullDea.push(...dea);
    const macd = dif.map((d, i) => (d - fullDea[i]) * 2);
    return {
        dif,
        dea: fullDea,
        macd
    };
}
//# sourceMappingURL=macd.js.map