import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// D1 收盘日报：第一节必须是“下一交易日最值得做的 0-3 个动作及理由”。
//
// 离线、确定性：临时市场缓存 + 临时账户库 + 合成日报；账户与成交都是合成 fixture，
// 不是用户真实账户。只读账户库与市场库，不写生产路径。
// 覆盖：NO_ACTION 路径、ILLUSTRATIVE（不可执行）轮动、缺 fund_* 表的降级、
// 可执行数量门控、plan_tracking 缺表降级与只读。

const dir = mkdtempSync(join(tmpdir(), 'ashare-v1-daily-'));
const MARKET_MAIN = join(dir, 'market-main.sqlite');
const MARKET_NO_FUND = join(dir, 'market-no-fund.sqlite');
const PORTFOLIO = join(dir, 'portfolio.sqlite');

process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = MARKET_MAIN;
process.env.ASHARE_PORTFOLIO_DB_PATH = PORTFOLIO;
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');
const account = await import('../build/portfolio/account.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { confirmRealAccount, initBaseline, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { PLAN_TRACKING_SCHEMA, buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { buildDecision } = await import('../build/portfolio/decision.js');

const DAYS = weekdays('20261005', 10);
const LAST = DAYS.at(-1);
const PREV = DAYS.at(-2);
const NEXT = '20261019';
const REPORT_ID = 'ASR-20261016-D1TEST';

const CLOSE = {
  '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935,
  '516080.SH': 0.636, '560390.SH': 0.742, '510300.SH': 4.0,
};

const BASIC = Object.entries(CLOSE).map(([ts_code]) => ({
  ts_code, name: ts_code === '510300.SH' ? '沪深300ETF' : `合成${ts_code}`,
  fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E',
}));

function reportFixture() {
  return {
    report_id: REPORT_ID,
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: LAST,
    generated_at: '2026-10-16T21:40:00+08:00',
    status: 'READY',
    run_mode: 'manual',
    market: {
      regime: 'range',
      regime_label: '震荡',
      tone: 'neutral',
      judgement: ['合成测试日报'],
      indices: [
        { ts_code: '000300.SH', name: '沪深300', close: 4020.11, pct_chg: -0.08, ret5: -1.20, ret20: -4.00, amount_yi: 5000, above_ma20: false, above_ma60: false },
      ],
      breadth: {
        stocks: 5000, up: 1500, down: 3400, flat: 100, limit_up: 20, limit_down: 40,
        up_ratio: 0.30, median_pct_chg: -0.40,
        amount_yi: 9000, amount_ma20_yi: 12000,
        pct_above_ma20: 18, pct_above_ma60: 30,
      },
    },
    sectors: {
      method: '合成测试数据',
      top: [{ industry: '出版业', rank: 1, strength: 1.0, stocks: 29, ret5_median_pct: 2.79, ret20_median_pct: 7.63, pct_above_ma20: 86.2 }],
      bottom: [{ industry: '铅锌', rank: 105, strength: 0.02, stocks: 14, ret5_median_pct: -8.69, ret20_median_pct: -18.15, pct_above_ma20: 0 }],
      all: [
        { industry: '半导体', rank: 90, strength: 0.1, ret5_median_pct: -3.0, ret20_median_pct: -8.0, pct_above_ma20: 10 },
        { industry: '国防军工', rank: 95, strength: 0.08, ret5_median_pct: -2.0, ret20_median_pct: -6.0, pct_above_ma20: 10 },
        { industry: '机械设备', rank: 70, strength: 0.3, ret5_median_pct: -1.0, ret20_median_pct: -3.0, pct_above_ma20: 25 },
        { industry: '医药生物', rank: 60, strength: 0.4, ret5_median_pct: 0.1, ret20_median_pct: -1.0, pct_above_ma20: 35 },
        { industry: '电力设备', rank: 65, strength: 0.35, ret5_median_pct: -0.2, ret20_median_pct: -2.0, pct_above_ma20: 30 },
      ],
    },
    disclaimer: '合成测试日报，不是投资建议。',
  };
}

function seedMarket(file, { fundTables = true, staleCodes = [], codes = Object.keys(CLOSE) } = {}) {
  const db = openAshareDb(file);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((date, index) => ({ cal_date: date, is_open: 1, pretrade_date: DAYS[index - 1] ?? null })));
  // 下一交易日：用于验证 expected_next_trade_date（20261019 为合成节假日）。
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?,?,?)').run(NEXT, 0, LAST);
  db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?,?,?)').run('20261020', 1, NEXT);
  if (fundTables) {
    upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], BASIC);
  }
  for (const code of codes) {
    const close = CLOSE[code];
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      DAYS.filter(date => !(staleCodes.includes(code) && date === LAST)).map(date => ({
        ts_code: code, trade_date: date,
        open: close, high: close, low: close, close, pre_close: close,
        vol: 1e6, amount: 1e5,
      })));
  }
  if (fundTables) {
    const reportDir = join(dir, 'reports', LAST);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${REPORT_ID}.json`), JSON.stringify(reportFixture(), null, 2));
    db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
      .run(REPORT_ID, LAST, 'READY', '2026-10-16T21:40:00+08:00', `reports/${LAST}/${REPORT_ID}.json`, 'manual');
  }
  return db;
}

/**
 * 模拟生产缓存“没有 fund_* 表”：只用原始 DatabaseSync 建 trade_cal / fund_daily / report，
 * 不建 fund_basic / fund_adj / fund_share（openAshareDb 总会把这几张表建出来）。
 */
function seedNoFundTables(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER NOT NULL, pretrade_date TEXT)');
  const cal = db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?,?,?)');
  DAYS.forEach((date, index) => cal.run(date, 1, DAYS[index - 1] ?? null));
  cal.run(NEXT, 0, LAST);
  cal.run('20261020', 1, NEXT);
  db.exec(`CREATE TABLE fund_daily (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL,
    close REAL, pre_close REAL, change REAL, pct_chg REAL, vol REAL, amount REAL, PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID`);
  const bar = db.prepare('INSERT OR REPLACE INTO fund_daily (ts_code, trade_date, open, high, low, close, pre_close, vol, amount) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [code, close] of Object.entries(CLOSE)) {
    for (const date of DAYS) bar.run(code, date, close, close, close, close, close, 1e6, 1e5);
  }
  db.exec(`CREATE TABLE report (report_id TEXT PRIMARY KEY, trade_date TEXT NOT NULL, status TEXT NOT NULL,
    generated_at TEXT NOT NULL, path TEXT NOT NULL, run_mode TEXT)`);
  const reportDir = join(dir, 'reports', LAST);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${REPORT_ID}.json`), JSON.stringify(reportFixture(), null, 2));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(REPORT_ID, LAST, 'READY', '2026-10-16T21:40:00+08:00', `reports/${LAST}/${REPORT_ID}.json`, 'manual');
  return db;
}

