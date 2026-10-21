import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { calculateFees, calibrateFees, feeRulesFor, loadFeeContext, saveFeeProfile } from '../build/portfolio/fees.js';

// Generic synthetic observations only: no private security codes or broker statement samples.
const evidence = level => ({ level, source: 'synthetic calibration fixture' });
const profile = (id, patch = {}) => ({ id, account_id: 'synthetic', code: '159999.SZ', classification: 'SUPER_ETF', effective_from: '20260101',
  values: { commission_rate: 0.00005, commission_min_cents: 0 },
  evidence: { commission_rate: evidence('CONFIRMED'), commission_min_cents: evidence('CONFIRMED') }, ...patch });
const db = () => { const d = new DatabaseSync(':memory:'); d.exec('CREATE TABLE account_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)'); return d; };

test('fee profile persistence, code precedence, effective dates and unrelated ETF defaults', () => {
  const d = db();
  try {
    saveFeeProfile(d, 'synthetic', profile('special'));
    saveFeeProfile(d, 'synthetic', profile('category', { code: undefined, classification: 'SUPER_ETF', values: { commission_rate: 0.0001 }, evidence: { commission_rate: evidence('ASSUMED') } }));
    const ctx = loadFeeContext(d, 'synthetic', '20261021');
    const special = feeRulesFor(ctx, '159999.SZ', 'ETF');
    assert.equal(special.commission_rate, 0.00005);
    assert.equal(calculateFees(1234500, 'buy', special).commission_cents, 62);
    assert.equal(special.fee_model.classification, 'SUPER_ETF');
    assert.equal(feeRulesFor(ctx, '159998.SZ', 'ETF').commission_min_cents, 500);
    assert.equal(feeRulesFor({ ...ctx, asOf: '20250101' }, '159999.SZ', 'ETF').commission_min_cents, 500);
    assert.equal(loadFeeContext(d, 'other', '20261021').profiles.length, 0);
    assert.equal(saveFeeProfile(d, 'synthetic', profile('special')).created, false);
    assert.throws(() => saveFeeProfile(d, 'synthetic', profile('special', { values: { commission_rate: 0.1 } })), /evidence|version/);
  } finally { d.close(); }
});

test('twelve generic calibration observations reproduce commissions without claiming unknown billing facts', () => {
  const ctx = { asOf: '20261021', accountId: 'synthetic', profiles: [profile('a')] };
  const discounted = feeRulesFor(ctx, '159999.SZ', 'ETF');
  const ordinary = feeRulesFor({ ...ctx, profiles: [profile('min-only', { values: { commission_rate: null, commission_min_cents: 500 }, evidence: { commission_rate: evidence('UNKNOWN'), commission_min_cents: evidence('CONFIRMED') } })] }, '159999.SZ', 'ETF');
  const samples = [120000, 240000, 360000, 480000, 600000, 720000, 840000, 960000].map((gross, i) => ({ gross_cents: gross, commission_cents: 6 * (i + 1) }));
  const fixed = [200000, 400000, 800000, 1000000].map(gross => ({ gross_cents: gross, commission_cents: 500 }));
  assert.equal(calibrateFees(samples, discounted).matched, true);
  assert.equal(calibrateFees(fixed, ordinary).matched, true);
  assert.equal(samples.length + fixed.length, 12);
  assert.equal(ordinary.fee_model.evidence.commission_rate.level, 'UNKNOWN');
  assert.equal(ordinary.fee_model.evidence.commission_min_cents.level, 'CONFIRMED');
  assert.equal(discounted.fee_model.aggregation, 'UNKNOWN');
  assert.equal(discounted.fee_model.minimum_billing_unit, 'UNKNOWN');
  assert.equal(discounted.fee_model.estimated, true);
});

test('stock/ETF taxes, slippage isolation and zero notional', () => {
  const ctx = { asOf: '20261021', profiles: [] };
  const stock = calculateFees(1000000, 'sell', feeRulesFor(ctx, '600999.SH', 'STOCK'));
  const etf = calculateFees(1000000, 'sell', feeRulesFor(ctx, '159999.SZ', 'ETF'));
  assert.equal(stock.stamp_duty_cents, 500);
  assert.equal(stock.transfer_fee_cents, 10);
  assert.equal(etf.stamp_duty_cents, 0);
  assert.equal(etf.transfer_fee_cents, 0);
  assert.equal(stock.total_cents, stock.actual_fee_estimate_cents + stock.slippage_estimate_cents);
  assert.equal(calculateFees(0, 'buy', feeRulesFor(ctx, '159999.SZ', 'ETF')).total_cents, 0);
  assert.throws(() => calculateFees(-1, 'buy', feeRulesFor(ctx, '159999.SZ', 'ETF')), /nonnegative/);
});
