import type { DatabaseSync } from 'node:sqlite';

/** Independent research observations. This module reads market data and never writes derived/live state. */
export const EVALUATION_VERSION = 'eval-research-1.0.0';
export interface EvaluationEvent {
  date: string;
  ts_code: string;
  score?: number | null;
  factors?: Record<string, number | null>;
  signals?: string[] | Record<string, number | boolean | null>;
  /** A caller-supplied historical industry, when available; otherwise current metadata is used with a warning. */
  industry?: string | null;
}
export interface EvaluationOptions {
  asOf: string;
  /** Exit at t+h close, h>=2: A-share T+1 forbids resale on the t+1 entry day. */
  horizon: number;
  buyFeeBps: number;
  sellFeeBps: number;
  slippageBps: number;
  maxExitDelay: number;
}
export type OutcomeStatus = 'completed' | 'entry_blocked' | 'entry_unknown' | 'pending' | 'unpriced' | 'unexited';
export interface ReferenceReturn {
  status: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  /** Mean of priced observations only; partial coverage is never called a complete benchmark. Decimal return. */
  observed_return: number | null;
  eligible: number;
  priced: number;
  unresolved: number;
}
export interface EvaluationOutcome {
  event: EvaluationEvent;
  status: OutcomeStatus;
  reason: string;
  entered: boolean;
  entry_date: string | null;
  planned_exit_date: string | null;
  exit_date: string | null;
  exit_delay: number | null;
  entry_price: number | null;
  exit_price: number | null;
  gross_return: number | null;
  net_return: number | null;
  exit_obstacles: { date: string; reason: string }[];
  references: Record<'equal_market' | 'csi300' | 'industry', ReferenceReturn>;
  /** Conditional on the explicitly reported reference coverage. */
  excess: Record<'equal_market' | 'csi300' | 'industry', number | null>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const mean = (v: number[]) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
const missingReference = (status: ReferenceReturn['status'] = 'unavailable'): ReferenceReturn =>
  ({ status, observed_return: null, eligible: 0, priced: 0, unresolved: 0 });
const REFERENCE_KEYS = ['equal_market', 'csi300', 'industry'] as const;

function validateDate(date: string): void {
  if (!/^\d{8}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid date: ${date}`);
}
function validateOptions(o: EvaluationOptions): void {
  validateDate(o.asOf);
  if (!Number.isInteger(o.horizon) || o.horizon < 2) throw new Error('horizon must be an integer >=2 for A-share T+1 resale');
  if (!Number.isInteger(o.maxExitDelay) || o.maxExitDelay < 0) throw new Error('maxExitDelay must be a nonnegative integer');
  for (const key of ['buyFeeBps', 'sellFeeBps', 'slippageBps'] as const) {
    if (!finite(o[key]) || o[key] < 0 || o[key] >= 10000) throw new Error(`${key} must be in [0, 10000)`);
  }
}

export interface Distribution {
  n: number;
  mean: number | null;
  median: number | null;
  win_rate: number | null;
  /** Sample standard deviation of observations; not annualized portfolio volatility. */
  volatility: number | null;
  min: number | null;
  p05: number | null;
  p25: number | null;
  p75: number | null;
  p95: number | null;
  max: number | null;
}
export function distribution(values: (number | null | undefined)[]): Distribution {
  const v = values.filter(finite).sort((a, b) => a - b);
  const avg = mean(v);
  const q = (p: number): number | null => {
    if (!v.length) return null;
    const k = (v.length - 1) * p;
    const i = Math.floor(k);
    return v[i] + (v[Math.min(i + 1, v.length - 1)] - v[i]) * (k - i);
  };
  return { n: v.length, mean: avg, median: q(0.5), win_rate: v.length ? v.filter(x => x > 0).length / v.length : null,
    volatility: v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - avg!) ** 2, 0) / (v.length - 1)) : null,
    min: v[0] ?? null, p05: q(0.05), p25: q(0.25), p75: q(0.75), p95: q(0.95), max: v.at(-1) ?? null };
}
/** Pairwise-complete Pearson correlation. Missing/constant samples produce null, never zero. */
export function correlation(pairs: readonly (readonly [number | null | undefined, number | null | undefined])[]) {
  const valid = pairs.filter((p): p is readonly [number, number] => finite(p[0]) && finite(p[1]));
  const n = valid.length;
  if (n < 2) return { n, correlation: null };
  const mx = mean(valid.map(p => p[0]))!;
  const my = mean(valid.map(p => p[1]))!;
  const xx = valid.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const yy = valid.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  const xy = valid.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  return { n, correlation: xx > 0 && yy > 0 ? Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))) : null };
}

/**
 * Signals are supplied as-of t close; this function never selects stocks using forward prices.
 * Exact t+1 entry only, conservative open-up-limit exclusion, close-down-limit/suspension exit deferral.
 * Limit queues/intraday liquidity are not simulated. All dated market queries are bounded by asOf.
 */
export function evaluateEvents(db: DatabaseSync, events: EvaluationEvent[], options: EvaluationOptions) {
  validateOptions(options);
  for (const e of events) {
    validateDate(e.date);
    if (!e.ts_code) throw new Error('ts_code is required');
    if (e.date > options.asOf) throw new Error(`Signal ${e.date} is after asOf ${options.asOf}`);
  }
  const start = events.length ? events.reduce((s, e) => e.date < s ? e.date : s, events[0].date) : options.asOf;
  const days = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date')
    .all(start, options.asOf) as { cal_date: string }[]).map(r => r.cal_date);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const stocks = db.prepare('SELECT ts_code, industry, list_date, delist_date FROM stock_basic ORDER BY ts_code').all() as
    { ts_code: string; industry: string | null; list_date: string | null; delist_date: string | null }[];
  const byCode = new Map(stocks.map(s => [s.ts_code, s]));
  // Diagnostic only, evaluated at the attempted execution date, never a signal selection rule.
  const delistedAt = (code: string, date: string) => {
    const delist = byCode.get(code)?.delist_date;
    return !!delist && delist <= date && delist <= options.asOf;
  };
  const barStmt = db.prepare(`SELECT d.open, d.close, d.vol, a.adj_factor, l.up_limit, l.down_limit
    FROM daily d LEFT JOIN adj_factor a ON a.ts_code=d.ts_code AND a.trade_date=d.trade_date
    LEFT JOIN stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date
    WHERE d.ts_code=? AND d.trade_date=? AND d.trade_date<=?`);
  const suspendStmt = db.prepare('SELECT 1 FROM suspend_d WHERE ts_code=? AND trade_date=? AND trade_date<=?');
  type Bar = { open: number | null; close: number | null; vol: number | null; adj_factor: number | null; up_limit: number | null; down_limit: number | null };
  const barCache = new Map<string, Bar | undefined>();
  const bar = (code: string, date: string) => {
    const key = `${code}|${date}`;
    if (!barCache.has(key)) barCache.set(key, barStmt.get(code, date, options.asOf) as Bar | undefined);
    return barCache.get(key);
  };
  const suspended = (code: string, date: string) => !!suspendStmt.get(code, date, options.asOf);
  const referenceCache = new Map<string, ReferenceReturn>();
  // Aggregate all industries in one query per interval, avoiding a market-sized bar cache per event date.
  const refStmt = db.prepare(`WITH observations AS (
    SELECT s.industry, CASE WHEN a.open>0 AND b.close>0 AND a.vol>0 AND b.vol>0
      AND aa.adj_factor>0 AND ab.adj_factor>0 AND sa.ts_code IS NULL AND sb.ts_code IS NULL
      THEN b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 END AS r
    FROM stock_basic s
    LEFT JOIN daily a ON a.ts_code=s.ts_code AND a.trade_date=? AND a.trade_date<=?
    LEFT JOIN daily b ON b.ts_code=s.ts_code AND b.trade_date=? AND b.trade_date<=?
    LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
    LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=b.trade_date
    LEFT JOIN suspend_d sa ON sa.ts_code=a.ts_code AND sa.trade_date=a.trade_date
    LEFT JOIN suspend_d sb ON sb.ts_code=b.ts_code AND sb.trade_date=b.trade_date
    WHERE s.list_date<=? AND (s.delist_date IS NULL OR s.delist_date='' OR s.delist_date>?)
  ) SELECT industry, COUNT(*) AS eligible, COUNT(r) AS priced, SUM(r) AS total FROM observations GROUP BY industry`);
  const referenceIntervals = new Set<string>();
  const stockReference = (signal: string, entry: string, exit: string, industry?: string | null): ReferenceReturn => {
    if (industry === null) return missingReference('not_applicable');
    const interval = `${signal}|${entry}|${exit}`;
    if (!referenceIntervals.has(interval)) {
      const rows = refStmt.all(entry, options.asOf, exit, options.asOf, signal, signal) as
        { industry: string | null; eligible: number; priced: number; total: number | null }[];
      let eligible = 0, priced = 0, total = 0;
      const make = (eligible: number, priced: number, total: number): ReferenceReturn => ({
        status: !priced ? 'unavailable' : priced === eligible ? 'complete' : 'partial',
        observed_return: priced ? total / priced : null, eligible, priced, unresolved: eligible - priced,
      });
      for (const r of rows) {
        eligible += r.eligible; priced += r.priced; total += r.total ?? 0;
        if (r.industry !== null) referenceCache.set(`${interval}|industry:${r.industry}`, make(r.eligible, r.priced, r.total ?? 0));
      }
      referenceCache.set(`${interval}|market`, make(eligible, priced, total));
      referenceIntervals.add(interval);
    }
    return referenceCache.get(`${interval}|${industry === undefined ? 'market' : `industry:${industry}`}`) ?? missingReference();
  };
  const indexStmt = db.prepare('SELECT open, close FROM index_daily WHERE ts_code=? AND trade_date=? AND trade_date<=?');
  const indexReference = (entry: string, exit: string): ReferenceReturn => {
    const key = `index|${entry}|${exit}`;
    const cached = referenceCache.get(key);
    if (cached) return cached;
    const a = indexStmt.get('000300.SH', entry, options.asOf) as { open: number } | undefined;
    const b = indexStmt.get('000300.SH', exit, options.asOf) as { close: number } | undefined;
    const priced = positive(a?.open) && positive(b?.close);
    const ref: ReferenceReturn = { status: priced ? 'complete' : 'unavailable', observed_return: priced ? b!.close / a!.open - 1 : null,
      eligible: 1, priced: priced ? 1 : 0, unresolved: priced ? 0 : 1 };
    referenceCache.set(key, ref);
    return ref;
  };
  const outcomes = events.map((event): EvaluationOutcome => {
    const i = dayIndex.get(event.date);
    const entryDate = i === undefined ? null : days[i + 1] ?? null;
    const plannedExit = i === undefined ? null : days[i + options.horizon] ?? null;
    const o: EvaluationOutcome = { event, status: 'pending', reason: 'entry_after_as_of', entered: false,
      entry_date: entryDate, planned_exit_date: plannedExit, exit_date: null, exit_delay: null,
      entry_price: null, exit_price: null, gross_return: null, net_return: null, exit_obstacles: [],
      references: { equal_market: missingReference(), csi300: missingReference(), industry: missingReference() },
      excess: { equal_market: null, csi300: null, industry: null } };
    const stop = (status: OutcomeStatus, reason: string) => Object.assign(o, { status, reason });
    if (i === undefined) return stop('unpriced', 'signal_not_in_exchange_calendar');
    if (!entryDate) return o;
    if (suspended(event.ts_code, entryDate)) return stop('entry_blocked', 'entry_suspended');
    const a = bar(event.ts_code, entryDate);
    if (!a || !positive(a.open)) return stop('unpriced', delistedAt(event.ts_code, entryDate) ? 'delisted_missing_entry_open' : 'missing_entry_open');
    if (a.vol === 0) return stop('entry_blocked', 'entry_zero_volume');
    if (!positive(a.vol)) return stop('entry_unknown', 'entry_volume_unknown');
    if (!positive(a.up_limit)) return stop('entry_unknown', 'entry_limit_unknown');
    if (a.open >= a.up_limit - 0.001) return stop('entry_blocked', 'entry_open_at_up_limit');
    o.entered = true;
    o.entry_price = a.open;
    if (!plannedExit) return stop('pending', 'horizon_after_as_of');
    for (let delay = 0; delay <= options.maxExitDelay; delay++) {
      const exitDate = days[i + options.horizon + delay];
      if (!exitDate) return stop('pending', 'exit_delay_after_as_of');
      let obstacle: string | undefined;
      const b = bar(event.ts_code, exitDate);
      if (suspended(event.ts_code, exitDate)) obstacle = 'exit_suspended';
      else if (!b || !positive(b.close)) obstacle = delistedAt(event.ts_code, exitDate) ? 'delisted_missing_exit_close' : 'missing_exit_close';
      else if (b.vol === 0) obstacle = 'exit_zero_volume';
      else if (!positive(b.vol)) obstacle = 'exit_volume_unknown';
      else if (!positive(b.down_limit)) obstacle = 'exit_limit_unknown';
      else if (b.close <= b.down_limit + 0.001) obstacle = 'exit_close_at_down_limit';
      if (obstacle) {
        o.exit_obstacles.push({ date: exitDate, reason: obstacle });
        // Missing pricing/constraints are unknown, not an assumed failed fill followed by a later success.
        if (obstacle === 'missing_exit_close' || obstacle === 'delisted_missing_exit_close' || obstacle === 'exit_volume_unknown' || obstacle === 'exit_limit_unknown') {
          return stop('unexited', obstacle);
        }
        if (delay === options.maxExitDelay) return stop('unexited', 'exit_delay_exhausted');
        continue;
      }
      o.exit_date = exitDate;
      o.exit_delay = delay;
      o.exit_price = b!.close;
      if (!positive(a.adj_factor) || !positive(b!.adj_factor)) return stop('unpriced', 'adjustment_factor_missing');
      o.gross_return = b!.close! * b!.adj_factor! / (a.open * a.adj_factor) - 1;
      const slip = options.slippageBps / 10000;
      o.net_return = (1 + o.gross_return) * (1 - slip) * (1 - options.sellFeeBps / 10000)
        / ((1 + slip) * (1 + options.buyFeeBps / 10000)) - 1;
      o.references.equal_market = stockReference(event.date, entryDate, exitDate);
      o.references.csi300 = indexReference(entryDate, exitDate);
      o.references.industry = stockReference(event.date, entryDate, exitDate, event.industry === undefined ? byCode.get(event.ts_code)?.industry ?? null : event.industry);
      for (const k of REFERENCE_KEYS) {
        const r = o.references[k].observed_return;
        o.excess[k] = r === null ? null : o.net_return - r;
      }
      return stop('completed', 'observed_exit');
    }
    return stop('unexited', 'exit_delay_exhausted');
  });
  return { version: EVALUATION_VERSION, scope: 'RESEARCH_ONLY_RETURN_OBSERVATIONS', options: { ...options }, outcomes,
    summary: summarizeEvaluation(outcomes, options.asOf), limitations: [
      'Signals/factors must be supplied using information available at t close; evaluation does not validate their provenance or financial announcement filtering.',
      'Calendar and dated market reads stop at asOf. Current stock_basic names/industry/listing metadata are not complete point-in-time history; historical industry references are approximate.',
      'Opening buys at up-limit and closing sales at down-limit are conservatively blocked; suspension records block all trading that date, including partial-day suspensions. No order queue or intraday execution simulation.',
      'A missing entry is never shifted to the next available bar. Missing exit price/limits remain unresolved; suspension/known down-limit exits defer by at most maxExitDelay exchange days.',
      'Adjusted open-to-close returns approximate corporate actions using endpoint factors. Costs apply to both sides; slippage applies adversely to both sides.',
      'Market/industry references are gross, uncosted endpoint observations of the signal-date listed universe, not investable portfolios. Partial references report priced-subset means and unresolved counts; no assumed delisting loss or zero return.',
      'CSI300 is the gross price-index open-to-close return, not an ETF or total-return investment. References use the actual delayed exit date.',
      'Statistics describe event/date return observations, not returns of a funded portfolio. Overlap and repeated stocks induce dependence; no significance or annualized Sharpe claim is made.',
      'A-share T+1 resale requires horizon>=2 under the t+h exit convention; entry-day resale is rejected.',
      'Non-overlap sensitivity greedily retains whole signal-date cohorts using every entered position, with exits still unconfirmed censored at asOf. No-entry cohorts remain counted but cannot create a holding interval. Returns use completed observations only, with unresolved denominators explicit; this does not remove dependence or selection bias.',
    ] };
}

function observationDrawdown(values: number[]): number | null {
  if (!values.length) return null;
  let level = 1, peak = 1, drawdown = 0;
  for (const r of values) {
    level *= 1 + r;
    peak = Math.max(peak, level);
    drawdown = Math.min(drawdown, level / peak - 1);
  }
  return drawdown;
}

/** Statistics are exported separately so V1/V2 drivers can use exactly the same definitions. */
export function summarizeEvaluation(outcomes: EvaluationOutcome[], asOf: string) {
  validateDate(asOf);
  const statuses: Record<OutcomeStatus, number> = { completed: 0, entry_blocked: 0, entry_unknown: 0, pending: 0, unpriced: 0, unexited: 0 };
  const reasons: Record<string, number> = {};
  for (const o of outcomes) { statuses[o.status]++; reasons[o.reason] = (reasons[o.reason] ?? 0) + 1; }
  const completed = outcomes.filter(o => o.status === 'completed' && finite(o.net_return));
  const benchmarks = Object.fromEntries(REFERENCE_KEYS.map(k => {
    const paired = completed.filter(o => finite(o.excess[k]));
    const complete = paired.filter(o => o.references[k].status === 'complete');
    return [k, { denominator_completed_events: completed.length, paired: paired.length, missing: completed.length - paired.length,
      complete_coverage_events: complete.length, partial_coverage_events: paired.length - complete.length,
      reference_memberships: completed.reduce((s, o) => s + o.references[k].eligible, 0),
      priced_memberships: completed.reduce((s, o) => s + o.references[k].priced, 0),
      unresolved_memberships: completed.reduce((s, o) => s + o.references[k].unresolved, 0),
      excess_complete_coverage: distribution(complete.map(o => o.excess[k])),
      excess_including_priced_subsets: distribution(paired.map(o => o.excess[k])) }];
  }));
  const cohorts = new Map<string, EvaluationOutcome[]>();
  for (const o of outcomes) { const list = cohorts.get(o.event.date) ?? []; list.push(o); cohorts.set(o.event.date, list); }
  const byDate = [...cohorts].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const entered = rows.filter(o => o.entered);
    const priced = rows.filter(o => o.status === 'completed' && finite(o.net_return));
    const open = entered.filter(o => !o.exit_date);
    const entries = entered.map(o => o.entry_date!).sort();
    const intervalEnds = entered.map(o => o.exit_date ?? asOf).sort();
    return { date, n: rows.length, entered: entered.length, completed: priced.length,
      unresolved_after_entry: entered.filter(o => o.status !== 'completed').length,
      not_entered: rows.length - entered.length, open_at_cutoff: open.length, censored: open.length > 0,
      entry_date: entries[0] ?? null, exit_date: intervalEnds.at(-1) ?? null,
      net_return: mean(priced.map(o => o.net_return!)),
      excess: Object.fromEntries(REFERENCE_KEYS.map(k => [k, mean(priced.map(o => o.excess[k]).filter(finite))])) as Record<typeof REFERENCE_KEYS[number], number | null> };
  });
  const holdingCohorts = byDate.filter(d => d.entered > 0);
  const nonOverlap: typeof byDate = [];
  let through = '';
  let overlappingPairs = 0;
  const exitDates = holdingCohorts.map(d => d.exit_date!).sort();
  const upperBound = (date: string) => {
    let lo = 0, hi = exitDates.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (exitDates[mid] < date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let i = 0; i < holdingCohorts.length; i++) {
    const d = holdingCohorts[i];
    // Earlier intervals include positions still open at asOf, even if another stock in that cohort exited.
    overlappingPairs += i - upperBound(d.entry_date!);
    if (d.entry_date! > through) { nonOverlap.push(d); through = d.exit_date!; }
  }
  const factors = [...new Set(outcomes.flatMap(o => Object.keys(o.event.factors ?? {})))].sort();
  const signalKeys = [...new Set(outcomes.flatMap(o => Array.isArray(o.event.signals) ? o.event.signals : Object.keys(o.event.signals ?? {})))].sort();
  const signalValue = (e: EvaluationEvent, key: string): number | null => {
    if (Array.isArray(e.signals)) return e.signals.includes(key) ? 1 : 0;
    const v = e.signals?.[key];
    return typeof v === 'boolean' ? Number(v) : finite(v) ? v : null;
  };
  const features = [
    ...(outcomes.some(o => o.event.score !== undefined) ? [{ name: 'score', get: (e: EvaluationEvent) => e.score }] : []),
    ...factors.map(k => ({ name: `factor:${k}`, get: (e: EvaluationEvent) => e.factors?.[k] })),
    ...signalKeys.map(k => ({ name: `signal:${k}`, get: (e: EvaluationEvent) => signalValue(e, k) })),
  ];
  const correlations = features.map(f => ({ feature: f.name,
    with_net_return: correlation(outcomes.map(o => [f.get(o.event), o.net_return] as const)),
    with_excess: Object.fromEntries(REFERENCE_KEYS.map(k => [k, correlation(outcomes.map(o => [f.get(o.event), o.excess[k]] as const))])),
    with_features: Object.fromEntries(features.map(g => [g.name, correlation(outcomes.map(o => [f.get(o.event), g.get(o.event)] as const))])) }));
  const cohortStats = (rows: typeof byDate) => ({ dates: rows.length, events: rows.reduce((s, d) => s + d.n, 0),
    entered: rows.reduce((s, d) => s + d.entered, 0), completed: rows.reduce((s, d) => s + d.completed, 0),
    unresolved_after_entry: rows.reduce((s, d) => s + d.unresolved_after_entry, 0),
    not_entered: rows.reduce((s, d) => s + d.not_entered, 0), open_at_cutoff: rows.reduce((s, d) => s + d.open_at_cutoff, 0),
    dates_with_entries: rows.filter(d => d.entered > 0).length, dates_with_completed_returns: rows.filter(d => d.completed > 0).length,
    net_return: distribution(rows.map(d => d.net_return)),
    excess_including_priced_subsets: Object.fromEntries(REFERENCE_KEYS.map(k => [k, distribution(rows.map(d => d.excess[k]))])),
    /** Synthetic compounding of priced date observations only; unresolved positions remain in denominators. */
    synthetic_observation_drawdown: observationDrawdown(rows.map(d => d.net_return).filter(finite)) });
  return { denominators: { events: outcomes.length, entered: outcomes.filter(o => o.entered).length, completed: completed.length,
    unresolved_after_entry: outcomes.filter(o => o.entered && o.status !== 'completed').length,
    not_entered: outcomes.filter(o => !o.entered).length, statuses, reasons },
    gross_return: distribution(completed.map(o => o.gross_return)), net_return: distribution(completed.map(o => o.net_return)),
    benchmarks, by_date: byDate, overlap: { as_of: asOf, overlapping_cohort_pairs: overlappingPairs, all_cohorts: cohortStats(byDate),
      excluded_no_entry_dates: byDate.filter(d => d.entered === 0).map(d => d.date),
      non_overlapping_cohorts: cohortStats(nonOverlap), retained_dates: nonOverlap.map(d => d.date) }, correlations,
    interpretation: 'Decimal event/date return observations. Synthetic observation drawdown is not funded portfolio drawdown; no independence, statistical significance or annualized volatility is asserted.' };
}
