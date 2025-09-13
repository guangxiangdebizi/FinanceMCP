// 美股财务指标数据格式化器
// 格式化美股财务指标数据
export function formatUsIndicatorData(data, ts_code, dataType) {
    if (!data || data.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `# ${ts_code} 美股财务指标数据\n\n❌ 未找到相关数据`
                }
            ]
        };
    }
    // 获取股票名称
    const stockName = data[0]?.security_name_abbr || ts_code;
    // 按报告期分组
    const groupedByPeriod = groupByPeriod(data);
    let content = `# ${stockName} (${ts_code}) 美股财务指标数据\n\n`;
    // 按报告期展示数据
    for (const [period, items] of Object.entries(groupedByPeriod)) {
        const item = items[0]; // 财务指标每期通常只有一条记录
        const reportType = item?.report_type || '未知';
        content += `## 📊 ${formatPeriod(period)} ${reportType}\n\n`;
        // 基本信息
        content += `### 📋 基本信息\n\n`;
        content += `| 项目 | 内容 |\n`;
        content += `|------|------|\n`;
        content += `| **会计准则** | ${item.accounting_standards || 'N/A'} |\n`;
        content += `| **货币单位** | ${item.currency || 'N/A'} |\n`;
        content += `| **公告日期** | ${formatDate(item.notice_date)} |\n`;
        content += `| **财务日期** | ${formatDate(item.financial_date)} |\n`;
        content += `\n`;
        // 核心财务指标
        content += generateCoreMetrics(item);
        // 盈利能力指标
        content += generateProfitabilityMetrics(item);
        // 成长性指标
        content += generateGrowthMetrics(item);
        // 偿债能力指标
        content += generateSolvencyMetrics(item);
        // 运营效率指标
        content += generateEfficiencyMetrics(item);
        // 市场表现指标
        content += generateMarketMetrics(item);
        content += `\n---\n\n`;
    }
    // 添加多期对比分析（如果有多个报告期）
    if (Object.keys(groupedByPeriod).length > 1) {
        content += generatePeriodComparison(groupedByPeriod);
    }
    // 添加数据说明
    content += `\n## 📋 数据说明\n\n`;
    content += `- **数据来源**: Tushare美股财务数据\n`;
    content += `- **货币单位**: ${data[0]?.currency || '美元'}(USD)\n`;
    content += `- **会计准则**: ${data[0]?.accounting_standards || '美国会计准则'}\n`;
    content += `- **更新时间**: ${new Date().toLocaleDateString('zh-CN')}\n`;
    content += `- **数据条数**: ${data.length} 条财务指标数据\n`;
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
// 格式化日期显示
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8)
        return dateStr || 'N/A';
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${year}-${month}-${day}`;
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
// 格式化百分比
function formatPercentage(value) {
    if (value === null || value === undefined)
        return 'N/A';
    return `${value.toFixed(2)}%`;
}
// 生成核心财务指标
function generateCoreMetrics(item) {
    let content = `### 💰 核心财务指标\n\n`;
    content += `| 指标 | 数值 | 同比变化 |\n`;
    content += `|------|------|----------|\n`;
    if (item.operate_income) {
        const yoyGrowth = item.operate_income_yoy ? formatPercentage(item.operate_income_yoy) : 'N/A';
        content += `| **营业收入** | ${formatCurrency(item.operate_income)} | ${yoyGrowth} |\n`;
    }
    // 可能的其他核心指标
    const coreFields = [
        { key: 'net_profit', name: '净利润', yoyKey: 'net_profit_yoy' },
        { key: 'total_assets', name: '总资产', yoyKey: 'total_assets_yoy' },
        { key: 'total_hldr_eqy_exc_min_int', name: '股东权益', yoyKey: 'equity_yoy' }
    ];
    for (const field of coreFields) {
        if (item[field.key]) {
            const yoyGrowth = item[field.yoyKey] ? formatPercentage(item[field.yoyKey]) : 'N/A';
            content += `| **${field.name}** | ${formatCurrency(item[field.key])} | ${yoyGrowth} |\n`;
        }
    }
    return content + '\n';
}
// 生成盈利能力指标
function generateProfitabilityMetrics(item) {
    let content = `### 📈 盈利能力指标\n\n`;
    content += `| 指标 | 数值 |\n`;
    content += `|------|------|\n`;
    const profitFields = [
        { key: 'roe', name: '净资产收益率(ROE)' },
        { key: 'roa', name: '总资产收益率(ROA)' },
        { key: 'gross_margin', name: '毛利率' },
        { key: 'netprofit_margin', name: '净利率' },
        { key: 'op_income_margin', name: '营业利润率' }
    ];
    for (const field of profitFields) {
        if (item[field.key] !== undefined && item[field.key] !== null) {
            content += `| **${field.name}** | ${formatPercentage(item[field.key])} |\n`;
        }
    }
    return content + '\n';
}
// 生成成长性指标
function generateGrowthMetrics(item) {
    let content = `### 🚀 成长性指标\n\n`;
    content += `| 指标 | 数值 |\n`;
    content += `|------|------|\n`;
    const growthFields = [
        { key: 'operate_income_yoy', name: '营业收入同比增长' },
        { key: 'net_profit_yoy', name: '净利润同比增长' },
        { key: 'total_assets_yoy', name: '总资产同比增长' },
        { key: 'equity_yoy', name: '净资产同比增长' }
    ];
    for (const field of growthFields) {
        if (item[field.key] !== undefined && item[field.key] !== null) {
            content += `| **${field.name}** | ${formatPercentage(item[field.key])} |\n`;
        }
    }
    return content + '\n';
}
// 生成偿债能力指标
function generateSolvencyMetrics(item) {
    let content = `### 🏛️ 偿债能力指标\n\n`;
    content += `| 指标 | 数值 |\n`;
    content += `|------|------|\n`;
    const solvencyFields = [
        { key: 'debt_to_assets', name: '资产负债率' },
        { key: 'assets_to_eqt', name: '权益乘数' },
        { key: 'current_ratio', name: '流动比率' },
        { key: 'quick_ratio', name: '速动比率' }
    ];
    for (const field of solvencyFields) {
        if (item[field.key] !== undefined && item[field.key] !== null) {
            const value = field.key.includes('ratio') || field.key.includes('debt') ?
                formatPercentage(item[field.key]) :
                item[field.key].toFixed(2);
            content += `| **${field.name}** | ${value} |\n`;
        }
    }
    return content + '\n';
}
// 生成运营效率指标
function generateEfficiencyMetrics(item) {
    let content = `### ⚡ 运营效率指标\n\n`;
    content += `| 指标 | 数值 |\n`;
    content += `|------|------|\n`;
    const efficiencyFields = [
        { key: 'inv_turn', name: '存货周转率' },
        { key: 'ar_turn', name: '应收账款周转率' },
        { key: 'assets_turn', name: '总资产周转率' },
        { key: 'ca_turn', name: '流动资产周转率' }
    ];
    for (const field of efficiencyFields) {
        if (item[field.key] !== undefined && item[field.key] !== null) {
            content += `| **${field.name}** | ${item[field.key].toFixed(2)}次 |\n`;
        }
    }
    return content + '\n';
}
// 生成市场表现指标
function generateMarketMetrics(item) {
    let content = `### 📊 市场表现指标\n\n`;
    content += `| 指标 | 数值 |\n`;
    content += `|------|------|\n`;
    const marketFields = [
        { key: 'basic_eps', name: '每股基本收益', isCurrency: true },
        { key: 'diluted_eps', name: '每股稀释收益', isCurrency: true },
        { key: 'bps', name: '每股净资产', isCurrency: true },
        { key: 'undp', name: '每股未分配利润', isCurrency: true }
    ];
    for (const field of marketFields) {
        if (item[field.key] !== undefined && item[field.key] !== null) {
            const value = field.isCurrency ?
                `$${item[field.key].toFixed(4)}` :
                item[field.key].toFixed(2);
            content += `| **${field.name}** | ${value} |\n`;
        }
    }
    return content + '\n';
}
// 生成多期对比分析
function generatePeriodComparison(groupedData) {
    const periods = Object.keys(groupedData).sort();
    if (periods.length < 2)
        return '';
    let comparison = `## 📊 多期对比分析\n\n`;
    comparison += `| 财务指标 | ${periods.map(p => formatPeriod(p)).join(' | ')} | 变化趋势 |\n`;
    comparison += `|---------|${periods.map(() => '----------').join('|')}|----------|\n`;
    // 重要指标对比
    const importantFields = [
        { key: 'operate_income', name: '营业收入', formatter: formatCurrency },
        { key: 'net_profit', name: '净利润', formatter: formatCurrency },
        { key: 'basic_eps', name: '每股基本收益', formatter: (v) => `$${v.toFixed(4)}` },
        { key: 'roe', name: '净资产收益率', formatter: formatPercentage },
        { key: 'roa', name: '总资产收益率', formatter: formatPercentage }
    ];
    for (const field of importantFields) {
        const values = [];
        for (const period of periods) {
            const item = groupedData[period][0];
            values.push(item[field.key] || null);
        }
        // 计算趋势
        const trend = calculateTrend(values);
        const formattedValues = values.map(v => v !== null ? field.formatter(v) : 'N/A');
        comparison += `| **${field.name}** | ${formattedValues.join(' | ')} | ${trend} |\n`;
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
//# sourceMappingURL=usIndicatorFormatters.js.map