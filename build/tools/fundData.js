import { TUSHARE_CONFIG } from '../config.js';
export const fundData = {
    name: "fund_data",
    description: "获取公募基金和ETF相关数据，包括基金列表、基金经理、基金净值、基金分红、基金持仓、基金公司、ETF复权因子、销售保有规模和场内基金专业因子等数据。",
    parameters: {
        type: "object",
        properties: {
            ts_code: {
                type: "string",
                description: "基金代码，如'150018.SZ'表示银华深证100分级，'001753.OF'表示场外基金。注意：查询基金列表(basic)时必须提供此参数"
            },
            data_type: {
                type: "string",
                description: "数据类型，可选值：basic(基金列表)、manager(基金经理)、nav(基金净值)、dividend(基金分红)、portfolio(基金持仓)、company(基金管理人列表)、adjustment(ETF/基金复权因子)、sales_volume(销售机构公募基金保有规模)、factor(场内基金专业技术因子)、all(基础组合数据)",
                enum: ["basic", "manager", "nav", "dividend", "portfolio", "company", "adjustment", "sales_volume", "factor", "all"]
            },
            start_date: {
                type: "string",
                description: "起始日期，格式为YYYYMMDD，如'20230101'。重要：对于基金持仓(portfolio)数据和基金净值(nav)数据，如果不指定时间参数，将返回所有历史数据，可能数据量很大。建议指定时间范围或使用period参数"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式为YYYYMMDD，如'20231231'。配合start_date使用可限制数据范围"
            },
            period: {
                type: "string",
                description: "特定报告期，格式为YYYYMMDD。例如：'20231231'表示2023年年报，'20240630'表示2024年中报，'20220630'表示2022年三季报，'20240331'表示2024年一季报。指定此参数时将忽略start_date和end_date"
            },
            trade_date: {
                type: "string",
                description: "交易日期，格式为YYYYMMDD。用于 adjustment/factor 等按交易日查询的分支"
            },
            name: {
                type: "string",
                description: "机构名称。用于 sales_volume 查询销售机构保有规模"
            },
            year: {
                type: "string",
                description: "年度。用于 sales_volume，例如'2024'"
            },
            quarter: {
                type: "string",
                description: "季度。用于 sales_volume，例如'1'、'2'、'3'、'4'"
            }
        },
        required: ["data_type"]
    },
    async run(args) {
        try {
            console.log('基金数据查询参数:', args);
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
            const dataTypes = args.data_type === 'all'
                ? ['basic', 'manager', 'nav', 'dividend', 'portfolio']
                : [args.data_type];
            for (const dataType of dataTypes) {
                try {
                    // 基金列表(basic)模块必须提供基金代码，否则跳过
                    if (dataType === 'basic' && !args.ts_code) {
                        console.warn('基金列表查询需要提供基金代码，跳过basic模块');
                        results.push({
                            type: dataType,
                            error: '基金列表查询需要提供基金代码(ts_code)参数，否则数据量过大'
                        });
                        continue;
                    }
                    const result = await fetchFundData(dataType, args.ts_code, args.period, args.start_date || defaultStartDate, args.end_date || defaultEndDate, {
                        tradeDate: args.trade_date,
                        name: args.name,
                        year: args.year,
                        quarter: args.quarter,
                    }, TUSHARE_API_KEY, TUSHARE_API_URL);
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
                throw new Error(`未找到相关基金数据`);
            }
            // 格式化输出
            const formattedOutput = formatFundData(results, args.ts_code);
            return {
                content: [{ type: "text", text: formattedOutput }]
            };
        }
        catch (error) {
            console.error('基金数据查询错误:', error);
            return {
                content: [{
                        type: "text",
                        text: `查询基金数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}`
                    }]
            };
        }
    }
};
// 获取基金数据的通用函数
async function fetchFundData(dataType, tsCode, period, startDate, endDate, options, apiKey, apiUrl) {
    const apiConfigs = {
        basic: {
            api_name: "fund_basic",
            default_fields: "ts_code,name,management,custodian,fund_type,found_date,due_date,list_date,issue_date,delist_date,issue_amount,m_fee,c_fee,duration_year,p_value,min_amount,exp_return,benchmark,status,invest_type,type,trustee,purc_startdate,redm_startdate,market"
        },
        manager: {
            api_name: "fund_manager",
            default_fields: "ts_code,ann_date,name,gender,birth_year,edu,nationality,begin_date,end_date,resume"
        },
        nav: {
            api_name: "fund_nav",
            default_fields: "ts_code,ann_date,nav_date,unit_nav,accum_nav,accum_div,net_asset,total_netasset,adj_nav"
        },
        dividend: {
            api_name: "fund_div",
            default_fields: "ts_code,ann_date,imp_anndate,base_date,div_proc,record_date,ex_date,pay_date,earpay_date,net_ex_date,div_cash,base_unit,ear_distr,ear_amount,account_date,base_year"
        },
        portfolio: {
            api_name: "fund_portfolio",
            default_fields: "ts_code,ann_date,end_date,symbol,mkv,amount,stk_mkv_ratio,stk_float_ratio"
        },
        company: {
            api_name: "fund_company",
            default_fields: "name,shortname,province,city,address,phone,office,website,chairman,manager,reg_capital,setup_date,end_date,employees,main_business,org_code,credit_code,short_enname"
        },
        adjustment: {
            api_name: "fund_adj",
            default_fields: "ts_code,trade_date,adj_factor"
        },
        sales_volume: {
            api_name: "fund_sales_vol",
            default_fields: "year,quarter,inst_name,fund_scale,scale,rank"
        },
        factor: {
            api_name: "fund_factor_pro",
            default_fields: "ts_code,trade_date,open,high,low,close,pre_close,change,pct_change,vol,amount,ma_bfq_5,ma_bfq_10,ma_bfq_20,ma_bfq_60,macd_dif_bfq,macd_dea_bfq,macd_bfq,kdj_k_bfq,kdj_d_bfq,kdj_bfq,rsi_bfq_6,rsi_bfq_12,rsi_bfq_24,boll_upper_bfq,boll_mid_bfq,boll_lower_bfq"
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
    // 根据不同的API添加特定参数
    if (dataType === 'basic') {
        if (tsCode)
            params.params.ts_code = tsCode;
    }
    else if (dataType === 'manager') {
        if (tsCode)
            params.params.ts_code = tsCode;
    }
    else if (dataType === 'nav') {
        if (tsCode)
            params.params.ts_code = tsCode;
        if (period) {
            params.params.nav_date = period;
        }
        else {
            if (startDate)
                params.params.start_date = startDate;
            if (endDate)
                params.params.end_date = endDate;
        }
    }
    else if (dataType === 'dividend') {
        if (tsCode)
            params.params.ts_code = tsCode;
    }
    else if (dataType === 'portfolio') {
        if (tsCode)
            params.params.ts_code = tsCode;
        if (period) {
            params.params.period = period;
        }
        else {
            if (startDate)
                params.params.start_date = startDate;
            if (endDate)
                params.params.end_date = endDate;
        }
    }
    else if (dataType === 'company') {
        // fund_company has no useful filter in the official schema.
    }
    else if (dataType === 'adjustment') {
        if (tsCode)
            params.params.ts_code = tsCode;
        if (options?.tradeDate || period) {
            params.params.trade_date = options?.tradeDate || period;
        }
        else {
            if (startDate)
                params.params.start_date = startDate;
            if (endDate)
                params.params.end_date = endDate;
        }
    }
    else if (dataType === 'sales_volume') {
        if (options?.name)
            params.params.name = options.name;
        if (options?.year)
            params.params.year = options.year;
        if (options?.quarter)
            params.params.quarter = options.quarter;
    }
    else if (dataType === 'factor') {
        if (tsCode)
            params.params.ts_code = tsCode;
        if (options?.tradeDate || period) {
            params.params.trade_date = options?.tradeDate || period;
        }
        else {
            if (startDate)
                params.params.start_date = startDate;
            if (endDate)
                params.params.end_date = endDate;
        }
    }
    console.log(`调用${config.api_name} API，参数:`, JSON.stringify(redactToken(params), null, 2));
    // 设置请求超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        const response = await fetch(apiUrl || 'https://api.tushare.pro', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        if (result.code !== 0) {
            throw new Error(`API返回错误: ${result.msg || '未知错误'}`);
        }
        if (!result.data || !result.data.items) {
            return { data: [], fields: result.data?.fields || [] };
        }
        // 转换数据格式
        const formattedData = result.data.items.map((item) => {
            const obj = {};
            result.data.fields.forEach((field, index) => {
                obj[field] = item[index];
            });
            return obj;
        });
        // 对某些数据类型进行日期范围过滤
        let filteredData = formattedData;
        if (['dividend'].includes(dataType) && startDate && endDate && !period) {
            filteredData = formattedData.filter((item) => {
                const annDate = item.ann_date;
                if (!annDate)
                    return true;
                return annDate >= startDate && annDate <= endDate;
            });
            console.log(`日期范围过滤后剩余${filteredData.length}条${dataType}记录`);
        }
        console.log(`成功获取到${filteredData.length}条${dataType}数据记录`);
        // 如果是净值数据且有基金代码，尝试获取基金份额数据并合并
        if (dataType === 'nav' && tsCode && filteredData.length > 0) {
            try {
                const shareResult = await fetchFundShareData(tsCode, startDate, endDate, period, apiKey, apiUrl);
                if (shareResult.data && shareResult.data.length > 0) {
                    // 创建份额数据的映射表，以交易日期为键
                    const shareMap = new Map();
                    shareResult.data.forEach((shareItem) => {
                        shareMap.set(shareItem.trade_date, shareItem.fd_share);
                    });
                    // 将份额数据合并到净值数据中
                    filteredData.forEach((navItem) => {
                        const tradeDate = navItem.nav_date || navItem.ann_date;
                        navItem.fd_share = shareMap.get(tradeDate) || null;
                    });
                    console.log(`成功合并${shareResult.data.length}条基金份额数据`);
                }
            }
            catch (error) {
                console.warn('获取基金份额数据失败，将继续返回净值数据:', error);
            }
        }
        return {
            data: filteredData,
            fields: result.data.fields
        };
    }
    catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}
// 获取基金份额数据的函数
async function fetchFundShareData(tsCode, startDate, endDate, period, apiKey, apiUrl) {
    const params = {
        api_name: "fund_share",
        token: apiKey,
        params: {
            ts_code: tsCode
        },
        fields: "ts_code,trade_date,fd_share"
    };
    // 添加时间参数
    if (period) {
        params.params.trade_date = period;
    }
    else {
        if (startDate)
            params.params.start_date = startDate;
        if (endDate)
            params.params.end_date = endDate;
    }
    console.log(`调用fund_share API，参数:`, JSON.stringify(redactToken(params), null, 2));
    // 设置请求超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        const response = await fetch(apiUrl || 'https://api.tushare.pro', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        if (result.code !== 0) {
            throw new Error(`API返回错误: ${result.msg || '未知错误'}`);
        }
        if (!result.data || !result.data.items) {
            return { data: [], fields: result.data?.fields || [] };
        }
        // 转换数据格式
        const formattedData = result.data.items.map((item) => {
            const obj = {};
            result.data.fields.forEach((field, index) => {
                obj[field] = item[index];
            });
            return obj;
        });
        return {
            data: formattedData,
            fields: result.data.fields
        };
    }
    catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}
