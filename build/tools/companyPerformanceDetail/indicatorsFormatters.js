// 财务指标详细格式化函数模块
// 用于处理不同类型的财务指标数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
// 辅助函数：格式化百分比
function formatPercent(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toFixed(2) + '%';
}
// 财务指标格式化（智能过滤空列）
export function formatIndicators(data) {
    if (!data || data.length === 0)
        return '暂无数据\n\n';
    // 定义不需要显示的系统字段
    const excludeFields = ['ts_code', 'ann_date', 'update_flag'];
    // 获取所有可能的字段
    const allFields = Object.keys(data[0] || {});
    // 智能过滤：检查每个字段是否在所有数据行中都为空
    const fieldsWithData = allFields.filter(field => {
        // 跳过系统字段
        if (excludeFields.includes(field))
            return false;
        // 检查该字段是否在任何一行中有有效数据
        return data.some(item => {
            const value = item[field];
            return value !== null &&
                value !== undefined &&
                value !== '' &&
                value !== 0;
        });
    });
    // 定义字段的中文名称映射和分类
    const fieldNameMap = {
        'end_date': '报告期',
        'eps': '基本每股收益',
        'dt_eps': '稀释每股收益',
        'total_revenue_ps': '每股营业总收入',
        'revenue_ps': '每股营业收入',
        'capital_rese_ps': '每股资本公积',
        'surplus_rese_ps': '每股盈余公积',
        'undist_profit_ps': '每股未分配利润',
        'extra_item': '非经常性损益',
        'profit_dedt': '扣非净利润',
        'gross_margin': '毛利',
        'current_ratio': '流动比率',
        'quick_ratio': '速动比率',
        'cash_ratio': '保守速动比率',
        'invturn_days': '存货周转天数',
        'arturn_days': '应收账款周转天数',
        'inv_turn': '存货周转率',
        'ar_turn': '应收账款周转率',
        'ca_turn': '流动资产周转率',
        'fa_turn': '固定资产周转率',
        'assets_turn': '总资产周转率',
        'op_income': '经营活动净收益',
        'valuechange_income': '价值变动净收益',
        'interst_income': '利息费用',
        'daa': '折旧与摊销',
        'ebit': '息税前利润',
        'ebitda': '息税折旧摊销前利润',
        'fcff': '企业自由现金流量',
        'fcfe': '股权自由现金流量',
        'current_exint': '无息流动负债',
        'noncurrent_exint': '无息非流动负债',
        'interestdebt': '带息债务',
        'netdebt': '净债务',
        'tangible_asset': '有形资产',
        'working_capital': '营运资金',
        'networking_capital': '营运流动资本',
        'invest_capital': '全部投入资本',
        'retained_earnings': '留存收益',
        'diluted2_eps': '期末摊薄每股收益',
        'bps': '每股净资产',
        'ocfps': '每股经营现金流',
        'retainedps': '每股留存收益',
        'cfps': '每股现金流量净额',
        'ebit_ps': '每股息税前利润',
        'fcff_ps': '每股企业自由现金流',
        'fcfe_ps': '每股股东自由现金流',
        'netprofit_margin': '销售净利率',
        'grossprofit_margin': '销售毛利率',
        'cogs_of_sales': '销售成本率',
        'expense_of_sales': '销售期间费用率',
        'profit_to_gr': '净利润/营业总收入',
        'saleexp_to_gr': '销售费用/营业总收入',
        'adminexp_of_gr': '管理费用/营业总收入',
        'finaexp_of_gr': '财务费用/营业总收入',
        'impai_ttm': '资产减值损失/营业总收入',
        'gc_of_gr': '营业总成本/营业总收入',
        'op_of_gr': '营业利润/营业总收入',
        'ebit_of_gr': '息税前利润/营业总收入',
        'roe': '净资产收益率',
        'roe_waa': '加权平均净资产收益率',
        'roe_dt': '净资产收益率(扣非)',
        'roa': '总资产报酬率',
        'npta': '总资产净利润',
        'roic': '投入资本回报率',
        'roe_yearly': '年化净资产收益率',
        'roa2_yearly': '年化总资产报酬率',
        'roe_avg': '平均净资产收益率',
        'debt_to_assets': '资产负债率',
        'assets_to_eqt': '权益乘数',
        'dp_assets_to_eqt': '权益乘数(杜邦)',
        'ca_to_assets': '流动资产/总资产',
        'nca_to_assets': '非流动资产/总资产',
        'tbassets_to_totalassets': '有形资产/总资产',
        'int_to_talcap': '带息债务/全部投入资本',
        'eqt_to_talcapital': '股东权益/全部投入资本',
        'currentdebt_to_debt': '流动负债/负债合计',
        'longdeb_to_debt': '非流动负债/负债合计',
        'ocf_to_shortdebt': '经营现金流/流动负债',
        'debt_to_eqt': '产权比率',
        'eqt_to_debt': '股东权益/负债合计',
        'eqt_to_interestdebt': '股东权益/带息债务',
        'tangibleasset_to_debt': '有形资产/负债合计',
        'tangasset_to_intdebt': '有形资产/带息债务',
        'tangibleasset_to_netdebt': '有形资产/净债务',
        'ocf_to_debt': '经营现金流/负债合计',
        'turn_days': '营业周期',
        'roa_yearly': '年化总资产净利率',
        'roa_dp': '总资产净利率(杜邦)',
        'fixed_assets': '固定资产合计',
        'profit_to_op': '利润总额/营业收入',
        'basic_eps_yoy': '每股收益同比增长率',
        'dt_eps_yoy': '稀释每股收益同比增长率',
        'cfps_yoy': '每股现金流同比增长率',
        'op_yoy': '营业利润同比增长率',
        'ebt_yoy': '利润总额同比增长率',
        'netprofit_yoy': '净利润同比增长率',
        'dt_netprofit_yoy': '扣非净利润同比增长率',
        'ocf_yoy': '经营现金流同比增长率',
        'roe_yoy': '净资产收益率同比增长率',
        'bps_yoy': '每股净资产增长率',
        'assets_yoy': '资产总计增长率',
        'eqt_yoy': '股东权益增长率',
        'tr_yoy': '营业总收入同比增长率',
        'or_yoy': '营业收入同比增长率',
        'equity_yoy': '净资产同比增长率',
        'rd_exp': '研发费用'
    };
    let output = `**📊 财务指标数据（智能过滤）**\n\n`;
    // 将字段按类别分组
    const profitabilityFields = fieldsWithData.filter(field => field.includes('eps') ||
        field.includes('roe') ||
        field.includes('roa') ||
        field.includes('margin') ||
        field.includes('profit') ||
        field.includes('roic') ||
        field.includes('ebit'));
    const solvencyFields = fieldsWithData.filter(field => field.includes('ratio') ||
        field.includes('debt') ||
        field.includes('eqt') ||
        field.includes('assets_to') ||
        field.includes('current_') ||
        field.includes('quick_') ||
        field.includes('cash_'));
    const operatingFields = fieldsWithData.filter(field => field.includes('turn') ||
        field.includes('days') ||
        field.includes('working') ||
        field.includes('capital') ||
        field.includes('_ps') && !field.includes('eps'));
    const growthFields = fieldsWithData.filter(field => field.includes('yoy') ||
        field.includes('yearly') ||
        field.includes('growth'));
    const cashflowFields = fieldsWithData.filter(field => field.includes('ocf') ||
        field.includes('fcf') ||
        field.includes('cash') ||
        field.includes('cfps'));
    // 其他字段（包括end_date）
    const otherFields = fieldsWithData.filter(field => !profitabilityFields.includes(field) &&
        !solvencyFields.includes(field) &&
        !operatingFields.includes(field) &&
        !growthFields.includes(field) &&
        !cashflowFields.includes(field));
    // 确保end_date排在第一位
    const sortedOtherFields = ['end_date', ...otherFields.filter(f => f !== 'end_date')];
    // 合并字段顺序：时间字段 + 盈利能力 + 偿债能力 + 营运能力 + 成长能力 + 现金流
    const displayFields = [...sortedOtherFields, ...profitabilityFields, ...solvencyFields, ...operatingFields, ...growthFields, ...cashflowFields];
    // 如果字段太多，分批显示
    const maxFieldsPerTable = 7; // 调整为7个字段一组，与现金流保持类似
    const fieldGroups = [];
    for (let i = 0; i < displayFields.length; i += maxFieldsPerTable) {
        fieldGroups.push(displayFields.slice(i, i + maxFieldsPerTable));
    }
    // 生成表格 - 每行是一个报告期，每列是一个指标
    fieldGroups.forEach((fields, groupIndex) => {
        if (groupIndex > 0) {
            output += `\n---\n\n`;
        }
        // 表头
        const headers = fields.map(field => fieldNameMap[field] || field);
        output += `| ${headers.join(' | ')} |\n`;
        output += `|${headers.map(() => '--------').join('|')}|\n`;
        // 数据行 - 每行是一个报告期
        for (const item of data) {
            const values = fields.map(field => {
                if (field === 'end_date') {
                    return item[field] || 'N/A';
                }
                // 对于百分比字段，使用百分比格式
                if (field.includes('margin') || field.includes('ratio') || field.includes('yoy') ||
                    field.includes('roe') || field.includes('roa') || field.includes('_to_') ||
                    field.includes('debt_to') || field.includes('assets_to')) {
                    return formatPercent(item[field]);
                }
                return formatNumber(item[field]);
            });
            output += `| ${values.join(' | ')} |\n`;
        }
    });
    // 统计信息
    output += `\n**📊 数据统计：**\n`;
    output += `- 原始字段总数：${allFields.length}\n`;
    output += `- 有效数据字段：${fieldsWithData.length}\n`;
    output += `- 过滤空字段数：${allFields.length - fieldsWithData.length - excludeFields.length}\n`;
    output += `- 报告期数量：${data.length}\n\n`;
    // 字段分类统计
    output += `**📈 字段分类统计：**\n`;
    output += `- 盈利能力指标：${profitabilityFields.length} 个\n`;
    output += `- 偿债能力指标：${solvencyFields.length} 个\n`;
    output += `- 营运能力指标：${operatingFields.length} 个\n`;
    output += `- 成长能力指标：${growthFields.length} 个\n`;
    output += `- 现金流指标：${cashflowFields.length} 个\n`;
    output += `- 其他指标：${sortedOtherFields.length} 个\n\n`;
    output += `**💡 说明：** 已智能过滤全为空的字段，只显示有实际数据的财务指标项目\n\n`;
    return output;
}
//# sourceMappingURL=indicatorsFormatters.js.map