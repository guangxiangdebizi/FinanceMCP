// 现金流量表详细格式化函数模块
// 用于处理不同类型的现金流数据展示
// 辅助函数：格式化数字
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const number = parseFloat(num);
    if (isNaN(number))
        return 'N/A';
    return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// 辅助函数：获取公司类型描述
function getCompanyType(type) {
    const types = {
        '1': '一般工商业',
        '2': '银行',
        '3': '保险',
        '4': '证券'
    };
    return types[type] || type;
}
// 基础现金流格式化
export function formatBasicCashFlow(data) {
    if (!data || data.length === 0)
        return '暂无数据\n\n';
    let output = `| 报告期 | 净利润 | 经营现金流 | 投资现金流 | 筹资现金流 | 自由现金流 | 现金净增加 | 期初现金 | 期末现金 | 汇率影响 |\n`;
    output += `|--------|--------|-----------|-----------|-----------|-----------|-----------|----------|----------|----------|\n`;
    for (const item of data) {
        const period = item.end_date || item.period || 'N/A';
        const netProfit = formatNumber(item.net_profit);
        const operatingCF = formatNumber(item.n_cashflow_act);
        const investingCF = formatNumber(item.n_cashflow_inv_act);
        const financingCF = formatNumber(item.n_cash_flows_fnc_act);
        const freeCF = formatNumber(item.free_cashflow);
        const netIncrease = formatNumber(item.n_incr_cash_cash_equ);
        const beginCash = formatNumber(item.c_cash_equ_beg_period);
        const endCash = formatNumber(item.c_cash_equ_end_period);
        const fxEffect = formatNumber(item.eff_fx_flu_cash);
        output += `| ${period} | ${netProfit} | ${operatingCF} | ${investingCF} | ${financingCF} | ${freeCF} | ${netIncrease} | ${beginCash} | ${endCash} | ${fxEffect} |\n`;
    }
    output += '\n**💡 说明：** 单位：万元，公司类型：' + getCompanyType(data[0]?.comp_type || '1') + '\n\n';
    return output;
}
// 全部现金流数据格式化（智能过滤空列）
export function formatCashflowAll(data) {
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
        'net_profit': '净利润',
        'finan_exp': '财务费用',
        'c_fr_sale_sg': '销售商品收现',
        'recp_tax_rends': '收到税费返还',
        'n_depos_incr_fi': '客户存款净增加',
        'n_incr_loans_cb': '向央行借款净增加',
        'n_inc_borr_oth_fi': '向其他金融机构拆入净增加',
        'prem_fr_orig_contr': '收到原保险合同保费',
        'n_incr_insured_dep': '保户储金净增加',
        'n_reinsur_prem': '收到再保业务现金',
        'n_incr_disp_tfa': '处置交易性金融资产净增加',
        'ifc_cash_incr': '拆入资金净增加',
        'n_incr_disp_faas': '回购业务资金净增加',
        'n_incr_loans_oth_bank': '拆出资金净增加',
        'n_cap_incr_repur': '代理买卖证券收到现金净额',
        'c_fr_oth_operate_a': '收到其他经营活动现金',
        'c_inf_fr_operate_a': '经营活动现金流入小计',
        'c_paid_goods_s': '购买商品支付现金',
        'c_paid_to_for_empl': '支付给职工现金',
        'c_paid_for_taxes': '支付各项税费',
        'n_incr_clt_loan_adv': '客户贷款及垫款净增加',
        'n_incr_dep_cbob': '存放央行和同业款项净增加',
        'c_pay_claims_orig_inco': '支付原保险合同赔付款',
        'pay_handling_chrg': '支付手续费及佣金',
        'pay_comm_insur_plcy': '支付保单红利',
        'oth_cash_pay_oper_act': '支付其他经营活动现金',
        'st_cash_out_act': '经营活动现金流出小计',
        'n_cashflow_act': '经营活动产生现金流量净额',
        'oth_recp_ral_inv_act': '收到其他投资活动现金',
        'c_disp_withdrwl_invest': '收回投资收到现金',
        'c_recp_return_invest': '取得投资收益收到现金',
        'n_recp_disp_fiolta': '处置固定资产收到现金',
        'n_recp_disp_sobu': '处置子公司收到现金',
        'stot_inflows_inv_act': '投资活动现金流入小计',
        'c_pay_acq_const_fiolta': '购建固定资产支付现金',
        'c_paid_invest': '投资支付现金',
        'n_disp_subs_oth_biz': '取得子公司支付现金',
        'oth_pay_ral_inv_act': '支付其他投资活动现金',
        'n_incr_pledge_loan': '质押贷款净增加',
        'stot_out_inv_act': '投资活动现金流出小计',
        'n_cashflow_inv_act': '投资活动产生现金流量净额',
        'c_recp_borrow': '取得借款收到现金',
        'proc_issue_bonds': '发行债券收到现金',
        'oth_cash_recp_ral_fnc_act': '收到其他筹资活动现金',
        'stot_cash_in_fnc_act': '筹资活动现金流入小计',
        'free_cashflow': '企业自由现金流量',
        'c_prepay_amt_borr': '偿还债务支付现金',
        'c_pay_dist_dpcp_int_exp': '分配股利利润支付现金',
        'incl_dvd_profit_paid_sc_ms': '其中子公司支付股利',
        'oth_cashpay_ral_fnc_act': '支付其他筹资活动现金',
        'stot_cashout_fnc_act': '筹资活动现金流出小计',
        'n_cash_flows_fnc_act': '筹资活动产生现金流量净额',
        'eff_fx_flu_cash': '汇率变动对现金影响',
        'n_incr_cash_cash_equ': '现金及现金等价物净增加',
        'c_cash_equ_beg_period': '期初现金及现金等价物',
        'c_cash_equ_end_period': '期末现金及现金等价物',
        'c_recp_cap_contrib': '吸收投资收到现金',
        'incl_cash_rec_saims': '其中子公司吸收少数股东投资',
        'uncon_invest_loss': '未确认投资损失',
        'prov_depr_assets': '资产减值准备',
        'depr_fa_coga_dpba': '固定资产折旧',
        'amort_intang_assets': '无形资产摊销',
        'lt_amort_deferred_exp': '长期待摊费用摊销',
        'decr_deferred_exp': '待摊费用减少',
        'incr_acc_exp': '预提费用增加',
        'loss_disp_fiolta': '处置固定资产损失',
        'loss_scr_fa': '固定资产报废损失',
        'loss_fv_chg': '公允价值变动损失',
        'invest_loss': '投资损失',
        'decr_def_inc_tax_assets': '递延所得税资产减少',
        'incr_def_inc_tax_liab': '递延所得税负债增加',
        'decr_inventories': '存货减少',
        'decr_oper_payable': '经营性应收项目减少',
        'incr_oper_payable': '经营性应付项目增加',
        'others': '其他',
        'im_net_cashflow_oper_act': '经营活动现金流量净额(间接法)',
        'conv_debt_into_cap': '债务转为资本',
        'conv_copbonds_due_within_1y': '一年内到期可转换公司债券',
        'fa_fnc_leases': '融资租入固定资产',
        'end_bal_cash': '现金期末余额',
        'beg_bal_cash': '现金期初余额',
        'end_bal_cash_equ': '现金等价物期末余额',
        'beg_bal_cash_equ': '现金等价物期初余额',
        'im_n_incr_cash_equ': '现金及现金等价物净增加(间接法)'
    };
    let output = `**💰 完整现金流量表数据（智能过滤）**\n\n`;
    // 将字段按类别分组
    const operatingFields = fieldsWithData.filter(field => field.includes('operate') ||
        field.includes('sale') ||
        field.includes('tax') ||
        field.includes('empl') ||
        field.includes('n_cashflow_act') ||
        field.includes('c_fr_') ||
        field.includes('c_paid_') ||
        field.includes('recp_') ||
        field.includes('pay_') ||
        field.includes('net_profit'));
    const investingFields = fieldsWithData.filter(field => field.includes('invest') ||
        field.includes('disp_') ||
        field.includes('acq_') ||
        field.includes('n_cashflow_inv') ||
        field.includes('fiolta') ||
        field.includes('sobu'));
    const financingFields = fieldsWithData.filter(field => field.includes('fnc_') ||
        field.includes('borrow') ||
        field.includes('bond') ||
        field.includes('cap_contrib') ||
        field.includes('dist_') ||
        field.includes('n_cash_flows_fnc'));
    const cashFields = fieldsWithData.filter(field => field.includes('cash') ||
        field.includes('equ') ||
        field.includes('incr_cash') ||
        field.includes('free_cashflow') ||
        field.includes('eff_fx'));
    // 其他字段（包括end_date）
    const otherFields = fieldsWithData.filter(field => !operatingFields.includes(field) &&
        !investingFields.includes(field) &&
        !financingFields.includes(field) &&
        !cashFields.includes(field));
    // 确保end_date排在第一位
    const sortedOtherFields = ['end_date', ...otherFields.filter(f => f !== 'end_date')];
    // 合并字段顺序：时间字段 + 经营字段 + 投资字段 + 筹资字段 + 现金字段
    const displayFields = [...sortedOtherFields, ...operatingFields, ...investingFields, ...financingFields, ...cashFields];
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
//# sourceMappingURL=cashflowFormatters.js.map