const marketMain = seedMarket(MARKET_MAIN);
const marketNoFund = seedNoFundTables(MARKET_NO_FUND);

// ---------------------------------------------------------------- 合成账户

const portfolio = openPortfolioDb();
const SYNTH_ID = 'synthetic-d1-2026-10-16';
const SYNTH = {
  ...account.DEMO_SNAPSHOT,
  snapshot_id: SYNTH_ID,
  as_of: '2026-10-16',
  source: 'synthetic-test-fixture',
  note: '合成测试账户（不是真实账户）',
  warnings: ['synthetic_fixture'],
  is_current: false,
};
account.importSnapshot(portfolio, SYNTH);
// 账本基线存在但用户尚未确认 → REAL_ACCOUNT_PENDING。
initBaseline(portfolio, 'demo-account', { asOf: LAST, snapshotId: SYNTH_ID });

const build = (overrides = {}) => buildDailyReport({
  portfolioDb: portfolio,
  marketDb: marketMain,
  accountId: 'demo-account',
  asOfTradeDate: LAST,
  generatedAt: '2026-10-16T21:55:00+08:00',
  ...overrides,
});

/** 用指定日报内容重建主市场缓存的报告文件（用例之间互不污染）。 */
function writeMainReport(report) {
  writeFileSync(join(dir, 'reports', LAST, `${REPORT_ID}.json`), JSON.stringify(report, null, 2));
}

