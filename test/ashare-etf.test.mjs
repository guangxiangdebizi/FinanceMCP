// ETF 数据纵切（R0）离线测试：不访问网络，使用临时 SQLite 与手写行情。
// 覆盖：五只基础信息映射、手/千元→份/元、qfq/hfq 与未来因子隔离、份额变化与
// 净申购标签、缺行情/滞后行情降级、空库状态、MCP 工具与既有工具面回归。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-etf-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'live.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
// 离线测试不等待真实退避：重试逻辑本身由既有测试覆盖，这里只验证回退路径。
process.env.ASHARE_TUSHARE_MAX_RETRIES = '0';
process.env.TUSHARE_TOKEN = 'test-token';

const { openAshareDb, upsertRows, closeAshareDb, migrateAshareDb } = await import('../build/ashare/db.js');
const etf = await import('../build/ashare/etf.js');
const {
  ETF_UNIVERSE, ETF_LOT_SIZE, ETF_TRADE_UNIT, ETF_STALE_MAX_AGE_DAYS, ETF_LIQUIDITY_WINDOW,
  FLOW_LABEL_RULE, ETF_NOT_INITIALIZED, classifyFlow, etfQuotes, etfStatus, etfSchemaReady,
  syncFundBasic, syncFundDaily, syncFundAdj, syncFundShare,
} = etf;
const { ashareToolDefinitions } = await import('../build/ashare/definitions.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const DATES = weekdays('20260105', 30);
const LAST = DATES.at(-1);
const originalFetch = globalThis.fetch;
/** 本地 YYYYMMDD 加减自然日，避免为测试引入额外依赖。 */
function addDaysLocal(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------- shared fixture

const db = openAshareDb();
db.exec('PRAGMA foreign_keys = OFF');
upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
  DATES.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DATES[i - 1] ?? null })));

const BASIC = [
  { ts_code: '159241.SZ', name: '航空航天ETF', management: '基金公司A', custodian: '银行A', fund_type: '股票型', found_date: '20200101', list_date: '20200302', issue_amount: 12.3, m_fee: 0.5, c_fee: 0.1, benchmark: '航空航天指数', status: 'L', invest_type: '被动指数型', type: '契约型开放式', market: 'E' },
  { ts_code: '159278.SZ', name: '机器人ETF', management: '基金公司B', custodian: '银行B', fund_type: '股票型', found_date: '20210101', list_date: '20210302', issue_amount: 8.1, m_fee: 0.5, c_fee: 0.1, benchmark: '机器人指数', status: 'L', invest_type: '被动指数型', type: '契约型开放式', market: 'E' },
  { ts_code: '159558.SZ', name: '半导体设备ETF', management: '基金公司C', custodian: '银行C', fund_type: '股票型', found_date: '20190101', list_date: '20190302', issue_amount: 30.5, m_fee: 0.5, c_fee: 0.1, benchmark: '半导体设备指数', status: 'L', invest_type: '被动指数型', type: '契约型开放式', market: 'E' },
  { ts_code: '516080.SH', name: '创新药ETF', management: '基金公司D', custodian: '银行D', fund_type: '股票型', found_date: '20200101', list_date: '20200302', issue_amount: 5.5, m_fee: 0.5, c_fee: 0.1, benchmark: '创新药指数', status: 'L', invest_type: '被动指数型', type: '契约型开放式', market: 'E' },
  { ts_code: '560390.SH', name: '电网设备ETF', management: '基金公司E', custodian: '银行E', fund_type: '股票型', found_date: '20200101', list_date: '20200302', issue_amount: 7.7, m_fee: 0.5, c_fee: 0.1, benchmark: '电网设备指数', status: 'L', invest_type: '被动指数型', type: '契约型开放式', market: 'E' },
];
upsertRows(db, 'fund_basic', ['ts_code', 'name', 'management', 'custodian', 'fund_type', 'found_date', 'list_date', 'issue_amount', 'm_fee', 'c_fee', 'benchmark', 'status', 'invest_type', 'type', 'market'], BASIC);

const DAILY_COLS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'];
const bar = (code, date, opts = {}) => ({
  ts_code: code, trade_date: date, open: 1, high: 1, low: 1, close: 1, pre_close: 1, change: 0, pct_chg: 0,
  vol: 1000, amount: 100, ...opts,
});

// 159558：DATES[20] 发生 2:1 拆分，价格 1.0 → 0.5，因子 1 → 2。最后一天用于单位换算。
const SPLIT = '159558.SZ';
const SPLIT_DAY = DATES[20];
DATES.forEach((d, i) => {
  const post = i >= 20;
  upsertRows(db, 'fund_daily', DAILY_COLS, [bar(SPLIT, d, {
    open: post ? 0.5 : 1, high: post ? 0.5 : 1, low: post ? 0.5 : 1, close: post ? 0.5 : 1, pre_close: post ? 0.5 : 1,
    // 最后一天的手写数字用于单位断言。
    vol: d === LAST ? 12345 : 1000,
    amount: d === LAST ? 678.9 : 100,
  })]);
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: SPLIT, trade_date: d, adj_factor: post ? 2 : 1 }]);
});
// 其余代码：159241 完全无行情；159278 只到 DATES[20]（滞后）；516080/560390 完整。
for (const code of ['159278.SZ', '516080.SH', '560390.SH']) {
  for (const d of code === '159278.SZ' ? DATES.slice(0, 21) : DATES) {
    upsertRows(db, 'fund_daily', DAILY_COLS, [bar(code, d, { close: 0.8, open: 0.8, high: 0.8, low: 0.8, pre_close: 0.8, vol: 500, amount: 40 })]);
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: code, trade_date: d, adj_factor: 1 }]);
  }
}
// 份额：159558 两个日期（可计算变化）；516080 无份额；560390 只有一个日期。
upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
  { ts_code: SPLIT, trade_date: DATES[27], fd_share: 100000, fund_type: 'ETF', market: 'SZ' },
  { ts_code: SPLIT, trade_date: DATES[28], fd_share: 102000, fund_type: 'ETF', market: 'SZ' },
  { ts_code: '560390.SH', trade_date: DATES[28], fd_share: 50000, fund_type: 'ETF', market: 'SH' },
]);
db.prepare("INSERT OR REPLACE INTO fund_sync_log (dataset, key, rows, status, message, synced_at) VALUES ('fund_daily', ?, 5, 'ok', '', '2026-01-05T00:00:00.000Z')").run(LAST);

// ---------------------------------------------------------------- A. basic mapping

