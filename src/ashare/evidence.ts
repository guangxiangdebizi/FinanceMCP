import type { DatabaseSync } from 'node:sqlite';
import { forEachStockBars } from './bars.js';
import { computeIndicators } from './indicators.js';
import { detectSignals, SIGNAL_DEFINITIONS, SIGNAL_VERSION } from './signals.js';
import { Regime, regimeSeries } from './market.js';
import { inTransaction } from './db.js';

/**
 * Minimal historical signal check (evi-1.0.0), not a backtest engine:
 * - event = a signal firing for a stock on day t (eligibility: name not ST
 *   today, ≥ 130 bars, 20-day average turnover ≥ 5000 万元);
 * - entry at the next day's open, exit at the close h trading days after t;
 *   events whose next open is at the limit-up price are skipped (unfillable);
 * - excess = event return − equal-weight return of all eligible stocks over
 *   the same window; statistics are clustered by date (t-stat across daily
 *   mean excess) so one crowded day cannot dominate;
 * - grouped by CSI 300 regime on day t.
 * Classification per signal (horizon 10):
 *   evidence_supported: ≥ 60 event days, ≥ 300 events, t ≥ 2 in the signal's
 *     direction overall, and no regime with ≥ 20 days showing t ≤ −1 against it;
 *   contradicted: t ≥ 2 against the signal's direction;
 *   research_only: everything else.
 * The sample is in-sample history of the local cache; costs, slippage and
 * delisting are not modelled. `evidence_supported` therefore means in-sample
 * directional evidence only: consecutive event days have overlapping return
 * windows (the t-stat is overstated) and 9 signals × 3 horizons × 4 regime
 * groups are tested without a multiple-testing correction.
 */
export const EVIDENCE_VERSION = 'evi-1.0.0';
export const HORIZONS = [5, 10, 20];
const PRIMARY_HORIZON = 10;

export const EVIDENCE_SCOPE = {
  meaning: 'evidence_supported 仅表示样本内方向性证据：在本地缓存的历史样本中，该信号 10 日超额收益方向与信号方向一致且按日期聚类 t ≥ 2；不是生产策略有效性，也不代表未来盈利概率。',
  limitations: [
    '样本内统计：分类规则与检验使用同一段历史，未做样本外检验',
    '收益窗口重叠：相邻事件日的 10 日持有期大量重叠，按日聚类的 t 值仍会高估显著性',
    '多重检验：9 个信号 × 3 个持有期 × 4 个市场状态分组同时检验，未做多重比较校正',
    '未计交易成本、滑点、停牌与退市',
  ],
};

export interface EvidenceRow {
  signal: string;
  regime: Regime | 'all';
  horizon: number;
  n: number;
  days: number;
  mean_excess: number;
  hit_rate: number;
  t_stat: number;
}

export interface SignalVerdict {
  signal: string;
  name: string;
  direction: string;
  classification: 'evidence_supported' | 'research_only' | 'contradicted';
  basis: string;
}

export interface EvidenceResult {
  version: string;
  signal_version: string;
  start: string;
  end: string;
  computed_at: string;
  events: number;
  rows: EvidenceRow[];
  verdicts: SignalVerdict[];
}

type Acc = { byDate: Map<string, { sum: number; n: number; hits: number }> };

