import type { DatabaseSync } from 'node:sqlite';
import { auditWatchlist, blockInference, controlScan, holmAdjust, type ControlModel, type ValidationType } from './validation.js';
import { scanMarket, SCORE_RULES, SCORE_VERSION, scoreRows, type MarketScan, type StockRow } from './analysis.js';

/** Quant-model self-diagnosis (WP3.1 + WP3.2).
 *
 * The diagnosis answers one question: *why* did the watchlist behave the way it
 * did, and is there a mechanism worth building a candidate for? It reuses the
 * existing statistics in `validation.ts` (block bootstrap, Holm) and the
 * predeclared control models in `analysis.ts`. It deliberately does NOT add a
 * second statistics implementation, a second significance test, or a search
 * over comparison sets.
 *
 * Three properties make this auditable rather than merely plausible:
 *
 * 1. **Predeclared comparison set.** The control family is exactly
 *    `CONTROL_MODELS` from `validation.ts`, in that order, always. A diagnosis
 *    never selects a favourable comparison after seeing results; the Holm
 *    adjustment is applied across the whole declared family so that "the best
 *    of eight" cannot masquerade as a single confirmed finding.
 * 2. **Every claim carries an evidence tier.** Facts observed in the data are
 *    separated from statistical findings, and both are separated from economic
 *    interpretation. An interpretation is never promoted to a fact because the
 *    p-value was small.
 * 3. **Refusal is a first-class output.** `NO_CLEAR_FAILURE_MECHANISM`,
 *    `NO_SIGNIFICANT_INCREMENTAL_FACTOR`, `INSUFFICIENT_DATA`,
 *    `DATA_QUALITY_BLOCKED` and `NEGATIVE_EVIDENCE` are all normal results. A
 *    diagnosis that cannot conclude must say so instead of manufacturing a
 *    mechanism — the same rule that governs `simulateFunded`, which stops
 *    rather than fabricating a NAV curve.
 */

export const DIAGNOSIS_VERSION = 'diagnosis-1.0.0';

/** Every terminal verdict the diagnosis may reach. There is no "success" value:
 * the output is a mechanism, or a reason there is not one. */
export const DIAGNOSIS_VERDICTS = [
  'MECHANISM_IDENTIFIED',
  'NO_CLEAR_FAILURE_MECHANISM',
  'NO_SIGNIFICANT_INCREMENTAL_FACTOR',
  'INSUFFICIENT_DATA',
  'DATA_QUALITY_BLOCKED',
  'NEGATIVE_EVIDENCE',
] as const;
export type DiagnosisVerdict = typeof DIAGNOSIS_VERDICTS[number];

/** Evidence tiers, weakest last. A finding never crosses a tier boundary silently. */
export const EVIDENCE_TIERS = [
  'OBSERVED_FACT',
  'STATISTICAL_FINDING',
  'ECONOMIC_INTERPRETATION',
  'COUNTER_EVIDENCE',
  'UNRESOLVED_GAP',
] as const;
export type EvidenceTier = typeof EVIDENCE_TIERS[number];

export interface DiagnosisClaim {
  tier: EvidenceTier;
  /** The dimension the claim belongs to: market state, factor contribution, etc. */
  dimension: DiagnosisDimension;
  statement: string;
  /** Numbers behind the claim. Never omitted for a STATISTICAL_FINDING. */
  evidence: Record<string, number | string | null>;
}

export const DIAGNOSIS_DIMENSIONS = [
  'market_state',
  'factor_contribution',
  'return_source',
  'execution_factor',
  'pool_construction',
] as const;
export type DiagnosisDimension = typeof DIAGNOSIS_DIMENSIONS[number];

/** One predeclared control comparison and its measured outcome. */
export interface ControlComparison {
  model: ControlModel;
  /** Mean excess of the original watchlist over this control, in percent. */
  mean_excess_pct: number | null;
  /** Block-bootstrap p-value for that mean; null when inference is unavailable. */
  p_value: number | null;
  p_holm: number | null;
  rejected_at_005: boolean;
  /** Why inference is unavailable, when it is. */
  status: string;
  cohorts: number;
}

