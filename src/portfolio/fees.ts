import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DEFAULT_FEE_RULES, DEFAULT_STOCK_RULES, FEE_RULE_VERSION, type FeeRules } from './rules.js';

export type FeeEvidence = 'CONFIRMED' | 'PUBLIC_REFERENCE' | 'ASSUMED' | 'UNKNOWN';
export type FeeClass = 'STOCK' | 'NORMAL_ETF' | 'SUPER_ETF' | 'OTHER_ETF';
export type FeeField = 'commission_rate' | 'commission_min_cents' | 'transfer_fee_rate' | 'stamp_duty_rate' | 'slippage_rate_per_side';
export interface FeeFieldEvidence { level: FeeEvidence; source: string; evidence_id?: string }
export interface FeeProfile {
  id: string;
  account_id?: string;
  broker_id?: string;
  code?: string;
  classification?: FeeClass;
  effective_from: string;
  effective_until?: string;
  values: Partial<Record<FeeField, number | null>>;
  evidence: Partial<Record<FeeField, FeeFieldEvidence>>;
  /** Unobserved billing details remain UNKNOWN, independently of the rate. */
  minimum_billing_unit?: 'UNKNOWN' | 'NONE';
  aggregation?: 'UNKNOWN' | 'ORDER' | 'FILL';
  rounding?: 'UNKNOWN' | 'HALF_UP_CENT';
  regulatory_fees_included?: 'UNKNOWN' | 'YES' | 'NO';
}
export interface FeeContext { accountId?: string; brokerId?: string; asOf: string; profiles: FeeProfile[] }
export interface FeeResolution {
  version: string;
  classification: FeeClass;
  profile_ids: string[];
  evidence: Record<FeeField, FeeFieldEvidence>;
  estimated: boolean;
  aggregation: 'UNKNOWN' | 'ORDER' | 'FILL';
  rounding: 'UNKNOWN' | 'HALF_UP_CENT';
  minimum_billing_unit: 'UNKNOWN' | 'NONE';
  regulatory_fees_included: 'UNKNOWN' | 'YES' | 'NO';
}
export interface FeeBreakdown {
  commission_cents: number;
  transfer_fee_cents: number;
  stamp_duty_cents: number;
  slippage_estimate_cents: number;
  /** Estimated statutory/broker costs; slippage is excluded. */
  actual_fee_estimate_cents?: number;
  total_cents: number;
  assumed: boolean;
  fee_model?: FeeResolution;
}
const FIELDS: FeeField[] = ['commission_rate', 'commission_min_cents', 'transfer_fee_rate', 'stamp_duty_rate', 'slippage_rate_per_side'];
const CLASSES: FeeClass[] = ['STOCK', 'NORMAL_ETF', 'SUPER_ETF', 'OTHER_ETF'];
const LEVELS: FeeEvidence[] = ['CONFIRMED', 'PUBLIC_REFERENCE', 'ASSUMED', 'UNKNOWN'];
const DATE = /^\d{8}$/;
const keyFor = (accountId: string) => `fee_profiles:${accountId}`;

export function validateFeeProfile(profile: FeeProfile): FeeProfile {
  if (!profile || !profile.id?.trim() || !DATE.test(profile.effective_from)) throw new Error('Fee profile requires id and effective_from YYYYMMDD');
  if (profile.effective_until && (!DATE.test(profile.effective_until) || profile.effective_until < profile.effective_from)) throw new Error('Invalid fee effective_until');
  if (profile.classification && !CLASSES.includes(profile.classification)) throw new Error('Unknown fee classification');
  if (profile.code && !/^\d{6}\.(SH|SZ|BJ)$/.test(profile.code)) throw new Error('Fee code requires exchange suffix');
  if (profile.classification === 'SUPER_ETF' && profile.code && !/^[15]/.test(profile.code)) throw new Error('SUPER_ETF code must identify an ETF');
  if (!profile.code && !profile.classification) throw new Error('Fee profile requires code or classification');
  if (profile.code && profile.classification && (profile.classification === 'STOCK') === /^[15]/.test(profile.code)) throw new Error('Fee classification disagrees with security kind');
  if (!profile.values || !profile.evidence) throw new Error('Fee values and field evidence are required');
  for (const field of Object.keys(profile.values)) {
    if (!FIELDS.includes(field as FeeField)) throw new Error(`Unknown fee field ${field}`);
    const value = profile.values[field as FeeField];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (field === 'commission_min_cents' ? !Number.isSafeInteger(value) : value > 1))) throw new Error(`Invalid fee value ${field}`);
    const evidence = profile.evidence[field as FeeField];
    if (!evidence || !LEVELS.includes(evidence.level) || !evidence.source?.trim()) throw new Error(`Field evidence required: ${field}`);
    if (value === null && evidence.level !== 'UNKNOWN') throw new Error(`Null fee must be UNKNOWN: ${field}`);
    if (field === 'slippage_rate_per_side' && evidence.level === 'CONFIRMED') throw new Error('Slippage is an estimate, never a confirmed broker fee');
  }
  for (const [field, choices] of Object.entries({ aggregation: ['UNKNOWN', 'ORDER', 'FILL'], rounding: ['UNKNOWN', 'HALF_UP_CENT'], minimum_billing_unit: ['UNKNOWN', 'NONE'], regulatory_fees_included: ['UNKNOWN', 'YES', 'NO'] })) {
    if ((profile as any)[field] !== undefined && !choices.includes((profile as any)[field])) throw new Error(`Invalid fee billing field ${field}`);
  }
  return profile;
}

