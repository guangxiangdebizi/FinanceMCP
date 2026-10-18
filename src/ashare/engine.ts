import type { DatabaseSync } from 'node:sqlite';
import { SCORE_RULES, SCORE_VERSION, RESEARCH_SCORE_VERSION, scanMarket, scoreRows, type ScoreVersion, type ScoreBreakdown, type StockRow } from './analysis.js';
import { DATA_CONTRACT, defaultTradeDate, parseYmd, resolveCode } from './data.js';
import { checkQuality, recentTradeDays } from './ingest.js';
import { INDICATOR_VERSION } from './indicators.js';
import { SIGNAL_BY_ID, SIGNAL_VERSION } from './signals.js';

export const ENGINE_VERSION = 'engine-1.0.0';
export const FACTOR_VERSION = 'factor-1.0.0';
export const FACTOR_SNAPSHOT_MAX_CODES = 20;

export const FACTOR_UNITS = {
  ret20: 'ratio (0.20 = 20%)', ret60: 'ratio (0.20 = 20%)',
  close: 'CNY', ma20: 'CNY, adjusted trend converted to as-of raw-price basis',
  ma60: 'CNY, adjusted trend converted to as-of raw-price basis',
  above_ma20: 'boolean', above_ma60: 'boolean', ma20_rising: 'boolean (versus 5 traded bars ago)',
  ma60_rising: 'boolean (versus 5 traded bars ago)', rsi14: 'index 0–100',
  atr_pct: 'ratio (0.04 = 4%)', amount20_yi: 'CNY 100 million', circ_mv_yi: 'CNY 100 million',
  pe_ttm: 'multiple', pb: 'multiple', roe: '%', netprofit_yoy: '% (scoring clips to [-100,100])',
  ocf_to_profit: '% (115.11 = 115.11%; 20 = 20%)', debt_to_assets: '%', eps: 'CNY/share',
  industry: 'current Tushare stock_basic classification; not historical point-in-time',
};

export const SCORING_POLICY = {
  weights: SCORE_RULES.weights,
  cash: {
    'score-1.0.0': 'Legacy preserved: percent value >= 0.8 scores 1, > 0 scores 0.5, otherwise 0; missing ratio scores 0.5',
    'score-2.0.0': 'Percent value >= 80 scores 1, > 0 scores 0.5, otherwise 0; missing ratio scores 0.5',
    financial_industries: 'Banks, securities, insurance and diversified financials use the same cash threshold; this is a heuristic with limited cross-industry comparability, not a claim of accounting equivalence',
    profit_anomalies: 'Negative ROE remains excluded by V1 eligibility in both versions. Nonpositive EPS is flagged but does not change scores: EPS and ocf_to_profit do not prove the same profit denominator. Unavailable/zero/negative denominator cannot be reconstructed from this cache; no denominator validity is asserted. Null ratio remains null in observations and uses the explicit neutral scoring default',
  },
  leverage: 'Financial industries and missing debt ratio use neutral 0.5; other industries use <60%:1, <80%:0.5, otherwise 0',
  missing: 'Raw and observed normalized factors remain null. scoring_factors and imputations expose every formula default; absent entire financial report uses component 0.3',
  normalization: 'Full-market eligible universe, lower positive PE ranked within industry; sector strength uses all scanned stocks with >=5 members per industry. Subset requests never change the normalization universe',
  ties: 'Legacy ordinal percentile ties retain full-market ts_code scan order; final equal-score ranks sort by ts_code',
};

export interface AnalysisRequest {
  date: string;
  score_version?: ScoreVersion;
  ts_codes?: string[];
  parameters?: { include_components?: boolean };
}

const finite = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;

/** Recover missing source amounts that legacy bars converted to zero; never changes V1 scores. */
export function missingAmount20Codes(db: DatabaseSync, date: string): Set<string> {
  const start = recentTradeDays(db, date, 260)[0];
  if (!start) return new Set();
  const rows = db.prepare(`SELECT DISTINCT d.ts_code FROM daily d
    WHERE d.trade_date BETWEEN ? AND ? AND d.amount IS NULL
    AND NOT EXISTS (SELECT 1 FROM daily newer WHERE newer.ts_code = d.ts_code
      AND newer.trade_date > d.trade_date AND newer.trade_date <= ? LIMIT 1 OFFSET 19)`)
    .all(start, date, date) as { ts_code: string }[];
  return new Set(rows.map(row => row.ts_code));
}

export interface FactorSourceQuality {
  amount20_missing?: boolean;
  technical_invalid?: boolean;
  close_invalid?: boolean;
}

