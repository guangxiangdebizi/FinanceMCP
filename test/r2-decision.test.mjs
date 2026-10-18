import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// R2 工作包 A1/A2 的失败先行用例。全部离线、确定性：临时市场缓存 + 临时账户库。
// 账户是显式标注的合成 fixture；正向用例通过 initBaseline + confirmRealAccount
// 的受控测试注入获得 VERIFIED 门控，生产工具没有匿名自认批准的通道。
const dir = mkdtempSync(join(tmpdir(), 'ashare-r2-decision-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');
const account = await import('../build/portfolio/account.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const ledger = await import('../build/portfolio/ledger.js');
const decision = await import('../build/portfolio/decision.js');
const evidence = await import('../build/portfolio/evidence.js');
const instrument = await import('../build/portfolio/instrument.js');

const { DEMO_SNAPSHOT, accountSummary, importSnapshot, markSnapshotCurrent, readSnapshot } = account;
const { buildDecision, classifyAssetClass } = decision;

const DATES = weekdays('20261005', 10);
const LAST = DATES.at(-1);      // 20261016
const PREV = DATES.at(-2);      // 20261015
const NEXT = '20261019';        // 日历里的下一个开市日（本缓存没有 bar）

// ---------------------------------------------------------------- 市场缓存

const market = openAshareDb();
upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
  [...DATES.map(d => ({ cal_date: d, is_open: 1, pretrade_date: PREV })),
   { cal_date: NEXT, is_open: 1, pretrade_date: LAST }]);

const ETF_BASIC = [
  { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '航空航天指数', status: 'L' },
  { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '机器人指数', status: 'L' },
  { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备指数', status: 'L' },
  { ts_code: '516080.SH', name: '创新药ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '创新药指数', status: 'L' },
  // 真实名称：名称与基准都含“恒生A股”，但仍应是国内权益，不是跨境。
  { ts_code: '560390.SH', name: '易方达恒生A股电网设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '恒生A股电网设备指数', status: 'L' },
  { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L' },
  { ts_code: '513100.SH', name: '纳指ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '纳斯达克100指数', status: 'L' },
  { ts_code: '159920.SZ', name: '恒生ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '恒生指数', status: 'L' },
  { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '上证5年期国债指数', status: 'L' },
  { ts_code: '518880.SH', name: '黄金ETF', fund_type: '商品型', invest_type: '被动指数型', benchmark: '上海黄金交易所Au99.99', status: 'L' },
  // 只有收盘价：open/high/low 缺失。
  { ts_code: '159999.SZ', name: '仅收盘价ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L' },
  // 上市状态未知。
  { ts_code: '159888.SZ', name: '状态未知ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: null },
  // 同时出现在 fund_basic 与 stock_basic：必须按 STOCK（fail closed）。
  { ts_code: '688981.SH', name: '中芯国际', fund_type: '股票型', invest_type: '被动指数型', benchmark: '芯片指数', status: 'L', market: 'E' },
];
upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
  ETF_BASIC.map(e => ({ ...e, market: e.market ?? 'E' })));

const CLOSE = {
  '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935, '516080.SH': 0.636, '560390.SH': 0.742,
  '510300.SH': 4.0, '513100.SH': 1.5, '159920.SZ': 2.0, '511010.SH': 100.0, '518880.SH': 5.0, '159888.SZ': 1.0,
};
for (const [code, close] of Object.entries(CLOSE)) {
  upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
    DATES.map(d => ({ ts_code: code, trade_date: d, open: close, high: close, low: close, close, pre_close: close, vol: 1000, amount: 100 })));
}
// 只有 close 的 bar：open/high/low 为 null，必须阻塞。
upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
  DATES.map(d => ({ ts_code: '159999.SZ', trade_date: d, open: null, high: null, low: null, close: 1.0, pre_close: null, vol: null, amount: null })));

upsertRows(market, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'], [
  { ts_code: '688981.SH', symbol: '688981', name: '中芯国际', list_date: '20200716', list_status: 'L' },
  { ts_code: '600519.SH', symbol: '600519', name: '合成主板股票', list_date: '20010827', list_status: 'L' },
]);
upsertRows(market, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], [
  ...DATES.map(d => ({ ts_code: '688981.SH', trade_date: d, open: 50, high: 51, low: 49, close: 50, pre_close: 50, vol: 1000, amount: 1000 })),
  ...DATES.map(d => ({ ts_code: '600519.SH', trade_date: d, open: 9.9, high: 10.1, low: 9.8, close: 10, pre_close: 10, vol: 1000, amount: 1000 })),
]);
// 停牌状态可证：每个交易日的 suspend_d 同步都成功。
upsertRows(market, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'],
  DATES.map(d => ({ dataset: 'suspend_d', key: d, rows: 0, status: 'ok', message: '', synced_at: `${LAST}T00:00:00Z` })));

// ---------------------------------------------------------------- 账户库（受控 test-only 注入）

const portfolio = openPortfolioDb();
const CURRENT_SNAPSHOT = {
  ...DEMO_SNAPSHOT,
  snapshot_id: 'r2-current',
  as_of: '2026-10-16',
  source: 'synthetic-test-fixture',
  note: 'R2 合成测试账户（不是真实账户）',
  warnings: ['synthetic_test_fixture'],
  is_current: true,
};
importSnapshot(portfolio, CURRENT_SNAPSHOT, { confirmCurrent: true });
const STALE_SNAPSHOT = {
  ...CURRENT_SNAPSHOT,
  snapshot_id: 'r2-stale',
  as_of: '2026-10-15',
  is_current: false,
};
importSnapshot(portfolio, STALE_SNAPSHOT);
// 持有主板个股的快照，用于验证轮动卖出个股时的个股费用/整手/T+1（测试内临时设为当前）。
const STOCK_HOLD_SNAPSHOT = {
  ...CURRENT_SNAPSHOT,
  snapshot_id: 'r2-stock-hold',
  is_current: false,
  positions: [
    { ts_code: '600519.SH', name: '合成主板股票', quantity: 10000, ref_price_milli: 10000, ref_cost_milli: 9000, market_value_cents: 10000000 },
  ],
  totals: { total_assets_cents: 15000000, securities_mv_cents: 10000000, cash_cents: 5000000, wealth_cents: 0, unrealized_pnl_cents: 1000000 },
};
importSnapshot(portfolio, STOCK_HOLD_SNAPSHOT);

/** 受控正例：显式测试账户 + 基线 + 用户确认，才可能得到 ACTIONABLE。 */
ledger.initBaseline(portfolio, 'r2-account', { asOf: LAST, snapshotId: 'r2-current', note: 'test fixture' });
ledger.confirmRealAccount(portfolio, 'r2-account', { confirm: true, note: 'r2 test fixture' });
ledger.initBaseline(portfolio, 'r2-pending', { asOf: LAST, snapshotId: 'r2-current', note: 'test fixture, gate left PENDING' });
ledger.initBaseline(portfolio, 'r2-stale', { asOf: PREV, snapshotId: 'r2-stale', note: 'test fixture' });
ledger.confirmRealAccount(portfolio, 'r2-stale', { confirm: true, note: 'r2 test fixture' });
ledger.initBaseline(portfolio, 'r2-stock-hold', { asOf: LAST, snapshotId: 'r2-stock-hold', note: 'test fixture' });
ledger.confirmRealAccount(portfolio, 'r2-stock-hold', { confirm: true, note: 'r2 test fixture' });
// 有未交收卖出的账户：现金口径有歧义，不能给出可执行方案。
ledger.initBaseline(portfolio, 'r2-settle', { asOf: LAST, cashCents: 1_000_000, note: 'test fixture' });
ledger.confirmRealAccount(portfolio, 'r2-settle', { confirm: true, note: 'r2 test fixture' });
ledger.recordEvent(portfolio, {
  event_id: 'r2-settle-buy', account_id: 'r2-settle', event_type: 'TRADE_BUY',
  occurred_on: LAST, ts_code: '600519.SH', quantity: 100, price_milli: 10000, fee_cents: 0, source: 'broker_statement',
});
ledger.recordEvent(portfolio, {
  event_id: 'r2-settle-sell', account_id: 'r2-settle', event_type: 'TRADE_SELL',
  occurred_on: LAST, ts_code: '600519.SH', quantity: 100, price_milli: 10000, fee_cents: 0, source: 'broker_statement',
});

const current = accountSummary(readSnapshot(portfolio, 'r2-current'));
const staleSummary = accountSummary({ ...readSnapshot(portfolio, 'r2-stale'), is_current: true });
const stockHoldSummary = accountSummary({ ...readSnapshot(portfolio, 'r2-stock-hold'), is_current: true });

// ---------------------------------------------------------------- 研究证据（唯一写路径 + 显式确认）

const record = (rec) => evidence.recordResearchEvidence(portfolio, rec, { confirm: true });
const RECORDS = [
  { evidence_id: 'EV-ROTATION', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '受控测试证据' },
  { evidence_id: 'EV-REVOKED', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'REVOKED', recorded_by: 'test-fixture', note: '已撤回' },
  { evidence_id: 'EV-EXPIRED', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: PREV, valid_until: PREV, status: 'VERIFIED', recorded_by: 'test-fixture', note: '已过期' },
  { evidence_id: 'EV-FUTURE', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: NEXT, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '尚未生效' },
  { evidence_id: 'EV-CODEMISMATCH', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '516080.SH', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '卖出标的对不上' },
  { evidence_id: 'EV-PENDING', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'PENDING', recorded_by: 'test-fixture', note: '待复核' },
  { evidence_id: 'EV-688', kind: 'ENTRY', buy_code: '688981.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '科创板研究记录' },
  { evidence_id: 'EV-CLOSEONLY', kind: 'ENTRY', buy_code: '159999.SZ', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '只有收盘价' },
  { evidence_id: 'EV-UNKNOWNSTATUS', kind: 'ENTRY', buy_code: '159888.SZ', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '上市状态未知' },
  { evidence_id: 'EV-600519', kind: 'ENTRY', buy_code: '600519.SH', sell_code: '159558.SZ', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '主板个股' },
  { evidence_id: 'EV-STOCKSELL', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '600519.SH', strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED', recorded_by: 'test-fixture', note: '卖出个股轮动' },
];
for (const rec of RECORDS) record(rec);

const claim = (id, source = 'RESEARCH_VERIFIED') => ({ claim: `研究结论 ${id}`, source, evidence_id: id, as_of: LAST });

const base = (overrides = {}) => ({
  account_id: 'r2-account',
  snapshot: current,
  as_of_trade_date: LAST,
  market_db: market,
  portfolio_db: portfolio,
  ...overrides,
});
const rotation = (overrides = {}) => buildDecision(base({
  action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
  evidence: claim('EV-ROTATION'),
  ...overrides,
}));
const rotateOf = d => d.options.find(o => o.action === 'SELL_AND_BUY');

// ---------------------------------------------------------------- 1. 证据必须是可验证的持久记录

test('R2-1. 随机 evidence_id 自称 RESEARCH_VERIFIED → 未验证，不是 ACTIONABLE', () => {
  const d = rotation({ evidence: claim('EV-NOT-STORED') });
  assert.equal(d.evidence.verified, false);
  assert.equal(d.evidence.reason, 'evidence_not_found');
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.equal(rotateOf(d).executable, false);
});

test('R2-2. 真实 VERIFIED 记录 + 匹配代码/日期 → verified', () => {
  const d = rotation();
  assert.equal(d.evidence.verified, true, JSON.stringify(d.evidence));
  assert.equal(d.evidence.evidence_id, 'EV-ROTATION');
  assert.equal(d.evidence.strategy_id, 'r2-test');
});

test('R2-3. 撤回/过期/代码不符/尚未生效/待复核 → 各自的具体原因', () => {
  const verify = (id) => evidence.verifyResearchEvidence(portfolio, { evidence_id: id }, {
    buyCode: '510300.SH', sellCode: '159558.SZ', asOf: LAST,
  });
  assert.equal(verify('EV-MISSING').reason, 'evidence_not_found');
  assert.equal(verify('EV-REVOKED').reason, 'evidence_revoked');
  assert.equal(verify('EV-EXPIRED').reason, 'evidence_expired');
  assert.equal(verify('EV-CODEMISMATCH').reason, 'evidence_code_mismatch');
  assert.equal(verify('EV-FUTURE').reason, 'evidence_not_yet_valid');
  assert.equal(verify('EV-PENDING').reason, 'evidence_status_not_verified');
  for (const id of ['EV-MISSING', 'EV-REVOKED', 'EV-EXPIRED', 'EV-CODEMISMATCH', 'EV-FUTURE', 'EV-PENDING']) {
    assert.equal(verify(id).verified, false, id);
  }
  const d = rotation({ evidence: claim('EV-REVOKED') });
  assert.equal(d.evidence.verified, false);
  assert.notEqual(d.status, 'ACTIONABLE');
});

// ---------------------------------------------------------------- 2. 身份与权限来自服务端缓存

test('R2-4. 688981.SH 声明 buy_kind=etf → 权限受限或声明不符，永不 ACTIONABLE', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '688981.SH', buy_kind: 'ETF' },
    evidence: claim('EV-688'),
  }));
  assert.notEqual(d.status, 'ACTIONABLE');
  const codes = d.reasons.map(r => r.code).concat(rotateOf(d).reasons.map(r => r.code));
  assert.ok(codes.includes('permission_restricted') || codes.includes('instrument_claim_mismatch'), JSON.stringify(codes));
  assert.deepEqual(rotateOf(d).legs, []);
});

