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

/** 受控正例：显式测试账户 + 基线 + 用户确认 + 完整性声明，才可能得到 ACTIONABLE。 */
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
// V1.0 新增准入：账本完整性必须由用户显式声明（缺省视为存在未上报交易风险）。
// 受控正例账户声明"已录入到 LAST、无未上报风险"；负例账户保持未声明。
for (const accountId of ['r2-account', 'r2-stock-hold']) {
  ledger.setAccountCompleteness(portfolio, accountId, {
    as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'test fixture declaration',
  }, { confirm: true, recordedBy: 'test-fixture' });
}
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

// V1.0 改变了 R2 的"旧快照一律不可执行"：状态现在可以由账本按决策日重建。
// 但旧快照本身仍然只发警告；**没有完整性声明**时依旧不可执行（保守方向）。
test('R2-10. 旧快照 + 当前行情 + 未声明完整性 → 不可执行，且 stale 以警告出现', () => {
  const status = decision.evaluateAccountStatus(portfolio, staleSummary, 'r2-stale', LAST);
  assert.equal(status.ok, false);
  assert.equal(status.state_basis, 'none');
  assert.ok(status.warnings.some(w => w.code === 'account_snapshot_stale'), JSON.stringify(status.warnings));
  assert.ok(status.reasons.some(r => r.code === 'account_completeness_undeclared'), JSON.stringify(status.reasons));
  const d = rotation({ account_id: 'r2-stale', snapshot: staleSummary });
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.equal(rotateOf(d).executable, false);
});

