import type { DatabaseSync } from 'node:sqlite';
import { fetchAll } from './fetch.js';
import { upsertRows } from './db.js';
import { addDays, latestTradeDay, shanghaiToday, syncTradeCal, tradeDaysBetween } from './ingest.js';
import { adjustmentRatio, AdjustMode, DataQueryError, parseYmd } from './data.js';

/**
 * ETF 数据纵切（R0）：基金基础信息、日线、复权因子与份额。
 *
 * 与股票管线完全隔离：只读写 fund_* 表，不触碰 daily/adj_factor/stock_basic
 * 等既有表，也不改变既有工具、评分或报告。口径以 R0 基线审计的实测结果为准：
 * - fund_daily.vol 单位是手（1 手 = 100 份），amount 单位是千元；
 * - fund_share.fd_share 单位是万份，是时点存量，不是资金净流入；
 * - fund_daily 支持按 trade_date 取全市场，因此按交易日同步，而不是逐代码同步。
 */

/** R0 冻结的五只持仓 ETF。 */
export const ETF_UNIVERSE = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'] as const;

/** ETF 交易单位：1 手 = 100 份（场内 ETF 的申报单位）。 */
export const ETF_LOT_SIZE = 100;
export const ETF_TRADE_UNIT = { lot_size: ETF_LOT_SIZE, unit: 'share', lot_unit: '手' } as const;

/**
 * 行情晚于预期最近交易日、或（无交易日历时）距查询截止日超过该自然日数即为 STALE
 * （只标记，不替换；有交易日期时以“不是预期最近交易日”为准）。
 */
export const ETF_STALE_MAX_AGE_DAYS = 7;
/** 流动性统计窗口（交易日数）。 */
export const ETF_LIQUIDITY_WINDOW = 20;
/** 默认查询窗口：截至 end 往前 30 个自然日，用于找到最后一根行情。 */
export const ETF_DEFAULT_WINDOW_DAYS = 30;
/** 份额变化估计要求两个份额日相隔不超过该自然日数，否则不视为可比。 */
export const ETF_FLOW_MAX_DATE_GAP_DAYS = 45;
export const ETF_SOURCE = 'tushare.fund_daily';

/**
 * 份额变化只能表述为“净申购规模估计”，且必须同时具备：
 * 两个可比日期的 fund_share、以及一个净值/收盘价代理。
 * 成交额（amount）与份额变化都不得表述为“资金净流入”。
 */
export const FLOW_LABEL_RULE =
  '仅当存在两个可比日期（间隔 ≤ ' + ETF_FLOW_MAX_DATE_GAP_DAYS + ' 个自然日）的 fund_share 且存在净值/收盘价代理时，'
  + '份额变化 × 价格才可标记为 net_creation_estimate（净申购规模估计，单位元）；'
  + 'fund_daily.amount 是二级市场成交额，份额变化是基金份额存量变化，二者都不是“资金净流入”，不得如此表述。';

const FUND_BASIC_FIELDS = 'ts_code,name,management,custodian,fund_type,found_date,due_date,list_date,issue_date,delist_date,issue_amount,m_fee,c_fee,benchmark,status,invest_type,type,market';
const FUND_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';
const FUND_ADJ_FIELDS = 'ts_code,trade_date,adj_factor';
const FUND_SHARE_FIELDS = 'ts_code,trade_date,fd_share,fund_type,market';

export type EtfQualityStatus = 'READY' | 'DEGRADED' | 'NOT_READY';

/** ETF 表是否存在：旧缓存（含未迁移的生产库）上 tools/list 与普通工具仍可用。 */
export function etfSchemaReady(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fund_daily'").get();
  return !!row;
}

export const ETF_NOT_INITIALIZED = 'ETF 缓存未初始化，请先运行 finance-ashare etf-sync';

function assertEtfSchema(db: DatabaseSync): void {
  if (!etfSchemaReady(db)) throw new DataQueryError(ETF_NOT_INITIALIZED);
}

function logFundSync(db: DatabaseSync, dataset: string, key: string, rows: number, status: string, message = ''): void {
  db.prepare('INSERT OR REPLACE INTO fund_sync_log (dataset, key, rows, status, message, synced_at) VALUES (?,?,?,?,?,?)')
    .run(dataset, key, rows, status, message.slice(0, 500), new Date().toISOString());
}

function fundSyncedOk(db: DatabaseSync, dataset: string, key: string): boolean {
  const row = db.prepare('SELECT status FROM fund_sync_log WHERE dataset = ? AND key = ?').get(dataset, key) as any;
  return row?.status === 'ok';
}

