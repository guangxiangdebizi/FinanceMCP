import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 工作包 A4：标的身份、权限、数据来源与预案状态门控。
//
// 每个用例都是失败先行：它们描述的是 R1 修复后的契约，在 R0 的
// portfolio/tools.ts（接受调用方 price/quote_date/status/advantage 并返回
// EXECUTABLE）上会失败。这里用临时 SQLite 缓存驱动，不访问网络，不碰生产库。

const dir = mkdtempSync(join(tmpdir(), 'ashare-portfolio-trust-'));
const MARKET = join(dir, 'ashare.sqlite');
const PORTFOLIO = join(dir, 'portfolio.sqlite');

process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = MARKET;
process.env.ASHARE_PORTFOLIO_DB_PATH = PORTFOLIO;
process.env.ASHARE_PORTFOLIO_ENABLED = '1';

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const account = await import('../build/portfolio/account.js');
const { runPortfolioTool } = await import('../build/portfolio/tools.js');
const instrument = await import('../build/portfolio/instrument.js');
const ledger = await import('../build/portfolio/ledger.js');
const evidenceStore = await import('../build/portfolio/evidence.js');
process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES = JSON.stringify([{ strategy_id: 'fixture-trust', source: 'synthetic-validation', rule_version: 'fixture-1' }]);

const { DEMO_SNAPSHOT, DEMO_SNAPSHOT_ID, accountSummary, importDemoSnapshot, importSnapshot, markSnapshotCurrent } = account;

// 交易日历：14/15/16 与 19 开市，17/18 休市。
const OPEN_DAYS = ['20261014', '20261015', '20261016', '20261019'];
const CLOSED_DAYS = ['20261017', '20261018'];
const LAST = '20261016';       // 最近的真实交易日
const NEXT = '20261019';       // 下一个交易日（本缓存里没有 bar）

const market = openAshareDb(MARKET);
upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
  [...OPEN_DAYS.map(d => ({ cal_date: d, is_open: 1, pretrade_date: OPEN_DAYS[OPEN_DAYS.indexOf(d) - 1] ?? null })),
   ...CLOSED_DAYS.map(d => ({ cal_date: d, is_open: 0, pretrade_date: LAST }))]);

