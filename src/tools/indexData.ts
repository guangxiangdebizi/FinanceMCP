import { TUSHARE_CONFIG } from '../config.js';
import { callTushare } from '../utils/tushareClient.js';

export const indexData = {
  name: "index_data",
  description: "获取指定股票指数的数据，支持日线/周线/月线行情、国际主要指数、指数基本信息和估值指标",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "指数代码，如'000001.SH'表示上证指数，'399001.SZ'表示深证成指"
      },
      start_date: {
        type: "string",
        description: "起始日期，格式为YYYYMMDD，如'20230101'（data_type=daily/valuation时有效）"
      },
      end_date: {
        type: "string",
        description: "结束日期，格式为YYYYMMDD，如'20230131'（data_type=daily/valuation时有效）"
      },
      data_type: {
        type: "string",
        description: "数据类型：daily(日线行情，默认)、weekly(周线行情)、monthly(月线行情)、global(国际主要指数日线)、basic(指数基本信息)、valuation(估值指标-市盈率/市净率/换手率/总市值等，使用index_dailybasic接口)",
        enum: ["daily", "weekly", "monthly", "global", "basic", "valuation"]
      }
    },
    required: ["code"]
  },
  async run(args: { code: string; start_date?: string; end_date?: string; data_type?: string }) {
    try {
      console.log(`使用Tushare API获取指数${args.code}的数据`);

      // 使用全局配置中的Tushare API设置
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;

      // index_basic 分支：返回指数基本信息，不需要日期参数
      if (args.data_type === 'basic') {
        const params = {
          api_name: "index_basic",
          token: TUSHARE_API_KEY,
          params: { ts_code: args.code },
          fields: "ts_code,name,fullname,market,publisher,index_type,category,base_date,base_point,list_date,weight_rule,desc,exp_date"
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
        try {
          const response = await fetch(TUSHARE_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`Tushare API请求失败: ${response.status}`);
          const data = await response.json();
          if (data.code !== 0) throw new Error(`Tushare API错误: ${data.msg}`);
          if (!data.data || !data.data.items || data.data.items.length === 0) {
            throw new Error(`未找到指数${args.code}的基本信息`);
          }
          const fields: string[] = data.data.fields;
          const rows = data.data.items.map((item: any) => {
            const r: Record<string, any> = {};
            fields.forEach((f, i) => { r[f] = item[i]; });
            return r;
          });
          const row = rows[0];
          const text = [
            `# ${row.name || args.code} 指数基本信息`,
            ``,
            `| 字段 | 值 |`,
            `|------|-----|`,
            `| 代码 | ${row.ts_code || 'N/A'} |`,
            `| 名称 | ${row.name || 'N/A'} |`,
            `| 全称 | ${row.fullname || 'N/A'} |`,
            `| 市场 | ${row.market || 'N/A'} |`,
            `| 发布方 | ${row.publisher || 'N/A'} |`,
            `| 指数类型 | ${row.index_type || 'N/A'} |`,
            `| 类别 | ${row.category || 'N/A'} |`,
            `| 基期 | ${row.base_date || 'N/A'} |`,
            `| 基点 | ${row.base_point || 'N/A'} |`,
            `| 上市日期 | ${row.list_date || 'N/A'} |`,
            `| 权重规则 | ${row.weight_rule || 'N/A'} |`,
            `| 终止日期 | ${row.exp_date || 'N/A'} |`,
            ``,
            row.desc ? `**描述**: ${row.desc}` : ''
          ].filter(l => l !== undefined).join('\n');
          return { content: [{ type: "text", text }] };
        } finally {
          clearTimeout(timeoutId);
        }
      }
      
      // valuation 分支：index_dailybasic 估值指标
      if (args.data_type === 'valuation') {
        const today = new Date();
        const defaultEnd = today.toISOString().slice(0, 10).replace(/-/g, '');
        const oneMonthAgo = new Date(); oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const defaultStart = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
        const { data, fields } = await callTushare(
          'index_dailybasic',
          {
            ts_code: args.code,
            start_date: args.start_date || defaultStart,
            end_date: args.end_date || defaultEnd,
          },
          'ts_code,trade_date,total_mv,float_mv,total_share,float_share,free_share,turnover_rate,turnover_rate_f,pe,pe_ttm,pb'
        );
        if (!data.length) throw new Error(`未找到指数${args.code}的估值数据`);
        const sorted = data.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
        const startD = sorted[sorted.length - 1]?.trade_date;
        const endD = sorted[0]?.trade_date;
        let text = `# ${args.code} 指数估值指标 (${startD} 至 ${endD})\n\n`;
        text += `| 日期 | 总市值(亿) | 流通市值(亿) | 换手率% | 换手率(自由)% | PE | PE(TTM) | PB |\n`;
        text += `|------|-----------|------------|--------|------------|----|---------|----|  \n`;
        sorted.forEach(r => {
          const mv = (v: any) => v != null ? (parseFloat(v) / 1e8).toFixed(2) : 'N/A';
          const n2 = (v: any) => v != null ? parseFloat(v).toFixed(2) : 'N/A';
          text += `| ${r.trade_date} | ${mv(r.total_mv)} | ${mv(r.float_mv)} | ${n2(r.turnover_rate)} | ${n2(r.turnover_rate_f)} | ${n2(r.pe)} | ${n2(r.pe_ttm)} | ${n2(r.pb)} |\n`;
        });
        text += `\n---\n*数据来源: Tushare index_dailybasic*`;
        return { content: [{ type: 'text', text }] };
      }

      if (args.data_type === 'weekly' || args.data_type === 'monthly' || args.data_type === 'global') {
        const today = new Date();
        const defaultEnd = today.toISOString().slice(0, 10).replace(/-/g, '');
        const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const defaultStart = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');
        const config = getIndexHistoryConfig(args.data_type);
        const { data } = await callTushare(
          config.apiName,
          {
            ts_code: args.code,
            start_date: args.start_date || defaultStart,
            end_date: args.end_date || defaultEnd,
          },
          config.fields
        );
        if (!data.length) throw new Error(`未找到指数${args.code}的${config.title}数据`);
        return { content: [{ type: 'text', text: formatIndexHistory(data, args.code, config.title, config.apiName) }] };
      }

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
        console.log(`请求Tushare API: ${params.api_name}，参数:`, params.params);
        
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

        // 表格格式输出
        let tableOutput = `# ${args.code}指数日线行情 (${startDate} 至 ${endDate})\n\n`;
        tableOutput += `## 期间走势: ${trend}\n${trendAnalysis}\n\n`;
        tableOutput += `| 日期 | 开盘 | 最高 | 最低 | 收盘 | 涨跌 | 涨跌幅% | 成交量(手) | 成交额(千元) |\n`;
        tableOutput += `|------|------|------|------|------|------|---------|-----------|------------|\n`;
        indexData.forEach((d: Record<string, any>) => {
          tableOutput += `| ${d.trade_date} | ${d.open} | ${d.high} | ${d.low} | ${d.close} | ${d.change} | ${d.pct_chg} | ${d.vol} | ${d.amount} |\n`;
        });

        return {
          content: [{ type: "text", text: tableOutput }]
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error("获取指数数据失败:", error);
      
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

function getIndexHistoryConfig(dataType: string) {
  if (dataType === 'weekly') {
    return {
      apiName: 'index_weekly',
      title: '周线行情',
      fields: 'ts_code,trade_date,close,open,high,low,pre_close,change,pct_chg,vol,amount'
    };
  }
  if (dataType === 'monthly') {
    return {
      apiName: 'index_monthly',
      title: '月线行情',
      fields: 'ts_code,trade_date,close,open,high,low,pre_close,change,pct_chg,vol,amount'
    };
  }
  return {
    apiName: 'index_global',
    title: '国际主要指数日线行情',
    fields: 'ts_code,trade_date,open,close,high,low,pre_close,change,pct_chg,swing,vol,amount'
  };
}

function formatIndexHistory(data: Record<string, any>[], code: string, title: string, apiName: string): string {
  const sorted = [...data].sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  const startDate = sorted[sorted.length - 1]?.trade_date || '';
  const endDate = sorted[0]?.trade_date || '';
  const hasSwing = sorted.some(r => r.swing !== undefined && r.swing !== null && r.swing !== '');

  let text = `# ${code} 指数${title} (${startDate} 至 ${endDate})\n\n`;
  text += hasSwing
    ? `| 日期 | 开盘 | 最高 | 最低 | 收盘 | 涨跌 | 涨跌幅% | 振幅% | 成交量 | 成交额 |\n`
    : `| 日期 | 开盘 | 最高 | 最低 | 收盘 | 涨跌 | 涨跌幅% | 成交量 | 成交额 |\n`;
  text += hasSwing
    ? `|------|------|------|------|------|------|---------|-------|--------|--------|\n`
    : `|------|------|------|------|------|------|---------|--------|--------|\n`;
  sorted.forEach(r => {
    const n = (v: any) => v !== undefined && v !== null && v !== '' ? String(v) : 'N/A';
    text += hasSwing
      ? `| ${n(r.trade_date)} | ${n(r.open)} | ${n(r.high)} | ${n(r.low)} | ${n(r.close)} | ${n(r.change)} | ${n(r.pct_chg)} | ${n(r.swing)} | ${n(r.vol)} | ${n(r.amount)} |\n`
      : `| ${n(r.trade_date)} | ${n(r.open)} | ${n(r.high)} | ${n(r.low)} | ${n(r.close)} | ${n(r.change)} | ${n(r.pct_chg)} | ${n(r.vol)} | ${n(r.amount)} |\n`;
  });
  text += `\n---\n*数据来源: Tushare ${apiName}*`;
  return text;
}
