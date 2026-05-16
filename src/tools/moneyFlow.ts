import { TUSHARE_CONFIG } from '../config.js';
import { callTushare } from '../utils/tushareClient.js';

export const moneyFlow = {
  name: "money_flow",
  description: [
    "获取个股/大盘/板块的资金流向数据（主力、超大单、大单、中单、小单的净流入净额与净占比）。",
    "数据源与接口：",
    "1) 个股 → Tushare 标准接口 moneyflow（沪深A股主动买卖单统计，2000 积分可正式调取；个股无涨跌幅/净占比字段，输出会显示 N/A）。",
    "2) 大盘 → Tushare 东方财富接口 moneyflow_mkt_dc（5000 积分可正式调取）。",
    "3) 板块（行业/概念/地域）→ Tushare 东方财富接口 moneyflow_ind_dc（6000 积分可正式调取，板块代码形如 'BK0486.DC'）。",
    "注意：大盘与板块接口为东财数据源，若 Token 积分未达门槛，Tushare 会限制为每小时/每日仅 2 次试用，此时会返回明确的访问受限提示。"
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      query_type: {
        type: "string",
        description: "查询类型：stock=个股，market=大盘，sector=板块，northbound=北向资金（港股通持股/沪深港通十大成交股）。默认根据ts_code自动判断"
      },
      ts_code: {
        type: "string",
        description: "股票代码或板块代码。个股形如 '000001.SZ'；东财板块代码带 .DC 后缀，形如 'BK0486.DC'（可先用 trade_date + query_type='sector' 查全板块列表以获取代码）。不填写则查询大盘资金流向。"
      },
      start_date: {
        type: "string",
        description: "起始日期，格式为YYYYMMDD，如'20240901'"
      },
      end_date: {
        type: "string",
        description: "结束日期，格式为YYYYMMDD，如'20240930'"
      },
      content_type: {
        type: "string",
        description: "板块资金类型，仅在查询板块时有效。可选：行业、概念、地域"
      },
      trade_date: {
        type: "string",
        description: "单独查询某个交易日的数据，格式为YYYYMMDD。northbound查询时为主要输入；其他类型填写则忽略start_date和end_date"
      }
    },
    required: []
  },
  async run(args: {
    query_type?: string;
    ts_code?: string;
    start_date?: string;
    end_date?: string;
    content_type?: string;
    trade_date?: string;
  }) {
    try {
      console.log('资金流向数据查询参数:', args);
      
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      if (!TUSHARE_API_KEY) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      // 判断查询类型
      let queryType = args.query_type;

      // northbound 分支：北向资金（港股通持股 / 沪深港通十大成交股）
      if (queryType === 'northbound') {
        const result = await fetchNorthboundFlow(args.ts_code, args.trade_date, TUSHARE_API_KEY, TUSHARE_API_URL);
        if (!result.data || result.data.length === 0) {
          throw new Error('未找到北向资金数据，请确认 trade_date 为有效交易日');
        }
        return { content: [{ type: 'text', text: formatNorthboundData(result.data, result.apiUsed, args.ts_code) }] };
      }

      if (!queryType) {
        // 自动判断：没有ts_code=大盘，有BK开头=板块，否则=个股
        if (!args.ts_code || args.ts_code.trim() === '') {
          queryType = 'market';
        } else if (args.ts_code.startsWith('BK')) {
          queryType = 'sector';
        } else {
          queryType = 'stock';
        }
      }
      
      let result;
      let targetName = '';
      
      if (queryType === 'market') {
        // 查询大盘资金流向
        targetName = '大盘';
        result = await fetchMarketMoneyFlow(
          (args.trade_date || args.start_date) ?? '',
          (args.trade_date || args.end_date) ?? '',
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      } else if (queryType === 'sector') {
        // 查询板块资金流向
        targetName = `板块${args.ts_code || ''}`;
        result = await fetchSectorMoneyFlow(
          args.ts_code,
          args.trade_date,
          args.start_date ?? '',
          args.end_date ?? '',
          args.content_type,
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      } else {
        // 查询个股资金流向
        targetName = `股票${args.ts_code}`;
        result = await fetchStockMoneyFlow(
          args.ts_code!,
          (args.trade_date || args.start_date) ?? '',
          (args.trade_date || args.end_date) ?? '',
          TUSHARE_API_KEY,
          TUSHARE_API_URL
        );
      }

      if (!result.data || result.data.length === 0) {
        throw new Error(`未找到${targetName}在指定时间范围内的资金流向数据`);
      }

      // 格式化输出
      const formattedOutput = formatMoneyFlowData(
        result.data, 
        result.fields, 
        queryType, 
        args.ts_code
      );
      
      return {
        content: [{ type: "text", text: formattedOutput }]
      };

    } catch (error) {
      console.error('资金流向数据查询错误:', error);
      return {
        content: [{ 
          type: "text", 
          text: `查询资金流向数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}` 
        }]
      };
    }
  }
};

// 获取大盘资金流向数据
// 说明：Tushare 没有非 DC 版本的大盘资金流向接口，只能使用 moneyflow_mkt_dc；
// 该接口需 5000 积分才能正式调取，低积分 Token 每日仅能试用 2 次。
async function fetchMarketMoneyFlow(
  startDate: string,
  endDate: string,
  apiKey: string,
  apiUrl: string
) {
  const params = {
    api_name: "moneyflow_mkt_dc",
    token: apiKey,
    params: {
      start_date: startDate,
      end_date: endDate
    },
    fields: "trade_date,close_sh,pct_change_sh,close_sz,pct_change_sz,net_amount,net_amount_rate,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate"
  };

  return await callTushareAPI(params, apiUrl);
}

// 获取个股资金流向数据
// 使用 Tushare 标准接口 moneyflow（2000积分可正式调用），
// 而非 moneyflow_dc（东财试用接口，低积分每日仅可试用2次，故弃用）。
async function fetchStockMoneyFlow(
  tsCode: string,
  startDate: string,
  endDate: string,
  apiKey: string,
  apiUrl: string
) {
  const params = {
    api_name: "moneyflow",
    token: apiKey,
    params: {
      ts_code: tsCode,
      start_date: startDate,
      end_date: endDate
    },
    // moneyflow 返回的是分买卖的量与金额，以及 net_mf_amount（万元）
    fields: "ts_code,trade_date,buy_sm_amount,sell_sm_amount,buy_md_amount,sell_md_amount,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount"
  };

  const result = await callTushareAPI(params, apiUrl);

  // 将 moneyflow 的字段映射/归一化为下游格式化函数期望的字段名：
  //   net_amount           = net_mf_amount（主力净流入，万元 → 元，保持与 DC 版本同量纲）
  //   buy_elg_amount       = 超大单净额 = buy_elg_amount - sell_elg_amount
  //   buy_lg_amount        = 大单净额   = buy_lg_amount  - sell_lg_amount
  //   buy_md_amount        = 中单净额   = buy_md_amount  - sell_md_amount
  //   buy_sm_amount        = 小单净额   = buy_sm_amount  - sell_sm_amount
  // moneyflow 接口不返回 close / pct_change / *_rate 占比字段，置空由格式化层显示 N/A。
  const WAN = 10000; // DC 接口单位为元，moneyflow 单位为万元，这里统一成"元"
  const toNum = (v: any) => {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const mapped = result.data.map((row: any) => {
    const elgNet = (toNum(row.buy_elg_amount) - toNum(row.sell_elg_amount)) * WAN;
    const lgNet  = (toNum(row.buy_lg_amount)  - toNum(row.sell_lg_amount))  * WAN;
    const mdNet  = (toNum(row.buy_md_amount)  - toNum(row.sell_md_amount))  * WAN;
    const smNet  = (toNum(row.buy_sm_amount)  - toNum(row.sell_sm_amount))  * WAN;
    const netAmt = toNum(row.net_mf_amount) * WAN;
    return {
      ts_code: row.ts_code,
      trade_date: row.trade_date,
      close: '',
      pct_change: '',
      net_amount: netAmt,
      net_amount_rate: '',
      buy_elg_amount: elgNet,
      buy_elg_amount_rate: '',
      buy_lg_amount: lgNet,
      buy_lg_amount_rate: '',
      buy_md_amount: mdNet,
      buy_md_amount_rate: '',
      buy_sm_amount: smNet,
      buy_sm_amount_rate: ''
    };
  });

  return {
    data: mapped,
    fields: [
      'ts_code','trade_date','close','pct_change',
      'net_amount','net_amount_rate',
      'buy_elg_amount','buy_elg_amount_rate',
      'buy_lg_amount','buy_lg_amount_rate',
      'buy_md_amount','buy_md_amount_rate',
      'buy_sm_amount','buy_sm_amount_rate'
    ]
  };
}

// 获取板块资金流向数据（东财）
// 说明：板块（行业/概念/地域）资金流向使用 DC 板块代码体系（如 BK0447），
// Tushare 没有等价的标准接口，只能使用 moneyflow_ind_dc；
// 该接口需 6000 积分才能正式调取，低积分 Token 每日仅能试用 2 次。
async function fetchSectorMoneyFlow(
  tsCode: string | undefined,
  tradeDate: string | undefined,
  startDate: string,
  endDate: string,
  contentType: string | undefined,
  apiKey: string,
  apiUrl: string
) {
  const params: any = {
    api_name: "moneyflow_ind_dc",
    token: apiKey,
    params: {} as any,
    fields: "trade_date,content_type,ts_code,name,pct_change,close,net_amount,net_amount_rate,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate,rank"
  };

  // 根据参数动态构建查询条件
  if (tsCode) {
    params.params.ts_code = tsCode;
  }
  if (tradeDate) {
    params.params.trade_date = tradeDate;
  } else {
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  }
  if (contentType) {
    params.params.content_type = contentType;
  }

  return await callTushareAPI(params, apiUrl);
}

// ── V2: 北向资金 ──────────────────────────────────────────────────────────────

async function fetchNorthboundFlow(
  tsCode: string | undefined,
  tradeDate: string | undefined,
  _apiKey: string,
  _apiUrl: string
): Promise<{ data: Record<string, any>[]; apiUsed: string }> {
  if (tsCode) {
    // 有具体港股代码 → hk_hold（港股通持股明细）
    const params: Record<string, any> = { ts_code: tsCode };
    if (tradeDate) params.trade_date = tradeDate;
    const { data } = await callTushare(
      'hk_hold',
      params,
      'ts_code,trade_date,exchange_id,by_vol,by_ratio,sell_vol,sell_ratio,hold_vol,hold_ratio'
    );
    return { data, apiUsed: 'hk_hold' };
  } else {
    // 无代码 → hsgt_top10（沪深港通十大成交股）
    if (!tradeDate) throw new Error('northbound 查询无 ts_code 时，trade_date 为必填项');
    const { data } = await callTushare(
      'hsgt_top10',
      { trade_date: tradeDate },
      'trade_date,ts_code,name,close,change,rank,market_type,amount,net_amount,buy,sell'
    );
    return { data, apiUsed: 'hsgt_top10' };
  }
}

function formatNorthboundData(data: Record<string, any>[], apiUsed: string, tsCode?: string): string {
  const sorted = [...data].sort((a, b) => {
    const rankCmp = (a.rank ?? 99) - (b.rank ?? 99);
    if (rankCmp !== 0) return rankCmp;
    return (b.trade_date || '').localeCompare(a.trade_date || '');
  });

  let out = `# 🌐 北向资金数据\n\n`;
  if (apiUsed === 'hk_hold') {
    out += `**查询方式**: 港股通持股明细 (hk_hold)  股票: ${tsCode}\n\n`;
    out += `| 日期 | 交易所 | 买入量(股) | 买入占比% | 卖出量(股) | 卖出占比% | 持股量(股) | 持股占比% |\n`;
    out += `|------|--------|-----------|---------|-----------|---------|-----------|--------|\n`;
    sorted.forEach(r => {
      const n = (v: any) => v != null ? String(v) : 'N/A';
      out += `| ${n(r.trade_date)} | ${n(r.exchange_id)} | ${n(r.by_vol)} | ${n(r.by_ratio)} | ${n(r.sell_vol)} | ${n(r.sell_ratio)} | ${n(r.hold_vol)} | ${n(r.hold_ratio)} |\n`;
    });
  } else {
    out += `**查询方式**: 沪深港通十大成交股 (hsgt_top10)  日期: ${sorted[0]?.trade_date || ''}\n\n`;
    out += `| 排名 | 代码 | 名称 | 收盘价 | 涨跌% | 市场 | 成交额(万) | 净买入(万) | 买入(万) | 卖出(万) |\n`;
    out += `|------|------|------|--------|------|------|-----------|-----------|---------|--------|\n`;
    sorted.forEach(r => {
      const n = (v: any) => v != null ? String(v) : 'N/A';
      out += `| ${n(r.rank)} | ${n(r.ts_code)} | ${n(r.name)} | ${n(r.close)} | ${n(r.change)} | ${n(r.market_type)} | ${n(r.amount)} | ${n(r.net_amount)} | ${n(r.buy)} | ${n(r.sell)} |\n`;
    });
  }
  out += `\n---\n*数据来源: Tushare ${apiUsed}*`;
  return out;
}

// ── 原有 Tushare 调用函数（stock/market/sector 分支保留）────────────────────
async function callTushareAPI(params: any, apiUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

  try {
    console.log(`请求Tushare API: ${params.api_name}，参数:`, params.params);
    
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
    
    if (data.code !== 0) {
      const rawMsg: string = data.msg || '';
      // 对 Tushare 常见的积分不足 / 试用次数耗尽错误，给出更清晰的指引
      const hitQuota = /(权限|积分|次数|频次|每天|每日|试用|超出)/i.test(rawMsg);
      if (hitQuota) {
        throw new Error(
          `Tushare API 访问受限（接口：${params.api_name}）：${rawMsg}。\n` +
          `提示：该接口对积分有门槛，未达标时每日仅能试用少数几次。` +
          `请在 https://tushare.pro 查看接口所需积分并提升权限后重试。`
        );
      }
      throw new Error(`Tushare API错误 (${params.api_name}): ${rawMsg}`);
    }
    
    if (!data.data || !data.data.items) {
      throw new Error(`未找到资金流向数据`);
    }
    
    // 获取字段名
    const fields = data.data.fields;
    
    // 将数据转换为对象数组
    const convertedData = data.data.items.map((item: any) => {
      const result: Record<string, any> = {};
      fields.forEach((field: string, index: number) => {
        result[field] = item[index];
      });
      return result;
    });
    
    console.log(`成功获取到${convertedData.length}条资金流向数据记录`);
    
    return {
      data: convertedData,
      fields: fields
    };
    
  } finally {
    clearTimeout(timeoutId);
  }
}

// 格式化资金流向数据输出
function formatMoneyFlowData(data: any[], fields: string[], queryType: string, tsCode?: string): string {
  // 按交易日期倒序排列（最新在前）  
  const sortedData = data.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  
  let target = '';
  if (queryType === 'market') {
    target = '大盘';
  } else if (queryType === 'sector') {
    target = sortedData[0]?.name ? `板块【${sortedData[0].name}】` : `板块 ${tsCode || ''}`;
  } else {
    target = `个股 ${tsCode}`;
  }
  
  let output = `# 💰 ${target}资金流向数据\n\n`;
  
  // 板块查询显示特殊信息
  if (queryType === 'sector' && sortedData[0]) {
    output += `## 📋 板块基本信息\n\n`;
    output += `- 板块代码: ${sortedData[0].ts_code || 'N/A'}\n`;
    output += `- 板块名称: ${sortedData[0].name || 'N/A'}\n`;
    output += `- 板块类型: ${sortedData[0].content_type || 'N/A'}\n`;
    if (sortedData[0].rank) {
      output += `- 资金流入排名: 第 ${sortedData[0].rank} 名\n`;
    }
    output += `\n`;
  }
  
  // 数据统计摘要
  const totalDays = sortedData.length;
  const netInflowDays = sortedData.filter(item => (parseFloat(item.net_amount) || 0) > 0).length;
  const netOutflowDays = totalDays - netInflowDays;
  
  // 计算累计净流入金额
  const totalNetAmount = sortedData.reduce((sum, item) => sum + (parseFloat(item.net_amount) || 0), 0);
  
  output += `## 📊 统计摘要\n\n`;
  output += `- 查询时间范围: ${sortedData[sortedData.length - 1]?.trade_date} 至 ${sortedData[0]?.trade_date}\n`;
  output += `- 交易天数: ${totalDays} 天\n`;
  output += `- 净流入天数: ${netInflowDays} 天 (${((netInflowDays/totalDays)*100).toFixed(1)}%)\n`;
  output += `- 净流出天数: ${netOutflowDays} 天 (${((netOutflowDays/totalDays)*100).toFixed(1)}%)\n`;
  output += `- 累计净流入: ${formatMoney(totalNetAmount)}\n\n`;

  // 构建数据表格
  if (queryType === 'market') {
    output += formatMarketFlowTable(sortedData);
  } else if (queryType === 'sector') {
    output += formatSectorFlowTable(sortedData);
  } else {
    output += formatStockFlowTable(sortedData);
  }
  
  // 最近5个交易日资金流向趋势
  const recentData = sortedData.slice(0, Math.min(5, sortedData.length));
  output += `\n## 📈 最近资金流向趋势\n\n`;
  
  recentData.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const rateRaw = item.net_amount_rate;
    const hasRate = rateRaw !== '' && rateRaw !== null && rateRaw !== undefined && !isNaN(parseFloat(rateRaw));
    const trend = netAmount > 0 ? '🟢' : '🔴';
    const direction = netAmount > 0 ? '净流入' : '净流出';
    const rateSuffix = hasRate ? ` (${Math.abs(parseFloat(rateRaw)).toFixed(2)}%)` : '';
    output += `${item.trade_date} ${trend} 主力${direction} ${formatMoney(Math.abs(netAmount))}${rateSuffix}\n`;
  });
  
  const sourceLabel =
    queryType === 'market' ? 'Tushare · 东方财富 (moneyflow_mkt_dc)'
    : queryType === 'sector' ? 'Tushare · 东方财富 (moneyflow_ind_dc)'
    : 'Tushare 标准接口 (moneyflow，沪深A股主动买卖单统计)';
  output += `\n---\n*数据来源: [${sourceLabel}](https://tushare.pro)*`;
  
  return output;
}