test('1. five ETF basic records map code → name → market → list_date', () => {
  assert.deepEqual([...ETF_UNIVERSE], ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH']);
  const q = etfQuotes(db, undefined, { start: DATES[0], end: LAST });
  assert.equal(q.quotes.length, 5);
  for (const [i, x] of q.quotes.entries()) {
    const b = BASIC[i];
    assert.equal(x.ts_code, b.ts_code);
    assert.equal(x.name, b.name);
    assert.equal(x.market, 'E');
    assert.equal(x.list_date, b.list_date);
    assert.equal(x.fund_type, '股票型');
    assert.equal(x.invest_type, '被动指数型');
    assert.equal(x.benchmark, b.benchmark);
    assert.equal(x.status, 'L');
    assert.deepEqual(x.trade_unit, { lot_size: 100, unit: 'share', lot_unit: '手' });
    assert.equal(x.source, 'tushare.fund_daily');
    assert.equal(ETF_LOT_SIZE, 100);
    assert.deepEqual(ETF_TRADE_UNIT, x.trade_unit);
  }
});

// ---------------------------------------------------------------- B. units

test('2. vol(手)×100 = 份 and amount(千元)×1000 = 元', () => {
  const q = etfQuotes(db, [SPLIT], { start: DATES[0], end: LAST });
  const b = q.quotes[0].latest_bar;
  assert.equal(b.trade_date, LAST);
  assert.equal(b.vol_lots, 12345);
  assert.equal(b.volume_shares, 12345 * ETF_LOT_SIZE);
  assert.equal(b.amount_kcny, 678.9);
  assert.equal(b.amount_cny, 678900);
  assert.equal(b.close_cny, 0.5);
  // 默认 adjust=none：复权价与原始价一致，amount/vol 不改写。
  assert.equal(q.query.adjust, 'none');
  assert.equal(q.quotes[0].adjusted.close, 0.5);
});

// ---------------------------------------------------------------- C. adjustment

// 真实事件（docs/audit/etf-baseline-20261018.json）：159558.SZ 在 20260709 发生 1→3 拆分。
// 真实日期晚于上面的合成窗口，因此单独建库，互不影响。
const REAL = '159558.SZ';
const REAL_DAYS = ['20260707', '20260708', '20260709', '20260710', '20260713'];
const realDb = openAshareDb(join(dir, 'real-split.sqlite'));
upsertRows(realDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], REAL_DAYS.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: REAL_DAYS[i - 1] ?? null })));
upsertRows(realDb, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'market', 'list_date', 'status'], [
  { ts_code: REAL, name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', market: 'E', list_date: '20190302', status: 'L' },
]);
// 原始行情：拆分前 close 4.215；拆分首日 pre_close 4.215/3 = 1.405，pct_chg +10.04%。
upsertRows(realDb, 'fund_daily', DAILY_COLS, [
  { ts_code: REAL, trade_date: '20260707', open: 4.11, high: 4.2, low: 4.05, close: 4.148, pre_close: 4.1, change: 0.048, pct_chg: 1.17, vol: 5000000, amount: 2100000 },
  { ts_code: REAL, trade_date: '20260708', open: 4.138, high: 4.35, low: 3.975, close: 4.215, pre_close: 4.148, change: 0.067, pct_chg: 1.62, vol: 5711734.19, amount: 2380355.2939 },
  { ts_code: REAL, trade_date: '20260709', open: 1.44, high: 1.546, low: 1.415, close: 1.546, pre_close: 1.405, change: 0.141, pct_chg: 10.04, vol: 15837801.82, amount: 2327849.3384 },
  { ts_code: REAL, trade_date: '20260710', open: 1.554, high: 1.611, low: 1.44, close: 1.445, pre_close: 1.546, change: -0.101, pct_chg: -6.53, vol: 26311198.58, amount: 4076980.7814 },
  { ts_code: REAL, trade_date: '20260713', open: 1.45, high: 1.47, low: 1.43, close: 1.46, pre_close: 1.445, change: 0.015, pct_chg: 1.04, vol: 20000000, amount: 2900000 },
]);
upsertRows(realDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [
  { ts_code: REAL, trade_date: '20260707', adj_factor: 1 },
  { ts_code: REAL, trade_date: '20260708', adj_factor: 1 },
  { ts_code: REAL, trade_date: '20260709', adj_factor: 3 },
  { ts_code: REAL, trade_date: '20260710', adj_factor: 3 },
  { ts_code: REAL, trade_date: '20260713', adj_factor: 3 },
]);

test('3. synthetic 2:1 split: qfq/hfq use fund_adj and qfq never uses a factor after end_date', () => {
  const after = etfQuotes(db, [SPLIT], { start: DATES[18], end: LAST, adjust: 'qfq' });
  const x = after.quotes[0];
  assert.equal(x.adjusted.base.adj_factor, 2);
  assert.equal(x.adjusted.base.trade_date, LAST);
  // 拆分后 0.5 × 2/2 = 0.5；拆分前由最新的 0.5 价位衡量历史：1.0 × 1/2 = 0.5。
  assert.equal(x.adjusted.close, 0.5);
  const hist = etfQuotes(db, [SPLIT], { start: DATES[18], end: DATES[19], adjust: 'qfq' });
  assert.equal(hist.quotes[0].adjusted.base.trade_date, DATES[19]);
  assert.equal(hist.quotes[0].adjusted.close, 1, 'end 之前的因子为 1，不得使用拆分后的 2');
  const hfq = etfQuotes(db, [SPLIT], { start: DATES[18], end: LAST, adjust: 'hfq' });
  assert.equal(hfq.quotes[0].adjusted.close, 1, 'hfq = price × factor = 0.5 × 2');
  assert.throws(() => etfQuotes(db, [SPLIT], { start: DATES[0], end: LAST, adjust: 'abc' }), /adjust/);
});

test('3b. real 1→3 split on 20260709: raw 4.215 is kept, qfq divides by 3, event is surfaced', () => {
  const q = etfQuotes(realDb, [REAL], { start: '20260707', end: '20260713', adjust: 'qfq' });
  const x = q.quotes[0];
  assert.equal(x.adjusted.base.trade_date, '20260713');
  assert.equal(x.adjusted.base.adj_factor, 3);
  // 原始行情保留：未复权的 close/pre_close 就是交易所原值，不被拆分平滑。
  assert.equal(x.latest_bar.trade_date, '20260713');
  assert.equal(x.latest_bar.close_cny, 1.46);
  const raw = etfQuotes(realDb, [REAL], { start: '20260708', end: '20260708', adjust: 'none' });
  assert.equal(raw.quotes[0].latest_bar.close_cny, 4.215);
  assert.equal(raw.quotes[0].adjusted.close, 4.215);
  // 前复权：拆分前 4.215 × 1 / 3 = 1.405，等于拆分首日的原始 pre_close（1.405）。
  assert.deepEqual(x.adjusted_rows.map(r => r.trade_date), REAL_DAYS);
  assert.deepEqual(x.adjusted_rows.map(r => r.close), [4.148 / 3, 1.405, 1.546, 1.445, 1.46].map(v => Math.round(v * 10000) / 10000));
  // end 就是拆分前一日时，基准只能是当日因子 1：qfq 等于原始价，绝不使用未来因子。
  const before = etfQuotes(realDb, [REAL], { start: '20260708', end: '20260708', adjust: 'qfq' });
  assert.equal(before.quotes[0].adjusted.close, 4.215);
  assert.equal(before.quotes[0].adjusted.base.adj_factor, 1, 'end 早于拆分日时绝不使用未来因子');
  assert.deepEqual(before.quotes[0].adjustment_events, [], 'end 早于拆分日时不报告未来事件');
  // 而拆分之后（end ≥ 20260709）同一根 20260708 的 K 线必须除以 3：取 0707~0713
  // 窗口的第一行验证（窗口内 end=0713 → base=3）。
  assert.equal(x.adjusted_rows[1].close, 1.405, '4.215 / 3');
  // 拆分事件显式列出，而不是静默平滑。
  assert.deepEqual(x.adjustment_events, [{ trade_date: '20260709', from_factor: 1, to_factor: 3, factor_ratio: 3 }]);
  // hfq = 原始价 × 当日因子：拆分前 4.215 × 1 = 4.215，拆分后 1.546 × 3 = 4.638。
  const hfqBefore = etfQuotes(realDb, [REAL], { start: '20260708', end: '20260708', adjust: 'hfq' });
  assert.equal(hfqBefore.quotes[0].adjusted.close, 4.215);
  const hfqAfter = etfQuotes(realDb, [REAL], { start: '20260709', end: '20260709', adjust: 'hfq' });
  assert.equal(hfqAfter.quotes[0].adjusted.close, 1.546 * 3);
});

