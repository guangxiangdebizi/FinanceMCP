import type { DatabaseSync } from 'node:sqlite';
import { addDays } from './ingest.js';

export interface Fundamentals {
  ts_code: string;
  end_date: string;
  ann_date: string;
  roe: number | null;
  roe_dt: number | null;
  netprofit_yoy: number | null;
  dt_netprofit_yoy: number | null;
  or_yoy: number | null;
  grossprofit_margin: number | null;
  debt_to_assets: number | null;
  ocf_to_profit: number | null;
  ocfps: number | null;
  eps: number | null;
}

/**
 * Point-in-time financial indicators: for each stock, the latest report
 * period whose announcement date is on or before `asOf`, and within that
 * period the latest announcement on or before `asOf`. Reports older than
 * 18 months are treated as missing rather than stale-but-current.
 */
export function fundamentalsAsOf(db: DatabaseSync, asOf: string): Map<string, Fundamentals> {
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT f.*, ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY end_date DESC, ann_date DESC) rn
      FROM fina_indicator f
      WHERE ann_date <= ? AND end_date >= ?
    ) WHERE rn = 1`).all(asOf, addDays(asOf, -550)) as any[];
  return new Map(rows.map(r => {
    delete r.rn;
    return [r.ts_code, r as Fundamentals];
  }));
}

export interface FundamentalRisk {
  flags: string[];
  /** Hard exclusion from the watchlist. */
  exclude: boolean;
}

const FINANCIAL_INDUSTRIES = new Set(['银行', '证券', '保险', '多元金融']);

export function fundamentalRisk(f: Fundamentals | undefined, industry: string | null): FundamentalRisk {
  if (!f) return { flags: ['无可用财报（公告日约束下）'], exclude: false };
  const flags: string[] = [];
  const loss = f.roe !== null && f.roe < 0;
  const negativeCash = f.ocf_to_profit !== null && f.ocf_to_profit < 0 && (f.roe ?? 0) > 0;
  if (loss) flags.push(`ROE 为负 (${f.roe?.toFixed(1)}%)`);
  if (negativeCash) flags.push('经营现金流与利润背离（经营现金流/净利润 < 0）');
  if (!FINANCIAL_INDUSTRIES.has(industry ?? '') && f.debt_to_assets !== null && f.debt_to_assets > 80) {
    flags.push(`资产负债率偏高 (${f.debt_to_assets.toFixed(1)}%)`);
  }
  if (f.netprofit_yoy !== null && f.netprofit_yoy < -50) flags.push(`净利润同比大幅下滑 (${f.netprofit_yoy.toFixed(1)}%)`);
  return { flags, exclude: loss };
}
