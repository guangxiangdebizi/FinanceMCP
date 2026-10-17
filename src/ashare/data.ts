import type { DatabaseSync } from 'node:sqlite';
import { addDays, checkQuality, CORE_INDICES, latestTradeDay, recentTradeDays, shanghaiToday, tradeDaysBetween } from './ingest.js';

/**
 * Data access layer (module A → consumers). The analysis engine and the MCP
 * data tools read market data, adjustments, financials and metadata through
 * these functions, so there is one definition of codes, dates, units,
 * adjustment and announcement-date availability. Nothing here computes
 * indicators, signals or scores, and nothing here writes to the database.
 */
export const DATA_CONTRACT_VERSION = 'data-1.0.0';

export const LIMITS = {
  history_rows_default: 120,
  history_rows_max: 500,
  history_span_calendar_days_max: 3700,
  financial_periods_default: 8,
  financial_periods_max: 40,
  market_trade_days_max: 60,
  basic_codes_max: 50,
  basic_rows_default: 20,
  basic_rows_max: 100,
};

export const DATA_CONTRACT = {
  version: DATA_CONTRACT_VERSION,
  ts_code: '6 位代码 + 交易所后缀：.SH 上交所、.SZ 深交所、.BJ 北交所（北交所使用 92xxxx 新代码）；也接受 6 位数字或股票全称并解析为唯一代码',
  dates: 'YYYYMMDD（也接受 YYYY-MM-DD），上海时区交易所日期；区间为闭区间 [start_date, end_date]',
  trade_days: '交易日以 Tushare trade_cal（SSE）为准；区间内非交易日不返回行情，自然日与交易日不混用',
  units: {
    price: '元',
    vol: '手（100 股）',
    amount: '千元（amount_yi 字段为亿元）',
    index_amount: '千元',
    total_mv: '万元',
    circ_mv: '万元',
    turnover_rate: '%',
    pct_chg: '%',
  },
  adjust: {
    none: '未复权：交易所原始价格',
    qfq: '前复权：price × adj_factor(t) / adj_factor(base)，base = 查询 end_date 当日或之前最后一个复权因子，不使用 end_date 之后的因子；同一 end_date 分页时价格基准不变',
    hfq: '后复权：price × adj_factor(t)（Tushare 口径，因子基准随上市以来的除权累计）',
    missing_factor: '缺少当日复权因子时，复权价格为 null 并标记 adj_factor_missing，不向前填补',
  },
  missing: '缺失值一律为 null，不转换为 0；停牌、未上市/已退市与无法解释的数据缺口分别列出',
  availability: {
    market_data: 'trade_date = 行情所属交易日；Tushare 未提供逐条发布时间，first_synced_at / last_synced_at 为 FinanceMCP 实际获取时间',
    financials: 'end_date = 报告期；ann_date = 公告日（历史可得性约束）；as_of 查询只返回 ann_date ≤ as_of 的记录。ann_date 早于报告期末的记录视为上游异常，不参与 as-of 选择',
    not_point_in_time: [
      '财务数据：Tushare 不保留历史修订版本；同一公告日的更正记录（update_flag=1）覆盖原记录，原值不可恢复，因此不是严格 Point-in-Time 财务库',
      '行业分类、股票名称（含 ST 标记）、上市状态为当前 stock_basic 口径，不代表历史任意日期的状态',
      '股票代码变更（如 300114.SZ → 302132.SZ）未做新旧代码合并，历史行情分别保存在各自代码下',
    ],
  },
  errors: '参数错误、范围超限或无数据时返回明确的错误信息或 empty=true，不用相邻日期数据替代',
};

export const FINANCIAL_FIELDS: Record<string, { label: string; unit: string }> = {
  roe: { label: '净资产收益率', unit: '%' },
  roe_dt: { label: '净资产收益率（扣非）', unit: '%' },
  netprofit_yoy: { label: '归母净利润同比', unit: '%' },
  dt_netprofit_yoy: { label: '扣非净利润同比', unit: '%' },
  or_yoy: { label: '营业收入同比', unit: '%' },
  grossprofit_margin: { label: '销售毛利率', unit: '%' },
  debt_to_assets: { label: '资产负债率', unit: '%' },
  ocf_to_profit: { label: '经营活动现金净流量相对利润', unit: '%（Tushare 原值为百分数，如 115.11 表示 115.11%）' },
  ocfps: { label: '每股经营活动现金流量', unit: '元/股' },
  eps: { label: '基本每股收益', unit: '元/股' },
};