// ---------------------------------------------------------------- D. shares and flow

test('4. share change needs two comparable dates; otherwise null + share_missing, never inflow', () => {
  const q = etfQuotes(db, [SPLIT, '516080.SH', '560390.SH'], { start: DATES[0], end: LAST });
  const [split, noShare, oneShare] = q.quotes;
  assert.equal(split.share.fd_share_wan, 102000);
  assert.equal(split.share.fd_share_wan_prev, 100000);
  assert.equal(split.share.share_change_wan, 2000);
  assert.equal(split.share.share_change_pct, 2);
  assert.equal(split.flow.label, 'net_creation_estimate');
  assert.equal(split.flow.amount_cny, 2000 * 1e4 * 0.5);

  assert.equal(noShare.share.fd_share_wan, null);
  assert.equal(noShare.share.share_change_wan, null);
  assert.equal(noShare.flow.label, null);
  assert.equal(noShare.flow.amount_cny, null);
  assert.ok(noShare.quality.reasons.includes('share_missing'));
  assert.equal(noShare.quality.status, 'DEGRADED');

  assert.equal(oneShare.share.share_change_wan, null);
  assert.ok(oneShare.quality.reasons.includes('share_prev_missing'));
  assert.equal(oneShare.flow.label, null);

  // 直接调用标签分类器：条件不足时一定是 null，并且规则文本禁止“资金净流入”。
  assert.equal(classifyFlow({ latest: null, previous: null, nav_proxy: 1 }).label, null);
  assert.equal(classifyFlow({ latest: { trade_date: LAST, fd_share_wan: 1 }, previous: null, nav_proxy: 1 }).label, null);
  assert.equal(classifyFlow({ latest: { trade_date: LAST, fd_share_wan: 1 }, previous: { trade_date: DATES[0], fd_share_wan: 1 }, nav_proxy: null }).label, null);
  assert.match(FLOW_LABEL_RULE, /net_creation_estimate/);
  assert.match(FLOW_LABEL_RULE, /不是“资金净流入”/);
});

// ---------------------------------------------------------------- E. missing / stale

test('5. a code with no bar at all is NOT_READY with no fabricated price', () => {
  const q = etfQuotes(db, ['159241.SZ'], { start: DATES[0], end: LAST });
  const x = q.quotes[0];
  assert.equal(x.quality.status, 'NOT_READY');
  assert.equal(x.latest_bar, null);
  assert.equal(x.adjusted.close, null);
  assert.ok(x.quality.reasons.includes('no_bar_in_window'));
  assert.ok(x.quality.missing.includes('fund_daily'));
  assert.equal(x.liquidity.mean_amount_cny, null);
  assert.equal(x.share.fd_share_wan, null);
  assert.equal(x.flow.label, null);
});

test('6. a stale bar is returned with its real date and flagged, not replaced or extrapolated', () => {
  const q = etfQuotes(db, ['159278.SZ'], { start: DATES[0], end: LAST });
  const x = q.quotes[0];
  assert.equal(x.expected_trade_date, LAST);
  assert.equal(x.latest_bar.trade_date, DATES[20], '真实行情日期原样返回');
  assert.equal(x.bar_matches_expected, false);
  assert.equal(x.stale, true);
  assert.equal(x.quality.status, 'DEGRADED');
  assert.ok(x.quality.reasons.some(r => r.startsWith('stale_bar')));
  // 7 个自然日规则：没有交易日历时，距查询截止日超过 7 天仍标记 STALE。
  const noCal = openAshareDb(join(dir, 'nocal.sqlite'));
  try {
    upsertRows(noCal, 'fund_basic', ['ts_code', 'name', 'market'], [{ ts_code: '159278.SZ', name: '机器人ETF', market: 'E' }]);
    upsertRows(noCal, 'fund_daily', DAILY_COLS, [bar('159278.SZ', '20260105')]);
    const far = etfQuotes(noCal, ['159278.SZ'], { start: '20260101', end: '20260120' });
    assert.equal(far.quotes[0].expected_trade_date, null);
    assert.equal(far.quotes[0].stale, true);
    assert.ok(far.quotes[0].quality.reasons.some(r => r.includes('15 个自然日')));
  } finally {
    noCal.close();
  }
  assert.ok(ETF_STALE_MAX_AGE_DAYS === 7);
});

// ---------------------------------------------------------------- F. status

