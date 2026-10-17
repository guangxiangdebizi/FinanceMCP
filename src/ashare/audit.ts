import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashareDataDir, logSync, upsertRows } from './db.js';
import { fetchAll } from './fetch.js';
import {
  checkQuality, CORE_INDICES, DATED_DATASETS, GAP_CHECK_MAX_AGE_DAYS, gapCheckFresh, REQUIRED_INDICES, syncIndexRange, syncSuspend, syncTradeDate, tradeDaysBetween,
} from './ingest.js';

/**
 * Cache audit (audit-1.1.0): a repeatable check of stored history that does
 * not rely on whole-market row ratios alone. For each trade date:
 * - every stock listed on that date (current stock_basic) without a `daily`
 *   bar is classified, in this order, as suspended (suspend_d), pending
 *   delisting, confirmed missing upstream (a per-stock Tushare check in
 *   gap_check, younger than GAP_CHECK_MAX_AGE_DAYS, found neither a bar nor a
 *   suspension), an expired upstream check due for a re-check, or an
 *   unexplained gap. Pending delisting needs a delisting date AND no bar of
 *   the stock on any later date: a hole between two bars of a stock that was
 *   delisted years later is a gap like any other. The delisting date is
 *   hindsight (current stock_basic), so this class describes the cache, not
 *   what was known on that day;
 * - traded stocks without adj_factor / daily_basic / stk_limit;
 * - missing core and optional indices;
 * - invalid OHLC, volume or amount, and pct_chg inconsistent with pre_close;
 * - pre_close inconsistent with the previous close after adjustment (a sign
 *   of mixed revisions across days);
 * - adj_factor changing between consecutive bars by enough to move the
 *   previous close by at least one tick (0.01) while pre_close still equals
 *   the previous raw close: factor precision noise or an upstream revision
 *   that only part of the stored history has picked up (smaller changes are
 *   sub-tick dividends and are not flagged);
 * - sync_log says ok but fewer rows are stored than were written;
 * - latest refresh incomplete/failed (suspend_d included), and suspension
 *   data not yet synced.
 * GAP = something to re-fetch; WARN = disclosed but not a gap; OK otherwise.
 */
export const AUDIT_VERSION = 'audit-1.1.0';

/**
 * A gap_check row records what Tushare answered at `checked_at`; an empty
 * answer is not proof that the data can never exist. Older checks expire and
 * are re-asked by the next `audit --fix`.
 */
export { GAP_CHECK_MAX_AGE_DAYS } from './ingest.js';

export interface AuditDay {
  trade_date: string;
  status: 'OK' | 'WARN' | 'GAP';
  issues: string[];
  daily: number;
  listed: number;
  suspended: number;
  pending_delisting: number;
  upstream_missing: number;
  upstream_missing_sample: string[];
  /** Upstream checks older than GAP_CHECK_MAX_AGE_DAYS: re-checked by --fix, not a cache gap yet. */
  upstream_check_expired: string[];
  suspend_synced: boolean;
  unexplained_missing: number;
  unexplained_sample: string[];
  missing_adj_factor: number;
  missing_daily_basic: number;
  missing_stk_limit: number;
  missing_core_indices: string[];
  missing_optional_indices: string[];
  invalid_bars: number;
  invalid_bar_codes: string[];
  pct_chg_inconsistent: number;
  pre_close_conflicts: number;
  factor_revision_boundaries: string[];
  logged_ok_but_short: { dataset: string; logged: number; stored: number }[];
  refresh_issues: string[];
}

/** Stocks listed on `day` (current stock_basic) without a daily bar that nothing explains. */
export function unexplainedStocks(db: DatabaseSync, day: string): string[] {
  return auditMissing(db, day).unexplained;
}

