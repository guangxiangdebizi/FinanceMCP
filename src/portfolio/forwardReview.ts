import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildBenchmarkComparison, FROZEN_FIVE_START_DATE, type BenchmarkResult } from './benchmarks.js';
import { canonicalJson, evaluateResearchJournal, listResearchJournal, type JournalEvaluation, type JournalFeeEstimator, type JournalRecord } from './researchJournal.js';

export const FORWARD_REVIEW_SCHEMA = 'forward-review/1.0';
/** First session whose data had not been observed before the rules were frozen; earlier records are history. */
export const TRUE_FORWARD_START = '20261022';
/** Reporting gate on non-overlapping matured windows. It is a floor for stating results, not a significance test. */
export const MIN_NON_OVERLAPPING_WINDOWS = 12;
const DEFAULT_HORIZONS = [5, 10, 20, 60];
const BENCHMARK_IDS = ['csi300_etf_buy_hold', 'frozen_multi_asset_basket', 'initial_five_etf_basket'] as const;
type BenchmarkId = typeof BENCHMARK_IDS[number];

export type EvidenceClass = 'TRUE_FORWARD' | 'PRE_FORWARD_HISTORICAL' | 'RETROSPECTIVE_RECORD';
export type HorizonVerdict = 'NO_MATURED_SAMPLE' | 'INSUFFICIENT_SAMPLE' | 'NO_IMPROVEMENT' | 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT';

const round = (n: number) => Math.round(n * 10000) / 10000;
const shanghaiDate = (timestamp: string) => new Date(Date.parse(timestamp) + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const mean = (v: number[]) => v.length ? round(v.reduce((s, x) => s + x, 0) / v.length) : null;
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const stdev = (v: number[]) => { if (v.length < 2) return null; const m = v.reduce((s, x) => s + x, 0) / v.length; return round(Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1))); };

/** A record counts as forward only if it concerns a session on/after the freeze and was stored no later than that session. */
export function classifyRecord(record: JournalRecord): EvidenceClass {
  if (record.as_of_trade_date < TRUE_FORWARD_START) return 'PRE_FORWARD_HISTORICAL';
  const late = shanghaiDate(record.generated_at) > record.as_of_trade_date || shanghaiDate(record.recorded_at) > record.as_of_trade_date
    || (record.provenance !== undefined && shanghaiDate(record.provenance.obtained_at) > record.as_of_trade_date);
  return late ? 'RETROSPECTIVE_RECORD' : 'TRUE_FORWARD';
}

interface MaturedRecord {
  record_id: string; source: string; as_of_trade_date: string; maturity_date: string;
  net_return_pct: number; max_drawdown_pct: number;
  excess_pct_points: Record<BenchmarkId, number | null>;
  invalidated: number; invalidation_defined: number;
}

function weighted(values: { v: number; w: number }[]): number {
  const total = values.reduce((s, x) => s + x.w, 0);
  return round(values.reduce((s, x) => s + x.v * x.w, 0) / total);
}

