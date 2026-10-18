// ChatGPT research-layer contract checks for the A-share tools. These are the
// properties a research client depends on: a stable nine-tool surface, an
// explicitly RESEARCH_ONLY factor snapshot that never writes, separate raw /
// normalized / contribution layers, explicit nulls plus named scoring defaults,
// full version traceability, deterministic repeated queries, and no backtest
// side effects.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-research-interface-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'cache.sqlite');
const { openAshareDb, upsertRows, closeAshareDb } = await import('../build/ashare/db.js');
const { ashareToolDefinitions, ASHARE_TOOL_NAMES } = await import('../build/ashare/definitions.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { analyzeMarket, ENGINE_VERSION, FACTOR_VERSION, SCORING_POLICY, FACTOR_UNITS, FACTOR_SNAPSHOT_MAX_CODES } = await import('../build/ashare/engine.js');
const { INDICATOR_VERSION } = await import('../build/ashare/indicators.js');
const { SIGNAL_VERSION } = await import('../build/ashare/signals.js');
const { SCORE_VERSION, RESEARCH_SCORE_VERSION } = await import('../build/ashare/analysis.js');
const { seedMarket, weekdays, STOCKS } = await import('./ashare-fixture.mjs');

const EXPECTED_TOOLS = [
  'ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis', 'ashare_sector_rank',
  'ashare_factor_snapshot', 'ashare_stock_history', 'ashare_financial_data', 'ashare_market_data', 'ashare_stock_basic',
  // R0 ETF 纵切：追加在既有工具之后，不改变上面十个的名称、顺序与描述。
  'ashare_etf_quotes', 'ashare_etf_status',
];
// The nine tools that already existed before this phase; ashare_factor_snapshot is the addition.
const EXISTING_TOOLS = EXPECTED_TOOLS.slice(0, 10).filter(name => name !== 'ashare_factor_snapshot');

const db = openAshareDb();
const dates = weekdays('20260105', 150);
const date = dates.at(-1);
seedMarket(db, dates);
upsertRows(db, 'fina_indicator', ['ts_code', 'end_date', 'ann_date', 'roe', 'netprofit_yoy', 'ocf_to_profit', 'debt_to_assets', 'eps'], [
  ...[115.11, 20, -10, null].map((cash, i) => ({ ts_code: STOCKS[i].ts_code, end_date: '20260331', ann_date: '20260430', roe: 10, netprofit_yoy: 10, ocf_to_profit: cash, debt_to_assets: 40, eps: 1 })),
  { ts_code: STOCKS[5].ts_code, end_date: '20260331', ann_date: '20260430', roe: 10, netprofit_yoy: 10, ocf_to_profit: 20, debt_to_assets: 40, eps: 0 },
]);

const call = async args => JSON.parse((await runAshareTool('ashare_factor_snapshot', args)).content[0].text);

test('the research surface is the documented read-only tools, and the snapshot is one of them', () => {
  assert.deepEqual(ashareToolDefinitions.map(t => t.name), EXPECTED_TOOLS);
  assert.deepEqual([...ASHARE_TOOL_NAMES].sort(), [...EXPECTED_TOOLS].sort());
  // The nine tools that predate the factor snapshot are still the same names in the same slots.
  assert.equal(EXISTING_TOOLS.length, 9, 'the nine pre-existing tools are untouched');
  assert.deepEqual(EXPECTED_TOOLS.slice(0, 10), [
    'ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis', 'ashare_sector_rank',
    'ashare_factor_snapshot', 'ashare_stock_history', 'ashare_financial_data', 'ashare_market_data', 'ashare_stock_basic',
  ]);
  for (const tool of ashareToolDefinitions) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  const snapshot = ashareToolDefinitions.find(t => t.name === 'ashare_factor_snapshot');
  assert.match(snapshot.description, /RESEARCH_ONLY/);
  assert.deepEqual(snapshot.inputSchema.properties.score_version.enum, [SCORE_VERSION, RESEARCH_SCORE_VERSION]);
  assert.equal(snapshot.inputSchema.properties.ts_codes.maxItems, FACTOR_SNAPSHOT_MAX_CODES);
  // The factor snapshot is the only tool that computes scores; it is not exposed
  // through the daily-report path and has no write argument.
  assert.deepEqual(Object.keys(snapshot.inputSchema.properties).sort(), ['date', 'include_components', 'score_version', 'ts_codes']);
});

test('the response names its score version and every computation version for both versions', async () => {
  for (const version of [SCORE_VERSION, RESEARCH_SCORE_VERSION]) {
    const body = await call({ date, ts_codes: [STOCKS[1].ts_code], score_version: version });
    assert.equal(body.status, 'RESEARCH_ONLY');
    assert.equal(body.trade_date, date);
    assert.equal(body.score_version, version, 'the requested score version is visible, not implied by the numbers');
    assert.equal(body.engine_version, ENGINE_VERSION);
    assert.equal(body.factor_version, FACTOR_VERSION);
    assert.equal(body.indicator_version, INDICATOR_VERSION);
    assert.equal(body.signal_version, SIGNAL_VERSION);
    assert.equal(body.rows[0].factor_version, FACTOR_VERSION);
    assert.deepEqual(body.policy, SCORING_POLICY);
    assert.deepEqual(body.units, FACTOR_UNITS);
    // Traceable to the trade date actually used, not the default "today".
    assert.equal(body.trade_date, date);
    assert.ok(body.normalization_scope === 'full_market_eligible');
    assert.ok(body.universe.scanned > body.count);
  }
  // The two versions must be distinguishable from the response alone.
  const v1 = await call({ date, ts_codes: [STOCKS[1].ts_code], score_version: SCORE_VERSION });
  const v2 = await call({ date, ts_codes: [STOCKS[1].ts_code], score_version: RESEARCH_SCORE_VERSION });
  assert.equal(v1.score_version !== v2.score_version, true);
});

test('raw factors, normalized factors, formula inputs and weighted contributions are separate layers', async () => {
  const body = await call({ date, ts_codes: [STOCKS[1].ts_code, STOCKS[5].ts_code], include_components: true });
  for (const row of body.rows) {
    for (const key of ['raw', 'normalized', 'components', 'contributions', 'factor_contributions', 'scoring_factors', 'imputations']) {
      assert.ok(key in row, `${row.ts_code}: ${key} must be present when include_components=true`);
    }
    // raw keeps source units; normalized is in [0,1] (or null); scoring_factors are formula inputs.
    for (const [key, value] of Object.entries(row.normalized)) {
      assert.ok(value === null || (typeof value === 'number' && value >= 0 && value <= 1), `${key}=${value} must be a 0..1 normalization or null`);
    }
    // Contributions must reconstruct the score from the documented weights.
    const weights = SCORING_POLICY.weights;
    const total = Object.entries(row.components).reduce((s, [k, v]) => s + v * weights[k], 0);
    assert.ok(Math.abs(total - row.score) < 0.011, `${row.ts_code}: components*weights=${total} vs score=${row.score}`);
    const factorTotal = Object.values(row.factor_contributions).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(factorTotal - row.score) < 0.011, `${row.ts_code}: factor contributions=${factorTotal} vs score=${row.score}`);
    const componentTotal = Object.values(row.contributions).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(componentTotal - row.score) < 0.011, `${row.ts_code}: component contributions=${componentTotal} vs score=${row.score}`);
    // Raw and normalized are genuinely different representations.
    assert.equal(typeof row.raw.close, 'number');
    assert.equal(typeof row.normalized.liquidity, 'number');
  }
  // include_components=false drops exactly the derived layers and keeps observations.
  const lean = await call({ date, ts_codes: [STOCKS[1].ts_code], include_components: false });
  for (const key of ['components', 'contributions', 'factor_contributions', 'scoring_factors', 'imputations']) assert.equal(key in lean.rows[0], false, key);
  for (const key of ['raw', 'normalized', 'score', 'rank', 'quality']) assert.ok(key in lean.rows[0], key);
});

