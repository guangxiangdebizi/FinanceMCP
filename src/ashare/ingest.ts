import type { DatabaseSync } from 'node:sqlite';
import { fetchAll } from './fetch.js';
import { logSync, upsertRows } from './db.js';

export const CORE_INDICES: Record<string, string> = {
  '000001.SH': '上证指数',
  '399001.SZ': '深证成指',
  '399006.SZ': '创业板指',
  '000300.SH': '沪深300',
  '000905.SH': '中证500',
  '000852.SH': '中证1000',
  '000688.SH': '科创50',
  '899050.BJ': '北证50',
};
/** Indices whose absence makes a trading day NOT_READY. */
export const REQUIRED_INDICES = ['000001.SH', '399001.SZ', '000300.SH'];

const todayYmd = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');

export function addDays(ymd: string, days: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function shanghaiToday(): string {
  return todayYmd();
}

// ---------------------------------------------------------------- calendar

export async function syncTradeCal(db: DatabaseSync, start: string, end: string): Promise<number> {
  const rows = await fetchAll('trade_cal', { exchange: 'SSE', start_date: start, end_date: end },
    'cal_date,is_open,pretrade_date');
  const n = upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], rows);
  logSync(db, 'trade_cal', `${start}-${end}`, n, 'ok');
  return n;
}

export function isTradeDay(db: DatabaseSync, date: string): boolean | undefined {
  const row = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(date) as any;
  return row ? row.is_open === 1 : undefined;
}

/** Most recent open day on or before `date`. */
export function latestTradeDay(db: DatabaseSync, date: string): string | undefined {
  const row = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1').get(date) as any;
  return row?.cal_date;
}

export function previousTradeDay(db: DatabaseSync, date: string): string | undefined {
  const row = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date < ? ORDER BY cal_date DESC LIMIT 1').get(date) as any;
  return row?.cal_date;
}

