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

export const ashareToolDefinitions = [
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

export const ASHARE_TOOL_NAMES = new Set(ashareToolDefinitions.map(t => t.name));
