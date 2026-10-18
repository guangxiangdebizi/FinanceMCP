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
import { routeToolCall } from './utils/dataSourceRouter.js';
import { isToolSourceAvailable, ToolSource } from './toolAvailability.js';
import { getConfiguredCredentialSources, getSourcePriority } from './config.js';
import { ashareToolDefinitions, ASHARE_TOOL_NAMES, PORTFOLIO_TOOL_NAMES, portfolioToolDefinitions } from './ashare/definitions.js';
import { isPrivateToolExposed, isToolExposed } from './toolProfile.js';

/** 条件化配置比较工具：只在私有端点提供，公网不暴露。 */
export const DECISION_TOOL_NAME = 'ashare_portfolio_decision';

export const toolList = [
  { name: timestampTool.name, description: timestampTool.description, inputSchema: timestampTool.parameters },
  { name: financeNews.name, description: financeNews.description, inputSchema: financeNews.parameters },
  { name: stockData.name, description: stockData.description, inputSchema: stockData.parameters },
  { name: stockDataMinutes.name, description: stockDataMinutes.description, inputSchema: stockDataMinutes.parameters },
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
  { name: hotNews.name, description: hotNews.description, inputSchema: hotNews.parameters },
  { name: futuresData.name, description: futuresData.description, inputSchema: futuresData.parameters },
];

// Keep this mapping explicit: it is the contract used by tools/list and by the
// direct-call guard. Qveris coverage mirrors getQverisToolPlan in qverisAdapter.
const TOOL_SOURCES: Record<string, readonly ToolSource[]> = {
  current_timestamp: ['local'],
  finance_news: ['twingly', 'qveris', 'web'],
  stock_data: ['tushare', 'qveris', 'binance'],
  stock_data_minutes: ['tushare', 'qveris', 'binance'],
  index_data: ['tushare', 'qveris'],
  macro_econ: ['tushare', 'qveris'],
  company_performance: ['tushare', 'qveris'],
  fund_data: ['tushare'],
  fund_manager_by_name: ['tushare'],
  convertible_bond: ['tushare'],
  block_trade: ['tushare'],
  money_flow: ['tushare'],
  margin_trade: ['tushare'],
  company_performance_hk: ['tushare', 'qveris'],
  company_performance_us: ['tushare', 'qveris'],
  csi_index_constituents: ['tushare', 'qveris'],
  dragon_tiger_inst: ['tushare'],
  hot_news_7x24: ['tushare', 'twingly', 'qveris'],
  futures_data: ['tushare'],
};

function toolSources(name: string): readonly ToolSource[] {
  // New tools default to a credential-backed source until explicitly mapped.
  return TOOL_SOURCES[name] ?? ['tushare'];
}

function primaryCredentialSource(name: string): ToolSource | undefined {
  const configured = new Set<string>(getConfiguredCredentialSources());
  const supported = toolSources(name);
  return getSourcePriority().find(source => configured.has(source) && supported.includes(source));
}

function contextualizeTool(tool: (typeof toolList)[number]) {
  if (tool.name !== 'hot_news_7x24' || primaryCredentialSource(tool.name) !== 'twingly') {
    return tool;
  }

  const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
  const limit = properties?.limit as Record<string, unknown> | undefined;
  return {
    ...tool,
    description: `${tool.description}。当前请求将优先使用 Twingly，因此 limit 最大为250`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        limit: {
          ...limit,
          description: '返回条数，默认100；当前首选数据源为 Twingly，最大250',
          maximum: 250,
        },
      },
    },
  };
}

/** 公网/本地入口对账户工具的统一拒绝原因码。 */
export const PRIVATE_ENDPOINT_REQUIRED = 'private_endpoint_required';

function privateEndpointError(name: string): Error {
  return new Error(
    `${PRIVATE_ENDPOINT_REQUIRED}: ${name} 是私有账户工具，只能通过已认证的私有端点调用`
    + '（设置 ASHARE_PRIVATE_PORTFOLIO_TOKEN 后使用 /private/mcp）；公网 /mcp 永远不提供账户数据。'
  );
}

export function isToolAvailable(name: string): boolean {
  // 账户工具不属于任何公网/本地工具面：它们只存在于私有端点（见 getPrivateToolList）。
  if (PORTFOLIO_TOOL_NAMES.has(name)) return false;
  if (ASHARE_TOOL_NAMES.has(name)) return isToolExposed(name);
  return toolList.some(tool => tool.name === name)
    && isToolExposed(name)
    && isToolSourceAvailable(toolSources(name));
}

export function getAvailableToolList() {
  // A-share tools read the local cache only, so request credentials do not scope them.
  const ashareTools = ashareToolDefinitions.filter(tool => isToolExposed(tool.name));
  // 账户工具**永不**进入公网 tools/list：即使 ASHARE_PORTFOLIO_ENABLED=1 也只在
  // 私有端点（getPrivateToolList）出现，避免匿名端点泄露账户数量、成本与持仓。
  return [
    ...toolList
      .filter(tool => isToolExposed(tool.name) && isToolSourceAvailable(toolSources(tool.name)))
      .map(contextualizeTool),
    ...ashareTools,
  ];
}

/**
 * 私有端点工具清单：只包含账户工具。与 `getAvailableToolList()` 成对使用，
 * 公网路径完全不经过这里，因此两者并发时不会互相影响（没有任何共享可变状态）。
 */
export function getPrivateToolList() {
  return portfolioToolDefinitions
    .filter(tool => isPrivateToolExposed(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
}

export function assertToolAvailable(name: string): void {
  if (PORTFOLIO_TOOL_NAMES.has(name)) throw privateEndpointError(name);
  if (!toolList.some(tool => tool.name === name) && !ASHARE_TOOL_NAMES.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (!isToolAvailable(name)) {
    throw new Error(`Tool ${name} is not available for the configured API credentials or tool profile`);
  }
}

async function dispatchNativeTool(name: string, args: Record<string, any>): Promise<any> {
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

export async function dispatchTool(name: string, args: Record<string, any>): Promise<any> {
  // 公网/本地入口：账户工具在这里被硬拒绝（assertToolAvailable 抛 private_endpoint_required）。
  assertToolAvailable(name);
  if (ASHARE_TOOL_NAMES.has(name)) {
    // Local analysis tools never enter the external data-source fallback router.
    const { runAshareTool } = await import('./ashare/tools.js');
    return runAshareTool(name, args);
  }
  return routeToolCall(name, args, () => dispatchNativeTool(name, args));
}

/**
 * 私有端点入口。与 `dispatchTool` 成对：这里**只**接受账户工具，任何市场工具都被
 * 明确拒绝；公网入口则相反。两者没有共享可变状态，因此并发请求不会互相串工具集。
 */
export async function dispatchPrivateTool(name: string, args: Record<string, any>): Promise<any> {
  if (!PORTFOLIO_TOOL_NAMES.has(name)) {
    throw new Error(`market_tool_not_available_on_private_endpoint: ${name} 是市场工具，私有 /private/mcp 只提供账户工具`);
  }
  if (!isPrivateToolExposed(name)) {
    throw new Error(`Tool ${name} is not exposed by the configured tool profile`);
  }
  if (name === DECISION_TOOL_NAME) {
    const { runDecisionTool } = await import('./portfolio/decisionTool.js');
    return runDecisionTool(args ?? {});
  }
  // 账户账本工具（summary/scenario 及后续新增的 ledger 工具）统一走 portfolio/tools.ts。
  const { runPortfolioTool } = await import('./portfolio/tools.js');
  return runPortfolioTool(name, args ?? {});
}