function auditMissing(db: DatabaseSync, day: string, now = Date.now()) {
  const missing = db.prepare(`
    SELECT b.ts_code, b.delist_date, s.ts_code IS NOT NULL suspended,
      g.upstream_daily = 0 AND g.upstream_suspended = 0 AS upstream_missing, g.checked_at,
      EXISTS (SELECT 1 FROM daily x WHERE x.ts_code = b.ts_code AND x.trade_date < ?) traded_before,
      EXISTS (SELECT 1 FROM daily x WHERE x.ts_code = b.ts_code AND x.trade_date > ?) traded_later
    FROM stock_basic b LEFT JOIN suspend_d s ON s.trade_date = ? AND s.ts_code = b.ts_code
    LEFT JOIN gap_check g ON g.ts_code = b.ts_code AND g.trade_date = ?
    WHERE b.list_date <= ? AND (b.delist_date IS NULL OR b.delist_date = '' OR b.delist_date > ?)
      AND NOT EXISTS (SELECT 1 FROM daily d WHERE d.ts_code = b.ts_code AND d.trade_date = ?)`).all(day, day, day, day, day, day, day) as any[];
  let suspended = 0;
  let pending = 0;
  const unexplained: string[] = [];
  const upstreamMissing: string[] = [];
  const expired: string[] = [];
  for (const m of missing) {
    if (m.suspended) suspended++;
    // Current delisting metadata plus a known last bar before this day supports the hindsight class.
    // No cached bars at all or a hole followed by later bars remains a gap.
    else if (m.delist_date && m.traded_before && !m.traded_later) pending++;
    else if (m.upstream_missing && gapCheckFresh(m.checked_at, now)) upstreamMissing.push(m.ts_code);
    else if (m.upstream_missing) expired.push(m.ts_code);
    else unexplained.push(m.ts_code);
  }
  return { suspended, pending, unexplained, upstreamMissing, expired };
}

const INVALID_BAR = `close IS NULL OR close <= 0 OR open <= 0 OR high < low OR close > high * 1.0001 OR close < low * 0.9999
  OR open > high * 1.0001 OR open < low * 0.9999 OR vol < 0 OR amount < 0 OR (vol > 0 AND (amount IS NULL OR amount <= 0))`;