/** Source validity lost by legacy numeric coercion; inspect exactly its as-of scan window. */
export function sourceQualityForDate(db: DatabaseSync, date: string): Map<string, FactorSourceQuality> {
  const quality = new Map<string, FactorSourceQuality>();
  for (const code of missingAmount20Codes(db, date)) quality.set(code, { amount20_missing: true });
  const start = recentTradeDays(db, date, 260)[0];
  if (!start) return quality;
  const invalid = db.prepare(`SELECT ts_code,
    MAX(CASE WHEN trade_date = ? AND (close IS NULL OR close <= 0) THEN 1 ELSE 0 END) close_invalid
    FROM daily WHERE trade_date BETWEEN ? AND ? AND (
      open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL
      OR open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
      OR high < low OR close > high * 1.0001 OR close < low * 0.9999
      OR open > high * 1.0001 OR open < low * 0.9999)
    GROUP BY ts_code`).all(date, start, date) as { ts_code: string; close_invalid: number }[];
  for (const row of invalid) quality.set(row.ts_code, { ...quality.get(row.ts_code), technical_invalid: true, close_invalid: !!row.close_invalid });
  return quality;
}

/** Mask observations only. Exact legacy formula inputs and weighted contributions remain auditable. */
export function applyObservationQuality(detail: ScoreBreakdown | undefined, quality: FactorSourceQuality = {}): void {
  if (!detail) return;
  if (quality.amount20_missing) {
    detail.normalized.liquidity = null;
    detail.imputations.liquidity = 'Missing source amount within the last 20 bars: legacy bars substituted zero before averaging; legacy scoring value retained explicitly for V1 parity';
  }
  if (quality.technical_invalid) for (const key of ['ret60', 'ret20', 'trend', 'rsi_fit', 'volatility_fit']) {
    detail.normalized[key] = null;
    detail.imputations[key] = 'Invalid or missing source OHLC in the as-of 260-trading-day scan window: observed technical factor is unreliable; legacy scoring value retained explicitly for V1 parity';
  }
}

export function rawFactors(row: StockRow, quality: FactorSourceQuality = {}) {
  const f = row.fundamentals;
  // Incomplete adjustment factors produce unreliable derived prices. Expose null
  // in observations while retaining the exact V1 eligibility and scoring rules.
  const adjusted = !quality.technical_invalid && !row.risk_flags.some(flag => flag.startsWith('复权因子缺失'));
  const price = (value: number) => adjusted ? finite(value) : null;
  return {
    close: quality.close_invalid || !(row.close > 0) ? null : finite(row.close), ret20: price(row.state.ret20), ret60: price(row.state.ret60),
    ma20: price(row.ma20), ma60: price(row.ma60),
    above_ma20: adjusted && Number.isFinite(row.ma20) ? row.state.above_ma20 : null,
    above_ma60: adjusted && Number.isFinite(row.ma60) ? row.state.above_ma60 : null,
    ma20_rising: adjusted && row.bars >= 25 && Number.isFinite(row.ma20) ? row.ma20_rising : null,
    ma60_rising: adjusted && row.bars >= 65 && Number.isFinite(row.ma60) ? row.ma60_rising : null,
    rsi14: price(row.state.rsi14), atr_pct: price(row.state.atr_pct),
    amount20_yi: quality.amount20_missing ? null : finite(row.amount20_yi), circ_mv_yi: finite(row.circ_mv_yi),
    pe_ttm: finite(row.pe_ttm), pb: finite(row.pb), roe: finite(f?.roe),
    netprofit_yoy: finite(f?.netprofit_yoy), ocf_to_profit: finite(f?.ocf_to_profit),
    debt_to_assets: finite(f?.debt_to_assets), eps: finite(f?.eps), industry: row.industry,
  };
}