/** Pure, deterministic: same journal + same market cache + same asOf gives identical JSON. */
export function buildForwardReview(input: {
  portfolioDb: DatabaseSync; marketDb: DatabaseSync | null | undefined; accountId: string; asOf: string;
  horizons?: number[]; feeEstimator?: JournalFeeEstimator; evaluations?: JournalEvaluation[];
}) {
  const horizons = input.horizons ?? DEFAULT_HORIZONS;
  const records = listResearchJournal(input.portfolioDb, { accountId: input.accountId, asOf: input.asOf, limit: 1000 });
  const byId = new Map(records.map(r => [r.record_id, r]));
  const classOf = new Map(records.map(r => [r.record_id, classifyRecord(r)]));
  const evaluations = input.evaluations ?? evaluateResearchJournal({ portfolioDb: input.portfolioDb, marketDb: input.marketDb, accountId: input.accountId, asOf: input.asOf, horizons, feeEstimator: input.feeEstimator });

  const benchmarkCache = new Map<string, Map<string, BenchmarkResult>>();
  let benchmarkMeta: { definition_version: string; basket_weights_status: string | null } | null = null;
  const comparison = (start: string, end: string) => {
    const key = `${start}:${end}`;
    if (!benchmarkCache.has(key)) {
      const result = buildBenchmarkComparison({ marketDb: input.marketDb, start, end });
      benchmarkMeta ??= { definition_version: result.definition_version, basket_weights_status: result.benchmarks.find(b => b.id === 'frozen_multi_asset_basket')?.weights_status ?? null };
      benchmarkCache.set(key, new Map(result.benchmarks.map(b => [b.id, b])));
    }
    return benchmarkCache.get(key)!;
  };

  const bySource: Record<string, Record<string, unknown>> = {};
  const sources = [...new Set(records.filter(r => classOf.get(r.record_id) === 'TRUE_FORWARD').map(r => r.source))].sort();
  for (const source of sources) {
    const perHorizon: Record<string, unknown> = {};
    for (const horizon of horizons) {
      const rows = evaluations.filter(e => e.horizon_trade_days === horizon && e.source === source && classOf.get(e.record_id) === 'TRUE_FORWARD');
      const pending = rows.filter(e => e.status === 'PENDING').length;
      const unavailable = rows.filter(e => e.status === 'UNAVAILABLE');
      const matured: MaturedRecord[] = [];
      const benchmarkWindows: Record<string, { vol: number | null; mdd: number | null }[]> = Object.fromEntries(BENCHMARK_IDS.map(id => [id, []]));
      for (const e of rows.filter(e => e.status === 'EVALUATED')) {
        const start = byId.get(e.record_id)!.as_of_trade_date;
        const obs = e.observations.filter((o: any) => o.status === 'EVALUATED' && Number.isFinite(o.invested_cents) && o.invested_cents > 0) as any[];
        if (!obs.length || obs.length !== e.observations.length) { unavailable.push(e); continue; }
        const w = (pick: (o: any) => number) => weighted(obs.map(o => ({ v: pick(o), w: o.invested_cents })));
        const net = w(o => o.net_return_pct);
        const excess: Record<BenchmarkId, number | null> = { csi300_etf_buy_hold: w(o => o.excess_return_pct), frozen_multi_asset_basket: null, initial_five_etf_basket: null };
        const benches = comparison(start, e.maturity_date!);
        const basket = benches.get('frozen_multi_asset_basket');
        excess.frozen_multi_asset_basket = basket && basket.status !== 'UNAVAILABLE' && basket.total_return_pct !== null ? round(net - basket.total_return_pct) : null;
        // The five-ETF no-trade benchmark is anchored at the confirmed baseline and cannot start later; take the
        // value ratio between the research date and maturity along that single anchored path (constant units, no trades).
        const fiveAtStart = comparison(FROZEN_FIVE_START_DATE, start).get('initial_five_etf_basket');
        const fiveAtEnd = comparison(FROZEN_FIVE_START_DATE, e.maturity_date!).get('initial_five_etf_basket');
        const fiveOk = (b?: BenchmarkResult) => !!b && b.status !== 'UNAVAILABLE' && b.end_value_cents !== null && b.end_value_cents > 0;
        excess.initial_five_etf_basket = fiveOk(fiveAtStart) && fiveOk(fiveAtEnd) ? round(net - (fiveAtEnd!.end_value_cents! / fiveAtStart!.end_value_cents! - 1) * 100) : null;
        for (const id of BENCHMARK_IDS) { const b = benches.get(id); if (b && b.status !== 'UNAVAILABLE') benchmarkWindows[id].push({ vol: b.annualized_vol_pct, mdd: b.max_drawdown_pct }); }
        matured.push({ record_id: e.record_id, source, as_of_trade_date: start, maturity_date: e.maturity_date!, net_return_pct: net,
          max_drawdown_pct: w(o => o.max_drawdown_pct), excess_pct_points: excess,
          invalidated: obs.filter(o => o.invalidation === 'INVALIDATED').length, invalidation_defined: obs.filter(o => o.invalidation !== 'NOT_DEFINED').length });
      }
      // Overlapping windows are strongly dependent; keep only windows that start after the previous kept one matured.
      matured.sort((a, b) => a.as_of_trade_date.localeCompare(b.as_of_trade_date));
      let lastMaturity = '';
      const independent = matured.filter(m => { if (m.as_of_trade_date < lastMaturity) return false; lastMaturity = m.maturity_date; return true; });
      const excessStats = Object.fromEntries(BENCHMARK_IDS.map(id => {
        const values = matured.map(m => m.excess_pct_points[id]).filter((x): x is number => x !== null);
        return [id, { n: values.length, mean_excess_pct_points: mean(values), median_excess_pct_points: median(values), hit_rate: values.length ? round(values.filter(x => x > 0).length / values.length) : null,
          benchmark_mean_annualized_vol_pct: mean(benchmarkWindows[id].map(x => x.vol).filter((x): x is number => x !== null)),
          benchmark_mean_max_drawdown_pct: mean(benchmarkWindows[id].map(x => x.mdd).filter((x): x is number => x !== null)) }];
      }));
      let verdict: HorizonVerdict;
      if (!matured.length) verdict = 'NO_MATURED_SAMPLE';
      else if (independent.length < MIN_NON_OVERLAPPING_WINDOWS) verdict = 'INSUFFICIENT_SAMPLE';
      else {
        const usable = BENCHMARK_IDS.map(id => (excessStats as any)[id]).filter(s => s.n > 0);
        verdict = usable.length === BENCHMARK_IDS.length && usable.every(s => s.mean_excess_pct_points > 0) ? 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT' : 'NO_IMPROVEMENT';
      }
      const nets = matured.map(m => m.net_return_pct);
      perHorizon[String(horizon)] = {
        horizon_trade_days: horizon, verdict, pending, unavailable: unavailable.length,
        unavailable_reasons: [...new Set(unavailable.map(e => e.reason ?? 'unspecified'))].sort(),
        matured: matured.length, non_overlapping_windows: independent.length,
        after_fee_net_return_pct: { mean: mean(nets), median: median(nets), stdev_across_windows: stdev(nets), worst: nets.length ? Math.min(...nets) : null },
        max_drawdown_pct: { mean_weighted_member: mean(matured.map(m => m.max_drawdown_pct)), worst: matured.length ? Math.min(...matured.map(m => m.max_drawdown_pct)) : null },
        excess_vs: excessStats,
        failed_predictions: {
          windows_with_negative_net_return: nets.filter(x => x < 0).length,
          windows_underperforming_csi300: matured.filter(m => (m.excess_pct_points.csi300_etf_buy_hold ?? 0) < 0).length,
          invalidation_breached_observations: matured.reduce((s, m) => s + m.invalidated, 0),
          observations_with_invalidation_defined: matured.reduce((s, m) => s + m.invalidation_defined, 0),
        },
      };
    }
    bySource[source] = perHorizon;
  }

  const all = Object.values(bySource).flatMap(h => Object.values(h) as any[]);
  const matured = all.reduce((s, h) => s + h.matured, 0);
  const qualified = all.filter(h => h.verdict === 'NO_IMPROVEMENT' || h.verdict === 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT');
  const conclusion = !matured ? 'NO_MATURED_FORWARD_SAMPLE'
    : !qualified.length ? 'INSUFFICIENT_FORWARD_SAMPLE'
    : qualified.every(h => h.verdict === 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT') ? 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT' : 'NO_IMPROVEMENT_DEMONSTRATED';
  const statement = {
    NO_MATURED_FORWARD_SAMPLE: '尚无成熟的真实前瞻窗口，不能说明研究有任何改进，也不能说明没有。',
    INSUFFICIENT_FORWARD_SAMPLE: `已有成熟窗口但独立（不重叠）窗口数低于 ${MIN_NON_OVERLAPPING_WINDOWS}，不作改进结论。`,
    NO_IMPROVEMENT_DEMONSTRATED: '在已达披露门槛的窗口中，扣费后相对基准没有一致的改进；历史规则不会因此被修改。',
    IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT: '已披露窗口平均扣费后超额为正，但未做显著性检验、窗口相关且基准权重未获批准，不构成前瞻有效性的证据。',
  }[conclusion];
  const recordCounts = { total: records.length, by_class: { TRUE_FORWARD: 0, PRE_FORWARD_HISTORICAL: 0, RETROSPECTIVE_RECORD: 0 } as Record<EvidenceClass, number>, by_source: {} as Record<string, number> };
  for (const r of records) { recordCounts.by_class[classOf.get(r.record_id)!]++; recordCounts.by_source[r.source] = (recordCounts.by_source[r.source] ?? 0) + 1; }
  const review = {
    schema: FORWARD_REVIEW_SCHEMA, account_id: input.accountId, as_of_trade_date: input.asOf, horizons,
    true_forward_start: TRUE_FORWARD_START,
    forward_rule: `仅 as_of_trade_date >= ${TRUE_FORWARD_START} 且在该交易日当天（上海时间）已写入、取得的记录计入前瞻统计；此前的数据已被观察过，只计数，不进入任何统计。`,
    records: recordCounts,
    pre_forward_excluded: records.filter(r => classOf.get(r.record_id) !== 'TRUE_FORWARD').map(r => ({ record_id: r.record_id, as_of_trade_date: r.as_of_trade_date, source: r.source, class: classOf.get(r.record_id) })),
    min_non_overlapping_windows: MIN_NON_OVERLAPPING_WINDOWS,
    benchmarks: { ids: BENCHMARK_IDS, ...(benchmarkMeta ?? { definition_version: null, basket_weights_status: null }),
      note: 'csi300 为记录内逐标的同预算整手含买卖费用比较；篮子取自冻结基准 API（仅含建仓费用、不含退出费用）；初始五只 ETF 为自 20261016 基线起数量不变、不交易的路径，取研究日至成熟日的市值比（无费用，现金计入分母），基准未扣退出费用，对研究侧略偏严格，已在文档披露。' },
    conclusion, statement, by_source: bySource,
    limitations: ['观察对象是账户持仓的价格纸面观察，不是实际成交，不含分红现金流（遇复权因子变化即标记不可用）。', '窗口按每个交易日重叠，统计量彼此相关；未做显著性检验。', '历史规则、基准定义与版本不会按结果调整。'],
  };
  return { ...review, review_id: `FR-${createHash('sha256').update(canonicalJson(review)).digest('hex').slice(0, 24)}` };
}
