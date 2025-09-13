import { TUSHARE_CONFIG } from '../config.js';
export const macroEcon = {
    name: "macro_econ",
    description: "获取宏观经济数据，包括Shibor利率、LPR利率、GDP、CPI、PPI、货币供应量、PMI、社融数据、Shibor报价、Libor、Hibor等",
    parameters: {
        type: "object",
        properties: {
            indicator: {
                type: "string",
                description: "指标类型，可选值：shibor(上海银行间同业拆放利率)、lpr(贷款市场报价利率)、gdp(国内生产总值)、cpi(居民消费价格指数)、ppi(工业生产者出厂价格指数)、cn_m(货币供应量)、cn_pmi(采购经理指数)、cn_sf(社会融资规模)、shibor_quote(Shibor银行报价数据)、libor(伦敦银行间同业拆借利率)、hibor(香港银行间同业拆借利率)"
            },
            start_date: {
                type: "string",
                description: "起始日期，格式为YYYYMMDD，如'20230101'"
            },
            end_date: {
                type: "string",
                description: "结束日期，格式为YYYYMMDD，如'20230131'"
            }
        },
        required: ["indicator", "start_date", "end_date"]
    },
    async run(args) {
        try {
            console.log(`使用Tushare API获取${args.indicator}宏观经济数据`);
            // 使用全局配置中的Tushare API设置
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            // 验证指标类型
            const validIndicators = ['shibor', 'lpr', 'gdp', 'cpi', 'ppi', 'cn_m', 'cn_pmi', 'cn_sf', 'shibor_quote', 'libor', 'hibor'];
            if (!validIndicators.includes(args.indicator)) {
                throw new Error(`不支持的指标类型: ${args.indicator}。支持的类型有: ${validIndicators.join(', ')}`);
            }
            // 根据指标类型设置不同的默认时间范围
            const today = new Date();
            const defaultEndDate = today.toISOString().slice(0, 10).replace(/-/g, '');
            let defaultStartDate = '';
            // 日期格式数据：默认30天
            const dailyIndicators = ['shibor', 'lpr', 'shibor_quote', 'libor', 'hibor'];
            // 月份格式数据：默认12个月
            const monthlyIndicators = ['cpi', 'ppi', 'cn_m', 'cn_pmi', 'cn_sf'];
            // 季度格式数据：默认8个季度
            const quarterlyIndicators = ['gdp'];
            if (dailyIndicators.includes(args.indicator)) {
                // 30天前
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                defaultStartDate = thirtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');
            }
            else if (monthlyIndicators.includes(args.indicator)) {
                // 12个月前
                const twelveMonthsAgo = new Date();
                twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
                defaultStartDate = twelveMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '');
            }
            else if (quarterlyIndicators.includes(args.indicator)) {
                // 8个季度前（约24个月）
                const eightQuartersAgo = new Date();
                eightQuartersAgo.setMonth(eightQuartersAgo.getMonth() - 24);
                defaultStartDate = eightQuartersAgo.toISOString().slice(0, 10).replace(/-/g, '');
            }
            else {
                // 其他情况默认3个月
                const threeMonthsAgo = new Date();
                threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
                defaultStartDate = threeMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '');
            }
            // 构建请求参数
            const params = {
                token: TUSHARE_API_KEY,
                params: {}, // 这里留空，后面根据不同的API添加特定参数
                fields: ""
            };
            // 根据不同指标类型设置不同的API名称、参数和字段
            switch (args.indicator) {
                case 'shibor':
                    params.api_name = "shibor";
                    params.fields = "date,on,1w,2w,1m,3m,6m,9m,1y";
                    // shibor接口使用date作为日期参数
                    params.params = {
                        start_date: args.start_date || defaultStartDate,
                        end_date: args.end_date || defaultEndDate
                    };
                    break;
                case 'lpr':
                    params.api_name = "lpr_data";
                    params.fields = "date,1y,5y";
                    // lpr_data接口使用start_date和end_date作为参数
                    params.params = {
                        start_date: args.start_date || defaultStartDate,
                        end_date: args.end_date || defaultEndDate
                    };
                    break;
                case 'gdp':
                    params.api_name = "cn_gdp";
                    params.fields = "quarter,gdp,gdp_yoy,pi,pi_yoy,si,si_yoy,ti,ti_yoy";
                    // GDP数据使用季度格式，需要转换日期格式为季度格式
                    const startYearQuarter = dateToQuarter(args.start_date || defaultStartDate);
                    const endYearQuarter = dateToQuarter(args.end_date || defaultEndDate);
                    params.params = {
                        start_q: startYearQuarter,
                        end_q: endYearQuarter
                    };
                    break;
                case 'cpi':
                    params.api_name = "cn_cpi";
                    params.fields = "month,nt_val,nt_yoy,nt_mom,nt_accu,town_val,town_yoy,town_mom,town_accu,cnt_val,cnt_yoy,cnt_mom,cnt_accu";
                    // CPI数据使用月份格式
                    const startMonth = dateToMonth(args.start_date || defaultStartDate);
                    const endMonth = dateToMonth(args.end_date || defaultEndDate);
                    params.params = {
                        start_m: startMonth,
                        end_m: endMonth
                    };
                    break;
                case 'ppi':
                    params.api_name = "cn_ppi";
                    // 映射Tushare官方文档中的完整30个字段
                    params.fields = "month,ppi_yoy,ppi_mp_yoy,ppi_mp_qm_yoy,ppi_mp_rm_yoy,ppi_mp_p_yoy,ppi_cg_yoy,ppi_cg_f_yoy,ppi_cg_c_yoy,ppi_cg_adu_yoy,ppi_cg_dcg_yoy,ppi_mom,ppi_mp_mom,ppi_mp_qm_mom,ppi_mp_rm_mom,ppi_mp_p_mom,ppi_cg_mom,ppi_cg_f_mom,ppi_cg_c_mom,ppi_cg_adu_mom,ppi_cg_dcg_mom,ppi_accu,ppi_mp_accu,ppi_mp_qm_accu,ppi_mp_rm_accu,ppi_mp_p_accu,ppi_cg_accu,ppi_cg_f_accu,ppi_cg_c_accu,ppi_cg_adu_accu,ppi_cg_dcg_accu";
                    // PPI数据使用月份格式
                    const startMonthPPI = dateToMonth(args.start_date || defaultStartDate);
                    const endMonthPPI = dateToMonth(args.end_date || defaultEndDate);
                    params.params = {
                        start_m: startMonthPPI,
                        end_m: endMonthPPI
                    };
                    break;
                case 'cn_m':
                    params.api_name = "cn_m";
                    params.fields = "month,m0,m0_yoy,m0_mom,m1,m1_yoy,m1_mom,m2,m2_yoy,m2_mom";
                    // 货币供应量数据使用月份格式
                    const startMonthM = dateToMonth(args.start_date || defaultStartDate);
                    const endMonthM = dateToMonth(args.end_date || defaultEndDate);
                    params.params = {
                        start_m: startMonthM,
                        end_m: endMonthM
                    };
                    break;
                case 'cn_pmi':
                    params.api_name = "cn_pmi";
                    // 根据Tushare文档使用所有PMI字段
                    params.fields = "month,pmi010000,pmi010100,pmi010200,pmi010300,pmi010400,pmi010500,pmi010600,pmi010700,pmi010800,pmi010900,pmi011000,pmi011100,pmi011200,pmi011300,pmi011400,pmi011500,pmi011600,pmi011700,pmi011800,pmi011900,pmi012000,pmi020100,pmi020101,pmi020102,pmi020200,pmi020201,pmi020202,pmi020300,pmi020301,pmi020302,pmi020400,pmi020401,pmi020402,pmi020500,pmi020501,pmi020502,pmi020600,pmi020601,pmi020602,pmi020700,pmi020800,pmi020900,pmi021000,pmi030000";
                    // PMI数据使用月份格式
                    const startMonthPMI = dateToMonth(args.start_date || defaultStartDate);
                    const endMonthPMI = dateToMonth(args.end_date || defaultEndDate);
                    params.params = {
                        start_m: startMonthPMI,
                        end_m: endMonthPMI
                    };
                    break;
                case 'cn_sf':
                    params.api_name = "cn_sf"; // 修正API名称
                    params.fields = "month,inc_month,inc_cumval,stk_endval";
                    // 社融增量数据使用月份格式
                    const startMonthSF = dateToMonth(args.start_date || defaultStartDate);
                    const endMonthSF = dateToMonth(args.end_date || defaultEndDate);
                    params.params = {
                        start_m: startMonthSF,
                        end_m: endMonthSF
                    };
                    break;
                case 'shibor_quote':
                    params.api_name = "shibor_quote";
                    params.fields = "date,bank,on_b,on_a,1w_b,1w_a,2w_b,2w_a,1m_b,1m_a,3m_b,3m_a,6m_b,6m_a,9m_b,9m_a,1y_b,1y_a";
                    // Shibor报价数据使用日期格式
                    params.params = {
                        start_date: args.start_date || defaultStartDate,
                        end_date: args.end_date || defaultEndDate
                    };
                    break;
                case 'libor':
                    params.api_name = "libor";
                    params.fields = "date,curr,on,1w,1m,2m,3m,6m,12m";
                    // Libor利率数据使用日期格式
                    params.params = {
                        start_date: args.start_date || defaultStartDate,
                        end_date: args.end_date || defaultEndDate,
                        curr: "USD" // 默认美元
                    };
                    break;
                case 'hibor':
                    params.api_name = "hibor";
                    params.fields = "date,on,1w,2w,1m,2m,3m,4m,5m,6m,9m,1y";
                    // Hibor利率数据使用日期格式
                    params.params = {
                        start_date: args.start_date || defaultStartDate,
                        end_date: args.end_date || defaultEndDate
                    };
                    break;
            }
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
                    throw new Error(`未找到${args.indicator}宏观经济数据`);
                }
                // 获取字段名
                const fields = data.data.fields;
                // 将数据转换为对象数组
                const econData = data.data.items.map((item) => {
                    const result = {};
                    fields.forEach((field, index) => {
                        result[field] = item[index];
                    });
                    return result;
                });
                // 生成指标表头
                let titleMap = {
                    'shibor': 'Shibor利率数据',
                    'lpr': 'LPR贷款市场报价利率',
                    'gdp': '国内生产总值(GDP)',
                    'cpi': '居民消费价格指数(CPI)',
                    'ppi': '工业生产者出厂价格指数(PPI)',
                    'cn_m': '货币供应量',
                    'cn_pmi': '采购经理指数(PMI)',
                    'cn_sf': '社会融资规模',
                    'shibor_quote': 'Shibor银行报价数据',
                    'libor': 'Libor利率数据',
                    'hibor': 'Hibor利率数据'
                };
                // 格式化数据（根据不同指标类型构建不同的格式）
                let formattedData = '';
                if (args.indicator === 'shibor' || args.indicator === 'lpr') {
                    // 日期型数据展示
                    formattedData = econData.map((data) => {
                        let row = '';
                        for (const [key, value] of Object.entries(data)) {
                            if (key !== 'date') {
                                const displayName = getRateDisplayName(key);
                                row += `${displayName}: ${value}%  `;
                            }
                        }
                        return ` ${formatDate(data.date)}\n${row}\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'shibor_quote') {
                    // Shibor报价数据展示
                    formattedData = econData.map((data) => {
                        return ` ${formatDate(data.date)} - ${data.bank}\n隔夜: 买价${data.on_b}% 卖价${data.on_a}%  1周: 买价${data['1w_b']}% 卖价${data['1w_a']}%\n1月: 买价${data['1m_b']}% 卖价${data['1m_a']}%  3月: 买价${data['3m_b']}% 卖价${data['3m_a']}%\n6月: 买价${data['6m_b']}% 卖价${data['6m_a']}%  1年: 买价${data['1y_b']}% 卖价${data['1y_a']}%\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'libor' || args.indicator === 'hibor') {
                    // 其他利率数据展示
                    formattedData = econData.map((data) => {
                        let row = '';
                        for (const [key, value] of Object.entries(data)) {
                            if (key !== 'date' && key !== 'curr') {
                                const displayName = getRateDisplayName(key);
                                row += `${displayName}: ${value}%  `;
                            }
                        }
                        const currencyInfo = data.curr ? ` (${data.curr})` : '';
                        return ` ${formatDate(data.date)}${currencyInfo}\n${row}\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'gdp') {
                    // 季度型数据展示
                    formattedData = econData.map((data) => {
                        return ` ${data.quarter}\nGDP总值: ${data.gdp}亿元  同比增长: ${data.gdp_yoy}%\n第一产业: ${data.pi}亿元  同比: ${data.pi_yoy}%\n第二产业: ${data.si}亿元  同比: ${data.si_yoy}%\n第三产业: ${data.ti}亿元  同比: ${data.ti_yoy}%\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'cpi') {
                    // CPI数据展示
                    formattedData = econData.map((data) => {
                        return ` ${formatMonth(data.month)}\n全国CPI: ${data.nt_val}  同比: ${data.nt_yoy}%  环比: ${data.nt_mom}%  累计: ${data.nt_accu}%\n城市CPI: ${data.town_val}  同比: ${data.town_yoy}%  环比: ${data.town_mom}%  累计: ${data.town_accu}%\n农村CPI: ${data.cnt_val}  同比: ${data.cnt_yoy}%  环比: ${data.cnt_mom}%  累计: ${data.cnt_accu}%\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'ppi') {
                    // PPI数据展示 - 完整30个字段的详细展示
                    formattedData = econData.map((data) => {
                        return ` ${formatMonth(data.month)}

 📊 全部工业品PPI
同比: ${data.ppi_yoy}%  环比: ${data.ppi_mom}%  累计: ${data.ppi_accu}%

 🏭 生产资料PPI
- 总体: 同比: ${data.ppi_mp_yoy}%  环比: ${data.ppi_mp_mom}%  累计: ${data.ppi_mp_accu}%
- 采掘业: 同比: ${data.ppi_mp_qm_yoy}%  环比: ${data.ppi_mp_qm_mom}%  累计: ${data.ppi_mp_qm_accu}%
- 原料业: 同比: ${data.ppi_mp_rm_yoy}%  环比: ${data.ppi_mp_rm_mom}%  累计: ${data.ppi_mp_rm_accu}%
- 加工业: 同比: ${data.ppi_mp_p_yoy}%  环比: ${data.ppi_mp_p_mom}%  累计: ${data.ppi_mp_p_accu}%

 🛍️ 生活资料PPI
- 总体: 同比: ${data.ppi_cg_yoy}%  环比: ${data.ppi_cg_mom}%  累计: ${data.ppi_cg_accu}%
- 食品类: 同比: ${data.ppi_cg_f_yoy}%  环比: ${data.ppi_cg_f_mom}%  累计: ${data.ppi_cg_f_accu}%
- 衣着类: 同比: ${data.ppi_cg_c_yoy}%  环比: ${data.ppi_cg_c_mom}%  累计: ${data.ppi_cg_c_accu}%
- 一般日用品类: 同比: ${data.ppi_cg_adu_yoy}%  环比: ${data.ppi_cg_adu_mom}%  累计: ${data.ppi_cg_adu_accu}%
- 耐用消费品类: 同比: ${data.ppi_cg_dcg_yoy}%  环比: ${data.ppi_cg_dcg_mom}%  累计: ${data.ppi_cg_dcg_accu}%
`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'cn_m') {
                    // 货币供应量数据展示
                    formattedData = econData.map((data) => {
                        return ` ${formatMonth(data.month)}\nM0: ${data.m0}亿元  同比: ${data.m0_yoy}%  环比: ${data.m0_mom}%\nM1: ${data.m1}亿元  同比: ${data.m1_yoy}%  环比: ${data.m1_mom}%\nM2: ${data.m2}亿元  同比: ${data.m2_yoy}%  环比: ${data.m2_mom}%\n`;
                    }).join('\n---\n\n');
                }
                else if (args.indicator === 'cn_pmi') {
                    // PMI数据展示 - 横向指标表格格式
                    // PMI指标定义
                    const pmiIndicators = [
                        { name: '制造业PMI', field: 'pmi010000' },
                        { name: '生产指数', field: 'pmi010100' },
                        { name: '新订单指数', field: 'pmi010200' },
                        { name: '新出口订单指数', field: 'pmi010300' },
                        { name: '在手订单指数', field: 'pmi010400' },
                        { name: '产成品库存指数', field: 'pmi010500' },
                        { name: '采购量指数', field: 'pmi010600' },
                        { name: '进口指数', field: 'pmi010700' },
                        { name: '购进价格指数', field: 'pmi010800' },
                        { name: '原材料库存指数', field: 'pmi010900' },
                        { name: '从业人员指数', field: 'pmi011000' },
                        { name: '供应商配送时间指数', field: 'pmi011100' },
                        { name: '生产经营活动预期指数', field: 'pmi011200' },
                        { name: '基础原材料制造业PMI', field: 'pmi011300' },
                        { name: '消费品制造业PMI', field: 'pmi011400' },
                        { name: '装备制造业PMI', field: 'pmi011500' },
                        { name: '高技术制造业PMI', field: 'pmi011600' },
                        { name: '大型企业PMI', field: 'pmi011700' },
                        { name: '中型企业PMI', field: 'pmi011800' },
                        { name: '小型企业PMI', field: 'pmi011900' },
                        { name: '消费品制造业PMI(分类)', field: 'pmi012000' },
                        { name: '非制造业商务活动指数', field: 'pmi020100' },
                        { name: '建筑业商务活动指数', field: 'pmi020101' },
                        { name: '服务业商务活动指数', field: 'pmi020102' },
                        { name: '非制造业新订单指数', field: 'pmi020200' },
                        { name: '建筑业新订单指数', field: 'pmi020201' },
                        { name: '服务业新订单指数', field: 'pmi020202' },
                        { name: '非制造业投入品价格指数', field: 'pmi020300' },
                        { name: '建筑业投入品价格指数', field: 'pmi020301' },
                        { name: '服务业投入品价格指数', field: 'pmi020302' },
                        { name: '非制造业销售价格指数', field: 'pmi020400' },
                        { name: '建筑业销售价格指数', field: 'pmi020401' },
                        { name: '服务业销售价格指数', field: 'pmi020402' },
                        { name: '非制造业从业人员指数', field: 'pmi020500' },
                        { name: '建筑业从业人员指数', field: 'pmi020501' },
                        { name: '服务业从业人员指数', field: 'pmi020502' },
                        { name: '非制造业业务活动预期指数', field: 'pmi020600' },
                        { name: '建筑业业务活动预期指数', field: 'pmi020601' },
                        { name: '服务业业务活动预期指数', field: 'pmi020602' },
                        { name: '非制造业新出口订单指数', field: 'pmi020700' },
                        { name: '非制造业在手订单指数', field: 'pmi020800' },
                        { name: '非制造业存货指数', field: 'pmi020900' },
                        { name: '非制造业供应商配送时间指数', field: 'pmi021000' },
                        { name: '综合PMI产出指数', field: 'pmi030000' }
                    ];
                    // 构建表头：月份 | 指标1 | 指标2 | ...
                    const tableHeader = '| 月份 | ' + pmiIndicators.map(indicator => indicator.name).join(' | ') + ' |';
                    const tableSeparator = '|' + '---|'.repeat(pmiIndicators.length + 1);
                    // 构建数据行：每行一个月份的所有指标数据
                    const tableRows = econData.map((data) => {
                        const rowData = pmiIndicators.map(indicator => data[indicator.field] || '-').join(' | ');
                        return `| ${formatMonth(data.month)} | ${rowData} |`;
                    });
                    formattedData = ` 采购经理指数(PMI)数据

${tableHeader}
${tableSeparator}
${tableRows.join('\n')}

数据说明：PMI指数50为荣枯分界线，高于50表示扩张，低于50表示收缩。`;
                }
                else if (args.indicator === 'cn_sf') {
                    // 社融增量数据展示
                    formattedData = econData.map((data) => {
                        return ` ${formatMonth(data.month)}\n当月增量: ${data.inc_month}亿元  累计增量: ${data.inc_cumval}亿元\n存量期末值: ${data.stk_endval}万亿元\n`;
                    }).join('\n---\n\n');
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: ` ${titleMap[args.indicator]}\n\n查询时间范围: ${args.start_date || defaultStartDate} - ${args.end_date || defaultEndDate}\n数据条数: ${econData.length}条记录\n\n---\n\n${formattedData}`
                        }
                    ]
                };
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (error) {
            console.error("获取宏观经济数据失败:", error);
            return {
                content: [
                    {
                        type: "text",
                        text: ` 获取${args.indicator}宏观经济数据失败\n\n错误信息: ${error instanceof Error ? error.message : String(error)}\n\n支持的指标类型: \n- shibor: 上海银行间同业拆放利率\n- lpr: 贷款市场报价利率\n- gdp: 国内生产总值\n- cpi: 居民消费价格指数\n- ppi: 工业生产者出厂价格指数\n- cn_m: 货币供应量\n- cn_pmi: 采购经理指数\n- cn_sf: 社会融资规模\n- shibor_quote: Shibor银行报价数据\n- libor: 伦敦银行间同业拆借利率\n- hibor: 香港银行间同业拆借利率`
                    }
                ]
            };
        }
    }
};
/*
 * 获取利率字段的显示名称
 */
function getRateDisplayName(key) {
    const nameMap = {
        'on': '隔夜',
        '1w': '1周',
        '2w': '2周',
        '1m': '1月',
        '2m': '2月',
        '3m': '3月',
        '4m': '4月',
        '5m': '5月',
        '6m': '6月',
        '9m': '9月',
        '1y': '1年',
        '5y': '5年',
        '12m': '12月'
    };
    return nameMap[key] || key;
}
/*
 * 格式化日期显示
 */
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8)
        return dateStr;
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${year}年${month}月${day}日`;
}
/*
 * 格式化月份显示
 */
function formatMonth(monthStr) {
    if (!monthStr || monthStr.length !== 6)
        return monthStr;
    const year = monthStr.substring(0, 4);
    const month = monthStr.substring(4, 6);
    return `${year}年${month}月`;
}
/*
 * 将日期格式(YYYYMMDD)转换为季度格式(YYYYQN)
 */
function dateToQuarter(dateStr) {
    if (!dateStr || dateStr.length < 8)
        return "";
    const year = dateStr.substring(0, 4);
    const month = parseInt(dateStr.substring(4, 6));
    // 确定季度
    let quarter;
    if (month >= 1 && month <= 3)
        quarter = 1;
    else if (month >= 4 && month <= 6)
        quarter = 2;
    else if (month >= 7 && month <= 9)
        quarter = 3;
    else
        quarter = 4;
    return `${year}Q${quarter}`;
}
/*
 * 将日期格式(YYYYMMDD)转换为月份格式(YYYYMM)
 */
function dateToMonth(dateStr) {
    if (!dateStr || dateStr.length < 8)
        return "";
    return dateStr.substring(0, 6);
}
//# sourceMappingURL=macroEcon.js.map