/** Read-only analysis; computes the complete universe before restricting output. */
export function analyzeMarket(db: DatabaseSync, request: AnalysisRequest) {
  const date = parseYmd(request.date, 'date');
  if (!date) throw new Error('date is required');
  const version = request.score_version ?? SCORE_VERSION;
  if (version !== SCORE_VERSION && version !== RESEARCH_SCORE_VERSION) throw new Error(`Unsupported score version: ${version}`);
  if (request.parameters?.include_components !== undefined && typeof request.parameters.include_components !== 'boolean') throw new Error('include_components must be boolean');
  for (const key of Object.keys(request.parameters ?? {})) if (key !== 'include_components') throw new Error(`Unsupported research parameter: ${key}`);
  if (request.ts_codes != null && !Array.isArray(request.ts_codes)) throw new Error('ts_codes must be an array');
  const codes = request.ts_codes ? [...new Set(request.ts_codes.map(code => resolveCode(db, code)))].sort() : undefined;
  if (!recentTradeDays(db, date, 1).length) throw new Error(`No cached trading calendar on or before ${date}`);
  const scan = scanMarket(db, date);
  const breakdowns = scoreRows(scan.rows, scan.sectors, version);
  const byCode = new Map(scan.rows.map(row => [row.ts_code, row]));
  const sourceQuality = sourceQualityForDate(db, date);
  const include = request.parameters?.include_components !== false;
  const rows = (codes ?? scan.rows.map(row => row.ts_code)).map(code => {
    const row = byCode.get(code);
    const info = row ? undefined : db.prepare('SELECT name, industry FROM stock_basic WHERE ts_code = ?').get(code) as { name: string; industry: string } | undefined;
    const detail = breakdowns.get(code);
    const observationQuality = sourceQuality.get(code) ?? {};
    const raw = row ? rawFactors(row, observationQuality) : Object.fromEntries(Object.keys(FACTOR_UNITS).map(key => [key, key === 'industry' ? info?.industry ?? null : null]));
    applyObservationQuality(detail, observationQuality);
    const flags = [...(row?.risk_flags ?? ['No as-of bar: suspension, absent history or missing market data; no stale bar substituted'])];
    if (observationQuality.amount20_missing) flags.push('Missing amount in the last 20 bars: observed turnover/liquidity factor is null; legacy score retains zero-substitution calculation for V1 parity');
    if (observationQuality.technical_invalid) flags.push('Invalid or missing source OHLC in the as-of scan window: technical observations are null and signals suppressed; original V1 scoring inputs retained for parity');
    if (row?.fundamentals?.eps != null && row.fundamentals.eps <= 0) flags.push('Nonpositive EPS: cash/profit denominator interpretation is uncertain; score policy unchanged');
    const missing = Object.entries(raw).filter(([, value]) => value === null).map(([key]) => key);
    return {
      ts_code: code, name: row?.name ?? info?.name ?? null, industry: row?.industry ?? info?.industry ?? null,
      eligible: row?.eligible ?? false, ineligible_reason: row?.ineligible_reason ?? (row ? null : 'No as-of bar'),
      factor_version: FACTOR_VERSION, raw,
      normalized: detail?.normalized ?? Object.fromEntries(['ret60', 'ret20', 'trend', 'rsi_fit', 'volatility_fit', 'liquidity', 'roe', 'growth', 'cash', 'leverage', 'valuation', 'sector'].map(key => [key, null])),
      score: finite(row?.score), rank: row?.rank ?? null,
      ...(include ? {
        components: detail?.components ?? null, contributions: detail?.contributions ?? null,
        factor_contributions: detail?.factor_contributions ?? null, scoring_factors: detail?.scoring_factors ?? null,
        imputations: detail?.imputations ?? null,
      } : {}),
      financial_report: row?.fundamentals ? { end_date: row.fundamentals.end_date, ann_date: row.fundamentals.ann_date } : null,
      signals: (observationQuality.technical_invalid ? [] : row?.signals ?? []).map(id => ({ ...SIGNAL_BY_ID.get(id)! })),
      invalidation: { price_below_ma60: raw.ma60, trend: 'Close below MA60 or MA20 falls versus 5 traded bars ago; monitoring rule only, not an execution instruction' },
      quality: { missing_factors: missing, bars: row?.bars ?? 0, risk_flags: flags },
    };
  });
  // checkQuality's wall-clock checked_at is deliberately excluded: identical
  // cached inputs must produce identical deterministic analysis results.
  const { checked_at: _checked, ...quality } = checkQuality(db, date, false);
  return {
    status: 'RESEARCH_ONLY' as const, trade_date: date, engine_version: ENGINE_VERSION, factor_version: FACTOR_VERSION,
    indicator_version: INDICATOR_VERSION, signal_version: SIGNAL_VERSION, score_version: version,
    parameters: { include_components: include }, normalization_scope: 'full_market_eligible' as const,
    universe: { scanned: scan.rows.length, eligible: scan.rows.filter(row => row.eligible).length, suspended_or_missing: scan.suspended_or_missing },
    units: FACTOR_UNITS, policy: SCORING_POLICY, quality: { ...quality, anomalies: { ...quality.anomalies } },
    limitations: [...DATA_CONTRACT.availability.not_point_in_time, 'Returns use adjusted traded bars, not fixed calendar days; missing historical bars may lengthen horizons', 'No cached profit denominator validation or full historical trading-status metadata; heuristic scores are not profit probabilities'],
    count: rows.length, rows,
  };
}

/** Bounded MCP entry point sharing the exact internal analysis contract. */
export function factorSnapshot(db: DatabaseSync, args: Record<string, unknown>) {
  if (!Array.isArray(args.ts_codes) || !args.ts_codes.length || args.ts_codes.length > FACTOR_SNAPSHOT_MAX_CODES) throw new Error(`ts_codes must contain 1–${FACTOR_SNAPSHOT_MAX_CODES} stocks`);
  if (args.ts_codes.some(code => typeof code !== 'string' || !code.trim())) throw new Error('ts_codes must contain nonempty strings');
  const date = parseYmd(args.date, 'date') ?? defaultTradeDate(db);
  return analyzeMarket(db, {
    date, ts_codes: args.ts_codes as string[], score_version: (args.score_version ?? SCORE_VERSION) as ScoreVersion,
    parameters: { include_components: args.include_components as boolean | undefined },
  });
}