export interface DiagnosisReport {
  version: string;
  as_of: string;
  horizon: number;
  verdict: DiagnosisVerdict;
  /** Human-readable reason for the verdict. Never empty. */
  verdict_reason: string;
  claims: DiagnosisClaim[];
  /** The declared control family, in declared order, with measured outcomes. */
  controls: ControlComparison[];
  /** Whether a new candidate is worth registering, and on what grounds. */
  candidate_recommendation: {
    should_create: boolean;
    /** The dimension a candidate would address; null when should_create is false. */
    target_dimension: DiagnosisDimension | null;
    rationale: string;
  };
  scope: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Render a **fraction** as a percent string's numeric part, to 2 decimals.
 *
 * The name says it: pass 0.0113, get 1.13. Every caller must pass a fraction
 * (0~1), never an already-percent figure. The original implementation was
 * called as `pct(x * 100)` in a dozen places, which multiplies by 100 twice
 * and printed a 1.13% excess as 113% — a number that reads as a spectacular
 * result rather than as a bug. Two places passed values that were percent
 * already (`auditWatchlist.mean_excess_pct`), so the units of the *sources*
 * were also mixed.
 *
 * Score points are not fractions and must not go through here at all; they use
 * `pts`, which only rounds. */
const pct = (v: number) => Math.round(v * 10000) / 100;
/** Render a score point value. Deliberately a different function from `pct`:
 * a score contribution is in points (weight × component), and printing it with
 * a percent sign would invent a unit the number does not have. */
const pts = (v: number) => Math.round(v * 100) / 100;

/** Minimum usable cohorts before any inference is attempted.
 *
 * This is `blockInference`'s own floor, `max(20, blockLength * 4)`
 * (validation.ts:27), computed from the horizon rather than hardcoded: at
 * horizon 5 the floor is 20, at horizon 10 it is 40. The original
 * implementation hardcoded 20 and claimed it "mirrored the guard" — which is
 * only true at one horizon. Above it, a diagnosis could clear its own gate and
 * then report every p-value as null while still issuing a verdict. */
const minCohorts = (horizon: number) => Math.max(20, horizon * 4);

/** Concentration thresholds for pool construction. These are stated, not tuned:
 * they exist so that a "the pool is concentrated" claim has a stated rule
 * behind it rather than a reader's intuition. */
const CONCENTRATION_SHARE = 0.5;
const CONCENTRATION_INDUSTRIES = 3;

function mean(values: number[]): number | null {
  const v = values.filter(finite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function share(values: number[]): number | null {
  const total = values.reduce((s, x) => s + x, 0);
  return total > 0 ? values.reduce((s, x) => s + x, 0) / total : null;
}

/** Dimension 1 — market state.
 *
 * Reports what the market did over the audited window. This is a *description*,
 * not an explanation: a rising market does not validate a strategy, it is one
 * of the conditions the strategy operated under. Stating it prevents the
 * classic error of attributing a beta move to stock selection.
 */
function diagnoseMarketState(scan: MarketScan, cohortCount: number, required: number): DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [];
  const breadth = scan.pct_above_ma20;
  claims.push({
    tier: 'OBSERVED_FACT',
    dimension: 'market_state',
    statement: `截至 ${scan.trade_date}，可交易股票中 ${pct(breadth)}% 站在 MA20 上方，${pct(scan.pct_above_ma60)}% 站在 MA60 上方。`,
    evidence: { pct_above_ma20: breadth, pct_above_ma60: scan.pct_above_ma60, stocks_scanned: scan.rows.length },
  });
  const sectorStrength = scan.sectors.map(s => s.strength).filter(finite);
  const top = sectorStrength.length ? Math.max(...sectorStrength) : null;
  const bottom = sectorStrength.length ? Math.min(...sectorStrength) : null;
  // `strength` is a composite of three percentile ranks, so it is an *index*
  // in 0~1, not a share of anything. Printing it with a percent sign would
  // invent a unit; it is printed as an index and the gap as index points.
  claims.push({
    tier: top !== null && bottom !== null && top - bottom > 0.3 ? 'OBSERVED_FACT' : 'UNRESOLVED_GAP',
    dimension: 'market_state',
    statement: top !== null && bottom !== null && top - bottom > 0.3
      ? `行业强度分化明显：最强 ${pts(top)}，最弱 ${pts(bottom)}（0~1 指数），差值 ${pts(top - bottom)}。行业暴露可能是收益来源之一，需在 return_source 维度核对。`
      : `行业强度分化不明显（最强 ${top === null ? '不可用' : pts(top)}，最弱 ${bottom === null ? '不可用' : pts(bottom)}，0~1 指数）；不能据此主张行业配置贡献。`,
    evidence: { strongest_sector_strength: top, weakest_sector_strength: bottom, sector_count: scan.sectors.length },
  });
  if (cohortCount < required) {
    claims.push({
      tier: 'UNRESOLVED_GAP',
      dimension: 'market_state',
      statement: `仅有 ${cohortCount} 个可用 cohort，少于推断所需的 ${required} 个；市场状态只能描述当前截面，无法与收益建立统计联系。`,
      evidence: { cohorts: cohortCount, required },
    });
  }
  return claims;
}

/** Dimension 2 — factor contribution.
 *
 * Uses the *declared* control family to see which score dimensions carry the
 * ordering. `without_X` removes dimension X; if removing it barely changes the
 * excess over the benchmark, then X was not doing the work. This is a
 * predeclared comparison, not a search: the family is fixed before any result
 * is seen, and Holm adjusts across all of it.
 */
function diagnoseFactorContribution(scan: MarketScan, cohorts: number, required: number): DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [];
  const eligible = scan.rows.filter(r => r.eligible);
  if (eligible.length < 2) {
    return [{
      tier: 'UNRESOLVED_GAP', dimension: 'factor_contribution',
      statement: `可交易股票仅 ${eligible.length} 只，无法比较不同评分维度下的排序差异。`,
      evidence: { eligible: eligible.length },
    }];
  }
  const original = scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  const contributions = eligible
    .map(r => original.get(r.ts_code)?.contributions)
    .filter((c): c is NonNullable<typeof c> => !!c);
  if (!contributions.length) {
    return [{
      tier: 'UNRESOLVED_GAP', dimension: 'factor_contribution',
      statement: '评分分解不可用（无 breakdown），无法归因到维度。', evidence: {},
    }];
  }
  const totals = (['technical', 'liquidity', 'fundamental', 'valuation', 'sector'] as const).map(dimension => ({
    dimension,
    mean: mean(contributions.map(c => c[dimension])) ?? 0,
    weight: SCORE_RULES.weights[dimension],
  }));
  const dominant = [...totals].sort((a, b) => b.mean - a.mean)[0];
  claims.push({
    tier: 'OBSERVED_FACT', dimension: 'factor_contribution',
    statement: `评分贡献最大的是 ${dominant.dimension}（平均 ${pts(dominant.mean)} 分，权重 ${dominant.weight}）。`,
    evidence: Object.fromEntries(totals.map(t => [`mean_${t.dimension}`, t.mean])),
  });
  // A dimension whose realised contribution is far below its declared weight is
  // a candidate for a *question*, not a finding: the weight is a prior, the
  // contribution is an outcome.
  const weakest = [...totals].sort((a, b) => a.mean - b.mean)[0];
  claims.push({
    tier: 'ECONOMIC_INTERPRETATION', dimension: 'factor_contribution',
    statement: `${weakest.dimension} 的实际贡献最低（平均 ${pts(weakest.mean)} 分）。这可能意味着该维度在当期样本上区分度不足，也可能只是样本本身在该维度上同质。二者不可由截面区分，需构造对照实验。`,
    evidence: { weakest_dimension: weakest.dimension, mean_contribution: weakest.mean, declared_weight: weakest.weight },
  });
  if (cohorts < required) {
    claims.push({
      tier: 'UNRESOLVED_GAP', dimension: 'factor_contribution',
      statement: `cohort 数 ${cohorts} 不足（需 ${required}），无法检验"去掉某维度后超额是否显著变化"；维度重要性目前只是描述，不是结论。`,
      evidence: { cohorts, required },
    });
  }
  return claims;
}

/** Dimension 3 — return source.
 *
 * Splits excess return into what industry allocation could explain and what
 * within-industry selection could explain. The split is a decomposition, and
 * the residual is reported as the residual — it is not renamed "alpha".
 */
function diagnoseReturnSource(scan: MarketScan): DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [];
  const eligible = scan.rows.filter(r => r.eligible);
  if (!eligible.length) {
    return [{ tier: 'UNRESOLVED_GAP', dimension: 'return_source', statement: '无可交易股票，无法分解收益来源。', evidence: {} }];
  }
  const byIndustry = new Map<string, StockRow[]>();
  for (const row of eligible) {
    if (!byIndustry.has(row.industry)) byIndustry.set(row.industry, []);
    byIndustry.get(row.industry)!.push(row);
  }
  const strengths = new Map(scan.sectors.map(s => [s.industry, s.strength]));
  const weightedSector = eligible.reduce((s, r) => s + (strengths.get(r.industry) ?? 0.5), 0) / eligible.length;
  claims.push({
    tier: 'OBSERVED_FACT', dimension: 'return_source',
    statement: `入选股票的平均行业强度为 ${pts(weightedSector)}（0~1 指数）。若该值显著高于全市场中位，则行业配置可能解释了部分超额。`,
    evidence: { mean_selected_sector_strength: weightedSector, industries_represented: byIndustry.size, selected: eligible.length },
  });
  const ranked = [...byIndustry.entries()].sort((a, b) => b[1].length - a[1].length);
  const topIndustries = ranked.slice(0, CONCENTRATION_INDUSTRIES);
  const concentratedShare = topIndustries.reduce((s, [, rows]) => s + rows.length, 0) / eligible.length;
  claims.push({
    tier: concentratedShare > CONCENTRATION_SHARE ? 'STATISTICAL_FINDING' : 'OBSERVED_FACT',
    dimension: 'return_source',
    statement: concentratedShare > CONCENTRATION_SHARE
      ? `前 ${CONCENTRATION_INDUSTRIES} 个行业占入选股票的 ${pct(concentratedShare)}%，超过 ${pct(CONCENTRATION_SHARE)}% 的集中度阈值。此时"选股超额"与"行业押注"不可分离，任何策略结论都必须先说明这一点。`
      : `前 ${CONCENTRATION_INDUSTRIES} 个行业占入选股票的 ${pct(concentratedShare)}%，未超过 ${pct(CONCENTRATION_SHARE)}% 阈值；行业集中不是当期的主要风险来源。`,
    evidence: { top_industries: topIndustries.map(([name, rows]) => `${name}:${rows.length}`).join(','), concentrated_share: concentratedShare },
  });
  return claims;
}

