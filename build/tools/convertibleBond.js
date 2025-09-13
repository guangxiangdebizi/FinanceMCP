import { TUSHARE_CONFIG } from '../config.js';
export const convertibleBond = {
    name: "convertible_bond",
    description: "获取可转债非行情数据，支持两种查询方式：1)使用issue类型按时间范围查询可转债发行数据；2)使用info类型按代码查询可转债详细信息",
    parameters: {
        type: "object",
        properties: {
            ts_code: {
                type: "string",
                description: "可转债代码，如'110001.SH'表示国电转债，'128001.SZ'表示平安转债。配合info类型使用可查询详细信息"
            },
            data_type: {
                type: "string",
                description: "数据类型，可选值：issue(可转债发行数据)、info(可转债详细信息，通过代码查询)",
                enum: ["issue", "info"]
            },
            start_date: {
                type: "string",
                description: "起始日期，格式为YYYYMMDD，如'20230101'。用于查询发行数据的公告日期范围"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式为YYYYMMDD，如'20230131'。用于查询发行数据的公告日期范围"
            }
        },
        required: ["data_type"]
    },
    async run(args) {
        try {
            console.log('可转债数据查询参数:', args);
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            if (!TUSHARE_API_KEY) {
                throw new Error('请配置TUSHARE_TOKEN环境变量');
            }
            // 默认日期设置
            const today = new Date();
            const currentYear = today.getFullYear();
            const defaultEndDate = `${currentYear}1231`;
            const defaultStartDate = `${currentYear - 1}0101`;
            const results = [];
            // 根据data_type决定要查询的API
            const dataTypes = args.data_type === 'info'
                ? ['basic', 'issue'] // info类型查询所有可用数据
                : [args.data_type];
            for (const dataType of dataTypes) {
                try {
                    const result = await fetchConvertibleBondData(dataType, args.ts_code, args.start_date || defaultStartDate, args.end_date || defaultEndDate, TUSHARE_API_KEY, TUSHARE_API_URL);
                    if (result.data && result.data.length > 0) {
                        results.push({
                            type: dataType,
                            data: result.data,
                            fields: result.fields
                        });
                    }
                }
                catch (error) {
                    console.warn(`获取${dataType}数据失败:`, error);
                    results.push({
                        type: dataType,
                        error: error instanceof Error ? error.message : '未知错误'
                    });
                }
            }
            if (results.length === 0) {
                throw new Error(`未找到相关可转债数据`);
            }
            // 格式化输出
            const formattedOutput = formatConvertibleBondData(results, args.ts_code);
            return {
                content: [{ type: "text", text: formattedOutput }]
            };
        }
        catch (error) {
            console.error('可转债数据查询错误:', error);
            return {
                content: [{
                        type: "text",
                        text: `查询可转债数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}`
                    }]
            };
        }
    }
};
// 获取可转债数据的通用函数
async function fetchConvertibleBondData(dataType, tsCode, startDate, endDate, apiKey, apiUrl) {
    const apiConfigs = {
        basic: {
            api_name: "cb_basic",
            default_fields: "ts_code,bond_short_name,stk_code,stk_short_name,maturity,par_value,issue_price,issue_size,remain_size,value_date,maturity_date,list_date,delist_date,exchange,conv_start_date,conv_end_date,first_conv_price,conv_price,rate_clause,put_clause,force_redeem_clause,resale_clause,cross_default_clause"
        },
        issue: {
            api_name: "cb_issue",
            default_fields: "ts_code,ann_date,res_ann_date,plan_issue_size,issue_size,issue_price,issue_type,issue_cost,onl_code,onl_name,onl_date,onl_size,onl_pch_vol,onl_pch_num,onl_pch_excess,onl_winning_rate,shd_ration_code,shd_ration_name,shd_ration_date,shd_ration_record_date,shd_ration_pay_date,shd_ration_price,shd_ration_ratio,shd_ration_size,shd_ration_vol,shd_ration_num,shd_ration_excess,offl_size,offl_deposit,offl_pch_vol,offl_pch_num,offl_pch_excess,offl_winning_rate,lead_underwriter,lead_underwriter_vol"
        }
    };
    const config = apiConfigs[dataType];
    if (!config) {
        throw new Error(`不支持的数据类型: ${dataType}`);
    }
    // 构建请求参数
    const params = {
        api_name: config.api_name,
        token: apiKey,
        params: {},
        fields: config.default_fields
    };
    // 根据Tushare文档严格映射参数
    if (dataType === 'basic') {
        // cb_basic接口参数：ts_code, list_date, exchange
        if (tsCode)
            params.params.ts_code = tsCode;
        // 对于basic查询，如果提供了start_date，映射到list_date（上市日期）
        if (startDate)
            params.params.list_date = startDate;
    }
    else if (dataType === 'issue') {
        // cb_issue接口参数：ts_code, ann_date, start_date, end_date
        if (tsCode)
            params.params.ts_code = tsCode;
        // 对于issue查询，直接使用start_date和end_date作为公告日期范围
        if (startDate)
            params.params.start_date = startDate;
        if (endDate)
            params.params.end_date = endDate;
    }
    // 设置请求超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        console.log(`请求Tushare API: ${params.api_name}，参数:`, params.params);
        // 发送请求
        const response = await fetch(apiUrl, {
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
        if (!data.data || !data.data.items) {
            throw new Error(`未找到${dataType}数据`);
        }
        // 获取字段名
        const fields = data.data.fields;
        // 将数据转换为对象数组
        const convertedData = data.data.items.map((item) => {
            const result = {};
            fields.forEach((field, index) => {
                result[field] = item[index];
            });
            return result;
        });
        return {
            data: convertedData,
            fields: fields
        };
    }
    finally {
        clearTimeout(timeoutId);
    }
}
// 格式化可转债数据输出
function formatConvertibleBondData(results, tsCode) {
    let output = ` 🪙 可转债数据报告${tsCode ? ` - ${tsCode}` : ''}\n\n`;
    output += `📅 查询时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n`;
    results.forEach((result, index) => {
        if (result.error) {
            output += ` ❌ ${getDataTypeName(result.type)}查询失败\n\n`;
            output += `错误信息: ${result.error}\n\n`;
            return;
        }
        const dataTypeName = getDataTypeName(result.type);
        output += ` 📊 ${dataTypeName} (${result.data.length}条记录)\n\n`;
        switch (result.type) {
            case 'basic':
                output += formatBasicInfo(result.data);
                break;
            case 'issue':
                output += formatIssueInfo(result.data);
                break;
            default:
                output += formatGenericCBData(result.data, result.fields);
                break;
        }
        if (index < results.length - 1) {
            output += "\n---\n\n";
        }
    });
    return output;
}
function getDataTypeName(type) {
    const nameMap = {
        'basic': '可转债基础信息',
        'issue': '可转债发行数据'
    };
    return nameMap[type] || type;
}
function formatBasicInfo(data) {
    if (!data || data.length === 0) {
        return "暂无基础信息数据\n\n";
    }
    return data.map((item, index) => {
        const output = ` ${index + 1}. ${item.bond_short_name || '未知可转债'} (${item.ts_code})\n\n`;
        let details = '';
        if (item.stk_code && item.stk_short_name) {
            details += `🏢 正股信息: ${item.stk_short_name} (${item.stk_code})\n`;
        }
        if (item.par_value)
            details += `💰 票面价值: ${formatNumber(item.par_value)}元\n`;
        if (item.issue_price)
            details += `💵 发行价格: ${formatNumber(item.issue_price)}元\n`;
        if (item.issue_size)
            details += `📊 发行规模: ${formatNumber(item.issue_size)}亿元\n`;
        if (item.remain_size)
            details += `📦 存续规模: ${formatNumber(item.remain_size)}亿元\n`;
        if (item.maturity)
            details += `⏰ 存续期限: ${item.maturity}年\n`;
        if (item.value_date)
            details += `📅 起息日期: ${formatDate(item.value_date)}\n`;
        if (item.maturity_date)
            details += `🏁 到期日期: ${formatDate(item.maturity_date)}\n`;
        if (item.list_date)
            details += `📈 上市日期: ${formatDate(item.list_date)}\n`;
        if (item.delist_date)
            details += `📉 摘牌日期: ${formatDate(item.delist_date)}\n`;
        if (item.exchange)
            details += `🏛️ 交易市场: ${item.exchange}\n`;
        if (item.conv_start_date)
            details += `🔄 转股开始: ${formatDate(item.conv_start_date)}\n`;
        if (item.conv_end_date)
            details += `🔚 转股结束: ${formatDate(item.conv_end_date)}\n`;
        if (item.first_conv_price)
            details += `💲 初始转股价: ${formatNumber(item.first_conv_price)}元/股\n`;
        if (item.conv_price)
            details += `💲 当前转股价: ${formatNumber(item.conv_price)}元/股\n`;
        if (item.rate_clause)
            details += `📋 利率条款: ${item.rate_clause}\n`;
        if (item.put_clause)
            details += `🔄 回售条款: ${item.put_clause}\n`;
        if (item.force_redeem_clause)
            details += `🚨 强赎条款: ${item.force_redeem_clause}\n`;
        return output + details + '\n';
    }).join('---\n\n');
}
function formatIssueInfo(data) {
    if (!data || data.length === 0) {
        return "暂无发行信息数据\n\n";
    }
    return data.map((item, index) => {
        const output = ` ${index + 1}. 发行信息 (${item.ts_code})\n\n`;
        let details = '';
        if (item.ann_date)
            details += `📢 发行公告日: ${formatDate(item.ann_date)}\n`;
        if (item.res_ann_date)
            details += `📊 发行结果公告日: ${formatDate(item.res_ann_date)}\n`;
        if (item.plan_issue_size)
            details += `📋 计划发行总额: ${formatNumber(item.plan_issue_size)}元\n`;
        if (item.issue_size)
            details += `💰 实际发行总额: ${formatNumber(item.issue_size)}元\n`;
        if (item.issue_price)
            details += `💵 发行价格: ${formatNumber(item.issue_price)}元\n`;
        if (item.issue_type)
            details += `🏷️ 发行方式: ${item.issue_type}\n`;
        if (item.issue_cost)
            details += `💸 发行费用: ${formatNumber(item.issue_cost)}元\n`;
        // 网上发行信息
        if (item.onl_code && item.onl_name) {
            details += `\n🌐 网上发行信息:\n`;
            details += `- 申购代码: ${item.onl_code} (${item.onl_name})\n`;
            if (item.onl_date)
                details += `- 发行日期: ${formatDate(item.onl_date)}\n`;
            if (item.onl_size)
                details += `- 发行总额: ${formatNumber(item.onl_size)}张\n`;
            if (item.onl_pch_vol)
                details += `- 有效申购: ${formatNumber(item.onl_pch_vol)}张\n`;
            if (item.onl_pch_num)
                details += `- 申购户数: ${formatNumber(item.onl_pch_num)}户\n`;
            if (item.onl_pch_excess)
                details += `- 超额认购: ${formatNumber(item.onl_pch_excess)}倍\n`;
            if (item.onl_winning_rate)
                details += `- 中签率: ${formatPercent(item.onl_winning_rate)}\n`;
        }
        // 老股东配售信息
        if (item.shd_ration_code && item.shd_ration_name) {
            details += `\n👥 老股东配售信息:\n`;
            details += `- 配售代码: ${item.shd_ration_code} (${item.shd_ration_name})\n`;
            if (item.shd_ration_date)
                details += `- 配售日期: ${formatDate(item.shd_ration_date)}\n`;
            if (item.shd_ration_record_date)
                details += `- 股权登记日: ${formatDate(item.shd_ration_record_date)}\n`;
            if (item.shd_ration_pay_date)
                details += `- 缴款日: ${formatDate(item.shd_ration_pay_date)}\n`;
            if (item.shd_ration_price)
                details += `- 配售价格: ${formatNumber(item.shd_ration_price)}元\n`;
            if (item.shd_ration_ratio)
                details += `- 配售比例: ${formatNumber(item.shd_ration_ratio)}\n`;
            if (item.shd_ration_size)
                details += `- 配售数量: ${formatNumber(item.shd_ration_size)}张\n`;
            if (item.shd_ration_vol)
                details += `- 有效申购: ${formatNumber(item.shd_ration_vol)}张\n`;
            if (item.shd_ration_num)
                details += `- 申购户数: ${formatNumber(item.shd_ration_num)}户\n`;
            if (item.shd_ration_excess)
                details += `- 超额认购: ${formatNumber(item.shd_ration_excess)}倍\n`;
        }
        // 网下发行信息
        if (item.offl_size) {
            details += `\n🏢 网下发行信息:\n`;
            details += `- 发行总额: ${formatNumber(item.offl_size)}张\n`;
            if (item.offl_deposit)
                details += `- 定金比例: ${formatPercent(item.offl_deposit)}\n`;
            if (item.offl_pch_vol)
                details += `- 有效申购: ${formatNumber(item.offl_pch_vol)}张\n`;
            if (item.offl_pch_num)
                details += `- 申购户数: ${formatNumber(item.offl_pch_num)}户\n`;
            if (item.offl_pch_excess)
                details += `- 超额认购: ${formatNumber(item.offl_pch_excess)}倍\n`;
            if (item.offl_winning_rate)
                details += `- 中签率: ${formatPercent(item.offl_winning_rate)}\n`;
        }
        // 承销商信息
        if (item.lead_underwriter) {
            details += `\n🏦 承销信息:\n`;
            details += `- 主承销商: ${item.lead_underwriter}\n`;
            if (item.lead_underwriter_vol)
                details += `- 包销数量: ${formatNumber(item.lead_underwriter_vol)}张\n`;
        }
        return output + details + '\n';
    }).join('---\n\n');
}
function formatGenericCBData(data, fields) {
    if (!data || data.length === 0) {
        return "暂无数据\n\n";
    }
    return data.map((item, index) => {
        let output = ` ${index + 1}. 记录详情\n\n`;
        fields.forEach(field => {
            if (item[field] !== null && item[field] !== undefined && item[field] !== '') {
                output += `${field}: ${item[field]}\n`;
            }
        });
        return output + '\n';
    }).join('---\n\n');
}
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return '-';
    const numValue = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(numValue))
        return '-';
    return numValue.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
function formatPercent(num) {
    if (num === null || num === undefined || num === '')
        return '-';
    const numValue = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(numValue))
        return '-';
    return `${numValue.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8)
        return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}
//# sourceMappingURL=convertibleBond.js.map