import { TUSHARE_CONFIG } from '../config.js';
export const marginTrade = {
    name: "margin_trade",
    description: "获取融资融券相关数据，支持多种数据类型：标的股票、交易汇总、交易明细、转融券汇总等",
    parameters: {
        type: "object",
        properties: {
            data_type: {
                type: "string",
                description: "数据类型，可选值：margin_secs(融资融券标的股票)、margin(融资融券交易汇总)、margin_detail(融资融券交易明细)、slb_len_mm(做市借券交易汇总)"
            },
            ts_code: {
                type: "string",
                description: "股票代码，如'000001.SZ'、'600000.SH'等（部分接口可选）"
            },
            start_date: {
                type: "string",
                description: "起始日期，格式YYYYMMDD，如'20240101'"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式YYYYMMDD，如'20240131'（可选，默认为当前日期）"
            },
            exchange: {
                type: "string",
                description: "交易所代码，可选值：SSE(上海证券交易所)、SZSE(深圳证券交易所)、BSE(北京证券交易所)，仅margin_secs接口使用"
            }
        },
        required: ["data_type", "start_date"]
    },
    async run(args) {
        try {
            console.log('融资融券数据查询参数:', args);
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            if (!TUSHARE_API_KEY) {
                throw new Error('请配置TUSHARE_TOKEN环境变量');
            }
            let data;
            let formattedOutput;
            switch (args.data_type) {
                case 'margin_secs':
                    // 融资融券标的（盘前更新）
                    data = await fetchMarginSecs(args, TUSHARE_API_KEY, TUSHARE_API_URL);
                    formattedOutput = formatMarginSecs(data, args);
                    break;
                case 'margin':
                    // 融资融券交易汇总
                    if (!args.ts_code) {
                        throw new Error('融资融券交易汇总查询需要提供股票代码(ts_code)');
                    }
                    data = await fetchMarginSummary(args, TUSHARE_API_KEY, TUSHARE_API_URL);
                    formattedOutput = formatMarginSummary(data, args);
                    break;
                case 'margin_detail':
                    // 融资融券交易明细
                    if (!args.ts_code) {
                        throw new Error('融资融券交易明细查询需要提供股票代码(ts_code)');
                    }
                    data = await fetchMarginDetail(args, TUSHARE_API_KEY, TUSHARE_API_URL);
                    formattedOutput = formatMarginDetail(data, args);
                    break;
                case 'slb_len_mm':
                    // 做市借券交易汇总
                    data = await fetchSlbLenMm(args, TUSHARE_API_KEY, TUSHARE_API_URL);
                    formattedOutput = formatSlbLenMm(data, args);
                    break;
                default:
                    throw new Error(`不支持的数据类型: ${args.data_type}`);
            }
            if (!data || data.length === 0) {
                throw new Error(`未找到相关融资融券数据`);
            }
            return {
                content: [{ type: "text", text: formattedOutput }]
            };
        }
        catch (error) {
            console.error('融资融券数据查询错误:', error);
            return {
                content: [{
                        type: "text",
                        text: `查询融资融券数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}`
                    }]
            };
        }
    }
};
// 1. 融资融券标的（盘前更新）
async function fetchMarginSecs(args, apiKey, apiUrl) {
    const params = {
        api_name: "margin_secs",
        token: apiKey,
        params: {
            ...(args.ts_code && { ts_code: args.ts_code }),
            start_date: args.start_date,
            ...(args.end_date && { end_date: args.end_date }),
            ...(args.exchange && { exchange: args.exchange })
        },
        fields: "trade_date,ts_code,name,exchange"
    };
    return await callTushareAPI(params, apiUrl, 'margin_secs');
}
// 2. 融资融券交易汇总
async function fetchMarginSummary(args, apiKey, apiUrl) {
    const params = {
        api_name: "margin",
        token: apiKey,
        params: {
            ts_code: args.ts_code,
            start_date: args.start_date,
            ...(args.end_date && { end_date: args.end_date })
        },
        fields: "trade_date,ts_code,rzye,rzmre,rzche,rqye,rqmcl,rqchl,rzrqye"
    };
    return await callTushareAPI(params, apiUrl, 'margin');
}
// 3. 融资融券交易明细
async function fetchMarginDetail(args, apiKey, apiUrl) {
    const params = {
        api_name: "margin_detail",
        token: apiKey,
        params: {
            ts_code: args.ts_code,
            start_date: args.start_date,
            ...(args.end_date && { end_date: args.end_date })
        },
        fields: "trade_date,ts_code,rzye,rzmre,rqye,rqmcl,rzrqye"
    };
    return await callTushareAPI(params, apiUrl, 'margin_detail');
}
// 4. 做市借券交易汇总
async function fetchSlbLenMm(args, apiKey, apiUrl) {
    const params = {
        api_name: "slb_len_mm",
        token: apiKey,
        params: {
            ...(args.ts_code && { ts_code: args.ts_code }),
            start_date: args.start_date,
            ...(args.end_date && { end_date: args.end_date })
        },
        fields: "trade_date,ts_code,name,ope_inv,lent_qnt,cls_inv,end_bal"
    };
    return await callTushareAPI(params, apiUrl, 'slb_len_mm');
}
// 通用API调用函数
async function callTushareAPI(params, apiUrl, apiName) {
    console.log(`请求${apiName}数据，参数:`, params.params);
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
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`Tushare API请求失败: ${response.status}`);
        }
        const data = await response.json();
        if (data.code !== 0) {
            throw new Error(`Tushare API错误: ${data.msg}`);
        }
        if (!data.data || !data.data.items || data.data.items.length === 0) {
            return [];
        }
        const fieldsArray = data.data.fields;
        const resultData = data.data.items.map((item) => {
            const result = {};
            fieldsArray.forEach((field, index) => {
                result[field] = item[index];
            });
            return result;
        });
        console.log(`成功获取到${resultData.length}条${apiName}数据记录`);
        return resultData;
    }
    catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}
