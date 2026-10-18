import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './db.js';
import type { MarketScan, StockRow } from './analysis.js';

/**
 * Watchlist maintenance rules (wl-1.0.0). Membership changes only on clear
 * evidence so small daily rank moves do not churn the list:
 * - target 40 names (allowed 30~50), at most 4 per industry;
 * - new names must rank within the top 40 eligible stocks;
 * - members stay while they remain eligible and rank within the top 150;
 *   a member is held at least 5 trading days unless it becomes ineligible;
 * - at most 6 additions per day once the list is built; a top-10 candidate
 *   may replace the weakest member only when that member ranks below 100.
 */
export const WATCHLIST_VERSION = 'wl-1.0.0';
export const WATCHLIST_RULES = {
  target: 40,
  min: 30,
  max: 50,
  industry_cap: 4,
  entry_rank: 40,
  exit_rank: 150,
  min_hold_days: 5,
  max_adds_per_day: 6,
  swap_candidate_rank: 10,
  swap_member_rank: 100,
};

export interface WatchlistMember {
  ts_code: string;
  name: string;
  industry: string;
  score: number;
  rank: number;
  entered_on: string;
  status: 'new' | 'kept';
  reason: string;
}

export interface WatchlistChange {
  ts_code: string;
  name: string;
  action: 'add' | 'remove';
  score: number | null;
  rank: number | null;
  reason: string;
}

export interface WatchlistResult {
  trade_date: string;
  previous_date: string | null;
  members: WatchlistMember[];
  changes: WatchlistChange[];
  industry_distribution: Record<string, number>;
}

function tradeDaysHeld(db: DatabaseSync, from: string, to: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM trade_cal WHERE is_open = 1 AND cal_date > ? AND cal_date <= ?').get(from, to) as any).n;
}