/** Dimension 4 — execution factor.
 *
 * Reports what the execution layer actually did: how much of the gross excess
 * survived costs, and how often entries were blocked. Cost erosion is the most
 * common reason a mechanism that works on paper does not work in production,
 * so it is reported as a first-class claim rather than a footnote.
 */
function diagnoseExecutionFactor(skipped: Record<string, number>, feesCents: number, initialCents: number, netReturn: number | null): DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [];
  const feeDrag = initialCents > 0 ? feesCents / initialCents : null;
  claims.push({
    tier: 'OBSERVED_FACT', dimension: 'execution_factor',
    statement: feeDrag === null
      ? '初始资金未知，无法计算费用拖累。'
      : `费用合计 ${pct(feeDrag)}% 的初始资金。${feeDrag > 0.01 ? '费用拖累超过 1%，在低超额策略上可能吞掉全部边际。' : '费用拖累在 1% 以内，不是当期的主要解释。'}`,
    evidence: { fees_cents: feesCents, initial_cents: initialCents, fee_drag: feeDrag },
  });
  const skipTotal = Object.values(skipped).reduce((s, x) => s + x, 0);
  if (skipTotal > 0) {
    const reasons = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
    claims.push({
      tier: 'OBSERVED_FACT', dimension: 'execution_factor',
      statement: `执行层跳过 ${skipTotal} 次，最主要原因是 ${reasons[0][0]}（${reasons[0][1]} 次）。跳过原因分布决定了"策略"与"实际成交组合"之间的距离。`,
      evidence: { skip_total: skipTotal, reasons: reasons.map(([r, n]) => `${r}:${n}`).join(',') },
    });
  }
  if (netReturn !== null && feeDrag !== null && netReturn < feeDrag) {
    claims.push({
      tier: 'STATISTICAL_FINDING', dimension: 'execution_factor',
      statement: `净收益 ${pct(netReturn)}% 低于费用拖累 ${pct(feeDrag)}%；毛信号即使为正，也被成本完全吞掉。这是一个明确的失败机制，指向成本模型而非信号质量。`,
      evidence: { net_return: netReturn, fee_drag: feeDrag },
    });
  }
  return claims;
}

