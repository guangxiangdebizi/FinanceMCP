import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import type { Reason } from './scenario.js';
import type { EtfQuoteInput, QuoteQuality } from './scenario.js';
import { resolveInstrument, type ResolvedInstrument } from './instrument.js';

/**
 * 服务端可信报价（工作包 A4）。
 *
 * 只读本地市场缓存，按“目标交易日 as_of 当日或之前最后一根 bar”取价，并如实报告：
 * - 真实 bar 的 `trade_date`（不是调用方声称的日期）；
 * - 是否等于该 as_of 的预期最近交易日（不等即 STALE）；
 * - 停牌（个股查 `suspend_d`，ETF 以当日无 bar 视为不可取价）；
 * - 上市状态（`fund_basic.status` / `stock_basic.list_status`）；
 * - ETF 的 `fund_adj` 因子（仅作参考，未复权价才是可交易价格）。
 *
 * 不访问网络、不写缓存、不把缺失数据补成 0 或旧值。
 */

export type QuoteSource = 'market_cache' | 'caller_supplied';

export interface ServerQuote {
  found: boolean;
  ts_code: string;
  /** 未复权收盘价，元；缺失为 null。 */
  price: number | null;
  /** bar 的真实交易日 YYYYMMDD。 */
  trade_date: string | null;
  quality: QuoteQuality;
  reasons: string[];
  source: 'market_cache';
  /** 请求的目标交易日。 */
  as_of: string;
  /** 该 as_of 的预期最近交易日（来自 trade_cal）；日历缺失为 null。 */
  expected_trade_date: string | null;
  list_status: string | null;
  suspended: boolean;
  /** ETF 的 fund_adj 因子，仅参考；个股为 null。 */
  adj_factor: number | null;
  /** 停牌状态是否可判定：个股 suspend_d 未同步该日时为 false。 */
  suspension_known: boolean;
}