export function updateWatchlist(db: DatabaseSync, scan: MarketScan): WatchlistResult {
  const R = WATCHLIST_RULES;
  const date = scan.trade_date;
  const byCode = new Map(scan.rows.map(r => [r.ts_code, r]));
  const prevDate = (db.prepare('SELECT MAX(trade_date) d FROM watchlist WHERE trade_date < ?').get(date) as any)?.d as string | null;
  const prev = prevDate ? db.prepare('SELECT * FROM watchlist WHERE trade_date = ?').all(prevDate) as any[] : [];

  const members: WatchlistMember[] = [];
  const changes: WatchlistChange[] = [];
  const industryCount = new Map<string, number>();
  const bump = (industry: string) => industryCount.set(industry, (industryCount.get(industry) ?? 0) + 1);

  const remove = (code: string, row: StockRow | undefined, reason: string) => {
    changes.push({ ts_code: code, name: row?.name ?? code, action: 'remove', score: row?.score ?? null, rank: row?.rank ?? null, reason });
  };

  for (const p of prev) {
    const row = byCode.get(p.ts_code);
    const held = tradeDaysHeld(db, p.entered_on, date);
    if (!row) { remove(p.ts_code, undefined, '当日无行情（停牌或缺失）'); continue; }
    if (!row.eligible) { remove(p.ts_code, row, `不再满足准入条件：${row.ineligible_reason}`); continue; }
    if (row.rank! > R.exit_rank && held >= R.min_hold_days) {
      remove(p.ts_code, row, `排名降至 ${row.rank}，超出保留阈值 ${R.exit_rank}`);
      continue;
    }
    members.push({
      ts_code: row.ts_code, name: row.name, industry: row.industry, score: row.score!, rank: row.rank!,
      entered_on: p.entered_on, status: 'kept',
      reason: row.rank! > R.exit_rank ? `排名 ${row.rank} 超出阈值，但持有未满 ${R.min_hold_days} 个交易日` : `排名 ${row.rank}，仍在保留阈值内`,
    });
    bump(row.industry);
  }

  const memberCodes = new Set(members.map(m => m.ts_code));
  const candidates = scan.rows.filter(r => r.eligible && !memberCodes.has(r.ts_code)).sort((a, b) => a.rank! - b.rank!);
  const initial = prev.length === 0;
  let adds = 0;
  const add = (row: StockRow, reason: string) => {
    members.push({ ts_code: row.ts_code, name: row.name, industry: row.industry, score: row.score!, rank: row.rank!, entered_on: date, status: 'new', reason });
    changes.push({ ts_code: row.ts_code, name: row.name, action: 'add', score: row.score!, rank: row.rank!, reason });
    memberCodes.add(row.ts_code);
    bump(row.industry);
    adds++;
  };

  for (const row of candidates) {
    if (members.length >= R.target) break;
    if ((industryCount.get(row.industry) ?? 0) >= R.industry_cap) continue;
    const belowMin = members.length < R.min;
    const rankLimit = initial || belowMin ? R.exit_rank : R.entry_rank;
    if (row.rank! > rankLimit) break;
    if (!initial && !belowMin && adds >= R.max_adds_per_day) break;
    add(row, initial ? `初始建池：排名 ${row.rank}` : `排名 ${row.rank} 进入前 ${rankLimit}`);
  }

  // Replace the weakest seasoned member only for a clearly stronger candidate.
  if (!initial) {
    for (const row of candidates) {
      if (adds >= R.max_adds_per_day || row.rank! > R.swap_candidate_rank) break;
      if (memberCodes.has(row.ts_code)) continue;
      const weakest = members
        .filter(m => m.status === 'kept' && m.rank > R.swap_member_rank && tradeDaysHeld(db, m.entered_on, date) >= R.min_hold_days)
        .sort((a, b) => b.rank - a.rank)[0];
      if (!weakest) break;
      const capOk = (industryCount.get(row.industry) ?? 0) < R.industry_cap || weakest.industry === row.industry;
      if (!capOk) continue;
      members.splice(members.indexOf(weakest), 1);
      industryCount.set(weakest.industry, industryCount.get(weakest.industry)! - 1);
      remove(weakest.ts_code, byCode.get(weakest.ts_code), `被排名 ${row.rank} 的 ${row.name} 替换（原排名 ${weakest.rank} > ${R.swap_member_rank}）`);
      add(row, `排名 ${row.rank} 替换排名 ${weakest.rank} 的成员`);
    }
  }

  members.sort((a, b) => a.rank - b.rank);
  inTransaction(db, () => {
    db.prepare('DELETE FROM watchlist WHERE trade_date = ?').run(date);
    db.prepare('DELETE FROM watchlist_change WHERE trade_date = ?').run(date);
    const ins = db.prepare('INSERT INTO watchlist (trade_date, ts_code, score, rank, industry, status, reason, entered_on) VALUES (?,?,?,?,?,?,?,?)');
    for (const m of members) ins.run(date, m.ts_code, m.score, m.rank, m.industry, m.status, m.reason, m.entered_on);
    const insC = db.prepare('INSERT OR REPLACE INTO watchlist_change (trade_date, ts_code, action, score, rank, reason) VALUES (?,?,?,?,?,?)');
    for (const c of changes) insC.run(date, c.ts_code, c.action, c.score, c.rank, c.reason);
    db.prepare('DELETE FROM stock_score WHERE trade_date = ?').run(date);
    const insS = db.prepare('INSERT INTO stock_score (trade_date, ts_code, score, rank, detail) VALUES (?,?,?,?,?)');
    for (const r of scan.rows) {
      if (r.eligible) insS.run(date, r.ts_code, r.score!, r.rank!, JSON.stringify(r.components ?? {}));
    }
  });

  return {
    trade_date: date,
    previous_date: prevDate,
    members,
    changes,
    industry_distribution: Object.fromEntries([...industryCount.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])),
  };
}

/** Remove watchlist history from `start` onwards so a replay rebuilds it in order. */
export function resetWatchlistFrom(db: DatabaseSync, start: string): void {
  inTransaction(db, () => {
    db.prepare('DELETE FROM watchlist WHERE trade_date >= ?').run(start);
    db.prepare('DELETE FROM watchlist_change WHERE trade_date >= ?').run(start);
  });
}
