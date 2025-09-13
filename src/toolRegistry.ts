#!/usr/bin/env node
import { financeNews } from "./tools/financeNews.js";
import { stockData } from "./tools/stockData.js";
import { indexData } from "./tools/indexData.js";
import { macroEcon } from "./tools/macroEcon.js";
import { companyPerformance } from "./tools/companyPerformance.js";
import { fundData } from "./tools/fundData.js";
import { fundManagerByName, runFundManagerByName } from "./tools/fundManagerByName.js";
import { convertibleBond } from "./tools/convertibleBond.js";
import { blockTrade } from "./tools/blockTrade.js";
import { moneyFlow } from "./tools/moneyFlow.js";
import { marginTrade } from "./tools/marginTrade.js";
import { companyPerformance_hk } from "./tools/companyPerformance_hk.js";
import { companyPerformance_us } from "./tools/companyPerformance_us.js";
import { csiIndexConstituents } from "./tools/csiIndexConstituents.js";
import { dragonTigerInst } from "./tools/dragonTigerInst.js";
import { hotNews } from "./tools/hotNews.js";
import { runWithRequestContext } from "./config.js";

// 时间戳工具（保留）
const timestampTool = {
  name: "current_timestamp",
  description: "获取当前东八区（中国时区）的时间戳，包括年月日时分秒信息",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "时间格式，可选值：datetime(完整日期时间，默认)、date(仅日期)、time(仅时间)、timestamp(Unix时间戳)、readable(可读格式)"
      }
    }
  },
  async run(args?: { format?: string }) {
    const now = new Date();
    const chinaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const format = args?.format || 'datetime';
    const pad = (n: number) => n.toString().padStart(2, '0');
    const y = chinaTime.getUTCFullYear();
    const m = pad(chinaTime.getUTCMonth() + 1);
    const d = pad(chinaTime.getUTCDate());
    const hh = pad(chinaTime.getUTCHours());
    const mm = pad(chinaTime.getUTCMinutes());
    const ss = pad(chinaTime.getUTCSeconds());
    const weekdays = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
    const wd = weekdays[chinaTime.getUTCDay()];
    let result = `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    if (format === 'date') result = `${y}-${m}-${d}`;
    if (format === 'time') result = `${hh}:${mm}:${ss}`;
    if (format === 'timestamp') result = Math.floor(chinaTime.getTime()/1000).toString();
    if (format === 'readable') result = `${y}年${m}月${d}日 ${wd} ${hh}时${mm}分${ss}秒`;
    return { content: [{ type: 'text', text: `## 🕐 当前东八区时间\n\n格式: ${format}\n时间: ${result}\n星期: ${wd}` }] };
  }
};

export const toolList = [
  { name: timestampTool.name, description: timestampTool.description, inputSchema: timestampTool.parameters },
  { name: financeNews.name, description: financeNews.description, inputSchema: financeNews.parameters },
  { name: stockData.name, description: stockData.description, inputSchema: stockData.parameters },
  { name: indexData.name, description: indexData.description, inputSchema: indexData.parameters },
  { name: macroEcon.name, description: macroEcon.description, inputSchema: macroEcon.parameters },
  { name: companyPerformance.name, description: companyPerformance.description, inputSchema: companyPerformance.parameters },
  { name: fundData.name, description: fundData.description, inputSchema: fundData.parameters },
  { name: fundManagerByName.name, description: fundManagerByName.description, inputSchema: (fundManagerByName as any).inputSchema },
  { name: convertibleBond.name, description: convertibleBond.description, inputSchema: convertibleBond.parameters },
  { name: blockTrade.name, description: blockTrade.description, inputSchema: blockTrade.parameters },
  { name: moneyFlow.name, description: moneyFlow.description, inputSchema: moneyFlow.parameters },
  { name: marginTrade.name, description: marginTrade.description, inputSchema: marginTrade.parameters },
  { name: companyPerformance_hk.name, description: companyPerformance_hk.description, inputSchema: companyPerformance_hk.parameters },
  { name: companyPerformance_us.name, description: companyPerformance_us.description, inputSchema: companyPerformance_us.parameters },
  { name: csiIndexConstituents.name, description: csiIndexConstituents.description, inputSchema: csiIndexConstituents.parameters },
  { name: dragonTigerInst.name, description: dragonTigerInst.description, inputSchema: dragonTigerInst.parameters },
  { name: hotNews.name, description: hotNews.description, inputSchema: hotNews.parameters }
];

