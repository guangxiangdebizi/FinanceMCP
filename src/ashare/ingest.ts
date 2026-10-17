import type { DatabaseSync } from 'node:sqlite';
import { fetchAll } from './fetch.js';
import { logSync, RefreshStatus, replaceDate, upsertRows } from './db.js';
export type { RefreshStatus };

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

export type SyncMode = 'skip_ok' | 'refresh';

export interface DatasetSync {
  /** Rows stored for the date after this run. */
  rows: number;
  /** Whether Tushare was actually queried in this run. */
  fetched: boolean;
  /** Stored cache state: ok / partial / empty. */
  status?: string;
  /** Outcome of this run's Tushare request, independent of what the cache already held. */
  refresh_status?: RefreshStatus;
  fetched_rows?: number;
  before_rows?: number;
  /** replaced = the date was swapped for the new snapshot; merged = upserted; kept = previous complete snapshot left as is; none = request failed. */
  write?: 'replaced' | 'merged' | 'kept' | 'none';
  error?: string;
}

/**
 * Download one whole-market trading day per dataset (one paginated request
 * per dataset, never per stock).
 *
 * `refresh` re-queries Tushare even when the date is already `ok`: the daily
 * pipeline uses it for the as-of day, whose data can still be completed or
 * revised between the 18:40 and 21:10 runs.
 *
 * Two things are recorded separately. The refresh is REFRESH_OK only when the
 * answer is complete (≥ 97% of the previous day and of what is stored); the
 * date is then replaced as a whole, so revised values win and withdrawn rows
 * disappear. A short answer is REFRESH_INCOMPLETE: over a complete cache it is
 * not written at all (the previous snapshot is kept intact, never mixed with a
 * partial update); over an incomplete cache its rows are merged. A request that
 * throws is REFRESH_FAILED and changes nothing. The cache `status` (ok /
 * partial / empty) always describes what is stored afterwards.
 */
export async function syncTradeDate(db: DatabaseSync, date: string, mode: SyncMode | boolean = 'skip_ok'): Promise<Record<string, DatasetSync>> {
  const refresh = mode === true || mode === 'refresh';
  const result: Record<string, DatasetSync> = {};
  const prev = previousTradeDay(db, date);
  for (const ds of DATED_DATASETS) {
    if (!refresh && syncedOk(db, ds.table, date)) {
      result[ds.table] = { rows: countFor(db, ds.table, date), fetched: false };
      continue;
    }
    const before = countFor(db, ds.table, date);
    const prevCount = prev ? countFor(db, ds.table, prev) : 0;
    const enough = (n: number) => n > 0 && (prevCount === 0 || n >= prevCount * 0.97);
    const cacheStatus = (n: number) => (enough(n) ? 'ok' : n ? 'partial' : 'empty');
    const notes = [refresh ? 'refresh' : '', prevCount ? `prev ${prev}=${prevCount}` : ''];
    let rows: Record<string, any>[];
    try {
      rows = await fetchAll(ds.api, { trade_date: date }, ds.fields, 6000);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      const status = cacheStatus(before);
      logSync(db, ds.table, date, 0, status, [...notes, 'request failed: ' + message].filter(Boolean).join('; '),
        { refresh_status: 'REFRESH_FAILED', before_rows: before, after_rows: before, write_mode: 'none' });
      result[ds.table] = { rows: before, fetched: true, status, refresh_status: 'REFRESH_FAILED', fetched_rows: 0, before_rows: before, write: 'none', error: message.slice(0, 200) };
      continue;
    }
    // A few withdrawn rows must still disappear, so this is not a strict `>= before`.
    const complete = enough(rows.length) && rows.length >= before * 0.97;
    const columns = ds.fields.split(',');
    const write = complete ? 'replaced' : enough(before) ? 'kept' : 'merged';
    if (write === 'replaced') replaceDate(db, ds.table, columns, date, rows);
    else if (write === 'merged') upsertRows(db, ds.table, columns, rows);
    const after = countFor(db, ds.table, date);
    const status = cacheStatus(after);
    const refreshStatus: RefreshStatus = complete ? 'REFRESH_OK' : 'REFRESH_INCOMPLETE';
    logSync(db, ds.table, date, rows.length, status, [`${write} ${before}->${after}`, ...notes].filter(Boolean).join('; '),
      { refresh_status: refreshStatus, before_rows: before, after_rows: after, write_mode: write });
    result[ds.table] = { rows: after, fetched: true, status, refresh_status: refreshStatus, fetched_rows: rows.length, before_rows: before, write };
  }
  return result;
}

