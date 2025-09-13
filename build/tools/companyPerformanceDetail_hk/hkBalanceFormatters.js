// 港股资产负债表数据格式化器
// 格式化港股资产负债表数据
export function formatHkBalanceData(data, ts_code, dataType) {
    if (!data || data.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `# ${ts_code} 港股资产负债表数据\n\n❌ 未找到相关数据`
                }
            ]
        };
    }
    // 获取股票名称
    const stockName = data[0]?.name || ts_code;
    // 按报告期分组
    const groupedByPeriod = groupByPeriod(data);
    let content = `# ${stockName} (${ts_code}) 港股资产负债表数据\n\n`;
    // 按报告期展示数据
    for (const [period, items] of Object.entries(groupedByPeriod)) {
        content += `## 📊 ${formatPeriod(period)} 资产负债表\n\n`;
        // 分类展示数据
        const categorizedData = categorizeBalanceItems(items);
        // 资产部分
        if (categorizedData.assets.length > 0) {
            content += `### 💰 资产部分\n\n`;
            content += `| 资产科目 | 金额(港币) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.assets) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 资产 |\n`;
            }
            content += `\n`;
        }
        // 负债部分
        if (categorizedData.liabilities.length > 0) {
            content += `### 📊 负债部分\n\n`;
            content += `| 负债科目 | 金额(港币) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.liabilities) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 负债 |\n`;
            }
            content += `\n`;
        }
        // 权益部分
        if (categorizedData.equity.length > 0) {
            content += `### 🏛️ 所有者权益部分\n\n`;
            content += `| 权益科目 | 金额(港币) | 备注 |\n`;
            content += `|---------|-----------|------|\n`;
            for (const item of categorizedData.equity) {
                const formattedValue = formatCurrency(item.ind_value);
                content += `| **${item.ind_name}** | ${formattedValue} | 权益 |\n`;
            }
            content += `\n`;
        }
        // 添加关键指标分析
        content += generateBalanceKeyMetrics(items, period);
        content += `\n---\n\n`;
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
// 分类资产负债表项目
function categorizeBalanceItems(items) {
    const assets = [];
    const liabilities = [];
    const equity = [];
    for (const item of items) {
        const category = getBalanceCategory(item.ind_name);
        if (category === 'asset') {
            assets.push(item);
        }
        else if (category === 'liability') {
            liabilities.push(item);
        }
        else if (category === 'equity') {
            equity.push(item);
        }
    }
    return { assets, liabilities, equity };
}
// 获取资产负债表科目分类
function getBalanceCategory(indName) {
    const assetKeywords = ['资产', '现金', '银行', '存款', '应收', '预付', '存货', '投资', '物业', '设备', '无形资产'];
    const liabilityKeywords = ['负债', '应付', '预收', '借款', '债务', '拨备', '税项负债'];
    const equityKeywords = ['权益', '股本', '股东', '储备', '盈余', '资本', '少数股东'];
    for (const keyword of assetKeywords) {
        if (indName.includes(keyword))
            return 'asset';
    }
    for (const keyword of liabilityKeywords) {
        if (indName.includes(keyword))
            return 'liability';
    }
    for (const keyword of equityKeywords) {
        if (indName.includes(keyword))
            return 'equity';
    }
    return 'other';
}
// 生成资产负债表关键指标分析
function generateBalanceKeyMetrics(items, period) {
    const metrics = {};
    // 提取关键指标
    items.forEach(item => {
        metrics[item.ind_name] = item.ind_value;
    });
    let analysis = `### 📈 ${formatPeriod(period)} 关键财务指标\n\n`;
    // 总资产
    const totalAssets = findMetricByKeywords(metrics, ['总资产', '资产总额']);
    if (totalAssets) {
        analysis += `- **总资产**: ${formatCurrency(totalAssets)}\n`;
    }
    // 总负债
    const totalLiabilities = findMetricByKeywords(metrics, ['总负债', '负债总额']);
    if (totalLiabilities) {
        analysis += `- **总负债**: ${formatCurrency(totalLiabilities)}\n`;
    }
    // 净资产/股东权益
    const equity = findMetricByKeywords(metrics, ['股东权益', '净资产', '权益总额']);
    if (equity) {
        analysis += `- **股东权益**: ${formatCurrency(equity)}\n`;
    }
    // 资产负债率
    if (totalAssets && totalLiabilities) {
        const debtRatio = (totalLiabilities / totalAssets) * 100;
        analysis += `- **资产负债率**: ${debtRatio.toFixed(2)}%\n`;
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
//# sourceMappingURL=hkBalanceFormatters.js.map