/** Read-only: no schema creation and no global/public account configuration. */
export function loadFeeContext(db: DatabaseSync | null | undefined, accountId: string | undefined, asOf: string, brokerId?: string): FeeContext {
  if (!DATE.test(asOf)) throw new Error('Fee asOf requires YYYYMMDD');
  let profiles: FeeProfile[] = [];
  if (db && accountId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_meta'").get()) {
    const row = db.prepare('SELECT value FROM account_meta WHERE key=?').get(keyFor(accountId)) as any;
    if (row) {
      const parsed: unknown = JSON.parse(row.value);
      if (!Array.isArray(parsed)) throw new Error('Invalid persisted fee profiles');
      profiles = parsed.map(validateFeeProfile);
    }
  }
  const brokers = [...new Set(profiles.filter(p => p.effective_from <= asOf && (!p.effective_until || asOf <= p.effective_until)).map(p => p.broker_id).filter((value): value is string => !!value))];
  if (!brokerId && brokers.length > 1) throw new Error('Multiple broker fee configurations require explicit brokerId');
  return { accountId, brokerId: brokerId ?? brokers[0], asOf, profiles };
}

/** Append versioned profiles only; a repeated id must contain exactly the same rule. */
export function saveFeeProfile(db: DatabaseSync, accountId: string, profile: FeeProfile): { created: boolean; profile: FeeProfile } {
  if (!accountId.trim()) throw new Error('accountId required');
  validateFeeProfile(profile);
  if (profile.account_id && profile.account_id !== accountId) throw new Error('Fee profile account mismatch');
  const scoped = { ...profile, account_id: accountId };
  const profiles = loadFeeContext(db, accountId, profile.effective_from).profiles;
  const existing = profiles.find(p => p.id === scoped.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(scoped)) throw new Error('Fee profile id already exists; append a new version');
    return { created: false, profile: existing };
  }
  db.prepare('INSERT INTO account_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(keyFor(accountId), JSON.stringify([...profiles, scoped]));
  return { created: true, profile: scoped };
}

/** Code > account/broker category > category default > conservative estimate. */
export function feeRulesFor(context: FeeContext, code: string, kind: 'ETF' | 'STOCK'): FeeRules {
  const active = context.profiles.filter(p => (!p.account_id || p.account_id === context.accountId)
    && (!p.broker_id || p.broker_id === context.brokerId) && p.effective_from <= context.asOf
    && (!p.effective_until || context.asOf <= p.effective_until));
  const specific = active.filter(p => p.code === code).sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.id.localeCompare(b.id));
  const classified = specific.filter(p => p.classification).at(-1)?.classification;
  const classification: FeeClass = kind === 'STOCK' ? 'STOCK' : classified && classified !== 'STOCK' ? classified : 'NORMAL_ETF';
  const category = active.filter(p => !p.code && p.classification === classification)
    .sort((a, b) => Number(!!a.broker_id) - Number(!!b.broker_id) || a.effective_from.localeCompare(b.effective_from) || a.id.localeCompare(b.id));
  const values: FeeRules = { ...(kind === 'STOCK' ? DEFAULT_STOCK_RULES.fees : DEFAULT_FEE_RULES) };
  const evidence = Object.fromEntries(FIELDS.map(field => [field, { level: 'ASSUMED', source: 'Conservative category default; broker terms unverified' }])) as Record<FeeField, FeeFieldEvidence>;
  evidence.transfer_fee_rate = { level: 'PUBLIC_REFERENCE', source: kind === 'STOCK' ? 'ChinaClear A-share transfer fee reference (2022-04-29)' : 'Exchange-traded ETF transfer fee exemption reference' };
  evidence.stamp_duty_rate = { level: 'PUBLIC_REFERENCE', source: kind === 'STOCK' ? 'A-share sell stamp duty reference (2023-08-28)' : 'Exchange-traded ETF stamp duty exemption reference' };
  const applied = [...category, ...specific];
  for (const p of applied) for (const field of FIELDS) if (Object.hasOwn(p.values, field)) {
    const value = p.values[field];
    if (value !== null && value !== undefined) values[field] = value;
    else values[field] = (kind === 'STOCK' ? DEFAULT_STOCK_RULES.fees : DEFAULT_FEE_RULES)[field];
    evidence[field] = p.evidence[field]!;
  }
  const billingValue = <K extends 'aggregation' | 'rounding' | 'minimum_billing_unit' | 'regulatory_fees_included'>(key: K) => applied.filter(p => p[key] !== undefined).at(-1)?.[key] ?? 'UNKNOWN';
  values.fee_model = {
    version: `${FEE_RULE_VERSION}:${createHash('sha256').update(JSON.stringify(applied)).digest('hex').slice(0, 12)}`,
    classification, profile_ids: applied.map(p => p.id), evidence,
    estimated: FIELDS.some(f => evidence[f].level === 'ASSUMED' || evidence[f].level === 'UNKNOWN')
      || billingValue('aggregation') === 'UNKNOWN' || billingValue('rounding') === 'UNKNOWN'
      || billingValue('minimum_billing_unit') === 'UNKNOWN',
    aggregation: billingValue('aggregation'), rounding: billingValue('rounding'),
    minimum_billing_unit: billingValue('minimum_billing_unit'), regulatory_fees_included: billingValue('regulatory_fees_included'),
  };
  return values;
}
export function resolveFeeRules(input: { db?: DatabaseSync | null; accountId?: string; brokerId?: string; code: string; kind: 'ETF' | 'STOCK'; asOf: string }): FeeRules {
  return feeRulesFor(loadFeeContext(input.db, input.accountId, input.asOf, input.brokerId), input.code, input.kind);
}

