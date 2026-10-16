import type { DatabaseSync } from 'node:sqlite';
import { fetchStats } from './fetch.js';
import {
  addDays, checkQuality, QualityReport, shanghaiToday, syncFinaIndicator, syncIndexDaily,
  syncStockBasic, syncTradeCal, syncTradeDate, tradeDaysBetween,
} from './ingest.js';

export interface SyncSummary {
  start: string;
  end: string;
  trade_days: number;
  quality: Pick<QualityReport, 'trade_date' | 'status' | 'reasons'>[];
  fina?: Record<string, number>;
  tushare: typeof fetchStats;
  seconds: number;
}

/**
 * Incremental sync: calendar, stock list, then each trading day in the range
 * as whole-market batches, the core indices and the financial indicators.
 */
export async function syncRange(db: DatabaseSync, start: string, end: string, opts: { force?: boolean; fina?: boolean } = {}): Promise<SyncSummary> {
  const t0 = Date.now();
  await syncTradeCal(db, addDays(start, -400), addDays(shanghaiToday(), 30));
  await syncStockBasic(db);
  const days = tradeDaysBetween(db, start, end);
  const quality: SyncSummary['quality'] = [];
  for (const [i, day] of days.entries()) {
    const counts = await syncTradeDate(db, day, opts.force);
    console.error(`[ashare] ${day} (${i + 1}/${days.length}) ${JSON.stringify(counts)}`);
  }
  await syncIndexDaily(db, end, addDays(start, -400));
  for (const day of days) {
    const q = checkQuality(db, day);
    quality.push({ trade_date: q.trade_date, status: q.status, reasons: q.reasons });
  }
  const fina = opts.fina === false ? undefined : await syncFinaIndicator(db, end);
  return { start, end, trade_days: days.length, quality, fina, tushare: { ...fetchStats }, seconds: Math.round((Date.now() - t0) / 1000) };
}
