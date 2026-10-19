import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// C2 候选 ETF 研究池 + C6 冻结对照基准。
//
// 离线、确定性：所有缓存都是 mkdtemp 下的**合成** SQLite，绝不读取生产缓存。
// 覆盖：有/无 fund_* 表（DEGRADED 路径）、五只持仓永远入选、流动性/规模排除原因、
// 基准可用与 unavailable 路径、以及“定义提前冻结”的元数据。

const dir = mkdtempSync(join(tmpdir(), 'ashare-v1-etf-'));
const MARKET_FULL = join(dir, 'market-full.sqlite');
const MARKET_NO_FUND = join(dir, 'market-no-fund.sqlite');
const MARKET_NO_SHARE = join(dir, 'market-no-share.sqlite');
const MARKET_ILLIQUID = join(dir, 'market-illiquid.sqlite');

process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = MARKET_FULL;
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');
const {
  ETF_CANDIDATE_CATEGORIES, ETF_CANDIDATE_DECLARATIONS, ETF_UNIVERSE_DISCLAIMER,
  ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY, screenEtfCandidates,
} = await import('../build/ashare/etfUniverse.js');
const {
  BENCHMARK_SCHEMA, CSI300_ETF_CODE, FROZEN_BASKET_WEIGHTS, FROZEN_BASKET_WEIGHTS_STATUS,
  FROZEN_FIVE_QUANTITIES, buildBenchmarkComparison,
} = await import('../build/portfolio/benchmarks.js');

// 窗口必须覆盖 2026-10-16：五只静态基准锚定在该基线日，起点在其之前会不可用。
const DAYS = weekdays('20260818', 44);
const LAST = DAYS.at(-1);
const HELD = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];

const BASIC = [
  { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '航空航天指数', status: 'L', market: 'E' },
  { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '机器人指数', status: 'L', market: 'E' },
  { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备指数', status: 'L', market: 'E' },
  { ts_code: '516080.SH', name: '创新药ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '创新药指数', status: 'L', market: 'E' },
  { ts_code: '560390.SH', name: '电网设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '电网设备指数', status: 'L', market: 'E' },
  { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L', market: 'E' },
  { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '上证5年期国债', status: 'L', market: 'E' },
  { ts_code: '518880.SH', name: '黄金ETF', fund_type: '商品型', invest_type: '被动指数型', benchmark: '上海金', status: 'L', market: 'E' },
  { ts_code: '513100.SH', name: '纳指ETF', fund_type: '股票型', invest_type: '国际(QDII)', benchmark: '纳斯达克100', status: 'L', market: 'E' },
];

// 收盘价与每日涨跌都固定，便于独立重算基准收益。
const CLOSE = {
  '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935,
  '516080.SH': 0.636, '560390.SH': 0.742,
  '510300.SH': 4.0, '511010.SH': 100.0, '518880.SH': 6.0, '513100.SH': 1.5,
};
const DAILY_RETURN = 0.001; // 每交易日 +0.1%
const AMOUNT_KCY = 500000;   // 千元；远高于流动性下限

function closeOn(base, index) {
  return Math.round(base * (1 + DAILY_RETURN * index) * 10000) / 10000;
}

function seed(file, { fundTables = true, shareTable = true, illiquidCodes = [], codes = Object.keys(CLOSE), withBars = codes } = {}) {
  const db = openAshareDb(file);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((date, index) => ({ cal_date: date, is_open: 1, pretrade_date: DAYS[index - 1] ?? null })));
  if (fundTables) {
    // 基础信息覆盖声明池里的每一只，避免“有声明、无 fund_basic 行”把整个池子降级。
    upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], BASIC);
  }
  for (const code of withBars) {
    const base = CLOSE[code];
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      DAYS.map((date, index) => ({
        ts_code: code, trade_date: date,
        open: closeOn(base, index), high: closeOn(base, index), low: closeOn(base, index),
        close: closeOn(base, index), pre_close: closeOn(base, index),
        vol: illiquidCodes.includes(code) ? 0 : 1e6,
        amount: illiquidCodes.includes(code) ? 1 : AMOUNT_KCY,
      })));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      DAYS.map(date => ({ ts_code: code, trade_date: date, adj_factor: 1 })));
    if (shareTable) {
      upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share'],
        DAYS.map(date => ({ ts_code: code, trade_date: date, fd_share: 1e6 })));
    }
  }
  return db;
}

