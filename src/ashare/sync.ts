import type { DatabaseSync } from 'node:sqlite';
import { fetchStats } from './fetch.js';
import {
  addDays, DatasetSync, checkQuality, QualityReport, shanghaiToday, syncFinaIndicator, syncIndexDaily,
  syncStockBasic, syncTradeCal, syncTradeDate, tradeDaysBetween,
} from './ingest.js';

export interface SyncSummary {
  start: string;
  end: string;
  trade_days: number;
  /** Dates re-queried from Tushare even though they were already synced. */
  refreshed: string[];
  datasets: Record<string, Record<string, DatasetSync>>;
  quality: Pick<QualityReport, 'trade_date' | 'status' | 'reasons'>[];
  fina?: Record<string, number>;
  tushare: typeof fetchStats;
  seconds: number;
}

/**
 * Incremental sync: calendar, stock list, then each trading day in the range
 * as whole-market batches, the core indices and the financial indicators.
 * Days on or after `refreshFrom` are re-queried even when already complete.
 */
export async function syncRange(db: DatabaseSync, start: string, end: string, opts: { force?: boolean; fina?: boolean; refreshFrom?: string } = {}): Promise<SyncSummary> {
  const t0 = Date.now();
  await syncTradeCal(db, addDays(start, -400), addDays(shanghaiToday(), 30));
  await syncStockBasic(db);
  const days = tradeDaysBetween(db, start, end);
  const quality: SyncSummary['quality'] = [];
  const refreshed: string[] = [];
  const datasets: SyncSummary['datasets'] = {};
  for (const [i, day] of days.entries()) {
    const refresh = opts.force || (opts.refreshFrom !== undefined && day >= opts.refreshFrom);
    if (refresh) refreshed.push(day);
    datasets[day] = await syncTradeDate(db, day, refresh ? 'refresh' : 'skip_ok');
    console.error(`[ashare] ${day} (${i + 1}/${days.length}) ${JSON.stringify(datasets[day])}`);
  }
  await syncIndexDaily(db, end, addDays(start, -400), opts.refreshFrom);
  for (const day of days) {
    const q = checkQuality(db, day);
    quality.push({ trade_date: q.trade_date, status: q.status, reasons: q.reasons });
  }
  const fina = opts.fina === false ? undefined : await syncFinaIndicator(db, end);
  return { start, end, trade_days: days.length, refreshed, datasets, quality, fina, tushare: { ...fetchStats }, seconds: Math.round((Date.now() - t0) / 1000) };
}