export function auditDay(db: DatabaseSync, day: string, prev?: string): AuditDay {
  const issues: string[] = [];
  let gap = false;
  const daily = (db.prepare('SELECT COUNT(*) n FROM daily WHERE trade_date = ?').get(day) as any).n as number;
  const listed = (db.prepare("SELECT COUNT(*) n FROM stock_basic WHERE list_date <= ? AND (delist_date IS NULL OR delist_date = '' OR delist_date > ?)").get(day, day) as any).n as number;
  const suspendSynced = !!db.prepare("SELECT 1 FROM sync_log WHERE dataset = 'suspend_d' AND key = ? AND status = 'ok'").get(day);
  const { suspended, pending, unexplained, upstreamMissing, expired } = auditMissing(db, day);
  if (upstreamMissing.length) issues.push(`${upstreamMissing.length} 只上市股票上游确认无行情且无停牌记录（非本地缓存缺口）`);
  if (expired.length) issues.push(`${expired.length} 只股票的上游缺失确认已超过 ${GAP_CHECK_MAX_AGE_DAYS} 天，需重新核对`);
  if (!daily) { issues.push('整日缺少 daily 行情'); gap = true; }
  if (unexplained.length) {
    if (suspendSynced) { issues.push(`${unexplained.length} 只上市股票无行情且无停牌记录`); gap = true; }
    else issues.push(`${unexplained.length} 只上市股票无行情，停牌数据未同步，无法区分停牌与缺口`);
  }
  const notJoined = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM daily d LEFT JOIN ${table} t ON t.ts_code = d.ts_code AND t.trade_date = d.trade_date WHERE d.trade_date = ? AND t.ts_code IS NULL`).get(day) as any).n as number;
  const missingAdj = notJoined('adj_factor');
  const missingBasic = notJoined('daily_basic');
  const missingLimit = notJoined('stk_limit');
  if (missingAdj) { issues.push(`${missingAdj} 条行情缺少复权因子`); gap = true; }
  if (missingBasic) issues.push(`${missingBasic} 条行情缺少每日指标`);
  if (missingLimit) issues.push(`${missingLimit} 条行情缺少涨跌停价`);
  const indices = new Set((db.prepare('SELECT ts_code FROM index_daily WHERE trade_date = ?').all(day) as any[]).map(r => r.ts_code));
  const missingCore = REQUIRED_INDICES.filter(c => !indices.has(c));
  const missingOptional = Object.keys(CORE_INDICES).filter(c => !REQUIRED_INDICES.includes(c) && !indices.has(c));
  if (missingCore.length) { issues.push(`核心指数缺失 ${missingCore.join(',')}`); gap = true; }
  if (missingOptional.length) issues.push(`非核心指数缺失 ${missingOptional.join(',')}`);
  const invalidCodes = (db.prepare(`SELECT ts_code FROM daily WHERE trade_date = ? AND (${INVALID_BAR}) ORDER BY ts_code`).all(day) as any[]).map(r => r.ts_code as string);
  const bad = db.prepare(`SELECT
      SUM(CASE WHEN pre_close > 0 AND ABS((close / pre_close - 1) * 100 - pct_chg) > 0.05 THEN 1 ELSE 0 END) pct
    FROM daily WHERE trade_date = ?`).get(day) as any;
  const invalid = invalidCodes.length;
  const pct = Number(bad.pct ?? 0);
  if (invalid) { issues.push(`${invalid} 条行情 OHLC/成交量/成交额非法`); gap = true; }
  if (pct) issues.push(`${pct} 条行情涨跌幅与昨收不一致`);
  let conflicts = 0;
  if (prev) {
    conflicts = (db.prepare(`SELECT COUNT(*) n FROM daily d
      JOIN daily p ON p.ts_code = d.ts_code AND p.trade_date = ?
      JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
      JOIN adj_factor b ON b.ts_code = p.ts_code AND b.trade_date = p.trade_date
      WHERE d.trade_date = ? AND d.pre_close > 0 AND ABS(p.close * b.adj_factor / a.adj_factor / d.pre_close - 1) > 0.005`).get(prev, day) as any).n;
    if (conflicts) issues.push(`${conflicts} 条昨收与前一交易日复权收盘不一致（可能混入了不同时间的修订）`);
  }
  const revisions = prev ? (db.prepare(`SELECT d.ts_code FROM daily d
      JOIN daily p ON p.ts_code = d.ts_code AND p.trade_date = ?
      JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
      JOIN adj_factor b ON b.ts_code = p.ts_code AND b.trade_date = p.trade_date
      WHERE d.trade_date = ? AND a.adj_factor <> b.adj_factor AND ABS(d.pre_close - p.close) < 0.005
        AND p.close * ABS(a.adj_factor / b.adj_factor - 1) >= 0.01
      ORDER BY d.ts_code`).all(prev, day) as any[]).map(r => r.ts_code) : [];
  if (revisions.length) issues.push(`${revisions.length} 只股票复权因子变化与昨收不一致（昨收等于前收盘，因子变化却超过 1 个价位；因子精度或上游修订）: ${revisions.slice(0, 5).join(',')}`);
  const short: AuditDay['logged_ok_but_short'] = [];
  for (const ds of DATED_DATASETS) {
    const log = db.prepare('SELECT status, rows, after_rows FROM sync_log WHERE dataset = ? AND key = ?').get(ds.table, day) as any;
    if (log?.status !== 'ok') continue;
    const logged = log.after_rows ?? log.rows;
    const stored = (db.prepare(`SELECT COUNT(*) n FROM ${ds.table} WHERE trade_date = ?`).get(day) as any).n;
    if (stored < logged * 0.97) short.push({ dataset: ds.table, logged, stored });
  }
  if (short.length) { issues.push(`同步记录为 ok 但缓存条数不足: ${short.map(x => `${x.dataset} ${x.stored}/${x.logged}`).join(', ')}`); gap = true; }
  const refreshIssues = (db.prepare("SELECT dataset, refresh_status FROM sync_log WHERE key = ? AND refresh_status IN ('REFRESH_INCOMPLETE', 'REFRESH_FAILED')").all(day) as any[])
    .map(r => `${r.dataset}:${r.refresh_status}`);
  if (refreshIssues.length) issues.push(`最新一次刷新异常: ${refreshIssues.join(', ')}`);
  if (!suspendSynced && !unexplained.length) issues.push('停牌数据未同步');
  return {
    trade_date: day,
    status: gap ? 'GAP' : issues.length ? 'WARN' : 'OK',
    issues,
    daily,
    listed,
    suspended,
    pending_delisting: pending,
    upstream_missing: upstreamMissing.length,
    upstream_missing_sample: upstreamMissing.slice(0, 20),
    upstream_check_expired: expired,
    suspend_synced: suspendSynced,
    unexplained_missing: unexplained.length,
    unexplained_sample: unexplained.slice(0, 20),
    missing_adj_factor: missingAdj,
    missing_daily_basic: missingBasic,
    missing_stk_limit: missingLimit,
    missing_core_indices: missingCore,
    missing_optional_indices: missingOptional,
    invalid_bars: invalid,
    invalid_bar_codes: invalidCodes.slice(0, 200),
    pct_chg_inconsistent: pct,
    pre_close_conflicts: conflicts,
    factor_revision_boundaries: revisions,
    logged_ok_but_short: short,
    refresh_issues: refreshIssues,
  };
}

export interface AuditResult {
  audit_id: string;
  version: string;
  start: string;
  end: string;
  created_at: string;
  status: 'OK' | 'WARN' | 'GAP';
  trade_days: number;
  counts: Record<'OK' | 'WARN' | 'GAP', number>;
  totals: Record<string, number>;
  /** Cache-wide findings that are not tied to one date. */
  global: Record<string, unknown>;
  days: AuditDay[];
}

export function auditCache(db: DatabaseSync, start: string, end: string): AuditResult {
  const tradeDays = tradeDaysBetween(db, start, end);
  const allOpen = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date < ? ORDER BY cal_date DESC LIMIT 1').get(start) as any)?.cal_date;
  const days = tradeDays.map((d, i) => auditDay(db, d, i ? tradeDays[i - 1] : allOpen));
  const counts = { OK: 0, WARN: 0, GAP: 0 };
  for (const d of days) counts[d.status]++;
  const sum = (k: keyof AuditDay) => days.reduce((s, d) => s + (d[k] as number), 0);
  const orphan = db.prepare('SELECT ts_code, COUNT(*) bars, MIN(trade_date) first, MAX(trade_date) last FROM daily WHERE trade_date BETWEEN ? AND ? AND ts_code NOT IN (SELECT ts_code FROM stock_basic) GROUP BY ts_code').all(start, end);
  const finaAnomalies = db.prepare('SELECT ts_code, end_date, ann_date FROM fina_indicator WHERE ann_date < end_date ORDER BY ts_code').all();
  const createdAt = new Date().toISOString();
  return {
    audit_id: `AUD-${start}-${end}-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`,
    version: AUDIT_VERSION,
    start,
    end,
    created_at: createdAt,
    status: counts.GAP ? 'GAP' : counts.WARN ? 'WARN' : 'OK',
    trade_days: days.length,
    counts,
    totals: {
      suspended_stock_days: sum('suspended'),
      pending_delisting_stock_days: sum('pending_delisting'),
      upstream_missing_stock_days: sum('upstream_missing'),
      upstream_check_expired_stock_days: days.reduce((n, d) => n + d.upstream_check_expired.length, 0),
      unexplained_missing_stock_days: sum('unexplained_missing'),
      days_without_suspend_data: days.filter(d => !d.suspend_synced).length,
      missing_adj_factor: sum('missing_adj_factor'),
      missing_daily_basic: sum('missing_daily_basic'),
      missing_stk_limit: sum('missing_stk_limit'),
      invalid_bars: sum('invalid_bars'),
      pct_chg_inconsistent: sum('pct_chg_inconsistent'),
      pre_close_conflicts: sum('pre_close_conflicts'),
      factor_revision_boundaries: days.reduce((n, d) => n + d.factor_revision_boundaries.length, 0),
    },
    global: {
      codes_with_quotes_but_not_in_stock_basic: orphan,
      fina_ann_date_before_period_end: finaAnomalies,
    },
    days,
  };
}

/** Persist an audit: full JSON under audits/, summary row in data_audit. */
export function saveAudit(db: DatabaseSync, audit: AuditResult, extra: Record<string, unknown> = {}): string {
  const dir = join(ashareDataDir(), 'audits');
  mkdirSync(dir, { recursive: true });
  const rel = join('audits', `${audit.audit_id}.json`);
  writeFileSync(join(ashareDataDir(), rel), JSON.stringify({ ...audit, ...extra }, null, 2));
  const summary = { status: audit.status, trade_days: audit.trade_days, counts: audit.counts, totals: audit.totals, ...extra };
  db.prepare('INSERT INTO data_audit (audit_id, created_at, start_date, end_date, status, summary, path) VALUES (?,?,?,?,?,?,?)')
    .run(audit.audit_id, audit.created_at, audit.start, audit.end, audit.status, JSON.stringify(summary), rel);
  return rel;
}

/**
 * Re-fetch only what the audit found missing, with the existing sync rules,
 * and never more than the defect needs:
 * - a date without any quotes is refreshed as a whole-market batch for all
 *   four datasets (a complete answer replaces the date, a short one is kept out);
 * - a dataset whose stored rows are fewer than a logged success wrote is
 *   refreshed for that dataset only;
 * - an invalid bar is re-fetched for that stock and date only (daily);
 * - missing adj_factor / daily_basic / stk_limit rows are fetched for that stock and date only;
 * - an unexplained (or expired upstream-checked) hole is repaired per stock:
 *   the bar first, then only those of daily_basic / adj_factor / stk_limit
 *   that are missing for that stock and date.
 * So stocks without a gap, and datasets without a defect, are never rewritten
 * with upstream values revised since they were stored. A stock still missing
 * afterwards is checked against Tushare suspend_d by code: a suspension found
 * that way is stored, and the answer is recorded in gap_check with its time
 * (it expires after GAP_CHECK_MAX_AGE_DAYS). Dates without suspension data get
 * suspend_d, and missing index bars are fetched for that date. Quality checks
 * are recomputed for touched dates. Watchlists and reports are never written here.
 */
export async function fillGaps(db: DatabaseSync, audit: AuditResult) {
  const actions: { trade_date: string; action: string; result: unknown }[] = [];
  // Per-stock repairs are logged under their own dataset name so the date-level sync_log rows keep their meaning.
  const repairLog = (table: string, code: string, day: string, rows: number) =>
    logSync(db, `repair:${table}`, `${code}:${day}`, rows, rows ? 'ok' : 'empty', 'audit --fix per-stock repair', { refresh_status: 'REFRESH_OK', write_mode: rows ? 'merged' : 'none' });
  const fetchStock = async (table: string, code: string, day: string) => {
    const ds = DATED_DATASETS.find(x => x.table === table)!;
    const rows = (await fetchAll(ds.api, { ts_code: code, start_date: day, end_date: day }, ds.fields)).filter(r => r.ts_code === code && r.trade_date === day);
    upsertRows(db, ds.table, ds.fields.split(','), rows);
    repairLog(ds.table, code, day, rows.length);
    return rows.length;
  };
  const stored = (table: string, code: string, day: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE ts_code = ? AND trade_date = ?`).get(code, day);
  const summarize = (r: Awaited<ReturnType<typeof syncTradeDate>>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { refresh_status: v.refresh_status, write: v.write, rows: v.rows }]));
  for (const d of audit.days) {
    let touched = false;
    if (d.daily === 0) {
      const r = await syncTradeDate(db, d.trade_date, 'refresh');
      actions.push({ trade_date: d.trade_date, action: 'refresh_trade_date', result: summarize(r) });
      touched = true;
    } else if (d.logged_ok_but_short.length) {
      const only = d.logged_ok_but_short.map(x => x.dataset);
      const r = await syncTradeDate(db, d.trade_date, 'refresh', only);
      actions.push({ trade_date: d.trade_date, action: `refresh_datasets ${only.join(',')}`, result: summarize(r) });
      touched = true;
    }
    if (d.daily && d.invalid_bars) {
      // invalid_bar_codes is a bounded display sample, never the repair worklist.
      const codes = (db.prepare(`SELECT ts_code FROM daily WHERE trade_date = ? AND (${INVALID_BAR}) ORDER BY ts_code`).all(d.trade_date) as any[]).map(r => r.ts_code);
      for (const code of codes) {
        const n = await fetchStock('daily', code, d.trade_date);
        actions.push({ trade_date: d.trade_date, action: `repair_bar ${code}`, result: { rows: n } });
      }
      touched = true;
    }
    if (!d.suspend_synced || d.refresh_issues.some(issue => issue.startsWith('suspend_d:'))) {
      const r = await syncSuspend(db, d.trade_date, true);
      actions.push({ trade_date: d.trade_date, action: 'sync_suspend_d', result: { refresh_status: r.refresh_status, rows: r.rows } });
      touched = true;
    }
    for (const code of [...d.missing_core_indices, ...d.missing_optional_indices]) {
      const n = await syncIndexRange(db, code, d.trade_date, d.trade_date);
      actions.push({ trade_date: d.trade_date, action: `index_daily ${code}`, result: { rows: n } });
      touched = true;
    }
    for (const table of ['adj_factor', 'daily_basic', 'stk_limit']) {
      // Re-query after any whole-date refresh and repair only still-missing rows.
      const codes = (db.prepare(`SELECT d.ts_code FROM daily d LEFT JOIN ${table} t ON t.ts_code = d.ts_code AND t.trade_date = d.trade_date WHERE d.trade_date = ? AND t.ts_code IS NULL ORDER BY d.ts_code`).all(d.trade_date) as any[]).map(r => r.ts_code);
      for (const code of codes) {
        const n = await fetchStock(table, code, d.trade_date);
        actions.push({ trade_date: d.trade_date, action: `repair_${table} ${code}`, result: { rows: n } });
        touched = true;
      }
    }
    if (d.unexplained_missing || d.upstream_check_expired.length) {
      const { unexplained, expired } = auditMissing(db, d.trade_date);
      for (const code of [...unexplained, ...expired]) {
        const got: Record<string, number> = { daily: await fetchStock('daily', code, d.trade_date) };
        if (got.daily) {
          for (const ds of DATED_DATASETS) {
            if (ds.table !== 'daily' && !stored(ds.table, code, d.trade_date)) got[ds.table] = await fetchStock(ds.table, code, d.trade_date);
          }
        }
        let susp = 0;
        if (!got.daily) {
          const rows = (await fetchAll('suspend_d', { ts_code: code, start_date: d.trade_date, end_date: d.trade_date }, 'ts_code,trade_date,suspend_timing,suspend_type'))
            .filter(r => r.ts_code === code && r.trade_date === d.trade_date && r.suspend_type === 'S');
          upsertRows(db, 'suspend_d', ['ts_code', 'trade_date', 'suspend_timing'], rows);
          susp = rows.length;
        }
        db.prepare('INSERT OR REPLACE INTO gap_check (ts_code, trade_date, checked_at, upstream_daily, upstream_suspended) VALUES (?,?,?,?,?)')
          .run(code, d.trade_date, new Date().toISOString(), got.daily ? 1 : 0, susp);
        actions.push({ trade_date: d.trade_date, action: `repair_stock ${code}`, result: { ...got, suspended: susp } });
      }
      touched = true;
    }
    if (touched) checkQuality(db, d.trade_date);
  }
  return actions;
}