/**
 * 只建出部分表的原始缓存：`openAshareDb()` 总会创建全部 fund_* 表，无法模拟
 * 生产缓存“还没有 fund_* 表”的状态，所以这里用 DatabaseSync 手写 schema。
 */
function seedPartial(file, { tradeCal = true, fundDaily = true, codes = [] } = {}) {
  const db = new DatabaseSync(file);
  if (tradeCal) {
    db.exec('CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER NOT NULL, pretrade_date TEXT)');
    const insert = db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?,?,?)');
    DAYS.forEach((date, index) => insert.run(date, 1, DAYS[index - 1] ?? null));
  }
  if (fundDaily) {
    db.exec('CREATE TABLE fund_daily (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, pre_close REAL, change REAL, pct_chg REAL, vol REAL, amount REAL, PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID');
    const insert = db.prepare('INSERT OR REPLACE INTO fund_daily (ts_code, trade_date, open, high, low, close, pre_close, vol, amount) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const code of codes) {
      const base = CLOSE[code];
      DAYS.forEach((date, index) => {
        const price = closeOn(base, index);
        insert.run(code, date, price, price, price, price, price, 1e6, AMOUNT_KCY);
      });
    }
  }
  return db;
}

const marketFull = seed(MARKET_FULL);
// 生产缓存当前的状态：有 trade_cal，没有 fund_* 表。
const marketNoFund = seedPartial(join(dir, 'raw-no-fund.sqlite'), { tradeCal: true, fundDaily: false });
// 有 fund_daily，但缺 fund_basic / fund_adj / fund_share。
const marketNoShare = seedPartial(join(dir, 'raw-no-share.sqlite'), { tradeCal: true, fundDaily: true, codes: Object.keys(CLOSE) });
const marketIlliquid = seed(MARKET_ILLIQUID, { illiquidCodes: ['510300.SH'] });

const byCode = (result, code) => result.candidates.find(candidate => candidate.ts_code === code);

// ---------------------------------------------------------------- C2-1

test('C2-1 完整缓存：五类候选按确定性顺序返回，持仓永远在结果里', () => {
  const result = screenEtfCandidates(marketFull, { asOf: LAST });
  assert.equal(result.schema, 'ashare-etf-candidate-screen/1.0');
  assert.equal(result.as_of_trade_date, LAST);
  assert.deepEqual(result.categories_requested, [...ETF_CANDIDATE_CATEGORIES]);
  assert.equal(result.data_coverage.status, 'READY');
  assert.deepEqual(result.data_coverage.missing_tables, []);

  for (const code of HELD) {
    const row = byCode(result, code);
    assert.ok(row, `${code} 必须出现`);
    assert.equal(row.held, true);
    assert.equal(row.included, true);
  }
  // 五个类别都至少有一个候选。
  for (const category of ETF_CANDIDATE_CATEGORIES) {
    const declared = ETF_CANDIDATE_DECLARATIONS.some(item => item.category === category);
    const present = result.candidates.some(candidate => candidate.category === category);
    assert.equal(present, declared, `${category} 的候选出现情况与声明不一致`);
  }
  // 分数降序（null 排最后），排名连续。
  const scored = result.candidates.filter(candidate => candidate.score !== null);
  for (let i = 1; i < scored.length; i += 1) {
    assert.ok(scored[i - 1].score >= scored[i].score, '分数必须降序');
  }
  result.candidates.forEach((candidate, index) => assert.equal(candidate.rank, index + 1));
});

test('C2-1b 相同输入两次调用得到完全相同的 JSON（确定性、无时间戳）', () => {
  const first = screenEtfCandidates(marketFull, { asOf: LAST });
  const second = screenEtfCandidates(marketFull, { asOf: LAST });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal('generated_at' in first, false);
});

// ---------------------------------------------------------------- C2-2

