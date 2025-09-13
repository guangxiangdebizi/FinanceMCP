// 港股利润表数据格式化器
// 格式化港股利润表数据
export function formatHkIncomeData(data, ts_code, dataType) {
    if (!data || data.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `# ${ts_code} 港股利润表数据\n\n❌ 未找到相关数据`
                }
            ]
        };
    }
    // 获取股票名称
    const stockName = data[0]?.name || ts_code;
    // 按报告期分组
    const groupedByPeriod = groupByPeriod(data);
    let content = `# ${stockName} (${ts_code}) 港股利润表数据\n\n`;
    // 按报告期展示数据
    for (const [period, items] of Object.entries(groupedByPeriod)) {
        content += `## 📊 ${formatPeriod(period)} 利润表\n\n`;
        content += `| 财务科目 | 金额(港币) | 备注 |\n`;
        content += `|---------|-----------|------|\n`;
        // 按重要性排序财务科目
        const sortedItems = sortIncomeItems(items);
        for (const item of sortedItems) {
            const formattedValue = formatCurrency(item.ind_value);
            const category = getIncomeCategory(item.ind_name);
            content += `| **${item.ind_name}** | ${formattedValue} | ${category} |\n`;
        }
        content += `\n`;
        // 添加关键指标分析
        content += generateKeyMetricsAnalysis(items, period);
        content += `\n---\n\n`;
    }
    // 添加多期对比分析（如果有多个报告期）
    if (Object.keys(groupedByPeriod).length > 1) {
        content += generatePeriodComparison(groupedByPeriod);
    }
    // 添加数据说明
    content += `\n## 📋 数据说明\n\n`;
    content += `- **数据来源**: Tushare港股财务数据\n`;
    content += `- **货币单位**: 港币\n`;
    content += `- **更新时间**: ${new Date().toLocaleDateString('zh-CN')}\n`;
    content += `- **数据条数**: ${data.length} 条财务科目数据\n`;
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
    // 判断报告期类型
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
    else if (absValue >= 1e8) {
        formatted = (value / 1e8).toFixed(2);
        unit = '亿';
    }
    else if (absValue >= 1e4) {
        formatted = (value / 1e4).toFixed(2);
        unit = '万';
    }
    else {
        formatted = value.toFixed(2);
        unit = '';
    }
    return `${formatted}${unit}`;
}
// 获取财务科目分类
function getIncomeCategory(indName) {
    const categories = {
        '营业额': '收入',
        '营运收入': '收入',
        '其他营业收入': '收入',
        '营运支出': '成本',
        '毛利': '盈利',
        '经营溢利': '盈利',
        '除税前溢利': '盈利',
        '除税后溢利': '盈利',
        '股东应占溢利': '盈利',
        '每股基本盈利': '每股指标',
        '每股摊薄盈利': '每股指标',
        '销售及分销费用': '费用',
        '行政开支': '费用',
        '利息收入': '财务',
        '融资成本': '财务',
        '税项': '税收',
        '应占联营公司溢利': '投资收益',
        '少数股东损益': '权益',
        '其他全面收益': '综合收益',
        '全面收益总额': '综合收益'
    };
    return categories[indName] || '其他';
}
// 按重要性排序财务科目
function sortIncomeItems(items) {
    const priority = {
        '营业额': 1,
        '营运收入': 2,
        '营运支出': 3,
        '毛利': 4,
        '销售及分销费用': 5,
        '行政开支': 6,
        '经营溢利': 7,
        '利息收入': 8,
        '融资成本': 9,
        '应占联营公司溢利': 10,
        '除税前溢利': 11,
        '税项': 12,
        '除税后溢利': 13,
        '少数股东损益': 14,
        '股东应占溢利': 15,
        '每股基本盈利': 16,
        '每股摊薄盈利': 17,
        '其他全面收益': 18,
        '全面收益总额': 19
    };
    return items.sort((a, b) => {
        const priorityA = priority[a.ind_name] || 999;
        const priorityB = priority[b.ind_name] || 999;
        return priorityA - priorityB;
    });
}
// 生成关键指标分析
function generateKeyMetricsAnalysis(items, period) {
    const metrics = {};
    // 提取关键指标
    items.forEach(item => {
        metrics[item.ind_name] = item.ind_value;
    });
    let analysis = `### 📈 ${formatPeriod(period)} 关键指标分析\n\n`;
    // 营收相关
    if (metrics['营业额']) {
        analysis += `- **营业额**: ${formatCurrency(metrics['营业额'])}\n`;
    }
    // 盈利相关
    if (metrics['毛利'] && metrics['营业额']) {
        const grossMargin = (metrics['毛利'] / metrics['营业额']) * 100;
        analysis += `- **毛利率**: ${grossMargin.toFixed(2)}%\n`;
    }
    if (metrics['股东应占溢利']) {
        analysis += `- **股东应占溢利**: ${formatCurrency(metrics['股东应占溢利'])}\n`;
    }
    if (metrics['股东应占溢利'] && metrics['营业额']) {
        const netMargin = (metrics['股东应占溢利'] / metrics['营业额']) * 100;
        analysis += `- **净利率**: ${netMargin.toFixed(2)}%\n`;
    }
    // 每股指标
    if (metrics['每股基本盈利']) {
        analysis += `- **每股基本盈利**: ${metrics['每股基本盈利'].toFixed(4)} 港币\n`;
    }
    return analysis;
}
// 生成多期对比分析
function generatePeriodComparison(groupedData) {
    const periods = Object.keys(groupedData).sort();
    if (periods.length < 2)
        return '';
    let comparison = `## 📊 多期对比分析\n\n`;
    comparison += `| 财务科目 | ${periods.map(p => formatPeriod(p)).join(' | ')} | 变化趋势 |\n`;
    comparison += `|---------|${periods.map(() => '----------').join('|')}|----------|\n`;
    // 获取所有财务科目
    const allIndicators = new Set();
    Object.values(groupedData).forEach(items => {
        items.forEach(item => allIndicators.add(item.ind_name));
    });
    // 重要指标优先
    const importantIndicators = ['营业额', '毛利', '经营溢利', '除税后溢利', '股东应占溢利', '每股基本盈利'];
    const sortedIndicators = [
        ...importantIndicators.filter(ind => allIndicators.has(ind)),
        ...Array.from(allIndicators).filter(ind => !importantIndicators.includes(ind))
    ];
    for (const indicator of sortedIndicators) {
        const values = [];
        for (const period of periods) {
            const item = groupedData[period].find(item => item.ind_name === indicator);
            values.push(item ? item.ind_value : null);
        }
        // 计算趋势
        const trend = calculateTrend(values);
        const formattedValues = values.map(v => v !== null ? formatCurrency(v) : 'N/A');
        comparison += `| **${indicator}** | ${formattedValues.join(' | ')} | ${trend} |\n`;
    }
    return comparison + '\n';
}
// 计算趋势
function calculateTrend(values) {
    const validValues = values.filter(v => v !== null);
    if (validValues.length < 2)
        return '📊 数据不足';
    const first = validValues[0];
    const last = validValues[validValues.length - 1];
    if (last > first * 1.1)
        return '📈 上升';
    if (last < first * 0.9)
        return '📉 下降';
    return '➡️ 平稳';
}
//# sourceMappingURL=hkIncomeFormatters.js.map