test('R2-5. 同时出现在 fund_basic 与 stock_basic → 按 STOCK（fail closed）', () => {
  const r = instrument.resolveInstrument(market, '688981.SH');
  assert.equal(r.kind, 'STOCK');
  assert.equal(r.source, 'stock_basic');
  assert.match(r.detail, /同时在 fund_basic 中/);
});

// ---------------------------------------------------------------- 3. 统一 bar / 质量检查

test('R2-6. 只有收盘价、缺少 open/high/low → 行情不可用（ohlc_missing）', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '159999.SZ', buy_kind: 'ETF' },
    evidence: claim('EV-CLOSEONLY'),
  }));
  const q = d.quotes.entries.find(x => x.ts_code === '159999.SZ');
  assert.equal(q.available, false);
  assert.equal(q.reason, 'ohlc_missing');
  assert.equal('price_milli' in q, false);
  const rotate = rotateOf(d);
  assert.equal(rotate.status, 'DATA_INSUFFICIENT');
  assert.equal(rotate.executable, false);
  assert.deepEqual(rotate.legs, []);
});

test('R2-7. 上市状态未知 → 行情不可用（list_status_unknown）', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '159888.SZ', buy_kind: 'ETF' },
    evidence: claim('EV-UNKNOWNSTATUS'),
  }));
  const q = d.quotes.entries.find(x => x.ts_code === '159888.SZ');
  assert.equal(q.available, false);
  assert.equal(q.reason, 'list_status_unknown');
  assert.equal(rotateOf(d).executable, false);
});

