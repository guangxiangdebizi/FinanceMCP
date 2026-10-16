import type { DatabaseSync } from 'node:sqlite';
import { forEachStockBars } from './bars.js';
import { computeIndicators } from './indicators.js';
import { detectSignals, technicalState, TechnicalState } from './signals.js';
import { recentTradeDays, addDays } from './ingest.js';
import { Fundamentals, fundamentalRisk, fundamentalsAsOf } from './fundamentals.js';

export const SCORE_VERSION = 'score-1.0.0';

/**
 * Heuristic score rules (score-1.0.0). The score orders stocks for research
 * attention; it is not a probability of profit and has not been validated as
 * a return forecast.
 *
 * Eligibility: not ST/*ST/退市整理, listed ≥ 250 calendar days, traded on the
 * as-of day, ≥ 130 bars of history, 20-day average turnover ≥ 1 亿元,
 * circulating market value ≥ 50 亿元, and not loss-making in the latest
 * financial report announced on or before the as-of day.
 *
 * score = 35·technical + 15·liquidity + 30·fundamental + 10·valuation + 10·sector
 * (each component in [0,1]; pr = percentile rank within the eligible set)
 *   technical   = 0.3·pr(ret60) + 0.2·pr(ret20) + 0.25·trend + 0.15·rsiFit + 0.1·volFit
 *                 trend = share of {close>MA20, close>MA60, MA20>MA60, MA60 rising};
 *                 rsiFit = 1 inside RSI14 45~70, decaying linearly to 0 at 25 points outside;
 *                 volFit = 1 when ATR14/close ≤ 4%, decaying linearly to 0 at 9%
 *   liquidity   = pr(20-day average turnover)
 *   fundamental = mean(pr(ROE), pr(净利润同比, clipped to ±100%), cash, leverage);
 *                 cash = 1 if 经营现金流/净利润 ≥ 0.8, 0.5 if > 0, else 0;
 *                 leverage = 1 if 资产负债率 < 60%, 0.5 if < 80%, else 0 (financials = 0.5);
 *                 no report available → 0.3
 *   valuation   = in-industry pr of lower PE(TTM); PE ≤ 0 or missing → 0
 *   sector      = industry strength percentile from sectorRank
 */
export const SCORE_RULES = {
  weights: { technical: 35, liquidity: 15, fundamental: 30, valuation: 10, sector: 10 },
  min_listed_days: 250,
  min_bars: 130,
  min_amount20_yi: 1,
  min_circ_mv_yi: 50,
};

export interface StockRow {
  ts_code: string;
  name: string;
  industry: string;
  close: number;
  pct_chg: number;
  amount20_yi: number;
  circ_mv_yi: number | null;
  pe_ttm: number | null;
  pb: number | null;
  turnover_rate: number | null;
  state: TechnicalState;
  ma20_rising: boolean;
  ma60_rising: boolean;
  ma20: number;
  ma60: number;
  atr14: number;
  high20_prior: number;
  bars: number;
  signals: string[];
  fundamentals?: Fundamentals;
  risk_flags: string[];
  eligible: boolean;
  ineligible_reason?: string;
  components?: Record<string, number>;
  score?: number;
  rank?: number;
}

export interface SectorRow {
  industry: string;
  stocks: number;
  ret5_median: number;
  ret20_median: number;
  pct_above_ma20: number;
  amount_yi: number;
  strength: number;
  rank: number;
}

export interface MarketScan {
  trade_date: string;
  rows: StockRow[];
  suspended_or_missing: number;
  signal_counts: Record<string, number>;
  pct_above_ma20: number;
  pct_above_ma60: number;
  sectors: SectorRow[];
}

const median = (values: number[]) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

function percentileRanks(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0);
  const n = idx.length;
  idx.forEach(([, i], r) => { out[i] = n > 1 ? r / (n - 1) : 0.5; });
  return out;
}

const isSt = (name: string) => /ST|退/.test(name ?? '');