// 场内 ETF（fund_basic.market='E'）。
upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'market', 'status', 'list_date'],
  [
    { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20200101' },
    { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20200101' },
    { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20200101' },
    { ts_code: '516080.SH', name: '创新药ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20200101' },
    { ts_code: '560390.SH', name: '电网设备ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20200101' },
    { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', market: 'E', status: 'L', list_date: '20120528' },
    // 场外基金：不是 ETF，不能当可交易标的。
    { ts_code: '000001.OF', name: '场外混合基金', fund_type: '混合型', market: 'O', status: 'L', list_date: '20100101' },
  ]);
upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
  [
    { ts_code: '159558.SZ', trade_date: LAST, open: 0.93, high: 0.94, low: 0.92, close: 0.935, pre_close: 0.93, vol: 1e6, amount: 9.35e5 },
    { ts_code: '510300.SH', trade_date: LAST, open: 3.98, high: 4.02, low: 3.97, close: 4.0, pre_close: 3.99, vol: 1e6, amount: 4e6 },
    { ts_code: '516080.SH', trade_date: LAST, open: 0.63, high: 0.64, low: 0.63, close: 0.636, pre_close: 0.63, vol: 1e6, amount: 6.36e5 },
  ]);

// 个股（stock_basic）。600001.SH 已退市；688981.SH 是科创板。
upsertRows(market, 'stock_basic', ['ts_code', 'symbol', 'name', 'market', 'exchange', 'list_date', 'delist_date', 'list_status'],
  [
    { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', market: '主板', exchange: 'SSE', list_date: '19991110', delist_date: null, list_status: 'L' },
    { ts_code: '601318.SH', symbol: '601318', name: '中国平安', market: '主板', exchange: 'SSE', list_date: '20070301', delist_date: null, list_status: 'L' },
    { ts_code: '600030.SH', symbol: '600030', name: '中信证券', market: '主板', exchange: 'SSE', list_date: '20030106', delist_date: null, list_status: 'L' },
    { ts_code: '600519.SH', symbol: '600519', name: '贵州茅台', market: '主板', exchange: 'SSE', list_date: '20010827', delist_date: null, list_status: 'L' },
    { ts_code: '688981.SH', symbol: '688981', name: '中芯国际', market: '科创板', exchange: 'SSE', list_date: '20200716', delist_date: null, list_status: 'L' },
    { ts_code: '600001.SH', symbol: '600001', name: '退市示例', market: '主板', exchange: 'SSE', list_date: '19980101', delist_date: '20150101', list_status: 'D' },
  ]);
upsertRows(market, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
  [
    { ts_code: '600000.SH', trade_date: LAST, open: 9.9, high: 10.1, low: 9.8, close: 10.0, pre_close: 9.9, vol: 1e6, amount: 1e7 },
    { ts_code: '601318.SH', trade_date: LAST, open: 49, high: 51, low: 48.5, close: 50.0, pre_close: 49, vol: 1e6, amount: 5e7 },
    { ts_code: '600030.SH', trade_date: LAST, open: 20, high: 21, low: 19.5, close: 20.5, pre_close: 20, vol: 1e6, amount: 2e7 },
    { ts_code: '600519.SH', trade_date: LAST, open: 1500, high: 1520, low: 1490, close: 1500, pre_close: 1500, vol: 1e4, amount: 1.5e7 },
    { ts_code: '688981.SH', trade_date: LAST, open: 49, high: 51, low: 48, close: 50.0, pre_close: 49, vol: 1e6, amount: 5e7 },
  ]);
// 600030.SH 在 LAST 当日停牌。
upsertRows(market, 'suspend_d', ['ts_code', 'trade_date', 'suspend_timing'], [
  { ts_code: '600030.SH', trade_date: LAST, suspend_timing: null },
]);
// R2：个股停牌状态必须可证——LAST 的 suspend_d 已成功同步（否则按 suspension_unknown 阻塞）。
upsertRows(market, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'], [
  { dataset: 'suspend_d', key: LAST, rows: 1, status: 'ok', message: '', synced_at: `${LAST}T00:00:00Z` },
]);
market.close();

// 账户库：演示快照（is_current=false）+ 两个明确标注为合成的"当前"快照。
const pdb = openPortfolioDb(PORTFOLIO);
importDemoSnapshot(pdb);

const ETF_CURRENT = {
  snapshot_id: 'synthetic-current-etf-2026-10-16',
  as_of: '2026-10-16',
  source: 'synthetic-test-fixture',
  note: '合成测试快照（非真实账户）；仅用于验证门控，不代表用户持仓',
  warnings: ['synthetic_test_fixture'],
  is_current: true,
  positions: [
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 58900, ref_price_milli: 935, ref_cost_milli: 1251, market_value_cents: 5507150 },
  ],
  totals: {
    total_assets_cents: 5648520, securities_mv_cents: 5507150,
    cash_cents: 141370, wealth_cents: 0, unrealized_pnl_cents: -1861709,
  },
};
const STOCK_CURRENT = {
  snapshot_id: 'synthetic-current-stock-2026-10-16',
  as_of: '2026-10-16',
  source: 'synthetic-test-fixture',
  note: '合成测试快照（非真实账户）；含主板个股，仅用于验证个股规则与门控',
  warnings: ['synthetic_test_fixture'],
  is_current: true,
  positions: [
    { ts_code: '600000.SH', name: '浦发银行', quantity: 10000, ref_price_milli: 10000, ref_cost_milli: 9000, market_value_cents: 10000000 },
  ],
  totals: {
    total_assets_cents: 15000000, securities_mv_cents: 10000000,
    cash_cents: 5000000, wealth_cents: 0, unrealized_pnl_cents: 1000000,
  },
};
importSnapshot(pdb, ETF_CURRENT, { confirmCurrent: true });
importSnapshot(pdb, STOCK_CURRENT, { confirmCurrent: true });
for (const snapshot of [ETF_CURRENT, STOCK_CURRENT]) {
  ledger.initBaseline(pdb, snapshot.snapshot_id, { asOf: LAST, snapshotId: snapshot.snapshot_id });
  ledger.confirmRealAccount(pdb, snapshot.snapshot_id, { confirm: true });
  ledger.setAccountCompleteness(pdb, snapshot.snapshot_id, { as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false }, { confirm: true, recordedBy: 'fixture' });
}
for (const [id, buy, sell] of [['TEST-EVID-1', '510300.SH', '159558.SZ'], ['TEST-EVID-STOCK', '601318.SH', '600000.SH']]) {
  evidenceStore.recordResearchEvidence(pdb, { evidence_id: id, kind: 'ROTATION', buy_code: buy, sell_code: sell,
    strategy_id: 'fixture-trust', as_of: LAST, status: 'VERIFIED', recorded_by: 'fixture',
    provenance: { source: 'synthetic-validation', rule_version: 'fixture-1', claim: '合成测试证据', validation_run_id: 'fixture-run', observation_type: 'WALK_FORWARD_VALIDATION' },
  }, { confirm: true });
}
pdb.close();

/** 只有一个快照可以是当前账户；每个用例显式指定它需要的那个。 */
function setCurrent(snapshotId) {
  const db = openPortfolioDb(PORTFOLIO);
  try {
    markSnapshotCurrent(db, snapshotId, { confirmedBy: 'test-fixture' });
  } finally {
    db.close();
  }
}
setCurrent(ETF_CURRENT.snapshot_id);

const ETF_SUMMARY = accountSummary(ETF_CURRENT);
const STOCK_SUMMARY = accountSummary(STOCK_CURRENT);

const call = async (args) => JSON.parse((await runPortfolioTool('ashare_portfolio_scenario', { account_id: args.snapshot_id === DEMO_SNAPSHOT_ID ? DEMO_SNAPSHOT_ID : args.snapshot_id ?? ETF_CURRENT.snapshot_id, ...args })).content[0].text);
const VERIFIED = { evidence_source: 'RESEARCH_VERIFIED', evidence_id: 'TEST-EVID-1', advantage: true, advantage_basis: '合成测试证据' };
/** 指定快照为当前账户后再调用工具：is_current 是行上的字段，读快照时才可见。 */
const callAs = async (snapshotId, args) => {
  setCurrent(snapshotId);
  return call({ snapshot_id: snapshotId, ...args });
};
const callAsEtf = (args) => callAs(ETF_CURRENT.snapshot_id, args);
const callAsStock = (args) => callAs(STOCK_CURRENT.snapshot_id, args);

// ---------------------------------------------------------------- 1. 声明伪装
test('A4-1. buy_kind=etf 伪装 688981.SH → NOT_EXECUTABLE，且不带可下单的买卖腿', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '688981.SH',
    buy_kind: 'etf', as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  const codes = s.reasons.map(r => r.code);
  assert.ok(codes.includes('instrument_claim_mismatch') || codes.includes('permission_restricted'), JSON.stringify(codes));
  // 没有 priced leg：两腿价格/数量都归零，计算值只在 illustrative。
  assert.equal(s.trade.buy.price_milli, null);
  assert.equal(s.trade.buy.lots, 0);
  assert.equal(s.trade.sell.price_milli, null);
  assert.equal(s.trade.sell.quantity, 0);
  assert.equal(s.after, null);
});