// 格式化基金数据输出
function formatFundData(results, tsCode) {
    let output = `# 基金数据查询结果\n\n`;
    if (tsCode) {
        output += `基金代码: ${tsCode}\n\n`;
    }
    for (const result of results) {
        if (result.error) {
            output += `# ${getDataTypeName(result.type)}\n❌ 查询失败: ${result.error}\n\n`;
            continue;
        }
        output += `# ${getDataTypeName(result.type)}\n`;
        output += `数据条数: ${result.data.length}\n\n`;
        if (result.data.length > 0) {
            switch (result.type) {
                case 'basic':
                    output += formatBasicData(result.data);
                    break;
                case 'manager':
                    output += formatManagerData(result.data);
                    break;
                case 'nav':
                    output += formatNavData(result.data);
                    break;
                case 'dividend':
                    output += formatDividendData(result.data);
                    break;
                case 'portfolio':
                    output += formatPortfolioData(result.data);
                    break;
                case 'company':
                    output += formatFundCompanyData(result.data);
                    break;
                case 'adjustment':
                    output += formatFundAdjustmentData(result.data);
                    break;
                case 'sales_volume':
                    output += formatFundSalesVolumeData(result.data);
                    break;
                case 'factor':
                    output += formatFundFactorData(result.data);
                    break;
                default:
                    output += formatGenericFundData(result.data, result.fields);
            }
        }
        output += '\n';
    }
    return output;
}
function getDataTypeName(type) {
    const names = {
        basic: '基金基本信息',
        manager: '基金经理',
        nav: '基金净值',
        dividend: '基金分红',
        portfolio: '基金持仓',
        company: '基金管理人列表',
        adjustment: 'ETF/基金复权因子',
        sales_volume: '销售机构公募基金保有规模',
        factor: '场内基金专业技术因子'
    };
    return names[type] || type;
}
function formatBasicData(data) {
    let output = '';
    data.forEach((item, index) => {
        output += `## ${index + 1}. ${item.name || '未知基金'} (${item.ts_code})\n`;
        output += `- 管理人: ${item.management || 'N/A'}\n`;
        output += `- 托管人: ${item.custodian || 'N/A'}\n`;
        output += `- 投资类型: ${item.fund_type || 'N/A'}\n`;
        output += `- 成立日期: ${item.found_date || 'N/A'}\n`;
        output += `- 上市时间: ${item.list_date || 'N/A'}\n`;
        output += `- 存续状态: ${item.status || 'N/A'}\n`;
        output += `- 市场: ${item.market === 'E' ? '场内' : item.market === 'O' ? '场外' : item.market || 'N/A'}\n`;
        if (item.m_fee)
            output += `- 管理费: ${formatPercent(item.m_fee)}%\n`;
        if (item.c_fee)
            output += `- 托管费: ${formatPercent(item.c_fee)}%\n`;
        output += '\n';
    });
    return output;
}
function formatManagerData(data) {
    let output = '';
    data.forEach((item, index) => {
        output += `## ${index + 1}. ${item.name || '未知经理'} (${item.ts_code})\n`;
        output += `- 性别: ${item.gender === 'M' ? '男' : item.gender === 'F' ? '女' : item.gender || 'N/A'}\n`;
        output += `- 出生年份: ${item.birth_year || 'N/A'}\n`;
        output += `- 学历: ${item.edu || 'N/A'}\n`;
        output += `- 国籍: ${item.nationality || 'N/A'}\n`;
        output += `- 任职日期: ${item.begin_date || 'N/A'}\n`;
        output += `- 离任日期: ${item.end_date || '在任'}\n`;
        output += `- 公告日期: ${item.ann_date || 'N/A'}\n`;
        if (item.resume) {
            const resumeShort = item.resume;
            output += `- 简历: ${resumeShort}\n`;
        }
        output += '\n';
    });
    return output;
}
function formatNavData(data) {
    let output = '';
    // 按日期排序，最新的在前
    const sortedData = data.sort((a, b) => {
        const dateA = a.nav_date || a.ann_date || '';
        const dateB = b.nav_date || b.ann_date || '';
        return dateB.localeCompare(dateA);
    });
    // 检查是否有基金份额数据
    const hasShareData = sortedData.some(item => item.fd_share !== null && item.fd_share !== undefined);
    if (hasShareData) {
        output += '| 净值日期 | 单位净值 | 累计净值 | 复权净值 | 资产净值 | 基金份额(万份) |\n';
        output += '|---------|----------|----------|----------|----------|---------------|\n';
        sortedData.forEach(item => {
            const shareFormatted = item.fd_share ? formatNumber(item.fd_share) : 'N/A';
            output += `| ${item.nav_date || 'N/A'} | ${formatNumber(item.unit_nav)} | ${formatNumber(item.accum_nav)} | ${formatNumber(item.adj_nav)} | ${formatNumber(item.net_asset)} | ${shareFormatted} |\n`;
        });
    }
    else {
        output += '| 净值日期 | 单位净值 | 累计净值 | 复权净值 | 资产净值 |\n';
        output += '|---------|----------|----------|----------|----------|\n';
        sortedData.forEach(item => {
            output += `| ${item.nav_date || 'N/A'} | ${formatNumber(item.unit_nav)} | ${formatNumber(item.accum_nav)} | ${formatNumber(item.adj_nav)} | ${formatNumber(item.net_asset)} |\n`;
        });
    }
    return output;
}
function formatDividendData(data) {
    let output = '';
    // 按公告日期排序，最新的在前
    const sortedData = data.sort((a, b) => {
        const dateA = a.ann_date || '';
        const dateB = b.ann_date || '';
        return dateB.localeCompare(dateA);
    });
    output += '| 公告日期 | 基准日期 | 分红方案 | 每股派息(元) | 除息日 | 派息日 | 权益登记日 |\n';
    output += '|---------|----------|----------|-------------|-------|-------|----------|\n';
    sortedData.forEach(item => {
        output += `| ${item.ann_date || 'N/A'} | ${item.base_date || 'N/A'} | ${item.div_proc || 'N/A'} | ${formatNumber(item.div_cash)} | ${item.ex_date || 'N/A'} | ${item.pay_date || 'N/A'} | ${item.record_date || 'N/A'} |\n`;
    });
    return output;
}
function formatPortfolioData(data) {
    let output = '';
    // 按报告期分组
    const groupedByPeriod = data.reduce((groups, item) => {
        const periodKey = `${item.end_date || 'Unknown'}_${item.ann_date || 'Unknown'}`;
        if (!groups[periodKey]) {
            groups[periodKey] = {
                end_date: item.end_date,
                ann_date: item.ann_date,
                holdings: []
            };
        }
        groups[periodKey].holdings.push(item);
        return groups;
    }, {});
    // 按报告期排序（最新的在前）
    const sortedPeriods = Object.values(groupedByPeriod).sort((a, b) => {
        const dateA = a.end_date || a.ann_date || '';
        const dateB = b.end_date || b.ann_date || '';
        return dateB.localeCompare(dateA);
    });
    sortedPeriods.forEach((period) => {
        output += `## 📊 报告期: ${period.end_date || 'N/A'}  (公告日期: ${period.ann_date || 'N/A'})\n`;
        output += `持仓股票数量: ${period.holdings.length}只\n\n`;
        // 按持有市值排序，从大到小
        const sortedHoldings = period.holdings.sort((a, b) => {
            const mvkA = parseFloat(a.mkv) || 0;
            const mvkB = parseFloat(b.mkv) || 0;
            return mvkB - mvkA;
        });
        output += '| 股票代码 | 持有市值(万元) | 持有数量(股) | 占基金净值比(%) | 占流通股本比(%) |\n';
        output += '|---------|---------------|-------------|----------------|----------------|\n';
        // 只显示前20大重仓股
        sortedHoldings.slice(0, 20).forEach((item) => {
            const mkv = formatNumber(parseFloat(item.mkv) / 10000); // 转换为万元
            const amount = formatNumber(item.amount);
            const mkvRatio = formatPercent(item.stk_mkv_ratio);
            const floatRatio = formatPercent(item.stk_float_ratio);
            output += `| ${item.symbol || 'N/A'} | ${mkv} | ${amount} | ${mkvRatio} | ${floatRatio} |\n`;
        });
        if (sortedHoldings.length > 20) {
            output += `\n💡 注：仅显示前20大重仓股，共持有${sortedHoldings.length}只股票\n`;
        }
        output += '\n---\n\n';
    });
    return output;
}
function formatFundCompanyData(data) {
    let output = '| 管理人 | 简称 | 地区 | 注册资本 | 成立日期 | 员工数 | 网站 |\n';
    output += '|--------|------|------|----------|----------|--------|------|\n';
    data.slice(0, 80).forEach(item => {
        output += `| ${item.name || 'N/A'} | ${item.shortname || 'N/A'} | ${[item.province, item.city].filter(Boolean).join('/') || 'N/A'} | ${formatNumber(item.reg_capital)} | ${item.setup_date || 'N/A'} | ${item.employees || 'N/A'} | ${item.website || 'N/A'} |\n`;
    });
    if (data.length > 80)
        output += `\n注：仅显示前80条，共${data.length}条。\n`;
    return output;
}
function formatFundAdjustmentData(data) {
    const sorted = [...data].sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
    let output = '| 交易日期 | 基金代码 | 复权因子 |\n';
    output += '|----------|----------|----------|\n';
    sorted.forEach(item => {
        output += `| ${item.trade_date || 'N/A'} | ${item.ts_code || 'N/A'} | ${formatNumber(item.adj_factor)} |\n`;
    });
    return output;
}
function formatFundSalesVolumeData(data) {
    const sorted = [...data].sort((a, b) => {
        const periodB = `${b.year || ''}${b.quarter || ''}`;
        const periodA = `${a.year || ''}${a.quarter || ''}`;
        const periodCmp = periodB.localeCompare(periodA);
        if (periodCmp !== 0)
            return periodCmp;
        return (parseFloat(a.rank) || 9999) - (parseFloat(b.rank) || 9999);
    });
    let output = '| 年度 | 季度 | 排名 | 机构 | 股票+混合基金保有规模 | 非货基金保有规模 |\n';
    output += '|------|------|------|------|----------------------|----------------|\n';
    sorted.forEach(item => {
        output += `| ${item.year || 'N/A'} | ${item.quarter || 'N/A'} | ${item.rank || 'N/A'} | ${item.inst_name || 'N/A'} | ${formatNumber(item.fund_scale)} | ${formatNumber(item.scale)} |\n`;
    });
    return output;
}
function formatFundFactorData(data) {
    const sorted = [...data].sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
    let output = '| 日期 | 代码 | 收盘 | 涨跌幅% | 成交量 | MA5 | MA20 | MACD | KDJ-K | RSI6 | BOLL上轨 | BOLL中轨 | BOLL下轨 |\n';
    output += '|------|------|------|---------|--------|-----|------|------|-------|------|----------|----------|----------|\n';
    sorted.forEach(item => {
        output += `| ${item.trade_date || 'N/A'} | ${item.ts_code || 'N/A'} | ${formatNumber(item.close)} | ${formatPercent(item.pct_change)} | ${formatNumber(item.vol)} | ${formatNumber(item.ma_bfq_5)} | ${formatNumber(item.ma_bfq_20)} | ${formatNumber(item.macd_bfq)} | ${formatNumber(item.kdj_k_bfq)} | ${formatNumber(item.rsi_bfq_6)} | ${formatNumber(item.boll_upper_bfq)} | ${formatNumber(item.boll_mid_bfq)} | ${formatNumber(item.boll_lower_bfq)} |\n`;
    });
    return output;
}
function formatGenericFundData(data, fields) {
    let output = '';
    if (data.length === 0)
        return '暂无数据\n';
    // 表头
    output += '| ' + fields.slice(0, 6).join(' | ') + ' |\n';
    output += '|' + fields.slice(0, 6).map(() => '-------').join('|') + '|\n';
    // 数据行
    data.forEach(item => {
        const row = fields.slice(0, 6).map(field => {
            const value = item[field];
            if (value === null || value === undefined)
                return 'N/A';
            if (typeof value === 'string' && value.length > 15) {
                return value.substring(0, 12) + '...';
            }
            return String(value);
        });
        output += '| ' + row.join(' | ') + ' |\n';
    });
    return output;
}
function formatNumber(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const value = parseFloat(num);
    if (isNaN(value))
        return 'N/A';
    if (Math.abs(value) >= 1e8) {
        return (value / 1e8).toFixed(2) + '亿';
    }
    else if (Math.abs(value) >= 1e4) {
        return (value / 1e4).toFixed(2) + '万';
    }
    else {
        return value.toFixed(2);
    }
}
function formatPercent(num) {
    if (num === null || num === undefined || num === '')
        return 'N/A';
    const value = parseFloat(num);
    if (isNaN(value))
        return 'N/A';
    return value.toFixed(2);
}
function redactToken(payload) {
    return {
        ...payload,
        token: payload.token ? '[redacted]' : payload.token
    };
}
