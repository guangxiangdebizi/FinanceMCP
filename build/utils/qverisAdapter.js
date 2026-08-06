import { callQverisCapability, createQverisSessionId, discoverQverisCapabilities, inspectQverisCapabilities, probeQverisCapability, QverisClientError, } from './qverisClient.js';
export class QverisUnsupportedError extends Error {
    constructor(message = 'Qveris 暂未覆盖该工具或参数组合') {
        super(message);
        this.name = 'QverisUnsupportedError';
    }
}
const COMPANY_QUERIES = {
    forecast: 'read-only company earnings estimates and forecast API',
    express: 'read-only company earnings results and surprise API',
    indicators: 'read-only company financial ratios and key metrics API',
    dividend: 'read-only company dividend history API',
    mainbz: 'read-only company revenue segment breakdown API',
    holder_number: 'read-only company shareholder count API',
    holder_trade: 'read-only company insider transaction API',
    audit: 'read-only company regulatory filings metadata API',
    company_basic: 'read-only company profile API',
    balance_basic: 'read-only company balance sheet API',
    balance_all: 'read-only company balance sheet API',
    cashflow_basic: 'read-only company cash flow statement API',
    cashflow_all: 'read-only company cash flow statement API',
    income_basic: 'read-only company income statement API',
    income_all: 'read-only company income statement API',
    share_float: 'read-only company corporate actions API',
    repurchase: 'read-only company share repurchase API',
    top10_holders: 'read-only company institutional ownership API',
    top10_floatholders: 'read-only company institutional ownership API',
    daily_basic: 'read-only company valuation ratios API',
    stk_basic: 'read-only security master and company profile API',
    ipo: 'read-only IPO calendar API',
};
function cleanString(value, maxLength = 400) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed))
        return undefined;
    return trimmed;
}
function cleanSymbol(value) {
    const symbol = cleanString(value, 40)?.toUpperCase();
    if (!symbol || symbol.includes('..') || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(symbol))
        return undefined;
    return symbol;
}
function cleanDate(value) {
    const date = cleanString(value, 32);
    if (!date || !/^\d{8}(?:\d{6})?$|^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(date))
        return undefined;
    return date;
}
function cleanQuery(value) {
    const query = cleanString(value, 200);
    if (!query || /[<>{}]/.test(query))
        return undefined;
    return query;
}
function companyPlan(name, args) {
    const dataType = cleanString(args.data_type)?.toLowerCase();
    const statementQueries = {
        income: 'read-only company income statement API',
        balance: 'read-only company balance sheet API',
        cashflow: 'read-only company cash flow statement API',
        indicator: 'read-only company financial ratios and key metrics API',
    };
    const discoveryQuery = name === 'company_performance'
        ? (dataType ? COMPANY_QUERIES[dataType] : undefined)
        : (dataType ? statementQueries[dataType] : undefined);
    if (!discoveryQuery)
        return undefined;
    const symbol = cleanSymbol(args.ts_code);
    if (args.ts_code !== undefined && !symbol)
        return undefined;
    return {
        title: '公司与财务数据',
        discoveryQuery,
        request: {
            symbol,
            startDate: cleanDate(args.start_date),
            endDate: cleanDate(args.end_date),
            reportPeriod: cleanDate(args.period),
            market: name.endsWith('_hk') ? 'hk' : name.endsWith('_us') ? 'us' : 'cn',
            limit: 20,
        },
    };
}
export function getQverisToolPlan(name, args) {
    for (const field of ['start_date', 'end_date', 'period', 'start_datetime', 'end_datetime']) {
        if (args[field] !== undefined && args[field] !== null && args[field] !== '' && !cleanDate(args[field])) {
            return undefined;
        }
    }
    if (name === 'stock_data') {
        if (cleanString(args.indicators))
            return undefined;
        const market = cleanString(args.market_type, 24)?.toLowerCase();
        const timeframe = cleanString(args.timeframe)?.toLowerCase() || 'daily';
        const symbol = cleanSymbol(args.code);
        if (!symbol
            || !market
            || !['cn', 'us', 'hk', 'fx', 'futures', 'fund', 'repo', 'convertible_bond', 'options', 'crypto'].includes(market)
            || !['daily', 'weekly', 'monthly'].includes(timeframe))
            return undefined;
        const asset = market === 'crypto' ? 'cryptocurrency' : `${market} market security`;
        return {
            title: '历史行情数据',
            discoveryQuery: `read-only ${asset} historical ${timeframe} OHLCV price API`,
            request: {
                symbol,
                startDate: cleanDate(args.start_date),
                endDate: cleanDate(args.end_date),
                interval: timeframe,
                market,
                limit: 200,
            },
        };
    }
    if (name === 'stock_data_minutes') {
        const market = cleanString(args.market_type, 24)?.toLowerCase();
        const symbol = cleanSymbol(args.code);
        const interval = cleanString(args.freq)?.toLowerCase();
        if (!symbol
            || !market
            || !['cn', 'crypto'].includes(market)
            || !interval
            || !['1min', '1m', '5min', '5m', '15min', '15m', '30min', '30m', '60min', '60m', '1h'].includes(interval))
            return undefined;
        return {
            title: '分钟行情数据',
            discoveryQuery: `read-only ${market === 'crypto' ? 'cryptocurrency' : 'stock'} intraday OHLCV API`,
            request: {
                symbol,
                startDate: cleanDate(args.start_datetime),
                endDate: cleanDate(args.end_datetime),
                interval,
                market,
                limit: 500,
            },
        };
    }
    if (name === 'index_data') {
        const dataType = cleanString(args.data_type)?.toLowerCase() || 'daily';
        const symbol = cleanSymbol(args.code);
        if (!symbol || !['daily', 'weekly', 'monthly', 'global', 'basic', 'valuation'].includes(dataType))
            return undefined;
        const query = dataType === 'basic'
            ? 'read-only stock index metadata API'
            : dataType === 'valuation'
                ? 'read-only stock index valuation metrics API'
                : 'read-only stock index historical OHLCV levels API';
        return {
            title: '指数数据',
            discoveryQuery: query,
            request: {
                symbol,
                startDate: cleanDate(args.start_date),
                endDate: cleanDate(args.end_date),
                interval: dataType,
                limit: 200,
            },
        };
    }
    if (name === 'macro_econ') {
        const indicator = cleanString(args.indicator)?.toLowerCase();
        if (!indicator || !['shibor', 'lpr', 'gdp', 'cpi', 'ppi', 'cn_m', 'cn_pmi', 'cn_sf', 'shibor_quote', 'libor', 'hibor'].includes(indicator))
            return undefined;
        return {
            title: '宏观经济数据',
            discoveryQuery: `read-only ${indicator} macroeconomic time series API`,
            request: {
                indicator,
                query: indicator,
                startDate: cleanDate(args.start_date),
                endDate: cleanDate(args.end_date),
                limit: 100,
            },
        };
    }
    if (name === 'finance_news') {
        const query = cleanQuery(args.query);
        if (!query)
            return undefined;
        return {
            title: '财经新闻',
            discoveryQuery: 'read-only financial news search API',
            request: { query, limit: 20 },
        };
    }
    if (name === 'hot_news_7x24') {
        return {
            title: '7x24 财经热点',
            discoveryQuery: 'read-only latest real-time financial market news API',
            request: { query: 'latest financial market news', limit: 30 },
        };
    }
    if (['company_performance', 'company_performance_hk', 'company_performance_us'].includes(name)) {
        return companyPlan(name, args);
    }
    if (name === 'csi_index_constituents') {
        const symbol = cleanSymbol(args.index_code);
        if (!symbol)
            return undefined;
        return {
            title: '指数成分数据',
            discoveryQuery: 'read-only stock index constituents and weights API',
            request: {
                symbol,
                startDate: cleanDate(args.start_date),
                endDate: cleanDate(args.end_date),
                limit: 500,
            },
        };
    }
    return undefined;
}
function normalizeName(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function formatDate(value, parameter) {
    if (!value)
        return undefined;
    const digits = value.replace(/\D/g, '');
    if (digits.length < 8)
        return value;
    const dateOnly = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    const description = `${parameter.type ?? ''} ${parameter.description ?? ''}`.toLowerCase();
    if (description.includes('yyyy-mm-dd') || parameter.type === 'date')
        return dateOnly;
    if (digits.length >= 14 && /time|datetime/.test(description)) {
        return `${dateOnly} ${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
    }
    return digits.slice(0, 8);
}
function marketValue(market) {
    const values = {
        cn: 'China',
        us: 'US',
        hk: 'Hong Kong',
        crypto: 'crypto',
        fx: 'forex',
    };
    return market ? values[market] ?? market : undefined;
}
function intervalCandidates(interval) {
    const value = interval?.toLowerCase();
    if (!value)
        return [];
    const mapping = {
        daily: ['daily', '1day', '1d', 'd'],
        weekly: ['weekly', '1week', '1wk', 'w'],
        monthly: ['monthly', '1month', '1mo', 'm'],
        '1min': ['1min', '1m'],
        '5min': ['5min', '5m'],
        '15min': ['15min', '15m'],
        '30min': ['30min', '30m'],
        '60min': ['60min', '1h'],
    };
    return mapping[value] ?? [value];
}
function chooseEnum(parameter, candidates) {
    if (!Array.isArray(parameter.enum) || parameter.enum.length === 0)
        return candidates[0];
    for (const candidate of candidates) {
        const match = parameter.enum.find(value => String(value).toLowerCase() === String(candidate).toLowerCase());
        if (match !== undefined)
            return match;
    }
    return undefined;
}
function reportPeriodValue(period, parameter) {
    if (!period)
        return undefined;
    const annual = period.replace(/\D/g, '').endsWith('1231');
    return chooseEnum(parameter, annual ? ['annual', 'FY', 'year'] : ['quarter', 'quarterly']);
}
function symbolForProvider(symbol, capability, parameter, market) {
    if (!symbol)
        return undefined;
    const toolId = capability.tool_id.toLowerCase();
    const description = (parameter.description ?? '').toLowerCase();
    if (toolId.startsWith('eodhd.') || description.includes('eodhd format')) {
        if (market === 'us' && !symbol.includes('.'))
            return `${symbol}.US`;
    }
    return symbol;
}
function mapParameter(parameter, capability, request) {
    const name = normalizeName(parameter.name);
    const description = (parameter.description ?? '').toLowerCase();
    if (['symbol', 'ticker', 'tickers', 'code', 'tscode', 'security', 'instrument', 'pair'].includes(name)) {
        return symbolForProvider(request.symbol, capability, parameter, request.market);
    }
    if (name === 's') {
        return symbolForProvider(request.symbol, capability, parameter, request.market);
    }
    if (['query', 'keyword', 'keywords', 'search', 'searchquery', 'topic'].includes(name)) {
        return request.query ?? request.indicator;
    }
    if (name === 'q') {
        if (/ticker|symbol|instrument|security/.test(description)) {
            return symbolForProvider(request.symbol, capability, parameter, request.market);
        }
        return request.query ?? request.indicator ?? request.symbol;
    }
    if (['indicator', 'series', 'seriesid', 'metric'].includes(name)) {
        return request.indicator ?? request.query;
    }
    if (['startdate', 'datefrom', 'fromdate', 'from', 'start', 'filterdatefrom', 'starttime', 'startdatetime'].includes(name)) {
        return formatDate(request.startDate, parameter);
    }
    if (['enddate', 'dateto', 'todate', 'to', 'end', 'filterdateto', 'endtime', 'enddatetime'].includes(name)) {
        return formatDate(request.endDate, parameter);
    }
    if (['interval', 'frequency', 'freq', 'timeframe', 'timespan', 'resolution', 'g'].includes(name)) {
        return chooseEnum(parameter, intervalCandidates(request.interval));
    }
    if (name === 'period') {
        return reportPeriodValue(request.reportPeriod, parameter)
            ?? chooseEnum(parameter, intervalCandidates(request.interval));
    }
    if (['limit', 'count', 'size', 'pagesize', 'pagelimit', 'maxresults'].includes(name)) {
        return request.limit;
    }
    if (name === 'category')
        return chooseEnum(parameter, ['general', 'business', 'forex', 'crypto']);
    if (['market', 'country', 'region', 'exchange'].includes(name))
        return marketValue(request.market);
    if (['fmt', 'format', 'datatype', 'outputformat'].includes(name))
        return chooseEnum(parameter, ['json']);
    const start = request.startDate?.replace(/\D/g, '');
    const end = request.endDate?.replace(/\D/g, '');
    if (capability.tool_id.startsWith('eodhd.table.csv.') && start && end) {
        const components = {
            a: String(Number(start.slice(4, 6)) - 1),
            b: String(Number(start.slice(6, 8))),
            c: start.slice(0, 4),
            d: String(Number(end.slice(4, 6)) - 1),
            e: String(Number(end.slice(6, 8))),
            f: end.slice(0, 4),
        };
        if (components[name])
            return components[name];
    }
    if (parameter.default !== undefined)
        return parameter.default;
    return undefined;
}
function convertType(value, parameter) {
    if (value === undefined)
        return undefined;
    const type = parameter.type?.toLowerCase();
    if (type === 'number' || type === 'integer') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? (type === 'integer' ? Math.floor(parsed) : parsed) : undefined;
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean')
            return value;
        if (String(value).toLowerCase() === 'true')
            return true;
        if (String(value).toLowerCase() === 'false')
            return false;
        return undefined;
    }
    return value;
}
function mapCapabilityParameters(capability, request) {
    const parameters = {};
    for (const parameter of capability.params ?? []) {
        if (!parameter?.name)
            continue;
        const value = convertType(mapParameter(parameter, capability, request), parameter);
        if (value !== undefined && value !== '') {
            parameters[parameter.name] = value;
        }
        else if (parameter.required) {
            return undefined;
        }
    }
    return parameters;
}
function expectedCost(capability) {
    const billingAmount = capability.billing_rule?.amount_credits;
    if (typeof billingAmount === 'number' && Number.isFinite(billingAmount))
        return billingAmount;
    const parsed = Number.parseFloat(String(capability.expected_cost ?? ''));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function isReadOnlyCapability(capability) {
    const text = `${capability.tool_id} ${capability.name ?? ''} ${capability.description ?? ''}`.toLowerCase();
    const mutatingAction = /(?:place|submit|create|cancel|modify|update|delete|send|execute|transfer|withdraw|deposit|buy|sell)\s+(?:an?\s+)?(?:order|trade|payment|transaction|account|position|post|message|funds?)/;
    if (mutatingAction.test(text))
        return false;
    const requiredNames = new Set((capability.params ?? [])
        .filter(parameter => parameter.required)
        .map(parameter => normalizeName(parameter.name)));
    const hasTradingSide = requiredNames.has('side') || requiredNames.has('orderside');
    const hasTradingAmount = ['quantity', 'qty', 'amount', 'orderquantity'].some(name => requiredNames.has(name));
    return !(hasTradingSide && hasTradingAmount);
}
function safeProviderName(capability) {
    const provider = cleanString(capability.provider_name)
        ?? capability.tool_id.split('.')[0]
        ?? 'unknown';
    return provider.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 80) || 'unknown';
}
function formatExecution(plan, capability, execution) {
    const metadata = {
        provider: safeProviderName(capability),
        capability: cleanString(capability.name) ?? capability.tool_id,
        tool_id: capability.tool_id,
        execution_id: execution.execution_id,
        cost: execution.cost,
        remaining_credits: execution.remaining_credits,
    };
    const result = execution.result ?? null;
    let text = `# ${plan.title}\n\n`;
    text += `${JSON.stringify({ metadata, result }, null, 2)}\n`;
    if (text.length > 30000) {
        text = `${text.slice(0, 30000)}\n\n[FinanceMCP: Qveris 返回内容已截断]`;
    }
    return { content: [{ type: 'text', text }] };
}
export async function runQverisForExistingTool(name, args) {
    const plan = getQverisToolPlan(name, args);
    if (!plan)
        throw new QverisUnsupportedError();
    const sessionId = createQverisSessionId();
    const discovered = await discoverQverisCapabilities({
        query: plan.discoveryQuery,
        limit: 8,
        sessionId,
    });
    if (discovered.results.length === 0)
        throw new QverisUnsupportedError('Qveris 未发现匹配的金融数据能力');
    const inspected = await inspectQverisCapabilities({
        toolIds: discovered.results.map(result => result.tool_id),
        searchId: discovered.search_id,
        sessionId,
    });
    const capabilities = (inspected.results.length ? inspected.results : discovered.results)
        .filter(isReadOnlyCapability)
        .map((capability, index) => ({
        capability,
        parameters: mapCapabilityParameters(capability, plan.request),
        rank: index,
    }))
        .filter((item) => Boolean(item.parameters))
        .sort((left, right) => {
        const costDifference = expectedCost(left.capability) - expectedCost(right.capability);
        return Number.isFinite(costDifference) && costDifference !== 0 ? costDifference : left.rank - right.rank;
    });
    let selected;
    for (const candidate of capabilities.slice(0, 6)) {
        try {
            const probe = await probeQverisCapability({
                toolId: candidate.capability.tool_id,
                parameters: candidate.parameters,
            });
            if (probe.schema?.valid === false)
                continue;
            selected = candidate;
            break;
        }
        catch (error) {
            if (error instanceof QverisClientError && error.kind === 'request')
                continue;
            throw error;
        }
    }
    if (!selected) {
        throw new QverisUnsupportedError('Qveris 当前候选接口无法匹配现有工具参数');
    }
    // Probe 可检查多个候选；Call 可能计费，因此每次 MCP 调用最多执行一次。
    const execution = await callQverisCapability({
        toolId: selected.capability.tool_id,
        searchId: discovered.search_id,
        parameters: selected.parameters,
        sessionId,
    });
    if (execution.success === false) {
        throw new QverisClientError('request', 'Qveris Provider 未返回可用结果');
    }
    return formatExecution(plan, selected.capability, execution);
}
