import { TUSHARE_CONFIG } from '../config.js';
import { calculateMACD, calculateKDJ, calculateRSI, calculateBOLL, calculateSMA, parseIndicatorParams, formatIndicatorParams, calculateRequiredDays, calculateExtendedStartDate, filterDataToUserRange } from './stockDataDetail/index.js';
export const stockData = {
    name: "stock_data",
    description: "获取指定股票/加密资产的历史行情数据，支持A股、美股、港股、外汇、期货、基金、债券逆回购、可转债、期权、加密货币(通过CoinGecko)",
    parameters: {
        type: "object",
        properties: {
            code: {
                type: "string",
                description: "股票/合约/加密资产代码。股票示例：'000001.SZ'(A股平安银行)、'AAPL'(美股)、'00700.HK'(港股)、'USDCNH.FXCM'(外汇)、'CU2501.SHF'(期货)、'159919.SZ'(基金)、'204001.SH'(逆回购)、'113008.SH'(可转债)、'10001313.SH'(期权)。加密示例(需 market_type=crypto，Binance)：推荐标准写法 'BTCUSDT'、'ETHUSDT'、'USDCUSDT'、'FDUSDUSDT' 等；也兼容 'BTC-USDT' 或 'BTC/USDT'。常见报价币：USDT、USDC、FDUSD、TUSD、BUSD、BTC、ETH。注意：若写 'USD' 会自动映射为 'USDT'（如 'BTC-USD' → 'BTCUSDT'）。"
            },
            market_type: {
                type: "string",
                description: "市场类型（必需），可选值：cn(A股),us(美股),hk(港股),fx(外汇),futures(期货),fund(基金),repo(债券逆回购),convertible_bond(可转债),options(期权),crypto(加密货币/CoinGecko)"
            },
            start_date: {
                type: "string",
                description: "起始日期，格式为YYYYMMDD，如'20230101'"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式为YYYYMMDD，如'20230131'"
            },
            indicators: {
                type: "string",
                description: "需要计算的技术指标，多个指标用空格分隔。支持的指标：macd(MACD指标)、rsi(相对强弱指标)、kdj(随机指标)、boll(布林带)、ma(均线指标)。必须明确指定参数，例如：'macd(12,26,9) rsi(14) kdj(9,3,3) boll(20,2) ma(10)'"
            }
        },
        required: ["code", "market_type"]
    },
    async run(args) {
        try {
            // 添加调试日志
            console.log('接收到的参数:', args);
            // 检查market_type参数
            if (!args.market_type) {
                throw new Error('请指定market_type参数：cn(A股)、us(美股)、hk(港股)、fx(外汇)、futures(期货)、fund(基金)、repo(债券逆回购)、convertible_bond(可转债)、options(期权)');
            }
            const marketType = args.market_type.trim().toLowerCase();
            console.log(`使用的市场类型: ${marketType}`);
            console.log(`使用Tushare API获取${marketType}市场股票${args.code}的行情数据`);
            // 解析技术指标参数
            const requestedIndicators = args.indicators ? args.indicators.trim().split(/\s+/) : [];
            console.log('请求的技术指标:', requestedIndicators);
            // 使用全局配置中的Tushare API设置
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            // 默认参数设置
            const today = new Date();
            const defaultEndDate = today.toISOString().slice(0, 10).replace(/-/g, '');
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            const defaultStartDate = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
            // 用户请求的时间范围
            const userStartDate = args.start_date || defaultStartDate;
            const userEndDate = args.end_date || defaultEndDate;
            // 如果有技术指标请求，计算需要的历史数据并扩展获取范围
            let actualStartDate = userStartDate;
            let actualEndDate = userEndDate;
            if (requestedIndicators.length > 0) {
                const requiredDays = calculateRequiredDays(requestedIndicators);
                actualStartDate = calculateExtendedStartDate(userStartDate, requiredDays);
                console.log(`技术指标需要${requiredDays}天历史数据，扩展开始日期从 ${userStartDate} 到 ${actualStartDate}`);
            }
            // 验证市场类型
            const validMarkets = ['cn', 'us', 'hk', 'fx', 'futures', 'fund', 'repo', 'convertible_bond', 'options', 'crypto'];
            if (!validMarkets.includes(marketType)) {
                throw new Error(`不支持的市场类型: ${marketType}。支持的类型有: ${validMarkets.join(', ')}`);
            }
            // 加密货币市场（Binance）分支：
            if (marketType === 'crypto') {
                console.log(`使用 Binance 获取加密资产 ${args.code} 的逐日K线 (OHLCV)`);
                // 日期与符号解析
                const toYMD = (d) => {
                    const y = d.getUTCFullYear();
                    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(d.getUTCDate()).padStart(2, '0');
                    return `${y}${m}${day}`;
                };
                const ymdToStartMs = (s) => Date.UTC(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, parseInt(s.slice(6, 8)), 0, 0, 0, 0);
                const ymdToEndMs = (s) => Date.UTC(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, parseInt(s.slice(6, 8)), 23, 59, 59, 999);
                const idToTicker = {
                    'bitcoin': 'BTC', 'ethereum': 'ETH', 'tether': 'USDT', 'usd-coin': 'USDC', 'solana': 'SOL',
                    'binancecoin': 'BNB', 'ripple': 'XRP', 'cardano': 'ADA', 'polkadot': 'DOT', 'chainlink': 'LINK',
                    'litecoin': 'LTC', 'shiba-inu': 'SHIB', 'tron': 'TRX', 'toncoin': 'TON', 'bitcoin-cash': 'BCH',
                    'ethereum-classic': 'ETC'
                };
                const parseBinanceSymbol = (raw) => {
                    const trimmed = raw.trim();
                    const upper = trimmed.toUpperCase();
                    const validQuotes = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'BTC', 'ETH']);
                    // 已经是诸如 BTCUSDT
                    if (!upper.includes('-') && !upper.includes('/') && !upper.includes('.')) {
                        return upper;
                    }
                    // 支持 TICKER-QUOTE / TICKER/QUOTE / id.vs
                    let base = '';
                    let quote = '';
                    if (upper.includes('-') || upper.includes('/')) {
                        const sep = upper.includes('-') ? '-' : '/';
                        const [b, q] = upper.split(sep);
                        base = b;
                        quote = q;
                    }
                    else if (upper.includes('.')) {
                        const [id, vs] = upper.split('.');
                        base = idToTicker[id.toLowerCase()] || id; // id -> ticker
                        quote = vs;
                    }
                    if (quote === 'USD')
                        quote = 'USDT';
                    if (!validQuotes.has(quote)) {
                        throw new Error(`不支持的报价资产: ${quote}。支持: ${Array.from(validQuotes).join(', ')}`);
                    }
                    return `${base}${quote}`;
                };
                const symbol = parseBinanceSymbol(args.code);
                const startYmd = requestedIndicators.length > 0 ? actualStartDate : userStartDate;
                let startMs = ymdToStartMs(startYmd);
                const endMs = ymdToEndMs(userEndDate);
                const allKlines = [];
                let pageIndex = 0;
                const maxPages = 100; // 安全上限，防止极端情况下的无限循环
                while (startMs < endMs && pageIndex < maxPages) {
                    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startMs}&endTime=${endMs}&limit=1000`;
                    console.log(`Binance Klines URL[${pageIndex + 1}]:`, url);
                    const resp = await fetch(url);
                    if (!resp.ok) {
                        try {
                            const contentType = resp.headers.get('content-type') || '';
                            if (contentType.includes('application/json')) {
                                const errJson = await resp.json();
                                const errMsg = errJson?.msg || `HTTP ${resp.status}`;
                                if (Number(errJson?.code) === -1121 || /invalid symbol/i.test(String(errMsg))) {
                                    throw new Error(`Binance 无效交易对: ${symbol}。该币对在 Binance 不存在或已下线，请更换有效币对（例如：BTCUSDT、ETHUSDT、SOLUSDT）。也支持 BTC-USDT、BTC/USDT、或 coinid.USDT 写法。`);
                                }
                                throw new Error(`Binance K线请求失败: ${resp.status} - ${errMsg}`);
                            }
                            else {
                                const text = await resp.text();
                                throw new Error(`Binance K线请求失败: ${resp.status}${text ? ` - ${text}` : ''}`);
                            }
                        }
                        catch (e) {
                            if (e instanceof Error)
                                throw e;
                            throw new Error(`Binance K线请求失败: ${resp.status}`);
                        }
                    }
                    const klines = await resp.json();
                    if (!Array.isArray(klines))
                        throw new Error('Binance 返回的 K 线数据格式异常');
                    if (klines.length === 0)
                        break;
                    allKlines.push(...klines);
                    const lastOpenTime = Number(klines[klines.length - 1][0]);
                    if (!(lastOpenTime > startMs))
                        break; // 保护，避免相同时间导致死循环
                    startMs = lastOpenTime + 1; // 下一页从最后一根K线的下一毫秒开始
                    pageIndex += 1;
                    if (klines.length < 1000)
                        break; // 已取完
                }
                let stockData = allKlines.map(row => {
                    const openTime = Number(row[0]);
                    const d = toYMD(new Date(openTime));
                    return {
                        trade_date: d,
                        open: Number(row[1]),
                        high: Number(row[2]),
                        low: Number(row[3]),
                        close: Number(row[4]),
                        vol: Number(row[5])
                    };
                });
                // 若未请求技术指标，才在此处严格按用户区间过滤；
                // 若请求了技术指标，需保留扩展区间用于计算，稍后再截回用户区间
                if (requestedIndicators.length === 0) {
                    stockData = stockData.filter(r => r.trade_date >= userStartDate && r.trade_date <= userEndDate);
                }
                stockData.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
                console.log(`Binance 分页返回 共${allKlines.length} 根K线，过滤后 ${stockData.length} 条记录`);
                // 计算技术指标
                let indicators = {};
                if (requestedIndicators.length > 0) {
                    let closes = stockData.map(d => parseFloat(d.close)).reverse();
                    let highs = stockData.map(d => parseFloat(d.high)).reverse();
                    let lows = stockData.map(d => parseFloat(d.low)).reverse();
                    for (const indicator of requestedIndicators) {
                        try {
                            const { name, params } = parseIndicatorParams(indicator);
                            switch (name) {
                                case 'macd':
                                    if (params.length !== 3)
                                        throw new Error('MACD指标需要3个参数，格式：macd(快线,慢线,信号线)');
                                    indicators.macd = calculateMACD(closes, params[0], params[1], params[2]);
                                    break;
                                case 'rsi':
                                    if (params.length !== 1)
                                        throw new Error('RSI指标需要1个参数，格式：rsi(周期)');
                                    indicators.rsi = calculateRSI(closes, params[0]);
                                    break;
                                case 'kdj':
                                    if (params.length !== 3)
                                        throw new Error('KDJ指标需要3个参数，格式：kdj(9,3,3)');
                                    indicators.kdj = calculateKDJ(highs, lows, closes, params[0], params[1], params[2]);
                                    break;
                                case 'boll':
                                    if (params.length !== 2)
                                        throw new Error('布林带指标需要2个参数，格式：boll(周期,标准差倍数)');
                                    indicators.boll = calculateBOLL(closes, params[0], params[1]);
                                    break;
                                case 'ma':
                                    if (params.length !== 1)
                                        throw new Error('移动平均线需要1个参数，格式：ma(周期)');
                                    indicators[`ma${params[0]}`] = calculateSMA(closes, params[0]);
                                    break;
                                default:
                                    throw new Error(`不支持的技术指标: ${name}`);
                            }
                        }
                        catch (e) {
                            console.error(`解析技术指标 ${indicator} 时出错:`, e);
                            throw new Error(`技术指标参数错误: ${indicator}`);
                        }
                    }
                    // 指标逆序以匹配最新在前
                    Object.keys(indicators).forEach(key => {
                        if (typeof indicators[key] === 'object' && indicators[key] !== null) {
                            if (Array.isArray(indicators[key])) {
                                indicators[key] = indicators[key].reverse();
                            }
                            else {
                                Object.keys(indicators[key]).forEach(subKey => {
                                    if (Array.isArray(indicators[key][subKey])) {
                                        indicators[key][subKey] = indicators[key][subKey].reverse();
                                    }
                                });
                            }
                        }
                    });
                    // 过滤到用户指定区间
                    stockData = filterDataToUserRange(stockData, userStartDate, userEndDate);
                    console.log(`过滤到用户请求时间范围，剩余${stockData.length}条记录`);
                }
                // 表格输出（走默认分支样式）
                const marketTitleMap = {
                    'crypto': '加密货币'
                };
                const fieldNameMap = {
                    'trade_date': '交易日期',
                    'open': '开盘',
                    'close': '收盘',
                    'high': '最高',
                    'low': '最低',
                    'vol': '成交量'
                };
                let formattedData = '';
                let indicatorData = '';
                if (stockData.length > 0) {
                    const coreFields = ['trade_date', 'open', 'close', 'high', 'low', 'vol'];
                    const availableFields = Object.keys(stockData[0]);
                    const displayFields = coreFields.filter(field => availableFields.includes(field));
                    const indicatorHeaders = [];
                    const hasIndicators = Object.keys(indicators).length > 0;
                    if (hasIndicators) {
                        if (indicators.macd)
                            indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                        if (indicators.rsi)
                            indicatorHeaders.push('RSI');
                        if (indicators.kdj)
                            indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                        if (indicators.boll)
                            indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                        const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                        maIndicators.forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
                    }
                    const allHeaders = [
                        ...displayFields.map(field => fieldNameMap[field] || field),
                        ...indicatorHeaders
                    ];
                    formattedData = `| ${allHeaders.join(' | ')} |\n`;
                    formattedData += `|${allHeaders.map(() => '--------').join('|')}|\n`;
                    stockData.forEach((data, index) => {
                        const basicRow = displayFields.map(field => data[field] ?? 'N/A');
                        const indicatorRow = [];
                        if (hasIndicators) {
                            if (indicators.macd) {
                                indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                            }
                            if (indicators.rsi)
                                indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                            if (indicators.kdj)
                                indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                            if (indicators.boll)
                                indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                            });
                        }
                        const fullRow = [...basicRow, ...indicatorRow];
                        formattedData += `| ${fullRow.join(' | ')} |\n`;
                    });
                }
                if (Object.keys(indicators).length > 0) {
                    indicatorData = `\n\n## 📊 技术指标说明\n`;
                    const indicatorParams = {};
                    for (const indicator of requestedIndicators) {
                        try {
                            const { name, params } = parseIndicatorParams(indicator);
                            indicatorParams[name] = formatIndicatorParams(name, params);
                        }
                        catch { }
                    }
                    if (indicators.macd)
                        indicatorData += `- **MACD${indicatorParams.macd || '(参数未知)'}**: DIF(快线)、DEA(慢线)、MACD(柱状图)\n`;
                    if (indicators.rsi)
                        indicatorData += `- **RSI${indicatorParams.rsi || '(参数未知)'}**: 相对强弱指标，范围0-100，>70超买，<30超卖\n`;
                    if (indicators.kdj)
                        indicatorData += `- **KDJ${indicatorParams.kdj || '(参数未知)'}**: 随机指标，K线、D线、J线，>80超买，<20超卖\n`;
                    if (indicators.boll)
                        indicatorData += `- **BOLL${indicatorParams.boll || '(参数未知)'}**: 布林带，上轨、中轨、下轨\n`;
                    const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                    if (maIndicators.length > 0) {
                        maIndicators.forEach(ma => {
                            const period = ma.replace('ma', '');
                            indicatorData += `- **${ma.toUpperCase()}(${period})**: 移动平均线，常用判断趋势方向\n`;
                        });
                    }
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `# ${args.code} ${marketTitleMap[marketType]}行情数据\n\n${formattedData}${indicatorData}`
                        }
                    ]
                };
            }
            // 构建请求参数
            const params = {
                token: TUSHARE_API_KEY,
                params: {
                    ts_code: args.code,
                    start_date: actualStartDate,
                    end_date: actualEndDate
                }
                // 不设置fields参数，默认返回所有字段
            };
            // 根据不同市场类型设置不同的API名称和参数，默认返回所有字段
            switch (marketType) {
                case 'cn':
                    params.api_name = "daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'us':
                    params.api_name = "us_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'hk':
                    params.api_name = "hk_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'fx':
                    params.api_name = "fx_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'futures':
                    params.api_name = "fut_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'fund':
                    params.api_name = "fund_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'repo':
                    params.api_name = "repo_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'convertible_bond':
                    params.api_name = "cb_daily";
                    // 不设置fields，返回所有可用字段
                    break;
                case 'options':
                    params.api_name = "opt_daily";
                    // 不设置fields，返回所有可用字段
                    // 期权接口优先使用trade_date，如果没有指定则使用end_date作为trade_date
                    if (requestedIndicators.length > 0) {
                        // 如请求技术指标，必须用区间以便获取足够历史
                        params.params = {
                            ts_code: args.code,
                            start_date: actualStartDate,
                            end_date: actualEndDate
                        };
                        // 统一将 amount 列名标注为（万元）
                    }
                    else if (!args.start_date && !args.end_date) {
                        // 如果都没指定，使用默认的end_date作为trade_date
                        params.params = {
                            trade_date: actualEndDate
                        };
                    }
                    else if (args.end_date && !args.start_date) {
                        // 只指定了end_date，使用作为trade_date
                        params.params = {
                            trade_date: actualEndDate
                        };
                    }
                    else {
                        // 如果指定了start_date或日期范围，保持原有逻辑但添加ts_code
                        params.params = {
                            ts_code: args.code,
                            start_date: actualStartDate,
                            end_date: actualEndDate
                        };
                    }
                    // 如果指定了具体的期权代码，添加到params中
                    if (args.code && args.code.length > 0) {
                        params.params.ts_code = args.code;
                    }
                    break;
            }
            console.log(`选择的API接口: ${params.api_name}`);
            console.log(`字段设置: 返回所有可用字段`);
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
                    throw new Error(`未找到${marketType}市场股票${args.code}的行情数据`);
                }
                // 获取字段名
                const fields = data.data.fields;
                // 将数据转换为对象数组
                let stockData = data.data.items.map((item) => {
                    const result = {};
                    fields.forEach((field, index) => {
                        result[field] = item[index];
                    });
                    return result;
                });
                console.log(`成功获取到${stockData.length}条${args.code}股票数据记录（扩展数据范围）`);
                // 对A股强制应用前复权（qfq）：使用最新交易日因子进行归一
                if (marketType === 'cn' && stockData.length > 0) {
                    try {
                        const afParams = {
                            api_name: 'adj_factor',
                            token: TUSHARE_API_KEY,
                            params: {
                                ts_code: args.code,
                                start_date: actualStartDate,
                                end_date: actualEndDate
                            },
                            fields: 'trade_date,adj_factor'
                        };
                        const afResp = await fetch(TUSHARE_API_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(afParams),
                            signal: controller.signal
                        });
                        if (!afResp.ok)
                            throw new Error(`adj_factor 请求失败: ${afResp.status}`);
                        const afJson = await afResp.json();
                        if (afJson.code !== 0)
                            throw new Error(`adj_factor 返回错误: ${afJson.msg}`);
                        const afFields = afJson.data?.fields ?? [];
                        const afItems = afJson.data?.items ?? [];
                        const idxDate = afFields.indexOf('trade_date');
                        const idxFactor = afFields.indexOf('adj_factor');
                        const factorMap = new Map();
                        for (const row of afItems) {
                            const d = String(row[idxDate]);
                            const f = Number(row[idxFactor]);
                            if (!isNaN(f))
                                factorMap.set(d, f);
                        }
                        // 找到stockData中最新交易日的因子
                        const latestDate = stockData
                            .map((r) => String(r.trade_date))
                            .sort((a, b) => b.localeCompare(a))[0];
                        const latestFactor = factorMap.get(latestDate);
                        if (latestFactor && !isNaN(latestFactor)) {
                            stockData = stockData.map((row) => {
                                const f = factorMap.get(String(row.trade_date));
                                if (f && !isNaN(f)) {
                                    const ratio = f / latestFactor; // 前复权：price * f / f_latest
                                    const adj = (v) => (v == null || v === '' || isNaN(Number(v))) ? v : Number(v) * ratio;
                                    return {
                                        ...row,
                                        open: adj(row.open),
                                        high: adj(row.high),
                                        low: adj(row.low),
                                        close: adj(row.close)
                                    };
                                }
                                return row;
                            });
                            console.log(`已应用前复权(基于最新交易日因子)到 ${args.code} 的OHLC价格`);
                        }
                        else {
                            console.warn('未找到最新交易日复权因子，跳过前复权');
                        }
                    }
                    catch (e) {
                        console.warn('应用前复权失败，继续返回未复权数据:', e);
                    }
                }
                // 计算技术指标
                let indicators = {};
                if (requestedIndicators.length > 0 && ['cn', 'us', 'hk', 'fund', 'futures', 'convertible_bond', 'options', 'fx', 'crypto'].includes(marketType)) {
                    // 对具有可用于OHLC的市场计算技术指标
                    // 构建按时间正序的价格序列
                    const mid = (a, b) => {
                        const x = parseFloat(a);
                        const y = parseFloat(b);
                        if (!isNaN(x) && !isNaN(y))
                            return (x + y) / 2;
                        if (!isNaN(x))
                            return x;
                        if (!isNaN(y))
                            return y;
                        return NaN;
                    };
                    let closes = [];
                    let highs = [];
                    let lows = [];
                    if (marketType === 'fx') {
                        closes = stockData.map((d) => mid(d.bid_close, d.ask_close)).reverse();
                        highs = stockData.map((d) => mid(d.bid_high, d.ask_high)).reverse();
                        lows = stockData.map((d) => mid(d.bid_low, d.ask_low)).reverse();
                    }
                    else {
                        closes = stockData.map((d) => parseFloat(d.close)).reverse();
                        highs = stockData.map((d) => parseFloat(d.high)).reverse();
                        lows = stockData.map((d) => parseFloat(d.low)).reverse();
                    }
                    for (const indicator of requestedIndicators) {
                        try {
                            const { name, params } = parseIndicatorParams(indicator);
                            switch (name) {
                                case 'macd':
                                    if (params.length !== 3) {
                                        throw new Error(`MACD指标需要3个参数，格式：macd(快线,慢线,信号线)，如：macd(12,26,9)`);
                                    }
                                    indicators.macd = calculateMACD(closes, params[0], params[1], params[2]);
                                    break;
                                case 'rsi':
                                    if (params.length !== 1) {
                                        throw new Error(`RSI指标需要1个参数，格式：rsi(周期)，如：rsi(14)`);
                                    }
                                    indicators.rsi = calculateRSI(closes, params[0]);
                                    break;
                                case 'kdj':
                                    if (params.length !== 3) {
                                        throw new Error(`KDJ指标需要3个参数，格式：kdj(K周期,K平滑,D平滑)，如：kdj(9,3,3)`);
                                    }
                                    indicators.kdj = calculateKDJ(highs, lows, closes, params[0], params[1], params[2]);
                                    break;
                                case 'boll':
                                    if (params.length !== 2) {
                                        throw new Error(`布林带指标需要2个参数，格式：boll(周期,标准差倍数)，如：boll(20,2)`);
                                    }
                                    indicators.boll = calculateBOLL(closes, params[0], params[1]);
                                    break;
                                case 'ma':
                                    if (params.length !== 1) {
                                        throw new Error(`移动平均线需要1个参数，格式：ma(周期)，如：ma(5)、ma(10)、ma(20)`);
                                    }
                                    const maPeriod = params[0];
                                    indicators[`ma${maPeriod}`] = calculateSMA(closes, maPeriod);
                                    break;
                                default:
                                    throw new Error(`不支持的技术指标: ${name}，支持的指标：macd(12,26,9)、rsi(14)、kdj(9,3,3)、boll(20,2)、ma(周期)`);
                            }
                        }
                        catch (error) {
                            console.error(`解析技术指标 ${indicator} 时出错:`, error);
                            throw new Error(`技术指标参数错误: ${indicator}`);
                        }
                    }
                    // 将技术指标数据逆序回来，以匹配原始数据的时间顺序（最新日期在前）
                    Object.keys(indicators).forEach(key => {
                        if (typeof indicators[key] === 'object' && indicators[key] !== null) {
                            if (Array.isArray(indicators[key])) {
                                indicators[key] = indicators[key].reverse();
                            }
                            else {
                                // 对于MACD、KDJ、BOLL等对象类型的指标
                                Object.keys(indicators[key]).forEach(subKey => {
                                    if (Array.isArray(indicators[key][subKey])) {
                                        indicators[key][subKey] = indicators[key][subKey].reverse();
                                    }
                                });
                            }
                        }
                    });
                }
                // 过滤数据到用户请求的时间范围
                if (requestedIndicators.length > 0) {
                    stockData = filterDataToUserRange(stockData, userStartDate, userEndDate);
                    console.log(`过滤到用户请求时间范围，剩余${stockData.length}条记录`);
                }
                // 生成市场类型标题
                const marketTitleMap = {
                    'cn': 'A股',
                    'us': '美股',
                    'hk': '港股',
                    'fx': '外汇',
                    'futures': '期货',
                    'fund': '基金',
                    'repo': '债券逆回购',
                    'convertible_bond': '可转债',
                    'options': '期权',
                    'crypto': '加密货币'
                };
                // 金额（amount）统一以“万元”为单位展示：amount(千) -> amount/10(万)
                const formatAmountWan = (val) => {
                    const num = Number(val);
                    if (val == null || val === '' || isNaN(num))
                        return 'N/A';
                    return (num / 10).toFixed(2);
                };
                // 格式化输出（根据不同市场类型构建表格格式）
                let formattedData = '';
                let indicatorData = '';
                const titleSuffix = marketType === 'cn' ? '（前复权）' : '';
                if (marketType === 'fx') {
                    // 外汇数据表格展示（追加技术指标列）
                    const hasIndicators = Object.keys(indicators).length > 0;
                    const indicatorHeaders = [];
                    if (hasIndicators) {
                        if (indicators.macd)
                            indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                        if (indicators.rsi)
                            indicatorHeaders.push('RSI');
                        if (indicators.kdj)
                            indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                        if (indicators.boll)
                            indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                        const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                        maIndicators.forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
                    }
                    const baseHeaders = ['交易日期', '买入开盘', '买入最高', '买入最低', '买入收盘', '卖出开盘', '卖出最高', '卖出最低', '卖出收盘', '报价笔数'];
                    const headers = [...baseHeaders, ...indicatorHeaders];
                    formattedData = `| ${headers.join(' | ')} |\n`;
                    formattedData += `|${headers.map(() => '--------').join('|')}|\n`;
                    stockData.forEach((data, index) => {
                        const baseRow = [data.trade_date, data.bid_open || 'N/A', data.bid_high || 'N/A', data.bid_low || 'N/A', data.bid_close || 'N/A', data.ask_open || 'N/A', data.ask_high || 'N/A', data.ask_low || 'N/A', data.ask_close || 'N/A', data.tick_qty || 'N/A'];
                        const indicatorRow = [];
                        if (hasIndicators) {
                            if (indicators.macd) {
                                indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                            }
                            if (indicators.rsi)
                                indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                            if (indicators.kdj)
                                indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                            if (indicators.boll)
                                indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                            });
                        }
                        const row = [...baseRow, ...indicatorRow];
                        formattedData += `| ${row.join(' | ')} |\n`;
                    });
                }
                else if (marketType === 'futures') {
                    // 期货数据表格展示（追加技术指标列）
                    const hasIndicators = Object.keys(indicators).length > 0;
                    const indicatorHeaders = [];
                    if (hasIndicators) {
                        if (indicators.macd)
                            indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                        if (indicators.rsi)
                            indicatorHeaders.push('RSI');
                        if (indicators.kdj)
                            indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                        if (indicators.boll)
                            indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                        const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                        maIndicators.forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
                    }
                    const baseHeaders = ['交易日期', '开盘', '最高', '最低', '收盘', '结算', '涨跌1', '涨跌2', '成交量', '持仓量'];
                    const headers = [...baseHeaders, ...indicatorHeaders];
                    formattedData = `| ${headers.join(' | ')} |\n`;
                    formattedData += `|${headers.map(() => '--------').join('|')}|\n`;
                    stockData.forEach((data, index) => {
                        const baseRow = [data.trade_date, data.open || 'N/A', data.high || 'N/A', data.low || 'N/A', data.close || 'N/A', data.settle || 'N/A', data.change1 || 'N/A', data.change2 || 'N/A', data.vol || 'N/A', data.oi || 'N/A'];
                        const indicatorRow = [];
                        if (hasIndicators) {
                            if (indicators.macd) {
                                indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                            }
                            if (indicators.rsi)
                                indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                            if (indicators.kdj)
                                indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                            if (indicators.boll)
                                indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                            });
                        }
                        const row = [...baseRow, ...indicatorRow];
                        formattedData += `| ${row.join(' | ')} |\n`;
                    });
                }
                else if (marketType === 'repo') {
                    // 债券逆回购数据表格展示
                    formattedData = `| 交易日期 | 品种名称 | 利率(%) | 成交金额(万元) |\n`;
                    formattedData += `|---------|---------|---------|---------------|\n`;
                    stockData.forEach((data) => {
                        const amtWan = formatAmountWan(data.amount);
                        formattedData += `| ${data.trade_date} | ${data.name || 'N/A'} | ${data.rate || 'N/A'} | ${amtWan} |\n`;
                    });
                }
                else if (marketType === 'convertible_bond') {
                    // 可转债数据表格展示（追加技术指标列）
                    const hasIndicators = Object.keys(indicators).length > 0;
                    const indicatorHeaders = [];
                    if (hasIndicators) {
                        if (indicators.macd)
                            indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                        if (indicators.rsi)
                            indicatorHeaders.push('RSI');
                        if (indicators.kdj)
                            indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                        if (indicators.boll)
                            indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                        const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                        maIndicators.forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
                    }
                    const baseHeaders = ['交易日期', '开盘', '最高', '最低', '收盘', '涨跌', '涨跌幅(%)', '成交量(手)', '成交金额(万元)', '纯债价值', '纯债溢价率(%)', '转股价值', '转股溢价率(%)'];
                    const headers = [...baseHeaders, ...indicatorHeaders];
                    formattedData = `| ${headers.join(' | ')} |\n`;
                    formattedData += `|${headers.map(() => '--------').join('|')}|\n`;
                    stockData.forEach((data, index) => {
                        const baseRow = [
                            data.trade_date,
                            data.open || 'N/A',
                            data.high || 'N/A',
                            data.low || 'N/A',
                            data.close || 'N/A',
                            data.change || 'N/A',
                            data.pct_chg || 'N/A',
                            data.vol || 'N/A',
                            formatAmountWan(data.amount),
                            data.bond_value || 'N/A',
                            data.bond_over_rate || 'N/A',
                            data.cb_value || 'N/A',
                            data.cb_over_rate || 'N/A'
                        ];
                        const indicatorRow = [];
                        if (hasIndicators) {
                            if (indicators.macd) {
                                indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                            }
                            if (indicators.rsi)
                                indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                            if (indicators.kdj)
                                indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                            if (indicators.boll)
                                indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                            });
                        }
                        const row = [...baseRow, ...indicatorRow];
                        formattedData += `| ${row.join(' | ')} |\n`;
                    });
                }
                else if (marketType === 'options') {
                    // 期权数据表格展示（追加技术指标列）
                    const hasIndicators = Object.keys(indicators).length > 0;
                    const indicatorHeaders = [];
                    if (hasIndicators) {
                        if (indicators.macd)
                            indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                        if (indicators.rsi)
                            indicatorHeaders.push('RSI');
                        if (indicators.kdj)
                            indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                        if (indicators.boll)
                            indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                        const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                        maIndicators.forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
                    }
                    const baseHeaders = ['交易日期', '交易所', '昨结算', '前收盘', '开盘', '最高', '最低', '收盘', '结算', '成交量(手)', '成交金额(万元)', '持仓量(手)'];
                    const headers = [...baseHeaders, ...indicatorHeaders];
                    formattedData = `| ${headers.join(' | ')} |\n`;
                    formattedData += `|${headers.map(() => '--------').join('|')}|\n`;
                    stockData.forEach((data, index) => {
                        const baseRow = [
                            data.trade_date,
                            data.exchange || 'N/A',
                            data.pre_settle || 'N/A',
                            data.pre_close || 'N/A',
                            data.open || 'N/A',
                            data.high || 'N/A',
                            data.low || 'N/A',
                            data.close || 'N/A',
                            data.settle || 'N/A',
                            data.vol || 'N/A',
                            formatAmountWan(data.amount),
                            data.oi || 'N/A'
                        ];
                        const indicatorRow = [];
                        if (hasIndicators) {
                            if (indicators.macd) {
                                indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                            }
                            if (indicators.rsi)
                                indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                            if (indicators.kdj)
                                indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                            if (indicators.boll)
                                indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                            });
                        }
                        const row = [...baseRow, ...indicatorRow];
                        formattedData += `| ${row.join(' | ')} |\n`;
                    });
                }
                else {
                    // 股票数据表格展示（A股、美股、港股、基金等）
                    if (stockData.length > 0) {
                        // 基础字段
                        const coreFields = ['trade_date', 'open', 'close', 'high', 'low', 'vol', 'amount'];
                        const availableFields = Object.keys(stockData[0]);
                        const displayFields = coreFields.filter(field => availableFields.includes(field));
                        // 生成字段名映射
                        const fieldNameMap = {
                            'trade_date': '交易日期',
                            'open': '开盘',
                            'close': '收盘',
                            'high': '最高',
                            'low': '最低',
                            'vol': '成交量',
                            'amount': '成交额'
                        };
                        fieldNameMap['amount'] = '成交额(万元)';
                        // 如果有技术指标，添加技术指标列
                        const indicatorHeaders = [];
                        const hasIndicators = Object.keys(indicators).length > 0;
                        if (hasIndicators) {
                            // 添加技术指标表头
                            if (indicators.macd) {
                                indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
                            }
                            if (indicators.rsi) {
                                indicatorHeaders.push('RSI');
                            }
                            if (indicators.kdj) {
                                indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
                            }
                            if (indicators.boll) {
                                indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
                            }
                            // 添加移动平均线
                            const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                            maIndicators.forEach(ma => {
                                indicatorHeaders.push(ma.toUpperCase());
                            });
                        }
                        // 组合所有表头
                        const allHeaders = [
                            ...displayFields.map(field => field === 'amount' ? '成交额(万元)' : (fieldNameMap[field] || field)),
                            ...indicatorHeaders
                        ];
                        formattedData = `| ${allHeaders.join(' | ')} |\n`;
                        formattedData += `|${allHeaders.map(() => '--------').join('|')}|\n`;
                        // 生成数据行
                        stockData.forEach((data, index) => {
                            const basicRow = displayFields.map(field => {
                                if (field === 'amount')
                                    return formatAmountWan(data.amount);
                                return data[field] || 'N/A';
                            });
                            // 添加技术指标数据
                            const indicatorRow = [];
                            if (hasIndicators) {
                                if (indicators.macd) {
                                    indicatorRow.push(isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4), isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4), isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4));
                                }
                                if (indicators.rsi) {
                                    indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
                                }
                                if (indicators.kdj) {
                                    indicatorRow.push(isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2), isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2), isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2));
                                }
                                if (indicators.boll) {
                                    indicatorRow.push(isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2), isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2), isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2));
                                }
                                // 添加移动平均线数据
                                const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                                maIndicators.forEach(ma => {
                                    indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
                                });
                            }
                            const fullRow = [...basicRow, ...indicatorRow];
                            formattedData += `| ${fullRow.join(' | ')} |\n`;
                        });
                    }
                }
                // 生成技术指标说明（如果有技术指标）
                if (Object.keys(indicators).length > 0) {
                    indicatorData = `\n\n## 📊 技术指标说明\n`;
                    // 记录实际使用的参数，用于说明中显示
                    const indicatorParams = {};
                    for (const indicator of requestedIndicators) {
                        try {
                            const { name, params } = parseIndicatorParams(indicator);
                            indicatorParams[name] = formatIndicatorParams(name, params);
                        }
                        catch {
                            // 忽略解析错误，继续处理其他指标
                        }
                    }
                    if (indicators.macd) {
                        const params = indicatorParams.macd || '(参数未知)';
                        indicatorData += `- **MACD${params}**: DIF(快线)、DEA(慢线)、MACD(柱状图)\n`;
                    }
                    if (indicators.rsi) {
                        const params = indicatorParams.rsi || '(参数未知)';
                        indicatorData += `- **RSI${params}**: 相对强弱指标，范围0-100，>70超买，<30超卖\n`;
                    }
                    if (indicators.kdj) {
                        const params = indicatorParams.kdj || '(参数未知)';
                        indicatorData += `- **KDJ${params}**: 随机指标，K线、D线、J线，>80超买，<20超卖\n`;
                    }
                    if (indicators.boll) {
                        const params = indicatorParams.boll || '(参数未知)';
                        indicatorData += `- **BOLL${params}**: 布林带，上轨、中轨、下轨\n`;
                    }
                    // 处理各种MA指标，过滤掉非MA指标
                    const maIndicators = Object.keys(indicators).filter(key => key.startsWith('ma') && key !== 'macd');
                    if (maIndicators.length > 0) {
                        maIndicators.forEach(ma => {
                            const period = ma.replace('ma', '');
                            indicatorData += `- **${ma.toUpperCase()}(${period})**: 移动平均线，常用判断趋势方向\n`;
                        });
                    }
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `# ${args.code} ${marketTitleMap[marketType]}行情数据${titleSuffix}\n\n${formattedData}${indicatorData}`
                        }
                    ]
                };
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (error) {
            console.error("获取股票数据失败:", error);
            return {
                content: [
                    {
                        type: "text",
                        text: `# 获取股票${args.code}数据失败\n\n无法从Tushare API获取数据：${error instanceof Error ? error.message : String(error)}\n\n请检查股票代码和市场类型是否正确：\n- A股格式："000001.SZ"\n- 美股格式："AAPL"\n- 港股格式："00700.HK"\n- 外汇格式："USDCNH.FXCM"（美元人民币）\n- 期货格式："CU2501.SHF"\n- 基金格式："159919.SZ"\n- 债券逆回购格式："204001.SH"\n- 可转债格式："113008.SH"\n- 期权格式："10001313.SH"\n\n技术指标使用说明（必须明确指定参数）：\n- **MACD**: macd(快线,慢线,信号线) - 例：macd(12,26,9)\n- **RSI**: rsi(周期) - 例：rsi(14)\n- **KDJ**: kdj(K周期,K平滑,D平滑) - 例：kdj(9,3,3)\n- **布林带**: boll(周期,标准差倍数) - 例：boll(20,2)\n- **移动平均线**: ma(周期) - 例：ma(5)、ma(10)、ma(20)\n\n使用示例：\n- "macd(12,26,9) rsi(14)"\n- "kdj(9,3,3) boll(20,2) ma(30)"\n- "macd(5,10,5) ma(5) ma(10)"`
                    }
                ]
            };
        }
    }
};
//# sourceMappingURL=stockData.js.map