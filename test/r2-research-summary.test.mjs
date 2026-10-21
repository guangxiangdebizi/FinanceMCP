import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// R2 工作包 B：研究模式账户晚间摘要。
//
// 离线、确定性：临时市场缓存 + 临时账户库 + 合成日报。所有数据都是合成 fixture，
// 不是用户真实账户、真实成交或真实收益。测试只读账户库与市场库，不写生产路径。

const dir = mkdtempSync(join(tmpdir(), 'ashare-r2-research-'));
const MARKET_MAIN = join(dir, 'market-main.sqlite');
const MARKET_NO_REPORT = join(dir, 'market-noreport.sqlite');
const MARKET_STALE = join(dir, 'market-stale.sqlite');
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
const { initBaseline } = await import('../build/portfolio/ledger.js');
const { buildResearchSummary } = await import('../build/portfolio/researchSummary.js');

const ROOT = process.cwd();
const OPEN_DAYS = weekdays('20261005', 10);
const LAST = OPEN_DAYS.at(-1);
const PREV = OPEN_DAYS.at(-2);
const REPORT_ID = 'ASR-20261016-R2TEST';

// 与 PRD §3 演示快照一致的收盘价，便于逐项核对重估权重。
const CLOSE = {
  '159241.SZ': 1.005,
  '159278.SZ': 0.796,
  '159558.SZ': 0.935,
  '516080.SH': 0.636,
  '560390.SH': 0.742,
  '510300.SH': 4.0,
};