test('R2-8. as_of 不在交易日历 → DATA_INSUFFICIENT', () => {
  const d = rotation({ as_of_trade_date: '20261017' });
  assert.equal(d.status, 'DATA_INSUFFICIENT');
  assert.ok(d.reasons.some(r => r.code === 'as_of_not_trading_day'), JSON.stringify(d.reasons));
  assert.equal(rotateOf(d).executable, false);
});

// ---------------------------------------------------------------- 4. 账户状态统一门控

test('R2-9. 快照 is_current=true 但账本 gate PENDING → 不可执行', () => {
  const d = rotation({ account_id: 'r2-pending' });
  assert.equal(d.snapshot_is_current, true);
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.ok(d.reasons.some(r => r.code === 'account_not_verified'), JSON.stringify(d.reasons));
  assert.equal(rotateOf(d).executable, false);
});

test('R2-10. 旧截图 + 当前行情 → 不可执行（account_snapshot_stale）', () => {
  const d = rotation({ account_id: 'r2-stale', snapshot: staleSummary });
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.ok(d.reasons.some(r => r.code === 'account_snapshot_stale'), JSON.stringify(d.reasons));
  assert.equal(rotateOf(d).executable, false);
});

test('R2-10b. 未交收卖出使现金口径有歧义 → 不可执行', () => {
  const status = decision.evaluateAccountStatus(portfolio, current, 'r2-settle', LAST);
  assert.equal(status.ok, false);
  assert.ok(status.reasons.some(r => r.code === 'account_settlement_pending'), JSON.stringify(status.reasons));
});

