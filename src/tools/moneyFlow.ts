import { TUSHARE_CONFIG } from '../config.js';

export const moneyFlow = {
  name: "money_flow",
  description: "获取个股、大盘和板块资金流向数据，包括主力资金、超大单、大单、中单、小单的净流入净额和净占比数据。示例：moneyFlow(start_date='20240901', end_date='20240930', ts_code='000001.SZ')",
  inputSchema: {
    type: "object" as const,
    properties: {
      query_type: {
        type: "string" as const,
        description: "查询类型：stock=个股，market=大盘，sector=板块。默认根据ts_code自动判断",
        enum: ["stock", "market", "sector"]
      },
      ts_code: {
        type: "string" as const,
        description: "股票代码或板块代码。个股如'000001.SZ'，板块如'BK0447'(东财板块代码)。不填写则查询大盘资金流向",
        minLength: 1,
        maxLength: 20
      },
      start_date: {
        type: "string" as const,
        description: "起始日期，格式为YYYYMMDD，如'20240901'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      end_date: {
        type: "string" as const,
        description: "结束日期，格式为YYYYMMDD，如'20240930'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      content_type: {
        type: "string" as const,
        description: "板块资金类型，仅在查询板块时有效。可选：行业、概念、地域",
        enum: ["行业", "概念", "地域"]
      },
      trade_date: {
        type: "string" as const,
        description: "单独查询某个交易日的数据，格式为YYYYMMDD。如填写则忽略start_date和end_date",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      }
    },
    required: ["start_date", "end_date"]
  } as const,
  outputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            type: { type: "string" as const },
            text: { type: "string" as const }
          },
          required: ["type", "text"]
        }
      },
      isError: { type: "boolean" as const }
    },
    required: ["content"]
  } as const,
  async run(args: { 
    query_type?: string;
    ts_code?: string; 
    start_date: string; 
    end_date: string;
    content_type?: string;
    trade_date?: string;
  }) {
    try {
      
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      if (!TUSHARE_API_KEY) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      // 判断查询类型
      let queryType = args.query_type;
      if (!queryType) {
        // 自动判断：没有ts_code=大盘，有BK开头=板块，否则=个股
        if (!args.ts_code || args.ts_code.trim() === '') {
          queryType = 'market';
        } else if (args.ts_code.startsWith('BK')) {
          queryType = 'sector';
        } else {
          queryType = 'stock';
        }
      }
      
      let result;
      let targetName = '';
      
      if (queryType === 'market') {
        // 查询大盘资金流向
        targetName = '大盘';
        result = await fetchMarketMoneyFlow(
          args.trade_date || args.start_date,
          args.trade_date || args.end_date,
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      } else if (queryType === 'sector') {
        // 查询板块资金流向
        targetName = `板块${args.ts_code || ''}`;
        result = await fetchSectorMoneyFlow(
          args.ts_code,
          args.trade_date,
          args.start_date,
          args.end_date,
          args.content_type,
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      } else {
        // 查询个股资金流向
        targetName = `股票${args.ts_code}`;
        result = await fetchStockMoneyFlow(
          args.ts_code!,
          args.trade_date || args.start_date,
          args.trade_date || args.end_date,
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      }

      if (!result.data || result.data.length === 0) {
        throw new Error(`未找到${targetName}在指定时间范围内的资金流向数据`);
      }

      // 格式化输出
      const formattedOutput = formatMoneyFlowData(
        result.data, 
        result.fields, 
        queryType, 
        args.ts_code
      );
      
      return {
        content: [{ type: "text", text: formattedOutput }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `查询资金流向数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}` 
        }]
      };
    }
  }
};

// 获取大盘资金流向数据
async function fetchMarketMoneyFlow(
  startDate: string,
  endDate: string,
  apiKey: string,
  apiUrl: string
) {
  const params = {
    api_name: "moneyflow_mkt_dc",
    token: apiKey,
    params: {
      start_date: startDate,
      end_date: endDate
    },
    fields: "trade_date,close_sh,pct_change_sh,close_sz,pct_change_sz,net_amount,net_amount_rate,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate"
  };

  return await callTushareAPI(params, apiUrl);
}

// 获取个股资金流向数据
async function fetchStockMoneyFlow(
  tsCode: string,
  startDate: string,
  endDate: string,
  apiKey: string,
  apiUrl: string
) {
  const params = {
    api_name: "moneyflow_dc",
    token: apiKey,
    params: {
      ts_code: tsCode,
      start_date: startDate,
      end_date: endDate
    },
    fields: "ts_code,trade_date,close,pct_change,net_amount,net_amount_rate,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate"
  };

  return await callTushareAPI(params, apiUrl);
}

// 获取板块资金流向数据（东财）
async function fetchSectorMoneyFlow(
  tsCode: string | undefined,
  tradeDate: string | undefined,
  startDate: string,
  endDate: string,
  contentType: string | undefined,
  apiKey: string,
  apiUrl: string
) {
  const params: any = {
    api_name: "moneyflow_ind_dc",
    token: apiKey,
    params: {} as any,
    fields: "trade_date,content_type,ts_code,name,pct_change,close,net_amount,net_amount_rate,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate,rank"
  };

  // 根据参数动态构建查询条件
  if (tsCode) {
    params.params.ts_code = tsCode;
  }
  if (tradeDate) {
    params.params.trade_date = tradeDate;
  } else {
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  }
  if (contentType) {
    params.params.content_type = contentType;
  }

  return await callTushareAPI(params, apiUrl);
}

// 调用Tushare API的通用函数
async function callTushareAPI(params: any, apiUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

  try {
    
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`Tushare API请求失败: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(`Tushare API错误: ${data.msg}`);
    }
    
    if (!data.data || !data.data.items) {
      throw new Error(`未找到资金流向数据`);
    }
    
    // 获取字段名
    const fields = data.data.fields;
    
    // 将数据转换为对象数组
    const convertedData = data.data.items.map((item: any) => {
      const result: Record<string, any> = {};
      fields.forEach((field: string, index: number) => {
        result[field] = item[index];
      });
      return result;
    });
    
    
    return {
      data: convertedData,
      fields: fields
    };
    
  } finally {
    clearTimeout(timeoutId);
  }
}

// 格式化资金流向数据输出
function formatMoneyFlowData(data: any[], fields: string[], queryType: string, tsCode?: string): string {
  // 按交易日期倒序排列（最新在前）  
  const sortedData = data.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  
  let target = '';
  if (queryType === 'market') {
    target = '大盘';
  } else if (queryType === 'sector') {
    target = sortedData[0]?.name ? `板块【${sortedData[0].name}】` : `板块 ${tsCode || ''}`;
  } else {
    target = `个股 ${tsCode}`;
  }
  
  let output = `# 💰 ${target}资金流向数据\n\n`;
  
  // 板块查询显示特殊信息
  if (queryType === 'sector' && sortedData[0]) {
    output += `## 📋 板块基本信息\n\n`;
    output += `- 板块代码: ${sortedData[0].ts_code || 'N/A'}\n`;
    output += `- 板块名称: ${sortedData[0].name || 'N/A'}\n`;
    output += `- 板块类型: ${sortedData[0].content_type || 'N/A'}\n`;
    if (sortedData[0].rank) {
      output += `- 资金流入排名: 第 ${sortedData[0].rank} 名\n`;
    }
    output += `\n`;
  }
  
  // 数据统计摘要
  const totalDays = sortedData.length;
  const netInflowDays = sortedData.filter(item => (parseFloat(item.net_amount) || 0) > 0).length;
  const netOutflowDays = totalDays - netInflowDays;
  
  // 计算累计净流入金额
  const totalNetAmount = sortedData.reduce((sum, item) => sum + (parseFloat(item.net_amount) || 0), 0);
  
  output += `## 📊 统计摘要\n\n`;
  output += `- 查询时间范围: ${sortedData[sortedData.length - 1]?.trade_date} 至 ${sortedData[0]?.trade_date}\n`;
  output += `- 交易天数: ${totalDays} 天\n`;
  output += `- 净流入天数: ${netInflowDays} 天 (${((netInflowDays/totalDays)*100).toFixed(1)}%)\n`;
  output += `- 净流出天数: ${netOutflowDays} 天 (${((netOutflowDays/totalDays)*100).toFixed(1)}%)\n`;
  output += `- 累计净流入: ${formatMoney(totalNetAmount)}\n\n`;

  // 构建数据表格
  if (queryType === 'market') {
    output += formatMarketFlowTable(sortedData);
  } else if (queryType === 'sector') {
    output += formatSectorFlowTable(sortedData);
  } else {
    output += formatStockFlowTable(sortedData);
  }
  
  // 最近5个交易日资金流向趋势
  const recentData = sortedData.slice(0, Math.min(5, sortedData.length));
  output += `\n## 📈 最近资金流向趋势\n\n`;
  
  recentData.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const trend = netAmount > 0 ? '🟢' : '🔴';
    const direction = netAmount > 0 ? '净流入' : '净流出';
    
    output += `${item.trade_date} ${trend} 主力${direction} ${formatMoney(Math.abs(netAmount))} (${Math.abs(netAmountRate).toFixed(2)}%)\n`;
  });
  
  output += `\n---\n*数据来源: [Tushare](https://tushare.pro) - 东方财富(DC)*`;
  
  return output;
}

