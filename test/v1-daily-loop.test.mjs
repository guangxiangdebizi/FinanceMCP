import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// V1.0 日频闭环修复的失败先行测试。
//
// 每个用例都对应一处**真实生产缺陷**（2026-10-19 观测），而不是为了覆盖率补的：
//   1. ETF 同步没有接入 `daily`，五只持仓的 fund_daily 停在 20261016；
//   2. 全市场 fund_daily 分页可能漏掉持仓代码，且没有逐只兜底；
//   3. 账户默认值曾是字符串 'default'，不传 account_id 返回 REAL_ACCOUNT_PENDING；
//   4. 账户快照解析一律用 latestSnapshot()，查询真实账户可能拿到演示持仓；
//   5. 行情缺失被报成 NO_ACTION（读起来像“已证明继续持有最优”）；
//   6. 份额披露滞后与行情缺失被混成同一个质量状态。

const dir = mkdtempSync(join(tmpdir(), 'ashare-1019-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');
process.env.ASHARE_RESEARCH_DB_PATH = join(dir, 'research.sqlite');
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.ASHARE_TUSHARE_MAX_RETRIES = '0';
process.env.TUSHARE_TOKEN = 'test-token';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const etf = await import('../build/ashare/etf.js');
const { syncEtfForDaily, syncFundDailyCodes, fundHoldingCoverage, fundBasicRefreshDue, ETF_UNIVERSE, etfQuotes } = etf;
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const account = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount } = await import('../build/portfolio/ledger.js');
const { listConfiguredAccounts, resolveAccountId, resolveAccountSnapshot, AccountResolutionError } = await import('../build/portfolio/accounts.js');
const { decisionInputFromArgs } = await import('../build/portfolio/decisionTool.js');

const originalFetch = globalThis.fetch;
const DAYS = ['20261013', '20261014', '20261015', '20261016', '20261019'];
const PREV = '20261016';
const TARGET = '20261019';
const BASIC = ETF_UNIVERSE.map(ts_code => ({ ts_code, name: `测试${ts_code}`, market: 'E', status: 'L', fund_type: '股票型' }));
const bar = (ts_code, trade_date, close = 1) => ({
  ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, change: 0, pct_chg: 0, vol: 1000, amount: 100,
});
/** 全市场某日回答：n 只合成 ETF；可指定要“漏掉”的代码。 */
function marketDay(date, { omit = [] } = {}) {
  const rows = Array.from({ length: 2100 }, (_, i) => bar(`5${String(i).padStart(5, '0')}.SH`, date));
  return rows.filter(row => !omit.includes(row.ts_code));
}
/**
 * 离线 Tushare 桩：
 * - fund_daily 全市场分页**故意漏掉** omitFromMarket 里的代码（复现上游分页漏行）；
 * - 逐代码查询（带 ts_code）能返回（除 missingUpstream 以外）；
 * - fund_adj / fund_share / fund_basic 返回最小可用数据。
 */
function stubFetch({ omitFromMarket = [], missingUpstream = [], calls = [] } = {}) {
  globalThis.fetch = async (_url, init) => {
    const { api_name, params, fields } = JSON.parse(init.body);
    calls.push({ api: api_name, params });
    let rows;
    if (api_name === 'fund_basic') rows = BASIC;
    else if (api_name === 'fund_daily') {
      if (params.ts_code) {
        rows = missingUpstream.includes(params.ts_code) ? [] : [bar(params.ts_code, params.trade_date, 2)];
      } else {
        rows = marketDay(params.trade_date, { omit: omitFromMarket });
      }
    } else if (api_name === 'fund_adj') {
      // 区间查询：返回窗口内每个交易日的因子，避免 qfq 序列缺根。
      const inWindow = DAYS.filter(date => (!params.start_date || date >= params.start_date) && (!params.end_date || date <= params.end_date));
      rows = inWindow.map(trade_date => ({ ts_code: params.ts_code, trade_date, adj_factor: 1 }));
    } else if (api_name === 'fund_share') {
      const inWindow = DAYS.filter(date => (!params.start_date || date >= params.start_date) && (!params.end_date || date <= params.end_date));
      rows = missingUpstream.includes(params.ts_code)
        ? []
        : inWindow.map(trade_date => ({ ts_code: params.ts_code, trade_date, fd_share: 1000, fund_type: 'ETF', market: 'SZ' }));
    } else rows = [];
    const cols = fields.split(',');
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: rows.map(row => cols.map(col => row[col] ?? null)) } }) };
  };
}