// ---------------------------------------------------------------- 5. 非可执行输出形状

test('R2-11. illustrative_legs 每笔 executable:false，投影标注假设', () => {
  const d = rotation({ evidence: claim('EV-ROTATION', 'UNVERIFIED') });
  const rotate = rotateOf(d);
  assert.equal(rotate.status, 'ILLUSTRATIVE');
  assert.equal(rotate.executable, false);
  assert.deepEqual(rotate.legs, []);
  assert.ok(rotate.illustrative_legs.length > 0);
  assert.ok(rotate.illustrative_legs.every(l => l.executable === false));
  assert.equal(rotate.exposure.illustrative, true);
  assert.ok(typeof rotate.exposure.basis === 'string');
  assert.match(rotate.exposure.note, /示意|非当前/);
  assert.equal(d.status, rotate.status, '主请求选项的状态是权威状态');
});

// ---------------------------------------------------------------- 6. 受控正例

test('R2-12. 受控正例：真实账户门控 + VERIFIED 证据 + 完整 bar + 开市日 → ACTIONABLE', () => {
  const status = decision.evaluateAccountStatus(portfolio, current, 'r2-account', LAST);
  assert.equal(status.ok, true, JSON.stringify(status.reasons));
  const d = rotation();
  assert.equal(d.status, 'ACTIONABLE', JSON.stringify(d.reasons));
  const rotate = rotateOf(d);
  assert.equal(rotate.executable, true);
  assert.equal(rotate.legs.length, 2);
  assert.ok(rotate.legs.every(l => l.executable === true));
  assert.deepEqual(rotate.illustrative_legs, []);
  assert.equal(d.evidence.verified, true);
});

