// 股东数据格式化函数模块
// 用于处理股东人数和股东增减持数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 辅助函数：获取股东类型描述
function getHolderType(type) {
    const typeMap = {
        'G': '👤 高管',
        'P': '👤 个人',
        'C': '🏢 公司'
    };
    return typeMap[type] || type;
}
// 格式化股东人数数据
export function formatHolderNumber(data) {
    if (!data || data.length === 0) {
        return `暂无数据\n\n`;
    }
    let output = '';
    // 按公告日期排序（最新的在前）
    const sortedData = data.sort((a, b) => (b.ann_date || '').localeCompare(a.ann_date || ''));
    // 创建表格头
    output += `| 公告日期 | 截止日期 | 股东户数(户) |\n`;
    output += `|---------|---------|------------|\n`;
    // 添加数据行
    for (const item of sortedData) {
        const annDate = item.ann_date || 'N/A';
        const endDate = item.end_date || 'N/A';
        const holderNum = item.holder_num ? formatNumber(item.holder_num) : 'N/A';
        output += `| ${annDate} | ${endDate} | ${holderNum} |\n`;
    }
    output += '\n';
    output += `📊 数据统计: 共 ${data.length} 条记录\n\n`;
    return output;
}
// 格式化股东增减持数据
export function formatHolderTrade(data) {
    if (!data || data.length === 0) {
        return `暂无数据\n\n`;
    }
    let output = '';
    // 按公告日期排序（最新的在前）
    const sortedData = data.sort((a, b) => (b.ann_date || '').localeCompare(a.ann_date || ''));
    // 分类统计
    const increaseData = sortedData.filter(item => item.in_de === 'IN');
    const decreaseData = sortedData.filter(item => item.in_de === 'DE');
    output += `📊 增减持概况: 增持 ${increaseData.length} 条，减持 ${decreaseData.length} 条\n\n`;
    // 创建详细表格
    output += `| 公告日期 | 股东名称 | 股东类型 | 增减持 | 变动数量(万股) | 变动比例(%) | 变动后持股(万股) | 变动后比例(%) | 均价(元) |\n`;
    output += `|---------|---------|---------|--------|-------------|-----------|-------------|-------------|--------|\n`;
    // 添加数据行
    for (const item of sortedData) {
        const annDate = item.ann_date || 'N/A';
        const holderName = item.holder_name || 'N/A';
        const holderType = getHolderType(item.holder_type);
        const inDe = item.in_de === 'IN' ? '🔼 增持' : '🔽 减持';
        const changeVol = item.change_vol ? formatNumber(item.change_vol / 10000) : 'N/A';
        const changeRatio = item.change_ratio ? item.change_ratio.toFixed(4) : 'N/A';
        const afterShare = item.after_share ? formatNumber(item.after_share / 10000) : 'N/A';
        const afterRatio = item.after_ratio ? item.after_ratio.toFixed(4) : 'N/A';
        const avgPrice = item.avg_price ? item.avg_price.toFixed(2) : 'N/A';
        output += `| ${annDate} | ${holderName} | ${holderType} | ${inDe} | ${changeVol} | ${changeRatio} | ${afterShare} | ${afterRatio} | ${avgPrice} |\n`;
    }
    output += '\n';
    // 增减持统计
    if (increaseData.length > 0) {
        output += `### 🔼 增持统计\n\n`;
        const totalIncreaseVol = increaseData.reduce((sum, item) => sum + (item.change_vol || 0), 0);
        output += `- 增持次数: ${increaseData.length} 次\n`;
        output += `- 累计增持数量: ${formatNumber(totalIncreaseVol / 10000)} 万股\n\n`;
    }
    if (decreaseData.length > 0) {
        output += `### 🔽 减持统计\n\n`;
        const totalDecreaseVol = decreaseData.reduce((sum, item) => sum + (item.change_vol || 0), 0);
        output += `- 减持次数: ${decreaseData.length} 次\n`;
        output += `- 累计减持数量: ${formatNumber(totalDecreaseVol / 10000)} 万股\n\n`;
    }
    return output;
}
//# sourceMappingURL=holderFormatters.js.map