test('R2-10a. 旧快照 + 账本可重建 + 已声明完整性 → 经 ledger_reconstruction 可执行', () => {
  // 与 R2-10 同一账户，唯一区别是用户显式声明"已录入到 LAST、无未上报风险"。
  ledger.setAccountCompleteness(portfolio, 'r2-stale', {
    as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'test fixture declaration',
  }, { confirm: true, recordedBy: 'test-fixture' });
  try {
    const status = decision.evaluateAccountStatus(portfolio, staleSummary, 'r2-stale', LAST);
    assert.equal(status.ok, true, JSON.stringify(status.reasons));
    assert.equal(status.state_basis, 'ledger_reconstruction');
    assert.equal(status.reconstruction_as_of, LAST);
    assert.ok(status.warnings.some(w => w.code === 'account_snapshot_stale'), '旧快照仍应作为警告披露');
    assert.equal(status.unreported_trade_risk, false);
  } finally {
    // 清理声明，避免影响后续用例（该表按账户唯一）。
    portfolio.prepare('DELETE FROM account_completeness WHERE account_id = ?').run('r2-stale');
  }
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

// ---------------------------------------------------------------- 9. A4 决策层可卖数量
// 该账户从纯现金基线起步：20261016 当日买入 159558.SZ 10000 份（T+1），
// 因此当日可卖数量为 0；另在 20261015 买入 5000 份作为"历史持仓"。
// 快照（用于决策输入）与账本保持一致，避免 A2 对账把本用例变成对账失败。
ledger.initBaseline(portfolio, 'r2-a4', { asOf: PREV, cashCents: 5_000_000, note: 'a4 test fixture' });
ledger.confirmRealAccount(portfolio, 'r2-a4', { confirm: true, note: 'r2 test fixture' });
ledger.setAccountCompleteness(portfolio, 'r2-a4', {
  as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'a4 declaration',
}, { confirm: true, recordedBy: 'test-fixture' });
ledger.recordEvent(portfolio, {
  event_id: 'r2-a4-buy-prior', account_id: 'r2-a4', event_type: 'TRADE_BUY', occurred_on: PREV,
  ts_code: '159558.SZ', quantity: 5000, price_milli: 935, fee_cents: 0, source: 'broker_statement',
});
ledger.recordEvent(portfolio, {
  event_id: 'r2-a4-buy-today', account_id: 'r2-a4', event_type: 'TRADE_BUY', occurred_on: LAST,
  ts_code: '159558.SZ', quantity: 10000, price_milli: 935, fee_cents: 0, source: 'broker_statement',
});
// 账本：现金 5,000,000 − 467,500 − 935,000 = 3,597,500 分；证券 1,402,500 分。
const A4_SNAPSHOT = {
  ...CURRENT_SNAPSHOT,
  snapshot_id: 'r2-a4-snapshot',
  is_current: false,
  positions: [
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 15000, ref_price_milli: 935, ref_cost_milli: 935, market_value_cents: 1_402_500 },
  ],
  totals: {
    total_assets_cents: 5_000_000,
    securities_mv_cents: 1_402_500,
    cash_cents: 3_597_500,
    wealth_cents: 0,
    unrealized_pnl_cents: 0,
  },
};
// 决策输入必须是账户库"当前快照"；用例内临时切换，结束后恢复。
importSnapshot(portfolio, A4_SNAPSHOT);
const a4Summary = accountSummary({ ...readSnapshot(portfolio, 'r2-a4-snapshot'), is_current: true });

/** 账户库只允许一个当前快照，因此本组用例显式切换并在结束后恢复。 */
function withA4Current(fn) {
  markSnapshotCurrent(portfolio, 'r2-a4-snapshot', { confirmedBy: 'test-fixture' });
  try {
    return fn();
  } finally {
    markSnapshotCurrent(portfolio, 'r2-current', { confirmedBy: 'test-fixture' });
  }
}

test('R2-A4-1. 当日买入的权益 ETF 不可卖：卖出请求被拒（insufficient_sellable_position）', () => withA4Current(() => {
  const status = decision.evaluateAccountStatus(portfolio, a4Summary, 'r2-a4', LAST);
  assert.equal(status.ok, true, JSON.stringify(status.reasons));
  assert.equal(status.reconciliation.ok, true, JSON.stringify(status.reconciliation.mismatches));
  assert.equal(status.sellable['159558.SZ'].quantity, 15000);
  assert.equal(status.sellable['159558.SZ'].sellable_quantity, 5000, '只有前一交易日的 5000 份可卖');

  const d = rotation({
    account_id: 'r2-a4',
    snapshot: a4Summary,
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
  });
  const codes = d.reasons.map(r => r.code).concat(rotateOf(d).reasons.map(r => r.code));
  assert.ok(codes.includes('insufficient_sellable_position'), JSON.stringify(codes));
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.deepEqual(rotateOf(d).legs, [], '超过可卖数量时不能留下可下单的卖出腿');
  assert.equal(rotateOf(d).executable, false);
}));

test('R2-A4-2. 历史持仓可卖：卖出不超过可卖数量 → ACTIONABLE', () => withA4Current(() => {
  const d = rotation({
    account_id: 'r2-a4',
    snapshot: a4Summary,
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 5000, buy_code: '510300.SH', buy_kind: 'ETF' },
  });
  assert.equal(d.status, 'ACTIONABLE', JSON.stringify(d.reasons));
  assert.equal(rotateOf(d).executable, true);
}));

// ---------------------------------------------------------------- 10. A2 决策层对账
test('R2-A2-1. 同日快照与账本重放冲突 → DATA_INSUFFICIENT / 不可执行', () => {
  // 账户库的当前快照与账本一致；这里构造一个"同日但现金不同"的快照对象。
  const conflicted = { ...current, snapshot_id: 'r2-current', totals: { ...current.totals, cash_cents: current.totals.cash_cents + 100 } };
  const status = decision.evaluateAccountStatus(portfolio, conflicted, 'r2-account', LAST);
  assert.equal(status.ok, false);
  assert.equal(status.reconciliation.ok, false);
  assert.ok(status.reconciliation.mismatches.some(m => m.field === 'cash_cents'), JSON.stringify(status.reconciliation.mismatches));
  assert.ok(status.reasons.some(r => r.code === 'account_reconciliation_mismatch'), JSON.stringify(status.reasons));

  const d = rotation({ snapshot: conflicted });
  assert.equal(d.status, 'DATA_INSUFFICIENT', JSON.stringify(d.reasons));
  assert.ok(d.reasons.some(r => r.code === 'account_reconciliation_mismatch'), JSON.stringify(d.reasons));
  assert.equal(rotateOf(d).executable, false);
  assert.deepEqual(rotateOf(d).legs, [], '对账冲突时不得给出主执行腿');
});

