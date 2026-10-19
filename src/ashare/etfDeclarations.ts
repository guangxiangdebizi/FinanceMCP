/**
 * 声明式 ETF 候选池（无依赖的纯数据模块）。
 *
 * 单独成文件的原因：`etf.ts` 需要知道候选池有哪些代码（复核权/份额与逐只日线
 * 兜底），而 `etfUniverse.ts` 又需要 `etf.ts` 的 `ETF_UNIVERSE` 与复权因子。
 * 把**声明**放进这个只含字面量的模块，两个方向都不会形成循环依赖。
 *
 * 这里的内容仍然是**声明**，不是上游事实：真实名称只取 `fund_basic.name`。
 */

export type EtfCandidateCategory = 'broad_based' | 'industry_theme' | 'bond' | 'gold' | 'cross_border';

export const ETF_CANDIDATE_CATEGORIES: readonly EtfCandidateCategory[] = [
  'broad_based', 'industry_theme', 'bond', 'gold', 'cross_border',
];

export const ETF_CANDIDATE_CATEGORY_LABELS: Record<EtfCandidateCategory, string> = {
  broad_based: '宽基',
  industry_theme: '行业/主题',
  bond: '债券',
  gold: '黄金/贵金属',
  cross_border: '跨境',
};

export interface EtfCandidateDeclaration {
  ts_code: string;
  category: EtfCandidateCategory;
  /** 声明式名称提示。真实名称只用 `fund_basic.name`；缺失时标为 hint，不当事实。 */
  name_hint: string;
  /** 声明式基准指数提示，仅供人工复核。 */
  benchmark_hint: string | null;
  /** 可计算跟踪误差的指数代码；只有该指数在 `index_daily` 中缓存时才计算。 */
  benchmark_index_code: string | null;
}

/**
 * 声明式候选池（**不是**上游事实）。分类与名称由本文件声明，版本号随输出返回；
 * 改变名单必须同时改版本号，保证历史输出可复现。
 * 五只持仓在 `ETF_UNIVERSE` 中，这里重复声明只是因为分类需要，`held` 由持仓表决定。
 */
export const ETF_CANDIDATE_DECLARATIONS: readonly EtfCandidateDeclaration[] = [
  // 宽基
  { ts_code: '510300.SH', category: 'broad_based', name_hint: '沪深300ETF', benchmark_hint: '沪深300指数', benchmark_index_code: '000300.SH' },
  { ts_code: '510500.SH', category: 'broad_based', name_hint: '中证500ETF', benchmark_hint: '中证500指数', benchmark_index_code: '000905.SH' },
  { ts_code: '512100.SH', category: 'broad_based', name_hint: '中证1000ETF', benchmark_hint: '中证1000指数', benchmark_index_code: '000852.SH' },
  { ts_code: '588000.SH', category: 'broad_based', name_hint: '科创50ETF', benchmark_hint: '科创50指数', benchmark_index_code: '000688.SH' },
  // 行业/主题（含五只真实持仓）
  { ts_code: '159241.SZ', category: 'industry_theme', name_hint: '航空航天ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '159278.SZ', category: 'industry_theme', name_hint: '机器人ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '159558.SZ', category: 'industry_theme', name_hint: '半导体设备ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '516080.SH', category: 'industry_theme', name_hint: '创新药ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '560390.SH', category: 'industry_theme', name_hint: '电网设备ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '512480.SH', category: 'industry_theme', name_hint: '半导体ETF', benchmark_hint: '中证全指半导体', benchmark_index_code: null },
  { ts_code: '512660.SH', category: 'industry_theme', name_hint: '军工ETF', benchmark_hint: '中证军工', benchmark_index_code: null },
  { ts_code: '512010.SH', category: 'industry_theme', name_hint: '医药ETF', benchmark_hint: '沪深300医药卫生', benchmark_index_code: null },
  { ts_code: '515790.SH', category: 'industry_theme', name_hint: '光伏ETF', benchmark_hint: '中证光伏产业', benchmark_index_code: null },
  // 债券
  { ts_code: '511010.SH', category: 'bond', name_hint: '国债ETF', benchmark_hint: '上证5年期国债', benchmark_index_code: null },
  { ts_code: '511260.SH', category: 'bond', name_hint: '十年国债ETF', benchmark_hint: '中债10年期国债', benchmark_index_code: null },
  { ts_code: '511380.SH', category: 'bond', name_hint: '转债ETF', benchmark_hint: '中证可转债及可交换债券', benchmark_index_code: null },
  { ts_code: '159649.SZ', category: 'bond', name_hint: '国开债ETF', benchmark_hint: '中债国开债', benchmark_index_code: null },
  // 黄金
  { ts_code: '518880.SH', category: 'gold', name_hint: '黄金ETF', benchmark_hint: '上海金', benchmark_index_code: null },
  { ts_code: '518800.SH', category: 'gold', name_hint: '黄金基金ETF', benchmark_hint: '上海金', benchmark_index_code: null },
  { ts_code: '159934.SZ', category: 'gold', name_hint: '黄金ETF（易方达）', benchmark_hint: '上海金', benchmark_index_code: null },
  // 跨境
  { ts_code: '513100.SH', category: 'cross_border', name_hint: '纳指ETF', benchmark_hint: '纳斯达克100', benchmark_index_code: null },
  { ts_code: '513500.SH', category: 'cross_border', name_hint: '标普500ETF', benchmark_hint: '标普500', benchmark_index_code: null },
  { ts_code: '513050.SH', category: 'cross_border', name_hint: '中概互联网ETF', benchmark_hint: '中国互联网50', benchmark_index_code: null },
  { ts_code: '159920.SZ', category: 'cross_border', name_hint: '恒生ETF', benchmark_hint: '恒生指数', benchmark_index_code: null },
];
