#!/usr/bin/env node
// Real-data checks of the data access layer and the four MCP data tools, on a COPY of the cache.
// Read-only apart from schema migration; still never point it at the live directory.
// Usage: ASHARE_DATA_DIR=<copy dir> node deploy/ashare/verify-data-service.mjs > result.json
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const dataDir = resolve(process.env.ASHARE_DATA_DIR || '');
if (!process.env.ASHARE_DATA_DIR || /finance-mcp-ashare\/?$/.test(dataDir)) throw new Error('ASHARE_DATA_DIR must point at a copy of the cache');
const copyPath = realpathSync(resolve(dataDir, 'ashare.sqlite'));
if (process.env.ASHARE_DB_PATH && realpathSync(process.env.ASHARE_DB_PATH) !== copyPath) throw new Error('ASHARE_DB_PATH must match the cache copy');
process.env.ASHARE_DB_PATH = copyPath;
console.log = (...a) => { if (process.env.ASHARE_VERBOSE) console.error(...a); };
const build = p => new URL(`../../build/ashare/${p}`, import.meta.url).href;
const { openAshareDb, getAshareDb, closeAshareDb, resolveReportPath } = await import(build('db.js'));
const { forEachStockBars } = await import(build('bars.js'));
const { latestReportMeta } = await import(build('report.js'));
const { runAshareTool } = await import(build('tools.js'));
const { readFileSync } = await import('node:fs');