test('C2-2 缺 fund_* 表：每一行都是 DEGRADED 并写出原因，持仓不被丢弃', () => {
  const result = screenEtfCandidates(marketNoFund, { asOf: LAST });
  assert.equal(result.data_coverage.status, 'NOT_READY');
  assert.deepEqual(
    [...result.data_coverage.missing_tables].sort(),
    ['fund_adj', 'fund_basic', 'fund_daily', 'fund_share'],
  );
  assert.ok(result.data_coverage.reasons.some(reason => reason.includes('fund_daily_table_missing')));

  // 声明池里的每一只都必须出现，不允许因为缺表被静默丢弃。
  // （limit 只截断 OK 的非持仓行；缺数据的行一律保留。）
  assert.equal(result.declared, ETF_CANDIDATE_DECLARATIONS.length);
  assert.ok(result.candidates.length >= HELD.length, '至少五只持仓必须在结果里');
  assert.equal(result.candidates.filter(candidate => !candidate.held).length, ETF_CANDIDATE_DECLARATIONS.length - HELD.length,
    '缺表时非持仓候选也全部保留，不因 limit 被丢弃');
  for (const row of result.candidates) {
    assert.equal(row.status, 'DEGRADED', `${row.ts_code} 应为 DEGRADED`);
    assert.ok(row.status_reasons.includes('fund_daily_table_missing'), `${row.ts_code} 缺少缺表原因`);
    assert.equal(row.filters.liquidity.state, 'unavailable');
    assert.equal(row.filters.liquidity.median_amount_kcy, null);
    assert.equal(row.filters.premium_discount.state, 'unavailable');
    assert.equal(row.filters.premium_discount.value_pct, null, '不得臆造溢价折价');
    assert.equal(row.score, null, '没有可评估分项时分数必须为 null');
  }
  // 持仓仍然全部在结果里，且没有被流动性/规模排除。
  for (const code of HELD) {
    const row = byCode(result, code);
    assert.ok(row, `${code} 必须出现`);
    assert.equal(row.held, true);
    assert.equal(row.included, true);
    assert.equal(row.exclusions.length, 0);
  }
  assert.ok(result.disclaimer.includes('不是买入信号'));
  assert.equal(result.disclaimer, ETF_UNIVERSE_DISCLAIMER);
});

// ---------------------------------------------------------------- C2-3

test('C2-3 缺 fund_share：规模为 null 且标 unavailable，其它过滤照常', () => {
  const result = screenEtfCandidates(marketNoShare, { asOf: LAST });
  assert.equal(result.data_coverage.status, 'DEGRADED');
  assert.ok(result.data_coverage.missing_tables.includes('fund_share'));
  const row = byCode(result, '510300.SH');
  assert.equal(row.filters.size.state, 'unavailable');
  assert.equal(row.filters.size.degrade_reason, 'fund_share_table_missing');
  assert.equal(row.filters.size.size_wan_cny, null);
  assert.equal(row.data.share.fd_share_wan, null);
  assert.equal(row.status, 'DEGRADED');
  // 有行情的代码流动性仍可评估。
  assert.equal(row.filters.liquidity.state, 'pass');
});

// ---------------------------------------------------------------- C2-4

test('C2-4 流动性不足：非持仓被排除并写出原因；持仓仍入选但保留排除原因', () => {
  const result = screenEtfCandidates(marketIlliquid, { asOf: LAST });
  const illiquid = byCode(result, '510300.SH');
  assert.ok(illiquid, '流动性不足的行仍必须出现在结果里（写出排除原因，而不是静默丢弃）');
  assert.equal(illiquid.held, false);
  assert.equal(illiquid.filters.liquidity.state, 'fail');
  assert.equal(illiquid.filters.liquidity.reason, 'liquidity_median_below_min');
  assert.equal(illiquid.filters.liquidity.median_amount_kcy, 1);
  assert.equal(illiquid.included, false);
  assert.ok(illiquid.exclusions.some(item => item.reason === 'liquidity_median_below_min'));
  assert.ok(result.excluded.some(item => item.ts_code === '510300.SH'));
  assert.ok(result.excluded.find(item => item.ts_code === '510300.SH').reasons.includes('liquidity:liquidity_median_below_min'));

  // 持仓永远入选；即使人为让它流动性不足，也只记录原因，不排除。
  for (const code of HELD) {
    const row = byCode(result, code);
    assert.equal(row.held, true);
    assert.equal(row.included, true);
  }
  // 阈值单位标注清楚（千元）。
  assert.ok(result.units.amount_kcy.includes('千元'));
  assert.equal(illiquid.filters.liquidity.threshold.min_median_amount_kcy, ETF_SCREEN_MIN_MEDIAN_AMOUNT_KCY);
});