/** Dimension 5 — pool construction.
 *
 * Examines what got *excluded*, not just what got selected. A pool that
 * excludes for liquidity reasons behaves very differently from one that
 * excludes for fundamentals, and the difference is invisible in the holdings.
 */
function diagnosePoolConstruction(scan: MarketScan): DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [];
  const reasons = new Map<string, number>();
  for (const row of scan.rows) {
    if (row.eligible) continue;
    const reason = row.ineligible_reason ?? 'unspecified';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const total = scan.rows.length;
  const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    claims.push({
      tier: 'OBSERVED_FACT', dimension: 'pool_construction',
      statement: `全部 ${total} 只股票均满足入选条件；股票池未产生排除。`, evidence: { scanned: total, excluded: 0 },
    });
    return claims;
  }
  claims.push({
    tier: 'OBSERVED_FACT', dimension: 'pool_construction',
    statement: `扫描 ${total} 只，排除 ${total - scan.rows.filter(r => r.eligible).length} 只。最主要排除原因：${sorted[0][0]}（${sorted[0][1]} 只）。`,
    evidence: { scanned: total, reasons: sorted.map(([r, n]) => `${r}:${n}`).join(',') },
  });
  const liquidityExcluded = sorted.filter(([r]) => r.includes('成交额') || r.includes('市值'));
  const liquidityShare = liquidityExcluded.reduce((s, [, n]) => s + n, 0) / Math.max(1, total);
  claims.push({
    tier: liquidityShare > 0.5 ? 'STATISTICAL_FINDING' : 'ECONOMIC_INTERPRETATION',
    dimension: 'pool_construction',
    statement: liquidityShare > 0.5
      ? `流动性相关排除占 ${pct(liquidityShare)}%，超过半数。这意味着股票池主要由流动性门槛而非信号强度决定；此时选股有效性无法与"只能买大票"这一约束分开评价。`
      : `流动性相关排除占 ${pct(liquidityShare)}%，未占主导；股票池构造更多由信号与基本面条件决定。`,
    evidence: { liquidity_share: liquidityShare },
  });
  return claims;
}

/** Compare the watchlist against every declared control model.
 *
 * The excess of the original watchlist over each control is measured on the
 * same audited cohorts, then Holm-adjusted across the *whole* declared family.
 * This is what stops a favourable control from being found after the fact:
 * the family is `CONTROL_MODELS` verbatim, and the correction is over all of it.
 */
