// Phase 1: FinanceMCP -> TactiCore read-only research data export contract.
//
// Failure-first: each test names the failure it must prevent. Run after a build:
//   (cd /home/jcshi/workspace/FinanceMCP && npm run build)
//   node --test test/ashare-research-export.test.mjs
//
// No network, no docker. The export opens a synthetic read-only database and
// writes only into a temporary directory; the production cache is never touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { runResearchExport, EXPORT_DATASETS, AVAILABILITY_SEMANTICS,
  RESEARCH_EXPORT_SCHEMA_VERSION } = await import('../build/ashare/researchExport.js');
const { openAshareDb } = await import('../build/ashare/db.js');
const { weekdays } = await import('./ashare-fixture.mjs');

function tempDir(label) {
  const dir = join(tmpdir(), `research-export-${label}-${Math.random().toString(36).slice(2)}`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A synthetic market with an explicit as-of boundary and deliberate gaps. */
function buildDb(label, { asOf, cutoff, finaAnnDates = {}, fundRows = [], extraOpenDays = [] } = {}) {
  const dir = tempDir(label);
  process.env.ASHARE_DATA_DIR = dir.dir;
  process.env.ASHARE_DB_PATH = join(dir.dir, 'ashare.sqlite');
  const db = openAshareDb();
  const days = weekdays('20260105', 10);
  const asOfDay = asOf ?? days[4];
  const cutoffDay = cutoff ?? days[9];
  // Seed the whole window as open sessions so "latest closed session" resolution
  // has a real calendar to work with, not just two isolated rows.
  const cal = db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date,is_open) VALUES (?,1)');
  for (const day of days) cal.run(day);
  // Open sessions with no bars at all: a legitimate as-of request that the price
  // tables cannot satisfy. Used to prove the export refuses rather than truncating.
  for (const day of extraOpenDays) cal.run(day);
  db.prepare("INSERT OR REPLACE INTO stock_basic (ts_code,symbol,name,industry,list_date,list_status) VALUES ('600000.SH','600000','测试','行业1','20180101','L')").run();
  const insert = (table, cols, row) =>
    db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
  // Bars: one on the as-of day (must be exported) and one after it (must not be).
  insert('daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    { ts_code: '600000.SH', trade_date: asOfDay, open: 10, high: 11, low: 9, close: 10.5, pre_close: 10, pct_chg: 5, vol: 1e5, amount: 2e5 });
  insert('daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    { ts_code: '600000.SH', trade_date: cutoffDay, open: 99, high: 100, low: 98, close: 99.5, pre_close: 10, pct_chg: 5, vol: 1e5, amount: 2e5 });
  insert('adj_factor', ['ts_code', 'trade_date', 'adj_factor'], { ts_code: '600000.SH', trade_date: asOfDay, adj_factor: 1.5 });
  for (const row of fundRows) {
    insert('fund_basic', ['ts_code', 'name', 'fund_type', 'list_date', 'delist_date', 'market'], row);
  }
  for (const [date, ann] of Object.entries(finaAnnDates)) {
    insert('fina_indicator', ['ts_code', 'ann_date', 'end_date', 'roe'], { ts_code: '600000.SH', ann_date: ann, end_date: date, roe: 12 });
  }
  return { dir, db, asOfDay, cutoffDay, days };
}

test('RE-01 identical input produces an identical snapshot_id and identical content hashes', () => {
  const a = buildDb('determinism-a', {});
  const b = buildDb('determinism-b', {});
  try {
    const outA = tempDir('out-a'), outB = tempDir('out-b');
    try {
      const m1 = runResearchExport(a.db, { asOfTradeDate: a.asOfDay, outputDir: outA.dir, now: new Date('2026-01-10T00:00:00Z') });
      const m2 = runResearchExport(b.db, { asOfTradeDate: b.asOfDay, outputDir: outB.dir, now: new Date('2026-01-10T00:00:00Z') });
      assert.equal(m1.snapshot_id, m2.snapshot_id, '相同输入必须产生相同 snapshot_id');
      assert.deepEqual(m1.content_hashes, m2.content_hashes, '相同输入必须产生相同内容哈希');
      for (const [file, sha] of Object.entries(m1.content_hashes)) {
        assert.equal(sha, m2.content_hashes[file], `${file} 的哈希不稳定`);
      }
    } finally { outA.cleanup(); outB.cleanup(); }
  } finally { a.db.close(); a.dir.cleanup(); b.db.close(); b.dir.cleanup(); }
});

test('RE-02 the live database is opened read-only and never written', () => {
  const fix = buildDb('readonly', {});
  const out = tempDir('out-readonly');
  try {
    const ro = new DatabaseSync(process.env.ASHARE_DB_PATH, { readOnly: true });
    const before = readFileSync(process.env.ASHARE_DB_PATH);
    runResearchExport(ro, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    ro.close();
    assert.deepEqual(readFileSync(process.env.ASHARE_DB_PATH), before, '导出不得修改来源库字节');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-03 prices after the as-of date are refused, not truncated', () => {
  // Ten weekdays of bars, then three more open sessions with no bars at all.
  // Requesting one of those is asking for a date the price tables cannot serve:
  // the export must fail loudly instead of silently returning the last good day.
  const later = weekdays('20260202', 3);
  const fix = buildDb('asof-after', { extraOpenDays: later });
  const out = tempDir('out-asof-after');
  try {
    assert.throws(() => runResearchExport(fix.db, { asOfTradeDate: later[1], outputDir: out.dir }),
      /research_export_as_of_after_data_cutoff|research_export_as_of_not_ready/,
      '请求晚于 data_cutoff 的 as-of 必须被拒绝');
    assert.ok(!existsSync(join(out.dir, 'manifest.json')), '拒绝时不得留下 manifest');
    // And the override must be explicit, not a silent default.
    const m = runResearchExport(fix.db, { asOfTradeDate: later[1], outputDir: out.dir, allowMissingBars: true, now: new Date('2026-02-10T00:00:00Z') });
    assert.equal(m.as_of_trade_date, later[1], '显式允许时才导出，且 as-of 必须是请求日');
    assert.ok(m.data_quality.reasons.some(r => r.includes('allow_missing_bars')),
      '允许缺行时必须显式记录该降级原因');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-04 no row later than the as-of date is ever written into a dataset', () => {
  const fix = buildDb('asof-leak', {});
  const out = tempDir('out-asof-leak');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    const bars = readFileSync(join(out.dir, 'daily_bars.csv'), 'utf8');
    assert.ok(bars.includes(fix.asOfDay), 'as-of 当日的行情必须被导出');
    assert.ok(!bars.includes(fix.cutoffDay), 'as-of 之后的行情绝不得到达快照');
    assert.equal(m.as_of_trade_date, fix.asOfDay);
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-05 a missing financial announcement date is not PIT-qualified', () => {
  const fix = buildDb('fina-missing', { finaAnnDates: { '20251231': '' } });
  const out = tempDir('out-fina-missing');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    assert.match(m.availability_semantics.financial_indicator, /empty ann_date means UNKNOWN/,
      'manifest 必须声明空公告日不等于 PIT 合格');
    const fina = readFileSync(join(out.dir, 'financial_indicator.csv'), 'utf8');
    const header = fina.split('\n')[0].split(',');
    assert.ok(header.includes('ann_date'), 'ann_date 列必须存在');
    // The row is exported verbatim: its ann_date field is empty, which is exactly
    // the signal a reader needs to see that its availability is UNKNOWN.
    const row = fina.trim().split('\n')[1].split(',');
    assert.equal(row[header.indexOf('ann_date')], '', '空公告日必须保持为空，不得填 0 或猜测');
    assert.equal(row[header.indexOf('roe')], '12', 'roe 值必须原样保留');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-06 unknown values stay null and are never coerced to zero', () => {
  const fix = buildDb('nulls', {});
  const out = tempDir('out-nulls');
  try {
    db_insert_missing_fields(fix.db);
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    assert.match(m.availability_semantics.unknown_values, /never coerced to zero/);
    const bars = readFileSync(join(out.dir, 'daily_bars.csv'), 'utf8');
    // A missing pct_chg must appear as an empty field, not as 0.
    const lines = bars.trim().split('\n');
    const header = lines[0].split(',');
    const pctIndex = header.indexOf('pct_chg');
    const row = lines[1].split(',');
    assert.equal(row[pctIndex], '', '缺失值必须写成空字段而不是 0');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-07 ETF share and price bases stay separate; a missing factor is disclosed', () => {
  const fix = buildDb('etf-split', {
    fundRows: [
      { ts_code: '510300.SH', name: '沪深300ETF', fund_type: 'ETF', list_date: '20120528', delist_date: null, market: 'SH' },
    ],
  });
  const out = tempDir('out-etf');
  try {
    // Share change (a 1->3 split) on the as-of day, with no adjustment factor at all.
    fix.db.prepare('INSERT OR REPLACE INTO fund_share (ts_code,trade_date,fd_share,fund_type,market) VALUES (?,?,?,?,?)')
      .run('510300.SH', fix.asOfDay, 3_000_000, 'ETF', 'SH');
    fix.db.prepare('INSERT OR REPLACE INTO fund_daily (ts_code,trade_date,open,high,low,close,pre_close,vol,amount) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('510300.SH', fix.asOfDay, 4.215, 4.3, 4.1, 4.215, 1.405, 1e6, 1e7);
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    const share = readFileSync(join(out.dir, 'fund_share.csv'), 'utf8');
    const bars = readFileSync(join(out.dir, 'fund_daily_bars.csv'), 'utf8');
    const factor = readFileSync(join(out.dir, 'fund_adj_factor.csv'), 'utf8');
    assert.match(share, /3000000/, '份额变化必须被导出');
    assert.match(bars, /4\.215/, '原始价格必须被导出');
    // No fund_adj row exists: the manifest must say the policy is separate datasets,
    // and the factor dataset must be empty rather than filled with 1.
    assert.equal(factor.trim(), 'ts_code,trade_date,adj_factor', '缺失复权因子时必须是空数据集，不得填 1');
    assert.equal(m.adjustment_policy.policy, 'raw_and_adjustment_factor_exported_separately');
    assert.match(m.adjustment_policy.note, /raw_close_no_adj_factor/);
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-08 an unlisted security cannot produce a positive target weight downstream', () => {
  const fix = buildDb('unlisted', {
    fundRows: [
      // Listed only from a date after the as-of day: at as-of it must be excluded.
      { ts_code: '511010.SH', name: '未上市ETF', fund_type: 'ETF', list_date: '20270101', delist_date: null, market: 'SH' },
    ],
  });
  const out = tempDir('out-unlisted');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    const basic = readFileSync(join(out.dir, 'fund_basic.csv'), 'utf8');
    assert.match(basic, /20270101/, '上市日期必须原样导出，供读取方自行判定');
    // The manifest must warn that identity classification has no PIT vintage, so a
    // reader cannot silently treat "listed today" as "listed then".
    assert.match(m.availability_semantics.identity_classification, /CURRENT_SNAPSHOT_NOT_PIT/);
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-09 suspension and price limits are exported so gaps are marked, not interpolated', () => {
  const fix = buildDb('suspend', {});
  const out = tempDir('out-suspend');
  try {
    fix.db.prepare('INSERT OR REPLACE INTO suspend_d (ts_code,trade_date,suspend_timing) VALUES (?,?,?)')
      .run('600000.SH', fix.asOfDay, 'S');
    fix.db.prepare('INSERT OR REPLACE INTO stk_limit (ts_code,trade_date,up_limit,down_limit) VALUES (?,?,?,?)')
      .run('600000.SH', fix.asOfDay, 11.55, 9.45);
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    const names = m.dataset_manifest.map(d => d.dataset);
    assert.ok(names.includes('suspend'), '停牌数据集必须被导出');
    assert.ok(names.includes('price_limit'), '涨跌停数据集必须被导出');
    const suspend = readFileSync(join(out.dir, 'suspend.csv'), 'utf8');
    assert.match(suspend, /S/, '停牌标记必须原样导出');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-10 timestamps resolve against the Shanghai trading-day boundary', () => {
  const fix = buildDb('shanghai', {});
  const out = tempDir('out-shanghai');
  try {
    // A clock inside the Shanghai session but still before the 15:00 close must not
    // resolve "today" to an unclosed session when no date is requested.
    const m = runResearchExport(fix.db, { outputDir: out.dir, now: new Date('2026-01-06T06:00:00Z') });
    assert.ok(m.as_of_trade_date, '必须解析出一个已收盘交易日');
    assert.ok(/^\d{8}$/.test(m.as_of_trade_date), 'as-of 必须是 YYYYMMDD');
    assert.equal(m.data_quality.as_of_requested, null, '未显式请求时应记录 requested 为 null');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-11 a security-code mapping never invents an exchange or asset class', () => {
  const fix = buildDb('mapping', {});
  const out = tempDir('out-mapping');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    assert.equal(m.code_mapping_version, 'ts-code-v1');
    const basic = readFileSync(join(out.dir, 'stock_basic.csv'), 'utf8');
    assert.match(basic, /600000\.SH/, '代码必须保留交易所后缀原样导出');
    // No cross-border ETF may be silently reclassified as a domestic equity.
    assert.doesNotMatch(basic, /CROSS_BORDER/, '不得凭空生成跨境标记');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-12 a manifest content hash mismatch is detectable by a reader', () => {
  const fix = buildDb('tamper', {});
  const out = tempDir('out-tamper');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    const file = join(out.dir, 'daily_bars.csv');
    const tampered = readFileSync(file, 'utf8').replace('10.5', '11.5');
    writeFileSync(file, tampered, 'utf8');
    const actual = createHash('sha256').update(tampered, 'utf8').digest('hex');
    assert.notEqual(actual, m.content_hashes['daily_bars.csv'], '被篡改的文件必须与 manifest 哈希不符');
    assert.equal(m.schema_version, RESEARCH_EXPORT_SCHEMA_VERSION);
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-13 an unknown dataset name is refused rather than silently skipped', () => {
  const fix = buildDb('unknown-dataset', {});
  const out = tempDir('out-unknown');
  try {
    assert.throws(() => runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, datasets: ['nope'] }),
      /research_export_unknown_datasets/);
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-14 a missing table is reported as DEGRADED, never as an empty dataset', () => {
  const fix = buildDb('missing-table', {});
  const out = tempDir('out-missing-table');
  try {
    fix.db.exec('DROP TABLE fina_indicator');
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    assert.equal(m.data_quality.status, 'DEGRADED');
    assert.ok(m.data_quality.missing_datasets.includes('financial_indicator'));
    assert.ok(!existsSync(join(out.dir, 'financial_indicator.csv')), '缺失表不得写成空文件');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

test('RE-15 every exported dataset carries its availability semantics', () => {
  const fix = buildDb('semantics', {});
  const out = tempDir('out-semantics');
  try {
    const m = runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: out.dir, now: new Date('2026-01-10T00:00:00Z') });
    assert.ok(m.dataset_manifest.length > 0, '至少导出一个数据集');
    for (const ds of m.dataset_manifest) {
      assert.ok(ds.availability in AVAILABILITY_SEMANTICS, `${ds.dataset} 缺少可得性语义`);
      assert.equal(ds.as_of_filtered, ds.time_column !== null, `${ds.dataset} 的 as-of 过滤标记与时间列不一致`);
      assert.ok(ds.sha256.length === 64, `${ds.dataset} 缺少内容哈希`);
    }
    // The industry-composition gap must be stated, not implied by an empty file.
    assert.ok(m.data_quality.reasons.some(r => r.startsWith('industry_membership_not_exported')),
      '必须显式记录行业成分未导出');
  } finally { out.cleanup(); fix.db.close(); fix.dir.cleanup(); }
});

/** Make one bar's pct_chg genuinely NULL so the null-handling test has something to see. */
function db_insert_missing_fields(db) {
  db.prepare('UPDATE daily SET pct_chg = NULL WHERE trade_date = ?')
    .run(db.prepare('SELECT MIN(trade_date) d FROM daily').get().d);
}

test('RE-16 the export refuses to write its snapshot into the live database path', () => {
  const fix = buildDb('same-path', {});
  try {
    assert.throws(() => runResearchExport(fix.db, { asOfTradeDate: fix.asOfDay, outputDir: process.env.ASHARE_DB_PATH }),
      /separate|same|refus/i, '输出目录不得与生产库同路径');
  } finally { fix.db.close(); fix.dir.cleanup(); }
});

/** Many audit runs sharing a handful of `end_date` values, inserted in shuffled order.
 *
 *  This is the shape that actually breaks: `data_audit` is a rowid table whose only index is
 *  on `audit_id`, while the export orders by `end_date`. With enough rows sharing an
 *  `end_date` the planner switches to `USE TEMP B-TREE FOR ORDER BY`, and a sort over ties
 *  is not ordered by anything the caller chose. Two databases holding identical logical
 *  content then export different bytes — and the manifest publishes a sha256 of each file,
 *  so the same snapshot stops being reproducible.
 *
 *  Small fixtures do not reproduce it: with a handful of rows SQLite scans the `audit_id`
 *  index and the order looks stable, which is exactly why this survived. */
function db_insert_many_audits(db) {
  const insert = db.prepare('INSERT OR REPLACE INTO data_audit (audit_id,created_at,start_date,end_date,status,summary,path) VALUES (?,?,?,?,?,?,?)');
  const rows = [];
  const window = weekdays('20260105', 5);   // entirely at or before the fixture's as-of day
  for (let i = 0; i < 3000; i += 1) {
    // 5 distinct end_dates, 600 rows each — enough ties to trigger the temp B-tree.
    // Dates stay inside the as-of window, because the export filters
    // `end_date <= as-of` and would otherwise drop rows for a reason unrelated to
    // what this test is about.
    const end = window[i % window.length];
    rows.push([`AUD-${String(i).padStart(6, '0')}`, '2026-01-10T10:00:00Z', window[0], end, 'OK', 's', null]);
  }
  for (let i = rows.length - 1; i > 0; i -= 1) {           // deterministic shuffle
    const j = (i * 7919 + 13) % (i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  for (const r of rows) insert.run(...r);
}

test('RE-17 a dataset whose rows tie on the time column still exports in a stated order', () => {
  const fix = buildDb('audit-order', {});
  try {
    db_insert_many_audits(fix.db);
    const first = tempDir('audit-1'), second = tempDir('audit-2');
    try {
      const opts = { asOfTradeDate: fix.asOfDay, now: new Date('2026-01-10T00:00:00Z') };
      const a = runResearchExport(fix.db, { ...opts, outputDir: first.dir });
      const b = runResearchExport(fix.db, { ...opts, outputDir: second.dir });
      const rows = readFileSync(join(first.dir, 'data_audit.csv'), 'utf8').trim().split('\n').slice(1);
      assert.equal(rows.length, 3000, 'every audit row must be exported');
      // The manifest publishes a content hash; a hash over an unspecified order is decoration.
      assert.equal(a.content_hashes['data_audit.csv'], b.content_hashes['data_audit.csv'],
        '同一数据库两次导出必须逐字节相同，否则 manifest 的 sha256 不可复现');
      // And the order must be the declared one: time column ascending, then the primary
      // key, so nothing is left to the sorter.
      const ids = rows.map(r => r.split(',')[0]);
      const dates = rows.map(r => r.split(',')[3]);
      assert.deepEqual(dates, [...dates].sort(), 'end_date 必须升序，as-of 语义不能被打乱');
      // Within one end_date the tie-break is audit_id; across dates the PK restarts.
      for (let i = 0; i < rows.length;) {
        let j = i;
        while (j < rows.length && dates[j] === dates[i]) j += 1;
        const group = ids.slice(i, j);
        assert.deepEqual(group, [...group].sort(),
          `end_date=${dates[i]} 的 ${group.length} 行必须按 audit_id 排序，不能留给排序器`);
        i = j;
      }
    } finally { first.cleanup(); second.cleanup(); }
  } finally { fix.db.close(); fix.dir.cleanup(); }
});