export function scanMarket(db: DatabaseSync, date: string): MarketScan {
  const days = recentTradeDays(db, date, 260);
  const start = days[0];
  const basic = new Map((db.prepare('SELECT ts_code, name, industry, list_date FROM stock_basic').all() as any[]).map(r => [r.ts_code, r]));
  const dailyBasic = new Map((db.prepare('SELECT * FROM daily_basic WHERE trade_date = ?').all(date) as any[]).map(r => [r.ts_code, r]));
  const pctToday = new Map((db.prepare('SELECT ts_code, pct_chg FROM daily WHERE trade_date = ?').all(date) as any[]).map(r => [r.ts_code, r.pct_chg]));
  const fundamentals = fundamentalsAsOf(db, date);
  const minListDate = addDays(date, -SCORE_RULES.min_listed_days);

  const rows: StockRow[] = [];
  let missing = 0;
  const signalCounts: Record<string, number> = {};
  forEachStockBars(db, start, date, (code, bars) => {
    const i = bars.dates.length - 1;
    if (bars.dates[i] !== date) { missing++; return; }
    const x = computeIndicators(bars);
    const info = basic.get(code) ?? { name: code, industry: '未知', list_date: '' };
    const db0 = dailyBasic.get(code);
    const state = technicalState(bars, x, i);
    const signals = detectSignals(bars, x, i);
    signals.forEach(s => { signalCounts[s] = (signalCounts[s] ?? 0) + 1; });
    const f = fundamentals.get(code);
    const industry = info.industry || '未知';
    const risk = fundamentalRisk(f, industry);
    const row: StockRow = {
      ts_code: code,
      name: info.name,
      industry,
      close: bars.rawClose[i],
      pct_chg: pctToday.get(code) ?? NaN,
      amount20_yi: x.amountMa20[i] / 1e5,
      circ_mv_yi: db0?.circ_mv != null ? db0.circ_mv / 1e4 : null,
      pe_ttm: db0?.pe_ttm ?? null,
      pb: db0?.pb ?? null,
      turnover_rate: db0?.turnover_rate ?? null,
      state,
      ma20_rising: i >= 5 && x.ma20[i] > x.ma20[i - 5],
      ma60_rising: i >= 5 && x.ma60[i] > x.ma60[i - 5],
      ma20: x.ma20[i] * bars.rawClose[i] / bars.close[i],
      ma60: x.ma60[i] * bars.rawClose[i] / bars.close[i],
      atr14: x.atr14[i] * bars.rawClose[i] / bars.close[i],
      high20_prior: x.high20[i - 1] * bars.rawClose[i] / bars.close[i],
      bars: bars.dates.length,
      signals,
      fundamentals: f,
      risk_flags: [...risk.flags],
      eligible: true,
    };
    if (state.rsi14 > 80) row.risk_flags.push(`RSI14 过热 (${state.rsi14.toFixed(0)})`);
    if (state.atr_pct > 0.07) row.risk_flags.push(`波动率高 (ATR/价格 ${(state.atr_pct * 100).toFixed(1)}%)`);
    const reason =
      isSt(info.name) ? 'ST/退市风险'
      : !info.list_date || info.list_date > minListDate ? '上市不足 250 天'
      : bars.dates.length < SCORE_RULES.min_bars ? '历史数据不足'
      : !(row.amount20_yi >= SCORE_RULES.min_amount20_yi) ? '20 日均成交额 < 1 亿'
      : row.circ_mv_yi === null || row.circ_mv_yi < SCORE_RULES.min_circ_mv_yi ? '流通市值 < 50 亿或缺失'
      : risk.exclude ? '最近已披露财报亏损'
      : undefined;
    if (reason) { row.eligible = false; row.ineligible_reason = reason; }
    rows.push(row);
  });

  const sectors = sectorRank(rows);
  scoreRows(rows, sectors);
  const total = rows.length || 1;
  return {
    trade_date: date,
    rows,
    suspended_or_missing: missing,
    signal_counts: signalCounts,
    pct_above_ma20: rows.filter(r => r.state.above_ma20).length / total,
    pct_above_ma60: rows.filter(r => r.state.above_ma60).length / total,
    sectors,
  };
}

export function sectorRank(rows: StockRow[]): SectorRow[] {
  const groups = new Map<string, StockRow[]>();
  for (const r of rows) {
    if (r.industry === '未知') continue;
    if (!groups.has(r.industry)) groups.set(r.industry, []);
    groups.get(r.industry)!.push(r);
  }
  const list = [...groups.entries()].filter(([, g]) => g.length >= 5).map(([industry, g]) => ({
    industry,
    stocks: g.length,
    ret5_median: median(g.map(r => r.state.ret5)),
    ret20_median: median(g.map(r => r.state.ret20)),
    pct_above_ma20: g.filter(r => r.state.above_ma20).length / g.length,
    amount_yi: g.reduce((s, r) => s + (Number.isFinite(r.amount20_yi) ? r.amount20_yi : 0), 0),
    strength: 0,
    rank: 0,
  }));
  // strength = 0.5·pr(20日中位收益) + 0.3·pr(5日中位收益) + 0.2·pr(站上MA20比例)
  const p20 = percentileRanks(list.map(s => s.ret20_median));
  const p5 = percentileRanks(list.map(s => s.ret5_median));
  const pma = percentileRanks(list.map(s => s.pct_above_ma20));
  list.forEach((s, i) => { s.strength = 0.5 * p20[i] + 0.3 * p5[i] + 0.2 * pma[i]; });
  list.sort((a, b) => b.strength - a.strength);
  list.forEach((s, i) => { s.rank = i + 1; });
  return list;
}

