// 股权质押数据格式化器
// 格式化股权质押统计数据
export function formatPledgeStat(data) {
    if (!data || data.length === 0) {
        return 'ℹ️ 暂无股权质押统计数据\n\n';
    }
    let output = '';
    // 按截止日期排序（最新在前）
    const sortedData = data.sort((a, b) => {
        const dateA = a.end_date || '00000000';
        const dateB = b.end_date || '00000000';
        return dateB.localeCompare(dateA);
    });
    // 最新数据概览
    const latestData = sortedData[0];
    output += `### 📊 最新质押概况\n\n`;
    output += `**截止日期**: ${formatDate(latestData.end_date)}\n`;
    output += `**质押次数**: ${latestData.pledge_count || 0} 次\n`;
    output += `**质押比例**: ${(parseFloat(latestData.pledge_ratio) || 0).toFixed(2)}%\n`;
    output += `**总股本**: ${formatNumber((parseFloat(latestData.total_share) || 0) * 10000)} 股\n\n`;
    const unrestPledge = parseFloat(latestData.unrest_pledge) || 0;
    const restPledge = parseFloat(latestData.rest_pledge) || 0;
    const totalPledge = unrestPledge + restPledge;
    output += `**质押股份详情**:\n`;
    output += `- 无限售股质押: ${formatNumber(unrestPledge * 10000)} 股\n`;
    output += `- 限售股质押: ${formatNumber(restPledge * 10000)} 股\n`;
    output += `- 质押股份合计: ${formatNumber(totalPledge * 10000)} 股\n\n`;
    // 历史趋势分析
    output += `### 📈 质押趋势分析\n\n`;
    // 计算统计指标
    const pledgeRatios = sortedData.map(item => parseFloat(item.pledge_ratio) || 0);
    const pledgeCounts = sortedData.map(item => parseInt(item.pledge_count) || 0);
    const maxRatio = Math.max(...pledgeRatios);
    const minRatio = Math.min(...pledgeRatios);
    const avgRatio = pledgeRatios.reduce((sum, ratio) => sum + ratio, 0) / pledgeRatios.length;
    const maxCount = Math.max(...pledgeCounts);
    const minCount = Math.min(...pledgeCounts);
    const avgCount = pledgeCounts.reduce((sum, count) => sum + count, 0) / pledgeCounts.length;
    output += `**质押比例统计**:\n`;
    output += `- 最高质押比例: ${maxRatio.toFixed(2)}%\n`;
    output += `- 最低质押比例: ${minRatio.toFixed(2)}%\n`;
    output += `- 平均质押比例: ${avgRatio.toFixed(2)}%\n\n`;
    output += `**质押次数统计**:\n`;
    output += `- 最多质押次数: ${maxCount} 次\n`;
    output += `- 最少质押次数: ${minCount} 次\n`;
    output += `- 平均质押次数: ${avgCount.toFixed(1)} 次\n\n`;
    // 详细历史记录表格
    output += `### 📋 历史质押记录\n\n`;
    output += `| 截止日期 | 质押次数 | 质押比例(%) | 无限售股质押 | 限售股质押 | 总股本 |\n`;
    output += `|---------|---------|------------|------------|----------|--------|\n`;
    for (const item of sortedData.slice(0, 15)) { // 显示最近15条记录
        const endDate = formatDate(item.end_date);
        const pledgeCount = item.pledge_count || 0;
        const pledgeRatio = (parseFloat(item.pledge_ratio) || 0).toFixed(2);
        const unrestPledge = formatNumber((parseFloat(item.unrest_pledge) || 0) * 10000) + ' 股';
        const restPledge = formatNumber((parseFloat(item.rest_pledge) || 0) * 10000) + ' 股';
        const totalShare = formatNumber((parseFloat(item.total_share) || 0) * 10000) + ' 股';
        output += `| ${endDate} | ${pledgeCount} | ${pledgeRatio} | ${unrestPledge} | ${restPledge} | ${totalShare} |\n`;
    }
    if (sortedData.length > 15) {
        output += `\n*注: 仅显示最近15条记录，共${sortedData.length}条记录*\n`;
    }
    // 风险评估
    output += `\n### ⚠️ 质押风险评估\n\n`;
    const currentRatio = parseFloat(latestData.pledge_ratio) || 0;
    let riskLevel = '';
    let riskColor = '';
    if (currentRatio >= 50) {
        riskLevel = '高风险';
        riskColor = '🔴';
    }
    else if (currentRatio >= 30) {
        riskLevel = '中等风险';
        riskColor = '🟡';
    }
    else if (currentRatio >= 10) {
        riskLevel = '低风险';
        riskColor = '🟢';
    }
    else {
        riskLevel = '风险极低';
        riskColor = '🟢';
    }
    output += `**当前风险等级**: ${riskColor} ${riskLevel}\n`;
    output += `**风险说明**: `;
    if (currentRatio >= 50) {
        output += `质押比例超过50%，存在较高的强制平仓风险，需密切关注股价变动\n`;
    }
    else if (currentRatio >= 30) {
        output += `质押比例在30%-50%之间，存在一定风险，建议关注质押相关公告\n`;
    }
    else if (currentRatio >= 10) {
        output += `质押比例在10%-30%之间，风险相对较低，属于正常水平\n`;
    }
    else {
        output += `质押比例较低，风险很小，对股价影响有限\n`;
    }
    output += '\n';
    return output;
}
// 格式化股权质押明细数据
export function formatPledgeDetail(data) {
    if (!data || data.length === 0) {
        return 'ℹ️ 暂无股权质押明细数据\n\n';
    }
    let output = '';
    // 按公告日期排序（最新在前）
    const sortedData = data.sort((a, b) => {
        const dateA = a.ann_date || '00000000';
        const dateB = b.ann_date || '00000000';
        return dateB.localeCompare(dateA);
    });
    // 统计概览
    output += `### 📊 质押明细概览\n\n`;
    // 统计未解押和已解押的记录
    const unreleased = sortedData.filter(item => item.is_release !== 'Y' && item.is_release !== '是');
    const released = sortedData.filter(item => item.is_release === 'Y' || item.is_release === '是');
    output += `**质押状态统计**:\n`;
    output += `- 总质押记录: ${sortedData.length} 条\n`;
    output += `- 未解押记录: ${unreleased.length} 条\n`;
    output += `- 已解押记录: ${released.length} 条\n\n`;
    // 按股东分组统计
    const holderStats = new Map();
    sortedData.forEach(item => {
        const holderName = item.holder_name || '未知股东';
        if (!holderStats.has(holderName)) {
            holderStats.set(holderName, {
                totalPledge: 0,
                totalHolding: parseFloat(item.holding_amount) || 0,
                count: 0,
                unreleased: 0
            });
        }
        const stats = holderStats.get(holderName);
        stats.totalPledge += parseFloat(item.pledge_amount) || 0;
        stats.count++;
        if (item.is_release !== 'Y' && item.is_release !== '是') {
            stats.unreleased++;
        }
    });
    // 股东质押排名
    output += `### 👥 主要质押股东\n\n`;
    output += `| 股东名称 | 质押次数 | 未解押次数 | 累计质押数量 | 持股总数 | 质押比例(%) |\n`;
    output += `|---------|---------|-----------|------------|---------|------------|\n`;
    const sortedHolders = Array.from(holderStats.entries())
        .sort((a, b) => b[1].totalPledge - a[1].totalPledge)
        .slice(0, 10);
    for (const [holderName, stats] of sortedHolders) {
        const pledgeRatio = stats.totalHolding > 0
            ? ((stats.totalPledge / stats.totalHolding) * 100).toFixed(2)
            : '-';
        output += `| ${holderName} | ${stats.count} | ${stats.unreleased} | ${formatNumber(stats.totalPledge * 10000)} 股 | ${formatNumber(stats.totalHolding * 10000)} 股 | ${pledgeRatio} |\n`;
    }
    output += '\n';
    // 未解押的质押明细
    if (unreleased.length > 0) {
        output += `### 🔒 未解押质押明细（最新${Math.min(10, unreleased.length)}条）\n\n`;
        output += `| 公告日期 | 股东名称 | 质押数量 | 质押开始 | 质押结束 | 占总股本(%) | 质押方 |\n`;
        output += `|---------|---------|---------|---------|---------|------------|--------|\n`;
        for (const item of unreleased.slice(0, 10)) {
            const annDate = formatDate(item.ann_date);
            const holderName = item.holder_name || '未知';
            const pledgeAmount = formatNumber((parseFloat(item.pledge_amount) || 0) * 10000) + ' 股';
            const startDate = formatDate(item.start_date);
            const endDate = formatDate(item.end_date);
            const totalRatio = (parseFloat(item.p_total_ratio) || 0).toFixed(4);
            const pledgor = item.pledgor || '-';
            output += `| ${annDate} | ${holderName} | ${pledgeAmount} | ${startDate} | ${endDate} | ${totalRatio} | ${pledgor} |\n`;
        }
        if (unreleased.length > 10) {
            output += `\n*注: 共${unreleased.length}条未解押记录，仅显示最新10条*\n`;
        }
    }
    output += '\n';
    // 最近解押的质押明细
    const recentReleased = released.filter(item => item.release_date).slice(0, 5);
    if (recentReleased.length > 0) {
        output += `### 🔓 最近解押记录\n\n`;
        output += `| 解押日期 | 股东名称 | 质押数量 | 质押期间 | 质押方 |\n`;
        output += `|---------|---------|---------|---------|--------|\n`;
        for (const item of recentReleased) {
            const releaseDate = formatDate(item.release_date);
            const holderName = item.holder_name || '未知';
            const pledgeAmount = formatNumber((parseFloat(item.pledge_amount) || 0) * 10000) + ' 股';
            const period = `${formatDate(item.start_date)} 至 ${formatDate(item.end_date)}`;
            const pledgor = item.pledgor || '-';
            output += `| ${releaseDate} | ${holderName} | ${pledgeAmount} | ${period} | ${pledgor} |\n`;
        }
    }
    output += '\n';
    return output;
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
//# sourceMappingURL=pledgeFormatters.js.map