const DAY = '20261016';
openAshareDb().close(); // migrate the copy's schema, as the container does at start
const db = getAshareDb();
const out = { data_dir: dataDir, started_at: new Date().toISOString(), samples: {}, timings_ms: {}, checks: {} };
const pass = (name, ok, detail) => { out.checks[name] = { ok: !!ok, ...detail }; console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 600)}`); };
const call = async (name, args) => {
  const t = Date.now();
  const text = (await runAshareTool(name, args)).content[0].text;
  (out.timings_ms[name] ??= []).push({ ms: Date.now() - t, bytes: Buffer.byteLength(text), args });
  return JSON.parse(text);
};
const col = (r, name) => r.rows.map(x => x[r.fields.indexOf(name)]);
const one = (sql, ...p) => db.prepare(sql).get(...p);

// ---------------------------------------------------------------- samples from the cache
const S = {
  large_cap: '600519.SH',
  recent_ipo: one(`SELECT b.ts_code FROM stock_basic b WHERE b.list_date BETWEEN '20260601' AND ? AND EXISTS (SELECT 1 FROM daily d WHERE d.ts_code = b.ts_code) ORDER BY b.list_date LIMIT 1`, DAY)?.ts_code,
  delisted: one(`SELECT b.ts_code FROM stock_basic b JOIN daily d ON d.ts_code = b.ts_code WHERE b.list_status = 'D' AND b.delist_date >= '20250101' GROUP BY b.ts_code ORDER BY COUNT(*) DESC LIMIT 1`)?.ts_code,
  suspended: one(`SELECT s.ts_code FROM suspend_d s JOIN stock_basic b ON b.ts_code = s.ts_code AND b.list_status = 'L' WHERE s.trade_date >= '20260101' GROUP BY s.ts_code HAVING COUNT(*) BETWEEN 3 AND 40 ORDER BY COUNT(*) DESC LIMIT 1`)?.ts_code,
  multi_period_financials: '600519.SH',
  fina_anomaly: '603400.SH',
  index: '000300.SH',
};
const exDate = one(`SELECT a.trade_date FROM adj_factor a JOIN adj_factor p ON p.ts_code = a.ts_code
  AND p.trade_date = (SELECT MAX(trade_date) FROM adj_factor WHERE ts_code = a.ts_code AND trade_date < a.trade_date)
  WHERE a.ts_code = ? AND a.trade_date BETWEEN '20250101' AND ? AND a.adj_factor <> p.adj_factor ORDER BY a.trade_date DESC LIMIT 1`, S.large_cap, DAY)?.trade_date;
out.samples = { ...S, ex_rights_date_600519: exDate };

// ---------------------------------------------------------------- 1. adjustment on an ex-rights date
{
  const days = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date').all('20250101', DAY).map(r => r.cal_date);
  const i = days.indexOf(exDate);
  const [start, end] = [days[i - 5], days[i + 5]];
  const qfq = await call('ashare_stock_history', { ts_code: S.large_cap, start_date: start, end_date: end, adjust: 'qfq' });
  const hfq = await call('ashare_stock_history', { ts_code: S.large_cap, start_date: start, end_date: end, adjust: 'hfq' });
  const raw = col(qfq, 'close'), adj = col(qfq, 'adj_close'), pct = col(qfq, 'pct_chg'), f = col(qfq, 'adj_factor');
  // A correct qfq series reproduces the exchange's pct_chg across the ex-date (pct_chg uses the ex-adjusted pre_close).
  const retErr = Math.max(...adj.slice(1).map((v, k) => Math.abs((v / adj[k] - 1) * 100 - pct[k + 1])));
  const hfqErr = Math.max(...col(hfq, 'adj_close').map((v, k) => Math.abs(v - raw[k] * f[k])));
  const atBase = Math.abs(adj.at(-1) - raw.at(-1));
  const before = await call('ashare_stock_history', { ts_code: S.large_cap, start_date: start, end_date: days[i - 1], adjust: 'qfq' });
  const rawEqualsQfqBefore = col(before, 'adj_close').every((v, k) => Math.abs(v - col(before, 'close')[k]) < 1e-6);
  const exRow = qfq.rows.find(r => r[0] === exDate);
  pass('ex_rights_adjustment', retErr < 0.02 && hfqErr < 0.01 && atBase < 1e-6 && before.adjust.base.trade_date <= days[i - 1] && rawEqualsQfqBefore && qfq.adjust.base.trade_date <= end,
    { ts_code: S.large_cap, ex_date: exDate, factor_before: f[4], factor_on_ex: f[5], raw_close: raw, qfq_close: adj, pct_chg: pct,
      max_return_vs_pct_chg_error_pp: Math.round(retErr * 1e4) / 1e4, max_hfq_error: hfqErr, qfq_base: qfq.adjust.base,
      as_of_before_ex: { end_date: days[i - 1], base: before.adjust.base, qfq_equals_raw: rawEqualsQfqBefore },
      ex_row_pre_close: exRow[qfq.fields.indexOf('pre_close')] });
}

// ---------------------------------------------------------------- 2. engine bars = data tool qfq
{
  const start = db.prepare("SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1 OFFSET 259").get(DAY).cal_date;
  let bars;
  forEachStockBars(db, start, DAY, (_c, b) => { bars = b; }, [S.large_cap]);
  const pages = [];
  let next = start;
  while (next) {
    const p = await call('ashare_stock_history', { ts_code: S.large_cap, start_date: next, end_date: DAY, limit: 500 });
    pages.push(...col(p, 'adj_close'));
    next = p.next_start_date;
  }
  const maxDiff = Math.max(...bars.close.map((v, k) => Math.abs(v - pages[k])));
  pass('engine_bars_match_data_tool', bars.close.length === pages.length && maxDiff < 1e-3, { bars: bars.close.length, tool_rows: pages.length, max_abs_diff: maxDiff });
}

// ---------------------------------------------------------------- 3. listing lifecycle and suspensions
{
  const ipoBasic = one('SELECT list_date FROM stock_basic WHERE ts_code = ?', S.recent_ipo);
  const ipoFirst = one('SELECT MIN(trade_date) d FROM daily WHERE ts_code = ?', S.recent_ipo).d;
  const ipo = await call('ashare_stock_history', { ts_code: S.recent_ipo, start_date: '20260501', end_date: DAY, adjust: 'none', limit: 500 });
  pass('recent_ipo', ipo.rows[0][0] === ipoFirst && ipo.coverage.not_listed_days > 0 && ipo.coverage.missing_days.length === 0,
    { ts_code: S.recent_ipo, list_date: ipoBasic.list_date, first_bar: ipo.rows[0][0], coverage: ipo.coverage, warnings: ipo.warnings });

  const del = one('SELECT list_date, delist_date FROM stock_basic WHERE ts_code = ?', S.delisted);
  const lastBar = one('SELECT MAX(trade_date) d FROM daily WHERE ts_code = ?', S.delisted).d;
  const span = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1 OFFSET 30').get(lastBar).cal_date;
  const dh = await call('ashare_stock_history', { ts_code: S.delisted, start_date: span, end_date: DAY, adjust: 'none', limit: 500 });
  pass('delisted', dh.delist_date === del.delist_date && dh.rows.at(-1)[0] === lastBar && dh.rows.every(r => r[0] < del.delist_date) && dh.coverage.not_listed_days > 0,
    { ts_code: S.delisted, delist_date: del.delist_date, last_bar: lastBar, coverage: { ...dh.coverage, missing_days: dh.coverage.missing_days.slice(0, 10) }, warnings: dh.warnings });

  const sd = db.prepare("SELECT trade_date FROM suspend_d WHERE ts_code = ? AND trade_date >= '20260101' ORDER BY trade_date").all(S.suspended).map(r => r.trade_date);
  const sh = await call('ashare_stock_history', { ts_code: S.suspended, start_date: '20260101', end_date: DAY, adjust: 'qfq', limit: 500 });
  pass('suspended', JSON.stringify(sh.coverage.suspended_days) === JSON.stringify(sd) && sh.rows.every(r => !sd.includes(r[0])) && sh.coverage.suspend_data_missing_days === 0,
    { ts_code: S.suspended, suspend_days: sd.length, coverage: { ...sh.coverage, suspended_days: sh.coverage.suspended_days.slice(0, 10) } });
}

// ---------------------------------------------------------------- 4. financial availability
{
  const asOf = '20260801';
  const f = await call('ashare_financial_data', { ts_code: S.multi_period_financials, as_of_date: asOf, limit: 12, include_revisions: true });
  const later = one('SELECT COUNT(*) n FROM fina_indicator WHERE ts_code = ? AND ann_date > ?', S.multi_period_financials, asOf).n;
  // data-1.1.0: later announcements exist in the cache but are neither returned nor counted.
  pass('financials_as_of', f.periods.length >= 6 && f.periods.every(p => p.ann_date <= asOf && p.ann_date >= p.end_date) && !('hidden_after_as_of' in f) && later > 0,
    { ts_code: S.multi_period_financials, as_of: asOf, periods: f.periods.map(p => ({ end_date: p.end_date, ann_date: p.ann_date, roe: p.values.roe, announcements: p.announcements })), later_in_cache_not_disclosed: later });
  const a = await call('ashare_financial_data', { ts_code: S.fina_anomaly, as_of_date: '20260501' });
  const aLate = await call('ashare_financial_data', { ts_code: S.fina_anomaly, as_of_date: '20260901' });
  // As of 0501 the 0630 period has not ended: not even the anomaly may mention it. As of 0901 it is disclosed.
  pass('financials_anomaly', !a.periods.some(p => p.end_date === '20260630') && !JSON.stringify(a).includes('20260630')
    && aLate.anomalies.some(x => x.end_date === '20260630' && x.ann_date === '20260422')
    && aLate.periods[0].end_date === '20260630' && aLate.periods[0].ann_date === '20260803',
    { as_of_20260501_latest: a.periods[0] && { end_date: a.periods[0].end_date, ann_date: a.periods[0].ann_date }, anomalies_20260501: a.anomalies, anomalies_20260901: aLate.anomalies, as_of_20260901_latest: { end_date: aLate.periods[0].end_date, ann_date: aLate.periods[0].ann_date } });
}

// ---------------------------------------------------------------- 5. market data = what the live report used
{
  const meta = latestReportMeta(db, DAY);
  const report = JSON.parse(readFileSync(resolveReportPath(meta.path), 'utf8'));
  const m = await call('ashare_market_data', { end_date: DAY });
  const d = m.days[0];
  const rb = report.market.breadth;
  const idx = Object.fromEntries(d.indices.map(i => [i.ts_code, i.close]));
  const idxOk = report.market.indices.every(i => Math.abs(idx[i.ts_code] - i.close) < 0.01);
  pass('market_matches_live_report', d.breadth.up === rb.up && d.breadth.down === rb.down && d.breadth.limit_up === rb.limit_up && d.breadth.limit_down === rb.limit_down && d.breadth.amount_yi === rb.amount_yi && idxOk && d.data_quality.status === 'READY',
    { report_id: meta.report_id, tool: d.breadth, report: { up: rb.up, down: rb.down, limit_up: rb.limit_up, limit_down: rb.limit_down, amount_yi: rb.amount_yi }, index_closes: idx });
  const range = await call('ashare_market_data', { start_date: '20260901', end_date: DAY, indices: ['000300.SH'], include_breadth: false });
  let tooLong = null;
  try { await call('ashare_market_data', { start_date: '20260101', end_date: DAY }); } catch (e) { tooLong = e.message; }
  pass('market_range_and_limit', range.trade_days > 20 && range.days.every(x => x.indices.length === 1) && /单次最多 60/.test(tooLong ?? ''), { range_days: range.trade_days, too_long_error: tooLong });
}

// ---------------------------------------------------------------- 6. stock basics, determinism, read-only
{
  const b = await call('ashare_stock_basic', { ts_codes: [S.large_cap, S.recent_ipo, S.delisted, S.suspended, '300114.SZ'] });
  pass('stock_basic', b.stocks.length === 4 && b.not_found.includes('300114.SZ') && b.stocks.find(s => s.ts_code === S.delisted).list_status === 'D',
    { stocks: b.stocks.map(s => ({ ts_code: s.ts_code, name: s.name, list_date: s.list_date, delist_date: s.delist_date, list_status: s.list_status })), not_found: b.not_found });
  const orphan = await call('ashare_stock_history', { ts_code: '300114.SZ', start_date: '20250101', end_date: '20250301', adjust: 'none' });
  pass('code_change_disclosed', orphan.rows.length > 0 && orphan.warnings.some(w => /不在当前 stock_basic/.test(w)), { rows: orphan.rows.length, warnings: orphan.warnings });
  const q = { ts_code: S.large_cap, end_date: DAY, include_basic: true };
  const [x, y] = [await call('ashare_stock_history', q), await call('ashare_stock_history', q)];
  let writeError = null;
  try { db.exec('DELETE FROM daily WHERE 0'); } catch (e) { writeError = e.message; }
  pass('deterministic_and_read_only', JSON.stringify(x) === JSON.stringify(y) && /readonly/.test(writeError ?? ''), { write_error: writeError });
}

closeAshareDb();
out.finished_at = new Date().toISOString();
out.passed = Object.values(out.checks).every(c => c.ok);
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exitCode = out.passed ? 0 : 1;