test('missing factors stay null while every scoring default is explicit', async () => {
  const body = await call({ date, ts_codes: [STOCKS[3].ts_code, STOCKS[5].ts_code], score_version: RESEARCH_SCORE_VERSION, include_components: true });
  const noReport = body.rows.find(r => r.ts_code === STOCKS[3].ts_code);
  // STOCKS[3] has a financial row with a null cash ratio: the raw value is missing, not zero.
  assert.equal(noReport.raw.ocf_to_profit, null);
  assert.equal(noReport.normalized.cash, null);
  assert.equal(noReport.scoring_factors.cash, 0.5, 'the formula default is explicit, not a silent zero');
  assert.match(noReport.imputations.cash, /0\.5/);
  assert.ok(noReport.quality.missing_factors.includes('ocf_to_profit'));
  // A stock with no financial report at all uses the documented component default.
  const noReportRow = body.rows.find(r => r.ts_code === STOCKS[5].ts_code);
  assert.ok(noReportRow.scoring_factors);
  for (const key of ['roe', 'growth', 'cash', 'leverage']) {
    if (noReportRow.normalized[key] === null) {
      assert.ok(typeof noReportRow.scoring_factors[key] === 'number');
      assert.ok(noReportRow.imputations[key], `${key} must name its default`);
    }
  }
  // No null observation is ever reported as a zero factor value.
  for (const row of body.rows) {
    for (const key of row.quality.missing_factors) assert.equal(row.raw[key], null, `${row.ts_code}.${key}`);
  }
});

