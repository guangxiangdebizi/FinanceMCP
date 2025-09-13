// 前十大股东和前十大流通股东数据格式化器
// 格式化前十大股东数据
export function formatTop10Holders(data) {
    if (!data || data.length === 0) {
        return 'ℹ️ 暂无前十大股东数据\n\n';
    }
    let output = '';
    // 按报告期分组
    const groupedByPeriod = data.reduce((acc, item) => {
        const endDate = item.end_date || '未知期间';
        if (!acc[endDate]) {
            acc[endDate] = [];
        }
        acc[endDate].push(item);
        return acc;
    }, {});
    // 按报告期排序（最新在前）
    const sortedPeriods = Object.keys(groupedByPeriod).sort((a, b) => {
        if (a === '未知期间')
            return 1;
        if (b === '未知期间')
            return -1;
        return b.localeCompare(a);
    });
    for (const period of sortedPeriods) {
        const items = groupedByPeriod[period];
        // 格式化报告期显示
        const formattedPeriod = period !== '未知期间' && period.length === 8
            ? `${period.substr(0, 4)}-${period.substr(4, 2)}-${period.substr(6, 2)}`
            : period;
        output += `### 📊 报告期: ${formattedPeriod}\n\n`;
        // 计算该期间的汇总信息
        const totalShares = items.reduce((sum, item) => sum + (parseFloat(item.hold_amount) || 0), 0);
        const totalRatio = items.reduce((sum, item) => sum + (parseFloat(item.hold_ratio) || 0), 0);
        output += `**汇总信息:**\n`;
        output += `- 前十大股东持股总数: ${formatNumber(totalShares)} 股\n`;
        output += `- 前十大股东持股比例: ${totalRatio.toFixed(2)}%\n`;
        output += `- 股东数量: ${items.length} 个\n\n`;
        // 按持股数量排序（从多到少）
        const sortedItems = items.sort((a, b) => (parseFloat(b.hold_amount) || 0) - (parseFloat(a.hold_amount) || 0));
        output += `| 排名 | 股东名称 | 持股数量 | 持股比例(%) | 持股变动 | 股东类型 | 公告日期 |\n`;
        output += `|------|---------|---------|------------|---------|----------|----------|\n`;
        sortedItems.forEach((item, index) => {
            const rank = index + 1;
            const holderName = item.holder_name || '未知';
            const holdAmount = item.hold_amount ? formatNumber(parseFloat(item.hold_amount)) + ' 股' : '-';
            const holdRatio = item.hold_ratio ? parseFloat(item.hold_ratio).toFixed(4) : '-';
            const holdChange = formatHoldChange(item.hold_change);
            const holderType = item.holder_type || '-';
            const annDate = formatDate(item.ann_date);
            output += `| ${rank} | ${holderName} | ${holdAmount} | ${holdRatio} | ${holdChange} | ${holderType} | ${annDate} |\n`;
        });
        output += '\n';
    }
    // 添加整体统计
    const uniqueHolders = new Set(data.map(item => item.holder_name)).size;
    const holderTypes = [...new Set(data.map(item => item.holder_type).filter(Boolean))];
    output += `### 📈 整体统计\n\n`;
    output += `- **涉及股东**: ${uniqueHolders} 个\n`;
    output += `- **股东类型**: ${holderTypes.join(', ')}\n`;
    output += `- **报告期数**: ${Object.keys(groupedByPeriod).length} 期\n\n`;
    return output;
}
// 格式化前十大流通股东数据
export function formatTop10FloatHolders(data) {
    if (!data || data.length === 0) {
        return 'ℹ️ 暂无前十大流通股东数据\n\n';
    }
    let output = '';
    // 按报告期分组
    const groupedByPeriod = data.reduce((acc, item) => {
        const endDate = item.end_date || '未知期间';
        if (!acc[endDate]) {
            acc[endDate] = [];
        }
        acc[endDate].push(item);
        return acc;
    }, {});
    // 按报告期排序（最新在前）
    const sortedPeriods = Object.keys(groupedByPeriod).sort((a, b) => {
        if (a === '未知期间')
            return 1;
        if (b === '未知期间')
            return -1;
        return b.localeCompare(a);
    });
    for (const period of sortedPeriods) {
        const items = groupedByPeriod[period];
        // 格式化报告期显示
        const formattedPeriod = period !== '未知期间' && period.length === 8
            ? `${period.substr(0, 4)}-${period.substr(4, 2)}-${period.substr(6, 2)}`
            : period;
        output += `### 🌊 报告期: ${formattedPeriod}\n\n`;
        // 计算该期间的汇总信息
        const totalShares = items.reduce((sum, item) => sum + (parseFloat(item.hold_amount) || 0), 0);
        const totalRatio = items.reduce((sum, item) => sum + (parseFloat(item.hold_ratio) || 0), 0);
        const totalFloatRatio = items.reduce((sum, item) => sum + (parseFloat(item.hold_float_ratio) || 0), 0);
        output += `**汇总信息:**\n`;
        output += `- 前十大流通股东持股总数: ${formatNumber(totalShares)} 股\n`;
        output += `- 占总股本比例: ${totalRatio.toFixed(2)}%\n`;
        output += `- 占流通股本比例: ${totalFloatRatio.toFixed(2)}%\n`;
        output += `- 股东数量: ${items.length} 个\n\n`;
        // 按持股数量排序（从多到少）
        const sortedItems = items.sort((a, b) => (parseFloat(b.hold_amount) || 0) - (parseFloat(a.hold_amount) || 0));
        output += `| 排名 | 股东名称 | 持股数量 | 占总股本(%) | 占流通股本(%) | 持股变动 | 股东类型 | 公告日期 |\n`;
        output += `|------|---------|---------|------------|-------------|---------|----------|----------|\n`;
        sortedItems.forEach((item, index) => {
            const rank = index + 1;
            const holderName = item.holder_name || '未知';
            const holdAmount = item.hold_amount ? formatNumber(parseFloat(item.hold_amount)) + ' 股' : '-';
            const holdRatio = item.hold_ratio ? parseFloat(item.hold_ratio).toFixed(4) : '-';
            const holdFloatRatio = item.hold_float_ratio ? parseFloat(item.hold_float_ratio).toFixed(4) : '-';
            const holdChange = formatHoldChange(item.hold_change);
            const holderType = item.holder_type || '-';
            const annDate = formatDate(item.ann_date);
            output += `| ${rank} | ${holderName} | ${holdAmount} | ${holdRatio} | ${holdFloatRatio} | ${holdChange} | ${holderType} | ${annDate} |\n`;
        });
        output += '\n';
    }
    // 添加整体统计
    const uniqueHolders = new Set(data.map(item => item.holder_name)).size;
    const holderTypes = [...new Set(data.map(item => item.holder_type).filter(Boolean))];
    output += `### 📈 整体统计\n\n`;
    output += `- **涉及流通股东**: ${uniqueHolders} 个\n`;
    output += `- **股东类型**: ${holderTypes.join(', ')}\n`;
    output += `- **报告期数**: ${Object.keys(groupedByPeriod).length} 期\n\n`;
    return output;
}
// 格式化持股变动显示
function formatHoldChange(change) {
    if (!change || change === 'None' || change === 'null' || change === null) {
        return '-';
    }
    const changeNum = parseFloat(change);
    if (isNaN(changeNum)) {
        return '-';
    }
    if (changeNum > 0) {
        return `+${formatNumber(changeNum)} 股`;
    }
    else if (changeNum < 0) {
        return `${formatNumber(changeNum)} 股`;
    }
    else {
        return '无变动';
    }
}
// 格式化日期显示
function formatDate(dateStr) {
    if (!dateStr || dateStr === 'None' || dateStr === 'null') {
        return '-';
    }
    if (dateStr.length === 8) {
        return `${dateStr.substr(0, 4)}-${dateStr.substr(4, 2)}-${dateStr.substr(6, 2)}`;
    }
    return dateStr;
}
// 格式化数字显示
function formatNumber(num) {
    if (num >= 100000000) {
        return (num / 100000000).toFixed(2) + '亿';
    }
    else if (num >= 10000) {
        return (num / 10000).toFixed(2) + '万';
    }
    else {
        return num.toLocaleString();
    }
}
//# sourceMappingURL=top10HoldersFormatters.js.map