test('7. etfStatus on an empty cache is NOT_READY with reasons and no exception', () => {
  const empty = openAshareDb(join(dir, 'empty.sqlite'));
  try {
    upsertRows(empty, 'trade_cal', ['cal_date', 'is_open'], [{ cal_date: LAST, is_open: 1 }]);
    const s = etfStatus(empty, { date: LAST });
    assert.equal(s.initialized, true);
    assert.equal(s.quality.status, 'NOT_READY');
    assert.equal(s.latest_fund_daily_date, null);
    assert.equal(s.codes.length, 5);
    assert.ok(s.codes.every(c => c.status === 'NOT_READY'));
    assert.ok(s.quality.reasons.length > 0);
    assert.equal(s.universe_size, 5);
  } finally {
    empty.close();
  }
  const good = etfStatus(db, { date: LAST });
  assert.equal(good.expected_trade_date, LAST);
  assert.equal(good.latest_fund_daily_date, LAST);
  assert.equal(good.coverage.codes_with_basic, 5);
  assert.equal(good.coverage.codes_with_bar_on_latest, 3, '159241 无行情，159278 滞后');
  assert.equal(good.fund_share.codes_with_share, 2);
  assert.equal(good.fund_share.available, true);
  assert.equal(good.quality.status, 'DEGRADED');
  // 短展示窗口不影响流动性统计：逐只仍按自己的最近 20 根行情计算，完整缓存的
  // 代码不会因 etfStatus 内部只查 30 个自然日而被判 DEGRADED。
  const full = etfQuotes(db, ['560390.SH'], { start: addDaysLocal(LAST, -30), end: LAST });
  assert.equal(full.quotes[0].liquidity.bars_used, 20, '流动性单独取 20 根，不是展示窗口里的条数');
  assert.equal(full.quotes[0].quality.reasons.includes('liquidity_window_short'), false);
  const short = etfQuotes(db, ['560390.SH'], { start: DATES[28], end: LAST });
  assert.equal(short.quotes[0].liquidity.bars_used, 20, '展示窗口只有 2 天，流动性仍是 20 根');
  // 该窗口内没有份额数据（合成样本只给了 2 只），所以此处只验证流动性不降级；
  // 完整缓存的 READY 由未迁移库/真实形状样本的其他断言覆盖。
  assert.equal(short.quotes[0].quality.reasons.some(r => r.startsWith('liquidity_window_short')), false);

  // 完整缓存（行情 + 复权 + 份额 + 交易日历）在正常交易日必须 READY，
  // 即使展示窗口短于 20 根 —— 这就是 liquidity_window_short 不能作为质量原因的回归。
    const complete = openAshareDb(join(dir, 'complete.sqlite'));
  try {
    // etfStatus 默认查询五只冻结 ETF；完整缓存样本必须包含全部五只基础信息。
    upsertRows(complete, 'trade_cal', ['cal_date', 'is_open'], DATES.map(d => ({ cal_date: d, is_open: 1 })));
    upsertRows(complete, 'fund_basic', ['ts_code', 'name', 'market', 'fund_type', 'invest_type', 'status'], BASIC.map(b => ({
      ts_code: b.ts_code, name: b.name, market: b.market, fund_type: b.fund_type, invest_type: b.invest_type, status: b.status,
    })));
    for (const d of DATES) {
      for (const b of BASIC) {
        upsertRows(complete, 'fund_daily', DAILY_COLS, [bar(b.ts_code, d, { close: 0.742, open: 0.742, high: 0.742, low: 0.742, pre_close: 0.742 })]);
        upsertRows(complete, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: b.ts_code, trade_date: d, adj_factor: 1 }]);
      }
    }
    for (const b of BASIC) {
      upsertRows(complete, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
        { ts_code: b.ts_code, trade_date: DATES[27], fd_share: 1000, fund_type: 'ETF', market: b.ts_code.endsWith('.SH') ? 'SH' : 'SZ' },
        { ts_code: b.ts_code, trade_date: LAST, fd_share: 1100, fund_type: 'ETF', market: b.ts_code.endsWith('.SH') ? 'SH' : 'SZ' },
      ]);
    }
    const ready = etfQuotes(complete, ['560390.SH'], { start: DATES.at(-2), end: LAST });
    assert.equal(ready.quotes[0].quality.status, 'READY', JSON.stringify(ready.quotes[0].quality.reasons));
    assert.equal(ready.quotes[0].liquidity.bars_used, 20);
    assert.equal(ready.quotes[0].stale, false);
    const st = etfStatus(complete, { date: LAST });
    assert.equal(st.quality.status, 'READY', JSON.stringify(st.quality.reasons));
    assert.ok(st.codes.every(c => c.status === 'READY'));
  } finally {
    complete.close();
  }
});

test('7b. a database without fund tables reports ETF_NOT_INITIALIZED instead of throwing an SQL error', () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec('CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER NOT NULL, pretrade_date TEXT)');
    assert.equal(etfSchemaReady(legacy), false);
    const s = etfStatus(legacy, { date: LAST });
    assert.equal(s.initialized, false);
    assert.equal(s.quality.status, 'NOT_READY');
    assert.deepEqual(s.quality.reasons, [ETF_NOT_INITIALIZED]);
    assert.throws(() => etfQuotes(legacy, undefined, {}), err => String(err.message).includes(ETF_NOT_INITIALIZED));
  } finally {
    legacy.close();
  }
});

// ---------------------------------------------------------------- G. tools

test('8. MCP tools are callable and an unknown code yields a clear per-code entry', async () => {
  const quotes = JSON.parse((await runAshareTool('ashare_etf_quotes', { ts_codes: ['159558.SZ', '999999.SZ'], start_date: DATES[0], end_date: LAST })).content[0].text);
  assert.equal(quotes.quotes.length, 2);
  assert.equal(quotes.quotes[0].ts_code, '159558.SZ');
  assert.equal(quotes.quotes[0].latest_bar.volume_shares, 12345 * 100);
  const unknown = quotes.quotes[1];
  assert.equal(unknown.ts_code, '999999.SZ');
  assert.equal(unknown.quality.status, 'NOT_READY');
  assert.equal(unknown.latest_bar, null);
  assert.ok(unknown.quality.reasons.includes('fund_basic_missing'));
  assert.ok(unknown.quality.reasons.includes('no_bar_in_window'));
  assert.equal(unknown.name, null);

  const status = JSON.parse((await runAshareTool('ashare_etf_status', { date: LAST })).content[0].text);
  assert.equal(status.expected_trade_date, LAST);
  assert.equal(status.codes.length, 5);

  // 默认五只 / 6 位代码解析为交易所后缀。
  const defaults = JSON.parse((await runAshareTool('ashare_etf_quotes', {})).content[0].text);
  assert.deepEqual(defaults.quotes.map(x => x.ts_code), [...ETF_UNIVERSE]);
  const bare = JSON.parse((await runAshareTool('ashare_etf_quotes', { ts_codes: ['560390'], end_date: LAST })).content[0].text);
  assert.equal(bare.quotes[0].ts_code, '560390.SH');
});

// ---------------------------------------------------------------- H. regression

test('9. the 9 pre-existing tools plus factor_snapshot are unchanged; ETF tools are appended', () => {
  const names = ashareToolDefinitions.map(t => t.name);
  const BEFORE = [
    'ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis', 'ashare_sector_rank',
    'ashare_factor_snapshot', 'ashare_stock_history', 'ashare_financial_data', 'ashare_market_data', 'ashare_stock_basic',
  ];
  assert.deepEqual(names.slice(0, BEFORE.length), BEFORE, '既有 10 个工具的顺序与名称未变');
  assert.deepEqual(names.slice(BEFORE.length), ['ashare_etf_quotes', 'ashare_etf_status']);
  const byName = new Map(ashareToolDefinitions.map(t => [t.name, t]));
  for (const n of BEFORE) assert.equal(byName.get(n).annotations.readOnlyHint, true, n);
  assert.equal(byName.get('ashare_etf_quotes').annotations.readOnlyHint, true);
  assert.equal(byName.get('ashare_etf_status').annotations.readOnlyHint, true);
  assert.match(byName.get('ashare_etf_quotes').description, /vol=手/);
  assert.match(byName.get('ashare_etf_quotes').description, /amount=千元/);
  assert.match(byName.get('ashare_etf_quotes').description, /不是资金净流入/);
  assert.match(byName.get('ashare_etf_quotes').description, /stale|STALE|滞后/);
});

// ---------------------------------------------------------------- I. schema and sync shape

