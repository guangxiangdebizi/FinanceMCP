/**
 * MCP tool definitions for the A-share daily research module. The tools only
 * read the local SQLite cache and JSON snapshots written by the
 * `finance-ashare` CLI, never call external data sources and never use
 * request credentials, so they sit outside the external data-source fallback
 * router. This file has no runtime dependencies so tools/list works on Node
 * versions without node:sqlite; the implementation is loaded on first call.
 */

const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const dateProp = { type: 'string', description: '交易日 YYYYMMDD；缺省为上海时区今天（非交易日取最近交易日）' };

export const ashareToolDefinitions: { name: string; description: string; inputSchema: Record<string, any>; annotations: typeof READ_ONLY }[] = [
  {
    name: 'ashare_data_status',
    description: 'A股日频数据状态：本地缓存最新交易日、各数据集覆盖率、数据质量检查（READY/DEGRADED/NOT_READY）、最近报告与同步时间。只读本地缓存。',
    inputSchema: { type: 'object', properties: { date: dateProp } },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_daily_report',
    description: 'A股日报研究快照：报告ID、as-of交易日、数据完整性、规则版本、市场环境（指数/成交额/涨跌家数/宽度）、行业强弱、动态股票池及增减、信号触发/失效条件与风险。核心数据缺失时返回 NOT_READY，不会用前一交易日数据替代。',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        format: { type: 'string', enum: ['markdown', 'json'], description: 'markdown（默认，摘要+全部股票池）或 json（完整快照）' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_watchlist',
    description: 'A股动态股票池（30~50只，行业分散）：成员、评分与排名、入池日期、当日增减及原因，以及近期变动历史。评分为启发式排序，不代表盈利概率。',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        history_days: { type: 'number', description: '返回最近 N 个交易日的股票池变动，默认 5，最大 30' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_stock_analysis',
    description: '单只A股的日频技术与基本面分析：MA/RSI/MACD/CCI/BOLL/ATR/量能、近期信号（含失效条件与历史证据分类）、公告日约束下的财务指标、估值、评分排名与股票池状态。',
    inputSchema: {
      type: 'object',
      properties: {
        ts_code: { type: 'string', description: '股票代码，如 600519.SH 或 600519' },
        date: dateProp,
      },
      required: ['ts_code'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_sector_rank',
    description: 'A股行业强弱排名（Tushare 行业分类）：20日/5日中位收益、站上MA20比例、成交额与综合强度。',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        top: { type: 'number', description: '返回前 N 个行业，默认全部' },
      },
    },
    annotations: READ_ONLY,
  },
];

const DATA_NOTE = '数据查询工具：只读本地缓存，返回结构化 JSON（字段、单位、来源、同步时间、数据质量与缺口），不计算技术指标或评分。';

ashareToolDefinitions.push(
  {
    name: 'ashare_factor_snapshot',
    description: 'A股只读研究因子快照（RESEARCH_ONLY）：原始/标准化因子、单位、准入与剔除原因、评分组件及逐因子贡献、排名、信号与失效条件、质量限制。单次 1–20 只，按完整市场候选集标准化后筛选返回；缺失保持 null，源 OHLC/成交额异常的技术观测置 null 并在质量中说明。支持正式 V1 与仅修正现金流百分数阈值的研究 V2，不改写正式日报/股票池。',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        ts_codes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: '1–20 个股票代码，接受 600519.SH、600519 或完整名称' },
        include_components: { type: 'boolean', description: '附带评分组件、逐因子贡献及缺失值评分默认值，默认 true' },
        score_version: { type: 'string', enum: ['score-1.0.0', 'score-2.0.0'], description: '默认 score-1.0.0；V2 为研究候选，不替换正式评分' },
      },
      required: ['ts_codes'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_stock_history',
    description: `单只A股历史日线：原始 OHLC、昨收、涨跌幅、成交量（手）、成交额（千元）、复权因子及所选复权价格（none/qfq/hfq，前复权以 end_date 之前最后一个因子为基准，不使用之后的因子），可选每日估值指标；列出停牌日、上市期外日期与无法解释的缺口。每次最多 500 行，超出时返回 next_start_date 分页。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ts_code: { type: 'string', description: '股票代码，如 600519.SH 或 600519' },
        start_date: { type: 'string', description: 'YYYYMMDD，闭区间起点；缺省为 end_date 往前 limit 个交易日' },
        end_date: { type: 'string', description: 'YYYYMMDD，闭区间终点（也是前复权基准日）；缺省为最近交易日' },
        adjust: { type: 'string', enum: ['none', 'qfq', 'hfq'], description: '复权方式，默认 qfq' },
        limit: { type: 'number', description: '最多返回行数，默认 120，最大 500' },
        include_basic: { type: 'boolean', description: '附带换手率、量比、PE(TTM)、PB、总/流通市值（万元），默认 false' },
      },
      required: ['ts_code'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_financial_data',
    description: `单只A股财务指标历史（Tushare fina_indicator）：按报告期列出 as_of_date 当时已公告的最新数据（ann_date ≤ as_of_date），含公告日、单位、多次公告的修订字段及截止日已知的上游异常；不披露截止日之后的记录数量或报告期信息。空值保持 null。数据源不保留完整修订历史，不是严格 Point-in-Time 财务库。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ts_code: { type: 'string', description: '股票代码，如 600519.SH 或 600519' },
        as_of_date: { type: 'string', description: 'YYYYMMDD，只返回该日及之前已公告的数据；缺省为最近交易日' },
        start_period: { type: 'string', description: '最早报告期 YYYY0331/0630/0930/1231' },
        end_period: { type: 'string', description: '最晚报告期 YYYY0331/0630/0930/1231' },
        limit: { type: 'number', description: '最多返回报告期数，默认 8，最大 40' },
        include_revisions: { type: 'boolean', description: '返回同一报告期较早公告的全部数值，默认只列出变动字段' },
      },
      required: ['ts_code'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_market_data',
    description: `A股市场数据（逐交易日）：核心指数 OHLC/涨跌幅/成交额，全市场上涨/下跌/平盘家数、涨跌停家数（含涨跌停价覆盖率）、成交额、上市与停牌股票数，以及每日数据质量。单次最多 60 个交易日。不含市场择时判断。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYYMMDD；缺省等于 end_date（单日）' },
        end_date: { type: 'string', description: 'YYYYMMDD；缺省为最近交易日' },
        indices: { type: 'array', items: { type: 'string' }, description: '指数代码子集：000001.SH,399001.SZ,399006.SZ,000300.SH,000905.SH,000852.SH,000688.SH,899050.BJ；缺省全部' },
        include_breadth: { type: 'boolean', description: '是否返回全市场涨跌家数等统计，默认 true' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_stock_basic',
    description: `A股基础信息：代码、名称、地域、行业、板块、交易所、上市/退市日期、上市状态。按代码列表（最多 50 个）或按名称/代码片段、行业、上市状态筛选（分页，最多 100 条）。行业与名称为当前口径，不代表历史日期的分类。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ts_codes: { type: 'array', items: { type: 'string' }, description: '股票代码或名称列表' },
        query: { type: 'string', description: '名称、6 位代码或 ts_code 片段' },
        industry: { type: 'string', description: '行业（Tushare 当前行业分类，精确匹配）' },
        list_status: { type: 'string', enum: ['L', 'D', 'P'], description: 'L 上市、D 退市、P 暂停上市' },
        limit: { type: 'number', description: '每页条数，默认 20，最大 100' },
        offset: { type: 'number', description: '分页偏移，默认 0' },
      },
    },
    annotations: READ_ONLY,
  },
);

export const ASHARE_TOOL_NAMES = new Set(ashareToolDefinitions.map(t => t.name));