test('R2-A2-2. 对账一致时决策正常；每个决策都披露完整性与未上报风险', () => {
  const status = decision.evaluateAccountStatus(portfolio, current, 'r2-account', LAST);
  assert.equal(status.ok, true, JSON.stringify(status.reasons));
  assert.equal(status.reconciliation.ok, true);
  assert.equal(status.unreported_trade_risk, false);
  assert.equal(status.reported_events_through, LAST);
  assert.equal(status.completeness_as_of, LAST);

  const d = rotation();
  assert.equal(d.account_status.reconciliation.ok, true);
  assert.equal(d.account_status.reported_events_through, LAST);
  assert.equal(d.account_status.last_user_reconciled_at, null);
  assert.equal(d.account_status.completeness_as_of, LAST);
  assert.equal(d.account_status.unreported_trade_risk, false);
});

test('R2-A1-3. 未声明完整性 → 不可执行；声明存在未上报风险 → 只能示意，不得 executable', () => {
  ledger.initBaseline(portfolio, 'r2-nocompleteness', { asOf: LAST, snapshotId: 'r2-current', note: 'fixture' });
  ledger.confirmRealAccount(portfolio, 'r2-nocompleteness', { confirm: true, note: 'r2 test fixture' });
  try {
    const status = decision.evaluateAccountStatus(portfolio, current, 'r2-nocompleteness', LAST);
    assert.equal(status.ok, false);
    assert.ok(status.reasons.some(r => r.code === 'account_completeness_undeclared'), JSON.stringify(status.reasons));

    // 声明"覆盖到决策日"，但缺省 unreported_trade_risk=true。
    ledger.setAccountCompleteness(portfolio, 'r2-nocompleteness', { as_of: LAST }, { confirm: true, recordedBy: 'test-fixture' });
    const risky = decision.evaluateAccountStatus(portfolio, current, 'r2-nocompleteness', LAST);
    assert.equal(risky.ok, true, JSON.stringify(risky.reasons));
    assert.equal(risky.unreported_trade_risk, true, '缺省即存在未上报交易风险');
    assert.equal(risky.state_basis, 'same_day_snapshot');

    // 可执行腿是对"当前现金/份额"的承诺，而未上报成交可能已改变它们：
    // 交易类表达必须降级为 ILLUSTRATIVE，且所有腿 executable:false。
    const d = rotation({ account_id: 'r2-nocompleteness' });
    assert.equal(d.status, 'ILLUSTRATIVE', JSON.stringify(d.reasons));
    assert.equal(d.account_status.unreported_trade_risk, true);
    assert.ok(d.warnings.some(w => /unreported_trade_risk/.test(w)), JSON.stringify(d.warnings));
    assert.ok(d.reasons.some(r => r.code === 'unreported_trade_risk'), JSON.stringify(d.reasons));
    const rotate = rotateOf(d);
    assert.equal(rotate.executable, false);
    assert.deepEqual(rotate.legs, []);
    assert.ok(rotate.illustrative_legs.every(l => l.executable === false));

    // 研究类（HOLD）不受影响：它不承诺任何数量。
    const hold = buildDecision(base({ account_id: 'r2-nocompleteness', action: { type: 'HOLD' } }));
    assert.ok(hold.warnings.some(w => /unreported_trade_risk/.test(w)));

    // 用户显式声明"已录入到决策日、无未上报风险"后才恢复可执行。
    ledger.setAccountCompleteness(portfolio, 'r2-nocompleteness', {
      as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'test-fixture' });
    const clean = rotation({ account_id: 'r2-nocompleteness' });
    assert.equal(clean.status, 'ACTIONABLE', JSON.stringify(clean.reasons));
    assert.equal(clean.account_status.unreported_trade_risk, false);
  } finally {
    portfolio.prepare('DELETE FROM account_completeness WHERE account_id = ?').run('r2-nocompleteness');
  }
});

