import type { DatabaseSync } from 'node:sqlite';
import type { Bars } from './indicators.js';

/**
 * Stream forward-adjusted daily bars for every stock between `start` and
 * `end`, one stock at a time. Prices are scaled by adj_factor / adj_factor at
 * the stock's last bar ≤ `end`, so bars never depend on data after `end`.
 */
export function forEachStockBars(
  db: DatabaseSync,
  start: string,
  end: string,
  cb: (tsCode: string, bars: Bars) => void,
  codes?: string[],
): number {
  // One indexed range query per stock: efficient for both a 260-day window and full history.
  const stmt = db.prepare(`
    SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.vol, d.amount, a.adj_factor, l.up_limit
    FROM daily d
    LEFT JOIN adj_factor a ON a.trade_date = d.trade_date AND a.ts_code = d.ts_code
    LEFT JOIN stk_limit l ON l.trade_date = d.trade_date AND l.ts_code = d.ts_code
    WHERE d.ts_code = ? AND d.trade_date BETWEEN ? AND ?
    ORDER BY d.trade_date`);
  const universe = codes?.length
    ? codes
    : (db.prepare('SELECT ts_code FROM stock_basic ORDER BY ts_code').all() as any[]).map(r => r.ts_code as string);

  let current: string | undefined;
  let rows: any[] = [];
  let stocks = 0;
  const flush = () => {
    if (!current || rows.length === 0) return;
    let lastFactor = NaN;
    for (let k = rows.length - 1; k >= 0; k--) {
      if (Number.isFinite(rows[k].adj_factor)) { lastFactor = rows[k].adj_factor; break; }
    }
    // A missing factor is carried forward from the previous bar so the series can still be
    // displayed, but `adjMissing` marks it: callers must not derive signals or scores from it.
    let carry = Number.isFinite(lastFactor) ? lastFactor : 1;
    const bars: Bars = { dates: [], open: [], high: [], low: [], close: [], vol: [], amount: [], rawOpen: [], rawClose: [], upLimit: [], adjMissing: 0 };
    for (const r of rows) {
      if (Number.isFinite(r.adj_factor)) carry = r.adj_factor;
      else bars.adjMissing!++;
      const ratio = Number.isFinite(lastFactor) ? carry / lastFactor : 1;
      bars.dates.push(r.trade_date);
      bars.open.push(r.open * ratio);
      bars.high.push(r.high * ratio);
      bars.low.push(r.low * ratio);
      bars.close.push(r.close * ratio);
      bars.vol.push(r.vol ?? 0);
      bars.amount.push(r.amount ?? 0);
      bars.rawOpen.push(r.open);
      bars.rawClose.push(r.close);
      bars.upLimit.push(r.up_limit ?? NaN);
    }
    stocks++;
    cb(current, bars);
  };
  for (const code of universe) {
    current = code;
    rows = stmt.all(code, start, end) as any[];
    flush();
  }
  return stocks;
}