// 格式化大盘资金流向表格
function formatMarketFlowTable(data: any[]): string {
  let output = `## 📋 大盘资金流向明细\n\n`;
  
  output += `| 交易日期 | 上证收盘 | 上证涨跌% | 深证收盘 | 深证涨跌% | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) |\n`;
  output += `|---------|---------|---------|---------|---------|------------|--------|------------|----------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatNumber(item.close_sh)} `;
    output += `| ${formatPercent(item.pct_change_sh)} `;
    output += `| ${formatNumber(item.close_sz)} `;
    output += `| ${formatPercent(item.pct_change_sz)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} |\n`;
  });
  
  return output;
}

// 格式化个股资金流向表格
function formatStockFlowTable(data: any[]): string {
  let output = `## 📋 个股资金流向明细\n\n`;
  
  output += `| 交易日期 | 收盘价 | 涨跌% | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) | 中单净流入(万元) | 小单净流入(万元) |\n`;
  output += `|---------|--------|------|------------|--------|------------|------------|------------|------------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    const mdAmount = parseFloat(item.buy_md_amount) || 0;
    const smAmount = parseFloat(item.buy_sm_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatNumber(item.close)} `;
    output += `| ${formatPercent(item.pct_change)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} `;
    output += `| ${formatMoney(mdAmount)} `;
    output += `| ${formatMoney(smAmount)} |\n`;
  });
  
  return output;
}

