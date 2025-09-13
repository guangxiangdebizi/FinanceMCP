// 美股现金流量表数据格式化器
// 格式化美股现金流量表数据
export function formatUsCashflowData(data, ts_code, dataType) {
    if (!data || data.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `# ${ts_code} 美股现金流量表数据\n\n❌ 未找到相关数据`
                }
            ]
        };
    }
    // 获取股票名称
    const stockName = data[0]?.name || ts_code;
    // 按报告期分组
    const groupedByPeriod = groupByPeriod(data);
    let content = `# ${stockName} (${ts_code}) 美股现金流量表数据\n\n`;
    // 按报告期展示数据
    for (const [period, items] of Object.entries(groupedByPeriod)) {
        const reportType = items[0]?.report_type || '未知';
        content += `## 📊 ${formatPeriod(period)} ${reportType}\n\n`;
        // 分类展示现金流数据
        const categorizedData = categorizeCashflowItems(items);
        // 经营活动现金流
        if (categorizedData.operating.length > 0) {
            content += `### 💼 经营活动现金流\n\n`;
            content += `| 现金流项目 | 金额(美元) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.operating) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 经营活动 |\n`;
            }
            content += `\n`;
        }
        // 投资活动现金流
        if (categorizedData.investing.length > 0) {
            content += `### 📈 投资活动现金流\n\n`;
            content += `| 现金流项目 | 金额(美元) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.investing) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 投资活动 |\n`;
            }
            content += `\n`;
        }
        // 筹资活动现金流
        if (categorizedData.financing.length > 0) {
            content += `### 🏦 筹资活动现金流\n\n`;
            content += `| 现金流项目 | 金额(美元) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.financing) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 筹资活动 |\n`;
            }
            content += `\n`;
        }
        // 其他现金流项目
        if (categorizedData.others.length > 0) {
            content += `### 🔄 其他现金流项目\n\n`;
            content += `| 现金流项目 | 金额(美元) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.others) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 其他项目 |\n`;
            }
            content += `\n`;
        }
        // 添加现金流关键指标分析
        content += generateCashflowKeyMetrics(items, period);
        content += `\n---\n\n`;
    }
    // 添加数据说明
    content += `\n## 📋 数据说明\n\n`;
    content += `- **数据来源**: Tushare美股财务数据\n`;
    content += `- **货币单位**: 美元(USD)\n`;
    content += `- **更新时间**: ${new Date().toLocaleDateString('zh-CN')}\n`;
    content += `- **数据条数**: ${data.length} 条现金流项目数据\n`;
    return {
        content: [
            {
                type: "text",
                text: content
            }
        ]
    };
}
// 按报告期分组数据
function groupByPeriod(data) {
    return data.reduce((groups, item) => {
        const period = item.end_date;
        if (!groups[period]) {
            groups[period] = [];
        }
        groups[period].push(item);
        return groups;
    }, {});
}
// 格式化报告期显示
function formatPeriod(period) {
    if (!period || period.length !== 8)
        return period;
    const year = period.substring(0, 4);
    const month = period.substring(4, 6);
    const day = period.substring(6, 8);
    if (month === '12' && day === '31') {
        return `${year}年年报`;
    }
    else if (month === '06' && day === '30') {
        return `${year}年中报`;
    }
    else if (month === '09' && day === '30') {
        return `${year}年三季报`;
    }
    else if (month === '03' && day === '31') {
        return `${year}年一季报`;
    }
    else {
        return `${year}-${month}-${day}`;
    }
}
// 格式化货币金额
function formatCurrency(value) {
    if (value === null || value === undefined)
        return 'N/A';
    const absValue = Math.abs(value);
    let formatted;
    let unit;
    if (absValue >= 1e12) {
        formatted = (value / 1e12).toFixed(2);
        unit = '万亿';
    }
    else if (absValue >= 1e9) {
        formatted = (value / 1e9).toFixed(2);
        unit = '十亿';
    }
    else if (absValue >= 1e6) {
        formatted = (value / 1e6).toFixed(2);
        unit = '百万';
    }
    else if (absValue >= 1e3) {
        formatted = (value / 1e3).toFixed(2);
        unit = '千';
    }
    else {
        formatted = value.toFixed(2);
        unit = '';
    }
    return `$${formatted}${unit}`;
}
// 分类现金流量表项目
function categorizeCashflowItems(items) {
    const operating = [];
    const investing = [];
    const financing = [];
    const others = [];
    for (const item of items) {
        const category = getCashflowCategory(item.ind_name);
        if (category === 'operating') {
            operating.push(item);
        }
        else if (category === 'investing') {
            investing.push(item);
        }
        else if (category === 'financing') {
            financing.push(item);
        }
        else {
            others.push(item);
        }
    }
    return { operating, investing, financing, others };
}
// 获取现金流量表科目分类
function getCashflowCategory(indName) {
    const operatingKeywords = [
        '经营活动', '营业收入', '客户款项', '供应商款项', '员工成本',
        '营运资金', '经营业务', '税项', '利息收入', '股息收入', '净利润',
        'Operating', 'Revenue', 'Customer', 'Supplier', 'Working Capital',
        'Net Income', 'Depreciation', 'Amortization'
    ];
    const investingKeywords = [
        '投资活动', '购买物业', '出售物业', '投资支出', '投资收入',
        '收购', '出售', '资本支出', '设备', '投资证券',
        'Investing', 'Capital Expenditure', 'Purchase', 'Sale', 'Investment',
        'Property', 'Equipment', 'Acquisition'
    ];
    const financingKeywords = [
        '筹资活动', '股份发行', '借款', '偿还', '股息支付',
        '债务', '融资', '股本', '借贷', '回购',
        'Financing', 'Issuance', 'Borrowing', 'Repayment', 'Dividend',
        'Debt', 'Equity', 'Repurchase'
    ];
    for (const keyword of operatingKeywords) {
        if (indName.includes(keyword))
            return 'operating';
    }
    for (const keyword of investingKeywords) {
        if (indName.includes(keyword))
            return 'investing';
    }
    for (const keyword of financingKeywords) {
        if (indName.includes(keyword))
            return 'financing';
    }
    return 'other';
}
// 生成现金流关键指标分析
function generateCashflowKeyMetrics(items, period) {
    const metrics = {};
    // 提取关键指标
    items.forEach(item => {
        metrics[item.ind_name] = item.ind_value;
    });
    let analysis = `### 📈 ${formatPeriod(period)} 现金流关键指标\n\n`;
    // 经营活动现金流净额
    const operatingCashFlow = findMetricByKeywords(metrics, [
        '经营活动产生的现金流量净额', '经营活动现金流净额', '营运资金变动',
        'Operating Cash Flow', 'Cash from Operating'
    ]);
    if (operatingCashFlow) {
        analysis += `- **经营活动现金流净额**: ${formatCurrency(operatingCashFlow)}\n`;
    }
    // 投资活动现金流净额
    const investingCashFlow = findMetricByKeywords(metrics, [
        '投资活动产生的现金流量净额', '投资活动现金流净额',
        'Investing Cash Flow', 'Cash from Investing'
    ]);
    if (investingCashFlow) {
        analysis += `- **投资活动现金流净额**: ${formatCurrency(investingCashFlow)}\n`;
    }
    // 筹资活动现金流净额
    const financingCashFlow = findMetricByKeywords(metrics, [
        '筹资活动产生的现金流量净额', '筹资活动现金流净额',
        'Financing Cash Flow', 'Cash from Financing'
    ]);
    if (financingCashFlow) {
        analysis += `- **筹资活动现金流净额**: ${formatCurrency(financingCashFlow)}\n`;
    }
    // 现金及现金等价物净增加额
    const netCashChange = findMetricByKeywords(metrics, [
        '现金及现金等价物净增加额', '现金净增加额', '现金变动净额',
        'Net Change in Cash', 'Cash Increase'
    ]);
    if (netCashChange) {
        analysis += `- **现金净增加额**: ${formatCurrency(netCashChange)}\n`;
    }
    // 期末现金余额
    const endingCash = findMetricByKeywords(metrics, [
        '现金及现金等价物期末余额', '期末现金余额',
        'Ending Cash Balance', 'Cash at End'
    ]);
    if (endingCash) {
        analysis += `- **期末现金余额**: ${formatCurrency(endingCash)}\n`;
    }
    // 自由现金流（经营现金流 - 资本支出）
    const capex = findMetricByKeywords(metrics, [
        '资本支出', '购买物业、设备', 'Capital Expenditure', 'Purchase of Property'
    ]);
    if (operatingCashFlow && capex) {
        const freeCashFlow = operatingCashFlow + capex; // capex通常为负数
        analysis += `- **自由现金流**: ${formatCurrency(freeCashFlow)}\n`;
    }
    return analysis;
}
// 根据关键词查找指标值
function findMetricByKeywords(metrics, keywords) {
    for (const [key, value] of Object.entries(metrics)) {
        for (const keyword of keywords) {
            if (key.includes(keyword)) {
                return value;
            }
        }
    }
    return null;
}
//# sourceMappingURL=usCashflowFormatters.js.map