test('A4-1b. 即使不声明 buy_kind，688981.SH 仍按科创板个股拒绝', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '688981.SH',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => r.code === 'permission_restricted'), JSON.stringify(s.reasons));
});

test('A4-1c. buy_board=main 不能绕过板块限制', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '688981.SH',
    buy_kind: 'stock', buy_board: 'main', as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE');
  assert.ok(s.reasons.some(r => ['permission_restricted', 'instrument_claim_mismatch'].includes(r.code)), JSON.stringify(s.reasons));
});

// ---------------------------------------------------------------- 2. 未知代码
test('A4-2. 未知代码 → NOT_EXECUTABLE instrument_unknown', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '999999.SZ',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'instrument_unknown'), JSON.stringify(s.reasons));
  assert.equal(s.trade.buy.lots, 0);
  assert.equal(s.trade.buy.price_milli, null);
});

test('A4-2b. 场外基金（market=O）不是 ETF，按未知处理', () => {
  const r = instrument.resolveInstrument(openAshareDb(MARKET), '000001.OF');
  assert.equal(r.found, false);
  assert.equal(r.kind, 'UNKNOWN');
});

// ---------------------------------------------------------------- 3. 伪造上市状态
test('A4-3. 伪造 buy_list_status=L 的退市个股 → 解析结果为准，NOT_EXECUTABLE', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600001.SH',
    buy_kind: 'stock', buy_list_status: 'L', as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'instrument_not_tradable'), JSON.stringify(s.reasons));
  assert.equal(s.trade.buy.lots, 0);
});

