// 财务审计意见格式化函数模块
// 用于处理上市公司财务审计意见数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 格式化财务审计意见数据
export function formatAudit(data) {
    if (!data || data.length === 0) {
        return `暂无数据\n\n`;
    }
    let output = '';
    // 按公告日期排序（最新的在前）
    const sortedData = data.sort((a, b) => (b.ann_date || '').localeCompare(a.ann_date || ''));
    // 创建表格头
    output += `| 公告日期 | 报告期 | 审计结果 | 审计费用(万元) | 会计事务所 | 签字会计师 |\n`;
    output += `|---------|--------|---------|-------------|----------|----------|\n`;
    // 添加数据行
    for (const item of sortedData) {
        const annDate = item.ann_date || 'N/A';
        const endDate = item.end_date || 'N/A';
        const auditResult = item.audit_result || 'N/A';
        const auditFees = item.audit_fees ? formatNumber(item.audit_fees / 10000) : 'N/A';
        const auditAgency = item.audit_agency || 'N/A';
        const auditSign = item.audit_sign || 'N/A';
        output += `| ${annDate} | ${endDate} | ${auditResult} | ${auditFees} | ${auditAgency} | ${auditSign} |\n`;
    }
    output += '\n';
    // 统计信息
    output += `📊 数据统计: 共 ${data.length} 条审计记录\n\n`;
    // 审计结果统计
    const auditResults = {};
    for (const item of data) {
        const result = item.audit_result || '未知';
        auditResults[result] = (auditResults[result] || 0) + 1;
    }
    if (Object.keys(auditResults).length > 0) {
        output += `### 📋 审计结果分布\n\n`;
        for (const [result, count] of Object.entries(auditResults)) {
            output += `- **${result}**: ${count} 次\n`;
        }
        output += '\n';
    }
    // 审计费用统计
    const feesData = data.filter(item => item.audit_fees && item.audit_fees > 0);
    if (feesData.length > 0) {
        const totalFees = feesData.reduce((sum, item) => sum + (item.audit_fees || 0), 0);
        const avgFees = totalFees / feesData.length;
        const maxFees = Math.max(...feesData.map(item => item.audit_fees || 0));
        const minFees = Math.min(...feesData.map(item => item.audit_fees || 0));
        output += `### 💰 审计费用统计\n\n`;
        output += `- **总计费用**: ${formatNumber(totalFees / 10000)} 万元\n`;
        output += `- **平均费用**: ${formatNumber(avgFees / 10000)} 万元\n`;
        output += `- **最高费用**: ${formatNumber(maxFees / 10000)} 万元\n`;
        output += `- **最低费用**: ${formatNumber(minFees / 10000)} 万元\n\n`;
    }
    // 会计事务所统计
    const agencies = {};
    for (const item of data) {
        const agency = item.audit_agency || '未知';
        agencies[agency] = (agencies[agency] || 0) + 1;
    }
    if (Object.keys(agencies).length > 0) {
        output += `### 🏢 会计事务所分布\n\n`;
        const sortedAgencies = Object.entries(agencies).sort((a, b) => b[1] - a[1]);
        for (const [agency, count] of sortedAgencies) {
            output += `- **${agency}**: ${count} 次\n`;
        }
        output += '\n';
    }
    return output;
}
//# sourceMappingURL=auditFormatters.js.map