export interface QuoteCache {
  /** 目标交易日是否在交易日历中且开市；日历缺失返回 undefined。 */
  isTradeDay(date: string): boolean | undefined;
  /** 该日或之前最近的开市日。 */
  latestTradeDay(date: string): string | undefined;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 交易日历查询；`trade_cal` 缺失时全部返回 undefined，由调用方降级。 */
export function tradeCalendar(db: DatabaseSync): QuoteCache {
  const ready = tableExists(db, 'trade_cal');
  return {
    isTradeDay(date: string): boolean | undefined {
      if (!ready) return undefined;
      const row = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(date) as any;
      return row ? row.is_open === 1 : undefined;
    },
    latestTradeDay(date: string): string | undefined {
      if (!ready) return undefined;
      const row = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 1').get(date) as any;
      return row?.cal_date;
    },
  };
}

const NOT_READY = (code: string, asOf: string, reason: string, extra: Partial<ServerQuote> = {}): ServerQuote => ({
  found: false, ts_code: code, price: null, trade_date: null, quality: 'NOT_READY',
  reasons: [reason], source: 'market_cache', as_of: asOf, expected_trade_date: null,
  list_status: null, suspended: false, adj_factor: null, suspension_known: false, ...extra,
});

/**
 * 读取服务端行情。`kind` 必须来自 `resolveInstrument`，不得由调用方直接给出。
 * 无 bar、非交易日、停牌、过期、非上市、价格非法 → quality 不为 READY。
 */
export function loadServerQuote(
  db: DatabaseSync,
  tsCode: string,
  asOf: string,
  kind: 'ETF' | 'STOCK' | 'UNKNOWN',
  calendar: QuoteCache = tradeCalendar(db),
): ServerQuote {
  const asOfIsTradeDay = calendar.isTradeDay(asOf);
  const expected = calendar.latestTradeDay(asOf) ?? null;
  const base = { source: 'market_cache' as const, as_of: asOf, expected_trade_date: expected };

  if (kind === 'UNKNOWN') return NOT_READY(tsCode, asOf, 'instrument_unknown', base);
  if (asOfIsTradeDay === false) {
    return NOT_READY(tsCode, asOf, 'as_of_not_a_trade_day', { ...base, quality: 'NOT_READY' });
  }
  if (asOfIsTradeDay === undefined) {
    return NOT_READY(tsCode, asOf, 'trade_calendar_missing', base);
  }

  const table = kind === 'ETF' ? 'fund_daily' : 'daily';
  if (!tableExists(db, table)) return NOT_READY(tsCode, asOf, `${table}_missing`, base);

  let bar: any;
  try {
    bar = db.prepare(`SELECT trade_date, open, high, low, close, pre_close FROM ${table}
      WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`).get(tsCode, asOf);
  } catch {
    return NOT_READY(tsCode, asOf, `${table}_unreadable`, base);
  }
  if (!bar) return NOT_READY(tsCode, asOf, 'no_bar_on_or_before_as_of', base);

  const reasons: string[] = [];
  const tradeDate = String(bar.trade_date);
  const close = typeof bar.close === 'number' && Number.isFinite(bar.close) && bar.close > 0 ? bar.close : null;
  if (close === null) reasons.push('invalid_close');
  // OHLC 一致性：low ≤ close ≤ high 且都为正；非法价格不得返回 READY。
  const ohlc = [bar.open, bar.high, bar.low].filter((v: unknown) => typeof v === 'number' && Number.isFinite(v)) as number[];
  if (ohlc.length === 3 && !(bar.low > 0 && bar.high >= bar.low && bar.open > 0 && close !== null && close >= bar.low && close <= bar.high)) {
    reasons.push('ohlc_inconsistent');
  }

  // 上市状态：以 fund_basic / stock_basic 为准，不看调用方。
  let listStatus: string | null = null;
  try {
    if (kind === 'ETF') {
      listStatus = (db.prepare('SELECT status s FROM fund_basic WHERE ts_code = ?').get(tsCode) as any)?.s ?? null;
    } else {
      listStatus = (db.prepare('SELECT list_status s FROM stock_basic WHERE ts_code = ?').get(tsCode) as any)?.s ?? null;
    }
  } catch {
    listStatus = null;
  }
  if (listStatus && listStatus !== 'L') reasons.push(`list_status_${listStatus}`);

  // 停牌：个股查 suspend_d；ETF 以当日无 bar 视为不可取价（fund_daily 无停牌表）。
  let suspended = false;
  let suspensionKnown = kind === 'ETF';
  if (kind === 'STOCK' && tableExists(db, 'suspend_d')) {
    try {
      suspended = !!db.prepare('SELECT 1 FROM suspend_d WHERE ts_code = ? AND trade_date = ?').get(tsCode, asOf);
      suspensionKnown = true;
    } catch {
      suspensionKnown = false;
    }
  }
  if (suspended) reasons.push('suspended_on_as_of');

  let adjFactor: number | null = null;
  if (kind === 'ETF' && tableExists(db, 'fund_adj')) {
    const row = db.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date = ?').get(tsCode, tradeDate) as any;
    adjFactor = typeof row?.adj_factor === 'number' ? row.adj_factor : null;
  }

  // 预期最近交易日与真实 bar 日期必须一致，否则是过期行情。
  if (expected && tradeDate !== expected) reasons.push(`stale_bar:${tradeDate}!=${expected}`);

  let quality: QuoteQuality;
  if (close === null || reasons.includes('ohlc_inconsistent')) quality = 'NOT_READY';
  else if (reasons.length > 0) quality = 'STALE';
  else quality = 'READY';

  return {
    found: true,
    ts_code: tsCode,
    price: close,
    trade_date: tradeDate,
    quality,
    reasons,
    source: 'market_cache',
    as_of: asOf,
    expected_trade_date: expected,
    list_status: listStatus,
    suspended,
    adj_factor: adjFactor,
    suspension_known: suspensionKnown,
  };
}

// ---------------------------------------------------------------- 情景输入装配

/** 情景数据来源模式：服务端只读缓存，或调用方显式要求的研究/演示模式。 */
export type ScenarioMode = 'server' | 'research';

export interface ScenarioQuoteBundle {
  quotes: Map<string, EtfQuoteInput>;
  resolved: { sell?: ResolvedInstrument; buy?: ResolvedInstrument };
  /** 服务端数据不足时的原因（如 as_of 非交易日、缓存不可用），并入情景 reasons。 */
  preconditions: Reason[];
  mode: ScenarioMode;
  /** 服务端行情是否可用（缓存存在且 as_of 是交易日）。 */
  server_cache_available: boolean;
  /** 每个代码的服务端报价明细，供工具输出审计。 */
  server_quotes: ServerQuote[];
  warnings: string[];
}

/** 只读打开本地市场缓存；文件不存在或无法只读打开时返回 null（不创建、不写入）。 */
export function openMarketCache(path: string = ashareDbPath()): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 15000;');
    return db;
  } catch {
    return null;
  }
}