export async function callTool(name: string, args: any, tushareToken?: string) {
  const toolArgs = args?.args || args;
  console.log(`Calling tool: ${name} with args:`, toolArgs);
  return await runWithRequestContext({ tushareToken }, async () => {
    switch (name) {
      case 'current_timestamp':
        return await timestampTool.run({ format: toolArgs?.format ? String(toolArgs.format) : undefined });
      case 'finance_news':
        return await financeNews.run({
          query: String(toolArgs?.query)
        });
      case 'stock_data':
        return await stockData.run({
          code: String(toolArgs?.code),
          market_type: String(toolArgs?.market_type),
          start_date: toolArgs?.start_date ? String(toolArgs.start_date) : undefined,
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
          indicators: toolArgs?.indicators ? String(toolArgs.indicators) : undefined,
        });
      case 'index_data':
        return await indexData.run({
          code: String(toolArgs?.code),
          start_date: toolArgs?.start_date ? String(toolArgs.start_date) : undefined,
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
        });
      case 'macro_econ':
        return await macroEcon.run({
          indicator: String(toolArgs?.indicator),
          start_date: toolArgs?.start_date ? String(toolArgs.start_date) : undefined,
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
        });
      case 'company_performance':
        return await companyPerformance.run({
          ts_code: String(toolArgs?.ts_code),
          data_type: String(toolArgs?.data_type),
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
          period: toolArgs?.period ? String(toolArgs.period) : undefined,
        });
      case 'fund_data':
        return await fundData.run({
          ts_code: toolArgs?.ts_code ? String(toolArgs.ts_code) : undefined,
          data_type: String(toolArgs?.data_type),
          start_date: toolArgs?.start_date ? String(toolArgs.start_date) : undefined,
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
          period: toolArgs?.period ? String(toolArgs.period) : undefined,
        });
      case 'fund_manager_by_name':
        return await runFundManagerByName({
          name: String(toolArgs?.name),
          ann_date: toolArgs?.ann_date ? String(toolArgs.ann_date) : undefined,
        });
      case 'convertible_bond':
        return await convertibleBond.run({
          ts_code: toolArgs?.ts_code ? String(toolArgs.ts_code) : undefined,
          data_type: String(toolArgs?.data_type),
          start_date: toolArgs?.start_date ? String(toolArgs.start_date) : undefined,
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
        });
      case 'block_trade':
        return await blockTrade.run({
          code: toolArgs?.code ? String(toolArgs.code) : undefined,
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
        });
      case 'money_flow':
        return await moneyFlow.run({
          ts_code: toolArgs?.ts_code ? String(toolArgs.ts_code) : undefined,
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
        });
      case 'margin_trade':
        return await marginTrade.run({
          data_type: String(toolArgs?.data_type),
          ts_code: toolArgs?.ts_code ? String(toolArgs.ts_code) : undefined,
          start_date: String(toolArgs?.start_date),
          end_date: toolArgs?.end_date ? String(toolArgs.end_date) : undefined,
          exchange: toolArgs?.exchange ? String(toolArgs.exchange) : undefined,
        });
      case 'company_performance_hk':
        return await companyPerformance_hk.run({
          ts_code: String(toolArgs?.ts_code),
          data_type: String(toolArgs?.data_type),
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
          period: toolArgs?.period ? String(toolArgs.period) : undefined,
          ind_name: toolArgs?.ind_name ? String(toolArgs.ind_name) : undefined,
        });
      case 'company_performance_us':
        return await companyPerformance_us.run({
          ts_code: String(toolArgs?.ts_code),
          data_type: String(toolArgs?.data_type),
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
          period: toolArgs?.period ? String(toolArgs.period) : undefined,
        });
      case 'csi_index_constituents':
        return await csiIndexConstituents.run({
          index_code: String(toolArgs?.index_code),
          start_date: String(toolArgs?.start_date),
          end_date: String(toolArgs?.end_date),
        });
      case 'dragon_tiger_inst':
        return await dragonTigerInst.run({
          trade_date: String(toolArgs?.trade_date),
          ts_code: toolArgs?.ts_code ? String(toolArgs.ts_code) : undefined,
        });
      case 'hot_news_7x24':
        return await hotNews.run({});
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}