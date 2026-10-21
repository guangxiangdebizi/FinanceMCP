import type { DatabaseSync } from 'node:sqlite';
import { verifyResearchEvidence, type VerifyEvidenceResult } from './evidence.js';

export interface TrustedStrategy { strategy_id: string; source: string; rule_version: string }
export interface TrustedEvidencePolicy { requireProvenance: true; strategies: TrustedStrategy[] }

/** Deployment configuration only. Tool argument mappers never read a client policy. */
export function trustedEvidencePolicy(): TrustedEvidencePolicy {
  const raw = process.env.ASHARE_RESEARCH_TRUSTED_STRATEGIES;
  if (!raw?.trim()) return { requireProvenance: true, strategies: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Trusted research strategies must be an array');
  const strategies = parsed.map((row: any) => {
    if (!row || !['strategy_id', 'source', 'rule_version'].every(key => typeof row[key] === 'string' && row[key].trim())) throw new Error('Trusted strategy requires strategy_id, source and rule_version');
    return { strategy_id: row.strategy_id.trim(), source: row.source.trim(), rule_version: row.rule_version.trim() };
  });
  if (new Set(strategies.map(row => row.strategy_id)).size !== strategies.length) throw new Error('Trusted strategy ids must be unique');
  return { requireProvenance: true, strategies };
}

export function verifyTrustedRotation(
  db: DatabaseSync | null | undefined,
  input: { evidence_id?: string | null; claim: string; buyCode: string; sellCode?: string | null; asOf: string },
  policy: TrustedEvidencePolicy,
): VerifyEvidenceResult {
  const base = verifyResearchEvidence(db, { evidence_id: input.evidence_id }, {
    buyCode: input.buyCode, sellCode: input.sellCode, asOf: input.asOf,
    expectedKind: 'ROTATION', requireProvenance: true, expectedClaim: input.claim,
  });
  if (!base.verified || !base.record) return base;
  const strategy = policy.strategies.find(row => row.strategy_id === base.record!.strategy_id);
  if (!strategy) return { ...base, verified: false, reason: 'evidence_provenance_mismatch', detail: 'Research strategy is not registered in trusted deployment configuration' };
  return verifyResearchEvidence(db, { evidence_id: input.evidence_id }, {
    buyCode: input.buyCode, sellCode: input.sellCode, asOf: input.asOf,
    expectedKind: 'ROTATION', requireProvenance: true, expectedClaim: input.claim,
    expectedStrategyId: strategy.strategy_id, expectedSource: strategy.source, expectedRuleVersion: strategy.rule_version,
  });
}
