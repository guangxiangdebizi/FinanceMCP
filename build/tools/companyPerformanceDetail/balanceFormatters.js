// 资产负债表数据格式化函数 - 简洁表格版本
// 格式化数字的辅助函数
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 辅助函数：获取报告类型描述
function getReportType(type) {
    const typeMap = {
        '1': '合并报表',
        '2': '单季合并',
        '6': '母公司报表'
    };
    return typeMap[type] || `类型${type}`;
}
// 辅助函数：获取公司类型描述
function getCompanyType(type) {
    const typeMap = {
        '1': '一般工商业',
        '2': '银行',
        '3': '保险',
        '4': '证券'
    };
    return typeMap[type] || `类型${type}`;
}
// 格式化核心资产负债表数据
export function formatBasicBalance(data) {
    if (!data || data.length === 0)
        return '暂无数据\n\n';
    let output = `| 报告期 | 资产总计 | 流动资产 | 非流动资产 | 负债合计 | 流动负债 | 非流动负债 | **股东权益** | **净资产** |\n`;
    output += `|--------|----------|----------|-----------|----------|----------|-----------|-------------|----------|\n`;
    for (const item of data) {
        const period = item.end_date || 'N/A';
        const totalAssets = formatNumber(item.total_assets);
        const curAssets = formatNumber(item.total_cur_assets);
        const ncaAssets = formatNumber(item.total_nca);
        const totalLiab = formatNumber(item.total_liab);
        const curLiab = formatNumber(item.total_cur_liab);
        const nclLiab = formatNumber(item.total_ncl);
        const equity = formatNumber(item.total_hldr_eqy_exc_min_int);
        const netAssets = formatNumber(item.total_hldr_eqy_exc_min_int);
        output += `| ${period} | ${totalAssets} | ${curAssets} | ${ncaAssets} | ${totalLiab} | ${curLiab} | ${nclLiab} | **${equity}** | **${netAssets}** |\n`;
    }
    output += `\n**💡 说明：** 单位：万元，报告类型：${getReportType(data[0]?.report_type || '1')}\n\n`;
    return output;
}
// 格式化完整资产负债表数据（智能过滤空列）
export function formatAllBalance(data) {
    if (!data || data.length === 0)
        return '暂无数据\n\n';
    // 定义不需要显示的系统字段
    const excludeFields = ['ts_code', 'ann_date', 'f_ann_date', 'comp_type', 'report_type', 'end_type', 'update_flag'];
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
    // 定义字段的中文名称映射
    const fieldNameMap = {
        'end_date': '报告期',
        'total_assets': '资产总计',
        'total_cur_assets': '流动资产合计',
        'total_nca': '非流动资产合计',
        'total_liab': '负债合计',
        'total_cur_liab': '流动负债合计',
        'total_ncl': '非流动负债合计',
        'total_hldr_eqy_exc_min_int': '股东权益合计',
        'total_hldr_eqy_inc_min_int': '所有者权益合计',
        'money_cap': '货币资金',
        'trad_asset': '交易性金融资产',
        'notes_receiv': '应收票据',
        'accounts_receiv': '应收账款',
        'oth_receiv': '其他应收款',
        'prepayment': '预付款项',
        'inventories': '存货',
        'fix_assets': '固定资产',
        'cip': '在建工程',
        'intan_assets': '无形资产',
        'goodwill': '商誉',
        'lt_eqt_invest': '长期股权投资',
        'invest_real_estate': '投资性房地产',
        'defer_tax_assets': '递延所得税资产',
        'short_loan': '短期借款',
        'trad_liab': '交易性金融负债',
        'notes_payable': '应付票据',
        'acct_payable': '应付账款',
        'payroll_payable': '应付职工薪酬',
        'taxes_payable': '应交税费',
        'int_payable': '应付利息',
        'div_payable': '应付股利',
        'oth_payable': '其他应付款',
        'bond_payable': '应付债券',
        'lt_payable': '长期应付款',
        'total_share': '股本',
        'cap_rese': '资本公积',
        'surplus_rese': '盈余公积',
        'undistr_porfit': '未分配利润',
        'special_rese': '专项储备',
        'treasury_share': '库存股',
        'minority_int': '少数股东权益',
        // 银行业务字段
        'cash_reser_cb': '向央行存款',
        'depos_in_oth_bfi': '存放同业',
        'loanto_oth_bank_fi': '拆出资金',
        'client_depos': '客户资金存款',
        'depos': '吸收存款',
        'loan_oth_bank': '拆入资金',
        'cb_borr': '向央行借款',
        // 保险业务字段
        'premium_receiv': '应收保费',
        'reinsur_receiv': '应收分保账款',
        'ph_pledge_loans': '保户质押贷款',
        'refund_cap_depos': '存出保证金',
        'rsrv_insur_cont': '保险合同准备金',
        'ph_invest': '保户储金及投资款',
        // 证券业务字段
        'client_prov': '客户备付金',
        'lending_funds': '融出资金',
        'transac_seat_fee': '交易席位费',
        'acting_trading_sec': '代理买卖证券款',
        'acting_uw_sec': '代理承销证券款'
    };
    let output = `**⚖️ 完整资产负债表数据（智能过滤）**\n\n`;
    // 将字段按类别分组
    const assetFields = fieldsWithData.filter(field => field.includes('asset') ||
        field.includes('receiv') ||
        field.includes('money_cap') ||
        field.includes('trad_asset') ||
        field.includes('inventories') ||
        field.includes('fix_') ||
        field.includes('invest') ||
        field.includes('intan_') ||
        field.includes('goodwill') ||
        field.includes('depos_in') ||
        field.includes('loanto_') ||
        field.includes('cash_reser') ||
        field.includes('premium_receiv') ||
        field.includes('ph_pledge') ||
        field.includes('refund_'));
    const liabilityFields = fieldsWithData.filter(field => field.includes('liab') ||
        field.includes('payable') ||
        field.includes('loan') ||
        field.includes('borr') ||
        field.includes('depos') && !field.includes('depos_in') ||
        field.includes('rsrv_') ||
        field.includes('ph_invest'));
    const equityFields = fieldsWithData.filter(field => field.includes('eqy') ||
        field.includes('share') ||
        field.includes('cap_rese') ||
        field.includes('surplus') ||
        field.includes('porfit') ||
        field.includes('minority'));
    // 其他重要字段（包括end_date）
    const otherFields = fieldsWithData.filter(field => !assetFields.includes(field) &&
        !liabilityFields.includes(field) &&
        !equityFields.includes(field));
    // 确保end_date排在第一位
    const sortedOtherFields = ['end_date', ...otherFields.filter(f => f !== 'end_date')];
    // 合并字段顺序：时间字段 + 资产字段 + 负债字段 + 权益字段
    const displayFields = [...sortedOtherFields, ...assetFields, ...liabilityFields, ...equityFields];
    // 如果字段太多，分批显示
    const maxFieldsPerTable = 8;
    const fieldGroups = [];
    for (let i = 0; i < displayFields.length; i += maxFieldsPerTable) {
        fieldGroups.push(displayFields.slice(i, i + maxFieldsPerTable));
    }
    // 生成表格
    fieldGroups.forEach((fields, groupIndex) => {
        if (groupIndex > 0) {
            output += `\n---\n\n`;
        }
        // 表头
        const headers = fields.map(field => fieldNameMap[field] || field);
        output += `| ${headers.join(' | ')} |\n`;
        output += `|${headers.map(() => '--------').join('|')}|\n`;
        // 数据行
        for (const item of data) {
            const values = fields.map(field => {
                if (field === 'end_date') {
                    return item[field] || 'N/A';
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
    output += `**💡 说明：** 单位：万元，已智能过滤全为空的字段，只显示有实际数据的项目\n\n`;
    return output;
}
//# sourceMappingURL=balanceFormatters.js.map