/**
 * 按模式装配情景行情。
 *
 * - `server`（默认）：只读市场缓存按 as_of 的真实交易日取价，附上真实 trade_date、
 *   质量、上市与停牌状态；缓存不可用或 as_of 非交易日时给出 DATA_INSUFFICIENT 原因，
 *   绝不退回调用方报价。
 * - `research`：调用方显式要求的研究/演示模式，接受调用方自填价格，但标记为
 *   `caller_supplied`，因此结果最多 ILLUSTRATIVE。
 */
export function buildScenarioQuotes(input: {
  marketDb: DatabaseSync | null;
  asOf: string;
  sellCode?: string;
  buyCode?: string;
  mode?: ScenarioMode;
  callerQuotes?: Map<string, EtfQuoteInput> | Record<string, EtfQuoteInput>;
  callerClaims?: { buy?: { kind?: string; board?: string } };
}): ScenarioQuoteBundle {
  const mode: ScenarioMode = input.mode === 'research' ? 'research' : 'server';
  const quotes = new Map<string, EtfQuoteInput>();
  const resolved: { sell?: ResolvedInstrument; buy?: ResolvedInstrument } = {};
  const preconditions: Reason[] = [];
  const warnings: string[] = [];
  const serverQuotes: ServerQuote[] = [];

  const codes = [...new Set([input.sellCode, input.buyCode].filter((c): c is string => !!c))];
  const callerMap = input.callerQuotes instanceof Map ? input.callerQuotes : new Map(Object.entries(input.callerQuotes ?? {}));
  const marketDb = input.marketDb;
  const serverUsable = !!marketDb;

  if (!marketDb) {
    preconditions.push({ code: 'data_insufficient', detail: '本地市场缓存不可用（文件缺失或无法只读打开），无法取得服务端行情' });
  }
  if (marketDb) {
    if (input.sellCode) resolved.sell = resolveInstrument(marketDb, input.sellCode);
    if (input.buyCode) resolved.buy = resolveInstrument(marketDb, input.buyCode);
  }

  for (const code of codes) {
    if (mode === 'research') {
      const raw = callerMap.get(code);
      if (raw) {
        quotes.set(code, {
          ...raw,
          // 调用方报价一律标记为自填，不能因为写了 quality:'READY' 就提升信任。
          quality: raw.quality ?? 'READY',
          list_status: raw.list_status ?? 'L',
          source: 'caller_supplied',
        });
      }
      continue;
    }
    // server 模式
    if (!serverUsable) continue;
    const kind = (code === input.sellCode ? resolved.sell?.kind : resolved.buy?.kind) ?? 'UNKNOWN';
    const q = loadServerQuote(marketDb!, code, input.asOf, kind);
    serverQuotes.push(q);
    if (!q.found || q.quality === 'NOT_READY') {
      const reason = q.reasons[0] ?? 'no_usable_bar';
      if (reason === 'as_of_not_a_trade_day' || reason === 'trade_calendar_missing' || reason === 'no_bar_on_or_before_as_of' || reason === 'invalid_close') {
        preconditions.push({ code: 'data_insufficient', detail: `${code} 无法从服务端缓存取得 ${input.asOf} 的可用行情：${q.reasons.join(', ')}` });
      }
      continue;
    }
    quotes.set(code, {
      ts_code: code,
      trade_date: q.trade_date ?? undefined,
      close: q.price ?? undefined,
      quality: q.quality,
      list_status: q.list_status ?? undefined,
      suspended: q.suspended,
      source: 'market_cache',
    });
  }
  if (mode === 'server' && serverQuotes.length > 0 && serverQuotes.every(q => q.suspension_known === false)) {
    warnings.push('suspension_data_missing');
  }
  return { quotes, resolved, preconditions, mode, server_cache_available: serverUsable, server_quotes: serverQuotes, warnings };
}
