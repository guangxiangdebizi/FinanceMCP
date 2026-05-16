import { callTushare } from '../utils/tushareClient.js';

export const futuresData = {
  name: "futures_data",
  description: [
    "获取期货持仓数据（龙虎榜/席位持仓）。",
    "数据源：Tushare fut_holding 接口（期货公司持仓排名）。",
    "V2 范围：仅支持持仓/定位用例（holding）；期货基本信息（fut_basic）不在本版本范围内。",
    "需要 Tushare 积分：fut_holding 接口需 2000 积分。"
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      trade_date: {
        type: "string",
        description: "交易日期，格式为YYYYMMDD，如'20240101'。必填"
      },
      symbol: {
        type: "string",
        description: "期货品种代码，如'IF'（沪深300股指期货）、'CU'（铜）、'RB'（螺纹钢）。不填则返回当日所有品种"
      },
      broker: {
        type: "string",
        description: "期货公司/席位名称，如'中信期货'。不填则返回所有席位"
      }
    },
    required: ["trade_date"]
  },
  async run(args: { trade_date: string; symbol?: string; broker?: string }) {
    try {
      console.log('期货持仓数据查询参数:', args);

      const params: Record<string, any> = { trade_date: args.trade_date };
      if (args.symbol) params.symbol = args.symbol;
      if (args.broker) params.broker = args.broker;

      const { data } = await callTushare(
        'fut_holding',
        params,
        'trade_date,symbol,broker,long_hld,long_chg,short_hld,short_chg'
      );

      if (!data.length) {
        throw new Error(`未找到 ${args.trade_date} 的期货持仓数据，请确认为有效交易日`);
      }

      const text = formatFuturesHolding(data, args.trade_date, args.symbol);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      console.error('期货持仓数据查询错误:', error);
      return {
        content: [{
          type: 'text',
          text: `查询期货持仓数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}`
        }]
      };
    }
  }
};

function formatFuturesHolding(data: Record<string, any>[], tradeDate: string, symbol?: string): string {
  const symbols = symbol ? [symbol] : [...new Set(data.map(r => r.symbol))].sort();

  let out = `# 📊 期货持仓数据 — ${tradeDate}`;
  if (symbol) out += ` (${symbol})`;
  out += `\n\n`;

  for (const sym of symbols) {
    const rows = data.filter(r => r.symbol === sym);
    if (!rows.length) continue;

    const totalLong = rows.reduce((s, r) => s + (parseFloat(r.long_hld) || 0), 0);
    const totalShort = rows.reduce((s, r) => s + (parseFloat(r.short_hld) || 0), 0);

    out += `## ${sym}\n\n`;
    out += `多头合计: ${totalLong.toFixed(0)} 手 | 空头合计: ${totalShort.toFixed(0)} 手\n\n`;
    out += `| 期货公司 | 多头持仓 | 多头变化 | 空头持仓 | 空头变化 |\n`;
    out += `|---------|---------|---------|---------|--------|\n`;
    rows.forEach(r => {
      const n = (v: any) => v != null && v !== '' ? String(v) : 'N/A';
      const chg = (v: any) => {
        const num = parseFloat(v);
        if (isNaN(num)) return 'N/A';
        return num > 0 ? `+${num}` : String(num);
      };
      out += `| ${n(r.broker)} | ${n(r.long_hld)} | ${chg(r.long_chg)} | ${n(r.short_hld)} | ${chg(r.short_chg)} |\n`;
    });
    out += `\n`;
  }

  out += `---\n*数据来源: Tushare fut_holding*`;
  return out;
}