export class DataQueryError extends Error {}

// ---------------------------------------------------------------- parameters

export function parseYmd(raw: unknown, label: string): string | undefined {
  if (raw == null || raw === '') return undefined;
  const value = String(raw).trim().replace(/-/g, '');
  if (!/^\d{8}$/.test(value)) throw new DataQueryError(`${label} 需要 YYYYMMDD 格式`);
  const d = new Date(Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8)));
  if (d.toISOString().slice(0, 10).replace(/-/g, '') !== value) throw new DataQueryError(`${label} 不是有效日期: ${raw}`);
  return value;
}

export function intParam(raw: unknown, def: number, min: number, max: number, label: string): number {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new DataQueryError(`${label} 需要 ≥ ${min} 的整数`);
  if (n > max) throw new DataQueryError(`${label} 最大为 ${max}，请缩小范围或分页查询`);
  return n;
}

export function listParam(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
  return items.map(x => String(x).trim()).filter(Boolean);
}

/** 600519.SH, 600519 or the exact stock name → ts_code; codes not in stock_basic are accepted when quotes exist. */
export function resolveCode(db: DatabaseSync, raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new DataQueryError('缺少 ts_code');
  const code = text.toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    const row = db.prepare("SELECT ts_code FROM stock_basic WHERE symbol = ? ORDER BY list_status = 'L' DESC LIMIT 1").get(code) as any;
    if (row) return row.ts_code;
  }
  const byName = db.prepare("SELECT ts_code FROM stock_basic WHERE name = ? ORDER BY list_status = 'L' DESC LIMIT 1").get(text) as any;
  if (byName) return byName.ts_code;
  throw new DataQueryError(`无法识别的股票代码: ${text}`);
}

/** Latest trade date on or before today (Shanghai) that the cache knows about. */
export function defaultTradeDate(db: DatabaseSync): string {
  const last = latestTradeDay(db, shanghaiToday());
  if (!last) throw new DataQueryError('交易日历为空，请先运行 finance-ashare sync');
  return last;
}

export function latestCachedDate(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(trade_date) d FROM daily').get() as any).d ?? null;
}

// ---------------------------------------------------------------- provenance

export interface Provenance {
  source: string;
  key: string;
  first_synced_at: string | null;
  last_synced_at: string | null;
  refresh_status: string | null;
  cache_status: string | null;
}

const API_NAMES: Record<string, string> = {
  daily: 'daily', daily_basic: 'daily_basic', adj_factor: 'adj_factor', stk_limit: 'stk_limit',
  suspend_d: 'suspend_d', index_daily: 'index_daily', fina_indicator: 'fina_indicator_vip', stock_basic: 'stock_basic', trade_cal: 'trade_cal',
};

/** When FinanceMCP fetched a dataset key (trade date, report period, …) and how the latest request went. */
export function provenance(db: DatabaseSync, dataset: string, key: string): Provenance {
  const last = db.prepare('SELECT * FROM sync_log WHERE dataset = ? AND key = ?').get(dataset, key) as any;
  const first = db.prepare('SELECT MIN(synced_at) t FROM sync_history WHERE dataset = ? AND key = ?').get(dataset, key) as any;
  return {
    source: `Tushare Pro ${API_NAMES[dataset] ?? dataset}`,
    key,
    first_synced_at: first?.t ?? last?.synced_at ?? null,
    last_synced_at: last?.synced_at ?? null,
    refresh_status: last?.refresh_status ?? null,
    cache_status: last?.status ?? null,
  };
}

// ---------------------------------------------------------------- adjustment

export type AdjustMode = 'none' | 'qfq' | 'hfq';

/** Price multiplier for one bar; NaN when the factor needed is missing. */
export function adjustmentRatio(mode: AdjustMode, factor: number, base: number): number {
  if (mode === 'none') return 1;
  if (!Number.isFinite(factor)) return NaN;
  if (mode === 'hfq') return factor;
  return Number.isFinite(base) && base > 0 ? factor / base : NaN;
}

/** The qfq base: the stock's last adjustment factor on or before `asOf` (never a later one). */
export function baseFactor(db: DatabaseSync, code: string, asOf: string): { trade_date: string; adj_factor: number } | null {
  const row = db.prepare('SELECT trade_date, adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1').get(code, asOf) as any;
  return row ? { trade_date: row.trade_date, adj_factor: row.adj_factor } : null;
}