// ---------------------------------------------------------------- 4. 调用方报价
test('A4-4. research 模式的调用方报价 → ILLUSTRATIVE，绝不 EXECUTABLE', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    mode: 'research', sell_price: 0.935, buy_price: 4.0, as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'ILLUSTRATIVE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'caller_supplied_quote'), JSON.stringify(s.reasons));
  assert.equal(s.quotes.source, 'caller_supplied');
  assert.equal(s.trade.buy.price_milli, null);
  assert.ok(s.trade.illustrative, '计算值应放在 illustrative');
  assert.equal(s.trade.illustrative.executable, false);
});

test('A4-4b. 伪造未来 quote_date → 永不 EXECUTABLE', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    mode: 'research', sell_price: 0.935, buy_price: 4.0, quote_date: '20270101',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.notEqual(s.status, 'EXECUTABLE');
  assert.ok(['NOT_EXECUTABLE', 'DATA_INSUFFICIENT', 'ILLUSTRATIVE'].includes(s.status), s.status);
});

test('A4-4c. server 模式下调用方价格被忽略，价格来自缓存', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    sell_price: 999, buy_price: 999, as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.caller_prices_ignored, true);
  assert.equal(s.quotes.source, 'market_cache');
  assert.equal(s.quotes.per_code['510300.SH'], 'market_cache');
  assert.equal(s.status, 'EXECUTABLE', JSON.stringify(s.reasons));
  assert.equal(s.trade.buy.price_milli, 4000, '价格必须来自缓存（4.000 元），而不是调用方的 999');
});

// ---------------------------------------------------------------- 5. 账户时效
test('A4-5. 演示快照（is_current=false）+ 合法 ETF + 已验证证据 → ILLUSTRATIVE account_not_current', async () => {
  const s = await call({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    snapshot_id: DEMO_SNAPSHOT_ID, as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'ILLUSTRATIVE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'account_not_current'), JSON.stringify(s.reasons));
  assert.equal(s.account.is_current, false);
  assert.equal(s.trade.buy.lots, 0);
  assert.equal(s.trade.sell.quantity, 0);
});

// ---------------------------------------------------------------- 6. 非交易日
test('A4-6. 非交易日 as_of → DATA_INSUFFICIENT 或 NOT_EXECUTABLE', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    as_of_trade_date: '20261018', ...VERIFIED,
  });
  assert.ok(['DATA_INSUFFICIENT', 'NOT_EXECUTABLE'].includes(s.status), JSON.stringify(s.reasons));
  assert.notEqual(s.status, 'EXECUTABLE');
});

// ---------------------------------------------------------------- 7. 过期 bar
test('A4-7. 过期 bar（as_of 是交易日但没有当日行情）→ NOT_EXECUTABLE quote_missing', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    as_of_trade_date: NEXT, ...VERIFIED,
  });
  // R2 收紧：bar 日期必须等于预期最近交易日；旧行为把旧 bar 标成 STALE 并继续计算，
  // 新契约下没有当日 bar 就不可取价（ETF 尤其如此），因此是 quote_missing 而不是 quote_stale。
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'quote_missing'), JSON.stringify(s.reasons));
  assert.deepEqual(s.quotes.missing_codes.sort(), ['159558.SZ', '510300.SH']);
  for (const code of ['159558.SZ', '510300.SH']) {
    const q = s.server_quotes.find(x => x.ts_code === code);
    assert.equal(q.quality, 'NOT_READY', code);
    assert.ok(q.reasons.includes('bar_not_latest_trade_day'), JSON.stringify(q.reasons));
  }
});