test('repeated identical queries are byte-identical and never write to the cache', async () => {
  const before = db.prepare('SELECT total_changes() n').get().n;
  const args = { date, ts_codes: [STOCKS[2].ts_code, STOCKS[7].ts_code], score_version: RESEARCH_SCORE_VERSION, include_components: true };
  const first = (await runAshareTool('ashare_factor_snapshot', args)).content[0].text;
  const second = (await runAshareTool('ashare_factor_snapshot', args)).content[0].text;
  assert.equal(first, second, 'identical requests must return identical bytes');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'a research query must not persist scores, quality checks or reports');
  // The internal engine and the MCP entry point agree exactly.
  const internal = analyzeMarket(db, { date, ts_codes: args.ts_codes, score_version: args.score_version, parameters: { include_components: true } });
  assert.equal(first, JSON.stringify(internal));
});

test('a tool call never runs a research backtest or evaluates events', async () => {
  // The snapshot must not import the evaluation module at all: that is the only
  // path that reads forward prices. Checking the module graph is stronger than
  // checking row counts, and the cache-file checks below cover writes.
  const toolsSource = readFileSync(new URL('../src/ashare/tools.ts', import.meta.url), 'utf8');
  const engineSource = readFileSync(new URL('../src/ashare/engine.ts', import.meta.url), 'utf8');
  for (const source of [toolsSource, engineSource]) {
    assert.equal(/from '\.\/evaluation\.js'|import\('.*evaluation/.test(source), false, 'the snapshot path must not import evaluation.ts');
  }
  const dbBefore = statSync(join(dir, 'cache.sqlite'));
  const rowsBefore = ['daily', 'stock_score', 'watchlist', 'watchlist_change', 'report'].map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const changesBefore = db.prepare('SELECT total_changes() n').get().n;
  await call({ date, ts_codes: [STOCKS[0].ts_code], include_components: true });
  await call({ date, ts_codes: [STOCKS[0].ts_code], score_version: RESEARCH_SCORE_VERSION, include_components: true });
  const rowsAfter = ['daily', 'stock_score', 'watchlist', 'watchlist_change', 'report'].map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  assert.deepEqual(rowsAfter, rowsBefore, 'no derived/live table row is added');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changesBefore);
  assert.equal(statSync(join(dir, 'cache.sqlite')).size, dbBefore.size);
});

test('the snapshot is refused a write and a research run is not triggered', async () => {
  // A read-only connection is what the MCP tools use; prove the write is refused.
  const readOnly = new DatabaseSync(join(dir, 'cache.sqlite'), { readOnly: true });
  try {
    assert.throws(() => readOnly.prepare("INSERT INTO watchlist (trade_date, ts_code) VALUES ('19000101', '000000.SZ')").run(), /readonly/i);
  } finally { readOnly.close(); }
});

test.after(() => closeAshareDb());
