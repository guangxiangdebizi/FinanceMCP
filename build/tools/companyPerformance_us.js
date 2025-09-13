import { TUSHARE_CONFIG } from '../config.js';
import { formatUsIncomeData } from './companyPerformanceDetail_us/usIncomeFormatters.js';
import { formatUsBalanceData } from './companyPerformanceDetail_us/usBalanceFormatters.js';
import { formatUsCashflowData } from './companyPerformanceDetail_us/usCashflowFormatters.js';
import { formatUsIndicatorData } from './companyPerformanceDetail_us/usIndicatorFormatters.js';
export const companyPerformance_us = {
    name: "company_performance_us",
    description: "获取美股上市公司综合表现数据，包括利润表、资产负债表、现金流量表和财务指标数据",
    parameters: {
        type: "object",
        properties: {
            ts_code: {
                type: "string",
                description: "美股代码，如'NVDA'表示英伟达，'AAPL'表示苹果，'TSLA'表示特斯拉"
            },
            data_type: {
                type: "string",
                description: "数据类型：income(利润表)、balance(资产负债表)、cashflow(现金流量表)、indicator(财务指标)",
                enum: ["income", "balance", "cashflow", "indicator"]
            },
            start_date: {
                type: "string",
                description: "起始日期，格式为YYYYMMDD，如'20230101'"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式为YYYYMMDD，如'20231231'"
            },
            period: {
                type: "string",
                description: "特定报告期，格式为YYYYMMDD，如'20231231'表示2023年年报。指定此参数时将忽略start_date和end_date"
            }
        },
        required: ["ts_code", "data_type", "start_date", "end_date"]
    },
    async run(args) {
        try {
            console.log('美股公司综合表现查询参数:', args);
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            if (!TUSHARE_API_KEY) {
                throw new Error('请配置TUSHARE_TOKEN环境变量');
            }
            // 根据data_type选择对应的接口
            let apiInterface = '';
            let formatFunction = null;
            switch (args.data_type) {
                case 'income':
                    apiInterface = 'us_income';
                    formatFunction = formatUsIncomeData;
                    break;
                case 'balance':
                    apiInterface = 'us_balancesheet';
                    formatFunction = formatUsBalanceData;
                    break;
                case 'cashflow':
                    apiInterface = 'us_cashflow';
                    formatFunction = formatUsCashflowData;
                    break;
                case 'indicator':
                    apiInterface = 'us_fina_indicator';
                    formatFunction = formatUsIndicatorData;
                    break;
                default:
                    throw new Error(`不支持的数据类型: ${args.data_type}`);
            }
            const result = await fetchUsFinancialData(apiInterface, args.ts_code, args.period, args.start_date, args.end_date, TUSHARE_API_KEY, TUSHARE_API_URL);
            if (!result.data || result.data.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `# ${args.ts_code} 美股${getDataTypeName(args.data_type)}数据\n\n❌ 未找到相关数据，请检查股票代码或日期范围`
                        }
                    ]
                };
            }
            // 使用对应的格式化函数
            if (formatFunction) {
                const formattedResult = formatFunction(result.data, args.ts_code, args.data_type);
                return formattedResult;
            }
            else {
                // 如果没有实现格式化器，返回原始数据
                return {
                    content: [
                        {
                            type: "text",
                            text: `# ${args.ts_code} 美股${getDataTypeName(args.data_type)}数据\n\n⚠️ 格式化器待实现，以下为原始数据：\n\n${JSON.stringify(result.data, null, 2)}`
                        }
                    ]
                };
            }
        }
        catch (error) {
            console.error('美股公司业绩查询错误:', error);
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ 美股公司业绩查询失败: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
};
// 获取数据类型中文名称
function getDataTypeName(dataType) {
    const names = {
        'income': '利润表',
        'balance': '资产负债表',
        'cashflow': '现金流量表',
        'indicator': '财务指标'
    };
    return names[dataType] || dataType;
}
// 通用的美股财务数据获取函数
async function fetchUsFinancialData(apiInterface, ts_code, period, start_date, end_date, apiKey, apiUrl) {
    const requestData = {
        api_name: apiInterface,
        token: apiKey,
        params: {
            ts_code: ts_code
        }
    };
    // 根据是否指定period来设置参数
    if (period) {
        requestData.params.period = period;
    }
    else if (start_date && end_date) {
        requestData.params.start_date = start_date;
        requestData.params.end_date = end_date;
    }
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData),
        signal: AbortSignal.timeout(TUSHARE_CONFIG.TIMEOUT)
    });
    if (!response.ok) {
        throw new Error(`Tushare API请求失败: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.code !== 0) {
        throw new Error(`Tushare API错误: ${data.msg || '未知错误'}`);
    }
    // 将返回的数组格式转换为对象数组
    const items = [];
    if (data.data && data.data.items && data.data.items.length > 0) {
        const fields = data.data.fields;
        for (const item of data.data.items) {
            const obj = {};
            fields.forEach((field, index) => {
                obj[field] = item[index];
            });
            items.push(obj);
        }
    }
    return { data: items };
}
//# sourceMappingURL=companyPerformance_us.js.map