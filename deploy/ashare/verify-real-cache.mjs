#!/usr/bin/env node
// Correctness checks of the 1017 fixes against a COPY of the real cache.
// Never point this at the live data directory: it corrupts and truncates data on purpose.
// Usage: ASHARE_DATA_DIR=<copy dir> node deploy/ashare/verify-real-cache.mjs > result.json
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.env.ASHARE_DATA_DIR || '');
if (!process.env.ASHARE_DATA_DIR || /finance-mcp-ashare\/?$/.test(dataDir)) {
  throw new Error('ASHARE_DATA_DIR must point at a copy of the cache, not the live directory');
}
console.log = (...a) => { if (process.env.ASHARE_VERBOSE) console.error(...a); };

const build = p => new URL(`../../build/ashare/${p}`, import.meta.url).href;
const { openAshareDb, openResearchDb, closeAshareDb } = await import(build('db.js'));
const { checkQuality, recentTradeDays } = await import(build('ingest.js'));
const { syncRange } = await import(build('sync.js'));
const { latestReportMeta } = await import(build('report.js'));
const { evaluateWatchlist, loadVerdicts } = await import(build('evidence.js'));
const { runCommand } = await import(build('commands.js'));
const { runAshareTool } = await import(build('tools.js'));

const DAY = '20261016';
const out = { data_dir: dataDir, started_at: new Date().toISOString(), checks: {} };
const pass = (name, ok, detail) => {
  out.checks[name] = { ok: !!ok, ...detail };
  console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
};
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const db = openAshareDb();

function liveSnapshot() {
  const days = recentTradeDays(db, DAY, 6);
  return {
    watchlist: hash(db.prepare('SELECT * FROM watchlist ORDER BY trade_date, ts_code').all()),
    changes: hash(db.prepare('SELECT * FROM watchlist_change ORDER BY trade_date, ts_code, action').all()),
    scores: hash(db.prepare('SELECT trade_date, COUNT(*) n, SUM(score) s FROM stock_score GROUP BY trade_date').all()),
    reports: hash(db.prepare('SELECT * FROM report ORDER BY report_id').all()),
    latest_json: Object.fromEntries(days.map(d => {
      const p = join(dataDir, 'reports', d, 'latest.json');
      return [d, existsSync(p) ? hash(readFileSync(p, 'utf8')) : null];
    })),
  };
}

// 1. Migration and the 10-16 live report through the MCP tools.
out.run_mode_backfill = db.prepare('SELECT run_mode, COUNT(*) n FROM report GROUP BY run_mode').all();
const served = latestReportMeta(db, DAY);
const latest = latestReportMeta(db);
const tools = {};
for (const [name, args] of [
  ['ashare_data_status', { date: DAY }], ['ashare_daily_report', { date: DAY, format: 'json' }], ['ashare_watchlist', { date: DAY }],
  ['ashare_stock_analysis', { ts_code: '600519.SH', date: DAY }], ['ashare_sector_rank', { date: DAY, top: 5 }],
]) {
  const text = (await runAshareTool(name, args)).content[0].text;
  tools[name] = { chars: text.length, head: text.slice(0, 80).replace(/\n/g, ' ') };
}
const reportJson = JSON.parse((await runAshareTool('ashare_daily_report', { date: DAY, format: 'json' })).content[0].text);
const wlJson = JSON.parse((await runAshareTool('ashare_watchlist', { date: DAY })).content[0].text);
pass('report_20261016_read', served?.run_mode === 'live' && latest?.report_id === served.report_id
  && reportJson.report_id === served.report_id && wlJson.report_id === served.report_id,
  { served: served?.report_id, latest: latest?.report_id, tool_report_id: reportJson.report_id, status: reportJson.status, watchlist: wlJson.count, tools });
closeAshareDb();

