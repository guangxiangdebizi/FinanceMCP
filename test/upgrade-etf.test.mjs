import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
const root = process.env.UPGRADE_BUILD_DIR ?? resolve('build');
process.env.TUSHARE_TOKEN = 'synthetic-test-only';
process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS = '0';
process.env.ASHARE_TUSHARE_MAX_RETRIES = '0';
const { discoverEtfUniverse, buildEtfOpportunity } = await import(pathToFileURL(resolve(root, 'ashare/etfResearch.js')).href);
const { screenEtfCandidates } = await import(pathToFileURL(resolve(root, 'ashare/etfUniverse.js')).href);
const { openAshareDb } = await import(pathToFileURL(resolve(root, 'ashare/db.js')).href);
const { syncEtfForDaily, ETF_PIPELINE_CODES } = await import(pathToFileURL(resolve(root, 'ashare/etf.js')).href);
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fund_basic(ts_code TEXT PRIMARY KEY,name TEXT,fund_type TEXT,invest_type TEXT,type TEXT,benchmark TEXT,status TEXT,list_date TEXT,delist_date TEXT,market TEXT);
    CREATE TABLE fund_daily(ts_code TEXT,trade_date TEXT,close REAL,high REAL,low REAL,vol REAL,amount REAL,PRIMARY KEY(ts_code,trade_date));
    CREATE TABLE fund_adj(ts_code TEXT,trade_date TEXT,adj_factor REAL,PRIMARY KEY(ts_code,trade_date));
    CREATE TABLE fund_share(ts_code TEXT,trade_date TEXT,fd_share REAL);
    CREATE TABLE trade_cal(cal_date TEXT PRIMARY KEY,is_open INTEGER);
    CREATE TABLE index_daily(ts_code TEXT,trade_date TEXT,close REAL);`);
  const rows = [
    ['510777.SH', '测试宽基沪深300ETF', '股票型', 'L', '20200101', null],
    ['511777.SH', '测试国债ETF', '债券型', 'L', '20200101', null],
    ['518777.SH', '测试黄金ETF', '商品型', 'L', '20200101', null],
    ['513777.SH', '测试纳指ETF', 'QDII', 'L', '20200101', null],
    ['512777.SH', '测试机器人ETF', '股票型', 'L', '20200101', null],
    ['510778.SH', '未来ETF', '股票型', 'L', '20270101', null],
    ['510779.SH', '已退市ETF', '股票型', 'D', '20200101', '20261001'],
    ['160777.SZ', '测试LOF', '股票型', 'L', '20200101', null],
    ['500777.SH', '封闭基金', '股票型', 'L', '20200101', null],
  ];
  for (const [code, name, type, status, listed, delisted] of rows) db.prepare('INSERT INTO fund_basic VALUES (?,?,?,NULL,NULL,NULL,?,?,?,?)').run(code, name, type, status, listed, delisted, 'E');
  const dates = [];
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.UTC(2026, 6, 1 + i));
    const date = d.toISOString().slice(0, 10).replace(/-/g, '');
    dates.push(date);
    db.prepare('INSERT INTO trade_cal VALUES (?,1)').run(date);
    for (const code of rows.map(row => row[0])) {
      const close = 1 + i * 0.01;
      db.prepare('INSERT INTO fund_daily VALUES (?,?,?,?,?,?,?)').run(code, date, close, close + 0.01, close - 0.01, 10000, 50000);
      db.prepare('INSERT INTO fund_adj VALUES (?,?,1)').run(code, date);
    }
  }
  for (const code of rows.map(row => row[0])) {
    db.prepare('INSERT INTO fund_share VALUES (?,?,?)').run(code, dates.at(-1), 100000);
    db.prepare('INSERT INTO fund_share VALUES (?,?,?)').run(code, dates.at(-2), 99000);
  }
  return { db, asOf: dates.at(-1), dates };
}
test('ETF discovery spans real cached asset classes and excludes LOF and unlisted products', () => {
  const { db, asOf } = fixture();
  try {
    const discovery = discoverEtfUniverse(db, asOf);
    // October delisting is after this historical as-of and therefore remains in this universe.
    assert.equal(discovery.meta.discovered_total, 6);
    const map = new Map(discovery.declarations.map(row => [row.ts_code, row]));
    assert.equal(map.get('511777.SH').category, 'bond');
    assert.equal(map.get('518777.SH').category, 'gold');
    assert.equal(map.get('513777.SH').category, 'cross_border');
    assert.equal(map.get('510777.SH').category, 'broad_based');
    assert.equal(map.get('512777.SH').category, 'industry_theme');
    for (const code of ['160777.SZ', '500777.SH', '510778.SH']) assert.equal(map.has(code), false);
    assert.equal(discoverEtfUniverse(db, '20261021').declarations.some(row => row.ts_code === '510779.SH'), false);
    const capped = discoverEtfUniverse(db, asOf, 2);
    assert.equal(capped.meta.dynamic_evaluated, 2);
    assert.equal(capped.meta.omitted_count, 4);
  } finally { db.close(); }
});
test('screen retains actual held instruments and reveals stale prices without mixing future coverage', () => {
  const { db, asOf, dates } = fixture();
  try {
    const screen = screenEtfCandidates(db, { asOf, heldCodes: ['510777.SH'], limit: 1 });
    assert.deepEqual(screen.held, ['510777.SH']);
    assert.equal(screen.universe_version, 'r2-etf-candidates-1.0.0', 'declared seed version remains compatible');
    assert.equal(screen.research_version, 'etf-research-20261021-v2');
    assert.equal(screen.universe_discovery.version, 'etf-discovery-20261021-v1');
    assert.ok(screen.universe_discovery.discovered_total > 0);
    assert.equal(screen.candidates.find(row => row.ts_code === '510777.SH').research.evidence_status, 'UNVERIFIED');
    db.prepare('DELETE FROM fund_daily WHERE ts_code=? AND trade_date=?').run('510777.SH', asOf);
    const stale = screenEtfCandidates(db, { asOf, heldCodes: ['510777.SH'] });
    const row = stale.candidates.find(row => row.ts_code === '510777.SH');
    assert.equal(row.included, true);
    assert.ok(row.status_reasons.includes('fund_daily_stale'));
    assert.equal(row.research.price_quality, 'UNAVAILABLE');
    assert.equal(row.research.trend.return_20d_pct, null);
    assert.equal(stale.data_coverage.status, 'DEGRADED');
    db.prepare('INSERT INTO fund_daily VALUES (?,?,?,?,?,?,?)').run('510777.SH', '20270101', 2, 2, 2, 10, 10);
    assert.ok(screenEtfCandidates(db, { asOf: dates.at(-2) }).data_coverage.latest.fund_daily <= dates.at(-2));
  } finally { db.close(); }
});
test('daily dynamic historical sync is bounded and repeated empty history is cooled down', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'upgrade-etf-'));
  const db = openAshareDb(resolve(dir, 'synthetic.sqlite'));
  const original = globalThis.fetch;
  const calls = [];
  try {
    for (const date of ['20261019', '20261020', '20261021']) db.prepare('INSERT INTO trade_cal(cal_date,is_open) VALUES (?,1)').run(date);
    db.prepare("INSERT INTO fund_sync_log VALUES ('fund_basic','market=E',1,'ok','',?)").run(new Date().toISOString());
    const codes = Array.from({ length: 30 }, (_, i) => `59${String(i).padStart(4, '0')}.SH`);
    for (const code of [...ETF_PIPELINE_CODES, ...codes]) {
      db.prepare("INSERT INTO fund_basic(ts_code,name,market,status,list_date) VALUES (?,?,'E','L','20200101')").run(code, `测试ETF${code}`);
      for (const date of ['20261020', '20261021']) db.prepare('INSERT INTO fund_daily(ts_code,trade_date,open,high,low,close,vol,amount) VALUES (?,?,1,1,1,1,10000,50000)').run(code, date);
    }
    db.prepare("INSERT INTO fund_sync_log VALUES ('fund_daily','20261021',1000,'ok','',?)").run(new Date().toISOString());
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body); calls.push(request);
      return { ok: true, json: async () => ({ code: 0, data: { fields: request.fields.split(','), items: [] } }) };
    };
    const first = await syncEtfForDaily(db, '20261021', { days: 1 });
    assert.equal(first.research_universe.selected_dynamic.length, 12);
    assert.equal(first.research_universe.history_requested.length, 12);
    assert.equal(calls.filter(call => call.api_name === 'fund_daily' && call.params.start_date).length, 12);
    const second = await syncEtfForDaily(db, '20261021', { days: 1 });
    assert.deepEqual(second.research_universe.history_requested, []);
  } finally { globalThis.fetch = original; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('opportunity compares adjusted historical returns and holdings correlation without inventing NAV or advantage', () => {
  const { db, asOf } = fixture();
  try {
    const result = buildEtfOpportunity(db, '510777.SH', asOf, ['511777.SH']);
    assert.equal(result.trend.state, 'UPTREND');
    assert.equal(result.relative_to_holdings[0].correlation.value, 1);
    assert.equal(result.relative_to_holdings[0].return_20d_excess_pct, 0);
    assert.equal(result.shares.status, 'AVAILABLE');
    assert.equal(result.shares.change_wan, 1000);
    assert.equal(result.nav.status, 'UNAVAILABLE');
    assert.equal(result.opportunity.status, 'UNVERIFIED');
    db.prepare('UPDATE fund_adj SET adj_factor=2 WHERE ts_code=? AND trade_date=?').run('510777.SH', asOf);
    assert.equal(buildEtfOpportunity(db, '510777.SH', asOf, []).shares.reason, 'factor_change_unclassified');
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run('511777.SH', asOf);
    assert.equal(buildEtfOpportunity(db, '511777.SH', asOf, []).trend.return_20d_pct, null);
  } finally { db.close(); }
});