// 格式化大盘资金流向表格
function formatMarketFlowTable(data: any[]): string {
  let output = `## 📋 大盘资金流向明细\n\n`;
  
  output += `| 交易日期 | 上证收盘 | 上证涨跌% | 深证收盘 | 深证涨跌% | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) |\n`;
  output += `|---------|---------|---------|---------|---------|------------|--------|------------|----------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatNumber(item.close_sh)} `;
    output += `| ${formatPercent(item.pct_change_sh)} `;
    output += `| ${formatNumber(item.close_sz)} `;
    output += `| ${formatPercent(item.pct_change_sz)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} |\n`;
  });
  
  return output;
}

// 格式化个股资金流向表格
function formatStockFlowTable(data: any[]): string {
  let output = `## 📋 个股资金流向明细\n\n`;
  output += `> 说明：使用 Tushare 标准接口 moneyflow（主动买卖单统计）。该接口不提供「收盘价 / 涨跌% / 净占比%」字段，故相关列显示为 N/A，属正常现象。\n\n`;
  output += `| 交易日期 | 收盘价 | 涨跌% | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) | 中单净流入(万元) | 小单净流入(万元) |\n`;
  output += `|---------|--------|------|------------|--------|------------|------------|------------|------------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    const mdAmount = parseFloat(item.buy_md_amount) || 0;
    const smAmount = parseFloat(item.buy_sm_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatNumber(item.close)} `;
    output += `| ${formatPercent(item.pct_change)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} `;
    output += `| ${formatMoney(mdAmount)} `;
    output += `| ${formatMoney(smAmount)} |\n`;
  });
  
  return output;
}

