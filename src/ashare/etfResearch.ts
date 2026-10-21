import type { DatabaseSync } from 'node:sqlite';
import { ETF_CANDIDATE_DECLARATIONS, type EtfCandidateCategory, type EtfCandidateDeclaration } from './etfDeclarations.js';

export const ETF_DISCOVERY_VERSION = 'etf-discovery-20261021-v1';
export const ETF_DISCOVERY_LIMIT = 200;
export const ETF_DYNAMIC_SYNC_LIMIT = 12;

function has(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** Exchange traded funds must be identified by cached metadata, never by a security prefix alone. */
export function etfIdentity(basic: any): boolean {
  return !!basic && !/LOF/i.test(String(basic.name ?? ''))
    && /ETF|交易型开放式|交易型开放|交易所交易基金/i.test([basic.name, basic.fund_type, basic.invest_type, basic.type].join(' '));
}

export function listedAsOf(basic: any, asOf: string): boolean {
  if (!basic) return false;
  if (basic.list_date && String(basic.list_date) > asOf) return false;
  if (basic.delist_date && String(basic.delist_date) <= asOf) return false;
  // Historical membership uses listing dates; a later delisting must not erase the old universe.
  if (basic.status && basic.status !== 'L' && !basic.delist_date) return false;
  return basic.market == null || basic.market === '' || basic.market === 'E' || basic.market === 'SH' || basic.market === 'SZ';
}

function categoryOf(basic: any): EtfCandidateCategory {
  const text = [basic.name, basic.fund_type, basic.invest_type, basic.benchmark].join(' ');
  if (/黄金|上海金|贵金属/.test(text)) return 'gold';
  if (/债|货币|现金|短融/.test(text)) return 'bond';
  if (/QDII|跨境|纳斯达克|纳指|标普|恒生|港股|香港|日经|德国|法国|美国|东南亚|海外|中概|沙特/.test(text)) return 'cross_border';
  if (/沪深300|中证500|中证1000|中证2000|中证A\d|上证50|上证180|上证380|深证100|深证成指|科创50|科创100|创业板|全指|宽基/.test(text)) return 'broad_based';
  return 'industry_theme';
}

export interface EtfDiscovery {
  declarations: EtfCandidateDeclaration[];
  meta: {
    version: string;
    source: string;
    metadata_basis: string;
    discovered_total: number;
    dynamic_evaluated: number;
    omitted_count: number;
    evaluation_limit: number;
    unavailable_reason: string | null;
    classification: string;
    note: string;
  };
}

/** A bounded, deterministic research sample of the actual cached ETF market. No network or writes. */
export function discoverEtfUniverse(db: DatabaseSync | null | undefined, asOf: string, limit = ETF_DISCOVERY_LIMIT): EtfDiscovery {
  const declarations = [...ETF_CANDIDATE_DECLARATIONS];
  const meta: EtfDiscovery['meta'] = {
    version: ETF_DISCOVERY_VERSION, source: 'fund_basic + fund_daily through as_of',
    metadata_basis: 'current_cached_metadata_with_listing_date_constraints_not_point_in_time_master',
    discovered_total: 0, dynamic_evaluated: 0, omitted_count: 0, evaluation_limit: limit,
    unavailable_reason: null, classification: 'declared_overrides_then_metadata_heuristic_not_verified_asset_exposure',
    note: '声明名单仅为保留研究种子，并非全市场；动态产品按截至目标日的近30自然日成交额排序，限定评估数量，未评估数量单独披露。当前基础资料不是历史时点主数据。',
  };
  if (!db || !has(db, 'fund_basic')) {
    meta.unavailable_reason = 'fund_basic_unavailable';
    return { declarations, meta };
  }
  const basics = (db.prepare('SELECT * FROM fund_basic ORDER BY ts_code').all() as any[])
    .filter(row => /^\d{6}\.(SH|SZ)$/.test(row.ts_code) && etfIdentity(row) && listedAsOf(row, asOf));
  meta.discovered_total = basics.length;
  const amounts = new Map<string, number>();
  if (has(db, 'fund_daily')) {
    const date = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(4, 6) - 1, +asOf.slice(6, 8)));
    date.setUTCDate(date.getUTCDate() - 30);
    const start = date.toISOString().slice(0, 10).replace(/-/g, '');
    for (const row of db.prepare('SELECT ts_code, AVG(amount) amount FROM fund_daily WHERE trade_date BETWEEN ? AND ? GROUP BY ts_code').all(start, asOf) as any[]) {
      amounts.set(row.ts_code, Number(row.amount) || 0);
    }
  }
  const declared = new Set(declarations.map(row => row.ts_code));
  const dynamic = basics.filter(row => !declared.has(row.ts_code))
    .sort((a, b) => (amounts.get(b.ts_code) ?? 0) - (amounts.get(a.ts_code) ?? 0) || String(a.ts_code).localeCompare(String(b.ts_code)))
    .slice(0, Math.max(0, Math.min(ETF_DISCOVERY_LIMIT, Math.trunc(limit))));
  for (const row of dynamic) declarations.push({
    ts_code: row.ts_code, name_hint: row.name ?? row.ts_code, category: categoryOf(row),
    benchmark_hint: row.benchmark ?? null, benchmark_index_code: null,
  });
  meta.dynamic_evaluated = dynamic.length;
  meta.omitted_count = Math.max(0, basics.filter(row => !declared.has(row.ts_code)).length - dynamic.length);
  return { declarations, meta };
}