// fund_basic 的真实分页行为（基线审计）：不带 ts_code 的全市场查询按 15000 行/页
// 返回，516080.SH 只出现在第 2 页。这里用一个只有 2 行的“第 2 页”复现同样的陷阱。
function pageAwareFetch(rows, opts = {}) {
  return async (_url, init) => {
    const { api_name, params, fields } = JSON.parse(init.body);
    const api = opts.override?.[api_name] ? opts.override[api_name](params) : null;
    if (api === 'error') return { ok: false, status: 500 };
    const pageSize = params.limit ?? rows.length;
    const offset = params.offset ?? 0;
    const pool = api_name === 'fund_basic' && !params.ts_code ? rows : rows.filter(r => !params.ts_code || r.ts_code === params.ts_code);
    const page = pool.slice(offset, offset + pageSize);
    const cols = fields.split(',');
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: page.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
}

test('11. fund_basic whole-market paging: a code that only appears on page 2 is still stored', async () => {
  // 第 1 页 15000 行 + 第 2 页 1 行，合计超过 fetchAll 的 6000 页长。
  const page1 = Array.from({ length: 15000 }, (_, i) => ({
    ts_code: `${String(500000 + i).padStart(6, '0')}.SH`, name: `基金${i}`, fund_type: '股票型', market: 'E', status: 'L', invest_type: '被动指数型',
  }));
  const page2 = ETF_UNIVERSE.filter(c => !page1.some(r => r.ts_code === c)).map(c => ({
    ts_code: c, name: `第2页${c}`, fund_type: '股票型', market: 'E', status: 'L', invest_type: '被动指数型',
  }));
  assert.ok(page2.some(r => r.ts_code === '516080.SH'), '516080.SH 只在第 2 页');
  const all = [...page1, ...page2];

  const mem = openAshareDb(':memory:');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ api: body.api_name, params: body.params });
    return pageAwareFetch(all)(url, init);
  };
  try {
    const r = await syncFundBasic(mem);
    assert.equal(r.rows, all.length, '两页都要写入，不能只存第 1 页');
    const stored = (mem.prepare('SELECT COUNT(*) n FROM fund_basic').get()).n;
    assert.equal(stored, all.length);
    assert.equal(mem.prepare('SELECT name FROM fund_basic WHERE ts_code = ?').get('516080.SH').name, '第2页516080.SH');
    assert.equal(r.per_code_codes, undefined, '两页都拿到时不需要逐只补查');
    // fetchAll 按请求页长（6000）翻页，直到第 2 页返回不足一页为止；15001 行 → 0/6000/12000。
    const basicCalls = calls.filter(c => c.api === 'fund_basic');
    assert.deepEqual(basicCalls.map(c => c.params.offset), [0, 6000, 12000]);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }
});

test('11a. a successful whole-market answer that omits a code is repaired per code', async () => {
  // 模拟“只返回第 1 页”的残缺全市场回答：516080.SH 不在其中。
  const partial = BASIC.filter(b => b.ts_code !== '516080.SH');
  const mem = openAshareDb(':memory:');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ api: body.api_name, params: body.params });
    // 全市场（无 ts_code）只返回残缺页；逐只请求仍能查到 516080.SH。
    return pageAwareFetch(body.params.ts_code ? BASIC : partial)(url, init);
  };
  try {
    const r = await syncFundBasic(mem);
    assert.equal(r.rows, 5, '漏掉的代码必须补查后写入');
    assert.deepEqual(r.per_code_codes, ['516080.SH']);
    assert.ok(mem.prepare('SELECT 1 FROM fund_basic WHERE ts_code = ?').get('516080.SH'));
    assert.deepEqual(calls.filter(c => c.params.ts_code).map(c => c.params.ts_code), ['516080.SH']);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }
});

test('11b. when the whole-market request fails, the per-code fallback still stores 516080.SH', async () => {
  const all = BASIC.map(b => ({ ...b }));
  const mem = openAshareDb(':memory:');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ api: body.api_name, params: body.params });
    // 全市场请求（无 ts_code）报错；逐代码请求正常返回。
    if (body.api_name === 'fund_basic' && !body.params.ts_code) return { ok: false, status: 500 };
    return pageAwareFetch(all)(url, init);
  };
  try {
    const r = await syncFundBasic(mem);
    assert.equal(r.rows, 5);
    assert.ok(r.error, '全市场失败要记录，而不是静默');
    const rows = mem.prepare('SELECT ts_code, name, market FROM fund_basic ORDER BY ts_code').all();
    assert.deepEqual(rows.map(x => x.ts_code).sort(), [...ETF_UNIVERSE].sort());
    assert.ok(rows.some(x => x.ts_code === '516080.SH'), '第 2 页代码必须由逐只回退补齐');
    assert.equal(rows.find(x => x.ts_code === '516080.SH').market, 'E');
    // 逐代码请求 5 次，每次带 ts_code。
    const fallback = calls.filter(c => c.api === 'fund_basic' && c.params.ts_code);
    assert.deepEqual(fallback.map(c => c.params.ts_code), [...ETF_UNIVERSE]);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }
});

// ---------------------------------------------------------------- J. live-shaped fixtures

test('12. live unit fixtures: 159241 20261016 vol/amount/fd_share convert exactly', () => {
  const live = openAshareDb(join(dir, 'live-units.sqlite'));
  try {
    upsertRows(live, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [{ ts_code: '159241.SZ', name: '天弘国证航天航空行业ETF', market: 'E', status: 'L' }]);
    upsertRows(live, 'fund_daily', DAILY_COLS, [{
      ts_code: '159241.SZ', trade_date: '20261016', pre_close: 1.0, open: 1.0, high: 1.02, low: 0.99, close: 1.005,
      change: 0.005, pct_chg: 0.5, vol: 1324820.01, amount: 132437.1582,
    }]);
    upsertRows(live, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
      { ts_code: '159241.SZ', trade_date: '20261015', fd_share: 122000.4265, fund_type: 'ETF', market: 'SZ' },
      { ts_code: '159241.SZ', trade_date: '20261016', fd_share: 123207.4265, fund_type: 'ETF', market: 'SZ' },
    ]);
    const q = etfQuotes(live, ['159241.SZ'], { start: '20261016', end: '20261016' });
    const x = q.quotes[0];
    assert.equal(x.latest_bar.vol_lots, 1324820.01);
    assert.equal(x.latest_bar.volume_shares, 132482001);
    assert.equal(x.latest_bar.amount_kcny, 132437.1582);
    assert.equal(x.latest_bar.amount_cny, 132437158.2);
    assert.equal(x.latest_bar.close_cny, 1.005);
    assert.equal(x.share.fd_share_wan, 123207.4265, '万份');
    assert.equal(x.share.fd_share_wan_prev, 122000.4265);
    assert.equal(x.share.share_change_wan, 1207);
    // 一条行情：今天就是交易日，不算滞后。流动性如实只有 1 根。
    assert.equal(x.liquidity.bars_used, 1);
    assert.equal(x.stale, false);
  } finally {
    live.close();
  }
});