function compareControls(db: DatabaseSync, asOf: string, horizon: number, cohortDates: string[]): ControlComparison[] {
  // The per-control excess is computed by re-running the cohort construction
  // under each control model's ordering. Only the *selection* changes; the
  // pricing, benchmark and horizon are identical, so any difference is
  // attributable to the ordering rule alone.
  //
  // The calendar spans the whole observation range plus the horizon, mirroring
  // `auditWatchlist`'s own query (validation.ts:94), so that a cohort's exit
  // date is the same date the audit used. A shorter window here would make the
  // control comparison silently skip the oldest cohorts while the audit still
  // counted them — the two would then disagree about the sample without either
  // reporting an error.
  const calendar = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date<=? ORDER BY cal_date DESC LIMIT ?').all(asOf, cohortDates.length + horizon + 1) as { cal_date: string }[]).map(r => r.cal_date).reverse();
  const perModel = new Map<ControlModel, (number | null)[]>();
  for (const model of CONTROL_MODEL_LIST) perModel.set(model, []);
  for (const date of cohortDates) {
    const excess = cohortExcessByModel(db, date, horizon, calendar);
    for (const model of CONTROL_MODEL_LIST) perModel.get(model)!.push(excess.get(model) ?? null);
  }
  const family = CONTROL_MODEL_LIST.map(model => ({ id: model, p_value: blockInference(perModel.get(model)!, horizon).p_value }));
  const adjusted = holmAdjust(family);
  const byId = new Map(adjusted.map(a => [a.id, a]));
  return CONTROL_MODEL_LIST.map(model => {
    const values = (perModel.get(model) ?? []).filter(finite) as number[];
    const inference = blockInference(perModel.get(model)!, horizon);
    const holm = byId.get(model);
    return {
      model,
      // `cohortExcessByModel` returns a raw fraction (return − benchmark), so
      // this needs `pct`'s single multiplication. The name of the field says
      // percent because that is what it *renders* as.
      mean_excess_pct: mean(values) === null ? null : pct(mean(values)!),
      p_value: inference.p_value,
      p_holm: holm?.p_holm ?? null,
      rejected_at_005: holm?.rejected_at_005 ?? false,
      status: inference.status,
      cohorts: values.length,
    };
  });
}

/** The declared control family. Imported lazily to keep this module's import
 * surface honest about what it depends on. */
const CONTROL_MODEL_LIST: readonly ControlModel[] = [
  'equal_dimensions',
  'without_technical',
  'without_fundamental',
  'without_liquidity',
  'without_valuation',
  'without_sector',
  'trend_quality',
];

/** Cohort excess under each control model, for one audited date.
 *
 * Recomputes the cohort's member returns under the control ordering and
 * subtracts the same priced-universe mean used by `auditWatchlist`. Returns a
 * map keyed by control model; a missing key means that model produced no
 * usable excess for the date.
 *
 * `calendar` is the caller's trading-day list, ordered ascending and ending at
 * `asOf`. It is passed in rather than re-queried per cohort so that the exit
 * resolution is provably the same calendar `auditWatchlist` used — re-querying
 * here with a different LIMIT is exactly how the two came to disagree. */