/**
 * Suspensions (Tushare suspend_d, suspend_type S) for one trade date. They let
 * the audit tell a suspended stock from a real gap in `daily`. A day with no
 * suspensions legitimately returns nothing, so completeness cannot be judged
 * from the row count: a successful request is REFRESH_OK and replaces the
 * date; a failed one changes nothing and leaves the date to be fetched again.
 */
export async function syncSuspend(db: DatabaseSync, date: string, refresh = false): Promise<DatasetSync> {
  const before = countFor(db, 'suspend_d', date);
  if (!refresh && syncedOk(db, 'suspend_d', date)) return { rows: before, fetched: false };
  const hadOk = syncedOk(db, 'suspend_d', date);
  try {
    const rows = await fetchAll('suspend_d', { trade_date: date, suspend_type: 'S' }, 'ts_code,trade_date,suspend_timing', 6000);
    replaceDate(db, 'suspend_d', ['ts_code', 'trade_date', 'suspend_timing'], date, rows);
    logSync(db, 'suspend_d', date, rows.length, 'ok', refresh ? 'refresh' : '',
      { refresh_status: 'REFRESH_OK', before_rows: before, after_rows: rows.length, write_mode: 'replaced' });
    return { rows: rows.length, fetched: true, status: 'ok', refresh_status: 'REFRESH_OK', fetched_rows: rows.length, before_rows: before, write: 'replaced' };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const status = hadOk ? 'ok' : 'failed';
    logSync(db, 'suspend_d', date, 0, status, 'request failed: ' + message,
      { refresh_status: 'REFRESH_FAILED', before_rows: before, after_rows: before, write_mode: 'none' });
    return { rows: before, fetched: true, status, refresh_status: 'REFRESH_FAILED', fetched_rows: 0, before_rows: before, write: 'none', error: message.slice(0, 200) };
  }
}

/** Fetch one core index over [start, end] and merge it; used for regular sync and for filling holes. */
export async function syncIndexRange(db: DatabaseSync, code: string, start: string, end: string, asOf = end): Promise<number> {
  const fields = 'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount';
  const key = `${code}:${start}-${end}`;
  try {
    const rows = await fetchAll('index_daily', { ts_code: code, start_date: start, end_date: end }, fields, 8000);
    upsertRows(db, 'index_daily', fields.split(','), rows);
    // A range ending at the as-of day is complete only if that day's bar came back.
    const complete = end === asOf ? rows.some(r => r.trade_date === asOf) : rows.length > 0;
    logSync(db, 'index_daily', key, rows.length, complete ? 'ok' : 'partial', '',
      { refresh_status: complete ? 'REFRESH_OK' : 'REFRESH_INCOMPLETE', write_mode: 'merged' });
    return rows.length;
  } catch (error: any) {
    logSync(db, 'index_daily', key, 0, 'failed', 'request failed: ' + String(error?.message ?? error), { refresh_status: 'REFRESH_FAILED', write_mode: 'none' });
    return 0;
  }
}

/**
 * Core index bars. Missing history is filled in both directions; bars from
 * `refreshFrom` to `end` are fetched again even when already stored, so the
 * as-of day's index close is re-checked like the stock data.
 */
export async function syncIndexDaily(db: DatabaseSync, end: string, defaultStart: string, refreshFrom?: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const code of Object.keys(CORE_INDICES)) {
    const span = db.prepare('SELECT MIN(trade_date) first, MAX(trade_date) last FROM index_daily WHERE ts_code = ?').get(code) as any;
    // Fill history before the earliest stored bar and new bars after the latest one.
    const ranges: [string, string][] = [];
    if (!span?.first) ranges.push([defaultStart, end]);
    else {
      if (span.first > defaultStart) ranges.push([defaultStart, addDays(span.first, -1)]);
      const from = refreshFrom && refreshFrom <= span.last ? refreshFrom : addDays(span.last, 1);
      if (from <= end) ranges.push([from, end]);
    }
    let count = 0;
    for (const [start, stop] of ranges) count += await syncIndexRange(db, code, start, stop, end);
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
  /** Quality of the stored cache alone, before the latest refresh outcome is considered. */
  cache_status: QualityStatus;
  /** Latest Tushare refresh per dataset for this date (null = never recorded). */
  refresh: Record<string, RefreshInfo | null>;
  /** When each dataset's stored rows for this date were written; datasets may come from different fetches. */
  snapshot: SnapshotInfo;
  checked_at: string;
}

export interface RefreshInfo {
  refresh_status: RefreshStatus | null;
  fetched_rows: number;
  before_rows: number | null;
  after_rows: number | null;
  write_mode: string | null;
  synced_at: string;
  message: string;
}