test('R2-A1-4. 账本存在晚于决策日的事件 → 该日不可重建，不可执行', () => {
  const status = decision.evaluateAccountStatus(portfolio, current, 'r2-settle', PREV);
  assert.equal(status.ok, false);
  assert.ok(status.future_events, 'r2-settle 在 LAST 有事件，PREV 的重建会被未来事件污染');
  assert.ok(status.reasons.some(r => r.code === 'account_reconstruction_unavailable'), JSON.stringify(status.reasons));
});

// ---------------------------------------------------------------- 11. A5 证据生命周期
test('R2-A5-1. VERIFIED → REVOKED：校验翻转为 evidence_revoked，审计恰好一行', () => {
  const id = 'EV-A5-REVOKE';
  evidence.recordResearchEvidence(portfolio, {
    evidence_id: id, kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ',
    strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'VERIFIED',
    recorded_by: 'test-fixture', note: 'A5 生命周期用例',
  }, { confirm: true });

  const before = evidence.verifyResearchEvidence(portfolio, { evidence_id: id }, {
    buyCode: '510300.SH', sellCode: '159558.SZ', asOf: LAST,
  });
  assert.equal(before.verified, true, JSON.stringify(before));
  assert.deepEqual(evidence.readEvidenceStatusHistory(portfolio, id), [], '写入时不产生迁移行');

  const result = evidence.revokeResearchEvidence(portfolio, id, {
    confirm: true, recordedBy: 'test-fixture', reason: '研究结论被后续数据推翻',
  });
  assert.equal(result.evidence_id, id);
  assert.equal(result.previous_status, 'VERIFIED');
  assert.equal(result.status, 'REVOKED');
  assert.equal(result.revoked_by, 'test-fixture');
  assert.equal(result.already_revoked, false);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.revoked_at), result.revoked_at);

  const after = evidence.verifyResearchEvidence(portfolio, { evidence_id: id }, {
    buyCode: '510300.SH', sellCode: '159558.SZ', asOf: LAST,
  });
  assert.equal(after.verified, false);
  assert.equal(after.reason, 'evidence_revoked', '撤回后仍以 evidence_revoked 拒绝');

  const history = evidence.readEvidenceStatusHistory(portfolio, id);
  assert.equal(history.length, 1, '每次迁移恰好一行');
  assert.equal(history[0].from_status, 'VERIFIED');
  assert.equal(history[0].to_status, 'REVOKED');
  assert.equal(history[0].recorded_by, 'test-fixture');
  assert.equal(history[0].reason, '研究结论被后续数据推翻');

  // 原记录的经济字段原样保留，只改状态。
  const record = evidence.readResearchEvidence(portfolio, id);
  assert.equal(record.buy_code, '510300.SH');
  assert.equal(record.sell_code, '159558.SZ');
  assert.equal(record.as_of, LAST);
  assert.equal(record.strategy_id, 'r2-test');
  assert.equal(record.status, 'REVOKED');

  // 重复撤回：幂等形状，不新增审计行。
  const again = evidence.revokeResearchEvidence(portfolio, id, { confirm: true, recordedBy: 'test-fixture' });
  assert.equal(again.already_revoked, true);
  assert.equal(again.status, 'REVOKED');
  assert.equal(again.previous_status, 'REVOKED');
  assert.equal(evidence.readEvidenceStatusHistory(portfolio, id).length, 1, '重复撤回不重复记账');
});