test('C2-4b 类别过滤不影响五只持仓出现，limit 只截断 OK 的非持仓行', () => {
  const result = screenEtfCandidates(marketFull, { asOf: LAST, categories: ['gold'], limit: 1 });
  assert.deepEqual(result.categories_requested, ['gold']);
  assert.equal(result.limit, 1);
  for (const code of HELD) assert.ok(byCode(result, code), `${code} 必须出现`);
  // gold 类别本身只有一个非持仓候选，其余被 limit 截断；缺数据的行不受 limit 影响。
  const okNonHeld = result.candidates.filter(candidate => !candidate.held && candidate.status === 'OK');
  assert.ok(okNonHeld.length <= 1);
  for (const row of result.candidates) {
    if (!row.held && row.status !== 'OK') {
      // 缺数据的行保留是刻意行为，不是 limit 失效。
      assert.ok(row.status_reasons.length > 0);
    }
  }
});

// ---------------------------------------------------------------- C6

test('C6-1 冻结基准：三个基准可用，权重状态为 provisional_pending_user_approval', () => {
  const comparison = buildBenchmarkComparison({ marketDb: marketFull });
  assert.equal(comparison.schema, BENCHMARK_SCHEMA);
  assert.equal(comparison.definition_frozen, true);
  assert.equal(comparison.data_quality.status, 'OK');
  assert.deepEqual(comparison.window, { start: DAYS[0], end: LAST, trading_days: DAYS.length });

  const [csi300, basket, five] = comparison.benchmarks;
  assert.equal(csi300.id, 'csi300_etf_buy_hold');
  assert.equal(csi300.status, 'OK');
  assert.equal(csi300.legs[0].ts_code, CSI300_ETF_CODE);
  // 名义本金 10,000 元，期初 4.0 元/份 → 2500 份；期间 +0.1%/日，共 39 个交易日。
  assert.equal(csi300.legs[0].start_quantity, 2500);
  assert.equal(csi300.legs[0].end_price_milli, Math.round(closeOn(4.0, DAYS.length - 1) * 1000));
  assert.ok(csi300.total_return_pct > 0, '上涨序列的总收益应为正');
  assert.ok(csi300.max_drawdown_pct <= 0, '最大回撤必须是负百分数或 0');

  assert.equal(basket.id, 'frozen_multi_asset_basket');
  assert.equal(basket.status, 'OK');
  assert.equal(basket.weights_status, FROZEN_BASKET_WEIGHTS_STATUS);
  assert.deepEqual(basket.weights, { ...FROZEN_BASKET_WEIGHTS });
  assert.equal(Object.values(FROZEN_BASKET_WEIGHTS).reduce((a, b) => a + b, 0), 1, '权重合计必须为 1');

  assert.equal(five.id, 'initial_five_etf_basket');
  assert.equal(five.status, 'OK');
  for (const code of HELD) {
    const leg = five.legs.find(item => item.ts_code === code);
    assert.ok(leg, `${code} 必须出现在静态基线里`);
    assert.equal(leg.start_quantity, FROZEN_FIVE_QUANTITIES[code]);
  }
  // 两个"建仓型"基准共用同一窗口与同一费用口径。
  for (const benchmark of [comparison.benchmarks[0], comparison.benchmarks[1]]) {
    assert.deepEqual(benchmark.window, comparison.window);
    assert.equal(benchmark.price_basis, 'qfq_adjusted');
  }
  // 五只静态基准锚定在实际基线日 2026-10-16：数量与现金是当时的事实，
  // 不是用窗口起点重新建仓，因此不再计建仓费用。
  assert.equal(five.window.start, '20261016');
  assert.equal(five.window.end, comparison.window.end);
  assert.equal(five.entry_fee_cents, 0, '已持有的静态基准不得虚构建仓费用');
  assert.ok(five.cash_cents > 0, '账户现金必须计入起点');
  assert.equal(five.price_basis, 'qfq_adjusted');
  assert.equal(comparison.conventions.fees.assumed, true);
});