function roundedRateCents(gross: number, rate: number): number {
  const [mantissa, exponentText = '0'] = rate.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const exponent = Number(exponentText) - fraction.length;
  const numerator = BigInt(whole + fraction) * (exponent > 0 ? 10n ** BigInt(exponent) : 1n);
  const denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  const result = (BigInt(gross) * numerator * 2n + denominator) / (2n * denominator);
  const cents = Number(result);
  if (!Number.isSafeInteger(cents)) throw new Error('Fee exceeds safe integer range');
  return cents;
}

export function calculateFees(grossCents: number, side: 'buy' | 'sell', rules: FeeRules): FeeBreakdown {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) throw new Error('grossCents must be nonnegative safe integer cents');
  for (const field of FIELDS) if (!Number.isFinite(rules[field]) || rules[field] < 0 || (field === 'commission_min_cents' ? !Number.isSafeInteger(rules[field]) : rules[field] > 1)) throw new Error(`Invalid fee field ${field}`);
  const commission = grossCents === 0 ? 0 : Math.max(roundedRateCents(grossCents, rules.commission_rate), rules.commission_min_cents);
  const transfer = roundedRateCents(grossCents, rules.transfer_fee_rate);
  const stamp = side === 'sell' ? roundedRateCents(grossCents, rules.stamp_duty_rate) : 0;
  const slippage = roundedRateCents(grossCents, rules.slippage_rate_per_side);
  if (!Number.isSafeInteger(commission + transfer + stamp + slippage)) throw new Error('Total fee exceeds safe integer range');
  return {
    commission_cents: commission, transfer_fee_cents: transfer, stamp_duty_cents: stamp,
    slippage_estimate_cents: slippage, actual_fee_estimate_cents: commission + transfer + stamp,
    total_cents: commission + transfer + stamp + slippage, assumed: rules.fee_model?.estimated ?? true,
    ...(rules.fee_model ? { fee_model: rules.fee_model } : {}),
  };
}

/** Calibration uses supplied observations; no private account observations are embedded. */
export function calibrateFees(samples: { gross_cents: number; commission_cents: number; side?: 'buy' | 'sell'; order_id?: string }[], rules: FeeRules) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('Calibration requires observations');
  if (rules.fee_model?.aggregation === 'UNKNOWN' && samples.some(s => s.order_id && samples.filter(x => x.order_id === s.order_id).length > 1)) throw new Error('Order/fill commission aggregation is UNKNOWN; provide order-level totals or an evidenced aggregation rule');
  const rows = samples.map(sample => {
    if (!Number.isSafeInteger(sample.commission_cents) || sample.commission_cents < 0) throw new Error('Invalid observed commission');
    const estimate = calculateFees(sample.gross_cents, sample.side ?? 'buy', rules).commission_cents;
    return { ...sample, calculated_commission_cents: estimate, delta_cents: estimate - sample.commission_cents, matched: estimate === sample.commission_cents };
  });
  return { matched: rows.every(row => row.matched), sample_count: rows.length, rows, note: 'Agreement with samples does not establish aggregation, rounding, a hidden billing minimum, or an unknown proportional rate.' };
}