// ---------------------------------------------------------------- 7. 资产分类（A2）

test('R2-13. 560390.SH 是国内 EQUITY；真正的跨境 ETF 仍是 CROSS_BORDER', () => {
  const fiveSixty = classifyAssetClass({ name: '易方达恒生A股电网设备ETF', fund_type: '股票型', benchmark: '恒生A股电网设备指数' });
  assert.equal(fiveSixty.asset_class, 'EQUITY', JSON.stringify(fiveSixty));
  // 即使 fund_type 缺失，仅凭名称与基准也必须判成国内权益。
  const nameOnly = classifyAssetClass({ name: '易方达恒生A股电网设备ETF', benchmark: '恒生A股电网设备指数' });
  assert.equal(nameOnly.asset_class, 'EQUITY', JSON.stringify(nameOnly));
  assert.equal(classifyAssetClass({ name: '恒生沪深港通AH精选ETF', benchmark: '恒生沪深港通AH精选指数' }).asset_class, 'EQUITY');
  assert.equal(classifyAssetClass({ name: '纳指ETF', fund_type: '股票型', benchmark: '纳斯达克100指数' }).asset_class, 'CROSS_BORDER');
  assert.equal(classifyAssetClass({ name: '恒生ETF', fund_type: '股票型', benchmark: '恒生指数' }).asset_class, 'CROSS_BORDER');
  assert.equal(classifyAssetClass({ name: '国债ETF', fund_type: '债券型', benchmark: '上证5年期国债指数' }).asset_class, 'BOND');
  assert.equal(classifyAssetClass({ name: '黄金ETF', fund_type: '商品型', benchmark: '上海黄金交易所Au99.99' }).asset_class, 'GOLD');
});

test('R2-14. 五只持仓 ETF 全部为 EQUITY，按类别压力与权益权重一致', () => {
  const d = buildDecision(base({ action: { type: 'HOLD' } }));
  const hold = d.options.find(o => o.action === 'HOLD');
  assert.deepEqual(hold.stress.unclassified_codes, []);
  const equity = hold.stress.by_asset_class.find(x => x.asset_class === 'EQUITY');
  assert.ok(equity.exposure_cents > 0);
  assert.equal(hold.exposure.by_asset_class.find(x => x.asset_class === 'CROSS_BORDER').market_value_cents, 0);
  assert.ok(hold.exposure.equity_weight > 0.9);
  // 五只 ETF 都是权益：权益压力敞口等于全部证券市值，损失等于 −10%。
  assert.equal(equity.exposure_cents, hold.exposure.securities_mv_cents);
  assert.equal(hold.stress.total_loss_cents, Math.round(hold.exposure.securities_mv_cents * -0.10));
  // 资产类别权重 + 现金 + 理财 = 1；主题/行业暴露完整，560390 归到电力设备。
  const classWeight = hold.exposure.by_asset_class.reduce((a, r) => a + r.weight, 0);
  const wealthRatio = current.totals.wealth_cents / current.totals.total_assets_cents;
  assert.ok(Math.abs(classWeight + hold.exposure.cash_ratio + wealthRatio - 1) < 1e-6);
  assert.equal(hold.exposure.theme_weight.length, 5);
  assert.ok(hold.exposure.industry_weight.some(r => r.industry === '电力设备' && r.weight > 0));
  assert.equal(hold.exposure.unclassified_industry_weight, 0);
  for (const code of ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH']) {
    const q = d.quotes.entries.find(x => x.ts_code === code);
    assert.equal(q.asset_class, 'EQUITY', code);
  }
});

// ---------------------------------------------------------------- 8. 个股风险预算与规则（A2）