// 格式化融资融券标的数据
function formatMarginSecs(data, args) {
    let output = `# 📋 融资融券标的股票列表\n\n`;
    output += `📅 查询期间: ${args.start_date}`;
    if (args.end_date) {
        output += ` ~ ${args.end_date}`;
    }
    output += `\n`;
    if (args.exchange) {
        output += `🏛️ 交易所: ${getExchangeName(args.exchange)}\n`;
    }
    output += `📊 标的数量: ${data.length}只\n\n`;
    if (data.length === 0) {
        output += `ℹ️ 暂无融资融券标的数据\n\n`;
        return output;
    }
    // 按交易所分组统计
    const exchangeStats = {};
    data.forEach(item => {
        const exchange = item.exchange || '未知';
        exchangeStats[exchange] = (exchangeStats[exchange] || 0) + 1;
    });
    output += `## 📈 按交易所统计\n\n`;
    output += `| 交易所 | 标的数量 | 占比 |\n`;
    output += `|--------|----------|------|\n`;
    Object.entries(exchangeStats).forEach(([exchange, count]) => {
        const percentage = ((count / data.length) * 100).toFixed(2);
        output += `| ${getExchangeName(exchange)} | ${count}只 | ${percentage}% |\n`;
    });
    // 显示详细列表（前50个）
    const displayData = data.slice(0, 50);
    output += `\n## 📋 详细标的列表 (前${displayData.length}条)\n\n`;
    output += `| 代码 | 名称 | 交易所 | 交易日期 |\n`;
    output += `|------|------|--------|----------|\n`;
    displayData.forEach(item => {
        output += `| ${item.ts_code} | ${item.name} | ${getExchangeName(item.exchange)} | ${item.trade_date} |\n`;
    });
    if (data.length > 50) {
        output += `\n*显示前50条记录，共${data.length}条数据*\n`;
    }
    return output;
}
// 格式化融资融券交易汇总数据
function formatMarginSummary(data, args) {
    let output = `# 💰 ${args.ts_code} 融资融券交易汇总\n\n`;
    output += `📅 查询期间: ${args.start_date} ~ ${args.end_date}\n`;
    output += `📊 数据条数: ${data.length}条\n\n`;
    if (data.length === 0) {
        output += `ℹ️ 暂无融资融券交易汇总数据\n\n`;
        return output;
    }
    const sortedData = data.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    const latestData = sortedData[0];
    // 最新数据概览
    output += `## 📈 最新数据概览 (${latestData.trade_date})\n\n`;
    output += `| 项目 | 金额/数量 | 说明 |\n`;
    output += `|------|----------|------|\n`;
    output += `| 💼 融资余额 | ${formatNumber(latestData.rzye)}元 | 当日融资买入后的余额 |\n`;
    output += `| 📊 融券余额 | ${formatNumber(latestData.rqye)}元 | 当日融券卖出后的余额 |\n`;
    output += `| 💰 融资融券余额 | ${formatNumber(latestData.rzrqye)}元 | 融资余额 + 融券余额 |\n\n`;
    // 期间统计
    let totalRzmre = 0, totalRzche = 0, totalRqmcl = 0, totalRqchl = 0;
    sortedData.forEach(item => {
        totalRzmre += parseFloat(item.rzmre || 0);
        totalRzche += parseFloat(item.rzche || 0);
        totalRqmcl += parseFloat(item.rqmcl || 0);
        totalRqchl += parseFloat(item.rqchl || 0);
    });
    output += `## 📊 期间统计汇总\n\n`;
    output += `| 项目 | 累计金额/数量 | 日均金额/数量 |\n`;
    output += `|------|-------------|-------------|\n`;
    output += `| 💵 融资买入额 | ${formatNumber(totalRzmre)}元 | ${formatNumber(totalRzmre / data.length)}元 |\n`;
    output += `| 💸 融资偿还额 | ${formatNumber(totalRzche)}元 | ${formatNumber(totalRzche / data.length)}元 |\n`;
    output += `| 📈 融券卖出量 | ${formatNumber(totalRqmcl)} | ${formatNumber(totalRqmcl / data.length)} |\n`;
    output += `| 📉 融券偿还量 | ${formatNumber(totalRqchl)} | ${formatNumber(totalRqchl / data.length)} |\n\n`;
    // 详细记录表格
    const displayData = sortedData.slice(0, 10);
    output += `## 📋 详细交易记录 (最近${displayData.length}个交易日)\n\n`;
    output += `| 交易日期 | 融资余额(万元) | 融资买入(万元) | 融资偿还(万元) | 融券余额(万元) | 融券卖出量 | 融券偿还量 |\n`;
    output += `|---------|--------------|--------------|--------------|--------------|----------|-----------|\n`;
    displayData.forEach(item => {
        const rzye = (parseFloat(item.rzye || 0) / 10000).toFixed(2);
        const rzmre = (parseFloat(item.rzmre || 0) / 10000).toFixed(2);
        const rzche = (parseFloat(item.rzche || 0) / 10000).toFixed(2);
        const rqye = (parseFloat(item.rqye || 0) / 10000).toFixed(2);
        const rqmcl = formatNumber(item.rqmcl || 0);
        const rqchl = formatNumber(item.rqchl || 0);
        output += `| ${item.trade_date} | ${rzye} | ${rzmre} | ${rzche} | ${rqye} | ${rqmcl} | ${rqchl} |\n`;
    });
    return output;
}
// 格式化融资融券交易明细数据
function formatMarginDetail(data, args) {
    let output = `# 📊 ${args.ts_code} 融资融券交易明细\n\n`;
    output += `📅 查询期间: ${args.start_date} ~ ${args.end_date}\n`;
    output += `📊 数据条数: ${data.length}条\n\n`;
    if (data.length === 0) {
        output += `ℹ️ 暂无融资融券交易明细数据\n\n`;
        return output;
    }
    const sortedData = data.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    // 显示详细明细表格
    const displayData = sortedData.slice(0, 20);
    output += `## 📋 交易明细记录 (最近${displayData.length}个交易日)\n\n`;
    output += `| 交易日期 | 融资余额(万元) | 融资买入(万元) | 融券余额(万元) | 融券卖出量 | 融资融券余额(万元) |\n`;
    output += `|---------|--------------|--------------|--------------|----------|----------------|\n`;
    displayData.forEach(item => {
        const rzye = (parseFloat(item.rzye || 0) / 10000).toFixed(2);
        const rzmre = (parseFloat(item.rzmre || 0) / 10000).toFixed(2);
        const rqye = (parseFloat(item.rqye || 0) / 10000).toFixed(2);
        const rqmcl = formatNumber(item.rqmcl || 0);
        const rzrqye = (parseFloat(item.rzrqye || 0) / 10000).toFixed(2);
        output += `| ${item.trade_date} | ${rzye} | ${rzmre} | ${rqye} | ${rqmcl} | ${rzrqye} |\n`;
    });
    if (sortedData.length > 20) {
        output += `\n*显示最近20条记录，共${sortedData.length}条数据*\n`;
    }
    return output;
}
// 格式化做市借券交易汇总数据
function formatSlbLenMm(data, args) {
    let output = `# 🏦 做市借券交易汇总\n\n`;
    output += `📅 查询期间: ${args.start_date}`;
    if (args.end_date) {
        output += ` ~ ${args.end_date}`;
    }
    output += `\n`;
    if (args.ts_code) {
        output += `📈 股票代码: ${args.ts_code}\n`;
    }
    output += `📊 数据条数: ${data.length}条\n\n`;
    if (data.length === 0) {
        output += `ℹ️ 暂无做市借券交易数据\n\n`;
        return output;
    }
    const sortedData = data.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    // 汇总统计
    let totalOpeInv = 0, totalLentQnt = 0, totalClsInv = 0, totalEndBal = 0;
    sortedData.forEach(item => {
        totalOpeInv += parseFloat(item.ope_inv || 0);
        totalLentQnt += parseFloat(item.lent_qnt || 0);
        totalClsInv += parseFloat(item.cls_inv || 0);
        totalEndBal += parseFloat(item.end_bal || 0);
    });
    output += `## 📊 汇总统计\n\n`;
    output += `| 项目 | 数量/金额 |\n`;
    output += `|------|----------|\n`;
    output += `| 📦 总期初余量 | ${formatNumber(totalOpeInv)}万股 |\n`;
    output += `| 🔄 总融出数量 | ${formatNumber(totalLentQnt)}万股 |\n`;
    output += `| 📦 总期末余量 | ${formatNumber(totalClsInv)}万股 |\n`;
    output += `| 💰 总期末余额 | ${formatNumber(totalEndBal)}万元 |\n\n`;
    // 详细记录表格
    const displayData = sortedData.slice(0, 15);
    output += `## 📋 详细交易记录 (前${displayData.length}条)\n\n`;
    output += `| 交易日期 | 股票代码 | 股票名称 | 期初余量(万股) | 融出数量(万股) | 期末余量(万股) | 期末余额(万元) |\n`;
    output += `|---------|----------|----------|--------------|--------------|--------------|----------------|\n`;
    displayData.forEach(item => {
        const opeInv = parseFloat(item.ope_inv || 0).toFixed(2);
        const lentQnt = item.lent_qnt ? parseFloat(item.lent_qnt).toFixed(2) : '-';
        const clsInv = parseFloat(item.cls_inv || 0).toFixed(2);
        const endBal = parseFloat(item.end_bal || 0).toFixed(2);
        output += `| ${item.trade_date} | ${item.ts_code} | ${item.name} | ${opeInv} | ${lentQnt} | ${clsInv} | ${endBal} |\n`;
    });
    if (sortedData.length > 15) {
        output += `\n*显示前15条记录，共${sortedData.length}条数据*\n`;
    }
    // 数据说明
    output += `\n## 📝 数据说明\n\n`;
    output += `- **期初余量**: 交易日开始时的借券余量\n`;
    output += `- **融出数量**: 当日新增的借券数量\n`;
    output += `- **期末余量**: 交易日结束时的借券余量\n`;
    output += `- **期末余额**: 期末借券余量对应的市值金额\n`;
    return output;
}
// 辅助函数
function getExchangeName(exchange) {
    const exchangeMap = {
        'SSE': '上交所',
        'SZSE': '深交所',
        'BSE': '北交所',
        '上交所': '上交所',
        '深交所': '深交所',
        '北交所': '北交所'
    };
    return exchangeMap[exchange] || exchange;
}
function formatNumber(num) {
    if (num === null || num === undefined || num === '') {
        return '0';
    }
    const numValue = parseFloat(num);
    if (isNaN(numValue)) {
        return '0';
    }
    if (numValue >= 100000000) {
        return (numValue / 100000000).toFixed(2) + '亿';
    }
    else if (numValue >= 10000) {
        return (numValue / 10000).toFixed(2) + '万';
    }
    else {
        return numValue.toLocaleString();
    }
}
//# sourceMappingURL=marginTrade.js.map