// 2. Quality states.
const counts = () => Object.fromEntries(['daily', 'daily_basic', 'adj_factor', 'stk_limit'].map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE trade_date = ?`).get(DAY).n]));
const baseline = counts();
const q = d => checkQuality(db, d, false);
const states = { [DAY]: q(DAY).status, '20261019': q('20261019').status, '20261017': q('20261017').status };
db.prepare('DELETE FROM stk_limit WHERE trade_date = ? AND ts_code IN (SELECT ts_code FROM stk_limit WHERE trade_date = ? LIMIT 1000)').run(DAY, DAY);
const degraded = q(DAY);
pass('quality_states', states[DAY] === 'READY' && states['20261019'] === 'NOT_READY' && states['20261017'] === 'NOT_READY' && degraded.status === 'DEGRADED',
  { states, degraded: { status: degraded.status, reasons: degraded.reasons } });

// 3. Same-day re-sync with revised / withdrawn / missing rows (real Tushare).
const original = db.prepare("SELECT close FROM daily WHERE ts_code = '000001.SZ' AND trade_date = ?").get(DAY).close;
db.prepare("UPDATE daily SET close = close * 2 WHERE ts_code = '000001.SZ' AND trade_date = ?").run(DAY);
db.prepare("INSERT INTO daily (ts_code, trade_date, close) VALUES ('999999.XX', ?, 1)").run(DAY);
db.prepare('DELETE FROM daily_basic WHERE trade_date = ? AND ts_code IN (SELECT ts_code FROM daily_basic WHERE trade_date = ? LIMIT 50)').run(DAY, DAY);
const corrupted = counts();
const start = recentTradeDays(db, DAY, 5)[0];
const run1 = await syncRange(db, start, DAY, { refreshFrom: DAY, fina: false });
const after1 = counts();
const restored = db.prepare("SELECT close FROM daily WHERE ts_code = '000001.SZ' AND trade_date = ?").get(DAY).close;
const bogus = db.prepare("SELECT COUNT(*) n FROM daily WHERE ts_code = '999999.XX'").get().n;
const run2 = await syncRange(db, start, DAY, { refreshFrom: DAY, fina: false });
const after2 = counts();
const history = db.prepare("SELECT dataset, COUNT(*) n FROM sync_history WHERE key = ? GROUP BY dataset").all(DAY);
const fetchedOlder = Object.entries(run2.datasets).filter(([d, ds]) => d !== DAY && Object.values(ds).some(x => x.fetched)).map(([d]) => d);
pass('same_day_resync', restored === original && bogus === 0 && JSON.stringify(after1) === JSON.stringify(after2)
  && JSON.stringify(after1) === JSON.stringify(baseline) && q(DAY).status === 'READY' && fetchedOlder.length === 0,
  { baseline, original_close: original, restored_close: restored, bogus_rows_left: bogus, corrupted, after_first: after1, after_second: after2,
    as_of_writes: Object.fromEntries(Object.entries(run1.datasets[DAY]).map(([k, v]) => [k, v.write])), refreshed: run2.refreshed,
    older_days_refetched: fetchedOlder, sync_history: history, tushare: run2.tushare });

// 4. Replay and back-dated report isolation.
const before = liveSnapshot();
const h = (args, sink) => ({ arg: n => args[n], flag: n => args[n] === true, ymd: v => v, print: v => sink.push(v) });
const sink = [];
await runCommand(db, 'replay', h({ start: '20261012', end: DAY }, sink));
await runCommand(db, 'report', h({ date: '20261014' }, sink));
const afterIso = liveSnapshot();
const research = openResearchDb();
const researchReports = research.prepare('SELECT run_mode, COUNT(*) n FROM main.report GROUP BY run_mode').all();
research.close();
pass('replay_isolation', JSON.stringify(before) === JSON.stringify(afterIso) && latestReportMeta(db).report_id === served.report_id
  && sink[0].space === 'research' && sink[1].space === 'research',
  { before, after: afterIso, replay: sink[0].reports.map(r => ({ trade_date: r.trade_date, status: r.status, count: r.watchlist_count })),
    manual: { space: sink[1].space, report_id: sink[1].report_id }, research_reports: researchReports, latest_after: latestReportMeta(db).report_id });

// 5. As-of invariance on real data.
const E = '20261009';
const asOf = evaluateWatchlist(db, '20260701', E, 5);
// What the previous code reported for `end` = E: windows were allowed to run past E up to the latest data.
const leaked = evaluateWatchlist(db, '20260701', DAY, 5).per_date.filter(d => d.trade_date <= E);
const leakedMean = Math.round(leaked.reduce((s, d) => s + d.excess, 0) / leaked.length * 100) / 100;
const verdicts = loadVerdicts(db, '20260801');
for (const t of ['daily', 'adj_factor', 'daily_basic', 'stk_limit', 'index_daily']) db.prepare(`DELETE FROM ${t} WHERE trade_date > ?`).run(E);
const truncated = evaluateWatchlist(db, '20260701', E, 5);
pass('as_of_invariance', JSON.stringify(asOf) === JSON.stringify(truncated) && verdicts.meta.usable_as_of === false,
  { end: E, as_of_dates: asOf.dates, pending_dates: asOf.pending_dates, mean_excess_pct: asOf.mean_excess_pct,
    truncated_dates: truncated.dates, truncated_mean: truncated.mean_excess_pct,
    previous_code_equivalent: { dates: leaked.length, mean_excess_pct: leakedMean, leaked_dates: leaked.slice(asOf.dates).map(d => d.trade_date) },
    evidence_as_of_20260801: verdicts.meta });

db.close();
out.finished_at = new Date().toISOString();
out.passed = Object.values(out.checks).every(c => c.ok);
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exitCode = out.passed ? 0 : 1;