test('10. fund schema is additive and idempotent; sync helpers write only fund_* tables', async () => {
  const tables = name => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  assert.ok(tables('fund_basic') && tables('fund_daily') && tables('fund_adj') && tables('fund_share') && tables('fund_sync_log'));
  assert.match(tables('fund_daily').sql, /PRIMARY KEY \(ts_code, trade_date\)/);
  assert.match(tables('fund_share').sql, /WITHOUT ROWID/);
  // 重复打开不报错，既有表结构不变；股票表仍在。
  const again = openAshareDb(join(dir, 'live.sqlite'));
  assert.ok(again.prepare("SELECT 1 FROM sqlite_master WHERE name = 'daily'").get());
  assert.deepEqual(migrateAshareDb(again), []);
  again.close();

  // 离线 Tushare mock：只统计被调用的接口与参数。
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const { api_name, params, fields } = JSON.parse(init.body);
    calls.push({ api: api_name, params });
    const rows = api_name === 'fund_basic' ? BASIC.map(b => ({ ...b }))
      : api_name === 'fund_daily' ? [bar(SPLIT, params.trade_date)]
        : api_name === 'fund_adj' ? [{ ts_code: params.ts_code, trade_date: DATES[0], adj_factor: 1 }]
          : api_name === 'fund_share' ? [{ ts_code: params.ts_code, trade_date: DATES[0], fd_share: 1, fund_type: 'ETF', market: 'SZ' }]
            : [];
    const cols = fields.split(',');
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: rows.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
  try {
    const mem = openAshareDb(':memory:');
    upsertRows(mem, 'trade_cal', ['cal_date', 'is_open'], [{ cal_date: DATES[0], is_open: 1 }, { cal_date: DATES[1], is_open: 1 }]);
    const basic = await syncFundBasic(mem);
    assert.equal(basic.rows, 5);
    const daily = await syncFundDaily(mem, DATES[0], DATES[1]);
    // 全市场一日只返回 1 行，远低于 ETF_DAILY_MIN_ROWS：既不能判为完整，也不能写入缓存。
    assert.equal(daily[DATES[0]].write, 'none');
    assert.equal(daily[DATES[0]].rows, 0);
    assert.match(daily[DATES[0]].error, /低于全市场下限/);
    assert.equal(daily[DATES[1]].rows, 0);
    const adj = await syncFundAdj(mem, DATES[0], DATES[1]);
    assert.equal(adj[SPLIT], 1);
    const share = await syncFundShare(mem, DATES[0], DATES[1]);
    assert.equal(share[SPLIT], 1);
    // fund_daily 按 trade_date 取全市场：不会按每只代码分别请求。
    const dailyCalls = calls.filter(c => c.api === 'fund_daily');
    assert.ok(dailyCalls.every(c => c.params.trade_date && !c.params.ts_code));
    assert.equal(dailyCalls.length, 2);
    assert.ok(calls.every(c => ['fund_basic', 'fund_daily', 'fund_adj', 'fund_share'].includes(c.api)));
    mem.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(ETF_LIQUIDITY_WINDOW === 20);
});

// ---------------------------------------------------------------- K. daily completeness (A2)

/** 全市场某一交易日的合成回答：n 只代码。 */
function marketRows(date, n, prefix = '5') {
  return Array.from({ length: n }, (_, i) => bar(`${prefix}${String(i).padStart(5, '0')}.SH`, date));
}
/** 只回答 fund_daily 的离线桩：按 trade_date 返回预设行数。 */
function dailyFetch(byDate) {
  return async (_url, init) => {
    const { api_name, params, fields } = JSON.parse(init.body);
    const rows = api_name === 'fund_daily' ? (byDate[params.trade_date] ?? []) : [];
    const cols = fields.split(',');
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: rows.map(r => cols.map(c => r[c] ?? null)) } }) };
  };
}
const rowsOn = (d, date) => d.prepare('SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ?').get(date).n;
/** 一个周五 + 其后周一的交易日历；周五已有一整日行情。 */
function mondayDb(name, { mondayRows = 0 } = {}) {
  const FRI = '20261009';
  const MON = '20261012';
  const d = openAshareDb(join(dir, name));
  upsertRows(d, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261008', is_open: 1, pretrade_date: '20261007' },
    { cal_date: FRI, is_open: 1, pretrade_date: '20261008' },
    { cal_date: '20261010', is_open: 0, pretrade_date: FRI },
    { cal_date: '20261011', is_open: 0, pretrade_date: FRI },
    { cal_date: MON, is_open: 1, pretrade_date: FRI },
  ]);
  upsertRows(d, 'fund_daily', DAILY_COLS, marketRows(FRI, 2000));
  if (mondayRows) upsertRows(d, 'fund_daily', DAILY_COLS, marketRows(MON, mondayRows));
  return { db: d, FRI, MON };
}

test('13. Monday: a 1-row answer after a full Friday is never complete and never replaces', async () => {
  const fresh = mondayDb('mon-fresh.sqlite');
  const keep = mondayDb('mon-keep.sqlite', { mondayRows: 2000 });
  // 自然日前一日是周日（0 行），旧实现因此把 1 行回答当成“有基准且完整”。
  globalThis.fetch = dailyFetch({ [fresh.MON]: marketRows(fresh.MON, 1) });
  try {
    const out = await syncFundDaily(fresh.db, fresh.MON, fresh.MON);
    assert.notEqual(out[fresh.MON].write, 'replaced', '1 行回答不得替换当日');
    assert.notEqual(out[fresh.MON].status, 'ok');
    assert.equal(rowsOn(fresh.db, fresh.MON), 0, '低于绝对下限的回答不写入缓存');
    assert.equal(rowsOn(fresh.db, fresh.FRI), 2000, '周五快照不受影响');

    // 已有完整周一快照时，残缺回答必须被挡住而不是覆盖。
    const kept = await syncFundDaily(keep.db, keep.MON, keep.MON, { refresh: true });
    assert.equal(kept[keep.MON].write, 'none');
    assert.equal(kept[keep.MON].rows, 2000, '已有快照必须保留');
    assert.notEqual(kept[keep.MON].status, 'ok');
    assert.match(kept[keep.MON].error, /明显少于基准/);
  } finally {
    globalThis.fetch = originalFetch;
    fresh.db.close();
    keep.db.close();
  }
});

test('14. post-holiday: the first day back is compared with the last trading day before the gap', async () => {
  const mem = openAshareDb(join(dir, 'holiday.sqlite'));
  const BEFORE = '20260930';
  const BACK = '20261008'; // 国庆长假后第一个交易日，自然日前一日是停市的 20261007
  upsertRows(mem, 'trade_cal', ['cal_date', 'is_open'], [{ cal_date: BEFORE, is_open: 1 }, { cal_date: BACK, is_open: 1 }]);
  upsertRows(mem, 'fund_daily', DAILY_COLS, marketRows(BEFORE, 2000));
  globalThis.fetch = dailyFetch({ [BACK]: marketRows(BACK, 1) });
  try {
    const out = await syncFundDaily(mem, BACK, BACK);
    assert.notEqual(out[BACK].write, 'replaced');
    assert.notEqual(out[BACK].status, 'ok');
    assert.equal(rowsOn(mem, BACK), 0);
    assert.match(out[BACK].error, /明显少于基准/);
    assert.equal(rowsOn(mem, BEFORE), 2000);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }
});

