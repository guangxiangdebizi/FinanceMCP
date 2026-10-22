/**
 * Immutable, versioned benchmark definitions.
 *
 * A published version is never edited: a change of weights, fees, adjustment or rebalancing needs a new
 * version entry plus a new approval record. Older versions stay readable so earlier research records
 * can be reproduced against the definition they were produced with.
 */

export type BasketApprovalStatus = 'provisional_pending_user_approval' | 'approved';

export interface BasketDefinition {
  version: string;
  status: BasketApprovalStatus;
  /** YYYYMMDD of the user's approval; null while provisional. */
  approved_on: string | null;
  approval_source: string | null;
  supersedes: string | null;
  weights: Readonly<Record<string, number>>;
  asset_class: Readonly<Record<string, 'equity' | 'bond' | 'gold' | 'cross_border'>>;
  /** Fixed conventions that are part of the definition, not tunables. */
  conventions: {
    initial_capital_cents: number;
    fees: string;
    adjustment: string;
    rebalancing: string;
    cash: string;
  };
}

const CLASSES = Object.freeze({
  '510300.SH': 'equity', '511010.SH': 'bond', '518880.SH': 'gold', '513100.SH': 'cross_border',
} as const);

const CONVENTIONS = Object.freeze({
  initial_capital_cents: 1_000_000, // 10,000 yuan notional, used only for normalisation
  fees: 'One-off entry cost per leg from the shared fee engine (fees.ts) resolved at the window start; no later trading, so no further fees.',
  adjustment: 'qfq with the last factor in the window as base; a missing factor series is disclosed as raw_close_no_adj_factor, never mixed.',
  rebalancing: 'No rebalancing inside the window; weights apply only at the start and are not re-set by price drift.',
  cash: 'Whole-lot rounding remainder stays as zero-return cash; no inflows, outflows or dividend reinvestment beyond the adjustment factor.',
});

export const BASKET_DEFINITIONS: readonly BasketDefinition[] = Object.freeze([
  Object.freeze({
    version: 'r2-benchmarks-1.0.0', status: 'provisional_pending_user_approval' as const, approved_on: null,
    approval_source: null, supersedes: null,
    weights: Object.freeze({ '510300.SH': 0.40, '511010.SH': 0.25, '518880.SH': 0.15, '513100.SH': 0.20 }),
    asset_class: CLASSES, conventions: CONVENTIONS,
  }),
  Object.freeze({
    version: 'r2-benchmarks-1.1.0', status: 'approved' as const, approved_on: '20261022',
    approval_source: 'user decision recorded 2026-10-22 (investment research V1.1 goal, section 3)',
    supersedes: 'r2-benchmarks-1.0.0',
    weights: Object.freeze({ '510300.SH': 0.40, '511010.SH': 0.25, '518880.SH': 0.15, '513100.SH': 0.20 }),
    asset_class: CLASSES, conventions: CONVENTIONS,
  }),
]);

export const CURRENT_BASKET_VERSION = 'r2-benchmarks-1.1.0';

export function basketDefinition(version: string = CURRENT_BASKET_VERSION): BasketDefinition {
  const found = BASKET_DEFINITIONS.find(item => item.version === version);
  if (!found) throw new Error(`Unknown benchmark definition version ${version}`);
  return found;
}

export const BASKET_CODES: readonly string[] = Object.freeze(Object.keys(basketDefinition().weights));