interface Price { date: string; raw: number; adjusted: number }
function prices(db: DatabaseSync, code: string, asOf: string): Price[] {
  if (!has(db, 'fund_daily') || !has(db, 'fund_adj')) return [];
  const rows = db.prepare(`SELECT d.trade_date, d.close, a.adj_factor FROM fund_daily d
    LEFT JOIN fund_adj a ON a.ts_code=d.ts_code AND a.trade_date=d.trade_date
    WHERE d.ts_code=? AND d.trade_date<=? ORDER BY d.trade_date DESC LIMIT 121`).all(code, asOf) as any[];
  const base = rows[0]?.adj_factor;
  if (!(base > 0)) return [];
  // Never bridge a missing factor when producing returns or correlations.
  return rows.reverse().map(row => ({ date: row.trade_date, raw: Number(row.close), adjusted: row.adj_factor > 0 && row.close > 0 ? row.close * row.adj_factor / base : Number.NaN }));
}
const round = (v: number): number => Math.round(v * 10000) / 10000;
function ret(series: Price[], window: number): number | null {
  const slice = series.slice(-(window + 1));
  return slice.length === window + 1 && slice.every(row => Number.isFinite(row.adjusted))
    ? round((slice.at(-1)!.adjusted / slice[0].adjusted - 1) * 100) : null;
}
function correlation(a: Price[], b: Price[]): { value: number | null; observations: number } {
  const returns = (rows: Price[]) => new Map(rows.slice(1).flatMap((row, i) => Number.isFinite(row.adjusted) && Number.isFinite(rows[i].adjusted)
    ? [[`${rows[i].date}:${row.date}`, row.adjusted / rows[i].adjusted - 1] as const] : []));
  const ar = returns(a), br = returns(b);
  const paired = [...ar].filter(([date]) => br.has(date)).slice(-60).map(([date, value]) => [value, br.get(date)!]);
  if (paired.length < 20) return { value: null, observations: paired.length };
  const ma = paired.reduce((s, row) => s + row[0], 0) / paired.length;
  const mb = paired.reduce((s, row) => s + row[1], 0) / paired.length;
  const aa = paired.reduce((s, row) => s + (row[0] - ma) ** 2, 0);
  const bb = paired.reduce((s, row) => s + (row[1] - mb) ** 2, 0);
  const ab = paired.reduce((s, row) => s + (row[0] - ma) * (row[1] - mb), 0);
  return { value: aa > 0 && bb > 0 ? round(ab / Math.sqrt(aa * bb)) : null, observations: paired.length };
}