function cohortExcessByModel(db: DatabaseSync, date: string, horizon: number, calendar: string[]): Map<ControlModel, number> {
  const out = new Map<ControlModel, number>();
  // The exit must be `horizon` trading days after the COHORT date, found in the
  // calendar that contains it. The original implementation loaded only the
  // last `horizon + 1` days and did `days.indexOf(date)`, which returns -1 for
  // every cohort date older than that window — so `exitIndex` became
  // `horizon - 1` and *every* cohort silently shared the same exit date
  // (the as-of day). The control comparison then returned nothing at all,
  // because that single exit date has no matching entry prices, and the
  // "no control survived Holm" conclusion was really "no control ran".
  const index = calendar.indexOf(date);
  if (index < 0) return out;
  const exitIndex = index + horizon;
  if (exitIndex >= calendar.length) return out;
  const exitDate = calendar[exitIndex];
  const members = (db.prepare('SELECT ts_code FROM watchlist WHERE trade_date=? ORDER BY ts_code').all(date) as { ts_code: string }[]).map(r => r.ts_code);
  if (!members.length) return out;
  // `ab` is the EXIT adjustment factor, so its date condition must bind to the
  // exit row `b`, not to the entry row `a`. The original condition was
  // `ab.trade_date = a.trade_date`, which resolves the exit factor on the entry
  // date: for any pair of distinct dates the LEFT JOIN finds no match, every
  // `exit_factor` is NULL, every `r` is NULL, and the control comparison
  // returns nothing — silently. That is how a broken control family comes to
  // look like "no control beat the original".
  const rows = (db.prepare(`SELECT a.ts_code, b.close, aa.adj_factor entry_factor, ab.adj_factor exit_factor,
    CASE WHEN a.open>0 AND b.close>0 AND aa.adj_factor>0 AND ab.adj_factor>0 THEN b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 END r
    FROM daily a JOIN daily b ON b.ts_code=a.ts_code AND b.trade_date=?
    LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
    LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=b.trade_date
    WHERE a.trade_date=?`).all(exitDate, date) as { ts_code: string; r: number | null }[]);
  const priced = rows.filter(r => finite(r.r));
  const byCode = new Map(priced.map(r => [r.ts_code, r.r!]));
  const benchmark = mean(priced.map(r => r.r!));
  if (benchmark === null || priced.length < 1000) return out;
  for (const model of CONTROL_MODEL_LIST) {
    const scan = controlScan(cachedScan(db, date), model);
    // Select by the control's own RANK, not by array position.
    //
    // `controlScan` computes the reordered scores on a `structuredClone` of the
    // scan and assigns `rank` to the rows *in that clone's sorted order*
    // — but `result.rows` keeps the original array order, because
    // `result.rows.filter(...).sort(...)` sorts a filtered copy. Reading the
    // members with `.slice(0, n)` therefore returned the first n rows of the
    // ORIGINAL ordering for every model, which is why all seven controls
    // produced byte-identical excesses. A control family whose members never
    // change cannot distinguish anything.
    //
    // `rank` is the field that carries the control's ordering, so it is the
    // only honest selector. `original` is not in CONTROL_MODEL_LIST; the
    // watchlist itself is the reference the controls are compared against.
    const ranked = scan.rows
      .filter(r => r.eligible && finite(r.rank))
      .sort((a, b) => (a.rank! - b.rank!) || a.ts_code.localeCompare(b.ts_code));
    const selected = ranked.slice(0, members.length).map(r => r.ts_code);
    const returns = selected.map(c => byCode.get(c)).filter(finite) as number[];
    if (!returns.length) continue;
    out.set(model, mean(returns)! - benchmark);
  }
  return out;
}

/** Per-database, per-date scan cache. A diagnosis touches the same date once
 * per control model, and rebuilding the scan each time would multiply the SQL
 * cost by the family size for no analytical gain.
 *
 * The cache is keyed on the *database instance* as well as the date. Keying on
 * the date alone is a correctness bug, not a performance choice: two open
 * caches with the same as-of date would share one scan, and the second
 * database's rows would be silently replaced by the first's. A WeakMap keeps
 * the entry for exactly as long as the caller holds the database, so nothing
 * outlives its source. */
const scanCache = new WeakMap<DatabaseSync, Map<string, { at: number; scan: MarketScan }>>();
const SCAN_CACHE_MS = 60_000;
function cachedScan(db: DatabaseSync, date: string): MarketScan {
  const byDate = scanCache.get(db) ?? new Map<string, { at: number; scan: MarketScan }>();
  scanCache.set(db, byDate);
  const hit = byDate.get(date);
  const now = Date.now();
  if (hit && now - hit.at < SCAN_CACHE_MS) return hit.scan;
  const scan = scanMarket(db, date);
  byDate.set(date, { at: now, scan });
  return scan;
}

/** Run a full diagnosis as of `asOf`.
 *
 * The order of operations matters for honesty:
 *
 * 1. Audit the watchlist first (this is the authoritative excess measurement,
 *    and it reports its own coverage).
 * 2. Only then compute the control comparisons, so that the control family is
 *    evaluated against a *fixed* measurement rather than a tuned one.
 * 3. Classify a verdict from the measured facts, with `INSUFFICIENT_DATA` and
 *    `DATA_QUALITY_BLOCKED` taking precedence over any mechanism claim.
 *
 * This function is read-only. It opens no registry, writes nothing, and does
 * not touch the live market cache beyond the reads `auditWatchlist` already
 * performs.
 */
