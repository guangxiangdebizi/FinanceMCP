import type { SignalVerdict } from './evidence.js';
import type { ValidationType } from './validation.js';

/**
 * Evidence tiers for research claims (goal §六.F). Pure classification, no I/O.
 * - RESEARCH_SUPPORTED means historical research support only.
 * - OUT_OF_SAMPLE_VALIDATED is reachable only through TRUE_FORWARD_OBSERVATION: retrospective
 *   holdouts and walk-forward replays run on history that may already have been observed.
 *   It never implies future profit.
 * Legacy `classification` values stay in reports untouched; this maps them without rewriting.
 */
export const EVIDENCE_TIERS = ['UNVERIFIED', 'RESEARCH_SUPPORTED', 'OUT_OF_SAMPLE_VALIDATED', 'REJECTED'] as const;
export type EvidenceTier = typeof EVIDENCE_TIERS[number];

export const OOS_MIN_INDEPENDENT_DATES = 60;
export const OOS_ALPHA = 0.05;

export function legacyEvidenceTier(classification: SignalVerdict['classification']): EvidenceTier {
  if (classification === 'evidence_supported') return 'RESEARCH_SUPPORTED';
  if (classification === 'contradicted') return 'REJECTED';
  return 'UNVERIFIED';
}

export interface OutOfSampleEvidence {
  type: ValidationType;
  freeze_id: string | null;
  rule_version: string | null;
  implementation_hash: string | null;
  range: { start: string; end: string } | null;
  independent_dates: number;
  /** After costs, decimal, in the direction the claim asserts. */
  mean_net_excess: number | null;
  ci95: [number, number] | null;
  /** Holm-adjusted over the predeclared family. */
  p_holm: number | null;
}

export function classifyEvidenceTier(input: { legacy?: SignalVerdict['classification'] | null; out_of_sample?: OutOfSampleEvidence | null }):
  { tier: EvidenceTier; reasons: string[] } {
  const base = input.legacy ? legacyEvidenceTier(input.legacy) : 'UNVERIFIED';
  const oos = input.out_of_sample;
  if (!oos) return { tier: base, reasons: [base === 'UNVERIFIED' ? 'no_out_of_sample_evidence' : 'in_sample_only'] };
  const reasons: string[] = [];
  if (oos.type !== 'TRUE_FORWARD_OBSERVATION') reasons.push(`${oos.type}_cannot_establish_out_of_sample`);
  if (!oos.freeze_id || !oos.rule_version || !oos.implementation_hash) reasons.push('fixed_rule_version_missing');
  if (!oos.range || oos.range.start > oos.range.end) reasons.push('time_range_missing');
  if (!(oos.independent_dates >= OOS_MIN_INDEPENDENT_DATES)) reasons.push('insufficient_independent_dates');
  if (!oos.ci95 || oos.mean_net_excess === null || oos.p_holm === null) reasons.push('robust_statistics_unavailable');
  if (reasons.length) return { tier: base, reasons };
  const [low, high] = oos.ci95!;
  if (oos.p_holm! <= OOS_ALPHA && low > 0 && oos.mean_net_excess! > 0) return { tier: 'OUT_OF_SAMPLE_VALIDATED', reasons: [] };
  if (oos.p_holm! <= OOS_ALPHA && high < 0 && oos.mean_net_excess! < 0) return { tier: 'REJECTED', reasons: ['significantly_negative_forward_net_excess'] };
  return { tier: base, reasons: ['forward_evidence_not_significant_after_adjustment'] };
}