test('C6-2 基准收益可独立重算：买入持有收益 = 期末/期初 − 1（扣费后）', () => {
  const comparison = buildBenchmarkComparison({ marketDb: marketFull });
  const csi300 = comparison.benchmarks[0];
  const startPrice = closeOn(4.0, 0);
  const endPrice = closeOn(4.0, DAYS.length - 1);
  const quantity = csi300.legs[0].start_quantity;
  const gross = Math.round(quantity * startPrice * 100);
  const fee = csi300.entry_fee_cents;
  const expected = ((quantity * endPrice * 100 - (gross + fee)) / (gross + fee)) * 100;
  assert.equal(csi300.total_return_pct, Math.round(expected * 100) / 100);
  assert.equal(csi300.end_value_cents, Math.round(quantity * endPrice * 100));
});

test('C6-3 缺基准所需代码 → 该基准 unavailable 并写明原因，不缩短窗口', () => {
  const missing = seed(join(dir, 'market-missing-csi300.sqlite'), {
    codes: Object.keys(CLOSE).filter(code => code !== CSI300_ETF_CODE),
    withBars: Object.keys(CLOSE).filter(code => code !== CSI300_ETF_CODE),
  });
  const comparison = buildBenchmarkComparison({ marketDb: missing });
  const csi300 = comparison.benchmarks[0];
  assert.equal(csi300.status, 'UNAVAILABLE');
  // 单代码基准没有该代码的任何行情 → code_not_cached；窗口不完整时才是 leg_not_cached。
  assert.equal(csi300.reason, 'code_not_cached');
  assert.ok(csi300.missing_codes.includes(CSI300_ETF_CODE));
  assert.equal(csi300.total_return_pct, null);
  assert.equal(csi300.window, null);
  assert.equal(comparison.data_quality.status, 'DEGRADED');
  // 多资产篮子也含 510300.SH，同样 unavailable；五只静态基线不含该代码，仍可用。
  assert.equal(comparison.benchmarks[1].status, 'UNAVAILABLE');
  assert.equal(comparison.benchmarks[1].reason, 'leg_not_cached');
  assert.equal(comparison.benchmarks[2].status, 'OK');
});

test('C6-4 没有窗口 / 只有空缓存 → 三个基准全部 unavailable', () => {
  // 空库：openAshareDb 会建出 fund_* 表，但没有交易日、没有行情。
  const empty = openAshareDb(join(dir, 'empty.sqlite'));
  const comparison = buildBenchmarkComparison({ marketDb: empty });
  assert.equal(comparison.data_quality.status, 'UNAVAILABLE');
  assert.equal(comparison.window, null);
  for (const benchmark of comparison.benchmarks) {
    assert.equal(benchmark.status, 'UNAVAILABLE');
    assert.ok(benchmark.reason);
    assert.equal(benchmark.total_return_pct, null);
  }
  assert.ok(comparison.data_quality.reasons.some(reason => reason.includes('window_too_short')));
  assert.ok(comparison.disclaimer.includes('提前冻结'));

  // 没有市场缓存句柄：同样全部 unavailable，不抛异常、不伪造。
  const noCache = buildBenchmarkComparison({ marketDb: null });
  assert.equal(noCache.data_quality.status, 'UNAVAILABLE');
  assert.ok(noCache.data_quality.reasons.some(reason => reason.includes('market_cache_unavailable')));
  for (const benchmark of noCache.benchmarks) assert.equal(benchmark.status, 'UNAVAILABLE');
});

test('C6-5 确定性：相同输入两次调用得到完全相同的 JSON', () => {
  const first = buildBenchmarkComparison({ marketDb: marketFull, start: DAYS[0], end: LAST });
  const second = buildBenchmarkComparison({ marketDb: marketFull, start: DAYS[0], end: LAST });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
