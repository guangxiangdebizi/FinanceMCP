import type { DatabaseSync } from 'node:sqlite';
import { addDays, isTradeDay, latestTradeDay, shanghaiToday, syncTradeCal, tradeDaysBetween, recentTradeDays } from './ingest.js';
import { syncRange } from './sync.js';
import { generateReport } from './report.js';
import { resetWatchlistFrom } from './watchlist.js';
import { computeEvidence, evaluateWatchlist, loadVerdicts } from './evidence.js';
import { runAshareTool } from './tools.js';
import { ashareResearchDbPath, openResearchDb } from './db.js';
import { acceptance } from './acceptance.js';
import { auditCache, fillGaps, saveAudit } from './audit.js';

export interface CliHelpers {
  arg(name: string): string | undefined;
  flag(name: string): boolean;
  ymd(value: string | undefined, label: string): string;
  print(value: unknown): void;
}

const EVIDENCE_MAX_AGE_DAYS = 7;

function evidenceStart(db: DatabaseSync, end: string): string {
  const first = (db.prepare('SELECT MIN(trade_date) d FROM daily').get() as any).d as string;
  return first ?? addDays(end, -730);
}

/** Latest trade date with a live watchlist; earlier dates belong to the research database. */
function lastLiveDate(db: DatabaseSync): string | undefined {
  return (db.prepare('SELECT MAX(trade_date) d FROM watchlist').get() as any).d ?? undefined;
}

function withResearchDb<T>(fn: (rdb: DatabaseSync) => T): T {
  const rdb = openResearchDb();
  try {
    return fn(rdb);
  } finally {
    rdb.close();
  }
}

function reportSummary(meta: { report_id: string; trade_date: string; status: string; path: string; run_mode?: string | null }, report: any) {
  return {
    report_id: meta.report_id,
    run_mode: report.run_mode,
    trade_date: meta.trade_date,
    status: meta.status,
    path: meta.path,
    regime: report.market?.regime_label,
    watchlist_count: report.watchlist?.count,
    added: report.watchlist?.added?.length,
    removed: report.watchlist?.removed?.length,
    reasons: report.data.quality.reasons,
  };
}