/** 递归找出任何 legs 数组里 executable:true 的条目。 */
function executableLegs(value, path = '$') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...executableLegs(item, `${path}[${index}]`)));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'legs' && Array.isArray(child)) {
        for (const leg of child) if (leg && leg.executable === true) found.push(`${path}.${key}`);
      }
      found.push(...executableLegs(child, `${path}.${key}`));
    }
  }
  return found;
}

// ---------------------------------------------------------------- 1. 结构

test('D1-1 第一节固定是“下一交易日最值得做的 0-3 个动作及理由”，动作数不超过 3', () => {
  const report = build();
  assert.equal(report.schema, 'ashare-daily-action-report/1.0');
  assert.equal(report.first_section.heading, '下一交易日最值得做的 0-3 个动作及理由');
  assert.ok(Array.isArray(report.first_section.actions));
  assert.ok(report.first_section.count <= 3);
  assert.equal(report.first_section.count, report.first_section.actions.length);
  assert.equal(Object.keys(report)[0], 'schema');
  assert.equal(report.as_of_trade_date, LAST);
  assert.equal(report.expected_next_trade_date, '20261020', '20261019 是合成节假日，应跳到 20261020');
  // 时间戳齐全。
  assert.equal(report.timestamps.as_of_trade_date, LAST);
  assert.ok('account_confirmed_at' in report.timestamps);
  assert.ok('quote_updated_at' in report.timestamps);
  assert.equal(report.timestamps.generated_at, '2026-10-16T21:55:00+08:00');
  // 所有事实都带 as_of / source / quality / claim_status。
  for (const fact of report.fact_register) {
    assert.ok(fact.source, `${fact.id} 缺少 source`);
    assert.ok(['FACT', 'UNVERIFIED'].includes(fact.claim_status));
    assert.ok(['OK', 'DEGRADED', 'MISSING'].includes(fact.quality));
  }
  assert.equal(report.market_judgement.research_status, 'UNVERIFIED');
});

// ---------------------------------------------------------------- 2. NO_ACTION

test('D1-2 无证据支持动作 → NO_ACTION，给出观察触发条件与空动作列表', () => {
  // 行情全部 READY、持仓权重未过半、市场反证不足以触发审视 → 不生成动作。
  const calm = seedMarket(join(dir, 'market-calm.sqlite'));  // 覆盖成“温和上涨 + 支持项占多数”的日报，避免用反证触发减仓动作。
  const calmReport = reportFixture();
  calmReport.market.breadth.up_ratio = 0.62;
  calmReport.market.breadth.median_pct_chg = 0.5;
  calmReport.market.breadth.amount_yi = 13000;
  calmReport.market.indices[0].ret5 = 1.5;
  calmReport.market.indices[0].ret20 = 3.0;
  calmReport.market.indices[0].above_ma20 = true;
  calmReport.market.indices[0].above_ma60 = true;
  calmReport.sectors.all = calmReport.sectors.all.map(row => ({ ...row, ret20_median_pct: 4.0 }));
  writeMainReport(calmReport);

  const report = build({ marketDb: calm });
  assert.equal(report.status, 'NO_ACTION');
  assert.equal(report.actionable, false);
  assert.equal(report.first_section.count, 0);
  assert.deepEqual(report.first_section.actions, []);
  assert.ok(report.first_section.no_action_reason.includes('没有可复核的证据'));
  assert.ok(report.first_section.observation_triggers.length >= 3, 'NO_ACTION 必须给出观察触发条件');
  assert.ok(report.first_section.observation_triggers.some(trigger => trigger.includes('行情质量')));
  assert.deepEqual(executableLegs(report), [], 'NO_ACTION 不得包含任何可执行腿');
  // 持仓仍然逐只列出并给出立场。
  assert.equal(report.holdings.length, 5);
  for (const holding of report.holdings) {
    assert.ok(['HOLD', 'REDUCE', 'ROTATE', 'WAIT'].includes(holding.stance));
    assert.ok(holding.reasons.length > 0);
    assert.ok(holding.counter_evidence.length > 0, `${holding.ts_code} 必须有反证/机会成本`);
  }
  // 候选池降级可见，不是静默空列表（行情全部就绪但缺 fund_share 等表时为 DEGRADED）。
  assert.ok(['READY', 'DEGRADED'].includes(report.data_quality.screening.status));
  assert.ok(Array.isArray(report.data_quality.screening.missing_tables));

  // 还原主日报 fixture，避免影响后续用例。
  writeMainReport(reportFixture());
});