// ---------------------------------------------------------------- 8. 停牌个股
test('A4-8. 停牌个股 → NOT_EXECUTABLE', async () => {
  const s = await callAsStock({
    action: 'sell-buy', sell_code: '600000.SH', sell_shares: 1000, buy_code: '600030.SH',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  // 停牌是“行情不可取”而非“旧价可算”：服务器报价明确记录 suspended_on_as_of。
  const q = s.server_quotes.find(x => x.ts_code === '600030.SH');
  assert.equal(q.quality, 'NOT_READY');
  assert.ok(q.reasons.includes('suspended_on_as_of'), JSON.stringify(q.reasons));
  assert.ok(s.reasons.some(r => ['quote_missing', 'instrument_not_tradable'].includes(r.code)), JSON.stringify(s.reasons));
});

// ---------------------------------------------------------------- 9. 资金不足
test('A4-9. 资金不足一手 → NOT_EXECUTABLE insufficient_cash_for_one_lot', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 100, buy_code: '600519.SH',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'NOT_EXECUTABLE', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'insufficient_cash_for_one_lot'), JSON.stringify(s.reasons));
  assert.equal(s.trade.buy.lots, 0);
});

// ---------------------------------------------------------------- 10. 假优势
test('A4-10. advantage=true 但没有 RESEARCH_VERIFIED/evidence_id → NO_ACTION 或 ILLUSTRATIVE', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    advantage: true, advantage_basis: '仅凭布尔值声明', as_of_trade_date: LAST,
  });
  assert.notEqual(s.status, 'EXECUTABLE');
  assert.ok(['NO_ACTION', 'ILLUSTRATIVE'].includes(s.status), JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => ['evidence_unverified', 'no_demonstrated_advantage'].includes(r.code)), JSON.stringify(s.reasons));
  assert.equal(s.evidence.verified, false);
});

test('A4-10b. 缺证据 → NO_ACTION no_demonstrated_advantage', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    as_of_trade_date: LAST,
  });
  assert.equal(s.status, 'NO_ACTION', JSON.stringify(s.reasons));
  assert.ok(s.reasons.some(r => r.code === 'no_demonstrated_advantage'));
});

// ---------------------------------------------------------------- 11. 正向：ETF
test('A4-11. 当前账户 + 服务端缓存行情 + 已验证证据 + ETF → EXECUTABLE，价格来自缓存', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.status, 'EXECUTABLE', JSON.stringify(s.reasons));
  assert.equal(s.quotes.server_cache, true);
  assert.equal(s.quotes.source, 'market_cache');
  assert.equal(s.trade.buy.price_milli, 4000);
  assert.equal(s.trade.sell.price_milli, 935);
  assert.equal(s.trade.buy.lots, 26);
  assert.equal(s.trade.execution_price_is_reference, true);
  assert.equal(s.t_plus_one, false, 'ETF 情景不套用个股 T+1 假设');
  assert.ok(s.warnings.includes('execution_price_is_reference'));
});

// ---------------------------------------------------------------- 12. 正向：主板个股
test('A4-12. 主板个股买入（股票规则）→ EXECUTABLE，卖出含印花税且 t_plus_one=true', async () => {
  const s = await callAsStock({
    action: 'sell-buy', sell_code: '600000.SH', sell_shares: 10000, buy_code: '601318.SH',
    as_of_trade_date: LAST, ...VERIFIED, evidence_id: 'TEST-EVID-STOCK',
  });
  assert.equal(s.status, 'EXECUTABLE', JSON.stringify(s.reasons));
  assert.equal(s.t_plus_one, true);
  assert.equal(s.rules.stock.assumed, true);
  assert.equal(s.rules.stock.t_plus_one, true);
  assert.equal(s.rules.stock.values.fees.stamp_duty_rate, 0.0005);
  assert.equal(s.rules.stock.values.fees.transfer_fee_rate, 0.00001);
  assert.equal(s.trade.buy.lot_size, 100);
  // 卖出 10,000 股 × 10.00 元 = 100,000 元 = 10,000,000 分；印花税 0.0005 → 5,000 分。
  assert.equal(s.trade.sell.gross_cents, 10000000);
  assert.equal(s.trade.sell.fees.stamp_duty_cents, 5000);
  assert.ok(s.trade.sell.fees.transfer_fee_cents > 0, '个股卖出应有过户费假设');
  // 买入 601318.SH @50 元：100 股一手 = 5,000 元。
  assert.equal(s.trade.buy.price_milli, 50000);
  assert.ok(s.trade.buy.quantity % 100 === 0, '买入股数必须是整手');
});

