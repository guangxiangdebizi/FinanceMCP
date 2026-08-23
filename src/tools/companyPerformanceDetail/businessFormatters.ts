// 主营业务构成格式化函数模块
// 用于处理主营业务构成数据展示

// 辅助函数：格式化数字
function formatNumber(num: any): string {
  if (num === null || num === undefined || num === '') return 'N/A';
  const number = parseFloat(num);
  if (isNaN(number)) return 'N/A';
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatYuanAsWan(num: any): string {
  const value = Number(num);
  return Number.isFinite(value) ? formatNumber(value / 10000) : 'N/A';
}

// 格式化融合版主营业务构成数据（包含产品、地区、行业）
export function formatMainBusinessCombined(data: any[]): string {
  if (!data || data.length === 0) {
    return `暂无数据\n\n`;
  }

  let output = '';
  
  // 按业务类型分组
  const groupedByType: Record<string, any[]> = {};
  for (const item of data) {
    const bzType = item.bz_type || '未知';
    if (!groupedByType[bzType]) {
      groupedByType[bzType] = [];
    }
    groupedByType[bzType].push(item);
  }

  // 按业务类型顺序处理：产品、地区、行业
  const typeOrder = ['产品', '地区', '行业'];
  const typeIcons = { '产品': '🏭', '地区': '🗺️', '行业': '🏢' };
  
  for (const bzType of typeOrder) {
    if (!groupedByType[bzType] || groupedByType[bzType].length === 0) {
      continue;
    }
    
    const typeData = groupedByType[bzType];
    const icon = typeIcons[bzType as keyof typeof typeIcons] || '📊';
    
    output += `## ${icon} 按${bzType}构成\n\n`;
    
    // 按报告期分组
    const groupedByPeriod: Record<string, any[]> = {};
    for (const item of typeData) {
      const period = item.end_date || 'unknown';
      if (!groupedByPeriod[period]) {
        groupedByPeriod[period] = [];
      }
      groupedByPeriod[period].push(item);
    }

    // 按报告期排序（最新的在前）
    const sortedPeriods = Object.keys(groupedByPeriod).sort((a, b) => b.localeCompare(a));

    // 为每个报告期生成表格
    for (const period of sortedPeriods) {
      const items = groupedByPeriod[period];
      output += `#### 📅 ${period} 报告期\n\n`;
      
      // 创建表格头
      output += `| ${bzType}项目 | 主营收入(万元) | 主营利润(万元) | 主营成本(万元) | 货币代码 |\n`;
      output += `|---------|-------------|-------------|-------------|----------|\n`;
      
      // 添加数据行
      for (const item of items) {
        const bzItem = item.bz_item || 'N/A';
        const bzSales = item.bz_sales ? formatYuanAsWan(item.bz_sales) : 'N/A';
        const bzProfit = item.bz_profit ? formatYuanAsWan(item.bz_profit) : 'N/A';
        const bzCost = item.bz_cost ? formatYuanAsWan(item.bz_cost) : 'N/A';
        const currType = item.curr_type || 'CNY';
        
        output += `| ${bzItem} | ${bzSales} | ${bzProfit} | ${bzCost} | ${currType} |\n`;
      }
      
      output += '\n';
    }
    
    output += '\n';
  }
  
  // 添加整体统计
  output += `## 📊 整体统计\n\n`;
  for (const bzType of typeOrder) {
    if (groupedByType[bzType]) {
      output += `- **${bzType}**: ${groupedByType[bzType].length} 条记录\n`;
    }
  }
  output += `- **总计**: ${data.length} 条记录\n\n`;
  
  return output;
}

// 格式化主营业务构成数据（保持向后兼容）
export function formatMainBusiness(data: any[]): string {
  if (!data || data.length === 0) {
    return `暂无数据\n\n`;
  }

  let output = '';
  
  // 按报告期分组
  const groupedData: Record<string, any[]> = {};
  for (const item of data) {
    const period = item.end_date || 'unknown';
    if (!groupedData[period]) {
      groupedData[period] = [];
    }
    groupedData[period].push(item);
  }

  // 按报告期排序（最新的在前）
  const sortedPeriods = Object.keys(groupedData).sort((a, b) => b.localeCompare(a));

  // 为每个报告期生成表格
  for (const period of sortedPeriods) {
    const items = groupedData[period];
    output += `#### 📅 ${period} 报告期\n\n`;
    
    // 创建表格头
    output += `| 业务项目 | 主营收入(万元) | 主营利润(万元) | 主营成本(万元) | 货币代码 |\n`;
    output += `|---------|-------------|-------------|-------------|----------|\n`;
    
    // 添加数据行
    for (const item of items) {
      const bzItem = item.bz_item || 'N/A';
      const bzSales = item.bz_sales ? formatYuanAsWan(item.bz_sales) : 'N/A';
      const bzProfit = item.bz_profit ? formatYuanAsWan(item.bz_profit) : 'N/A';
      const bzCost = item.bz_cost ? formatYuanAsWan(item.bz_cost) : 'N/A';
      const currType = item.curr_type || 'CNY';
      
      output += `| ${bzItem} | ${bzSales} | ${bzProfit} | ${bzCost} | ${currType} |\n`;
    }
    
    output += '\n';
  }
  
  return output;
}