// ---------------------------------------------------------------- 3. 不可执行轮动

test('D1-3 账户未确认 → ILLUSTRATIVE，轮动/减仓腿全部 executable:false', () => {
  const report = build();
  assert.equal(report.status, 'ILLUSTRATIVE');
  assert.equal(report.actionable, false);
  assert.equal(report.gate.satisfied, false);
  assert.ok(report.gate.reasons.some(reason => reason.code === 'account_not_current'));
  assert.ok(report.gate.reasons.some(reason => reason.code === 'account_not_verified'));
  assert.ok(report.first_section.actions.length > 0, '合成日报应至少给出一个审视动作');
  for (const action of report.first_section.actions) {
    assert.ok(action.legs.length > 0, `${action.code} 应有示意腿`);
    assert.ok(action.illustrative, `${action.code} 应有 illustrative 块`);
    assert.equal(action.illustrative.executable, false);
    for (const leg of action.legs) {
      assert.equal(leg.executable, false, `${action.code} 的腿不得可执行`);
      assert.ok(leg.reason, '不可执行腿必须写明原因');
    }
    for (const leg of action.illustrative.legs) assert.equal(leg.executable, false);
    assert.ok(action.fees_cents !== null, '示意腿也要给出假设费用');
    assert.ok(action.triggers.length > 0);
    assert.ok(action.invalidation_conditions.length > 0);
    assert.ok(action.risk_impact.length > 0);
  }
  assert.deepEqual(executableLegs(report), []);
  // 数量只是示意，且必须是整手。
  for (const action of report.first_section.actions) {
    for (const leg of action.legs) {
      if (leg.quantity === null) continue;
      assert.equal(leg.quantity % leg.lot_size, 0, '示意数量必须是整手');
    }
  }
});

test('D1-3b 候选 vs 现金：现金不足一手时显式标注，不臆造买入', () => {
  const report = build();
  assert.equal(report.candidate_vs_cash.available, true);
  assert.equal(typeof report.candidate_vs_cash.cash_cents, 'number');
  assert.ok(report.candidate_vs_cash.entries.length > 0);
  for (const entry of report.candidate_vs_cash.entries) {
    assert.ok(entry.fact_meta, `${entry.ts_code} 缺少事实元数据`);
    assert.ok(entry.fact_meta.as_of || entry.fact_meta.quality === 'DEGRADED');
    if (entry.price_milli === null) {
      assert.equal(entry.one_lot_cents, null);
      assert.equal(entry.cash_sufficient_for_one_lot, null);
    } else {
      assert.equal(entry.one_lot_cents, Math.round((100 * entry.price_milli) / 10));
    }
  }
});

// ---------------------------------------------------------------- 4. 行情过期