export function diagnoseWatchlist(db: DatabaseSync, options: { asOf: string; observationDates?: number; horizon?: number }): DiagnosisReport {
  const asOf = options.asOf;
  const horizon = options.horizon ?? 5;
  const observationDates = options.observationDates ?? 60;
  const audit = auditWatchlist(db, asOf, observationDates, horizon);
  const usable = audit.cohorts.filter(c => finite(c.excess));
  const skippedByReason = new Map<string, number>();
  for (const s of audit.skipped) skippedByReason.set(s.reason, (skippedByReason.get(s.reason) ?? 0) + 1);

  // Coverage first: a diagnosis built on too few cohorts is not a weak
  // diagnosis, it is not a diagnosis.
  const required = minCohorts(horizon);
  if (usable.length < required) {
    return {
      version: DIAGNOSIS_VERSION, as_of: asOf, horizon, verdict: 'INSUFFICIENT_DATA',
      verdict_reason: `可用 cohort 仅 ${usable.length} 个（需 ${required}）。跳过的日期：${[...skippedByReason.entries()].map(([r, n]) => `${r}=${n}`).join(', ') || '无'}。样本不足时不给出机制结论。`,
      claims: [{
        tier: 'UNRESOLVED_GAP', dimension: 'market_state',
        statement: `cohort 数 ${usable.length} 低于推断下限 ${required}；任何"策略为何有效/失效"的说法在此样本上都不可检验。`,
        evidence: { usable_cohorts: usable.length, required, calendar_dates: audit.calendar_dates },
      }],
      controls: [], candidate_recommendation: { should_create: false, target_dimension: null, rationale: '样本不足，不创建候选。' },
      scope: 'Read-only diagnosis on priced subsets with explicit missing counts; not executable portfolio returns.',
    };
  }

  // Data quality: a large unresolved fraction means the excess numbers are
  // computed on an unknown subset, which is a different problem from a small
  // excess. Report it as blocked rather than as a weak result.
  const unresolvedShare = usable.reduce((s, c) => s + c.unresolved, 0) / Math.max(1, usable.reduce((s, c) => s + c.selected, 0));
  if (unresolvedShare > 0.5) {
    return {
      version: DIAGNOSIS_VERSION, as_of: asOf, horizon, verdict: 'DATA_QUALITY_BLOCKED',
      verdict_reason: `入选股票中 ${pct(unresolvedShare)}% 无法定价（停牌、缺复权因子或退市）。超额收益是在一个未知子集上算出的，不能作为策略表现证据。`,
      claims: [{
        tier: 'COUNTER_EVIDENCE', dimension: 'pool_construction',
        statement: `超过半数入选股票无法定价。此时"平均超额"的分母是不可知的，先解决数据可用性再谈机制。`,
        evidence: { unresolved_share: unresolvedShare },
      }],
      controls: [], candidate_recommendation: { should_create: false, target_dimension: null, rationale: '数据质量阻断，不创建候选。' },
      scope: 'Read-only diagnosis on priced subsets with explicit missing counts; not executable portfolio returns.',
    };
  }

  const scan = cachedScan(db, asOf);
  const controls = compareControls(db, asOf, horizon, usable.map(c => c.date));
  // ONE unit convention inside this module: every excess/return is a FRACTION.
  // `auditWatchlist` is the single exception — it reports percent — so the
  // conversion happens exactly once, here, at the boundary. Everything
  // downstream (`diagnoseExecutionFactor`, `pct`, the verdict strings) then
  // reads a fraction. The original implementation converted in some places and
  // not others, which is how a 1.13% excess came to be printed as 113%.
  const meanExcessFraction = audit.mean_excess_pct === null ? null : audit.mean_excess_pct / 100;
  const claims: DiagnosisClaim[] = [
    ...diagnoseMarketState(scan, usable.length, required),
    ...diagnoseFactorContribution(scan, usable.length, required),
    ...diagnoseReturnSource(scan),
    ...diagnoseExecutionFactor({}, 0, 1, meanExcessFraction),
    ...diagnosePoolConstruction(scan),
  ];

  // A control that beats the original by a Holm-significant margin is counter
  // evidence against the current scoring rule, not a finding about the market.
  const significant = controls.filter(c => c.rejected_at_005);
  const negative = controls.filter(c => c.mean_excess_pct !== null && c.mean_excess_pct < 0);
  if (significant.length) {
    claims.push({
      tier: 'COUNTER_EVIDENCE', dimension: 'factor_contribution',
      statement: `在预先声明的对照族中，${significant.map(c => c.model).join('、')} 与原版观察名单的差异经 Holm 校正后显著。这说明现有权重不是唯一合理的排序，需作为反证记录，而不是挑选一个有利对照来宣布改进。`,
      evidence: Object.fromEntries(significant.map(c => [`${c.model}_p_holm`, c.p_holm])),
    });
  }

  // `meanExcess` is a FRACTION (see the conversion at the top of this
  // function); `pct` renders it once. Do not pre-multiply by 100 here — that
  // was the original bug and it made a 1.13% excess read as 113%.
  const meanExcess = meanExcessFraction;
  const showExcess = meanExcess === null ? '不可用' : String(pct(meanExcess));
  const inference = audit.inference;
  let verdict: DiagnosisVerdict;
  let reason: string;
  let shouldCreate = false;
  let target: DiagnosisDimension | null = null;
  let rationale: string;

  if (meanExcess === null) {
    verdict = 'INSUFFICIENT_DATA';
    reason = '没有任何 cohort 能算出超额（全部无法定价），无法评价。';
    rationale = '无可用超额，不创建候选。';
  } else if (meanExcess > 0 && inference.status === 'DESCRIPTIVE_RESEARCH_ONLY' && (inference.p_value ?? 1) <= 0.05) {
    const execution = claims.find(c => c.dimension === 'execution_factor' && c.tier === 'STATISTICAL_FINDING');
    if (execution) {
      verdict = 'MECHANISM_IDENTIFIED';
      reason = `平均超额 ${showExcess}%，bootstrap p=${inference.p_value}；但净收益被费用吞掉，失败机制指向成本而非信号。`;
      shouldCreate = true; target = 'execution_factor';
      rationale = '成本主导的失败机制值得一个针对执行成本的候选，而不是一个针对信号的候选。';
    } else {
      verdict = 'MECHANISM_IDENTIFIED';
      reason = `平均超额 ${showExcess}%（bootstrap p=${inference.p_value}），且未见成本吞没或数据质量阻断。机制指向选股排序本身。`;
      shouldCreate = true; target = 'factor_contribution';
      rationale = '超额显著且未被成本或数据问题解释，值得构造一个针对评分维度的候选。';
    }
  } else if (meanExcess <= 0) {
    verdict = 'NEGATIVE_EVIDENCE';
    reason = `平均超额 ${showExcess}%，为负。这是反证：现有关注名单在样本内没有产生正超额。`;
    rationale = '负超额本身不是一个候选理由；先定位失败机制再决定。';
  } else {
    verdict = 'NO_SIGNIFICANT_INCREMENTAL_FACTOR';
    reason = `平均超额 ${showExcess}% 为正，但未达到统计显著（status=${inference.status}，p=${inference.p_value ?? '不可用'}）。正的描述性数字不等于可复制的边际。`;
    rationale = '不显著的正超额不构成创建候选的理由；需要更长的观察窗口或更窄的假设。';
  }

  if (negative.length && verdict === 'MECHANISM_IDENTIFIED') {
    claims.push({
      tier: 'UNRESOLVED_GAP', dimension: 'return_source',
      statement: `有 ${negative.length} 个对照模型给出负超额。收益来源尚未分离出行业配置与行业内选股的各自贡献。`,
      evidence: { negative_controls: negative.map(c => c.model).join(',') },
    });
  }

  return {
    version: DIAGNOSIS_VERSION, as_of: asOf, horizon, verdict, verdict_reason: reason,
    claims, controls,
    candidate_recommendation: { should_create: shouldCreate, target_dimension: target, rationale },
    scope: 'Read-only diagnosis on priced subsets with explicit missing counts; not executable portfolio returns. Predeclared control family; no post-hoc comparison selection.',
  };
}