test('R2-A5-2. 撤回缺少 --confirm 或 recordedBy → 拒绝；未知 id → 拒绝', () => {
  assert.throws(() => evidence.revokeResearchEvidence(portfolio, 'EV-A5-REVOKE', {}), /confirm/);
  assert.throws(() => evidence.revokeResearchEvidence(portfolio, 'EV-A5-REVOKE', { confirm: false, recordedBy: 'x' }), /confirm/);
  assert.throws(() => evidence.revokeResearchEvidence(portfolio, 'EV-A5-REVOKE', { confirm: true }), /recordedBy/);
  assert.throws(() => evidence.revokeResearchEvidence(portfolio, 'EV-A5-REVOKE', { confirm: true, recordedBy: '  ' }), /recordedBy/);
  assert.throws(() => evidence.revokeResearchEvidence(portfolio, 'EV-DOES-NOT-EXIST', {
    confirm: true, recordedBy: 'test-fixture',
  }), /不存在/);
  // 被拒绝的调用不改变任何状态。
  assert.equal(evidence.readResearchEvidence(portfolio, 'EV-A5-REVOKE').status, 'REVOKED');
  assert.equal(evidence.readEvidenceStatusHistory(portfolio, 'EV-A5-REVOKE').length, 1);
  assert.deepEqual(evidence.readEvidenceStatusHistory(portfolio, 'EV-DOES-NOT-EXIST'), []);
});

test('R2-A5-3. PENDING → REVOKED 也走同一路径（撤回不要求曾经 VERIFIED）', () => {
  const id = 'EV-A5-PENDING';
  evidence.recordResearchEvidence(portfolio, {
    evidence_id: id, kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ',
    strategy_id: 'r2-test', as_of: LAST, valid_until: null, status: 'PENDING',
    recorded_by: 'test-fixture', note: 'A5 pending 用例',
  }, { confirm: true });
  const result = evidence.revokeResearchEvidence(portfolio, id, { confirm: true, recordedBy: 'test-fixture' });
  assert.equal(result.previous_status, 'PENDING');
  assert.equal(evidence.readEvidenceStatusHistory(portfolio, id)[0].from_status, 'PENDING');
  assert.equal(evidence.verifyResearchEvidence(portfolio, { evidence_id: id }, {
    buyCode: '510300.SH', sellCode: '159558.SZ', asOf: LAST,
  }).reason, 'evidence_revoked');
});

test.after(() => {
  portfolio.close();
  market.close();
});

test('R2-A1-5. 跨日估值不需要每天重新声明：声明覆盖到基线即可重建后续交易日', () => {
  // 账户在 LAST 日确认并声明"已录入到 LAST、无未上报风险"。
  ledger.initBaseline(portfolio, 'r2-crossday', { asOf: LAST, snapshotId: 'r2-current', note: 'fixture' });
  ledger.confirmRealAccount(portfolio, 'r2-crossday', { confirm: true, note: 'r2 test fixture' });
  ledger.setAccountCompleteness(portfolio, 'r2-crossday', {
    as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'fixture',
  }, { confirm: true, recordedBy: 'test-fixture' });
  try {
    // 声明日当天：无未上报风险。
    const sameDay = decision.evaluateAccountStatus(portfolio, current, 'r2-crossday', LAST);
    assert.equal(sameDay.unreported_trade_risk, false, JSON.stringify(sameDay.reasons));

    // 下一个交易日：仍可重建（不需要重新声明），但风险标记为 true —— 因为声明
    // 只覆盖到 LAST，之后的交易日没有被用户核对过。
    const nextDay = '20261020'; // 合成日历中的下一个开市日
    const later = decision.evaluateAccountStatus(portfolio, current, 'r2-crossday', nextDay);
    assert.equal(later.ok, true, JSON.stringify(later.reasons));
    assert.equal(later.state_basis, 'ledger_reconstruction');
    assert.equal(later.unreported_trade_risk, true, '声明未覆盖的日期必须视为存在未上报交易风险');
    assert.ok(later.warnings.some(w => w.code === 'account_snapshot_stale'), JSON.stringify(later.warnings));

    // 交易类表达因此只能是示意。
    const d = rotation({ account_id: 'r2-crossday', as_of_trade_date: nextDay });
    assert.notEqual(d.status, 'ACTIONABLE');
    assert.equal(rotateOf(d).executable, false);
  } finally {
    portfolio.prepare('DELETE FROM account_completeness WHERE account_id = ?').run('r2-crossday');
    portfolio.prepare('DELETE FROM account_baseline WHERE account_id = ?').run('r2-crossday');
  }
});
