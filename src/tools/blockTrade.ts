import { TUSHARE_CONFIG } from '../config.js';
import { resolveStockCodes } from '../utils/stockCodeResolver.js';

export const blockTrade = {
  name: "block_trade",
  description: "获取大宗交易数据，包括成交价格、成交量、买卖双方营业部等详细信息。示例：blockTrade(start_date='20240101', end_date='20240131', code='000001.SZ')",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string" as const,
        description: "股票代码（可选），如'000001.SZ'表示平安银行。不填写则查询全市场大宗交易",
        minLength: 1,
        maxLength: 20
      },
      start_date: {
        type: "string" as const,
        description: "起始日期，格式为YYYYMMDD，如'20230101'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      end_date: {
        type: "string" as const,
        description: "结束日期，格式为YYYYMMDD，如'20231231'",
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
  async run(args: { code?: string; start_date: string; end_date: string }) {
    try {
      
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      if (!TUSHARE_API_KEY) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      // 构建请求参数
      const requestParams: any = {
        start_date: args.start_date,
        end_date: args.end_date
      };
      
      // 只有提供了code时才添加ts_code参数
      if (args.code) {
        requestParams.ts_code = args.code;
      }

      const params = {
        api_name: "block_trade",
        token: TUSHARE_API_KEY,
        params: requestParams
        // 不设置fields参数，返回所有字段
      };


      // 设置请求超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

      try {
        const response = await fetch(TUSHARE_API_URL!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(params),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Tushare API请求失败: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== 0) {
          throw new Error(`Tushare API错误: ${data.msg}`);
        }

        if (!data.data || !data.data.items || data.data.items.length === 0) {
          return {
            content: [{ 
              type: "text", 
              text: `# 📊 ${args.code || '全市场'} 大宗交易数据\n\n查询期间: ${args.start_date} - ${args.end_date}\n\n❌ 暂无大宗交易记录\n\n在指定时间范围内，${args.code ? '该股票' : '全市场'}没有大宗交易数据。` 
            }]
          };
        }

        // 获取字段名
        const fieldsArray = data.data.fields;

        // 将数据转换为对象数组
        const tradeData = data.data.items.map((item: any) => {
          const result: Record<string, any> = {};
          fieldsArray.forEach((field: string, index: number) => {
            result[field] = item[index];
          });
          return result;
        });


        // 格式化输出
        const formattedOutput = await formatBlockTradeData(tradeData, args.code || '全市场', args.start_date, args.end_date);
        
        return {
          content: [{ type: "text", text: formattedOutput }]
        };

      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `查询大宗交易数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}` 
        }]
      };
    }
  }
};