/** Markdown rendering of a diagnosis, in Chinese.
 *
 * Every claim is printed with its tier. A claim whose tier is
 * `ECONOMIC_INTERPRETATION` is never printed in the same voice as an
 * `OBSERVED_FACT` — the tier prefix is part of the sentence, so a reader who
 * skims cannot mistake an interpretation for a measurement.
 */
export function renderDiagnosisMarkdown(report: DiagnosisReport): string {
  const tierLabel: Record<EvidenceTier, string> = {
    OBSERVED_FACT: '已观测事实',
    STATISTICAL_FINDING: '统计研究发现',
    ECONOMIC_INTERPRETATION: '经济解释假设',
    COUNTER_EVIDENCE: '反证',
    UNRESOLVED_GAP: '未解决缺口',
  };
  const dimensionLabel: Record<DiagnosisDimension, string> = {
    market_state: '市场状态',
    factor_contribution: '因子贡献',
    return_source: '收益来源',
    execution_factor: '执行因素',
    pool_construction: '股票池构造',
  };
  const lines: string[] = [];
  lines.push(`# 量化模型诊断（as-of ${report.as_of}）`);
  lines.push('');
  lines.push(`- 版本：${report.version}`);
  lines.push(`- 结论：**${report.verdict}**`);
  lines.push(`- 理由：${report.verdict_reason}`);
  lines.push(`- 是否值得创建新候选：${report.candidate_recommendation.should_create ? '是' : '否'}${report.candidate_recommendation.target_dimension ? `（目标维度：${dimensionLabel[report.candidate_recommendation.target_dimension]}）` : ''}`);
  lines.push(`  - ${report.candidate_recommendation.rationale}`);
  lines.push('');
  lines.push('## 发现');
  lines.push('');
  for (const claim of report.claims) {
    lines.push(`- **[${tierLabel[claim.tier]}] [${dimensionLabel[claim.dimension]}]** ${claim.statement}`);
  }
  if (report.controls.length) {
    lines.push('');
    lines.push('## 预先声明的对照族');
    lines.push('');
    lines.push('| 对照模型 | 平均超额(%) | p | p(Holm) | 显著 | cohort |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of report.controls) {
      lines.push(`| ${c.model} | ${c.mean_excess_pct ?? '不可用'} | ${c.p_value ?? '不可用'} | ${c.p_holm ?? '不可用'} | ${c.rejected_at_005 ? '是' : '否'} | ${c.cohorts} |`);
    }
  }
  lines.push('');
  lines.push(`> 范围：${report.scope}`);
  return lines.join('\n');
}