// 格式化板块资金流向表格
function formatSectorFlowTable(data: any[]): string {
  let output = `## 📋 板块资金流向明细\n\n`;
  
  output += `| 交易日期 | 板块涨跌% | 板块指数 | 主力净流入(万元) | 净占比% | 超大单净流入(万元) | 大单净流入(万元) | 中单净流入(万元) | 小单净流入(万元) | 排名 |\n`;
  output += `|---------|----------|---------|------------|--------|------------|------------|------------|------------|------|\n`;
  
  data.forEach(item => {
    const netAmount = parseFloat(item.net_amount) || 0;
    const netAmountRate = parseFloat(item.net_amount_rate) || 0;
    const elgAmount = parseFloat(item.buy_elg_amount) || 0;
    const lgAmount = parseFloat(item.buy_lg_amount) || 0;
    const mdAmount = parseFloat(item.buy_md_amount) || 0;
    const smAmount = parseFloat(item.buy_sm_amount) || 0;
    
    const netFlowIcon = netAmount > 0 ? '🟢' : '🔴';
    
    output += `| ${item.trade_date} `;
    output += `| ${formatPercent(item.pct_change)} `;
    output += `| ${formatNumber(item.close)} `;
    output += `| ${netFlowIcon} ${formatMoney(netAmount)} `;
    output += `| ${formatPercent(netAmountRate)} `;
    output += `| ${formatMoney(elgAmount)} `;
    output += `| ${formatMoney(lgAmount)} `;
    output += `| ${formatMoney(mdAmount)} `;
    output += `| ${formatMoney(smAmount)} `;
    output += `| ${item.rank || 'N/A'} |\n`;
  });
  
  return output;
}

// 格式化金额（万元）
function formatMoney(amount: number): string {
  if (amount === 0) return '0.00万';
  const amountInWan = amount / 10000;
  if (Math.abs(amountInWan) >= 100000) {
    return (amountInWan / 10000).toFixed(2) + '亿';
  }
  return amountInWan.toFixed(2) + '万';
}

// 格式化数字
function formatNumber(num: any): string {
  if (num === null || num === undefined || num === '' || isNaN(parseFloat(num))) {
    return 'N/A';
  }
  const number = parseFloat(num);
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 格式化百分比
function formatPercent(num: any): string {
  if (num === null || num === undefined || num === '' || isNaN(parseFloat(num))) {
    return 'N/A';
  }
  const number = parseFloat(num);
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toFixed(2)}%`;
} 