export function buildEtfOpportunity(db: DatabaseSync | null | undefined, code: string, asOf: string, heldCodes: readonly string[]) {
  const series = db ? prices(db, code, asOf) : [];
  const latest = series.at(-1);
  const fresh = latest?.date === asOf && Number.isFinite(latest.adjusted);
  const ret20 = fresh ? ret(series, 20) : null;
  const ma = (n: number) => {
    const slice = series.slice(-n);
    return fresh && slice.length === n && slice.every(row => Number.isFinite(row.adjusted)) ? round(slice.reduce((s, row) => s + row.adjusted, 0) / n) : null;
  };
  const ma20 = ma(20), ma60 = ma(60);
  const comparisons = heldCodes.filter(held => held !== code).map(held => {
    const other = db ? prices(db, held, asOf) : [];
    const other20 = other.at(-1)?.date === asOf ? ret(other, 20) : null;
    return { ts_code: held, correlation: correlation(series, other), return_20d_excess_pct: ret20 !== null && other20 !== null ? round(ret20 - other20) : null };
  });
  const shares = db && has(db, 'fund_share') ? db.prepare('SELECT trade_date,fd_share FROM fund_share WHERE ts_code=? AND trade_date<=? AND fd_share>0 ORDER BY trade_date DESC LIMIT 2').all(code, asOf) as any[] : [];
  const gap = shares.length === 2 ? (Date.parse(`${shares[0].trade_date.slice(0, 4)}-${shares[0].trade_date.slice(4, 6)}-${shares[0].trade_date.slice(6, 8)}`) - Date.parse(`${shares[1].trade_date.slice(0, 4)}-${shares[1].trade_date.slice(4, 6)}-${shares[1].trade_date.slice(6, 8)}`)) / 86400000 : null;
  let factorChanged = false;
  let factorsAvailable = false;
  let shareDatesOpen = false;
  if (db && shares.length === 2) {
    if (has(db, 'trade_cal')) shareDatesOpen = shares.every(row => (db.prepare('SELECT is_open FROM trade_cal WHERE cal_date=?').get(row.trade_date) as any)?.is_open === 1);
    if (has(db, 'fund_adj')) {
      const row = db.prepare('SELECT COUNT(DISTINCT adj_factor) n FROM fund_adj WHERE ts_code=? AND trade_date BETWEEN ? AND ? AND adj_factor>0').get(code, shares[1].trade_date, shares[0].trade_date) as any;
      factorChanged = Number(row.n) > 1;
      factorsAvailable = shares.every(row => Number((db.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code=? AND trade_date=?').get(code, row.trade_date) as any)?.adj_factor) > 0);
    }
  }
  const shareComparable = gap !== null && gap > 0 && gap <= 45 && !factorChanged && factorsAvailable && shareDatesOpen;
  return {
    evidence_status: 'UNVERIFIED' as const,
    price_quality: fresh ? 'READY' : 'UNAVAILABLE',
    trend: { return_5d_pct: fresh ? ret(series, 5) : null, return_20d_pct: ret20, return_60d_pct: fresh ? ret(series, 60) : null, ma20, ma60, state: ma20 !== null && ma60 !== null && latest ? latest.adjusted > ma20 && ma20 > ma60 ? 'UPTREND' : latest.adjusted < ma20 && ma20 < ma60 ? 'DOWNTREND' : 'MIXED' : 'UNAVAILABLE' },
    relative_to_holdings: comparisons,
    relative_to_cash: { cash_return_assumption_pct: 0, historical_return_20d_excess_pct: ret20, advantage_status: 'UNVERIFIED', note: '零收益现金仅为历史机会成本参照；未扣交易费，不代表未来投资优势。' },
    shares: { status: shareComparable ? 'AVAILABLE' : 'UNAVAILABLE', latest_date: shares[0]?.trade_date ?? null, previous_date: shares[1]?.trade_date ?? null, change_wan: shareComparable ? round(shares[0].fd_share - shares[1].fd_share) : null, change_pct: shareComparable ? round((shares[0].fd_share / shares[1].fd_share - 1) * 100) : null, reason: shareComparable ? null : factorChanged ? 'factor_change_unclassified' : 'comparable_share_dates_unavailable', note: '份额存量变化不是资金净流入，也不是实时申赎；未获取可靠NAV时不估计申购资金。' },
    nav: { status: 'UNAVAILABLE', reason: 'nav_iopv_not_cached', value: null },
    valuation: { status: 'UNAVAILABLE', reason: 'nav_iopv_not_cached', premium_discount_pct: null },
    opportunity: { status: 'UNVERIFIED', rationale: '趋势、相对强弱、相关性与份额均为历史研究事实；交易成本、权限、风险预算与有效优势证据须由账户决策层校验。', costs: 'ACCOUNT_FEE_ENGINE_REQUIRED', forward_return_prediction: null },
  };
}