test('15. recovery: a retry with a full answer replaces the day and returns to ok', async () => {
  const mem = mondayDb('mon-recovery.sqlite');
  try {
    globalThis.fetch = dailyFetch({ [mem.MON]: marketRows(mem.MON, 1) });
    const bad = await syncFundDaily(mem.db, mem.MON, mem.MON);
    assert.notEqual(bad[mem.MON].status, 'ok');
    // 失败当天不会被记为 ok，因此下一次同步会自动重取。
    globalThis.fetch = dailyFetch({ [mem.MON]: marketRows(mem.MON, 2000) });
    const good = await syncFundDaily(mem.db, mem.MON, mem.MON);
    assert.equal(good[mem.MON].write, 'replaced');
    assert.equal(good[mem.MON].status, 'ok');
    assert.equal(good[mem.MON].rows, 2000);
    assert.equal(good[mem.MON].error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    mem.db.close();
  }
});

test('16. absolute floor: a tiny answer is never complete, even with no calendar predecessor', async () => {
  assert.equal(etf.ETF_DAILY_MIN_ROWS, 500, '全市场一日下限是导出常量');
  const mem = openAshareDb(join(dir, 'floor.sqlite'));
  const DAY = '20261012';
  upsertRows(mem, 'trade_cal', ['cal_date', 'is_open'], [{ cal_date: DAY, is_open: 1 }]); // 日历里没有更早的交易日
  try {
    globalThis.fetch = dailyFetch({ [DAY]: marketRows(DAY, 100) });
    const tiny = await syncFundDaily(mem, DAY, DAY);
    assert.notEqual(tiny[DAY].write, 'replaced');
    assert.notEqual(tiny[DAY].status, 'ok');
    assert.equal(rowsOn(mem, DAY), 0);
    assert.match(tiny[DAY].error, /低于全市场下限 500/);

    // 行数达标但日历给不出前一交易日：记为 unverifiable，仍然不是 complete。
    globalThis.fetch = dailyFetch({ [DAY]: marketRows(DAY, 2000) });
    const full = await syncFundDaily(mem, DAY, DAY, { refresh: true });
    assert.equal(full[DAY].status, 'unverifiable');
    assert.equal(full[DAY].write, 'merged');
    assert.equal(rowsOn(mem, DAY), 2000);
    assert.match(full[DAY].error, /完整性不可验证/);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }
});

// ---------------------------------------------------------------- L. OHLC validation (A2)

test('17. invalid OHLC/volume bars are never READY and never provide an executable price', () => {
  const bad = openAshareDb(join(dir, 'bad-bars.sqlite'));
  const DAYS = ['20261015', '20261016'];
  upsertRows(bad, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DAYS[i - 1] ?? null })));
  const GOOD = { open: 1, high: 1.02, low: 0.99, close: 1.005, pre_close: 1, vol: 1000, amount: 100 };
  const CASES = [
    ['510001.SH', {}, null],
    ['510002.SH', { close: 0 }, 'nonpositive_close'],
    ['510003.SH', { close: null }, 'missing_close'],
    ['510004.SH', { high: 0.9, low: 1.1 }, 'invalid_ohlc'],
    ['510005.SH', { vol: -1 }, 'negative_volume'],
    ['510006.SH', { open: 0 }, 'invalid_ohlc'],
  ];
  for (const [code, over] of CASES) {
    upsertRows(bad, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [{ ts_code: code, name: `测试${code}`, market: 'E', status: 'L' }]);
    upsertRows(bad, 'fund_daily', DAILY_COLS, [
      bar(code, DAYS[0], { ...GOOD, close: 1.0 }),
      bar(code, DAYS[1], { ...GOOD, ...over }),
    ]);
    upsertRows(bad, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], DAYS.map(d => ({ ts_code: code, trade_date: d, adj_factor: 1 })));
    upsertRows(bad, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
      { ts_code: code, trade_date: DAYS[0], fd_share: 1000, fund_type: 'ETF', market: 'SH' },
      { ts_code: code, trade_date: DAYS[1], fd_share: 1010, fund_type: 'ETF', market: 'SH' },
    ]);
  }
  try {
    const q = etfQuotes(bad, CASES.map(c => c[0]), { start: DAYS[0], end: DAYS[1] });
    const byCode = new Map(q.quotes.map(x => [x.ts_code, x]));
    // 配对正向：合法 K 线 → READY，价格与净申购估计都成立。
    const ok = byCode.get('510001.SH');
    assert.equal(ok.quality.status, 'READY', JSON.stringify(ok.quality.reasons));
    assert.equal(ok.executable_price_cny, 1.005);
    assert.equal(ok.latest_bar.close_cny, 1.005);
    assert.equal(ok.latest_bar.valid, true);
    assert.deepEqual(ok.latest_bar.validation_reasons, []);
    assert.equal(ok.flow.label, 'net_creation_estimate');
    assert.equal(ok.flow.amount_cny, Math.round(10 * 1e4 * 1.005 * 100) / 100);
    for (const [code, , expected] of CASES.slice(1)) {
      const x = byCode.get(code);
      assert.equal(x.quality.status, 'NOT_READY', `${code} 非法 K 线不得 READY`);
      assert.ok(x.quality.reasons.includes(expected), `${code}: ${expected} in ${JSON.stringify(x.quality.reasons)}`);
      assert.equal(x.latest_bar.valid, false);
      assert.equal(x.latest_bar.close_cny, null, `${code} 不得给出可执行价格`);
      assert.equal(x.executable_price_cny, null);
      assert.equal(x.adjusted.close, null, `${code} 非法 K 线不换算复权价`);
      assert.equal(x.flow.label, null, `${code} 坏价格不得驱动净申购估计`);
    }
  } finally {
    bad.close();
  }
});

test('18. fund_basic permission errors are distinguishable from a plain missing record', async () => {
  const mem = openAshareDb(join(dir, 'basic-permission.sqlite'));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40001, msg: '抱歉，您没有权限访问该接口，请提升积分' }) });
  try {
    const r = await syncFundBasic(mem);
    assert.equal(r.rows, 0);
    assert.equal(r.permission_denied, true);
    assert.match(r.error, /权限|积分/);
    const reasons = etfQuotes(mem, ['516080.SH'], { start: '20261015', end: '20261016' }).quotes[0].quality.reasons;
    assert.ok(reasons.includes('fund_basic_missing'));
    assert.ok(reasons.includes('fund_basic_permission'), JSON.stringify(reasons));
    assert.equal(etfStatus(mem, { date: '20261016' }).fund_basic.permission_denied, true);
  } finally {
    globalThis.fetch = originalFetch;
    mem.close();
  }

  // 普通失败只报缺失，不冒充权限问题。
  const other = openAshareDb(join(dir, 'basic-other-error.sqlite'));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40002, msg: '系统繁忙，请稍后重试' }) });
  try {
    const r = await syncFundBasic(other);
    assert.equal(r.permission_denied, undefined);
    const reasons = etfQuotes(other, ['516080.SH'], { start: '20261015', end: '20261016' }).quotes[0].quality.reasons;
    assert.ok(reasons.includes('fund_basic_missing'));
    assert.equal(reasons.includes('fund_basic_permission'), false);
    assert.equal(etfStatus(other, { date: '20261016' }).fund_basic.permission_denied, false);
  } finally {
    globalThis.fetch = originalFetch;
    other.close();
  }
});

// ---------------------------------------------------------------- M. corporate actions (A3)

test('19. a 1→3 split inside the share window suppresses the estimate as corporate_action_ambiguous', () => {
  upsertRows(realDb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
    { ts_code: REAL, trade_date: '20260708', fd_share: 100000, fund_type: 'ETF', market: 'SZ' },
    { ts_code: REAL, trade_date: '20260709', fd_share: 300000, fund_type: 'ETF', market: 'SZ' },
  ]);
  const x = etfQuotes(realDb, [REAL], { start: '20260708', end: '20260709' }).quotes[0];
  // 原始份额变化如实返回（事实），但不得据此报出巨量“净申购”。
  assert.equal(x.share.share_change_wan, 200000);
  assert.equal(x.flow.label, null);
  assert.equal(x.flow.reason, 'corporate_action_ambiguous');
  assert.equal(x.flow.amount_cny, null);
  assert.equal(x.flow.adjustment_kind, 'factor_change_unclassified', '因子变化只记为未分类，不断言拆分');
  assert.deepEqual(x.flow.adjustment_event, {
    from_date: '20260708', to_date: '20260709', from_factor: 1, to_factor: 3, factor_ratio: 3,
    adjustment_kind: 'factor_change_unclassified',
  });
  assert.equal(JSON.stringify(x.flow).includes('net_inflow'), false);
});