// 格式化大宗交易数据
async function formatBlockTradeData(data: any[], code: string, startDate: string, endDate: string): Promise<string> {
  let output = `# 📊 ${code} 大宗交易数据\n\n`;
  output += `查询期间: ${startDate} - ${endDate}\n`;
  output += `交易记录: 共 ${data.length} 条\n\n`;

  // 统计信息
  const totalVolume = data.reduce((sum, item) => sum + (parseFloat(item.vol) || 0), 0);
  const totalAmount = data.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const avgPrice = totalAmount > 0 && totalVolume > 0 ? totalAmount / totalVolume : 0;

  output += `## 📈 统计摘要\n\n`;
  output += `- 累计成交量: ${formatNumber(totalVolume)} 万股\n`;
  output += `- 累计成交金额: ${formatNumber(totalAmount)} 万元\n`;
  output += `- 平均成交价: ${avgPrice > 0 ? avgPrice.toFixed(2) : 'N/A'} 元/股\n`;
  output += `- 交易天数: ${new Set(data.map(item => item.trade_date)).size} 天\n`;
  output += `- 涉及股票: ${new Set(data.map(item => item.ts_code)).size} 只\n\n`;

  // 按交易日期分组
  const groupedData: Record<string, any[]> = {};
  for (const item of data) {
    const date = item.trade_date || 'unknown';
    if (!groupedData[date]) {
      groupedData[date] = [];
    }
    groupedData[date].push(item);
  }

  // 按日期排序（最新的在前）
  const sortedDates = Object.keys(groupedData).sort((a, b) => b.localeCompare(a));

  output += `## 📋 交易明细\n\n`;

  for (const date of sortedDates) {
    const dayTrades = groupedData[date];
    const dayVolume = dayTrades.reduce((sum, item) => sum + (parseFloat(item.vol) || 0), 0);
    const dayAmount = dayTrades.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

    output += `### 📅 ${date}\n\n`;
    output += `当日汇总: ${dayTrades.length} 笔交易，成交量 ${formatNumber(dayVolume)} 万股，成交额 ${formatNumber(dayAmount)} 万元\n\n`;

    // 创建表格
    output += `| 股票代码 | 成交价(元) | 成交量(万股) | 成交金额(万元) | 买方营业部 | 卖方营业部 |\n`;
    output += `|---------|-----------|------------|-------------|-----------|----------|\n`;

    for (const trade of dayTrades) {
      const tsCode = trade.ts_code || 'N/A';
      const price = trade.price ? parseFloat(trade.price).toFixed(2) : 'N/A';
      const volume = trade.vol ? formatNumber(trade.vol) : 'N/A';
      const amount = trade.amount ? formatNumber(trade.amount) : 'N/A';
      const buyer = trade.buyer || 'N/A';
      const seller = trade.seller || 'N/A';

      // 截断过长的营业部名称
      const buyerShort = buyer.length > 20 ? buyer.substring(0, 17) + '...' : buyer;
      const sellerShort = seller.length > 20 ? seller.substring(0, 17) + '...' : seller;

      output += `| ${tsCode} | ${price} | ${volume} | ${amount} | ${buyerShort} | ${sellerShort} |\n`;
    }

    output += '\n';
  }

  // 股票活跃度统计（仅在查询全市场时显示）
  if (!code || code === '全市场') {
    const stockCount: Record<string, number> = {};
    const stockVolume: Record<string, number> = {};
    
    for (const trade of data) {
      if (trade.ts_code) {
        stockCount[trade.ts_code] = (stockCount[trade.ts_code] || 0) + 1;
        stockVolume[trade.ts_code] = (stockVolume[trade.ts_code] || 0) + (parseFloat(trade.vol) || 0);
      }
    }

    // 按交易次数排序的TOP5股票
    const topStocksByCount = Object.entries(stockCount)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);

    if (topStocksByCount.length > 0) {
      output += `## 📈 最活跃股票统计\n\n`;
      output += `### 🔥 大宗交易次数 TOP5\n\n`;
      output += `| 排名 | 股票代码 | 交易次数 | 累计成交量(万股) |\n`;
      output += `|-----|---------|--------|--------------|\n`;
      
      topStocksByCount.forEach(([tsCode, count], index) => {
        const volume = stockVolume[tsCode] || 0;
        output += `| ${index + 1} | ${tsCode} | ${count} 次 | ${formatNumber(volume)} |\n`;
      });
      output += '\n';
    }
  }

  // 买卖营业部统计
  const buyerCount: Record<string, number> = {};
  const sellerCount: Record<string, number> = {};

  for (const trade of data) {
    if (trade.buyer && trade.buyer !== 'N/A') {
      buyerCount[trade.buyer] = (buyerCount[trade.buyer] || 0) + 1;
    }
    if (trade.seller && trade.seller !== 'N/A') {
      sellerCount[trade.seller] = (sellerCount[trade.seller] || 0) + 1;
    }
  }

  // 买方营业部TOP5
  const topBuyers = Object.entries(buyerCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5);

  if (topBuyers.length > 0) {
    output += `## 🏆 活跃营业部统计\n\n`;
    output += `### 🟢 买方营业部 TOP5\n\n`;
    output += `| 排名 | 营业部名称 | 交易次数 |\n`;
    output += `|-----|-----------|--------|\n`;
    
    topBuyers.forEach(([name, count], index) => {
      const nameShort = name.length > 30 ? name.substring(0, 27) + '...' : name;
      output += `| ${index + 1} | ${nameShort} | ${count} 次 |\n`;
    });
    output += '\n';
  }

  // 卖方营业部TOP5
  const topSellers = Object.entries(sellerCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5);

  if (topSellers.length > 0) {
    output += `### 🔴 卖方营业部 TOP5\n\n`;
    output += `| 排名 | 营业部名称 | 交易次数 |\n`;
    output += `|-----|-----------|--------|\n`;
    
    topSellers.forEach(([name, count], index) => {
      const nameShort = name.length > 30 ? name.substring(0, 27) + '...' : name;
      output += `| ${index + 1} | ${nameShort} | ${count} 次 |\n`;
    });
    output += '\n';
  }

  output += `---\n\n*数据来源: Tushare Pro*`;
  
  // 收集所有股票代码并生成说明
  const stockCodes: string[] = [];
  for (const trade of data) {
    if (trade.ts_code) {
      stockCodes.push(String(trade.ts_code));
    }
  }
  const stockExplanation = await resolveStockCodes(stockCodes);
  output += stockExplanation;

  return output;
}

// 辅助函数：格式化数字
function formatNumber(num: any): string {
  if (num === null || num === undefined || num === '' || isNaN(parseFloat(num))) {
    return 'N/A';
  }
  const number = parseFloat(num);
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
} 