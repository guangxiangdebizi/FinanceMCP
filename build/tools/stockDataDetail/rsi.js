// RSI 技术指标计算模块
/**
 * 计算RSI指标
 * @param prices 价格数组
 * @param period 计算周期，默认14
 */
export function calculateRSI(prices, period = 14) {
    const rsi = [];
    const gains = [];
    const losses = [];
    // 计算涨跌幅
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }
    for (let i = 0; i < prices.length; i++) {
        if (i < period) {
            rsi.push(NaN);
        }
        else {
            const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
            const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
            if (avgLoss === 0) {
                rsi.push(100);
            }
            else {
                const rs = avgGain / avgLoss;
                rsi.push(100 - (100 / (1 + rs)));
            }
        }
    }
    return rsi;
}
//# sourceMappingURL=rsi.js.map