test('20. an unchanged factor (dividend-only) still yields an estimate; 159241 1015→1016 gives 0', () => {
  const flowDb = openAshareDb(join(dir, 'flow-basic.sqlite'));
  const DAYS = ['20261015', '20261016'];
  upsertRows(flowDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DAYS[i - 1] ?? null })));
  const SPEC = [
    ['159241.SZ', 1.005, 123207.4265, 123207.4265],
    ['510001.SH', 1.005, 1000, 1100],
  ];
  for (const [code, close, s0, s1] of SPEC) {
    const market = code.endsWith('.SH') ? 'SH' : 'SZ';
    upsertRows(flowDb, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [{ ts_code: code, name: `测试${code}`, market: 'E', status: 'L' }]);
    upsertRows(flowDb, 'fund_daily', DAILY_COLS, DAYS.map(d => bar(code, d, { open: close, high: close, low: close, close, pre_close: close })));
    upsertRows(flowDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], DAYS.map(d => ({ ts_code: code, trade_date: d, adj_factor: 1 })));
    upsertRows(flowDb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
      { ts_code: code, trade_date: DAYS[0], fd_share: s0, fund_type: 'ETF', market },
      { ts_code: code, trade_date: DAYS[1], fd_share: s1, fund_type: 'ETF', market },
    ]);
  }
  try {
    const [unchanged, dividend] = etfQuotes(flowDb, SPEC.map(s => s[0]), { start: DAYS[0], end: DAYS[1] }).quotes;
    assert.equal(unchanged.flow.label, 'net_creation_estimate');
    assert.equal(unchanged.flow.amount_cny, 0, '份额不变 → 估计为 0');
    assert.equal(unchanged.flow.share_change_wan, 0);
    assert.equal(unchanged.flow.adjustment_kind, null);
    assert.equal(unchanged.flow.nav_proxy_date, '20261016');
    assert.equal(unchanged.quality.status, 'READY');
    assert.equal(dividend.flow.label, 'net_creation_estimate');
    assert.equal(dividend.flow.amount_cny, Math.round(100 * 1e4 * 1.005 * 100) / 100);
    assert.equal(dividend.quality.status, 'READY');
  } finally {
    flowDb.close();
  }
});

test('21. reversed / over-long share periods, bad units and unverified adjustments are rejected', () => {
  const at = { nav_proxy: 1, nav_proxy_date: '20260709', adjustment_checked: true, share_dates_are_trading_days: true, latest_bar_date: '20260709' };
  const pt = d => ({ trade_date: d, fd_share_wan: 1000 });
  assert.equal(classifyFlow({ ...at, latest: pt('20260709'), previous: pt('20260710') }).reason, 'share_dates_not_comparable', '日期倒序');
  assert.equal(classifyFlow({ ...at, latest: pt('20260709'), previous: pt('20260709') }).reason, 'share_dates_not_comparable', '同一日期不是两个可比时点');
  assert.match(classifyFlow({ ...at, latest: pt('20260709'), previous: pt('20260501') }).reason, /^share_date_gap_\d+d_exceeds_45d$/, '两期不等长（超过容差）');
  assert.equal(classifyFlow({ ...at, latest: { trade_date: '20260709', fd_share_wan: 0 }, previous: pt('20260708') }).reason, 'share_units_invalid');
  assert.equal(classifyFlow({ ...at, latest: pt('20260709'), previous: { trade_date: '20260708', fd_share_wan: -5 } }).reason, 'share_units_invalid');
  assert.equal(classifyFlow({ ...at, latest: { trade_date: '20260709', fd_share_wan: Number.NaN }, previous: pt('20260708') }).reason, 'share_missing');
  assert.equal(classifyFlow({ ...at, share_dates_are_trading_days: false, latest: pt('20260709'), previous: pt('20260708') }).reason, 'share_date_not_trading_day');
  assert.equal(classifyFlow({ ...at, adjustment_checked: false, latest: pt('20260709'), previous: pt('20260708') }).reason, 'corporate_action_unverified');
  assert.equal(classifyFlow({ ...at, nav_proxy_date: '20260708', latest: pt('20260709'), previous: pt('20260708') }).reason, 'nav_proxy_date_mismatch');
  assert.equal(classifyFlow({ ...at, nav_proxy_date: null, latest: pt('20260709'), previous: pt('20260708') }).reason, 'nav_proxy_date_mismatch');
  // 配对正向：同日价格代理 + 因子未变 + 份额为正 → 估计成立。
  const ok = classifyFlow({ ...at, latest: { trade_date: '20260709', fd_share_wan: 1100 }, previous: pt('20260708') });
  assert.equal(ok.label, 'net_creation_estimate');
  assert.equal(ok.amount_cny, 100 * 1e4 * 1);
});

test('22. a share date without its own bar, or far behind the latest bar, produces no estimate', () => {
  const mem = openAshareDb(join(dir, 'flow-stale.sqlite'));
  const DAYS = ['20260601', '20260602', '20261015', '20261016'];
  upsertRows(mem, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DAYS[i - 1] ?? null })));
  const seed = (code, barDays, shareDays) => {
    upsertRows(mem, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [{ ts_code: code, name: `测试${code}`, market: 'E', status: 'L' }]);
    upsertRows(mem, 'fund_daily', DAILY_COLS, barDays.map(d => bar(code, d, { open: 1, high: 1, low: 1, close: 1, pre_close: 1 })));
    upsertRows(mem, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], barDays.map(d => ({ ts_code: code, trade_date: d, adj_factor: 1 })));
    upsertRows(mem, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      shareDays.map((d, i) => ({ ts_code: code, trade_date: d, fd_share: 1000 + i * 10, fund_type: 'ETF', market: 'SH' })));
  };
  // 份额停在 6 月，行情已到 10 月：份额明显滞后，不能输出“当期净申购”。
  seed('510011.SH', DAYS, ['20260601', '20260602']);
  // 份额日 20261016 当天没有行情：价格代理日期不匹配。
  seed('510012.SH', ['20260601', '20261015'], ['20261015', '20261016']);
  try {
    const [stale, noBar] = etfQuotes(mem, ['510011.SH', '510012.SH'], { start: '20260601', end: '20261016' }).quotes;
    assert.equal(stale.flow.label, null);
    assert.equal(stale.flow.reason, 'share_stale_for_period');
    assert.match(stale.flow.detail, /超过 45 日容差/);
    assert.equal(noBar.flow.label, null);
    assert.equal(noBar.flow.reason, 'nav_proxy_date_mismatch');
  } finally {
    mem.close();
  }
});

process.on('beforeExit', () => {
  closeAshareDb();
});