test('R2-15. 失效价 >= 入场价 → invalid_invalidation，不用 abs 冒充预算', () => {
  const equal = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: claim('EV-600519'),
    stock_plan: { ts_code: '600519.SH', quantity: 1000, invalidation_milli: 10000 },
  }));
  assert.equal(equal.stock_plan.ok, false);
  assert.ok(equal.stock_plan.reasons.some(r => r.code === 'invalid_invalidation'), JSON.stringify(equal.stock_plan.reasons));
  assert.equal(equal.stock_plan.planned_risk_cents, null);
  const above = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: claim('EV-600519'),
    stock_plan: { ts_code: '600519.SH', quantity: 1000, invalidation_milli: 11000 },
  }));
  assert.equal(above.stock_plan.ok, false);
  assert.ok(above.stock_plan.reasons.some(r => r.code === 'invalid_invalidation'));
});

test('R2-16. 有效失效价 → 计划风险 = 数量 × (入场 − 失效)，且不超过净资产 0.5%', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: claim('EV-600519'),
    stock_plan: { ts_code: '600519.SH', quantity: 1000, invalidation_milli: 9900 },
  }));
  assert.equal(d.stock_plan.entry_milli, 10000);
  assert.equal(d.stock_plan.planned_risk_cents, 10000);
  assert.equal(d.stock_plan.budget_cents, Math.round(current.totals.total_assets_cents * 0.005));
  assert.ok(d.stock_plan.planned_risk_cents <= d.stock_plan.budget_cents);
  assert.equal(d.stock_plan.ok, true, JSON.stringify(d.stock_plan.reasons));
  assert.match(d.stock_plan.note, /0\.5%/);
  assert.match(d.stock_plan.note, /不保证成交/);
});

test('R2-17. 轮动买入个股时使用个股费用/整手/T+1，不套用 ETF 假设', () => {
  const d = buildDecision(base({
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '600519.SH', buy_kind: 'STOCK' },
    evidence: claim('EV-600519'),
    stock_plan: { ts_code: '600519.SH', quantity: 1000, invalidation_milli: 9900 },
  }));
  const rotate = rotateOf(d);
  const legs = rotate.legs.length ? rotate.legs : rotate.illustrative_legs;
  const buy = legs.find(l => l.side === 'BUY');
  const sell = legs.find(l => l.side === 'SELL');
  assert.equal(buy.instrument_kind, 'STOCK');
  assert.equal(buy.lot_size, 100);
  assert.equal(buy.quantity % 100, 0);
  assert.ok(buy.fees.transfer_fee_cents > 0, '个股买入应计过户费假设');
  assert.equal(sell.instrument_kind, 'ETF');
  assert.equal(sell.fees.stamp_duty_cents, 0, 'ETF 卖出不套用个股印花税');
  assert.equal(rotate.t_plus_one, true);
});

test('R2-18. 轮动卖出个股时使用个股费用（含印花税/过户费）与 T+1 标记', () => {
  // 账户库全局只有一个“当前快照”，因此本用例显式切换并在结束后恢复。
  markSnapshotCurrent(portfolio, 'r2-stock-hold', { confirmedBy: 'test-fixture' });
  try {
    const d = buildDecision(base({
      account_id: 'r2-stock-hold',
      snapshot: stockHoldSummary,
      action: { type: 'SELL_AND_BUY', sell_code: '600519.SH', sell_shares: 1000, buy_code: '510300.SH', buy_kind: 'ETF' },
      evidence: claim('EV-STOCKSELL'),
    }));
    const rotate = rotateOf(d);
    const legs = rotate.legs.length ? rotate.legs : rotate.illustrative_legs;
    const sell = legs.find(l => l.side === 'SELL');
    const buy = legs.find(l => l.side === 'BUY');
    assert.equal(sell.instrument_kind, 'STOCK');
    assert.equal(sell.t_plus_one, true);
    // 1000 股 × 10.000 元 = 10,000 元 = 1,000,000 分；印花税 0.0005 → 500 分。
    assert.equal(sell.gross_cents, 1_000_000);
    assert.equal(sell.fees.stamp_duty_cents, 500);
    assert.ok(sell.fees.transfer_fee_cents > 0, '个股卖出应计过户费假设');
    assert.equal(buy.instrument_kind, 'ETF');
    assert.equal(buy.fees.stamp_duty_cents, 0, 'ETF 买入不套用个股印花税');
    assert.equal(rotate.t_plus_one, true);
    assert.equal(d.status, 'ACTIONABLE', JSON.stringify(d.reasons));
  } finally {
    markSnapshotCurrent(portfolio, 'r2-current', { confirmedBy: 'test-fixture' });
  }
});

test.after(() => {
  portfolio.close();
  market.close();
});
