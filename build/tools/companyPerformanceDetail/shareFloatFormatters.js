// 限售股解禁数据格式化器
// 格式化限售股解禁数据
export function formatShareFloat(data) {
    if (!data || data.length === 0) {
        return 'ℹ️ 暂无限售股解禁数据\n\n';
    }
    let output = '';
    // 按解禁日期分组
    const groupedByDate = data.reduce((acc, item) => {
        const floatDate = item.float_date || '未知日期';
        if (!acc[floatDate]) {
            acc[floatDate] = [];
        }
        acc[floatDate].push(item);
        return acc;
    }, {});
    // 按解禁日期排序
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
        if (a === '未知日期')
            return 1;
        if (b === '未知日期')
            return -1;
        return b.localeCompare(a); // 最新日期在前
    });
    for (const floatDate of sortedDates) {
        const items = groupedByDate[floatDate];
        // 格式化解禁日期显示
        const formattedDate = floatDate !== '未知日期' && floatDate.length === 8
            ? `${floatDate.substr(0, 4)}-${floatDate.substr(4, 2)}-${floatDate.substr(6, 2)}`
            : floatDate;
        output += `### 🗓️ 解禁日期: ${formattedDate}\n\n`;
        // 计算该日期的汇总信息
        const totalShares = items.reduce((sum, item) => sum + (parseFloat(item.float_share) || 0), 0);
        const avgRatio = items.reduce((sum, item) => sum + (parseFloat(item.float_ratio) || 0), 0) / items.length;
        output += `**汇总信息:**\n`;
        output += `- 解禁总股数: ${formatNumber(totalShares)} 股\n`;
        output += `- 平均占比: ${avgRatio.toFixed(4)}%\n`;
        output += `- 解禁股东数: ${items.length} 个\n\n`;
        // 按解禁股份数量排序
        const sortedItems = items.sort((a, b) => (parseFloat(b.float_share) || 0) - (parseFloat(a.float_share) || 0));
        output += `| 股东名称 | 解禁股份(股) | 占总股本比率(%) | 股份类型 | 公告日期 |\n`;
        output += `|---------|-------------|----------------|----------|----------|\n`;
        for (const item of sortedItems) {
            const holderName = item.holder_name || '未知';
            const floatShare = formatNumber(parseFloat(item.float_share) || 0);
            const floatRatio = (parseFloat(item.float_ratio) || 0).toFixed(4);
            const shareType = item.share_type || '未知';
            const annDate = item.ann_date && item.ann_date.length === 8
                ? `${item.ann_date.substr(0, 4)}-${item.ann_date.substr(4, 2)}-${item.ann_date.substr(6, 2)}`
                : (item.ann_date || '未知');
            output += `| ${holderName} | ${floatShare} | ${floatRatio} | ${shareType} | ${annDate} |\n`;
        }
        output += '\n';
    }
    // 添加统计摘要
    const totalAllShares = data.reduce((sum, item) => sum + (parseFloat(item.float_share) || 0), 0);
    const uniqueHolders = new Set(data.map(item => item.holder_name)).size;
    const shareTypes = [...new Set(data.map(item => item.share_type).filter(Boolean))];
    output += `### 📈 整体统计\n\n`;
    output += `- **解禁总股数**: ${formatNumber(totalAllShares)} 股\n`;
    output += `- **涉及股东**: ${uniqueHolders} 个\n`;
    output += `- **股份类型**: ${shareTypes.join(', ')}\n`;
    output += `- **解禁批次**: ${Object.keys(groupedByDate).length} 批\n\n`;
    return output;
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
//# sourceMappingURL=shareFloatFormatters.js.map