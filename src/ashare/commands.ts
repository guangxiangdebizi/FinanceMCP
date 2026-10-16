import type { DatabaseSync } from 'node:sqlite';
import { addDays, isTradeDay, latestTradeDay, shanghaiToday, syncTradeCal, tradeDaysBetween, recentTradeDays } from './ingest.js';
import { syncRange } from './sync.js';
import { generateReport, loadReport } from './report.js';
import { resetWatchlistFrom } from './watchlist.js';
import { computeEvidence, evaluateWatchlist, loadVerdicts } from './evidence.js';
import { runAshareTool } from './tools.js';

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

function reportSummary(meta: { report_id: string; trade_date: string; status: string; path: string }, report: any) {
  return {
    report_id: meta.report_id,
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
      await syncTradeCal(db, addDays(date, -30), addDays(date, 30));
      if (!isTradeDay(db, date)) {
        h.print({ trade_date: date, skipped: true, reason: '非交易日' });
        return true;
      }
      // Re-check the last 5 trading days so a missed run is filled in.
      const start = recentTradeDays(db, date, 5)[0];
      const sync = await syncRange(db, start, date);
      const evidence = loadVerdicts(db).meta;
      const ageDays = evidence.computed_at ? (Date.now() - Date.parse(evidence.computed_at)) / 86400_000 : Infinity;
      let evidenceRefreshed = false;
      if (ageDays > EVIDENCE_MAX_AGE_DAYS) {
        computeEvidence(db, evidenceStart(db, date), date);
        evidenceRefreshed = true;
      }
      const { meta, report } = generateReport(db, date, 'live');
      h.print({ sync: { ...sync, quality: sync.quality.slice(-3) }, evidence_refreshed: evidenceRefreshed, report: reportSummary(meta, report) });
      return true;
    }
    case 'report': {
      const date = h.ymd(h.arg('date'), '--date');
      const { meta, report } = generateReport(db, date, 'manual');
      h.print(reportSummary(meta, report));
      return true;
    }
    case 'replay': {
      const start = h.ymd(h.arg('start'), '--start');
      const end = h.ymd(h.arg('end'), '--end');
      resetWatchlistFrom(db, start);
      const out = [];
      for (const day of tradeDaysBetween(db, start, end)) {
        const t0 = Date.now();
        const { meta, report } = generateReport(db, day, 'replay');
        const summary = reportSummary(meta, report);
        console.error(`[ashare] replay ${day} ${meta.status} 股票池 ${summary.watchlist_count ?? '-'} (+${summary.added ?? 0}/-${summary.removed ?? 0}) ${Date.now() - t0}ms`);
        out.push(summary);
      }
      h.print(out);
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
      h.print(evaluateWatchlist(db, start, end, Number(h.arg('horizon') || 5)));
      return true;
    }
    case 'acceptance': {
      // Continuous live acceptance: the last N trading days each have a READY
      // report produced by the daily pipeline on the trading day itself (CST).
      const days = Number(h.arg('days') || 3);
      const end = latestTradeDay(db, shanghaiToday())!;
      const tradeDays = recentTradeDays(db, end, days);
      const checks = tradeDays.map(day => {
        const metas = db.prepare('SELECT * FROM report WHERE trade_date = ? ORDER BY generated_at').all(day) as any[];
        const live = metas.map(m => ({ meta: m, report: loadReport(m) })).filter(x => x.report.run_mode === 'live');
        const ready = live.filter(x => x.report.status !== 'NOT_READY');
        const sameDay = ready.filter(x => String(x.report.generated_at).slice(0, 10).replace(/-/g, '') === day);
        const final = ready.at(-1);
        return {
          trade_date: day,
          live_runs: live.map(x => ({ report_id: x.meta.report_id, status: x.meta.status, generated_at: x.report.generated_at })),
          ready_report: final?.meta.report_id ?? null,
          watchlist: final ? { count: final.report.watchlist?.count, added: final.report.watchlist?.added?.length, removed: final.report.watchlist?.removed?.length } : null,
          published_same_day: sameDay.length > 0,
          pass: sameDay.length > 0,
        };
      });
      h.print({ required_consecutive_days: days, trade_days: tradeDays, passed: checks.every(c => c.pass), checks });
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
