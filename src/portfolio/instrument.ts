import type { DatabaseSync } from 'node:sqlite';
import { inferBoard, type InstrumentKind } from './rules.js';

/**
 * 可信标的身份（PRD §4 / 工作包 A4）。
 *
 * 调用方传来的 `buy_kind`/`buy_board` 只是**待核对的声明**，不是权威。品种与板块
 * 一律从本地只读市场缓存（`fund_basic` / `stock_basic`）判定：
 * - `fund_basic` 中 `market='E'` 的记录 → ETF；
 * - 否在 `stock_basic` 中 → STOCK，板块由 6 位代码前缀推断；
 * - 两边都查不到 → UNKNOWN，永远不可操作（fail closed）；
 * - 同时出现在两张表 → 按 STOCK 处理（fail closed），因为个股权限更严。
 *
 * 本模块只读，不写市场库，也不访问网络。
 */

export type ResolvedKind = InstrumentKind | 'UNKNOWN';

export interface ResolvedInstrument {
  found: boolean;
  kind: ResolvedKind;
  /** 板块：ETF 为 'etf'；个股为 688/300/8/4/main；未知为 null。 */
  board: string | null;
  /** 上市状态 L/D/P；未知为 null。 */
  list_status: string | null;
  name: string | null;
  source: 'fund_basic' | 'stock_basic' | 'none';
  /** 依据的缓存快照时间（updated_at），缺失时为 null；不是行情时间。 */
  as_of: string | null;
  /** 判定说明，便于审计。 */
  detail: string;
}

const UNKNOWN = (code: string, detail: string): ResolvedInstrument => ({
  found: false, kind: 'UNKNOWN', board: null, list_status: null, name: null, source: 'none', as_of: null, detail,
});

/** 代码规范化为 `600519.SH` 形式；无法识别时返回 null。 */
export function normalizeInstrumentCode(raw: unknown): string | null {
  const text = String(raw ?? '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(text)) return text;
  return null;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 上海时区的今天（YYYYMMDD）。只用于判断缓存里的退市日期是否已经生效。 */
function todayYmd(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * 解析一个代码的真实品种、板块与上市状态。
 * 缓存缺表（旧库）按“查不到”处理，不抛错，由调用方降级为 instrument_unknown。
 */
export function resolveInstrument(db: DatabaseSync, rawCode: unknown): ResolvedInstrument {
  const code = normalizeInstrumentCode(rawCode);
  if (!code) return UNKNOWN(String(rawCode ?? ''), `代码格式无法识别：${String(rawCode ?? '')}`);

  let stock: any;
  let fund: any;
  try {
    if (hasTable(db, 'stock_basic')) stock = db.prepare('SELECT ts_code, name, list_status, list_date, delist_date, updated_at FROM stock_basic WHERE ts_code = ?').get(code);
    if (hasTable(db, 'fund_basic')) fund = db.prepare("SELECT ts_code, name, status, market, list_date, delist_date, updated_at FROM fund_basic WHERE ts_code = ?").get(code);
  } catch {
    // 只读库结构异常时同样按未知处理，绝不据此放行交易。
    return UNKNOWN(code, '市场缓存不可读，无法确认标的身份');
  }

  // 两张表都有 → 按 STOCK 处理（个股权限更严，fail closed）。
  if (stock) {
    const board = inferBoard(code) ?? null;
    // 退市日期已过但 list_status 仍为 L 时，以日期为准（缓存可能滞后）。
    const delisted = !!(stock.delist_date && String(stock.delist_date) <= todayYmd());
    return {
      found: true,
      kind: 'STOCK',
      board,
      list_status: delisted ? 'D' : (stock.list_status ?? null),
      name: stock.name ?? null,
      source: 'stock_basic',
      as_of: stock.updated_at ?? null,
      detail: `stock_basic 中存在 ${code}${fund ? '（同时在 fund_basic 中，按个股处理）' : ''}`,
    };
  }
  if (fund) {
    const isEtf = fund.market === 'E';
    if (!isEtf) {
      return {
        found: false,
        kind: 'UNKNOWN',
        board: null,
        list_status: fund.status ?? null,
        name: fund.name ?? null,
        source: 'fund_basic',
        as_of: fund.updated_at ?? null,
        detail: `fund_basic 中 ${code} 的 market=${fund.market ?? 'null'}，不是场内 ETF`,
      };
    }
    return {
      found: true,
      kind: 'ETF',
      board: 'etf',
      list_status: fund.status ?? null,
      name: fund.name ?? null,
      source: 'fund_basic',
      as_of: fund.updated_at ?? null,
      detail: `fund_basic 中 ${code} market=E，按场内 ETF 处理`,
    };
  }
  return UNKNOWN(code, `本地缓存（stock_basic / fund_basic）中没有 ${code}，按不可操作处理`);
}

export interface InstrumentClaim {
  kind?: string;
  board?: string;
}

const KIND_ALIASES: Record<string, InstrumentKind> = { etf: 'ETF', stock: 'STOCK' };

/** 把调用方声明的 kind 规范化；无法识别时返回 null（不是"默认 ETF"）。 */
export function normalizeClaimKind(raw: unknown): InstrumentKind | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return KIND_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}

export interface ClaimCheck {
  ok: boolean;
  /** 声明与解析结果矛盾时的原因码。 */
  reason?: 'instrument_claim_mismatch';
  detail?: string;
}

/**
 * 核对调用方声明。声明缺省不算矛盾（解析结果说了算）；一旦声明与解析结果
 * 不一致就拒绝，防止 `buy_kind='etf'` 绕过板块限制。
 */
export function checkInstrumentClaim(claim: InstrumentClaim, resolved: ResolvedInstrument): ClaimCheck {
  const claimedKind = normalizeClaimKind(claim.kind);
  if (claimedKind && claimedKind !== resolved.kind) {
    return {
      ok: false,
      reason: 'instrument_claim_mismatch',
      detail: `调用方声明 buy_kind=${String(claim.kind)}，但本地缓存判定 ${resolved.kind}（${resolved.detail}）`,
    };
  }
  const claimedBoard = claim.board == null || claim.board === '' ? null : String(claim.board);
  if (claimedBoard && resolved.kind === 'STOCK' && resolved.board && claimedBoard !== resolved.board) {
    return {
      ok: false,
      reason: 'instrument_claim_mismatch',
      detail: `调用方声明 buy_board=${claimedBoard}，但 ${resolved.board} 由代码前缀与 stock_basic 判定`,
    };
  }
  if (claimedBoard && resolved.kind === 'ETF' && claimedBoard !== 'etf') {
    return {
      ok: false,
      reason: 'instrument_claim_mismatch',
      detail: `调用方声明 buy_board=${claimedBoard}，但 ${resolved.name ?? '标的'} 是场内 ETF`,
    };
  }
  return { ok: true };
}