// 语义修复（任务书 D2）：持仓行情缺失/过期是 DATA_INSUFFICIENT —— 行情缺失
// 不等于“已证明继续持有最优”。旧断言 NO_ACTION 正是被修复的缺陷：五只持仓全部
// NOT_READY 时报告仍声称“数据完整、没有可靠优势”。
test('D1-4 持仓行情过期 → DATA_INSUFFICIENT（行情缺失不等于已证明继续持有），阻塞原因与触发条件明确', () => {
  const stale = seedMarket(join(dir, 'market-stale.sqlite'), { staleCodes: ['159278.SZ'] });
  const report = build({ marketDb: stale });
  assert.equal(report.status, 'DATA_INSUFFICIENT');
  assert.equal(report.actionable, false);
  assert.equal(report.first_section.count, 0, '“等待行情补齐”不是 0–3 个交易动作之一');
  assert.deepEqual(report.first_section.actions, []);
  assert.ok(report.first_section.no_action_reason.includes('159278.SZ'), report.first_section.no_action_reason);
  assert.ok(report.first_section.observation_triggers.some(trigger => trigger.includes('159278.SZ')));
  assert.ok(report.first_section.observation_triggers.some(trigger => trigger.includes('触发条件')));
  assert.ok(report.first_section.observation_triggers.some(trigger => trigger.includes('失效条件')));
  assert.deepEqual(executableLegs(report), []);
  assert.ok(report.data_quality.quotes.stale.includes('159278.SZ')
    || report.data_quality.quotes.not_ready.includes('159278.SZ'));
  // 过期持仓的立场是 WAIT，而不是 HOLD。
  assert.equal(report.holdings.find(holding => holding.ts_code === '159278.SZ').stance, 'WAIT');
  // 数据质量分层：行情不足与账户身份必须分开披露。
  assert.equal(report.data_quality.tiers.etf_price.status, 'PARTIAL');
  assert.ok(report.data_quality.tiers.etf_price.not_ready.includes('159278.SZ'));
  assert.equal(report.data_quality.tiers.trade_plan_executability.status, 'NOT_EXECUTABLE');
  // 持有/观察/减仓/轮动条件逐只给出（D3），且不复用“行业收益代替 ETF 收益”。
  const staleHolding = report.holdings.find(holding => holding.ts_code === '159278.SZ');
  assert.deepEqual(staleHolding.research.conditions.map(c => c.stance), ['HOLD', 'WATCH', 'REDUCE', 'ROTATE']);
  assert.equal(staleHolding.research.data.fresh, false);
  assert.ok(staleHolding.research.availability.unavailable.some(line => line.includes('NOT_READY') || line.includes('行情质量')));
});

// ---------------------------------------------------------------- 5. 门控满足

