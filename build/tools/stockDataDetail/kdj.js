// KDJ 技术指标计算模块
/**
 * 计算KDJ指标
 * @param highs 最高价数组
 * @param lows 最低价数组
 * @param closes 收盘价数组
 * @param period RSV周期，默认9
 * @param k K值平滑参数，默认3
 * @param d D值平滑参数，默认3
 */
export function calculateKDJ(highs, lows, closes, period = 9, k = 3, d = 3) {
    const rsv = [];
    const kValues = [];
    const dValues = [];
    const jValues = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            rsv.push(NaN);
            kValues.push(NaN);
            dValues.push(NaN);
            jValues.push(NaN);
        }
        else {
            const periodHigh = Math.max(...highs.slice(i - period + 1, i + 1));
            const periodLow = Math.min(...lows.slice(i - period + 1, i + 1));
            const currentRsv = ((closes[i] - periodLow) / (periodHigh - periodLow)) * 100;
            rsv.push(currentRsv);
            if (i === period - 1) {
                kValues.push(currentRsv);
                dValues.push(currentRsv);
            }
            else {
                const newK = (kValues[i - 1] * (k - 1) + currentRsv) / k;
                const newD = (dValues[i - 1] * (d - 1) + newK) / d;
                kValues.push(newK);
                dValues.push(newD);
            }
            const j = 3 * kValues[i] - 2 * dValues[i];
            jValues.push(j);
        }
    }
    return { k: kValues, d: dValues, j: jValues };
}
//# sourceMappingURL=kdj.js.map