import assert from 'node:assert/strict';
import test from 'node:test';
import { differences, digest, projectScan } from '../deploy/ashare/verify-v1-parity.mjs';

test('parity evidence distinguishes missing data from null, zero, and non-finite values', () => {
  const values = [undefined, null, NaN, Infinity, -Infinity, 0, -0, 'NaN'];
  assert.equal(new Set(values.map(digest)).size, values.length);
  assert.notEqual(digest({ factor: undefined }), digest({}));
  assert.equal(digest({ a: 1, b: null }), digest({ b: null, a: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});

test('exact comparison exposes tiny score changes and field presence instead of rounding', () => {
  const a = { rows: [{ ts_code: '600519.SH', score: 50, components: { fundamental: 0.5 }, missing: undefined }] };
  const b = structuredClone(a);
  b.rows[0].score += 1e-12;
  b.rows[0].components.fundamental = 0.5000000000001;
  delete b.rows[0].missing;
  const diff = differences(a, b);
  assert.equal(diff.length, 3);
  assert.ok(diff.some(d => d.path === '$.rows.0.score'));
  assert.ok(diff.some(d => d.path === '$.rows.0.components.fundamental'));
  assert.ok(diff.some(d => d.path === '$.rows.0.missing' && d.presence_mismatch));
  assert.equal(differences(a, b, 1).length, 1);
  assert.notEqual(digest(a), digest(b));
});

test('legacy projection compares ineligible stocks and retains row order and signal state', () => {
  const scan = {
    trade_date: '20261016', suspended_or_missing: 3,
    pct_above_ma20: 0.5, pct_above_ma60: 0.25,
    signal_counts: { breakout: 1 }, sectors: [{ industry: '银行', rank: 1, strength: 0.8 }],
    rows: [
      { ts_code: '600519.SH', eligible: true, score: 90, rank: 1, components: { fundamental: 0.7 }, signals: ['breakout'], state: { ret20: 0.1 } },
      { ts_code: '000001.SZ', eligible: false, ineligible_reason: '历史数据不足', signals: [], state: { ret20: NaN } },
    ],
  };
  const expected = projectScan(scan);
  const withResearchMetadata = structuredClone(scan);
  withResearchMetadata.rows[0].research_factors = { cash: 115.11 };
  assert.deepEqual(projectScan(withResearchMetadata), expected);
  const changed = structuredClone(scan);
  changed.rows[1].ineligible_reason = 'ST/退市风险';
  assert.notEqual(digest(projectScan(changed)), digest(expected));
  const signalChanged = structuredClone(scan);
  signalChanged.rows[0].signals = [];
  assert.notEqual(digest(projectScan(signalChanged)), digest(expected));
  const reordered = structuredClone(scan);
  reordered.rows.reverse();
  assert.notEqual(digest(projectScan(reordered)), digest(expected));
});
