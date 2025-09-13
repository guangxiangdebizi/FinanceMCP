// 技术指标数据计算器
/**
 * 计算技术指标所需的最小历史数据天数
 * @param indicators 技术指标数组
 * @returns 所需的最小历史天数
 */
export function calculateRequiredDays(indicators) {
    let maxDays = 0;
    for (const indicator of indicators) {
        const match = indicator.match(/^([a-zA-Z]+\d*)(\(([^)]+)\))?$/);
        if (!match)
            continue;
        const name = match[1].toLowerCase();
        const paramsStr = match[3];
        let params = [];
        if (paramsStr) {
            params = paramsStr.split(',').map(p => parseFloat(p.trim())).filter(n => !isNaN(n));
        }
        let requiredDays = 0;
        switch (name) {
            case 'macd':
                if (params.length < 3)
                    continue; // 跳过参数不完整的指标
                const slowPeriod = params[1];
                const signalPeriod = params[2];
                requiredDays = slowPeriod + signalPeriod + 10; // 额外10天保证计算准确性
                break;
            case 'rsi':
                if (params.length < 1)
                    continue;
                const rsiPeriod = params[0];
                requiredDays = rsiPeriod + 10;
                break;
            case 'kdj':
                if (params.length < 1)
                    continue;
                const kdjPeriod = params[0];
                requiredDays = kdjPeriod + 10;
                break;
            case 'boll':
                if (params.length < 1)
                    continue;
                const bollPeriod = params[0];
                requiredDays = bollPeriod + 10;
                break;
            case 'ma':
                if (params.length < 1)
                    continue;
                const maPeriod = params[0];
                requiredDays = maPeriod + 5;
                break;
        }
        maxDays = Math.max(maxDays, requiredDays);
    }
    return maxDays;
}
/**
 * 计算扩展的开始日期
 * @param originalStartDate 用户指定的开始日期 YYYYMMDD
 * @param requiredDays 需要的历史天数
 * @returns 扩展后的开始日期 YYYYMMDD
 */
export function calculateExtendedStartDate(originalStartDate, requiredDays) {
    const date = new Date(parseInt(originalStartDate.substring(0, 4)), parseInt(originalStartDate.substring(4, 6)) - 1, parseInt(originalStartDate.substring(6, 8)));
    // 考虑到周末和节假日，实际需要更多的日历天数
    const calendarDays = Math.ceil(requiredDays * 1.5); // 1.5倍系数考虑非交易日
    date.setDate(date.getDate() - calendarDays);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
/**
 * 过滤数据到用户请求的时间范围
 * @param data 完整数据数组
 * @param startDate 用户请求的开始日期
 * @param endDate 用户请求的结束日期
 * @returns 过滤后的数据
 */
export function filterDataToUserRange(data, startDate, endDate) {
    return data.filter(item => {
        const tradeDate = item.trade_date;
        return tradeDate >= startDate && tradeDate <= endDate;
    });
}
//# sourceMappingURL=dataCalculator.js.map