export function tradeDaysBetween(db: DatabaseSync, start: string, end: string): string[] {
  return (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date').all(start, end) as any[])
    .map(r => r.cal_date);
}

export function recentTradeDays(db: DatabaseSync, end: string, count: number): string[] {
  return (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT ?').all(end, count) as any[])
    .map(r => r.cal_date).reverse();
}

// ---------------------------------------------------------------- stock list

export async function syncStockBasic(db: DatabaseSync): Promise<number> {
  const fields = 'ts_code,symbol,name,area,industry,market,exchange,list_date,delist_date,list_status,is_hs';
  const rows: Record<string, any>[] = [];
  // Include delisted and paused names so historical replays are not survivor-only.
  for (const status of ['L', 'D', 'P']) {
    rows.push(...await fetchAll('stock_basic', { list_status: status }, fields));
  }
  const now = new Date().toISOString();
  rows.forEach(r => { r.updated_at = now; });
  const n = upsertRows(db, 'stock_basic', [...fields.split(','), 'updated_at'], rows);
  logSync(db, 'stock_basic', 'all', n, 'ok');
  return n;
}

// ---------------------------------------------------------------- per trade date

type DatedDataset = {
  api: string;
  table: string;
  fields: string;
};

export const DATED_DATASETS: DatedDataset[] = [
  { api: 'daily', table: 'daily', fields: 'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount' },
  { api: 'daily_basic', table: 'daily_basic', fields: 'ts_code,trade_date,turnover_rate,turnover_rate_f,volume_ratio,pe_ttm,pb,ps_ttm,dv_ttm,total_mv,circ_mv' },
  { api: 'adj_factor', table: 'adj_factor', fields: 'ts_code,trade_date,adj_factor' },
  { api: 'stk_limit', table: 'stk_limit', fields: 'ts_code,trade_date,up_limit,down_limit' },
];

function syncedOk(db: DatabaseSync, dataset: string, key: string): boolean {
  const row = db.prepare('SELECT status FROM sync_log WHERE dataset = ? AND key = ?').get(dataset, key) as any;
  return row?.status === 'ok';
}

function countFor(db: DatabaseSync, table: string, date: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE trade_date = ?`).get(date) as any).n;
}

/**
 * Download one whole-market trading day per dataset (one paginated request
 * per dataset, never per stock). A dataset is marked `partial` when its row
 * count falls well short of the previous day so the next run fetches again.
 */
export async function syncTradeDate(db: DatabaseSync, date: string, force = false): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const prev = previousTradeDay(db, date);
  for (const ds of DATED_DATASETS) {
    if (!force && syncedOk(db, ds.table, date)) {
      result[ds.table] = countFor(db, ds.table, date);
      continue;
    }
    const rows = await fetchAll(ds.api, { trade_date: date }, ds.fields, 6000);
    upsertRows(db, ds.table, ds.fields.split(','), rows);
    const prevCount = prev ? countFor(db, ds.table, prev) : 0;
    const complete = rows.length > 0 && (prevCount === 0 || rows.length >= prevCount * 0.97);
    logSync(db, ds.table, date, rows.length, complete ? 'ok' : (rows.length ? 'partial' : 'empty'),
      prevCount ? `prev ${prev}=${prevCount}` : '');
    result[ds.table] = rows.length;
  }
  return result;
}

export async function syncIndexDaily(db: DatabaseSync, end: string, defaultStart: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const fields = 'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount';
  for (const code of Object.keys(CORE_INDICES)) {
    const span = db.prepare('SELECT MIN(trade_date) first, MAX(trade_date) last FROM index_daily WHERE ts_code = ?').get(code) as any;
    // Fill history before the earliest stored bar and new bars after the latest one.
    const ranges: [string, string][] = [];
    if (!span?.first) ranges.push([defaultStart, end]);
    else {
      if (span.first > defaultStart) ranges.push([defaultStart, addDays(span.first, -1)]);
      if (span.last < end) ranges.push([addDays(span.last, 1), end]);
    }
    let count = 0;
    for (const [start, stop] of ranges) {
      const rows = await fetchAll('index_daily', { ts_code: code, start_date: start, end_date: stop }, fields, 8000);
      upsertRows(db, 'index_daily', fields.split(','), rows);
      logSync(db, 'index_daily', `${code}:${start}-${stop}`, rows.length, 'ok');
      count += rows.length;
    }
    result[code] = count;
  }
  return result;
}

// ---------------------------------------------------------------- financials

const FINA_FIELDS = 'ts_code,ann_date,end_date,roe,roe_dt,netprofit_yoy,dt_netprofit_yoy,or_yoy,grossprofit_margin,debt_to_assets,ocf_to_profit,ocfps,eps,update_flag';

export function reportPeriods(end: string, count: number): string[] {
  const periods: string[] = [];
  let year = +end.slice(0, 4);
  const ends = ['1231', '0930', '0630', '0331'];
  while (periods.length < count) {
    for (const md of ends) {
      const p = `${year}${md}`;
      if (p <= end && periods.length < count) periods.push(p);
    }
    year--;
  }
  return periods;
}

/**
 * Batch financial indicators by report period (fina_indicator_vip). Recent
 * periods are refreshed each run because disclosures keep arriving; older
 * periods are fetched once.
 */
export async function syncFinaIndicator(db: DatabaseSync, asOf: string, periods = 12, refreshRecent = 3): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const list = reportPeriods(asOf, periods);
  for (const [i, period] of list.entries()) {
    if (i >= refreshRecent && syncedOk(db, 'fina_indicator', period)) continue;
    const rows = await fetchAll('fina_indicator_vip', { period }, FINA_FIELDS, 5000);
    // Restated rows (update_flag=1) are written last so they win on the same announcement date.
    rows.sort((a, b) => String(a.update_flag ?? '').localeCompare(String(b.update_flag ?? '')));
    const valid = rows.filter(r => r.ann_date && r.end_date);
    upsertRows(db, 'fina_indicator', FINA_FIELDS.split(',').filter(f => f !== 'update_flag'), valid);
    logSync(db, 'fina_indicator', period, valid.length, 'ok');
    result[period] = valid.length;
  }
  return result;
}

// ---------------------------------------------------------------- quality

export type QualityStatus = 'READY' | 'DEGRADED' | 'NOT_READY';
export interface QualityReport {
  trade_date: string;
  status: QualityStatus;
  reasons: string[];
  counts: Record<string, number>;
  coverage: Record<string, number>;
  anomalies: Record<string, number>;
  indices_present: string[];
  checked_at: string;
}

export function checkQuality(db: DatabaseSync, date: string, persist = true): QualityReport {
  const reasons: string[] = [];
  const degraded: string[] = [];
  const open = isTradeDay(db, date);
  const counts: Record<string, number> = {};
  for (const ds of DATED_DATASETS) counts[ds.table] = countFor(db, ds.table, date);
  const prev = previousTradeDay(db, date);
  counts.prev_daily = prev ? countFor(db, 'daily', prev) : 0;
  const listed = (db.prepare(`SELECT COUNT(*) n FROM stock_basic WHERE list_date <= ? AND (delist_date IS NULL OR delist_date = '' OR delist_date > ?)`).get(date, date) as any).n;
  counts.listed = listed;

  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : 0);
  const coverage = {
    daily_vs_prev: ratio(counts.daily, counts.prev_daily),
    daily_vs_listed: ratio(counts.daily, listed),
    daily_basic_vs_daily: ratio(counts.daily_basic, counts.daily),
    adj_factor_vs_daily: ratio(
      (db.prepare('SELECT COUNT(*) n FROM daily d JOIN adj_factor a ON a.trade_date = d.trade_date AND a.ts_code = d.ts_code WHERE d.trade_date = ?').get(date) as any).n,
      counts.daily),
    stk_limit_vs_daily: ratio(counts.stk_limit, counts.daily),
  };

  const anomalies = db.prepare(`
    SELECT
      SUM(CASE WHEN close IS NULL OR close <= 0 THEN 1 ELSE 0 END) bad_close,
      SUM(CASE WHEN high < low OR close > high * 1.0001 OR close < low * 0.9999 THEN 1 ELSE 0 END) ohlc_inconsistent,
      SUM(CASE WHEN vol > 0 AND (amount IS NULL OR amount <= 0) THEN 1 ELSE 0 END) zero_amount,
      SUM(CASE WHEN ABS(pct_chg) > 31 THEN 1 ELSE 0 END) extreme_move
    FROM daily WHERE trade_date = ?`).get(date) as Record<string, number>;
  for (const k of Object.keys(anomalies)) anomalies[k] = Number(anomalies[k] ?? 0);

  const indices = (db.prepare('SELECT ts_code FROM index_daily WHERE trade_date = ?').all(date) as any[]).map(r => r.ts_code);

  if (open === false) reasons.push(`${date} 不是交易日`);
  if (open === undefined) reasons.push(`交易日历缺少 ${date}`);
  if (counts.daily === 0) reasons.push('当日日线缺失');
  else if (counts.prev_daily && coverage.daily_vs_prev < 0.97) reasons.push(`当日日线条数 ${counts.daily} 低于前一交易日 ${counts.prev_daily} 的 97%`);
  if (counts.daily && coverage.adj_factor_vs_daily < 0.97) reasons.push(`复权因子覆盖率 ${coverage.adj_factor_vs_daily} < 0.97`);
  if (counts.daily && coverage.daily_basic_vs_daily < 0.95) reasons.push(`每日指标覆盖率 ${coverage.daily_basic_vs_daily} < 0.95`);
  const missingIdx = REQUIRED_INDICES.filter(c => !indices.includes(c));
  if (missingIdx.length) reasons.push(`核心指数缺失: ${missingIdx.join(',')}`);
  if (anomalies.bad_close > 0 || anomalies.ohlc_inconsistent > 5) reasons.push(`行情异常: 无效收盘价 ${anomalies.bad_close}，OHLC 不一致 ${anomalies.ohlc_inconsistent}`);

  if (counts.daily && coverage.stk_limit_vs_daily < 0.95) degraded.push(`涨跌停价覆盖率 ${coverage.stk_limit_vs_daily} < 0.95，涨跌停统计不完整`);
  const optionalMissing = Object.keys(CORE_INDICES).filter(c => !REQUIRED_INDICES.includes(c) && !indices.includes(c));
  if (optionalMissing.length) degraded.push(`非核心指数缺失: ${optionalMissing.join(',')}`);

  const status: QualityStatus = reasons.length ? 'NOT_READY' : degraded.length ? 'DEGRADED' : 'READY';
  const report: QualityReport = {
    trade_date: date,
    status,
    reasons: [...reasons, ...degraded],
    counts,
    coverage,
    anomalies,
    indices_present: indices,
    checked_at: new Date().toISOString(),
  };
  if (persist) db.prepare('INSERT OR REPLACE INTO quality_check (trade_date, status, detail, checked_at) VALUES (?,?,?,?)')
    .run(date, status, JSON.stringify(report), report.checked_at);
  return report;
}