test('D1-5 门控满足但动作由未验证研究判断触发 → ILLUSTRATIVE，腿不可执行', () => {
  // 单独建一个已确认的账户，避免影响其它用例的 PENDING 语义。
  const confirmedPortfolio = openPortfolioDb(join(dir, 'portfolio-confirmed.sqlite'), { marketPath: MARKET_MAIN });
  const snapshotId = 'synthetic-confirmed-2026-10-16';
  account.importSnapshot(confirmedPortfolio, { ...SYNTH, snapshot_id: snapshotId });
  initBaseline(confirmedPortfolio, 'confirmed-account', { asOf: LAST, snapshotId });
  account.markSnapshotCurrent(confirmedPortfolio, snapshotId, { confirmedBy: 'test-fixture' });
  confirmRealAccount(confirmedPortfolio, 'confirmed-account', { confirm: true, note: 'synthetic fixture' });
  // V1.0 准入：日报与决策共用同一个账户门控，因此同样要求覆盖决策日的完整性声明。
  setAccountCompleteness(confirmedPortfolio, 'confirmed-account', {
    as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'synthetic fixture declaration',
  }, { confirm: true, recordedBy: 'test-fixture' });

  const report = buildDailyReport({
    portfolioDb: confirmedPortfolio,
    marketDb: marketMain,
    accountId: 'confirmed-account',
    asOfTradeDate: LAST,
    generatedAt: '2026-10-16T21:55:00+08:00',
  });
  // 账户门控本身通过……
  assert.equal(report.gate.satisfied, true);
  // ……但唯一可生成的动作由"集中度阈值 + 未经验证的市场证据计数"触发，
  // 这两者都是研究判断，不能单独授权一笔可执行卖出（PRD §6/§7）。
  assert.equal(report.actionable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
  assert.ok(report.first_section.actions.length > 0);
  for (const action of report.first_section.actions) {
    for (const leg of action.legs) {
      assert.equal(leg.executable, false, `${action.code} 的腿不得可执行`);
      assert.ok(typeof leg.reason === 'string' && leg.reason.length > 0, '不可执行必须给出原因码');
    }
    assert.ok(action.illustrative, '非可执行动作必须保留 illustrative 块');
    assert.ok(action.illustrative.legs.every(leg => leg.executable === false));
  }
  // 数量仍然由程序计算（示意值），不是手填的。
  const leg = report.first_section.actions[0].legs[0];
  assert.ok(Number.isInteger(leg.quantity) && leg.quantity > 0);
  assert.equal(leg.quantity % leg.lot_size, 0);
  assert.equal(leg.gross_cents, Math.round((leg.quantity * leg.price_milli) / 10));
});

// ---------------------------------------------------------------- 6. plan_tracking

test('D1-6 plan_tracking 缺表 → 明确降级为 not_available，不建表、不补造历史', () => {
  const report = build();
  assert.equal(report.plan_tracking.available, false);
  assert.equal(report.plan_tracking.reason, 'plan_tracking_table_missing');
  assert.deepEqual(report.plan_tracking.entries, []);
  // 模块不得自己建表。
  const tables = new DatabaseSync(PORTFOLIO, { readOnly: true })
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_tracking'").all();
  assert.deepEqual(tables, []);
});

test('D1-6b plan_tracking 存在 → 只读列出更早预案，结果保持 unknown', () => {
  const db = openPortfolioDb(join(dir, 'portfolio-tracking.sqlite'), { marketPath: MARKET_MAIN });
  db.exec(PLAN_TRACKING_SCHEMA);
  db.prepare(`INSERT INTO plan_tracking
    (plan_id, account_id, as_of_trade_date, generated_at, status, action_code, action_summary, legs_json, observation_triggers_json, invalidation_conditions_json, expected_by, note, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'PLAN-1', 'demo-account', PREV, '2026-10-15T21:40:00+08:00', 'ILLUSTRATIVE',
    'REDUCE_CONCENTRATION', '审视 159558.SZ 的集中度', '[]', '[]', '[]', '20261016', 'synthetic', '2026-10-15T21:40:00+08:00',
  );
  account.importSnapshot(db, { ...SYNTH, snapshot_id: 'synthetic-tracking' });
  initBaseline(db, 'demo-account', { asOf: LAST, snapshotId: 'synthetic-tracking' });

  const report = buildDailyReport({ portfolioDb: db, marketDb: marketMain, accountId: 'demo-account', asOfTradeDate: LAST });
  assert.equal(report.plan_tracking.available, true);
  assert.equal(report.plan_tracking.entries.length, 1);
  assert.equal(report.plan_tracking.entries[0].plan_id, 'PLAN-1');
  assert.equal(report.plan_tracking.entries[0].outcome, 'unknown', '没有后续核对时不得臆断已触发/已失效');
});

// ---------------------------------------------------------------- 7. 缺表降级

test('D1-7 市场缓存缺 fund_* 表 → 状态降级但报告仍完整、不含可执行腿', () => {
  const report = build({ marketDb: marketNoFund });
  assert.ok(['DATA_INSUFFICIENT', 'NO_ACTION', 'ILLUSTRATIVE'].includes(report.status));
  assert.equal(report.actionable, false);
  assert.equal(report.data_quality.screening.status, 'DEGRADED');
  assert.deepEqual(report.data_quality.screening.missing_tables.sort(), ['fund_adj', 'fund_basic', 'fund_share']);
  assert.deepEqual(executableLegs(report), []);
  assert.equal(report.holdings.length, 5, '缺行情时持仓仍逐只列出');
  for (const holding of report.holdings) {
    assert.ok(['WAIT', 'HOLD', 'REDUCE', 'ROTATE'].includes(holding.stance));
    assert.equal(holding.price_source, 'snapshot_reference_price');
  }
  assert.equal(report.drawdown.available, false);
  assert.equal(report.drawdown.reason, 'no_history');
});

// ---------------------------------------------------------------- 8. 确定性

test('D1-8 相同输入两次调用得到完全相同的 JSON（generated_at 不进入哈希）', () => {
  const first = build({ generatedAt: '2026-10-16T21:55:00+08:00' });
  const second = build({ generatedAt: '2026-10-16T22:30:00+08:00' });
  assert.equal(first.report_id, second.report_id);
  assert.equal(JSON.stringify({ ...first, timestamps: null }), JSON.stringify({ ...second, timestamps: null }));
});

// ---------------------------------------------------------------- 9. 只读

test('D1-9 只读：生成日报不修改账户库（行数与文件大小不变）', () => {
  const before = new DatabaseSync(PORTFOLIO, { readOnly: true });
  const count = (db) => ({
    snapshot: db.prepare('SELECT COUNT(*) n FROM account_snapshot').get().n,
    position: db.prepare('SELECT COUNT(*) n FROM position').get().n,
    event: db.prepare('SELECT COUNT(*) n FROM account_event').get().n,
  });
  const beforeCounts = count(before);
  before.close();
  build();
  const after = new DatabaseSync(PORTFOLIO, { readOnly: true });
  assert.deepEqual(count(after), beforeCounts);
  after.close();
});

// ---------------------------------------------------------------- 10. 与决策同口径

test('D1-10 未上报交易风险时，日报与决策给出一致的 executable=false', () => {
  // 已确认真实账户，但完整性声明为"存在未上报交易风险"（缺省即如此）。
  const riskyPortfolio = openPortfolioDb(join(dir, 'portfolio-risky.sqlite'), { marketPath: MARKET_MAIN });
  const snapshotId = 'synthetic-risky-2026-10-16';
  account.importSnapshot(riskyPortfolio, { ...SYNTH, snapshot_id: snapshotId });
  initBaseline(riskyPortfolio, 'risky-account', { asOf: LAST, snapshotId });
  account.markSnapshotCurrent(riskyPortfolio, snapshotId, { confirmedBy: 'test-fixture' });
  confirmRealAccount(riskyPortfolio, 'risky-account', { confirm: true, note: 'synthetic fixture' });
  setAccountCompleteness(riskyPortfolio, 'risky-account', { as_of: LAST }, { confirm: true, recordedBy: 'test-fixture' });

  const report = buildDailyReport({
    portfolioDb: riskyPortfolio,
    marketDb: marketMain,
    accountId: 'risky-account',
    asOfTradeDate: LAST,
    generatedAt: '2026-10-16T21:55:00+08:00',
  });
  // 日报必须承认门控未满足，且没有任何可执行腿。
  assert.equal(report.gate.satisfied, false, JSON.stringify(report.gate));
  assert.equal(report.gate.unreported_trade_risk, true);
  assert.ok(report.gate.reasons.some(r => r.code === 'unreported_trade_risk'), JSON.stringify(report.gate.reasons));
  assert.equal(report.actionable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
  for (const action of report.first_section.actions) {
    for (const leg of action.legs) assert.equal(leg.executable, false, `${action.code} 的腿不得可执行`);
  }

  // 决策工具对同一账户必须给出一致的结论。
  const decision = buildDecision({
    account_id: 'risky-account',
    snapshot: account.accountSummary(account.readSnapshot(riskyPortfolio, snapshotId)),
    as_of_trade_date: LAST,
    market_db: marketMain,
    portfolio_db: riskyPortfolio,
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 10000, buy_code: '510300.SH', buy_kind: 'ETF' },
  });
  assert.notEqual(decision.status, 'ACTIONABLE');
  for (const option of decision.options) {
    if (option.status !== 'ACTIONABLE') assert.deepEqual(option.legs, []);
  }
  assert.ok(decision.warnings.some(w => /unreported_trade_risk/.test(w)), JSON.stringify(decision.warnings));
});