export async function runCommand(db: DatabaseSync, command: string, h: CliHelpers): Promise<boolean> {
  switch (command) {
    case 'daily': {
      const date = h.arg('date') ? h.ymd(h.arg('date'), '--date') : shanghaiToday();
      // The live pipeline only moves forward: rebuilding an older day would break the
      // continuity of every later watchlist. Use `report` or `replay` (research database) instead.
      const last = lastLiveDate(db);
      if (last && last > date) throw new Error(`正式股票池已到 ${last}，daily 不能回写更早的 ${date}；历史日期请用 report --date ${date}（研究库）或 replay`);
      await syncTradeCal(db, addDays(date, -30), addDays(date, 30));
      if (!isTradeDay(db, date)) {
        h.print({ trade_date: date, skipped: true, reason: '非交易日' });
        return true;
      }
      // Fill in any of the last 5 trading days that are missing, and always re-query the
      // as-of day itself: the 21:10 run must re-check what the 18:40 run stored.
      const start = recentTradeDays(db, date, 5)[0];
      const sync = await syncRange(db, start, date, { refreshFrom: date });
      const evidence = loadVerdicts(db).meta;
      const ageDays = evidence.computed_at ? (Date.now() - Date.parse(evidence.computed_at)) / 86400_000 : Infinity;
      let evidenceRefreshed = false;
      if (ageDays > EVIDENCE_MAX_AGE_DAYS) {
        computeEvidence(db, evidenceStart(db, date), date);
        evidenceRefreshed = true;
      }
      const { meta, report } = generateReport(db, date, 'live');
      const { datasets, ...rest } = sync;
      h.print({ sync: { ...rest, quality: sync.quality.slice(-3), as_of_datasets: datasets[date] }, evidence_refreshed: evidenceRefreshed, report: reportSummary(meta, report) });
      return true;
    }
    case 'report': {
      // Manual reports always go to the research database: only `daily` writes live
      // reports and watchlists, even for the latest live date itself.
      const date = h.ymd(h.arg('date'), '--date');
      const summary = withResearchDb(rdb => { const { meta, report } = generateReport(rdb, date, 'manual'); return reportSummary(meta, report); });
      h.print({ space: 'research', research_db: ashareResearchDbPath(), live_latest: lastLiveDate(db) ?? null, ...summary });
      return true;
    }
    case 'replay': {
      // Replays always run in the research database: live watchlists and reports are read-only to them.
      const start = h.ymd(h.arg('start'), '--start');
      const end = h.ymd(h.arg('end'), '--end');
      const out = withResearchDb(rdb => {
        resetWatchlistFrom(rdb, start);
        return tradeDaysBetween(rdb, start, end).map(day => {
          const t0 = Date.now();
          const { meta, report } = generateReport(rdb, day, 'replay');
          const summary = reportSummary(meta, report);
          console.error(`[ashare] replay ${day} ${meta.status} 股票池 ${summary.watchlist_count ?? '-'} (+${summary.added ?? 0}/-${summary.removed ?? 0}) ${Date.now() - t0}ms`);
          return summary;
        });
      });
      h.print({ space: 'research', research_db: ashareResearchDbPath(), reports: out });
      return true;
    }
    case 'evidence': {
      const end = h.arg('end') ? h.ymd(h.arg('end'), '--end') : latestTradeDay(db, shanghaiToday())!;
      const start = h.arg('start') ? h.ymd(h.arg('start'), '--start') : evidenceStart(db, end);
      const result = computeEvidence(db, start, end);
      h.print({ ...result, rows: result.rows.filter(r => r.horizon === 10) });
      return true;
    }
    case 'pool-eval': {
      const start = h.ymd(h.arg('start'), '--start');
      const end = h.ymd(h.arg('end'), '--end');
      const run = (d: DatabaseSync) => evaluateWatchlist(d, start, end, Number(h.arg('horizon') || 5));
      h.print({ space: h.flag('research') ? 'research' : 'live', ...(h.flag('research') ? withResearchDb(run) : run(db)) });
      return true;
    }
    case 'acceptance': {
      const days = Number(h.arg('days') || 3);
      const end = h.arg('end') ? h.ymd(h.arg('end'), '--end') : latestTradeDay(db, shanghaiToday())!;
      h.print(acceptance(db, end, days, { allowDegraded: h.flag('allow-degraded') }));
      return true;
    }
    case 'audit': {
      // Data-module check of stored history; --fix re-fetches only what is missing.
      const end = h.arg('end') ? h.ymd(h.arg('end'), '--end') : latestTradeDay(db, shanghaiToday())!;
      const start = h.arg('start') ? h.ymd(h.arg('start'), '--start') : evidenceStart(db, end);
      const t0 = Date.now();
      const before = auditCache(db, start, end);
      const summary = (a: typeof before) => ({
        audit_id: a.audit_id, status: a.status, trade_days: a.trade_days, counts: a.counts, totals: a.totals,
        gap_days: a.days.filter(d => d.status === 'GAP').map(d => ({ trade_date: d.trade_date, issues: d.issues, unexplained_sample: d.unexplained_sample })),
        warn_issue_kinds: [...new Set(a.days.filter(d => d.status === 'WARN').flatMap(d => d.issues.map(i => i.replace(/^\d+ ?(只|条)?/, '#'))))].slice(0, 20),
        global: a.global,
      });
      if (!h.flag('fix')) {
        const path = saveAudit(db, before);
        h.print({ ...summary(before), path, seconds: Math.round((Date.now() - t0) / 1000) });
        return true;
      }
      const actions = await fillGaps(db, before);
      const after = auditCache(db, start, end);
      const beforePath = saveAudit(db, before, { followed_by: after.audit_id });
      const afterPath = saveAudit(db, after, { fixed_from: before.audit_id, actions });
      h.print({ before: { ...summary(before), path: beforePath }, actions_count: actions.length, actions: actions.slice(0, 100), after: { ...summary(after), path: afterPath }, seconds: Math.round((Date.now() - t0) / 1000) });
      return true;
    }
    case 'research-snapshot': {
      // Reads the live cache read-only and writes only to the separate snapshot database.
      const { runResearchSnapshot } = await import('./snapshot.js');
      h.print(runResearchSnapshot({
        date: h.ymd(h.arg('date'), '--date'),
        dbPath: h.arg('db'),
        revise: h.flag('revise'),
        horizon: h.arg('horizon') ? Number(h.arg('horizon')) : undefined,
      }));
      return true;
    }
    case 'research-evaluate': {
      const { runResearchEvaluate } = await import('./snapshot.js');
      h.print(runResearchEvaluate({
        date: h.ymd(h.arg('date'), '--date'),
        dbPath: h.arg('db'),
        asOf: h.arg('as-of') ? h.ymd(h.arg('as-of'), '--as-of') : undefined,
        horizon: h.arg('horizon') ? Number(h.arg('horizon')) : undefined,
      }));
      return true;
    }
    case 'status': {
      const result = await runAshareTool('ashare_data_status', { date: h.arg('date') });
      process.stdout.write(result.content[0].text + '\n');
      return true;
    }
    default:
      return false;
  }
}