// ---------------------------------------------------------------- listing, suspensions, coverage

export function isListedOn(basic: { list_date?: string | null; delist_date?: string | null } | undefined, date: string): boolean {
  if (!basic?.list_date) return false;
  return basic.list_date <= date && (!basic.delist_date || basic.delist_date > date);
}

export interface Coverage {
  trade_days: number;
  bars: number;
  suspended_days: string[];
  not_listed_days: number;
  /** After the last bar of a stock with a delisting date: no longer quoted, not a gap. */
  pending_delisting_days: string[];
  /** A per-stock Tushare check (cache audit) found neither a bar nor a suspension: an upstream gap. */
  upstream_missing_days: string[];
  /** Listed, not suspended and no bar: a real gap (or suspension data not yet synced). */
  missing_days: string[];
  suspend_data_missing_days: number;
}

/**
 * Classify every trade day in [start, end] for one stock: a bar, a recorded
 * suspension, outside the listing period, or an unexplained gap. Suspension
 * data is only as complete as the suspend_d sync; days without it are counted.
 */
export function stockCoverage(db: DatabaseSync, code: string, start: string, end: string, barDates: Set<string>): Coverage {
  const days = tradeDaysBetween(db, start, end);
  const basic = db.prepare('SELECT list_date, delist_date FROM stock_basic WHERE ts_code = ?').get(code) as any;
  const suspended = new Set((db.prepare('SELECT trade_date FROM suspend_d WHERE ts_code = ? AND trade_date BETWEEN ? AND ?').all(code, start, end) as any[]).map(r => r.trade_date));
  const synced = new Set((db.prepare("SELECT key FROM sync_log WHERE dataset = 'suspend_d' AND status = 'ok' AND key BETWEEN ? AND ?").all(start, end) as any[]).map(r => r.key));
  const span = db.prepare('SELECT MIN(trade_date) a, MAX(trade_date) z FROM daily WHERE ts_code = ?').get(code) as any;
  const upstream = new Set((db.prepare('SELECT trade_date FROM gap_check WHERE ts_code = ? AND trade_date BETWEEN ? AND ? AND upstream_daily = 0 AND upstream_suspended = 0').all(code, start, end) as any[]).map(r => r.trade_date));
  const out: Coverage = { trade_days: days.length, bars: 0, suspended_days: [], not_listed_days: 0, pending_delisting_days: [], upstream_missing_days: [], missing_days: [], suspend_data_missing_days: 0 };
  for (const d of days) {
    if (barDates.has(d)) { out.bars++; continue; }
    // Without a stock_basic row (code change), the stock's own quote span stands in for the listing period.
    const listed = basic ? isListedOn(basic, d) : (span?.a ? d >= span.a && d <= span.z : false);
    if (!listed) { out.not_listed_days++; continue; }
    if (suspended.has(d)) { out.suspended_days.push(d); continue; }
    // Same rule as the cache audit.
    if (basic?.delist_date && span?.z && d > span.z) { out.pending_delisting_days.push(d); continue; }
    if (upstream.has(d)) { out.upstream_missing_days.push(d); continue; }
    if (!synced.has(d)) out.suspend_data_missing_days++;
    out.missing_days.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- stock history

export interface StockHistoryQuery {
  ts_code?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  adjust?: unknown;
  limit?: unknown;
  include_basic?: unknown;
}

const HISTORY_FIELDS = ['trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount', 'adj_factor'];
const ADJ_FIELDS = ['adj_open', 'adj_high', 'adj_low', 'adj_close'];
const BASIC_FIELDS = ['turnover_rate', 'volume_ratio', 'pe_ttm', 'pb', 'total_mv', 'circ_mv'];

/**
 * Daily bars of one stock over [start, end] (closed), oldest first, at most
 * `limit` rows. Without a start, the window holds the last `limit` trade days
 * up to end. When truncated, `next_start_date` continues with the same end
 * (so the qfq base stays the same across pages).
 */
export function stockHistory(db: DatabaseSync, q: StockHistoryQuery) {
  const code = resolveCode(db, q.ts_code);
  const adjust = (q.adjust == null || q.adjust === '' ? 'qfq' : String(q.adjust)) as AdjustMode;
  if (!['none', 'qfq', 'hfq'].includes(adjust)) throw new DataQueryError('adjust 只能是 none、qfq 或 hfq');
  const limit = intParam(q.limit, LIMITS.history_rows_default, 1, LIMITS.history_rows_max, 'limit');
  const end = parseYmd(q.end_date, 'end_date') ?? defaultTradeDate(db);
  const start = parseYmd(q.start_date, 'start_date') ?? (recentTradeDays(db, end, limit)[0] ?? end);
  if (start > end) throw new DataQueryError(`start_date ${start} 晚于 end_date ${end}`);
  if (addDays(start, LIMITS.history_span_calendar_days_max) < end) throw new DataQueryError(`日期区间超过 ${LIMITS.history_span_calendar_days_max} 个自然日，请分段查询`);
  const includeBasic = q.include_basic === true || q.include_basic === 'true';

  const basic = db.prepare('SELECT ts_code, name, industry, list_date, delist_date, list_status FROM stock_basic WHERE ts_code = ?').get(code) as any;
  const rows = db.prepare(`
    SELECT d.trade_date, d.open, d.high, d.low, d.close, d.pre_close, d.pct_chg, d.vol, d.amount, a.adj_factor
      ${includeBasic ? ', b.turnover_rate, b.volume_ratio, b.pe_ttm, b.pb, b.total_mv, b.circ_mv' : ''}
    FROM daily d
    LEFT JOIN adj_factor a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
    ${includeBasic ? 'LEFT JOIN daily_basic b ON b.ts_code = d.ts_code AND b.trade_date = d.trade_date' : ''}
    WHERE d.ts_code = ? AND d.trade_date BETWEEN ? AND ?
    ORDER BY d.trade_date LIMIT ?`).all(code, start, end, limit + 1) as any[];
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  const pageEnd = truncated ? rows.at(-1).trade_date : end;
  const nextStart = truncated ? (db.prepare('SELECT MIN(trade_date) d FROM daily WHERE ts_code = ? AND trade_date > ? AND trade_date <= ?').get(code, pageEnd, end) as any).d : null;

  const base = adjust === 'qfq' ? baseFactor(db, code, end) : null;
  if (adjust === 'qfq' && rows.length && !base) throw new DataQueryError(`${code} 在 ${end} 之前没有复权因子，无法前复权；请使用 adjust=none`);
  const fields = [...HISTORY_FIELDS, ...(adjust === 'none' ? [] : ADJ_FIELDS), 'adj_factor_missing', ...(includeBasic ? BASIC_FIELDS : [])];
  const adjMissing: string[] = [];
  const out = rows.map(r => {
    const missing = !(r.adj_factor > 0);
    if (missing) adjMissing.push(r.trade_date);
    const ratio = adjustmentRatio(adjust, missing ? NaN : r.adj_factor, base?.adj_factor ?? NaN);
    const adj = (v: number | null) => (v == null || !Number.isFinite(ratio) ? null : Math.round(v * ratio * 10000) / 10000);
    return [
      r.trade_date, r.open, r.high, r.low, r.close, r.pre_close, r.pct_chg, r.vol, r.amount, r.adj_factor ?? null,
      ...(adjust === 'none' ? [] : [adj(r.open), adj(r.high), adj(r.low), adj(r.close)]),
      missing,
      ...(includeBasic ? BASIC_FIELDS.map(f => r[f] ?? null) : []),
    ];
  });

  const coverage = stockCoverage(db, code, start, pageEnd, new Set(rows.map(r => r.trade_date)));
  const lastCached = latestCachedDate(db);
  const warnings: string[] = [];
  if (!basic) warnings.push(`${code} 不在当前 stock_basic 中（可能为代码变更或已从清单移除），名称、行业与上市日期不可得`);
  if (adjMissing.length) warnings.push(`${adjMissing.length} 个交易日缺少复权因子，复权价格为 null`);
  if (coverage.upstream_missing_days.length) warnings.push(`${coverage.upstream_missing_days.length} 个交易日上游（Tushare）确认既无行情也无停牌记录`);
  if (coverage.missing_days.length) warnings.push(`${coverage.missing_days.length} 个交易日在上市期内既无行情也无停牌记录${coverage.suspend_data_missing_days ? `（其中 ${coverage.suspend_data_missing_days} 天尚未同步停牌数据）` : ''}`);
  if (lastCached && end > lastCached) warnings.push(`end_date ${end} 晚于缓存最新交易日 ${lastCached}`);
  if (!rows.length) warnings.push('区间内无行情数据');
  const q0 = rows.length ? checkQuality(db, rows.at(-1).trade_date, false) : null;

  return {
    ts_code: code,
    name: basic?.name ?? null,
    list_date: basic?.list_date ?? null,
    delist_date: basic?.delist_date || null,
    list_status: basic?.list_status ?? null,
    query: { start_date: start, end_date: end, adjust, limit, include_basic: includeBasic },
    returned: { first: rows[0]?.trade_date ?? null, last: rows.at(-1)?.trade_date ?? null, rows: rows.length },
    truncated,
    next_start_date: nextStart,
    adjust: {
      mode: adjust,
      formula: DATA_CONTRACT.adjust[adjust],
      base: base ? { trade_date: base.trade_date, adj_factor: base.adj_factor } : null,
    },
    units: { price: DATA_CONTRACT.units.price, vol: DATA_CONTRACT.units.vol, amount: DATA_CONTRACT.units.amount, ...(includeBasic ? { total_mv: '万元', circ_mv: '万元', turnover_rate: '%' } : {}) },
    fields,
    rows: out,
    coverage: {
      trade_days: coverage.trade_days,
      bars: coverage.bars,
      suspended_days: coverage.suspended_days,
      not_listed_days: coverage.not_listed_days,
      pending_delisting_days: coverage.pending_delisting_days,
      upstream_missing_days: coverage.upstream_missing_days,
      missing_days: coverage.missing_days,
      suspend_data_missing_days: coverage.suspend_data_missing_days,
      adj_factor_missing_days: adjMissing,
    },
    data_quality: q0 ? { trade_date: q0.trade_date, status: q0.status, cache_status: q0.cache_status } : null,
    source: ['daily', 'adj_factor', ...(includeBasic ? ['daily_basic'] : [])].map(ds => provenance(db, ds, rows.at(-1)?.trade_date ?? end)),
    warnings,
    contract_version: DATA_CONTRACT_VERSION,
  };
}

// ---------------------------------------------------------------- financials

export interface FinancialRecord {
  ts_code: string;
  end_date: string;
  ann_date: string;
  [field: string]: any;
}

/**
 * Point-in-time financial indicators: for each stock, the latest report
 * period whose announcement date is on or before `asOf`, and within that
 * period the latest announcement on or before `asOf`. Reports older than
 * 18 months are treated as missing rather than stale-but-current. Records
 * announced before their period even ends are upstream errors and never used.
 */
export function financialsAsOf(db: DatabaseSync, asOf: string): Map<string, FinancialRecord> {
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT f.*, ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY end_date DESC, ann_date DESC) rn
      FROM fina_indicator f
      WHERE ann_date <= ? AND end_date >= ? AND ann_date >= end_date
    ) WHERE rn = 1`).all(asOf, addDays(asOf, -550)) as any[];
  return new Map(rows.map(r => {
    delete r.rn;
    return [r.ts_code, r as FinancialRecord];
  }));
}

const isPeriod = (p: string) => /^\d{4}(0331|0630|0930|1231)$/.test(p);

export interface FinancialQuery {
  ts_code?: unknown;
  as_of_date?: unknown;
  start_period?: unknown;
  end_period?: unknown;
  limit?: unknown;
  include_revisions?: unknown;
}

/**
 * Financial indicator history of one stock as known on `as_of_date`: per
 * report period, the latest announcement on or before as_of (the same rule as
 * the analysis engine). Announcements after as_of are not returned, only
 * counted; records announced before their period end are listed as anomalies.
 */
export function financialHistory(db: DatabaseSync, q: FinancialQuery) {
  const code = resolveCode(db, q.ts_code);
  const asOf = parseYmd(q.as_of_date, 'as_of_date') ?? defaultTradeDate(db);
  const startPeriod = parseYmd(q.start_period, 'start_period');
  const endPeriod = parseYmd(q.end_period, 'end_period');
  for (const [p, label] of [[startPeriod, 'start_period'], [endPeriod, 'end_period']] as const) {
    if (p && !isPeriod(p)) throw new DataQueryError(`${label} 必须是报告期末（YYYY0331/0630/0930/1231）`);
  }
  if (startPeriod && endPeriod && startPeriod > endPeriod) throw new DataQueryError('start_period 晚于 end_period');
  const limit = intParam(q.limit, LIMITS.financial_periods_default, 1, LIMITS.financial_periods_max, 'limit');
  const withRevisions = q.include_revisions === true || q.include_revisions === 'true';
  const fields = Object.keys(FINANCIAL_FIELDS);

  const all = db.prepare(`SELECT ts_code, end_date, ann_date, ${fields.join(', ')} FROM fina_indicator
    WHERE ts_code = ? AND end_date BETWEEN ? AND ? ORDER BY end_date DESC, ann_date DESC`)
    .all(code, startPeriod ?? '00000000', endPeriod ?? '99999999') as any[];
  const anomalies = all.filter(r => r.ann_date < r.end_date && r.ann_date <= asOf)
    .map(r => ({ end_date: r.end_date, ann_date: r.ann_date, issue: 'ann_date_before_period_end', handling: '公告日早于报告期末，视为上游异常，不参与 as-of 选择' }));
  const known = all.filter(r => r.ann_date <= asOf && r.ann_date >= r.end_date);
  const hidden = all.filter(r => r.ann_date > asOf).length;

  const byPeriod = new Map<string, any[]>();
  for (const r of known) {
    if (!byPeriod.has(r.end_date)) byPeriod.set(r.end_date, []);
    byPeriod.get(r.end_date)!.push(r);
  }
  const periods = [...byPeriod.entries()].slice(0, limit).map(([endDate, recs]) => {
    const [selected, ...older] = recs;
    const values = Object.fromEntries(fields.map(f => [f, selected[f] ?? null]));
    const changed = (a: any, b: any) => fields.filter(f => (a[f] ?? null) !== (b[f] ?? null));
    return {
      end_date: endDate,
      ann_date: selected.ann_date,
      values,
      announcements: recs.length,
      ...(recs.length > 1 ? {
        revisions: withRevisions
          ? older.map(o => ({ ann_date: o.ann_date, values: Object.fromEntries(fields.map(f => [f, o[f] ?? null])), changed_fields: changed(selected, o) }))
          : older.map(o => ({ ann_date: o.ann_date, changed_fields: changed(selected, o) })),
      } : {}),
    };
  });
  const basic = db.prepare('SELECT name, industry, list_status FROM stock_basic WHERE ts_code = ?').get(code) as any;
  const syncedPeriods = periods.map(p => provenance(db, 'fina_indicator', p.end_date));
  return {
    ts_code: code,
    name: basic?.name ?? null,
    as_of_date: asOf,
    query: { start_period: startPeriod ?? null, end_period: endPeriod ?? null, limit, include_revisions: withRevisions },
    selection_rule: '每个报告期取 ann_date ≤ as_of_date 的最新一条公告；ann_date < end_date 的记录不参与（与分析引擎 financialsAsOf 同一规则）',
    truncated: byPeriod.size > limit,
    periods,
    units: Object.fromEntries(fields.map(f => [f, FINANCIAL_FIELDS[f]])),
    hidden_after_as_of: hidden,
    anomalies,
    availability: {
      rule: DATA_CONTRACT.availability.financials,
      limitations: [DATA_CONTRACT.availability.not_point_in_time[0]],
    },
    source: syncedPeriods.length ? syncedPeriods : [provenance(db, 'fina_indicator', '')],
    empty: periods.length === 0,
    contract_version: DATA_CONTRACT_VERSION,
  };
}

// ---------------------------------------------------------------- market

export interface BreadthRow {
  trade_date: string;
  stocks: number;
  up: number;
  down: number;
  flat: number;
  limit_up: number;
  limit_down: number;
  with_limit: number;
  /** Thousand yuan. */
  amount: number;
}

/** Whole-market up/down/limit counts and turnover per trade date (raw counts, no interpretation). */
export function breadthByDate(db: DatabaseSync, start: string, end: string): Map<string, BreadthRow> {
  const rows = db.prepare(`
    SELECT d.trade_date, COUNT(*) stocks,
      SUM(CASE WHEN d.pct_chg > 0 THEN 1 ELSE 0 END) up,
      SUM(CASE WHEN d.pct_chg < 0 THEN 1 ELSE 0 END) down,
      SUM(CASE WHEN d.pct_chg = 0 THEN 1 ELSE 0 END) flat,
      SUM(CASE WHEN l.up_limit IS NOT NULL AND d.close >= l.up_limit - 0.001 THEN 1 ELSE 0 END) limit_up,
      SUM(CASE WHEN l.down_limit IS NOT NULL AND d.close <= l.down_limit + 0.001 THEN 1 ELSE 0 END) limit_down,
      SUM(CASE WHEN l.ts_code IS NOT NULL THEN 1 ELSE 0 END) with_limit,
      SUM(d.amount) amount
    FROM daily d LEFT JOIN stk_limit l ON l.trade_date = d.trade_date AND l.ts_code = d.ts_code
    WHERE d.trade_date BETWEEN ? AND ? GROUP BY d.trade_date ORDER BY d.trade_date`).all(start, end) as any[];
  return new Map(rows.map(r => [r.trade_date, {
    trade_date: r.trade_date, stocks: r.stocks, up: r.up ?? 0, down: r.down ?? 0, flat: r.flat ?? 0,
    limit_up: r.limit_up ?? 0, limit_down: r.limit_down ?? 0, with_limit: r.with_limit ?? 0, amount: r.amount ?? 0,
  }]));
}

export interface MarketQuery {
  start_date?: unknown;
  end_date?: unknown;
  indices?: unknown;
  include_breadth?: unknown;
}

const round = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Core index bars and whole-market counts per trade date over a bounded range. */
export function marketData(db: DatabaseSync, q: MarketQuery) {
  const end = parseYmd(q.end_date, 'end_date') ?? defaultTradeDate(db);
  const start = parseYmd(q.start_date, 'start_date') ?? end;
  if (start > end) throw new DataQueryError(`start_date ${start} 晚于 end_date ${end}`);
  const requested = listParam(q.indices).map(c => c.toUpperCase());
  const unknown = requested.filter(c => !(c in CORE_INDICES));
  if (unknown.length) throw new DataQueryError(`不支持的指数: ${unknown.join(',')}；可选 ${Object.keys(CORE_INDICES).join(',')}`);
  const indices = requested.length ? requested : Object.keys(CORE_INDICES);
  const withBreadth = !(q.include_breadth === false || q.include_breadth === 'false');
  const days = tradeDaysBetween(db, start, end);
  if (days.length > LIMITS.market_trade_days_max) {
    throw new DataQueryError(`区间含 ${days.length} 个交易日，单次最多 ${LIMITS.market_trade_days_max} 个，请缩小日期范围或分段查询`);
  }
  const placeholders = indices.map(() => '?').join(',');
  const bars = db.prepare(`SELECT * FROM index_daily WHERE ts_code IN (${placeholders}) AND trade_date BETWEEN ? AND ? ORDER BY trade_date, ts_code`)
    .all(...indices, start, end) as any[];
  const breadth = withBreadth ? breadthByDate(db, start, end) : new Map<string, BreadthRow>();
  const suspended = new Map((db.prepare('SELECT trade_date, COUNT(*) n FROM suspend_d WHERE trade_date BETWEEN ? AND ? GROUP BY trade_date').all(start, end) as any[]).map(r => [r.trade_date, r.n]));
  const suspendSynced = new Set((db.prepare("SELECT key FROM sync_log WHERE dataset = 'suspend_d' AND status = 'ok' AND key BETWEEN ? AND ?").all(start, end) as any[]).map(r => r.key));
  const listed = db.prepare("SELECT COUNT(*) n FROM stock_basic WHERE list_date <= ? AND (delist_date IS NULL OR delist_date = '' OR delist_date > ?)");

  const out = days.map(day => {
    const q0 = checkQuality(db, day, false);
    const b = breadth.get(day);
    const limitCoverage = b && b.stocks ? b.with_limit / b.stocks : null;
    return {
      trade_date: day,
      data_quality: { status: q0.status, cache_status: q0.cache_status, reasons: q0.reasons },
      indices: bars.filter(r => r.trade_date === day).map(r => ({
        ts_code: r.ts_code, name: CORE_INDICES[r.ts_code], open: r.open, high: r.high, low: r.low, close: r.close,
        pre_close: r.pre_close, pct_chg: r.pct_chg, vol: r.vol, amount: r.amount, amount_yi: round(r.amount / 1e5),
      })),
      missing_indices: indices.filter(c => !bars.some(r => r.trade_date === day && r.ts_code === c)),
      ...(withBreadth ? {
        breadth: b ? {
          stocks_traded: b.stocks, up: b.up, down: b.down, flat: b.flat,
          limit_up: b.limit_up, limit_down: b.limit_down,
          limit_price_coverage: round(limitCoverage, 4),
          limit_counts_complete: limitCoverage != null && limitCoverage >= 0.95,
          amount: b.amount, amount_yi: round(b.amount / 1e5),
          listed: (listed.get(day, day) as any).n,
          suspended: suspendSynced.has(day) ? (suspended.get(day) ?? 0) : null,
        } : null,
      } : {}),
    };
  });
  return {
    query: { start_date: start, end_date: end, indices, include_breadth: withBreadth },
    trade_days: days.length,
    days: out,
    empty: days.length === 0,
    definitions: {
      up_down: 'pct_chg > 0 / < 0 / = 0 的股票数（仅当日有成交行情的股票）',
      limit_up_down: '收盘价 ≥ 涨停价 − 0.001 / ≤ 跌停价 + 0.001；涨跌停价覆盖率 < 95% 时 limit_counts_complete=false',
      suspended: 'Tushare suspend_d 当日停牌数；该日停牌数据未同步时为 null',
      listed: '当前 stock_basic 中按上市/退市日期在当日处于上市期的股票数（当前口径）',
    },
    units: { index_price: '点', vol: '手', amount: '千元', amount_yi: '亿元' },
    source: [provenance(db, 'daily', end), provenance(db, 'stk_limit', end), provenance(db, 'suspend_d', end)],
    contract_version: DATA_CONTRACT_VERSION,
  };
}

// ---------------------------------------------------------------- stock basics

export interface BasicQuery {
  ts_codes?: unknown;
  query?: unknown;
  industry?: unknown;
  list_status?: unknown;
  limit?: unknown;
  offset?: unknown;
}

const BASIC_COLUMNS = 'ts_code, symbol, name, area, industry, market, exchange, list_date, delist_date, list_status, is_hs, updated_at';

/** Stock master data by code list or by a bounded search. */
export function stockBasic(db: DatabaseSync, q: BasicQuery) {
  const codes = listParam(q.ts_codes);
  if (codes.length > LIMITS.basic_codes_max) throw new DataQueryError(`ts_codes 最多 ${LIMITS.basic_codes_max} 个`);
  const clean = (r: any) => ({ ...r, delist_date: r.delist_date || null });
  const common = {
    limitations: [DATA_CONTRACT.availability.not_point_in_time[1], DATA_CONTRACT.availability.not_point_in_time[2]],
    source: provenance(db, 'stock_basic', 'all'),
    contract_version: DATA_CONTRACT_VERSION,
  };
  if (codes.length) {
    const found: any[] = [];
    const notFound: string[] = [];
    for (const raw of codes) {
      let code: string;
      try { code = resolveCode(db, raw); } catch { notFound.push(raw); continue; }
      if (found.some(f => f.ts_code === code)) continue;
      const row = db.prepare(`SELECT ${BASIC_COLUMNS} FROM stock_basic WHERE ts_code = ?`).get(code) as any;
      if (row) found.push(clean(row));
      else notFound.push(raw);
    }
    return { mode: 'codes', stocks: found, not_found: notFound, total: found.length, truncated: false, ...common };
  }
  const where: string[] = [];
  const params: any[] = [];
  const text = q.query == null ? '' : String(q.query).trim();
  if (text) {
    where.push("(name LIKE ? ESCAPE '\\' OR symbol LIKE ? ESCAPE '\\' OR ts_code LIKE ? ESCAPE '\\')");
    const like = `%${text.replace(/[\\%_]/g, c => '\\' + c)}%`;
    params.push(like, like, like);
  }
  if (q.industry != null && q.industry !== '') { where.push('industry = ?'); params.push(String(q.industry).trim()); }
  if (q.list_status != null && q.list_status !== '') {
    const st = String(q.list_status).toUpperCase();
    if (!['L', 'D', 'P'].includes(st)) throw new DataQueryError('list_status 只能是 L、D 或 P');
    where.push('list_status = ?'); params.push(st);
  }
  if (!where.length) throw new DataQueryError('请提供 ts_codes，或 query / industry / list_status 至少一个筛选条件');
  const limit = intParam(q.limit, LIMITS.basic_rows_default, 1, LIMITS.basic_rows_max, 'limit');
  const offset = intParam(q.offset, 0, 0, 100000, 'offset');
  const cond = `WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) n FROM stock_basic ${cond}`).get(...params) as any).n;
  const rows = db.prepare(`SELECT ${BASIC_COLUMNS} FROM stock_basic ${cond} ORDER BY ts_code LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  return {
    mode: 'search', stocks: rows.map(clean), total, offset, limit,
    truncated: offset + rows.length < total, next_offset: offset + rows.length < total ? offset + rows.length : null, ...common,
  };
}