export interface SnapshotInfo {
  written_at: Record<string, string | null>;
  spread_minutes: number | null;
  mixed: boolean;
  note: string | null;
}

/**
 * The fetch each dataset's cached rows come from. A refresh that was kept or
 * failed leaves the earlier rows in place, so daily, daily_basic, adj_factor
 * and stk_limit can be from fetches hours apart; that is reported, not hidden.
 */
export function snapshotInfo(db: DatabaseSync, date: string): SnapshotInfo {
  const written: Record<string, string | null> = {};
  for (const ds of DATED_DATASETS) {
    const h = db.prepare("SELECT MAX(synced_at) t FROM sync_history WHERE dataset = ? AND key = ? AND write_mode IN ('replaced', 'merged')").get(ds.table, date) as any;
    // Rows synced before write_mode existed: the latest successful sync wrote them.
    const legacy = db.prepare("SELECT synced_at t FROM sync_log WHERE dataset = ? AND key = ? AND write_mode IS NULL AND status = 'ok'").get(ds.table, date) as any;
    written[ds.table] = h?.t ?? legacy?.t ?? null;
  }
  const times = Object.values(written).filter((t): t is string => !!t).map(t => Date.parse(t));
  const spread = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : times.length ? 0 : null;
  const mixed = spread !== null && spread > 60;
  return {
    written_at: written,
    spread_minutes: spread,
    mixed,
    note: mixed ? `各数据集当日缓存来自不同时间的获取（最大相差 ${spread} 分钟），其中较早的为上一次有效快照` : null,
  };
}

/** Latest recorded refresh of each dated dataset and core index for `date`. */
export function latestRefresh(db: DatabaseSync, date: string): Record<string, RefreshInfo | null> {
  const info = (r: any): RefreshInfo | null => r ? {
    refresh_status: r.refresh_status ?? null, fetched_rows: r.rows, before_rows: r.before_rows ?? null, after_rows: r.after_rows ?? null,
    write_mode: r.write_mode ?? null, synced_at: r.synced_at, message: r.message ?? '',
  } : null;
  const out: Record<string, RefreshInfo | null> = {};
  for (const ds of DATED_DATASETS) out[ds.table] = info(db.prepare('SELECT * FROM sync_log WHERE dataset = ? AND key = ?').get(ds.table, date));
  for (const code of Object.keys(CORE_INDICES)) {
    out[`index_daily:${code}`] = info(db.prepare("SELECT * FROM sync_log WHERE dataset = 'index_daily' AND key LIKE ? ORDER BY synced_at DESC LIMIT 1").get(`${code}:%-${date}`));
  }
  return out;
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

  const cacheStatus: QualityStatus = reasons.length ? 'NOT_READY' : degraded.length ? 'DEGRADED' : 'READY';
  // A good cache does not make a bad refresh good: if the latest request for this date was short
  // or failed, the report keeps the previous snapshot but cannot be an unqualified READY.
  const refresh = latestRefresh(db, date);
  const refreshIssues: string[] = [];
  for (const [name, r] of Object.entries(refresh)) {
    if (r?.refresh_status === 'REFRESH_INCOMPLETE') {
      refreshIssues.push(`最新一次刷新 ${name} 不完整（返回 ${r.fetched_rows} 条，${r.write_mode === 'kept' ? `沿用上一次有效快照 ${r.after_rows} 条` : `缓存现有 ${r.after_rows ?? '-'} 条`}，${r.synced_at}）`);
    } else if (r?.refresh_status === 'REFRESH_FAILED') {
      refreshIssues.push(`最新一次刷新 ${name} 请求失败（${(r.message.split('request failed: ')[1] ?? r.message).slice(0, 80)}；沿用已有缓存，${r.synced_at}）`);
    }
  }
  const status: QualityStatus = cacheStatus === 'NOT_READY' ? 'NOT_READY' : refreshIssues.length || cacheStatus === 'DEGRADED' ? 'DEGRADED' : 'READY';
  const report: QualityReport = {
    trade_date: date,
    status,
    reasons: [...reasons, ...degraded, ...refreshIssues],
    counts,
    coverage,
    anomalies,
    indices_present: indices,
    cache_status: cacheStatus,
    refresh,
    snapshot: snapshotInfo(db, date),
    checked_at: new Date().toISOString(),
  };
  if (persist) db.prepare('INSERT OR REPLACE INTO quality_check (trade_date, status, detail, checked_at) VALUES (?,?,?,?)')
    .run(date, status, JSON.stringify(report), report.checked_at);
  return report;
}