function countFundRows(db: DatabaseSync, table: string, date: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE trade_date = ?`).get(date) as any).n;
}

/** 6 位数字或代码名 → 交易所后缀（5/6 开头为 .SH，1/3 开头为 .SZ）。 */
function normalizeFundCode(raw: unknown): string {
  const text = String(raw ?? '').trim().toUpperCase();
  if (!text) throw new DataQueryError('缺少 ts_code');
  if (/^\d{6}\.(SH|SZ)$/.test(text)) return text;
  if (/^\d{6}$/.test(text)) return `${text}.${/^[56]/.test(text) ? 'SH' : 'SZ'}`;
  throw new DataQueryError(`无法识别的基金代码: ${text}`);
}

// ---------------------------------------------------------------- sync

export interface FundBasicSync {
  rows: number;
  fetched: boolean;
  /** 全市场请求失败的原因（逐只补齐后仍记录，不静默）。 */
  error?: string;
  /** 全市场结果里缺失、由逐只补查的代码。 */
  per_code_codes?: string[];
}

/**
 * 基金基础信息。优先取场内全市场（market=E），失败时退回逐只查询，使权限较低的
 * token 也能同步这五只。
 *
 * 上游分页有陷阱：不带过滤条件的 fund_basic 按固定行数分页，某只 ETF 可能只出现在
 * 后面的页里。因此即使全市场请求成功，也要核对五只是否都已落库，缺哪只就单独补查
 * —— 不做“一次调用就覆盖全市场”的假设。只写 fund_basic，不触碰 stock_basic。
 */
export async function syncFundBasic(db: DatabaseSync): Promise<FundBasicSync> {
  assertEtfSchema(db);
  const now = new Date().toISOString();
  let rows: Record<string, any>[] = [];
  let error: string | undefined;
  try {
    rows = await fetchAll('fund_basic', { market: 'E' }, FUND_BASIC_FIELDS, 6000);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  const seen = new Set(rows.map(r => r.ts_code));
  const missing = ETF_UNIVERSE.filter(c => !seen.has(c));
  if (missing.length) {
    for (const code of missing) {
      try {
        rows.push(...await fetchAll('fund_basic', { ts_code: code }, FUND_BASIC_FIELDS));
      } catch (e: any) {
        error = [error, `${code}: ${String(e?.message ?? e)}`].filter(Boolean).join('; ');
      }
    }
  }
  const valid = rows.filter(r => r.ts_code);
  valid.forEach(r => { r.updated_at = now; });
  const n = upsertRows(db, 'fund_basic', [...FUND_BASIC_FIELDS.split(','), 'updated_at'], valid);
  const notes = [error ? `whole-market error: ${error}` : '', missing.length ? `per-code filled: ${missing.join(',')}` : ''].filter(Boolean).join('; ');
  logFundSync(db, 'fund_basic', 'market=E', n, n ? 'ok' : 'empty', notes);
  return { rows: n, fetched: true, ...(error ? { error: error.slice(0, 200) } : {}), ...(missing.length ? { per_code_codes: missing } : {}) };
}

export interface FundDateSync {
  rows: number;
  fetched: boolean;
  status: string;
  write: 'replaced' | 'merged' | 'none';
  error?: string;
}

/**
 * 按交易日同步全市场基金日线。与股票 syncTradeDate 同思路：一次请求取一天
 * 全市场，整日替换，因此上游修订或撤下的行不会残留；明显不完整的回答不覆盖
 * 已有的完整快照，而是合并或保留。
 */
export async function syncFundDaily(db: DatabaseSync, start: string, end: string, opts: { refresh?: boolean } = {}): Promise<Record<string, FundDateSync>> {
  assertEtfSchema(db);
  const days = tradeDaysBetween(db, start, end);
  if (!days.length) throw new DataQueryError(`交易日历在 ${start}-${end} 内为空，请先同步 trade_cal`);
  const out: Record<string, FundDateSync> = {};
  for (const date of days) {
    const before = countFundRows(db, 'fund_daily', date);
    if (!opts.refresh && fundSyncedOk(db, 'fund_daily', date)) {
      out[date] = { rows: before, fetched: false, status: before ? 'ok' : 'empty', write: 'none' };
      continue;
    }
    const prev = addDays(date, -1);
    const prevCount = countFundRows(db, 'fund_daily', prev);
    let rows: Record<string, any>[];
    try {
      rows = await fetchAll('fund_daily', { trade_date: date }, FUND_DAILY_FIELDS, 6000);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      logFundSync(db, 'fund_daily', date, 0, before ? 'ok' : 'failed', 'request failed: ' + message);
      out[date] = { rows: before, fetched: true, status: before ? 'ok' : 'failed', write: 'none', error: message.slice(0, 200) };
      continue;
    }
    const valid = rows.filter(r => r.ts_code);
    const complete = valid.length > 0 && (prevCount === 0 || valid.length >= prevCount * 0.97) && valid.length >= before * 0.97;
    let write: FundDateSync['write'];
    if (complete) {
      db.prepare('DELETE FROM fund_daily WHERE trade_date = ?').run(date);
      upsertRows(db, 'fund_daily', FUND_DAILY_FIELDS.split(','), valid);
      write = 'replaced';
    } else if (valid.length && !before) {
      upsertRows(db, 'fund_daily', FUND_DAILY_FIELDS.split(','), valid);
      write = 'merged';
    } else {
      write = 'none';
    }
    const after = countFundRows(db, 'fund_daily', date);
    const status = after ? (complete ? 'ok' : 'partial') : 'empty';
    logFundSync(db, 'fund_daily', date, valid.length, status, `${write} ${before}->${after}${prevCount ? `; prev ${prev}=${prevCount}` : ''}`);
    out[date] = { rows: after, fetched: true, status, write, ...(complete ? {} : { error: '回答不完整，未覆盖已有快照' }) };
  }
  return out;
}

/**
 * 复权因子。fund_adj 按代码区间取，逐只合并写入（不做整段替换，避免一次
 * 失败抹掉已有历史）。任何一只失败只记录该代码，不影响其他代码。
 */
export async function syncFundAdj(db: DatabaseSync, start: string, end: string): Promise<Record<string, number>> {
  assertEtfSchema(db);
  const out: Record<string, number> = {};
  for (const code of ETF_UNIVERSE) {
    const key = `${code}:${start}-${end}`;
    try {
      const rows = (await fetchAll('fund_adj', { ts_code: code, start_date: start, end_date: end }, FUND_ADJ_FIELDS))
        .filter(r => r.ts_code && r.trade_date);
      const n = upsertRows(db, 'fund_adj', FUND_ADJ_FIELDS.split(','), rows);
      logFundSync(db, 'fund_adj', key, n, n ? 'ok' : 'empty');
      out[code] = n;
    } catch (e: any) {
      logFundSync(db, 'fund_adj', key, 0, 'failed', 'request failed: ' + String(e?.message ?? e));
      out[code] = 0;
    }
  }
  return out;
}

/** 基金份额（时点存量，万份）。同样按代码区间合并写入。 */
export async function syncFundShare(db: DatabaseSync, start: string, end: string): Promise<Record<string, number>> {
  assertEtfSchema(db);
  const out: Record<string, number> = {};
  for (const code of ETF_UNIVERSE) {
    const key = `${code}:${start}-${end}`;
    try {
      const rows = (await fetchAll('fund_share', { ts_code: code, start_date: start, end_date: end }, FUND_SHARE_FIELDS))
        .filter(r => r.ts_code && r.trade_date);
      const n = upsertRows(db, 'fund_share', FUND_SHARE_FIELDS.split(','), rows);
      logFundSync(db, 'fund_share', key, n, n ? 'ok' : 'empty');
      out[code] = n;
    } catch (e: any) {
      logFundSync(db, 'fund_share', key, 0, 'failed', 'request failed: ' + String(e?.message ?? e));
      out[code] = 0;
    }
  }
  return out;
}

export interface EtfSyncSummary {
  start: string;
  end: string;
  trade_days: number;
  fund_basic: FundBasicSync;
  fund_daily: Record<string, FundDateSync>;
  fund_adj: Record<string, number>;
  fund_share: Record<string, number>;
  errors: string[];
  seconds: number;
}

/** 五只 ETF 的完整同步：基础信息 → 逐交易日全市场日线 → 逐代码复权/份额。 */
export async function syncEtf(db: DatabaseSync, start: string, end: string, opts: { refresh?: boolean } = {}): Promise<EtfSyncSummary> {
  const t0 = Date.now();
  const errors: string[] = [];
  // 按交易日同步需要交易日历；缺失时先补该区间，不假设“工作日 = 交易日”。
  if (!tradeDaysBetween(db, start, end).length) await syncTradeCal(db, addDays(start, -10), addDays(end, 10));
  const basic = await syncFundBasic(db);
  if (basic.error) errors.push(`fund_basic: ${basic.error}`);
  const daily = await syncFundDaily(db, start, end, opts);
  for (const [date, r] of Object.entries(daily)) if (r.error) errors.push(`fund_daily ${date}: ${r.error}`);
  const adj = await syncFundAdj(db, start, end);
  const share = await syncFundShare(db, start, end);
  for (const [code, n] of Object.entries(adj)) if (!n) errors.push(`fund_adj ${code}: 无数据或请求失败`);
  for (const [code, n] of Object.entries(share)) if (!n) errors.push(`fund_share ${code}: 无数据或请求失败`);
  return {
    start, end,
    trade_days: Object.keys(daily).length,
    fund_basic: basic, fund_daily: daily, fund_adj: adj, fund_share: share,
    errors, seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// ---------------------------------------------------------------- flow labelling

export interface FlowInput {
  /** 最新份额：时点存量，单位万份。 */
  latest: { trade_date: string; fd_share_wan: number } | null;
  /** 上一份额时点，必须早于 latest 且间隔可比。 */
  previous: { trade_date: string; fd_share_wan: number } | null;
  /** 净值或收盘价代理，单位元/份。 */
  nav_proxy: number | null;
}

export interface FlowClassification {
  /** 只有满足全部条件才是 net_creation_estimate，否则为 null。 */
  label: 'net_creation_estimate' | null;
  /** 净申购规模估计（元）：份额变化 × 价格代理；label 为 null 时也是 null。 */
  amount_cny: number | null;
  share_change_wan: number | null;
  unit: 'cny';
  reason: string;
  rule: string;
}

/** 日历日差（YYYYMMDD）。 */
function calendarDays(a: string, b: string): number {
  const toUtc = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((toUtc(b) - toUtc(a)) / 86400_000);
}

/**
 * 只给“净申购规模估计”打标签，绝不把成交额或份额变化称为“资金净流入”。
 * 条件：两个可比日期的份额都存在，间隔 ≤ ETF_FLOW_MAX_DATE_GAP_DAYS，且有价格代理。
 */
export function classifyFlow(input: FlowInput): FlowClassification {
  const base = { label: null, amount_cny: null, share_change_wan: null, unit: 'cny' as const, rule: FLOW_LABEL_RULE };
  const { latest, previous, nav_proxy: nav } = input;
  if (!latest || !Number.isFinite(latest.fd_share_wan)) return { ...base, reason: 'share_missing' };
  if (!previous || !Number.isFinite(previous.fd_share_wan)) return { ...base, reason: 'share_prev_missing' };
  if (previous.trade_date >= latest.trade_date) return { ...base, reason: 'share_dates_not_comparable' };
  const gap = calendarDays(previous.trade_date, latest.trade_date);
  if (gap > ETF_FLOW_MAX_DATE_GAP_DAYS) return { ...base, reason: `share_date_gap_${gap}d_exceeds_${ETF_FLOW_MAX_DATE_GAP_DAYS}d` };
  if (nav == null || !Number.isFinite(nav) || nav <= 0) return { ...base, reason: 'nav_proxy_missing' };
  const changeWan = latest.fd_share_wan - previous.fd_share_wan;
  return {
    label: 'net_creation_estimate',
    amount_cny: Math.round(changeWan * 1e4 * nav * 100) / 100,
    share_change_wan: Math.round(changeWan * 10000) / 10000,
    unit: 'cny',
    reason: 'two comparable share dates and a price proxy are available',
    rule: FLOW_LABEL_RULE,
  };
}

// ---------------------------------------------------------------- queries

export interface EtfQuotesQuery {
  start?: unknown;
  end?: unknown;
  adjust?: unknown;
  /** 以交易日历为准的“预期最近交易日”；MCP 层按上海时区今天传入，缺省用 end。 */
  asOfDate?: unknown;
}

const round4 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);

/** qfq 基准：end 当日或之前最后一个复权因子，绝不使用 end 之后的因子。 */
export function fundBaseFactor(db: DatabaseSync, code: string, asOf: string): { trade_date: string; adj_factor: number } | null {
  const row = db.prepare('SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1')
    .get(code, asOf) as any;
  return row ? { trade_date: row.trade_date, adj_factor: row.adj_factor } : null;
}

function latestFundDailyDate(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(trade_date) d FROM fund_daily').get() as any)?.d ?? null;
}

export interface EtfQuote {
  ts_code: string;
  name: string | null;
  fund_type: string | null;
  invest_type: string | null;
  market: string | null;
  list_date: string | null;
  delist_date: string | null;
  status: string | null;
  benchmark: string | null;
  trade_unit: typeof ETF_TRADE_UNIT;
  as_of_trade_date: string;
  latest_bar: {
    trade_date: string;
    open: number | null; high: number | null; low: number | null; close: number | null;
    pre_close: number | null; change: number | null; pct_chg: number | null;
    vol_lots: number | null; amount_kcny: number | null;
    close_cny: number | null; amount_cny: number | null; volume_shares: number | null;
  } | null;
  adjusted: { mode: AdjustMode; base: { trade_date: string; adj_factor: number } | null; open: number | null; high: number | null; low: number | null; close: number | null };
  /** 窗口内逐日复权价（与 adjusted.mode 同口径），用于核对拆分前后的连续序列。 */
  adjusted_rows: { trade_date: string; open: number | null; high: number | null; low: number | null; close: number | null }[];
  share: {
    fd_share_wan: number | null;
    fd_share_wan_prev: number | null;
    share_change_wan: number | null;
    share_change_pct: number | null;
    latest_share_date: string | null;
    previous_share_date: string | null;
  };
  flow: FlowClassification;
  /** 窗口内复权因子发生变化的交易日（拆分/份额折算），原始价格不被平滑掉。 */
  adjustment_events: { trade_date: string; from_factor: number; to_factor: number; factor_ratio: number }[];
  liquidity: { window: number; bars_used: number; mean_amount_cny: number | null; zero_volume_days: number; max_gap_days: number | null };
  quality: { status: EtfQualityStatus; reasons: string[]; missing: string[] };
  stale: boolean;
  expected_trade_date: string | null;
  bar_matches_expected: boolean | null;
  source: string;
  synced_at: string | null;
}

export interface EtfQuotesResult {
  query: { start_date: string; end_date: string; adjust: AdjustMode };
  as_of_trade_date: string;
  expected_trade_date: string | null;
  units: Record<string, string>;
  quotes: EtfQuote[];
  warnings: string[];
  source: string;
  flow_label_rule: string;
}

/**
 * 五只（或指定）ETF 的行情快照。每个代码独立判定质量：
 * - 窗口内没有任何行情 → NOT_READY，价格字段为 null，不伪造；
 * - 有行情但晚于预期最近交易日或超过 7 个自然日 → 仍返回该行情，同时标记 STALE/DEGRADED；
 * - 份额、复权因子、基础信息缺失 → DEGRADED 并列出 missing 字段名。
 */
export function etfQuotes(db: DatabaseSync, codes: unknown, q: EtfQuotesQuery = {}): EtfQuotesResult {
  assertEtfSchema(db);
  const adjust = (q.adjust == null || q.adjust === '' ? 'none' : String(q.adjust)) as AdjustMode;
  if (!['none', 'qfq', 'hfq'].includes(adjust)) throw new DataQueryError('adjust 只能是 none、qfq 或 hfq');
  const rawEnd = parseYmd(q.end, 'end_date');
  const asOf = parseYmd(q.asOfDate, 'as_of_date');
  const calendarEnd = asOf && (!rawEnd || rawEnd < asOf) ? asOf : rawEnd;
  const end = rawEnd ?? latestTradeDay(db, calendarEnd ?? shanghaiToday()) ?? latestFundDailyDate(db) ?? shanghaiToday();
  const start = parseYmd(q.start, 'start_date') ?? addDays(end, -ETF_DEFAULT_WINDOW_DAYS);
  if (start > end) throw new DataQueryError(`start_date ${start} 晚于 end_date ${end}`);
  const requested = codes == null || (Array.isArray(codes) && codes.length === 0) || codes === ''
    ? [...ETF_UNIVERSE] : (Array.isArray(codes) ? codes : [codes]);
  // 未显式指定 end 时，预期交易日按“今天”而不是窗口终点，否则历史窗口会永远 READY。
  const expected = latestTradeDay(db, calendarEnd ?? end) ?? null;

  const warnings: string[] = [];
  if (!expected) warnings.push('交易日历缺少该区间，无法判断行情是否落后于最近交易日；仅按 7 个自然日判定 STALE');

  const quotes = requested.map(raw => quoteOne(db, normalizeFundCode(raw), start, end, adjust, expected));
  return {
    query: { start_date: start, end_date: end, adjust },
    as_of_trade_date: end,
    expected_trade_date: expected,
    units: { price: '元/份', vol: '手（1 手 = 100 份）', amount: '千元', fd_share: '万份', amount_cny: '元', volume_shares: '份' },
    quotes,
    warnings,
    source: ETF_SOURCE,
    flow_label_rule: FLOW_LABEL_RULE,
  };
}

function quoteOne(db: DatabaseSync, code: string, start: string, end: string, adjust: AdjustMode, expected: string | null): EtfQuote {
  const reasons: string[] = [];
  const missing: string[] = [];
  const basic = db.prepare('SELECT * FROM fund_basic WHERE ts_code = ?').get(code) as any;
  if (!basic) { reasons.push('fund_basic_missing'); missing.push('fund_basic'); }
  const bars = db.prepare(`
    SELECT trade_date, open, high, low, close, pre_close, change, pct_chg, vol, amount
    FROM fund_daily WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date`).all(code, start, end) as any[];
  const last = bars.at(-1);
  if (!bars.length) { reasons.push('no_bar_in_window'); missing.push('fund_daily'); }

  let stale = false;
  if (last) {
    const age = calendarDays(last.trade_date, end);
    if (expected && last.trade_date !== expected) {
      stale = true;
      reasons.push(`stale_bar: 最新行情 ${last.trade_date}，预期最近交易日 ${expected}`);
    }
    // 没有交易日历时无法判断“落后几个交易日”，只能按自然日放宽阈值。
    if ((!expected && age > ETF_STALE_MAX_AGE_DAYS) || (expected && age > ETF_STALE_MAX_AGE_DAYS * 2)) {
      stale = true;
      reasons.push(`stale_bar: 最新行情 ${last.trade_date} 距查询截止日 ${end} 已 ${age} 个自然日`);
    }
  }

  // 复权：与 data.ts 的股票口径一致（qfq 以 end 之前最后一个因子为基准）。
  const factor = last ? (db.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date = ?').get(code, last.trade_date) as any)?.adj_factor : null;
  const base = adjust === 'qfq' ? fundBaseFactor(db, code, end) : null;
  if (last && adjust !== 'none' && !(factor > 0)) { reasons.push('adj_factor_missing'); missing.push('fund_adj'); }
  if (last && adjust === 'qfq' && !base) { reasons.push('adj_factor_missing'); if (!missing.includes('fund_adj')) missing.push('fund_adj'); }
  // 未复权不需要因子；qfq/hfq 缺少因子时价格只能为 null，不能拿原始价冒充复权价。
  // 每一根 K 线用当日因子，qfq 的基准固定为 end 之前最后一个因子，因此拆分前后连续。
  const factors = new Map((db.prepare(`
    SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ?`)
    .all(code, start, end) as any[]).map(r => [r.trade_date, r.adj_factor]));
  const barRatio = (date: string) => {
    const f = factors.get(date);
    return adjust === 'none' ? 1 : adjustmentRatio(adjust, f > 0 ? f : NaN, base?.adj_factor ?? NaN);
  };
  const ratio = last ? barRatio(last.trade_date) : NaN;
  const adjPrice = (v: number | null) => (v == null || !Number.isFinite(ratio) ? null : round4(v * ratio));

  // 份额：最新与上一时点（都在 end 之前）。
  const shareRows = db.prepare('SELECT trade_date, fd_share FROM fund_share WHERE ts_code = ? AND trade_date <= ? AND fd_share IS NOT NULL ORDER BY trade_date DESC LIMIT 2')
    .all(code, end) as any[];
  const latestShare = shareRows[0] ?? null;
  const prevShare = shareRows[1] ?? null;
  if (!latestShare) { reasons.push('share_missing'); missing.push('fund_share'); }
  else if (!prevShare) reasons.push('share_prev_missing');
  const changeWan = latestShare && prevShare ? round4(latestShare.fd_share - prevShare.fd_share) : null;
  const changePct = latestShare && prevShare && prevShare.fd_share > 0
    ? Math.round(((latestShare.fd_share - prevShare.fd_share) / prevShare.fd_share) * 10000) / 100 : null;

  const closeCny = last?.close ?? null;
  const flow = classifyFlow({
    latest: latestShare ? { trade_date: latestShare.trade_date, fd_share_wan: latestShare.fd_share } : null,
    previous: prevShare ? { trade_date: prevShare.trade_date, fd_share_wan: prevShare.fd_share } : null,
    nav_proxy: closeCny,
  });

  // 流动性单独取最近 20 根行情，不依赖调用方的展示窗口：短窗口只影响返回的行情，
  // 不把完整缓存判成 DEGRADED。bars_used 如实反映实际参与计算的根数（新上市不足
  // 20 日时为真实根数，不视为数据缺陷）。
  const liquidityBars = (db.prepare(`
    SELECT trade_date, vol, amount FROM fund_daily WHERE ts_code = ? AND trade_date <= ?
    ORDER BY trade_date DESC LIMIT ?`).all(code, end, ETF_LIQUIDITY_WINDOW) as any[]).reverse();
  const amounts = liquidityBars.map(r => (r.amount == null ? null : r.amount * 1000)).filter((v): v is number => v != null && Number.isFinite(v));
  let maxGap: number | null = null;
  for (let i = 1; i < liquidityBars.length; i++) {
    const gap = calendarDays(liquidityBars[i - 1].trade_date, liquidityBars[i].trade_date);
    if (maxGap == null || gap > maxGap) maxGap = gap;
  }

  // 拆分/份额折算：列出窗口内复权因子发生变化的交易日，不把原始价格的不连续
  // 悄悄平滑掉。raw 价格始终保留，复权价按因子换算。
  const factorRows = db.prepare(`
    SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ? AND adj_factor > 0
    ORDER BY trade_date`).all(code, start, end) as any[];
  const adjustmentEvents: { trade_date: string; from_factor: number; to_factor: number; factor_ratio: number }[] = [];
  for (let i = 1; i < factorRows.length; i++) {
    const prev = factorRows[i - 1];
    const cur = factorRows[i];
    if (Math.abs(cur.adj_factor - prev.adj_factor) > 1e-9) {
      adjustmentEvents.push({
        trade_date: cur.trade_date,
        from_factor: prev.adj_factor,
        to_factor: cur.adj_factor,
        factor_ratio: Math.round((cur.adj_factor / prev.adj_factor) * 10000) / 10000,
      });
    }
  }

  const status: EtfQualityStatus = !last ? 'NOT_READY' : reasons.length ? 'DEGRADED' : 'READY';
  const logRow = last ? db.prepare("SELECT synced_at FROM fund_sync_log WHERE dataset = 'fund_daily' AND key = ?").get(last.trade_date) as any : null;

  return {
    ts_code: code,
    name: basic?.name ?? null,
    fund_type: basic?.fund_type ?? null,
    invest_type: basic?.invest_type ?? null,
    market: basic?.market ?? null,
    list_date: basic?.list_date ?? null,
    delist_date: basic?.delist_date || null,
    status: basic?.status ?? null,
    benchmark: basic?.benchmark ?? null,
    trade_unit: ETF_TRADE_UNIT,
    as_of_trade_date: end,
    latest_bar: last ? {
      trade_date: last.trade_date,
      open: last.open ?? null, high: last.high ?? null, low: last.low ?? null, close: closeCny,
      pre_close: last.pre_close ?? null, change: last.change ?? null, pct_chg: last.pct_chg ?? null,
      vol_lots: last.vol ?? null, amount_kcny: last.amount ?? null,
      close_cny: closeCny,
      amount_cny: last.amount == null ? null : Math.round(last.amount * 1000 * 100) / 100,
      volume_shares: last.vol == null ? null : Math.round(last.vol * ETF_LOT_SIZE * 100) / 100,
    } : null,
    adjusted: {
      mode: adjust,
      base,
      open: adjPrice(last?.open), high: adjPrice(last?.high), low: adjPrice(last?.low), close: adjPrice(last?.close),
    },
    adjusted_rows: bars.map(b => {
      const r = barRatio(b.trade_date);
      const p = (v: number | null) => (v == null || !Number.isFinite(r) ? null : round4(v * r));
      return { trade_date: b.trade_date, open: p(b.open), high: p(b.high), low: p(b.low), close: p(b.close) };
    }),
    share: {
      fd_share_wan: latestShare?.fd_share ?? null,
      fd_share_wan_prev: prevShare?.fd_share ?? null,
      share_change_wan: changeWan,
      share_change_pct: changePct,
      latest_share_date: latestShare?.trade_date ?? null,
      previous_share_date: prevShare?.trade_date ?? null,
    },
    flow,
    liquidity: {
      window: ETF_LIQUIDITY_WINDOW,
      bars_used: liquidityBars.length,
      mean_amount_cny: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length * 100) / 100 : null,
      zero_volume_days: liquidityBars.filter(r => r.vol === 0 || r.vol == null).length,
      max_gap_days: maxGap,
    },
    adjustment_events: adjustmentEvents,
    quality: { status, reasons, missing },
    stale,
    expected_trade_date: expected,
    bar_matches_expected: last && expected ? last.trade_date === expected : null,
    source: ETF_SOURCE,
    synced_at: logRow?.synced_at ?? null,
  };
}

// ---------------------------------------------------------------- status

export interface EtfStatusResult {
  initialized: boolean;
  as_of_trade_date: string;
  expected_trade_date: string | null;
  latest_fund_daily_date: string | null;
  universe: readonly string[];
  universe_size: number;
  coverage: { codes_with_bar_on_latest: number; codes_with_basic: number; codes_with_share: number };
  fund_basic: { codes_present: string[]; missing: string[] };
  fund_share: { available: boolean; codes_with_share: number; latest_date: string | null };
  codes: { ts_code: string; name: string | null; status: EtfQualityStatus; reasons: string[]; latest_bar_date: string | null; stale: boolean; share_available: boolean }[];
  quality: { status: EtfQualityStatus; reasons: string[] };
  last_sync: { dataset: string; key: string; rows: number; status: string; synced_at: string }[];
  source: string;
  flow_label_rule: string;
}

/** ETF 数据状态：最新日线日期、五只覆盖、逐只就绪度与份额可得性。空库返回 NOT_READY，不抛异常。 */
export function etfStatus(db: DatabaseSync, q: { date?: unknown } = {}): EtfStatusResult {
  const requested = parseYmd(q.date, 'date');
  const base: EtfStatusResult = {
    initialized: etfSchemaReady(db),
    as_of_trade_date: requested ?? latestTradeDay(db, shanghaiToday()) ?? shanghaiToday(),
    expected_trade_date: null,
    latest_fund_daily_date: null,
    universe: ETF_UNIVERSE,
    universe_size: ETF_UNIVERSE.length,
    coverage: { codes_with_bar_on_latest: 0, codes_with_basic: 0, codes_with_share: 0 },
    fund_basic: { codes_present: [], missing: [...ETF_UNIVERSE] },
    fund_share: { available: false, codes_with_share: 0, latest_date: null },
    codes: [],
    quality: { status: 'NOT_READY', reasons: [] },
    last_sync: [],
    source: ETF_SOURCE,
    flow_label_rule: FLOW_LABEL_RULE,
  };
  if (!base.initialized) {
    base.quality.reasons.push(ETF_NOT_INITIALIZED);
    return base;
  }
  const date = base.as_of_trade_date;
  base.expected_trade_date = latestTradeDay(db, date) ?? null;
  base.latest_fund_daily_date = latestFundDailyDate(db);
  const basics = db.prepare('SELECT ts_code, name FROM fund_basic').all() as any[];
  base.fund_basic.codes_present = basics.map(r => r.ts_code).filter(c => (ETF_UNIVERSE as readonly string[]).includes(c));
  base.fund_basic.missing = ETF_UNIVERSE.filter(c => !base.fund_basic.codes_present.includes(c));
  base.coverage.codes_with_basic = base.fund_basic.codes_present.length;
  const share = db.prepare(`SELECT COUNT(DISTINCT ts_code) n, MAX(trade_date) d FROM fund_share WHERE ts_code IN (${ETF_UNIVERSE.map(() => '?').join(',')})`)
    .get(...ETF_UNIVERSE) as any;
  base.fund_share.codes_with_share = share?.n ?? 0;
  base.fund_share.latest_date = share?.d ?? null;
  base.fund_share.available = (share?.n ?? 0) > 0;

  const quotes = etfQuotes(db, [...ETF_UNIVERSE], { start: addDays(date, -ETF_DEFAULT_WINDOW_DAYS), end: date, adjust: 'none' });
  base.codes = quotes.quotes.map(x => ({
    ts_code: x.ts_code,
    name: x.name,
    status: x.quality.status,
    reasons: x.quality.reasons,
    latest_bar_date: x.latest_bar?.trade_date ?? null,
    stale: x.stale,
    share_available: x.share.fd_share_wan != null,
  }));
  base.coverage.codes_with_bar_on_latest = base.codes.filter(c => c.latest_bar_date === date).length;
  const latest = base.latest_fund_daily_date;
  if (!latest) base.quality.reasons.push('ETF 日线缓存为空，请先运行 finance-ashare etf-sync');
  else if (base.expected_trade_date && latest !== base.expected_trade_date) {
    base.quality.reasons.push(`最新 ETF 日线 ${latest} 落后于最近交易日 ${base.expected_trade_date}`);
  }
  for (const c of base.codes) if (c.status !== 'READY') base.quality.reasons.push(`${c.ts_code}: ${c.reasons.join('; ') || c.status}`);
  base.quality.status = !latest ? 'NOT_READY'
    : base.codes.every(c => c.status === 'READY') && !base.quality.reasons.length ? 'READY' : 'DEGRADED';
  base.last_sync = db.prepare('SELECT dataset, key, rows, status, synced_at FROM fund_sync_log ORDER BY synced_at DESC LIMIT 10').all() as any[];
  return base;
}
