// 利润表数据格式化函数 - 简洁表格版本
// 格式化数字的辅助函数
function formatNumber(num: any): string {
  if (num === null || num === undefined || num === '') return 'N/A';
  const number = parseFloat(num);
  if (isNaN(number)) return 'N/A';
  return (number / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 辅助函数：获取报告类型描述
function getReportType(type: string): string {
  const typeMap: Record<string, string> = {
    '1': '合并报表',
    '2': '单季合并',
    '6': '母公司报表'
  };
  return typeMap[type] || `类型${type}`;
}

// 辅助函数：获取公司类型描述
function getCompanyType(type: string): string {
  const typeMap: Record<string, string> = {
    '1': '一般工商业',
    '2': '银行',
    '3': '保险',
    '4': '证券'
  };
  return typeMap[type] || `类型${type}`;
}

// 1. 格式化核心利润表数据
export function formatBasicIncome(data: any[]): string {
  if (!data || data.length === 0) return '暂无数据\n\n';
  
  let output = `| 报告期 | 基本EPS | 稀释EPS | 营业收入 | 营业成本 | 营业利润 | 利润总额 | 所得税 | **净利润** | **归母净利润** | EBIT | EBITDA |\n`;
  output += `|--------|---------|---------|----------|----------|----------|----------|--------|-----------|-------------|------|--------|\n`;
  
  for (const item of data) {
    const period = item.end_date || 'N/A';
    const basicEps = item.basic_eps ? item.basic_eps.toFixed(4) : 'N/A';
    const dilutedEps = item.diluted_eps ? item.diluted_eps.toFixed(4) : 'N/A';
    const revenue = formatNumber(item.revenue);
    const operCost = formatNumber(item.oper_cost);
    const operProfit = formatNumber(item.operate_profit);
    const totalProfit = formatNumber(item.total_profit);
    const incomeTax = formatNumber(item.income_tax);
    const nIncome = formatNumber(item.n_income);
    const nIncomeAttrP = formatNumber(item.n_income_attr_p);
    const ebit = formatNumber(item.ebit);
    const ebitda = formatNumber(item.ebitda);
    
    output += `| ${period} | ${basicEps} | ${dilutedEps} | ${revenue} | ${operCost} | ${operProfit} | ${totalProfit} | ${incomeTax} | **${nIncome}** | **${nIncomeAttrP}** | ${ebit} | ${ebitda} |\n`;
  }
  
  output += `\n**💡 说明：** 单位：万元，EPS单位：元，报表类型：${getReportType(data[0]?.report_type || '1')}\n\n`;
  return output;
}



// 全部利润表数据格式化（智能过滤空列）
export function formatAllIncome(data: any[]): string {
  if (!data || data.length === 0) return '暂无数据\n\n';
  
  // 定义不需要显示的系统字段
  const excludeFields = ['ts_code', 'ann_date', 'f_ann_date', 'report_type', 'comp_type', 'end_type', 'update_flag'];
  
  // 获取所有可能的字段
  const allFields = Object.keys(data[0] || {});
  
  // 智能过滤：检查每个字段是否在所有数据行中都为空
  const fieldsWithData = allFields.filter(field => {
    // 跳过系统字段
    if (excludeFields.includes(field)) return false;
    
    // 检查该字段是否在任何一行中有有效数据
    return data.some(item => {
      const value = item[field];
      return value !== null && 
             value !== undefined && 
             value !== '' && 
             value !== 0;
    });
  });
  
  let output = `**💰 完整利润表数据（智能过滤）**\n\n`;
  
  // 将字段按类别分组
  const revenueFields = fieldsWithData.filter(field => 
    field.includes('revenue') || 
    field.includes('income') || 
    field.includes('prem_') || 
    field.includes('comm_') ||
    field.includes('int_income') ||
    field.includes('n_commis') ||
    field.includes('reins_')
  );
  
  const costFields = fieldsWithData.filter(field => 
    field.includes('cost') || 
    field.includes('exp') || 
    field.includes('cogs') || 
    field.includes('sell_') ||
    field.includes('admin_') ||
    field.includes('fin_exp') ||
    field.includes('assets_impair') ||
    field.includes('refund') ||
    field.includes('payout')
  );
  
  const profitFields = fieldsWithData.filter(field => 
    field.includes('profit') || 
    field.includes('ebit') || 
    field.includes('eps') || 
    field.includes('n_income') || 
    field.includes('minority') ||
    field.includes('total_profit') ||
    field.includes('operate_profit')
  );
  
  const otherFields = fieldsWithData.filter(field => 
    !revenueFields.includes(field) && 
    !costFields.includes(field) && 
    !profitFields.includes(field) &&
    field !== 'end_date'
  );
  
  // 确保end_date排在第一位
  const displayFields = ['end_date', ...revenueFields, ...costFields, ...profitFields, ...otherFields].filter(f => fieldsWithData.includes(f) || f === 'end_date');
  
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
    const headers = fields.map(field => getFieldDisplayName(field));
    output += `| ${headers.join(' | ')} |\n`;
    output += `|${headers.map(() => '--------').join('|')}|\n`;
    
    // 数据行
    for (const item of data) {
      const values = fields.map(field => {
        if (field === 'end_date') {
          return item[field] || 'N/A';
        }
        const value = item[field];
        if (value === null || value === undefined || value === '') return 'N/A';
        if (typeof value === 'number') {
          // EPS字段保留4位小数
          if (field.includes('eps')) {
            return value.toFixed(4);
          }
          return formatNumber(value);
        }
        return value;
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
  
  output += `**💡 说明：** 单位：万元，EPS单位：元，已智能过滤全为空的字段，只显示有实际数据的项目\n\n`;
  
  return output;
}

// 辅助函数：获取字段中文显示名称
function getFieldDisplayName(field: string): string {
  const fieldNames: Record<string, string> = {
    'end_date': '报告期',
    'end_type': '报告期类型',
    'basic_eps': '基本每股收益',
    'diluted_eps': '稀释每股收益',
    'total_revenue': '营业总收入',
    'revenue': '营业收入',
    'int_income': '利息收入',
    'prem_earned': '已赚保费',
    'comm_income': '手续费及佣金收入',
    'n_commis_income': '手续费及佣金净收入',
    'n_oth_income': '其他经营净收益',
    'n_oth_b_income': '加:其他业务净收益',
    'prem_income': '保险业务收入',
    'out_prem': '减:分出保费',
    'une_prem_reser': '提取未到期责任准备金',
    'reins_income': '其中:分保费收入',
    'n_sec_tb_income': '代理买卖证券业务净收入',
    'n_sec_uw_income': '证券承销业务净收入',
    'n_asset_mg_income': '受托客户资产管理业务净收入',
    'oth_b_income': '其他业务收入',
    'fv_value_chg_gain': '加:公允价值变动净收益',
    'invest_income': '加:投资净收益',
    'ass_invest_income': '其中:对联营企业和合营企业的投资收益',
    'forex_gain': '加:汇兑净收益',
    'total_cogs': '营业总成本',
    'oper_cost': '减:营业成本',
    'int_exp': '减:利息支出',
    'comm_exp': '减:手续费及佣金支出',
    'biz_tax_surchg': '减:营业税金及附加',
    'sell_exp': '减:销售费用',
    'admin_exp': '减:管理费用',
    'fin_exp': '减:财务费用',
    'assets_impair_loss': '减:资产减值损失',
    'prem_refund': '退保金',
    'compens_payout': '赔付总支出',
    'reser_insur_liab': '提取保险责任准备金',
    'div_payt': '保户红利支出',
    'reins_exp': '分保费用',
    'oper_exp': '营业支出',
    'compens_payout_refu': '减:摊回赔付支出',
    'insur_reser_refu': '减:摊回保险责任准备金',
    'reins_cost_refund': '减:摊回分保费用',
    'other_bus_cost': '其他业务成本',
    'operate_profit': '营业利润',
    'non_oper_income': '加:营业外收入',
    'non_oper_exp': '减:营业外支出',
    'nca_disploss': '其中:减:非流动资产处置净损失',
    'total_profit': '利润总额',
    'income_tax': '所得税费用',
    'n_income': '净利润(含少数股东损益)',
    'n_income_attr_p': '净利润(不含少数股东损益)',
    'minority_gain': '少数股东损益',
    'oth_compr_income': '其他综合收益',
    't_compr_income': '综合收益总额',
    'compr_inc_attr_p': '归属于母公司(或股东)的综合收益总额',
    'compr_inc_attr_m_s': '归属于少数股东的综合收益总额',
    'ebit': '息税前利润',
    'ebitda': '息税折旧摊销前利润',
    'insurance_exp': '保险业务支出',
    'undist_profit': '年初未分配利润',
    'distable_profit': '可分配利润',
    'rd_exp': '研发费用',
    'fin_exp_int_exp': '财务费用:利息费用',
    'fin_exp_int_inc': '财务费用:利息收入',
    'transfer_surplus_rese': '盈余公积转入',
    'transfer_housing_imprest': '住房周转金转入',
    'transfer_oth': '其他转入',
    'adj_lossgain': '调整以前年度损益',
    'withdra_legal_surplus': '提取法定盈余公积',
    'withdra_legal_pubfund': '提取法定公益金',
    'withdra_biz_devfund': '提取企业发展基金',
    'withdra_rese_fund': '提取储备基金',
    'withdra_oth_ersu': '提取任意盈余公积金',
    'workers_welfare': '职工奖金福利',
    'distr_profit_shrhder': '可供股东分配的利润',
    'prfshare_payable_dvd': '应付优先股股利',
    'comshare_payable_dvd': '应付普通股股利',
    'capit_comstock_div': '转作股本的普通股股利',
    'net_after_nr_lp_correct': '扣除非经常性损益后的净利润（更正前）',
    'credit_impa_loss': '信用减值损失',
    'net_expo_hedging_benefits': '净敞口套期收益',
    'oth_impair_loss_assets': '其他资产减值损失',
    'total_opcost': '营业总成本（二）',
    'amodcost_fin_assets': '以摊余成本计量的金融资产终止确认收益',
    'oth_income': '其他收益',
    'asset_disp_income': '资产处置收益',
    'continued_net_profit': '持续经营净利润',
    'end_net_profit': '终止经营净利润',
    'update_flag': '更新标识'
  };
  
  return fieldNames[field] || field;
}