// 格式化板块资金流向表格
function formatSectorFlowTable(data: any[]): string {
  let output = `## 📋 板块资金流向明细\n\n`;
  
  output += `| 交易日期 | 板块涨跌% | 板块指数 | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) | 中单净流入(万元) | 小单净流入(万元) | 排名 |\n`;
  output += `|---------|----------|---------|------------|--------|------------|------------|------------|------------|------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    const mdAmount = parseFloat(item.buy_md_amount) || 0;
    const smAmount = parseFloat(item.buy_sm_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatPercent(item.pct_change)} `;
    output += `| ${formatNumber(item.close)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} `;
    output += `| ${formatMoney(mdAmount)} `;
    output += `| ${formatMoney(smAmount)} `;
    output += `| ${item.rank || 'N/A'} |\n`;
  });
  
  return output;
}

// 格式化金额（万元）
function formatMoney(amount: number): string {
  if (amount === 0) return '0.00万';
  const amountInWan = amount / 10000;
  if (Math.abs(amountInWan) >= 100000) {
    return (amountInWan / 10000).toFixed(2) + '亿';
  }
  return amountInWan.toFixed(2) + '万';
}

// 格式化数字
function formatNumber(num: any): string {
  if (num === null || num === undefined || num === '' || isNaN(parseFloat(num))) {
    return 'N/A';
  }
  const number = parseFloat(num);
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 格式化百分比
function formatPercent(num: any): string {
  if (num === null || num === undefined || num === '' || isNaN(parseFloat(num))) {
    return 'N/A';
  }
  const number = parseFloat(num);
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toFixed(2)}%`;
} 