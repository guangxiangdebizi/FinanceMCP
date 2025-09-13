// 业绩预告和业绩快报格式化函数模块
// 用于处理业绩预告和业绩快报数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 辅助函数：获取预告类型描述
function getForecastType(type) {
    const typeMap = {
        '1': '预增',
        '2': '预减',
        '3': '扭亏',
        '4': '首亏',
        '5': '续亏',
        '6': '续盈',
        '7': '略增',
        '8': '略减'
    };
    return typeMap[type] || type;
}
// 格式化业绩预告数据
export function formatForecast(data) {
    let output = '';
    for (const item of data) {
        output += ` ${item.end_date} 期间预告\n`;
        output += `公告日期: ${item.ann_date}  预告类型: ${getForecastType(item.type)}\n`;
        if (item.p_change_min !== null && item.p_change_max !== null) {
            output += `净利润变动幅度: ${item.p_change_min}% ~ ${item.p_change_max}%\n`;
        }
        if (item.net_profit_min !== null && item.net_profit_max !== null) {
            output += `预计净利润: ${formatNumber(item.net_profit_min)} ~ ${formatNumber(item.net_profit_max)} 万元\n`;
        }
        if (item.last_parent_net)
            output += `上年同期净利润: ${formatNumber(item.last_parent_net)} 万元\n`;
        if (item.summary)
            output += `业绩预告摘要: ${item.summary}\n`;
        if (item.change_reason)
            output += `变动原因: ${item.change_reason}\n`;
        output += '\n';
    }
    return output;
}
// 格式化业绩快报数据
export function formatExpress(data) {
    let output = '';
    for (const item of data) {
        output += ` ${item.end_date} 期间快报\n`;
        output += `公告日期: ${item.ann_date}\n\n`;
        if (item.revenue)
            output += `营业收入: ${formatNumber(item.revenue)} 万元\n`;
        if (item.operate_profit)
            output += `营业利润: ${formatNumber(item.operate_profit)} 万元\n`;
        if (item.total_profit)
            output += `利润总额: ${formatNumber(item.total_profit)} 万元\n`;
        if (item.n_income)
            output += `净利润: ${formatNumber(item.n_income)} 万元\n`;
        if (item.total_assets)
            output += `总资产: ${formatNumber(item.total_assets)} 万元\n`;
        if (item.total_hldr_eqy_exc_min_int)
            output += `股东权益: ${formatNumber(item.total_hldr_eqy_exc_min_int)} 万元\n`;
        if (item.diluted_eps)
            output += `每股收益: ${item.diluted_eps} 元\n`;
        if (item.diluted_roe)
            output += `净资产收益率: ${item.diluted_roe}%\n`;
        // 同比增长率
        if (item.yoy_net_profit)
            output += `净利润同比增长: ${item.yoy_net_profit}%\n`;
        if (item.yoy_sales)
            output += `营收同比增长: ${item.yoy_sales}%\n`;
        output += '\n';
    }
    return output;
}
//# sourceMappingURL=forecastExpressFormatters.js.map