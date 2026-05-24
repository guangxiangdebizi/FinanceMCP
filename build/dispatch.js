import { timestampTool } from './tools/timestampTool.js';
import { financeNews } from './tools/financeNews.js';
import { stockData } from './tools/stockData.js';
import { stockDataMinutes } from './tools/stockDataMinutes.js';
import { indexData } from './tools/indexData.js';
import { macroEcon } from './tools/macroEcon.js';
import { companyPerformance } from './tools/companyPerformance.js';
import { fundData } from './tools/fundData.js';
import { fundManagerByName, runFundManagerByName } from './tools/fundManagerByName.js';
import { convertibleBond } from './tools/convertibleBond.js';
import { blockTrade } from './tools/blockTrade.js';
import { moneyFlow } from './tools/moneyFlow.js';
import { marginTrade } from './tools/marginTrade.js';
import { companyPerformance_hk } from './tools/companyPerformance_hk.js';
import { companyPerformance_us } from './tools/companyPerformance_us.js';
import { csiIndexConstituents } from './tools/csiIndexConstituents.js';
import { dragonTigerInst } from './tools/dragonTigerInst.js';
import { hotNews } from './tools/hotNews.js';
import { futuresData } from './tools/futuresData.js';
export const toolList = [
    { name: timestampTool.name, description: timestampTool.description, inputSchema: timestampTool.parameters },
    { name: financeNews.name, description: financeNews.description, inputSchema: financeNews.parameters },
    { name: stockData.name, description: stockData.description, inputSchema: stockData.parameters },
    { name: stockDataMinutes.name, description: stockDataMinutes.description, inputSchema: stockDataMinutes.parameters },
    { name: indexData.name, description: indexData.description, inputSchema: indexData.parameters },
    { name: macroEcon.name, description: macroEcon.description, inputSchema: macroEcon.parameters },
    { name: companyPerformance.name, description: companyPerformance.description, inputSchema: companyPerformance.parameters },
    { name: fundData.name, description: fundData.description, inputSchema: fundData.parameters },
    { name: fundManagerByName.name, description: fundManagerByName.description, inputSchema: fundManagerByName.inputSchema },
    { name: convertibleBond.name, description: convertibleBond.description, inputSchema: convertibleBond.parameters },
    { name: blockTrade.name, description: blockTrade.description, inputSchema: blockTrade.parameters },
    { name: moneyFlow.name, description: moneyFlow.description, inputSchema: moneyFlow.parameters },
    { name: marginTrade.name, description: marginTrade.description, inputSchema: marginTrade.parameters },
    { name: companyPerformance_hk.name, description: companyPerformance_hk.description, inputSchema: companyPerformance_hk.parameters },
    { name: companyPerformance_us.name, description: companyPerformance_us.description, inputSchema: companyPerformance_us.parameters },
    { name: csiIndexConstituents.name, description: csiIndexConstituents.description, inputSchema: csiIndexConstituents.parameters },
    { name: dragonTigerInst.name, description: dragonTigerInst.description, inputSchema: dragonTigerInst.parameters },
    { name: hotNews.name, description: hotNews.description, inputSchema: hotNews.parameters },
    { name: futuresData.name, description: futuresData.description, inputSchema: futuresData.parameters },
];
export async function dispatchTool(name, args) {
    switch (name) {
        case 'current_timestamp':
            return await timestampTool.run({ format: args?.format ? String(args.format) : undefined });
        case 'finance_news':
            return await financeNews.run({ query: String(args?.query) });
        case 'stock_data':
            return await stockData.run({
                code: String(args?.code),
                market_type: String(args?.market_type),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                indicators: args?.indicators ? String(args.indicators) : undefined,
                timeframe: args?.timeframe ? String(args.timeframe) : undefined,
            });
        case 'stock_data_minutes':
            return await stockDataMinutes.run({
                code: String(args?.code),
                market_type: String(args?.market_type),
                start_datetime: String(args?.start_datetime),
                end_datetime: String(args?.end_datetime),
                freq: String(args?.freq),
            });
        case 'index_data':
            return await indexData.run({
                code: String(args?.code),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                data_type: args?.data_type ? String(args.data_type) : undefined,
            });
        case 'macro_econ':
            return await macroEcon.run({
                indicator: String(args?.indicator),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
            });
        case 'company_performance':
            return await companyPerformance.run({
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
                data_type: String(args?.data_type),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                period: args?.period ? String(args.period) : undefined,
            });
        case 'fund_data':
            return await fundData.run({
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
                data_type: String(args?.data_type),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                period: args?.period ? String(args.period) : undefined,
                trade_date: args?.trade_date ? String(args.trade_date) : undefined,
                name: args?.name ? String(args.name) : undefined,
                year: args?.year ? String(args.year) : undefined,
                quarter: args?.quarter ? String(args.quarter) : undefined,
            });
        case 'fund_manager_by_name':
            return await runFundManagerByName({
                name: String(args?.name),
                ann_date: args?.ann_date ? String(args.ann_date) : undefined,
            });
        case 'convertible_bond':
            return await convertibleBond.run({
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
                data_type: String(args?.data_type),
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                period: args?.period ? String(args.period) : undefined,
            });
        case 'block_trade':
            return await blockTrade.run({
                code: args?.code ? String(args.code) : undefined,
                start_date: String(args?.start_date),
                end_date: String(args?.end_date),
            });
        case 'money_flow':
            return await moneyFlow.run({
                query_type: args?.query_type ? String(args.query_type) : undefined,
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
                start_date: args?.start_date ? String(args.start_date) : undefined,
                end_date: args?.end_date ? String(args.end_date) : undefined,
                content_type: args?.content_type ? String(args.content_type) : undefined,
                trade_date: args?.trade_date ? String(args.trade_date) : undefined,
            });
        case 'margin_trade':
            return await marginTrade.run({
                data_type: String(args?.data_type),
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
                start_date: String(args?.start_date),
                end_date: args?.end_date ? String(args.end_date) : undefined,
                exchange: args?.exchange ? String(args.exchange) : undefined,
            });
        case 'company_performance_hk':
            return await companyPerformance_hk.run({
                ts_code: String(args?.ts_code),
                data_type: String(args?.data_type),
                start_date: String(args?.start_date),
                end_date: String(args?.end_date),
                period: args?.period ? String(args.period) : undefined,
                ind_name: args?.ind_name ? String(args.ind_name) : undefined,
            });
        case 'company_performance_us':
            return await companyPerformance_us.run({
                ts_code: String(args?.ts_code),
                data_type: String(args?.data_type),
                start_date: String(args?.start_date),
                end_date: String(args?.end_date),
                period: args?.period ? String(args.period) : undefined,
            });
        case 'csi_index_constituents':
            return await csiIndexConstituents.run({
                index_code: String(args?.index_code),
                start_date: String(args?.start_date),
                end_date: String(args?.end_date),
            });
        case 'dragon_tiger_inst':
            return await dragonTigerInst.run({
                trade_date: String(args?.trade_date),
                ts_code: args?.ts_code ? String(args.ts_code) : undefined,
            });
        case 'hot_news_7x24':
            return await hotNews.run({});
        case 'futures_data':
            return await futuresData.run({
                trade_date: String(args?.trade_date),
                symbol: args?.symbol ? String(args.symbol) : undefined,
                broker: args?.broker ? String(args.broker) : undefined,
            });
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