export function computeEvidence(db: DatabaseSync, start: string, end: string): EvidenceResult {
  const regimes = regimeSeries(db, end);
  const names = new Map((db.prepare('SELECT ts_code, name FROM stock_basic').all() as any[]).map(r => [r.ts_code, r.name]));
  // Benchmark: equal-weight forward return of eligible stocks per (date, horizon).
  const bench = new Map<string, { sum: number; n: number }>();
  const events: { signal: string; date: string; h: number; ret: number }[] = [];

  forEachStockBars(db, start, end, (code, b) => {
    if (/ST|退/.test(names.get(code) ?? '')) return;
    // Without a complete adjustment factor history the price series mixes adjusted and raw prices.
    if (b.adjMissing) return;
    const x = computeIndicators(b);
    const n = b.dates.length;
    for (let i = 130; i < n - 1; i++) {
      if (!(x.amountMa20[i] >= 5e4)) continue;
      const entryRaw = b.rawOpen[i + 1];
      const fillable = !(Number.isFinite(b.upLimit[i + 1]) && entryRaw >= b.upLimit[i + 1] - 0.001);
      const entry = b.open[i + 1];
      const rets: (number | undefined)[] = HORIZONS.map(h => (i + h < n && entry > 0 ? b.close[i + h] / entry - 1 : undefined));
      HORIZONS.forEach((h, k) => {
        const r = rets[k];
        if (r === undefined) return;
        const key = `${b.dates[i]}|${h}`;
        const acc = bench.get(key) ?? { sum: 0, n: 0 };
        acc.sum += r; acc.n++;
        bench.set(key, acc);
      });
      if (!fillable || i + 1 >= n) continue;
      const fired = detectSignals(b, x, i);
      for (const s of fired) {
        HORIZONS.forEach((h, k) => {
          const r = rets[k];
          if (r !== undefined) events.push({ signal: s, date: b.dates[i], h, ret: r });
        });
      }
    }
  });

  const groups = new Map<string, Acc>();
  for (const e of events) {
    const b = bench.get(`${e.date}|${e.h}`);
    if (!b || b.n < 50) continue;
    const excess = e.ret - b.sum / b.n;
    const regime = regimes.get(e.date);
    for (const rg of ['all', regime].filter(Boolean) as string[]) {
      const key = `${e.signal}|${rg}|${e.h}`;
      const acc = groups.get(key) ?? { byDate: new Map() };
      const d = acc.byDate.get(e.date) ?? { sum: 0, n: 0, hits: 0 };
      d.sum += excess; d.n++; if (excess > 0) d.hits++;
      acc.byDate.set(e.date, d);
      groups.set(key, acc);
    }
  }

  const rows: EvidenceRow[] = [];
  for (const [key, acc] of groups) {
    const [signal, regime, h] = key.split('|');
    const dayMeans = [...acc.byDate.values()].map(d => d.sum / d.n);
    const days = dayMeans.length;
    const n = [...acc.byDate.values()].reduce((s, d) => s + d.n, 0);
    const hits = [...acc.byDate.values()].reduce((s, d) => s + d.hits, 0);
    const mean = dayMeans.reduce((s, v) => s + v, 0) / days;
    const sd = days > 1 ? Math.sqrt(dayMeans.reduce((s, v) => s + (v - mean) ** 2, 0) / (days - 1)) : NaN;
    const t = sd > 0 ? mean / (sd / Math.sqrt(days)) : 0;
    rows.push({
      signal, regime: regime as EvidenceRow['regime'], horizon: Number(h), n, days,
      mean_excess: Math.round(mean * 1e6) / 1e4, // percent, 2 decimals
      hit_rate: Math.round((hits / n) * 1000) / 1000,
      t_stat: Math.round(t * 100) / 100,
    });
  }
  rows.sort((a, b) => a.signal.localeCompare(b.signal) || a.horizon - b.horizon || a.regime.localeCompare(b.regime));

  const computedAt = new Date().toISOString();
  inTransaction(db, () => {
    db.prepare('DELETE FROM signal_evidence').run();
    const ins = db.prepare('INSERT INTO signal_evidence (computed_at, signal, regime, horizon, n, days, mean_excess, hit_rate, t_stat, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(computedAt, r.signal, r.regime, r.horizon, r.n, r.days, r.mean_excess, r.hit_rate, r.t_stat, start, end);
  });
  const verdicts = [...loadVerdicts(db).verdicts.values()];
  return { version: EVIDENCE_VERSION, signal_version: SIGNAL_VERSION, start, end, computed_at: computedAt, events: events.length, rows, verdicts };
}

export interface EvidenceMeta {
  start?: string;
  end?: string;
  computed_at?: string;
  /** False when the stored evidence window ends after the as-of date and was therefore not known then. */
  usable_as_of?: boolean;
  as_of?: string;
}

/**
 * Load the stored evidence and classify signals without recomputing. With
 * `asOf`, evidence whose window ends after that date is not used: a replayed
 * or back-dated report must not present later statistics as known at the time.
 */
export function loadVerdicts(db: DatabaseSync, asOf?: string): { verdicts: Map<string, SignalVerdict>; meta: EvidenceMeta } {
  const stored = db.prepare('SELECT * FROM signal_evidence').all() as any[];
  const first = stored[0];
  const usable = !asOf || !first || String(first.end_date) <= asOf;
  const meta: EvidenceMeta = first ? { start: first.start_date, end: first.end_date, computed_at: first.computed_at } : {};
  if (asOf) Object.assign(meta, { as_of: asOf, usable_as_of: usable });
  const rows = usable ? stored : [];
  const missingBasis = usable ? '尚无历史检验结果' : `已存证据窗口截至 ${first.end_date}，晚于 ${asOf}，该日期当时不可得，不予引用`;
  const verdicts = new Map<string, SignalVerdict>();
  for (const def of SIGNAL_DEFINITIONS) {
    const sign = def.direction === 'bullish' ? 1 : -1;
    const all = rows.find(r => r.signal === def.id && r.regime === 'all' && r.horizon === PRIMARY_HORIZON);
    if (!all) {
      verdicts.set(def.id, { signal: def.id, name: def.name, direction: def.direction, classification: 'research_only', basis: missingBasis });
      continue;
    }
    const against = rows.filter(r => r.signal === def.id && r.regime !== 'all' && r.horizon === PRIMARY_HORIZON && r.days >= 20 && sign * r.t_stat <= -1).map(r => r.regime);
    let classification: SignalVerdict['classification'] = 'research_only';
    if (sign * all.t_stat >= 2 && all.days >= 60 && all.n >= 300 && against.length === 0) classification = 'evidence_supported';
    else if (sign * all.t_stat <= -2) classification = 'contradicted';
    verdicts.set(def.id, {
      signal: def.id, name: def.name, direction: def.direction, classification,
      basis: `样本内 ${PRIMARY_HORIZON}日超额 ${all.mean_excess}%，t=${all.t_stat}（窗口重叠、未做多重检验校正），事件 ${all.n} 个/${all.days} 天（${all.start_date}~${all.end_date}）` +
        (against.length ? `；在 ${against.join(',')} 状态下方向相反` : ''),
    });
  }
  return { verdicts, meta };
}

/**
 * Realised forward performance of the stored watchlist (research record, not
 * a backtest): for each watchlist date t, members' return from the open of
 * t+1 to the close of t+h versus the equal-weight return of every stock
 * trading on both days. Prices are adjusted with adj_factor.
 *
 * Strictly as of `end`: only dates whose whole window t+1..t+h lies on or
 * before `end` are counted, and no price after `end` is read, so data that
 * arrives later cannot change an earlier report's figures.
 */
export function evaluateWatchlist(db: DatabaseSync, start: string, end: string, horizon = 5, minUniverse = 1000) {
  const days = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date').all(start, end) as any[]).map(r => r.cal_date as string);
  const wlDates = (db.prepare('SELECT DISTINCT trade_date FROM watchlist WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date').all(start, end) as any[]).map(r => r.trade_date as string);
  const ret = db.prepare(`
    SELECT d1.ts_code, (dh.close * ah.adj_factor) / (d1.open * a1.adj_factor) - 1 AS r
    FROM daily d1
    JOIN adj_factor a1 ON a1.ts_code = d1.ts_code AND a1.trade_date = d1.trade_date
    JOIN daily dh ON dh.ts_code = d1.ts_code AND dh.trade_date = ?
    JOIN adj_factor ah ON ah.ts_code = dh.ts_code AND ah.trade_date = dh.trade_date
    WHERE d1.trade_date = ? AND d1.open > 0`);
  const members = db.prepare('SELECT ts_code FROM watchlist WHERE trade_date = ?');
  const perDate: { trade_date: string; members: number; pool_ret: number; market_ret: number; excess: number }[] = [];
  for (const t of wlDates) {
    const i = days.indexOf(t);
    if (i < 0 || i + horizon >= days.length) continue;
    const rows = ret.all(days[i + horizon], days[i + 1]) as any[];
    if (rows.length < minUniverse) continue;
    const byCode = new Map(rows.map(r => [r.ts_code, r.r as number]));
    const pool = (members.all(t) as any[]).map(m => byCode.get(m.ts_code)).filter((v): v is number => Number.isFinite(v));
    if (!pool.length) continue;
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const p = mean(pool);
    const m = mean(rows.map(r => r.r));
    perDate.push({ trade_date: t, members: pool.length, pool_ret: p, market_ret: m, excess: p - m });
  }
  const ex = perDate.map(d => d.excess);
  const avg = ex.length ? ex.reduce((s, v) => s + v, 0) / ex.length : NaN;
  const sd = ex.length > 1 ? Math.sqrt(ex.reduce((s, v) => s + (v - avg) ** 2, 0) / (ex.length - 1)) : NaN;
  const pct = (v: number) => Math.round(v * 1e4) / 100;
  return {
    horizon,
    as_of: end,
    pending_dates: wlDates.length - perDate.length,
    dates: perDate.length,
    mean_excess_pct: pct(avg),
    hit_rate: ex.length ? Math.round((ex.filter(v => v > 0).length / ex.length) * 1000) / 1000 : null,
    // Overlapping windows: consecutive dates share h-1 days, so this t-stat overstates significance.
    t_stat_overlapping: sd > 0 ? Math.round((avg / (sd / Math.sqrt(ex.length))) * 100) / 100 : null,
    note: '股票池为启发式评分结果；样本短且持有期重叠，不能据此推断盈利概率',
    per_date: perDate.map(d => ({ ...d, pool_ret: pct(d.pool_ret), market_ret: pct(d.market_ret), excess: pct(d.excess) })),
  };
}
