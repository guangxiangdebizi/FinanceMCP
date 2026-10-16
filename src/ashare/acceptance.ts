import type { DatabaseSync } from 'node:sqlite';
import { previousTradeDay, recentTradeDays } from './ingest.js';
import { latestReportMeta, loadReport, ReportMeta } from './report.js';

/**
 * Continuous live acceptance for one trading day. A day passes only when all
 * of these hold:
 * - scheduled_runs: at least two live pipeline reports were generated on the
 *   trading day itself (Beijing time), i.e. both timer runs fired and finished;
 * - data_rechecked: Tushare `daily` was fetched at least twice that day, so the
 *   later run re-checked the day's quotes instead of trusting the first result;
 * - final_status: the last live report is READY. DEGRADED (a non-core gap such
 *   as stk_limit coverage or a missing non-core index) passes only with
 *   `allowDegraded`, and is then reported as PASS_DEGRADED, never as PASS;
 * - mcp_consistent: the report the MCP tools serve for the date is that final
 *   live report;
 * - watchlist_continuous: the final list links to the previous trading day's
 *   list and its size equals previous + added − removed.
 * A day that is today before the second run (21:10 CST) is PENDING.
 */
export interface AcceptanceDay {
  trade_date: string;
  result: 'PASS' | 'PASS_DEGRADED' | 'FAIL' | 'PENDING';
  failed: string[];
  live_runs: { report_id: string; status: string; generated_at: string; same_day: boolean }[];
  daily_fetches: { synced_at: string; rows: number; status: string; message: string }[];
  final: { report_id: string; status: string; generated_at: string; reasons: string[] } | null;
  mcp_report_id: string | null;
  watchlist: { previous_date: string | null; expected_previous: string | null; count: number | null; previous_count: number | null; added: number; removed: number } | null;
}

const cstDate = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
const cstHourMinute = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(11, 16);

export function acceptanceDay(db: DatabaseSync, day: string, opts: { allowDegraded?: boolean; now?: Date } = {}): AcceptanceDay {
  const now = opts.now ?? new Date();
  const metas = db.prepare("SELECT * FROM report WHERE trade_date = ? AND run_mode = 'live' ORDER BY generated_at").all(day) as unknown as ReportMeta[];
  const live = metas.map(meta => ({ meta, report: loadReport(meta) }));
  const runs = live.map(x => ({
    report_id: x.meta.report_id, status: x.meta.status, generated_at: x.report.generated_at,
    same_day: cstDate(x.report.generated_at) === day,
  }));
  const fetches = (db.prepare("SELECT synced_at, rows, status, message FROM sync_history WHERE dataset = 'daily' AND key = ? ORDER BY synced_at").all(day) as any[])
    .map(r => ({ synced_at: r.synced_at, rows: r.rows, status: r.status, message: r.message }));
  const final = live.at(-1);
  const served = latestReportMeta(db, day);

  let watchlist: AcceptanceDay['watchlist'] = null;
  if (final && final.report.watchlist) {
    const expected = previousTradeDay(db, day) ?? null;
    const count = (date: string | null) => date
      ? (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE trade_date = ?').get(date) as any).n as number
      : null;
    watchlist = {
      previous_date: final.report.watchlist.previous_date ?? null,
      expected_previous: expected,
      count: count(day),
      previous_count: count(expected),
      added: final.report.watchlist.added?.length ?? 0,
      removed: final.report.watchlist.removed?.length ?? 0,
    };
  }

  const failed: string[] = [];
  if (runs.filter(r => r.same_day).length < 2) failed.push('scheduled_runs');
  if (fetches.filter(f => cstDate(f.synced_at) === day).length < 2) failed.push('data_rechecked');
  const status = final?.meta.status;
  if (status !== 'READY' && !(status === 'DEGRADED' && opts.allowDegraded)) failed.push('final_status');
  if (!final || served?.report_id !== final.meta.report_id) failed.push('mcp_consistent');
  if (!watchlist || watchlist.previous_date !== watchlist.expected_previous
    || watchlist.count !== (watchlist.previous_count ?? 0) + watchlist.added - watchlist.removed) failed.push('watchlist_continuous');

  const pending = failed.length > 0 && cstDate(now.toISOString()) === day && cstHourMinute(now) < '21:15';
  return {
    trade_date: day,
    result: pending ? 'PENDING' : failed.length ? 'FAIL' : status === 'DEGRADED' ? 'PASS_DEGRADED' : 'PASS',
    failed,
    live_runs: runs,
    daily_fetches: fetches,
    final: final ? { report_id: final.meta.report_id, status: final.meta.status, generated_at: final.report.generated_at, reasons: final.report.data?.quality?.reasons ?? [] } : null,
    mcp_report_id: served?.report_id ?? null,
    watchlist,
  };
}

export function acceptance(db: DatabaseSync, end: string, days: number, opts: { allowDegraded?: boolean; now?: Date } = {}) {
  const tradeDays = recentTradeDays(db, end, days);
  const checks = tradeDays.map(day => acceptanceDay(db, day, opts));
  return {
    required_consecutive_days: days,
    allow_degraded: !!opts.allowDegraded,
    trade_days: tradeDays,
    passed: checks.length === days && checks.every(c => c.result === 'PASS' || c.result === 'PASS_DEGRADED'),
    criteria: ['scheduled_runs', 'data_rechecked', 'final_status', 'mcp_consistent', 'watchlist_continuous'],
    checks,
  };
}
