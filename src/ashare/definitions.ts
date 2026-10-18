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

// ETF 数据纵切（R0）。与既有工具并列新增，不改变原有 10 个工具的名称与描述。
ashareToolDefinitions.push(
  {
    name: 'ashare_etf_quotes',
    description: `ETF 行情快照（只读本地 fund_* 缓存）：基础信息、最新行情与明确单位换算、复权价格、份额时点值与质量标记。字段单位：价格=元/份，vol=手（1 手 = 100 份，volume_shares=份），amount=千元（amount_cny=元）。fund_share 是份额时点存量，份额变化不是资金净流入，也不等于成交额；仅在两个可比份额日期与价格代理都存在时才给出 net_creation_estimate（净申购规模估计）。行情缺失返回 NOT_READY 且价格字段为 null；行情落后于预期交易日时仍返回真实行情日期并标记 STALE/DEGRADED，不伪造、不用旧数据冒充当日。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ts_codes: { type: 'array', items: { type: 'string' }, description: 'ETF 代码列表，如 159558.SZ 或 159558；缺省为持仓五只 159241.SZ,159278.SZ,159558.SZ,516080.SH,560390.SH' },
        start_date: { type: 'string', description: 'YYYYMMDD，闭区间起点；缺省为 end_date 往前 30 个自然日（用于流动性统计）' },
        end_date: { type: 'string', description: 'YYYYMMDD，闭区间终点（也是前复权基准日）；缺省为最近交易日' },
        adjust: { type: 'string', enum: ['none', 'qfq', 'hfq'], description: '复权方式，默认 none；qfq 以 end_date 之前最后一个复权因子为基准，不使用之后的因子' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_etf_status',
    description: `ETF 数据状态：缓存最新 ETF 日线日期、预期最近交易日、五只 ETF 的基础信息/行情/份额覆盖、逐只就绪度（READY/DEGRADED/NOT_READY）与最近同步记录。空缓存返回 NOT_READY 与原因，不抛异常。${DATA_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { date: dateProp },
    },
    annotations: READ_ONLY,
  },
);

export const ASHARE_TOOL_NAMES = new Set(ashareToolDefinitions.map(t => t.name));

/**
 * 私有账户工具（可选）。这些工具读取独立账户库 `portfolio.sqlite`，默认不暴露：
 * 只有在 `ASHARE_PORTFOLIO_ENABLED=1` 时它们才进入 tools/list 并可被调用，避免
 * 公网 `ashare_daily` profile 泄露账户数量、成本与持仓。与市场工具同属 A 股模块，
 * 但单独成集，互不影响。定义本身不含运行时依赖，便于在没有 node:sqlite 的
 * Node 版本上也能安全地做 tools/list。
 */
const PORTFOLIO_NOTE = '演示/只读账户：数据来自 PRD §3 截图基线，写入独立的 portfolio.sqlite，与公开市场端点隔离；费用、交易单位与压力参数均为假设值，不是券商事实；不下单、不访问券商。';

