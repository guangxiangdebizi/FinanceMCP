// 分红送股格式化函数模块
// 用于处理分红送股数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 格式化分红送股数据
export function formatDividend(data) {
    let output = '';
    for (const item of data) {
        output += ` ${item.end_date} 分红方案\n`;
        output += `公告日期: ${item.ann_date}  实施进度: ${item.div_proc || 'N/A'}\n`;
        if (item.stk_div)
            output += `送股比例: 每10股送${item.stk_div}股\n`;
        if (item.stk_bo_rate)
            output += `转股比例: 每10股转${item.stk_bo_rate}股\n`;
        if (item.cash_div)
            output += `现金分红: 每10股派${item.cash_div}元\n`;
        if (item.cash_div_tax)
            output += `税后分红: 每10股派${item.cash_div_tax}元\n`;
        if (item.record_date)
            output += `股权登记日: ${item.record_date}\n`;
        if (item.ex_date)
            output += `除权除息日: ${item.ex_date}\n`;
        if (item.pay_date)
            output += `派息日: ${item.pay_date}\n`;
        output += '\n';
    }
    return output;
}
//# sourceMappingURL=dividendFormatters.js.map