import { TUSHARE_CONFIG } from '../config.js';

export const indexData = {
  name: "index_data",
  description: "获取指定股票指数的数据，例如上证指数、深证成指等。示例：index_data(code='000001.SH', start_date='20240101', end_date='20240131')",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string" as const,
        description: "指数代码，如'000001.SH'表示上证指数，'399001.SZ'表示深证成指",
        pattern: "^[0-9]{6}\\.(SH|SZ)$",
        minLength: 9,
        maxLength: 9
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
        description: "结束日期，格式为YYYYMMDD，如'20230131'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      }
    },
    required: ["code", "start_date", "end_date"]
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
  async run(args: { code: string; start_date?: string; end_date?: string }) {
    try {
      
      // 使用全局配置中的Tushare API设置
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      // 默认参数设置
      const today = new Date();
      const defaultEndDate = today.toISOString().slice(0, 10).replace(/-/g, '');
      
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const defaultStartDate = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
      
      // 构建请求参数
      const params = {
        api_name: "index_daily",
        token: TUSHARE_API_KEY,
        params: {
          ts_code: args.code,
          start_date: args.start_date || defaultStartDate,
          end_date: args.end_date || defaultEndDate
        },
        fields: "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"
      };
      
      // 设置请求超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
      
      try {
        
        // 发送请求
        const response = await fetch(TUSHARE_API_URL, {
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
        
        // 处理响应数据
        if (data.code !== 0) {
          throw new Error(`Tushare API错误: ${data.msg}`);
        }
        
        // 确保data.data和data.data.items存在
        if (!data.data || !data.data.items || data.data.items.length === 0) {
          throw new Error(`未找到指数${args.code}的数据`);
        }
        
        // 获取字段名
        const fields = data.data.fields;
        
        // 将数据转换为对象数组
        const indexData = data.data.items.map((item: any) => {
          const result: Record<string, any> = {};
          fields.forEach((field: string, index: number) => {
            result[field] = item[index];
          });
          return result;
        });
        
        // 收集涨跌数据用于生成趋势分析
        const closePrices = indexData.map((item: Record<string, any>) => parseFloat(item.close));
        let trend = "持平";
        let trendAnalysis = "";
        
        if (closePrices.length > 1) {
          const firstPrice = closePrices[closePrices.length - 1]; // 最早的收盘价
          const lastPrice = closePrices[0]; // 最近的收盘价
          const change = ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2);
          
          if (lastPrice > firstPrice) {
            trend = `上涨 ${change}%`;
            trendAnalysis = `在此期间，${args.code}整体呈上涨趋势，累计涨幅达${change}%。`;
          } else if (lastPrice < firstPrice) {
            trend = `下跌 ${Math.abs(parseFloat(change))}%`;
            trendAnalysis = `在此期间，${args.code}整体呈下跌趋势，累计跌幅达${Math.abs(parseFloat(change))}%。`;
          }
        }
        
        // 格式化输出日期范围
        const startDate = indexData[indexData.length - 1]?.trade_date || args.start_date || defaultStartDate;
        const endDate = indexData[0]?.trade_date || args.end_date || defaultEndDate;
        
        // 格式化输出
        const formattedData = indexData.map((data: Record<string, any>) => {
          return `## ${data.trade_date}\n开盘: ${data.open}  最高: ${data.high}  最低: ${data.low}  收盘: ${data.close}\n涨跌: ${data.change}  涨跌幅: ${data.pct_chg}%  成交量: ${data.vol}  成交额: ${data.amount}\n`;
        }).join('\n---\n\n');
        
        return {
          content: [
            {
              type: "text",
              text: `# ${args.code}指数数据 (${startDate} 至 ${endDate})\n\n` +
                   `## 期间走势: ${trend}\n${trendAnalysis}\n\n---\n\n${formattedData}`
            }
          ]
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `# 获取指数${args.code}数据失败\n\n无法从Tushare API获取数据：${error instanceof Error ? error.message : String(error)}\n\n请检查指数代码是否正确，常用指数代码：\n- 上证指数: 000001.SH\n- 深证成指: 399001.SZ\n- 创业板指: 399006.SZ\n- 沪深300: 000300.SH\n- 中证500: 000905.SH`
          }
        ]
      };
    }
  }
}; 