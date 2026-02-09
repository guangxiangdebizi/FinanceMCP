/**
 * 上市公司基本信息格式化模块
 * 处理公司基础信息的格式化和统计分析
 */

interface CompanyBasicData {
  ts_code: string;
  com_name: string;
  com_id: string;
  exchange: string;
  chairman: string;
  manager: string;
  secretary: string;
  reg_capital: number;
  setup_date: string;
  province: string;
  city: string;
  introduction?: string;
  website: string;
  email: string;
  office?: string;
  employees: number;
  main_business?: string;
  business_scope?: string;
}

/**
 * 格式化上市公司基本信息
 */
export function formatCompanyBasic(data: CompanyBasicData[]): string {
  if (!data || data.length === 0) {
    return "未找到上市公司基本信息。";
  }


  let result = `## 🏢 上市公司基本信息\n\n`;

  // 基础信息表格展示
  result += `### 公司基础信息\n\n`;
  result += `| 股票代码 | 公司全称 | 交易所 | 法人代表 | 总经理 | 董秘 | 注册资本(万元) | 注册日期 | 所在地区 |\n`;
  result += `|---------|---------|--------|---------|--------|------|----------------|----------|----------|\n`;

  data.forEach((record: CompanyBasicData) => {
    const exchangeName = getExchangeName(record.exchange);
    const regCapital = record.reg_capital ? (record.reg_capital / 10000).toFixed(2) : 'N/A';
    const location = `${record.province || 'N/A'}${record.city ? '/' + record.city : ''}`;
    
    result += `| ${record.ts_code || 'N/A'} | ${record.com_name || 'N/A'} | ${exchangeName} | ${record.chairman || 'N/A'} | ${record.manager || 'N/A'} | ${record.secretary || 'N/A'} | ${regCapital} | ${formatDate(record.setup_date) || 'N/A'} | ${location} |\n`;
  });

  // 公司详细信息（如果只查询单个公司）
  if (data.length === 1) {
    const company = data[0];
    result += `\n### 📋 详细信息\n\n`;
    
    if (company.com_id) {
      result += `**统一社会信用代码：** ${company.com_id}\n\n`;
    }
    
    if (company.employees && company.employees > 0) {
      result += `**员工人数：** ${company.employees.toLocaleString()}人\n\n`;
    }
    
    if (company.website) {
      result += `**公司网站：** ${company.website}\n\n`;
    }
    
    if (company.email) {
      result += `**联系邮箱：** ${company.email}\n\n`;
    }
    
    if (company.office) {
      result += `**办公地址：** ${company.office}\n\n`;
    }
    
    if (company.main_business) {
      result += `**主要业务及产品：**\n`;
      result += `${company.main_business}\n\n`;
    }
    
    if (company.business_scope) {
      result += `**经营范围：**\n`;
      result += `${company.business_scope}\n\n`;
    }
    
    if (company.introduction) {
      result += `**公司介绍：**\n`;
      result += `${company.introduction}\n\n`;
    }
  }

  // 统计分析
  if (data.length > 1) {
    result += `\n### 📊 统计分析\n\n`;
    
    // 1. 交易所分布
    const exchangeStats: Record<string, number> = {};
    data.forEach(record => {
      const exchange = getExchangeName(record.exchange);
      exchangeStats[exchange] = (exchangeStats[exchange] || 0) + 1;
    });

    result += `**🏛️ 交易所分布：**\n`;
    Object.entries(exchangeStats)
      .sort(([, a], [, b]) => b - a)
      .forEach(([exchange, count]) => {
        const percentage = ((count / data.length) * 100).toFixed(1);
        result += `- ${exchange}: ${count}家 (${percentage}%)\n`;
      });

    // 2. 地区分布
    const provinceStats: Record<string, number> = {};
    data.forEach(record => {
      const province = record.province || '未知';
      provinceStats[province] = (provinceStats[province] || 0) + 1;
    });

    result += `\n**🗺️ 地区分布（前10名）：**\n`;
    Object.entries(provinceStats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .forEach(([province, count]) => {
        const percentage = ((count / data.length) * 100).toFixed(1);
        result += `- ${province}: ${count}家 (${percentage}%)\n`;
      });

    // 3. 注册资本分析
    const validCapital = data
      .filter(record => record.reg_capital && record.reg_capital > 0)
      .map(record => record.reg_capital);
      
    if (validCapital.length > 0) {
      const avgCapital = (validCapital.reduce((sum, cap) => sum + cap, 0) / validCapital.length / 10000).toFixed(2);
      const maxCapital = (Math.max(...validCapital) / 10000).toFixed(2);
      const minCapital = (Math.min(...validCapital) / 10000).toFixed(2);
      
      result += `\n**💰 注册资本分析：**\n`;
      result += `- 平均注册资本: ${avgCapital}万元\n`;
      result += `- 最高注册资本: ${maxCapital}万元\n`;
      result += `- 最低注册资本: ${minCapital}万元\n`;
      result += `- 统计样本: ${validCapital.length}家公司\n`;
    }

    // 4. 员工规模分析
    const validEmployees = data
      .filter(record => record.employees && record.employees > 0)
      .map(record => record.employees);
      
    if (validEmployees.length > 0) {
      const avgEmployees = Math.round(validEmployees.reduce((sum, emp) => sum + emp, 0) / validEmployees.length);
      const maxEmployees = Math.max(...validEmployees);
      const minEmployees = Math.min(...validEmployees);
      
      result += `\n**👥 员工规模分析：**\n`;
      result += `- 平均员工数: ${avgEmployees.toLocaleString()}人\n`;
      result += `- 最大员工数: ${maxEmployees.toLocaleString()}人\n`;
      result += `- 最小员工数: ${minEmployees.toLocaleString()}人\n`;
      result += `- 统计样本: ${validEmployees.length}家公司\n`;
    }

    // 5. 成立年代分析
    const setupYears = data
      .filter(record => record.setup_date && record.setup_date.length >= 4)
      .map(record => parseInt(record.setup_date.substring(0, 4)))
      .filter(year => year >= 1980 && year <= new Date().getFullYear());
      
    if (setupYears.length > 0) {
      const avgYear = Math.round(setupYears.reduce((sum, year) => sum + year, 0) / setupYears.length);
      const earliestYear = Math.min(...setupYears);
      const latestYear = Math.max(...setupYears);
      const currentYear = new Date().getFullYear();
      const avgAge = currentYear - avgYear;
      
      result += `\n**🗓️ 成立年代分析：**\n`;
      result += `- 平均成立年份: ${avgYear}年\n`;
      result += `- 最早成立: ${earliestYear}年\n`;
      result += `- 最晚成立: ${latestYear}年\n`;
      result += `- 平均公司年龄: ${avgAge}年\n`;
      result += `- 统计样本: ${setupYears.length}家公司\n`;
    }
  }

  // 数据汇总信息
  result += `\n---\n`;
  result += `📅 **数据统计时间:** ${new Date().toLocaleString('zh-CN')}\n`;
  result += `📊 **公司记录总数:** ${data.length}条\n`;
  result += `🏢 **数据来源:** Tushare上市公司基本信息接口\n`;

  return result;
}

/**
 * 获取交易所中文名称
 */
function getExchangeName(exchange: string): string {
  const exchangeMap: Record<string, string> = {
    'SSE': '上海证券交易所',
    'SZSE': '深圳证券交易所', 
    'BSE': '北京证券交易所',
    'SH': '上海证券交易所',
    'SZ': '深圳证券交易所',
    'BJ': '北京证券交易所'
  };
  return exchangeMap[exchange] || exchange || 'N/A';
}

/**
 * 格式化日期显示
 */
function formatDate(dateStr: string): string {
  if (!dateStr || dateStr.length < 8) return dateStr;
  
  // 假设格式为YYYYMMDD
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  
  return `${year}-${month}-${day}`;
} 