const ETF_BASIC = [
  { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '航空航天指数', status: 'L', market: 'E' },
  { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '机器人指数', status: 'L', market: 'E' },
  { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备指数', status: 'L', market: 'E' },
  { ts_code: '516080.SH', name: '创新药ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '创新药指数', status: 'L', market: 'E' },
  { ts_code: '560390.SH', name: '电网设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '电网设备指数', status: 'L', market: 'E' },
  // 持仓之外的候选（合成数据）
  { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300指数', status: 'L', market: 'E' },
];

// 合成日报：广度偏强、指数趋势与量能偏弱、行业分化 → 同时有支持与反证。
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
      judgement: ['合成测试日报：不同维度信号分化，用于校验支持/反证切片'],
      indices: [
        { ts_code: '000001.SH', name: '上证指数', close: 3716.28, pct_chg: 0.24, ret5: -2.56, ret20: -5.54, amount_yi: 7324.75, above_ma20: false, above_ma60: false },
        { ts_code: '399001.SZ', name: '深证成指', close: 11802.46, pct_chg: -0.12, ret5: -6.64, ret20: -13.33, amount_yi: 3843.87, above_ma20: false, above_ma60: false },
        { ts_code: '000300.SH', name: '沪深300', close: 4020.11, pct_chg: -0.08, ret5: -1.20, ret20: -4.00, amount_yi: 5000.0, above_ma20: false, above_ma60: false },
        { ts_code: '000852.SH', name: '中证1000', close: 5900.0, pct_chg: 0.31, ret5: 0.80, ret20: -1.50, amount_yi: 2600.0, above_ma20: true, above_ma60: false },
      ],
      breadth: {
        stocks: 5000, up: 3100, down: 1800, flat: 100, limit_up: 50, limit_down: 20,
        up_ratio: 0.62, median_pct_chg: 0.40,
        amount_yi: 12000.0, amount_ma20_yi: 15000.0,
        pct_above_ma20: 28.0, pct_above_ma60: 40.0,
      },
    },
    sectors: {
      method: '合成测试数据',
      top: [{ industry: '出版业', rank: 1, strength: 1.0, stocks: 29, ret5_median_pct: 2.79, ret20_median_pct: 7.63, pct_above_ma20: 86.2 }],
      bottom: [{ industry: '铅锌', rank: 105, strength: 0.02, stocks: 14, ret5_median_pct: -8.69, ret20_median_pct: -18.15, pct_above_ma20: 0 }],
      all: [
        { industry: '半导体', rank: 5, strength: 0.9, ret5_median_pct: 3.0, ret20_median_pct: 5.0, pct_above_ma20: 70 },
        { industry: '国防军工', rank: 90, strength: 0.1, ret5_median_pct: -2.0, ret20_median_pct: -6.0, pct_above_ma20: 10 },
        { industry: '机械设备', rank: 70, strength: 0.3, ret5_median_pct: -1.0, ret20_median_pct: -3.0, pct_above_ma20: 25 },
        { industry: '医药生物', rank: 20, strength: 0.7, ret5_median_pct: 1.0, ret20_median_pct: 2.0, pct_above_ma20: 55 },
        { industry: '电力设备', rank: 60, strength: 0.4, ret5_median_pct: 0.2, ret20_median_pct: -1.0, pct_above_ma20: 40 },
      ],
    },
    disclaimer: '合成测试日报，不是投资建议。',
  };
}

function seedMarket(file, options = {}) {
  const { report = true, staleCodes = [], missingCodes = [] } = options;
  const db = openAshareDb(file);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    OPEN_DAYS.map((date, index) => ({ cal_date: date, is_open: 1, pretrade_date: OPEN_DAYS[index - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], ETF_BASIC);
  for (const [code, close] of Object.entries(CLOSE)) {
    if (missingCodes.includes(code)) continue;
    const rows = OPEN_DAYS
      .filter(date => !(staleCodes.includes(code) && date === LAST))
      .map(date => ({
        ts_code: code, trade_date: date,
        open: close, high: close, low: close, close, pre_close: close,
        vol: 1e6, amount: close * 1e6,
      }));
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], rows);
  }
  // 个股交叉核对数据（不进入持仓）。
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_status'], [
    { ts_code: '600519.SH', symbol: '600519', name: '合成个股', list_status: 'L' },
  ]);
  if (report) {
    const reportDir = join(dir, 'reports', LAST);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${REPORT_ID}.json`), JSON.stringify(reportFixture(), null, 2));
    db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
      .run(REPORT_ID, LAST, 'READY', '2026-10-16T21:40:00+08:00', `reports/${LAST}/${REPORT_ID}.json`, 'manual');
  }
  return db;
}

const marketMain = seedMarket(MARKET_MAIN);
const marketNoReport = seedMarket(MARKET_NO_REPORT, { report: false });
const marketStale = seedMarket(MARKET_STALE, { staleCodes: ['159278.SZ'], missingCodes: ['159241.SZ'] });

// ---------------------------------------------------------------- 合成账户与账本基线

const portfolio = openPortfolioDb();
const SYNTH_ID = 'synthetic-research-2026-10-18';
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

const summaryOf = (overrides = {}) => buildResearchSummary({
  portfolioDb: portfolio,
  marketDb: marketMain,
  accountId: 'demo-account',
  asOfTradeDate: LAST,
  ...overrides,
});

/** 递归找出任何 `legs` 数组里 executable:true 的条目（研究摘要必须为 0）。 */
function executableLegs(value, path = '$') {
  const found = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      found.push(...executableLegs(value[index], `${path}[${index}]`));
    }
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

// ---------------------------------------------------------------- 1. RESEARCH_ONLY 主路径

test('1. RESEARCH_ONLY：五只持仓有真实 bar 日期与正确权重，且没有可执行腿', () => {
  const summary = summaryOf();
  assert.equal(summary.status, 'RESEARCH_ONLY');
  assert.equal(summary.actionable, false);
  assert.equal(summary.holdings.length, 5);

  const snapshot = account.readSnapshot(portfolio, SYNTH_ID);
  const base = account.accountSummary(snapshot);
  for (const holding of summary.holdings) {
    assert.equal(holding.latest_bar_date, LAST, holding.ts_code);
    assert.equal(holding.bar_quality, 'READY', holding.ts_code);
    assert.equal(holding.price_used_for_revaluation, true, holding.ts_code);
    assert.equal(holding.source, 'server_cache');
    const expected = base.positions.find(position => position.ts_code === holding.ts_code);
    assert.equal(holding.weight, expected.weight, `${holding.ts_code} 权重`);
    assert.equal(holding.market_value_cents, expected.market_value_cents, `${holding.ts_code} 市值`);
  }
  assert.deepEqual(executableLegs(summary), []);
  for (const option of summary.decision_constraints.options) {
    assert.equal(option.executable, false);
  }
  assert.equal(summary.rotation_comparison.executable, false);
});

// ---------------------------------------------------------------- 2. 缺日报

test('2. 没有可用市场日报 → DATA_INSUFFICIENT / market_report_missing，不臆造 regime', () => {
  const summary = summaryOf({ marketDb: marketNoReport });
  assert.equal(summary.status, 'DATA_INSUFFICIENT');
  assert.ok(summary.reasons.some(reason => reason.code === 'market_report_missing'), JSON.stringify(summary.reasons));
  assert.equal(summary.market_context.available, false);
  assert.equal(summary.market_context.regime, null);
  assert.equal(summary.data_quality.market_report.reason, 'market_report_missing');
  assert.equal(summary.data_quality.status, 'INSUFFICIENT');
  assert.ok(summary.data_quality.missing_fields.includes('market_report'));
});

// ---------------------------------------------------------------- 3. 旧 bar / 缺 bar

test('3. 旧 bar 与缺 bar 都显式可见，不静默替换价格', () => {
  const summary = summaryOf({ marketDb: marketStale });

  // 旧 bar：bar 日期与阻塞原因必须可见；R1 收紧后旧收盘不冒充当前可交易价，
  // 因此回退到快照参考价并显式标注来源。
  const stale = summary.holdings.find(holding => holding.ts_code === '159278.SZ');
  assert.equal(stale.latest_bar_date, PREV);
  assert.ok(['STALE', 'NOT_READY'].includes(stale.bar_quality), stale.bar_quality);
  assert.ok(stale.bar_reasons.includes('bar_not_latest_trade_day'), JSON.stringify(stale.bar_reasons));
  assert.equal(stale.price_used_for_revaluation, false);
  assert.equal(stale.price_source, 'snapshot_reference_price');
  assert.equal(stale.price_milli, 796);
  assert.ok(summary.data_quality.quotes.not_ready.includes('159278.SZ'));

  const missing = summary.holdings.find(holding => holding.ts_code === '159241.SZ');
  assert.equal(missing.latest_bar_date, null);
  assert.equal(missing.bar_quality, 'MISSING');
  assert.equal(missing.price_used_for_revaluation, false);
  assert.equal(missing.price_source, 'snapshot_reference_price');
  assert.equal(missing.price_milli, 1005);
  assert.ok(summary.data_quality.quotes.missing.includes('159241.SZ'));
  assert.ok(summary.data_quality.missing_fields.includes('bar_missing:159241.SZ'));
  assert.equal(summary.data_quality.status, 'DEGRADED');
});

// ---------------------------------------------------------------- 4. 未提供候选

test('4. 未提供候选 → rotation_comparison 明确 not_available_without_candidate', () => {
  const summary = summaryOf();
  assert.equal(summary.rotation_comparison.status, 'not_available_without_candidate');
  assert.equal(summary.rotation_comparison.executable, false);
  assert.equal(summary.rotation_comparison.reason_code, 'candidate_required');
});

// ---------------------------------------------------------------- 4b. 候选 + 卖出数量

test('4b. 候选与卖出数量齐备 → 轮动比较只作示意，所有腿不可执行', () => {
  const summary = summaryOf({ candidateCode: '510300.SH', sell: { code: '159558.SZ', shares: 10000 } });
  assert.equal(summary.rotation_comparison.status, 'ILLUSTRATIVE');
  assert.equal(summary.rotation_comparison.executable, false);
  assert.equal(summary.rotation_comparison.candidate.ts_code, '510300.SH');
  assert.equal(summary.rotation_comparison.candidate.price_milli, 4000);
  for (const leg of summary.rotation_comparison.illustrative_legs) {
    assert.equal(leg.executable, false);
  }
  assert.deepEqual(executableLegs(summary), []);
});

// ---------------------------------------------------------------- 5. 候选未缓存

test('5. 候选未缓存 → DATA_INSUFFICIENT / candidate_not_cached，不伪造价格', () => {
  const summary = summaryOf({ candidateCode: '588999.SH', sell: { code: '159558.SZ', shares: 10000 } });
  assert.equal(summary.status, 'DATA_INSUFFICIENT');
  assert.ok(summary.reasons.some(reason => reason.code === 'candidate_not_cached'), JSON.stringify(summary.reasons));
  assert.equal(summary.rotation_comparison.status, 'DATA_INSUFFICIENT');
  assert.equal(summary.rotation_comparison.reason_code, 'candidate_not_cached');
  assert.equal(summary.rotation_comparison.candidate.available, false);
  assert.equal('price_milli' in summary.rotation_comparison.candidate, false);
});

// ---------------------------------------------------------------- 6. 市场证据

test('6. 市场证据同时包含支持与反证，全部带 as_of/source，整体 UNVERIFIED', () => {
  const summary = summaryOf();
  const evidence = summary.market_evidence;
  assert.equal(evidence.research_status, 'UNVERIFIED');
  assert.equal(evidence.forward_validation_required, true);
  assert.equal(evidence.available, true);
  assert.ok(evidence.support.length > 0, '应有支持项');
  assert.ok(evidence.contradiction.length > 0, '应有反证项');

  for (const item of [...evidence.support, ...evidence.contradiction, ...evidence.neutral]) {
    assert.ok(item.id);
    assert.ok(item.statement);
    assert.ok(item.as_of, `${item.id} 缺少 as_of`);
    assert.ok(item.source, `${item.id} 缺少 source`);
    assert.ok(['support', 'contradiction', 'neutral'].includes(item.direction));
  }
  // 证据方向来自事实：宽度偏强（支持）与指数/量能偏弱（反证）同时出现。
  assert.ok(evidence.support.some(item => item.id === 'breadth_up_ratio'));
  assert.ok(evidence.contradiction.some(item => item.id.startsWith('index_ret20:')));
  assert.ok(evidence.contradiction.some(item => item.id === 'breadth_amount_vs_ma20'));
});

// ---------------------------------------------------------------- 7. 账户未确认

test('7. 账户未确认 → REAL_ACCOUNT_PENDING，状态 RESEARCH_ONLY', () => {
  const summary = summaryOf();
  assert.equal(summary.account_status, 'REAL_ACCOUNT_PENDING');
  assert.equal(summary.status, 'RESEARCH_ONLY');
  assert.equal(summary.data_quality.real_account.verified, false);
  assert.ok(summary.warnings.includes('real_account_pending'));
});

// ---------------------------------------------------------------- 8. 确定性

test('8. 相同输入两次调用得到完全相同 JSON，且不含时间戳', () => {
  const first = summaryOf();
  const second = summaryOf();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal('generated_at' in first, false);
  assert.equal(first.summary_id, second.summary_id);
});

// ---------------------------------------------------------------- 9. 导入样例

test('9. 真实券商导入样例明确标注 example，且不含真实账户号码', () => {
  const sample = summaryOf().account_import_sample;
  assert.equal(sample.note, 'example only; no real trades inferred');
  const example = sample.real_account_import_example;
  assert.equal(example.source, 'broker_statement');
  assert.equal(example.account_id, 'example-account');
  assert.equal(/\d{6,}/.test(example.account_id), false, '不能用数字账号样例');
  assert.ok(sample.required_fields.includes('event_id'));
  assert.ok(sample.required_fields.includes('price_milli'));
  assert.ok(sample.dry_run_command.includes('--dry-run'));
});

// ---------------------------------------------------------------- 10. CLI 端到端

test('10. CLI 端到端：exit 0、合法 JSON、账户库未被修改', () => {
  const counts = () => {
    const db = new DatabaseSync(PORTFOLIO, { readOnly: true });
    try {
      return {
        account_snapshot: db.prepare('SELECT COUNT(*) n FROM account_snapshot').get().n,
        position: db.prepare('SELECT COUNT(*) n FROM position').get().n,
        account_event: db.prepare('SELECT COUNT(*) n FROM account_event').get().n,
      };
    } finally {
      db.close();
    }
  };
  const beforeStat = statSync(PORTFOLIO);
  const beforeCounts = counts();

  const result = spawnSync(process.execPath, [
    'build/ashare/cli.js', 'portfolio-research-summary',
    '--account', 'demo-account', '--date', LAST,
    '--market-db', MARKET_MAIN, '--db', PORTFOLIO, '--json',
  ], { cwd: ROOT, env: { ...process.env, ASHARE_DATA_DIR: dir }, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'ashare-portfolio-research-summary/1.0');
  assert.equal(output.status, 'RESEARCH_ONLY');
  assert.equal(output.holdings.length, 5);

  const afterStat = statSync(PORTFOLIO);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'CLI 不得修改账户库 mtime');
  assert.equal(afterStat.size, beforeStat.size, 'CLI 不得修改账户库大小');
  assert.deepEqual(counts(), beforeCounts, 'CLI 不得新增/删除账户库行');
});
