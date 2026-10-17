#!/usr/bin/env node
// Phase B0 checks on a COPY of the real cache (it writes: audit --fix, a simulated failed refresh).
// Usage: ASHARE_DATA_DIR=<copy dir> PRISTINE_DB=<untouched snapshot> [BASELINE_BUILD=<old build dir>] \
//        node deploy/ashare/verify-b0.mjs > result.json
import { resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

const dataDir = resolve(process.env.ASHARE_DATA_DIR || '');
if (!process.env.ASHARE_DATA_DIR || /finance-mcp-ashare\/?$/.test(dataDir)) throw new Error('ASHARE_DATA_DIR must point at a copy of the cache');
if (!process.env.PRISTINE_DB) throw new Error('PRISTINE_DB (untouched snapshot to diff against) is required');
const copyPath = realpathSync(resolve(dataDir, 'ashare.sqlite'));
const pristinePath = realpathSync(process.env.PRISTINE_DB);
const copyStat = statSync(copyPath), pristineStat = statSync(pristinePath);
if (copyPath === pristinePath || (copyStat.dev === pristineStat.dev && copyStat.ino === pristineStat.ino)) throw new Error('Cache copy and pristine snapshot must be different files');
if (process.env.ASHARE_DB_PATH && realpathSync(process.env.ASHARE_DB_PATH) !== copyPath) throw new Error('ASHARE_DB_PATH must match the cache copy');
process.env.ASHARE_DB_PATH = copyPath;
console.log = (...a) => { if (process.env.ASHARE_VERBOSE) console.error(...a); };
const build = p => new URL(`../../build/ashare/${p}`, import.meta.url).href;
const { openAshareDb } = await import(build('db.js'));
const { auditCache, fillGaps } = await import(build('audit.js'));
const { checkQuality, syncSuspend } = await import(build('ingest.js'));
const { financialHistory, stockHistory, marketData } = await import(build('data.js'));

const START = '20240102';
const END = '20261016';
const db = openAshareDb();
const out = { data_dir: dataDir, pristine: process.env.PRISTINE_DB, started_at: new Date().toISOString(), checks: {} };
const pass = (name, ok, detail) => { out.checks[name] = { ok: !!ok, ...detail }; console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 800)}`); };

// ---------------------------------------------------------------- 1. classification, old vs new
const t0 = Date.now();
const before = auditCache(db, START, END);
out.audit_before = { status: before.status, counts: before.counts, totals: before.totals, seconds: Math.round((Date.now() - t0) / 1000) };
if (process.env.BASELINE_BUILD) {
  const old = await import(resolve(process.env.BASELINE_BUILD, 'ashare/audit.js'));
  const a = old.auditCache(db, START, END);
  const reclassified = [];
  for (const [i, d] of before.days.entries()) {
    const o = a.days[i];
    if (o.pending_delisting !== d.pending_delisting || o.unexplained_missing !== d.unexplained_missing) {
      reclassified.push({ trade_date: d.trade_date, old: { pending: o.pending_delisting, unexplained: o.unexplained_missing }, new: { pending: d.pending_delisting, unexplained: d.unexplained_missing, upstream: d.upstream_missing }, sample: d.unexplained_sample.slice(0, 5) });
    }
  }
  out.audit_old_rules = { status: a.status, counts: a.counts, totals: a.totals };
  pass('b0_1_reclassification', true, { days_changed: reclassified.length, reclassified: reclassified.slice(0, 50) });
}
// Independent recount: pending delisting = delisting date set, not suspended, no bar that day or on any later day.
const pendingSql = db.prepare(`SELECT COUNT(*) n FROM stock_basic b WHERE b.list_date <= ?1 AND b.delist_date > ?1 AND b.delist_date <> ''
  AND EXISTS (SELECT 1 FROM daily x WHERE x.ts_code = b.ts_code AND x.trade_date < ?1)
  AND NOT EXISTS (SELECT 1 FROM daily x WHERE x.ts_code = b.ts_code AND x.trade_date >= ?1)
  AND NOT EXISTS (SELECT 1 FROM suspend_d s WHERE s.ts_code = b.ts_code AND s.trade_date = ?1)`);
const mismatch = before.days.filter(d => pendingSql.get(d.trade_date).n !== d.pending_delisting).map(d => d.trade_date);
pass('b0_1_pending_only_after_last_bar', mismatch.length === 0, { pending_stock_days: before.totals.pending_delisting_stock_days, mismatched_days: mismatch.slice(0, 20) });

// ---------------------------------------------------------------- 2. audit --fix touches only what it repairs
const t1 = Date.now();
const actions = await fillGaps(db, before);
const after = auditCache(db, START, END);
out.fix = { actions: actions.length, sample: actions.slice(0, 40), seconds: Math.round((Date.now() - t1) / 1000) };
out.audit_after = { status: after.status, counts: after.counts, totals: after.totals };
const repaired = new Set();
const wholeDays = new Map();
for (const a of actions) {
  const m = /^repair_(stock|bar|adj_factor|daily_basic|stk_limit) (\S+)$/.exec(a.action);
  if (m) {
    const datasets = m[1] === 'bar' ? ['daily'] : m[1] === 'stock' ? Object.keys(a.result).filter(k => ['daily', 'daily_basic', 'adj_factor', 'stk_limit'].includes(k)) : [m[1]];
    for (const table of datasets) repaired.add(`${table}|${m[2]}|${a.trade_date}`);
  }
  if (a.action === 'refresh_trade_date') wholeDays.set(a.trade_date, ['daily', 'daily_basic', 'adj_factor', 'stk_limit']);
  if (a.action.startsWith('refresh_datasets ')) wholeDays.set(a.trade_date, a.action.slice(17).split(','));
}
db.prepare('ATTACH DATABASE ? AS p').run(`file:${pristinePath}?mode=ro`);
const diffs = {};
let unexpected = [];
for (const t of ['daily', 'daily_basic', 'adj_factor', 'stk_limit']) {
  const changed = db.prepare(`SELECT ts_code, trade_date FROM (SELECT * FROM main.${t} EXCEPT SELECT * FROM p.${t})
    UNION SELECT ts_code, trade_date FROM (SELECT * FROM p.${t} EXCEPT SELECT * FROM main.${t})`).all();
  diffs[t] = changed.length;
  unexpected.push(...changed.filter(r => !repaired.has(`${t}|${r.ts_code}|${r.trade_date}`) && !(wholeDays.get(r.trade_date) ?? []).includes(t)).map(r => ({ table: t, ...r })));
}
pass('b0_2_unrelated_rows_unchanged', unexpected.length === 0, { changed_rows: diffs, repaired_stock_days: new Set([...repaired].map(key => key.slice(key.indexOf('|') + 1))).size, repaired_dataset_stock_days: repaired.size, whole_day_refreshes: Object.fromEntries(wholeDays), unexpected: unexpected.slice(0, 20) });
const derived = Object.fromEntries(['watchlist', 'watchlist_change', 'report', 'stock_score', 'signal_evidence'].map(t => {
  const difference = db.prepare(`SELECT COUNT(*) n FROM (SELECT * FROM main.${t} EXCEPT SELECT * FROM p.${t})`).get().n
    + db.prepare(`SELECT COUNT(*) n FROM (SELECT * FROM p.${t} EXCEPT SELECT * FROM main.${t})`).get().n;
  return [t, { rows: db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n, changed_rows: difference }];
}));
pass('b0_2_no_derived_state_written', Object.values(derived).every(t => t.changed_rows === 0), derived);
db.exec('DETACH DATABASE p');

// ---------------------------------------------------------------- 3. no future metadata in as-of financial queries
{
  const codes = db.prepare("SELECT DISTINCT ts_code FROM fina_indicator ORDER BY ts_code").all().map(r => r.ts_code);
  const step = Math.max(1, Math.floor(codes.length / 300));
  const asOfs = ['20240430', '20250331', '20250901', '20260415', '20260501', '20260801'];
  let checked = 0;
  const leaks = [];
  for (let i = 0; i < codes.length; i += step) {
    for (const asOf of asOfs) {
      const r = financialHistory(db, { ts_code: codes[i], as_of_date: asOf, limit: 40, include_revisions: true });
      const { source, ...body } = r; // provenance carries FinanceMCP fetch times (ISO), not data dates
      const later = (JSON.stringify(body).match(/\b20\d{6}\b/g) ?? []).filter(x => x > asOf);
      if (later.length || 'hidden_after_as_of' in r) leaks.push({ ts_code: codes[i], as_of: asOf, later: [...new Set(later)].slice(0, 5) });
      checked++;
    }
  }
  const a = financialHistory(db, { ts_code: '603400.SH', as_of_date: '20260501' });
  pass('b0_3_no_future_metadata', leaks.length === 0 && !JSON.stringify(a).includes('20260630'), { queries: checked, leaks: leaks.slice(0, 20), sample_603400_20260501_anomalies: a.anomalies });
}

// ---------------------------------------------------------------- 4. failed suspension refresh propagates
{
  const day = END;
  const susp = db.prepare('SELECT ts_code FROM suspend_d WHERE trade_date = ? ORDER BY ts_code LIMIT 1').get(day)?.ts_code;
  const rows = db.prepare('SELECT COUNT(*) n FROM suspend_d WHERE trade_date = ?').get(day).n;
  const q0 = checkQuality(db, day, false).status;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40001, msg: '参数异常：模拟失败（verify-b0）' }) });
  let r;
  try { r = await syncSuspend(db, day, true); } finally { globalThis.fetch = realFetch; }
  const q1 = checkQuality(db, day, false);
  const h = susp ? stockHistory(db, { ts_code: susp, start_date: '20261009', end_date: day }) : null;
  const m = marketData(db, { end_date: day });
  const kept = db.prepare('SELECT COUNT(*) n FROM suspend_d WHERE trade_date = ?').get(day).n;
  const r2 = await syncSuspend(db, day, true); // real Tushare request
  const q2 = checkQuality(db, day, false);
  pass('b0_4_suspend_refresh_failure', q0 === 'READY' && r.refresh_status === 'REFRESH_FAILED' && kept === rows && q1.status === 'DEGRADED' && q1.cache_status === 'READY'
    && m.days[0].breadth.suspended_source === 'stale_cache' && (!h || (h.coverage.suspend_refresh_failed_days.includes(day) && h.data_quality.status === 'DEGRADED' && h.data_quality.trade_date === day)) && r2.refresh_status === 'REFRESH_OK' && q2.status === 'READY',
    { trade_date: day, before: q0, suspend_rows: rows, kept_after_failure: kept, during: { status: q1.status, cache_status: q1.cache_status, reasons: q1.reasons, market_suspended_source: m.days[0].breadth.suspended_source, history_warning: h?.warnings.find(w => /停牌/.test(w)) }, after_real_refresh: { refresh_status: r2.refresh_status, rows: r2.rows, status: q2.status } });
}

out.finished_at = new Date().toISOString();
out.ok = Object.values(out.checks).every(c => c.ok);
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
db.close();
process.exitCode = out.ok ? 0 : 1;