function scoreRows(rows: StockRow[], sectors: SectorRow[]): void {
  const eligible = rows.filter(r => r.eligible);
  const sectorPct = new Map(sectors.map(s => [s.industry, s.strength]));
  const pr60 = percentileRanks(eligible.map(r => r.state.ret60));
  const pr20 = percentileRanks(eligible.map(r => r.state.ret20));
  const prAmt = percentileRanks(eligible.map(r => Math.log(r.amount20_yi)));
  const prRoe = percentileRanks(eligible.map(r => r.fundamentals?.roe ?? NaN));
  const prGrowth = percentileRanks(eligible.map(r => {
    const g = r.fundamentals?.netprofit_yoy;
    return g == null ? NaN : Math.max(-100, Math.min(100, g));
  }));
  // Valuation: percentile of lower positive PE within each industry.
  const prVal = new Array(eligible.length).fill(0);
  const byIndustry = new Map<string, number[]>();
  eligible.forEach((r, i) => {
    if (!byIndustry.has(r.industry)) byIndustry.set(r.industry, []);
    byIndustry.get(r.industry)!.push(i);
  });
  for (const idx of byIndustry.values()) {
    const ranks = percentileRanks(idx.map(i => {
      const pe = eligible[i].pe_ttm;
      return pe != null && pe > 0 ? -pe : NaN;
    }));
    idx.forEach((i, k) => {
      const pe = eligible[i].pe_ttm;
      prVal[i] = pe != null && pe > 0 ? (idx.length > 1 ? ranks[k] : 0.5) : 0;
    });
  }
  const W = SCORE_RULES.weights;
  eligible.forEach((r, i) => {
    const s = r.state;
    const trend = ([s.above_ma20, s.above_ma60, r.ma20 > r.ma60, r.ma60_rising].filter(Boolean).length) / 4;
    const dist = s.rsi14 < 45 ? 45 - s.rsi14 : s.rsi14 > 70 ? s.rsi14 - 70 : 0;
    const rsiFit = Number.isFinite(s.rsi14) ? Math.max(0, 1 - dist / 25) : 0;
    const volFit = Number.isFinite(s.atr_pct) ? Math.max(0, Math.min(1, (0.09 - s.atr_pct) / 0.05)) : 0;
    const technical = 0.3 * pr60[i] + 0.2 * pr20[i] + 0.25 * trend + 0.15 * rsiFit + 0.1 * volFit;
    const f = r.fundamentals;
    let fundamental = 0.3;
    if (f) {
      const cash = f.ocf_to_profit == null ? 0.5 : f.ocf_to_profit >= 0.8 ? 1 : f.ocf_to_profit > 0 ? 0.5 : 0;
      const financial = ['银行', '证券', '保险', '多元金融'].includes(r.industry);
      const leverage = financial || f.debt_to_assets == null ? 0.5 : f.debt_to_assets < 60 ? 1 : f.debt_to_assets < 80 ? 0.5 : 0;
      const roe = f.roe == null ? 0.3 : prRoe[i];
      const growth = f.netprofit_yoy == null ? 0.3 : prGrowth[i];
      fundamental = (roe + growth + cash + leverage) / 4;
    }
    const components = {
      technical,
      liquidity: prAmt[i],
      fundamental,
      valuation: prVal[i],
      sector: sectorPct.get(r.industry) ?? 0.5,
    };
    r.components = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    r.score = Math.round((W.technical * technical + W.liquidity * components.liquidity + W.fundamental * fundamental
      + W.valuation * components.valuation + W.sector * components.sector) * 100) / 100;
  });
  eligible.sort((a, b) => (b.score! - a.score!) || a.ts_code.localeCompare(b.ts_code));
  eligible.forEach((r, i) => { r.rank = i + 1; });
}