function seedMarket(name = 'market.sqlite') {
  const db = openAshareDb(join(dir, name));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], DAYS.map((date, index) => ({
    cal_date: date, is_open: 1, pretrade_date: DAYS[index - 1] ?? null,
  })));
  // 上一交易日已有完整全市场快照，使“完整性基准”可用。
  upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
    marketDay(PREV));
  return db;
}

// ---------------------------------------------------------------- B. ETF 同步

test('B-1 daily 流水线必须同步 ETF：同步完成后持仓目标交易日 READY', async () => {
  const db = seedMarket('b1.sqlite');
  const calls = [];
  stubFetch({ calls });
  try {
    const summary = await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
    assert.deepEqual(summary.dates, DAYS, '最近 5 个交易日都应覆盖');
    assert.equal(summary.fund_daily[TARGET].status, 'ok', JSON.stringify(summary.fund_daily[TARGET]));
    assert.deepEqual(summary.coverage[TARGET].ready.slice().sort(), [...ETF_UNIVERSE].sort(), '五只持仓当日都必须有可校验行情');
    assert.deepEqual(summary.coverage[TARGET].missing, []);
    assert.deepEqual(summary.errors, []);
    // 逐只复权/份额覆盖持仓 + 已声明候选池。
    assert.ok(Object.keys(summary.fund_adj).length >= ETF_UNIVERSE.length);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
  // 用同一个库重新打开，验证落库结果（而不是只看返回值）。
  const reopened = openAshareDb(join(dir, 'b1.sqlite'));
  try {
    const status = etf.etfStatus(reopened, { date: TARGET });
    assert.equal(status.latest_fund_daily_date, TARGET);
    assert.equal(status.coverage.codes_with_bar_on_latest, ETF_UNIVERSE.length);
    assert.equal(status.quality.status, 'READY', JSON.stringify(status.quality.reasons));
    for (const code of ETF_UNIVERSE) {
      const quote = etfQuotes(reopened, [code], { start: PREV, end: TARGET });
      assert.equal(quote.quotes[0].tiers.price.status, 'READY', `${code} 价格层级必须 READY`);
      assert.equal(quote.quotes[0].latest_bar.trade_date, TARGET);
    }
  } finally {
    reopened.close();
  }
});

test('B-2 全市场回答漏掉持仓代码 → 逐只兜底补齐，且不删除同日其他行', async () => {
  const db = seedMarket('b2.sqlite');
  const missing = ['159241.SZ', '516080.SH'];
  const calls = [];
  stubFetch({ omitFromMarket: missing, calls });
  try {
    const summary = await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
    const coverage = summary.coverage[TARGET];
    assert.deepEqual(coverage.ready.slice().sort(), [...ETF_UNIVERSE].sort(), '兜底后五只持仓全部 READY');
    for (const code of missing) {
      assert.ok(calls.some(call => call.api === 'fund_daily' && call.params.ts_code === code && call.params.trade_date === TARGET),
        `${code} 必须发起逐只请求`);
    }
    // 全市场当日行数没有被逐只写入破坏（持仓代码是额外补上的 5 行）。
    const synthetic = db.prepare(`SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ? AND ts_code NOT IN (${ETF_UNIVERSE.map(() => '?').join(',')})`)
      .get(TARGET, ...ETF_UNIVERSE).n;
    const holdings = db.prepare(`SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ? AND ts_code IN (${ETF_UNIVERSE.map(() => '?').join(',')})`)
      .get(TARGET, ...ETF_UNIVERSE).n;
    assert.equal(synthetic, 2100, '逐只兜底不得删除或重复其他代码');
    assert.equal(holdings, ETF_UNIVERSE.length, '五只持仓各只有一行（无重复）');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B-3 上游确实没有持仓行情（停牌）→ 明确记为 no_upstream_bar，不伪造、不阻塞其他代码', async () => {
  const db = seedMarket('b3.sqlite');
  const suspended = '159278.SZ';
  stubFetch({ omitFromMarket: [suspended], missingUpstream: [suspended] });
  try {
    const summary = await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
    assert.deepEqual(summary.coverage[TARGET].no_upstream_bar, [suspended], JSON.stringify(summary.coverage[TARGET]));
    assert.ok(!summary.coverage[TARGET].ready.includes(suspended));
    assert.equal(summary.coverage[TARGET].ready.length, ETF_UNIVERSE.length - 1, '其他持仓不受影响');
    const status = etf.etfStatus(db, { date: TARGET });
    const row = status.codes.find(code => code.ts_code === suspended);
    assert.equal(row.status, 'NOT_READY', '停牌代码不能 READY');
    assert.ok(row.reasons.includes('no_bar_in_window'), `停牌原因必须显式给出：${JSON.stringify(row.reasons)}`);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B-4 幂等：重复运行同一交易日不重复请求已合法持仓，也不重复写信', async () => {
  const db = seedMarket('b4.sqlite');
  const calls = [];
  stubFetch({ calls });
  try {
    await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
    const firstWrites = db.prepare('SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ?').get(TARGET).n;
    const firstPerCode = calls.filter(call => call.api === 'fund_daily' && call.params.ts_code).length;
    calls.length = 0;
    // 不传 refreshFrom：模拟当天已经成功同步后的重跑（定时任务第二次运行同一入口）。
    const second = await syncEtfForDaily(db, TARGET);
    const secondPerCode = calls.filter(call => call.api === 'fund_daily' && call.params.ts_code).length;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ?').get(TARGET).n, firstWrites, '行数不得增长');
    assert.equal(secondPerCode, 0, `已有合法 bar 时不应逐只重复请求（第一次 ${firstPerCode} 次，第二次 ${secondPerCode} 次）`);
    assert.equal(second.coverage[TARGET].ready.length, ETF_UNIVERSE.length);
    // 全市场日线仍会按 refresh 重查一次 —— 这是有意为之（当日数据可能修订），
    // 但每只只在“缺失或非法”时才追加请求。
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B-5 ETF 同步失败不破坏已有快照，也不会抛到股票日报之外', async () => {
  const db = seedMarket('b5.sqlite');
  try {
    await promptDailyThenFail(db);
    const rows = db.prepare(`SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ? AND ts_code NOT IN (${ETF_UNIVERSE.map(() => '?').join(',')})`)
      .get(PREV, ...ETF_UNIVERSE).n;
    assert.equal(rows, 2100, '失败的上游请求不得删除上一份已确认快照');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

async function promptDailyThenFail(db) {
  // 先成功写入目标日，再让上游全部失败：已有行必须保留。
  stubFetch({});
  await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
  const before = db.prepare('SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ?').get(TARGET).n;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const summary = await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
  const after = db.prepare('SELECT COUNT(*) n FROM fund_daily WHERE trade_date = ?').get(TARGET).n;
  assert.equal(after, before, '上游失败后当日快照必须保留');
  assert.ok(summary.errors.length > 0, '失败必须显式记录在上游返回里，而不是静默');
}

test('B-6 部分数据：全市场回答偏小（低于下限/收缩）时不替换，只合并或保留', async () => {
  const db = seedMarket('b6.sqlite');
  // 目标日上游只返回 10 行（明显残缺）。
  globalThis.fetch = async (_url, init) => {
    const { api_name, params, fields } = JSON.parse(init.body);
    let rows = [];
    if (api_name === 'fund_daily' && !params.ts_code) rows = marketDay(params.trade_date).slice(0, 10);
    else if (api_name === 'fund_daily' && params.ts_code) rows = [bar(params.ts_code, params.trade_date)];
    const cols = fields.split(',');
    return { ok: true, json: async () => ({ code: 0, data: { fields: cols, items: rows.map(row => cols.map(col => row[col] ?? null)) } }) };
  };
  try {
    const summary = await syncEtfForDaily(db, TARGET, { refreshFrom: TARGET });
    assert.notEqual(summary.fund_daily[TARGET].write, 'replaced', '残缺回答不得整日替换');
    // 持仓可以由逐只兜底补齐，但状态必须如实说明上游残缺。
    assert.ok(summary.coverage[TARGET].ready.length > 0);
    assert.ok(summary.fund_daily[TARGET].status !== 'ok' || summary.errors.length > 0,
      '残缺的全市场回答必须有可审计状态');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('B-7 fund_basic 不无条件每天全量重拉：7 天内且五只齐全时跳过', async () => {
  const db = openAshareDb(join(dir, 'b7.sqlite'));
  try {
    upsertRows(db, 'fund_basic', ['ts_code', 'name', 'market', 'status'], BASIC);
    db.prepare(`INSERT OR REPLACE INTO fund_sync_log (dataset, key, rows, status, message, synced_at) VALUES ('fund_basic','market=E',?,?,?,?)`)
      .run(BASIC.length, 'ok', '', new Date().toISOString());
    assert.equal(fundBasicRefreshDue(db), false, '刚同步过且五只齐全时不应重拉');
    assert.equal(fundBasicRefreshDue(db, Date.now() + 8 * 86400_000), true, '超过刷新间隔后必须重拉');
    // 权限受限是暂时的：即使刚同步过也要重试。
    db.prepare(`INSERT OR REPLACE INTO fund_sync_log (dataset, key, rows, status, message, synced_at) VALUES ('fund_basic','market=E',0,'permission_denied','积分不足',?)`)
      .run(new Date().toISOString());
    assert.equal(fundBasicRefreshDue(db), true);
    // 缺一只持仓时也必须重拉。
    db.prepare('DELETE FROM fund_basic WHERE ts_code = ?').run(ETF_UNIVERSE[0]);
    assert.equal(fundBasicRefreshDue(db), true);
  } finally {
    db.close();
  }
});

test('B-8 份额滞后只降 flow 层级，不把有效日线判为不可估值', () => {
  const db = openAshareDb(join(dir, 'b8.sqlite'));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open'], DAYS.map(date => ({ cal_date: date, is_open: 1 })));
  const code = ETF_UNIVERSE[0];
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'market', 'status'], [{ ts_code: code, name: '测试', market: 'E', status: 'L' }]);
  upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], [bar(code, PREV), bar(code, TARGET)]);
  // 份额只披露到上一交易日。
  upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], [
    { ts_code: code, trade_date: '20261015', fd_share: 1000, fund_type: 'ETF', market: 'SZ' },
    { ts_code: code, trade_date: PREV, fd_share: 1010, fund_type: 'ETF', market: 'SZ' },
  ]);
  upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [bar(code, PREV) && { ts_code: code, trade_date: PREV, adj_factor: 1 }]);
  try {
    const quote = etfQuotes(db, [code], { start: '20261013', end: TARGET }).quotes[0];
    assert.equal(quote.tiers.price.status, 'READY', '有当天合法收盘即价格 READY');
    assert.equal(quote.tiers.flow.status, 'LAGGED', JSON.stringify(quote.tiers.flow));
    assert.equal(quote.tiers.flow.latest_share_date, PREV);
    assert.ok(quote.tiers.flow.lag_days >= 1);
    assert.ok(quote.executable_price_cny !== null, '份额滞后不得夺走可执行参考价');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- C. 账户身份

function seedAccountDb(name, accountId = 'real-main') {
  const path = join(dir, name);
  const db = openPortfolioDb(path, { marketPath: join(dir, 'unrelated-market.sqlite') });
  account.importSnapshot(db, { ...account.DEMO_SNAPSHOT, snapshot_id: 'user-confirmed-eod-2026-10-16', as_of: PREV, source: 'test' });
  initBaseline(db, accountId, { asOf: PREV, snapshotId: 'user-confirmed-eod-2026-10-16' });
  confirmRealAccount(db, accountId, { confirm: true, note: 'test fixture' });
  return { db, path };
}

test('C-1 省略 account_id 解析到唯一真实账户，不再落到默认字符串 default', () => {
  const { db } = seedAccountDb('c1.sqlite');
  try {
    const resolved = resolveAccountId(db, undefined);
    assert.equal(resolved.account_id, 'real-main');
    assert.equal(resolved.source, 'default');
    const explicit = resolveAccountId(db, 'real-main');
    assert.equal(explicit.account_id, 'real-main');
    assert.equal(explicit.source, 'explicit');
    assert.deepEqual(listConfiguredAccounts(db).map(row => row.account_id), ['real-main']);
  } finally {
    db.close();
  }
});

test('C-2 显式未知账户被拒绝，绝不返回其他账户的快照', () => {
  const { db } = seedAccountDb('c2.sqlite');
  try {
    assert.throws(() => resolveAccountId(db, 'someone-else'), (error) => {
      assert.ok(error instanceof AccountResolutionError);
      assert.equal(error.code, 'account_not_configured');
      return true;
    });
    const decision = decisionInputFromArgs({ action: 'hold', account_id: 'someone-else' }, db, null);
    assert.fail(`未知账户不得进入决策：${JSON.stringify(decision.account_id)}`);
  } catch (error) {
    assert.equal(error.code, 'account_not_configured');
  } finally {
    db.close();
  }
});

test('C-3 不传 account_id 与显式传入真实账户得到同一身份与同一持仓', () => {
  const { db } = seedAccountDb('c3.sqlite');
  try {
    const implicitInput = decisionInputFromArgs({ action: 'hold' }, db, null);
    const explicitInput = decisionInputFromArgs({ action: 'hold', account_id: 'real-main' }, db, null);
    assert.equal(implicitInput.account_id, 'real-main');
    assert.equal(explicitInput.account_id, 'real-main');
    assert.equal(implicitInput.snapshot.snapshot_id, explicitInput.snapshot.snapshot_id);
    assert.deepEqual(
      implicitInput.snapshot.positions.map(p => [p.ts_code, p.quantity]),
      explicitInput.snapshot.positions.map(p => [p.ts_code, p.quantity]),
    );
  } finally {
    db.close();
  }
});

test('C-4 账户快照解析不会用演示快照冒充真实账户持仓', () => {
  const { db } = seedAccountDb('c4.sqlite');
  try {
    const resolved = resolveAccountSnapshot(db, 'real-main');
    assert.equal(resolved.snapshot_id, 'user-confirmed-eod-2026-10-16');
    assert.notEqual(resolved.snapshot_id, account.DEMO_SNAPSHOT_ID);
    assert.equal(resolved.source, 'ledger_baseline');
  } finally {
    db.close();
  }
});

test('C-5 有多个已确认真实账户时必须要求显式选择，不猜', () => {
  const { db } = seedAccountDb('c5.sqlite');
  try {
    initBaseline(db, 'real-second', { asOf: PREV, snapshotId: 'user-confirmed-eod-2026-10-16' });
    confirmRealAccount(db, 'real-second', { confirm: true, note: 'test fixture' });
    assert.throws(() => resolveAccountId(db, undefined), (error) => {
      assert.equal(error.code, 'account_selection_required');
      return true;
    });
    assert.equal(resolveAccountId(db, 'real-second').account_id, 'real-second');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- D. 前瞻记录

const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { recordPlanTracking, planIdFor, planTrackingTableExists } = await import('../build/portfolio/researchRecord.js');
const { setAccountCompleteness } = await import('../build/portfolio/ledger.js');

test('D-1 前瞻记录：只写 plan_tracking，幂等，且不写任何账户事件', () => {
  const { db } = seedAccountDb('d1.sqlite');
  try {
    setAccountCompleteness(db, 'real-main', { as_of: PREV, reported_events_through: PREV, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });
    const market = seedMarket('d1-market.sqlite');
    stubFetch({});
    try {
      const report = buildDailyReport({
        portfolioDb: db, marketDb: market, accountId: 'real-main', asOfTradeDate: PREV,
        snapshotId: 'user-confirmed-eod-2026-10-16', generatedAt: '2026-10-19T13:00:00Z',
      });
      assert.equal(planTrackingTableExists(db), false, '生成日报本身不得建表（只读）');
      const first = recordPlanTracking({ portfolioDb: db, accountId: 'real-main', report });
      assert.equal(first.recorded, true);
      assert.equal(first.plan_id, planIdFor(report, 'real-main'));
      const second = recordPlanTracking({ portfolioDb: db, accountId: 'real-main', report });
      assert.equal(second.recorded, false, '同一输入重跑必须幂等');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_tracking').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 0, '研究记录不得写成真实成交');
      const row = db.prepare('SELECT * FROM plan_tracking').get();
      assert.equal(row.as_of_trade_date, PREV);
      assert.equal(row.account_id, 'real-main');
      assert.ok(JSON.parse(row.observation_triggers_json).length > 0, '必须记录观察触发条件');
      assert.ok(/模拟预案/.test(row.note) && /provisional/.test(row.note), '必须标注模拟预案与 provisional 基准');
      // 记录时间戳明确，数据日期明确（D5）。
      assert.ok(row.generated_at && row.recorded_at);
    } finally {
      market.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('D-2 数据不足日不写前瞻记录（不产生可能被误读的“当日判断”）', async () => {
  // 该判断由 run-account-daily.mjs 在 status === DATA_INSUFFICIENT 时跳过；
  // 这里用报告状态直接锁定契约。
  const { db } = seedAccountDb('d2.sqlite');
  const market = seedMarket('d2-market.sqlite');
  try {
    const report = buildDailyReport({
      portfolioDb: db, marketDb: market, accountId: 'real-main', asOfTradeDate: TARGET,
      snapshotId: 'user-confirmed-eod-2026-10-16',
    });
    assert.equal(report.status, 'DATA_INSUFFICIENT');
    assert.equal(planTrackingTableExists(db), false);
  } finally {
    market.close();
    db.close();
  }
});

// ---------------------------------------------------------------- C4. 账户口径

test('C-6 账户口径对照：数量一致、现金一致，HHI 差异只来自价格口径', async () => {
  const { db } = seedAccountDb('c6.sqlite');
  const market = seedMarket('c6-market.sqlite');
  stubFetch({});
  try {
    // 目标日行情用 2 元收盘（与快照参考价不同），触发重估差异。
    const summary = await syncEtfForDaily(market, PREV, { refreshFrom: PREV });
    assert.ok(summary.coverage[PREV].ready.length === ETF_UNIVERSE.length);
    const report = buildDailyReport({
      portfolioDb: db, marketDb: market, accountId: 'real-main', asOfTradeDate: PREV,
      snapshotId: 'user-confirmed-eod-2026-10-16',
    });
    assert.equal(report.account_view.quantity_consistent, true, '证券数量必须与快照一致');
    assert.equal(report.account_view.snapshot_basis.cash_cents, report.account_view.revalued_basis.cash_cents);
    assert.equal(report.account_view.snapshot_basis.securities_mv_cents, 7436250);
    assert.notEqual(report.account_view.snapshot_basis.securities_mv_cents, report.account_view.revalued_basis.securities_mv_cents,
      '收盘价与参考价不同时必须如实重估');
    assert.equal(report.account_view.revalued_basis.price_source, 'server_cache_close');
    assert.equal(report.account_view.snapshot_basis.hhi, 0.557087);
    assert.ok(typeof report.account_view.reconciliation.find(row => row.field === 'hhi').explanation === 'string');
    assert.match(report.account_view.note, /数量与用户确认的快照逐只一致/);
    // 可执行性仍必须被账户门控阻止（未上报交易风险）。
    assert.equal(report.actionable, false);
  } finally {
    market.close();
    globalThis.fetch = originalFetch;
    db.close();
  }
});