export const portfolioToolDefinitions: { name: string; description: string; inputSchema: Record<string, any>; annotations: typeof READ_ONLY }[] = [
  {
    name: 'ashare_portfolio_summary',
    description: `只读账户快照汇总：五只 ETF 的数量、参考价/成本、市值、权重、现金、理财、总资产、赫芬达尔集中度、主题暴露与对账结果。${PORTFOLIO_NOTE} 历史净值与历史最大回撤未知，显式返回 available=false。需要 ASHARE_PORTFOLIO_ENABLED=1。`,
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: '账户快照 ID；缺省为最新快照（R0 只有 demo-2026-10-18）' },
        include_checks: { type: 'boolean', description: '是否附带逐项对账明细，默认 true' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_portfolio_scenario',
    description: `只读静态换仓情景（确定性）：价格默认只从服务端只读市场缓存（fund_daily/daily）按真实交易日读取，标的品种/板块/上市状态由 fund_basic/stock_basic 判定，不接受调用方自填价格来提升信任。计算卖出回笼、费用分解、可买整手数量、剩余现金、交易前后权重/现金比例/HHI/主题暴露与声明式压力损失，并输出 HOLD/ROTATE/REDUCE_EQUITY 对照。状态含义：EXECUTABLE（全部门控通过）/ ILLUSTRATIVE（账户非当前、调用方自填报价或优势未验证）/ NO_ACTION（无已验证优势）/ NOT_EXECUTABLE（权限、上市、停牌、过期、缺行情、整手、资金或标的身份不符）/ DATA_INSUFFICIENT（缓存无法回答）。非可执行状态下买卖两腿均归零，计算值只在 trade.illustrative（executable:false）。行情收盘价只是参考价，不是下一交易日保证成交价。${PORTFOLIO_NOTE} 需要 ASHARE_PORTFOLIO_ENABLED=1。`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hold', 'sell-buy'], description: 'hold（不操作）或 sell-buy（卖出并买入）' },
        sell_code: { type: 'string', description: '卖出代码，如 159558.SZ' },
        sell_shares: { type: 'number', description: '卖出份数，必须为 100 的正整数倍' },
        buy_code: { type: 'string', description: '买入代码，如 510300.SH' },
        as_of_trade_date: { type: 'string', description: '行情交易日 YYYYMMDD；缺省为快照 as_of；非交易日返回 DATA_INSUFFICIENT' },
        mode: { type: 'string', enum: ['server', 'research'], description: '缺省 server：价格只来自服务端缓存；research：显式接受自填价格，结果最多 ILLUSTRATIVE' },
        sell_price: { type: 'number', description: '仅 mode=research 生效的卖出价，元/份；server 模式下忽略' },
        buy_price: { type: 'number', description: '仅 mode=research 生效的买入价，元/份；server 模式下忽略' },
        quote_date: { type: 'string', description: '仅 mode=research 生效的报价日期 YYYYMMDD' },
        buy_kind: { type: 'string', enum: ['etf', 'stock'], description: '调用方声明的买入品种；与 fund_basic/stock_basic 判定不一致时返回 NOT_EXECUTABLE(instrument_claim_mismatch)' },
        buy_board: { type: 'string', description: '调用方声明的买入板块；声明不能绕过 PRD §4 对 688/689/300/301/8/4 个股的限制' },
        advantage: { type: 'boolean', description: '相对优势声明；布尔本身不是已验证优势，需配合 evidence_source=RESEARCH_VERIFIED 与 evidence_id' },
        advantage_basis: { type: 'string', description: '相对优势依据（原样透传到结果）' },
        evidence_source: { type: 'string', enum: ['RESEARCH_VERIFIED', 'UNVERIFIED'], description: '优势证据来源；缺省 UNVERIFIED' },
        evidence_id: { type: 'string', description: '研究证据 ID；RESEARCH_VERIFIED 时必须非空，否则优势按未验证处理' },
        evidence_as_of: { type: 'string', description: '证据日期 YYYYMMDD' },
        sell_list_status: { type: 'string', description: '已废弃：上市状态以 fund_basic/stock_basic 为准，调用方声明被忽略' },
        buy_list_status: { type: 'string', description: '已废弃：上市状态以 fund_basic/stock_basic 为准，调用方声明被忽略' },
        sell_suspended: { type: 'boolean', description: '已废弃：停牌状态以 suspend_d 为准，调用方声明被忽略' },
        buy_suspended: { type: 'boolean', description: '已废弃：停牌状态以 suspend_d 为准，调用方声明被忽略' },
      },
      required: ['action'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_portfolio_decision',
    description: `条件化配置比较（R1，确定性、只读）：把 HOLD / REDUCE_EQUITY / SELL_AND_BUY / NO_ACTION 四种决策表达并列，给出每种表达的总权益/主题/行业权重、集中度（HHI）、现金比例、假设费用（版本化，无券商真实费率时为 null）、参考份数/手数、资金来源、最小成交单位、行情交易日、按资产类别的声明式压力损失与失效条件。候选 ETF 行情只从服务端只读缓存（fund_basic/fund_daily）读取，不接受调用方自填价格；未缓存时返回 DATA_INSUFFICIENT(candidate_not_cached)。轮动优势必须来自 RESEARCH_VERIFIED 且带 evidence_id 的研究证据，否则标记 UNVERIFIED 且不可执行。新建主板个股按净资产 0.5% 的单笔计划风险校验，超预算返回 risk_budget_exceeded。${PORTFOLIO_NOTE} 需要 ASHARE_PORTFOLIO_ENABLED=1 或私有端点令牌；只在 /private/mcp 提供。`,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: '账户标识，缺省 default' },
        snapshot_id: { type: 'string', description: '账户快照 ID；缺省为最新快照' },
        action: { type: 'string', enum: ['hold', 'reduce', 'sell-buy', 'no-action'], description: '本次请求的决策表达' },
        sell_code: { type: 'string', description: '卖出代码，如 159558.SZ（reduce / sell-buy 必填）' },
        sell_shares: { type: 'number', description: '卖出份数，必须为 100 的正整数倍' },
        buy_code: { type: 'string', description: '买入代码（可以是 ETF_UNIVERSE 之外的 ETF 或主板个股）' },
        buy_kind: { type: 'string', enum: ['etf', 'stock'], description: '买入品种，默认 etf；stock 仅限沪深主板' },
        as_of_trade_date: { type: 'string', description: '行情交易日 YYYYMMDD；缺省为快照 as_of' },
        advantage_claim: { type: 'string', description: '轮动优势主张（原样透传）' },
        advantage_source: { type: 'string', enum: ['RESEARCH_VERIFIED', 'UNVERIFIED'], description: '优势证据来源；不接受布尔值' },
        advantage_evidence_id: { type: 'string', description: '研究证据 ID；RESEARCH_VERIFIED 时必须提供' },
        advantage_as_of: { type: 'string', description: '证据日期 YYYYMMDD' },
        stock_code: { type: 'string', description: '个股计划代码，缺省取 buy_code' },
        stock_quantity: { type: 'number', description: '个股计划股数，缺省取本次可买整手数' },
        stock_invalidation_price: { type: 'number', description: '个股计划失效价，元/股；提供后按净资产 0.5% 校验计划风险' },
        reason: { type: 'string', description: 'no-action 时的说明' },
      },
      required: ['action'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_portfolio_daily_report',
    description: `收盘日报（D1，确定性、只读）：首屏是"下一交易日最值得做的 0–3 个动作及理由"，随后是市场判断与反证、五只真实持仓的持有/减仓/换仓/等待理由、候选与资金竞争、集中度与回撤披露、条件化交易预案（费用与参考数量）、失效条件与历史预案跟踪。状态为 ACTIONABLE / ILLUSTRATIVE / NO_ACTION / DATA_INSUFFICIENT；没有证据支持时返回 NO_ACTION 并给出观察触发条件。所有数字由程序计算，研究性主张标 UNVERIFIED；只有账户门控全部满足时才会出现可执行数量，否则一律 executable:false。行情来自本地只读缓存的收盘价，不是下一交易日可成交价。${PORTFOLIO_NOTE} 只在 /private/mcp 提供。`,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: '账户标识，缺省 default' },
        as_of_trade_date: { type: 'string', description: '日报目标交易日 YYYYMMDD；缺省为最近交易日' },
        snapshot_id: { type: 'string', description: '账户快照 ID；缺省为最新快照' },
        max_actions: { type: 'number', description: '动作上限 0–3，默认 3' },
        categories: { type: 'array', items: { type: 'string' }, description: '候选 ETF 类别子集：broad/industry/bond/gold/cross_border' },
      },
      required: [],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_etf_candidates',
    description: `适格 ETF 动态研究候选（C2，只读本地 fund_* 缓存）：按宽基/行业主题/债券/黄金/跨境分类，给出数据覆盖、规模（份额×价格，万份/元口径）、流动性（20 日成交额中位数）、跟踪质量与风险特征，并逐项给出纳入或剔除原因。数据缺失时显式 DEGRADED（列出缺哪张表/哪个日期），绝不静默丢弃；溢折价在缓存缺少 NAV/IOPV 时标 unavailable，不估算。五只真实持仓永远包含且不被流动性/规模过滤（held:true）。这是研究候选筛选，不是买入信号，评分是启发式排序。${PORTFOLIO_NOTE} 只在 /private/mcp 提供。`,
    inputSchema: {
      type: 'object',
      properties: {
        as_of_trade_date: { type: 'string', description: '交易日 YYYYMMDD；缺省为最近交易日' },
        categories: { type: 'array', items: { type: 'string' }, description: '类别子集：broad/industry/bond/gold/cross_border；缺省全部' },
        limit: { type: 'number', description: 'OK 且非持仓候选的返回上限；不隐藏 DEGRADED 与被剔除行' },
      },
      required: [],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'ashare_portfolio_benchmarks',
    description: `事先固定的对照基准比较（C6，只读）：沪深300 ETF（510300.SH）被动持有、固定权重的多资产 ETF 篮子（权重为暂定值，状态 provisional_pending_user_approval，待用户批准）、以及原五只 ETF 按起始数量不交易。统一时间窗、费用与现金流口径，给出总收益、最大回撤与波动率。任一所需 ETF 无缓存数据时该基准标 UNAVAILABLE 并说明原因，绝不缩短窗口或用代理替代。基准在观察结果之前固定，不得事后挑选。${PORTFOLIO_NOTE} 只在 /private/mcp 提供。`,
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: '窗口起点 YYYYMMDD；缺省按固定窗口长度回溯' },
        end_date: { type: 'string', description: '窗口终点 YYYYMMDD；缺省为最近交易日' },
      },
      required: [],
    },
    annotations: READ_ONLY,
  },
];

export const PORTFOLIO_TOOL_NAMES = new Set(portfolioToolDefinitions.map(t => t.name));