test('A4-12b. ETF 情景不套用个股印花税/过户费', async () => {
  const s = await callAsEtf({
    action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH',
    as_of_trade_date: LAST, ...VERIFIED,
  });
  assert.equal(s.trade.sell.fees.stamp_duty_cents, 0);
  assert.equal(s.trade.sell.fees.transfer_fee_cents, 0);
});

test('private scenario verifies stored provenance and ignores client attempts to disable strict checks', async () => {
  const args = { action: 'sell-buy', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', as_of_trade_date: LAST, ...VERIFIED };
  for (const patch of [{ evidence_id: 'made-up' }, { advantage_basis: 'different claim' }, { strict: false, trusted_evidence_policy: { requireProvenance: false }, evidence_id: 'made-up' }]) {
    const result = await callAsEtf({ ...args, ...patch });
    assert.notEqual(result.status, 'EXECUTABLE');
    assert.equal(result.evidence.verified, false);
    assert.equal(result.trade.sell.quantity, 0);
  }
  const original = process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES;
  try {
    process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES = JSON.stringify([{ strategy_id: 'fixture-trust', source: 'wrong-source', rule_version: 'fixture-1' }]);
    assert.equal((await callAsEtf(args)).evidence.verified, false);
    process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES = JSON.stringify([{ strategy_id: 'fixture-trust', source: 'synthetic-validation', rule_version: 'wrong-version' }]);
    assert.equal((await callAsEtf(args)).evidence.verified, false);
  } finally { process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES = original; }
});

test('private decision tool binds source, strategy, rule version and concrete claim on real calls', async () => {
  setCurrent(ETF_CURRENT.snapshot_id);
  const { runDecisionTool } = await import('../build/portfolio/decisionTool.js');
  const invoke = async patch => JSON.parse((await runDecisionTool({ account_id: ETF_CURRENT.snapshot_id, action: 'sell-buy',
    sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', as_of_trade_date: LAST,
    advantage_source: 'RESEARCH_VERIFIED', advantage_claim: '合成测试证据', advantage_evidence_id: 'TEST-EVID-1', ...patch,
  })).content[0].text);
  const good = await invoke({});
  assert.equal(good.evidence.verified, true);
  assert.equal(good.status, 'ACTIONABLE', JSON.stringify(good.reasons));
  for (const patch of [{ advantage_claim: 'different claim' }, { advantage_evidence_id: 'made-up' },
    { strict: false, trusted_evidence_policy: { strategies: [] }, advantage_claim: 'different claim' }]) {
    const result = await invoke(patch);
    assert.equal(result.evidence.verified, false);
    assert.notEqual(result.status, 'ACTIONABLE');
    assert.deepEqual(result.options.find(option => option.action === 'SELL_AND_BUY').legs, []);
  }
  const original = process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES;
  try {
    delete process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES;
    assert.equal((await invoke({})).evidence.verified, false, 'unregistered strategies fail closed');
  } finally { process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES = original; }
});

// ---------------------------------------------------------------- 13. 隐私门控
test('A4-13. ASHARE_PORTFOLIO_ENABLED 未设置时账户工具被拒绝', async () => {
  delete process.env.ASHARE_PORTFOLIO_ENABLED;
  const res = await runPortfolioTool('ashare_portfolio_scenario', { action: 'hold' });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.refused, true);
  assert.equal(body.reason, 'portfolio_tools_disabled');
  process.env.ASHARE_PORTFOLIO_ENABLED = '1';
});

// ---------------------------------------------------------------- 身份解析单元
test('A4-14. resolveInstrument：ETF / STOCK / 两表都有按 STOCK / 未知', () => {
  const db = openAshareDb(MARKET);
  assert.equal(instrument.resolveInstrument(db, '159558.SZ').kind, 'ETF');
  assert.equal(instrument.resolveInstrument(db, '600000.SH').kind, 'STOCK');
  assert.equal(instrument.resolveInstrument(db, '688981.SH').board, '688');
  assert.equal(instrument.resolveInstrument(db, '600001.SH').list_status, 'D');
  const unknown = instrument.resolveInstrument(db, '123456.SZ');
  assert.equal(unknown.found, false);
  assert.equal(unknown.kind, 'UNKNOWN');
  db.close();
});
