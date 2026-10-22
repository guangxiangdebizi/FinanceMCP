import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'ashare-fee-cal-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
const { calculateFees, calibrateFees, feeRulesFor, loadFeeContext } = await import('../build/portfolio/fees.js');
const { portfolioToolDefinitions, ashareToolDefinitions } = await import('../build/ashare/definitions.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');

const CLI = join(process.cwd(), 'build', 'ashare', 'cli.js');
const run = args => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: process.env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stderr: r.stderr, json };
};
const ev = (level, source = 'historical fills') => ({ level, source });
const special = (code, id) => ({ id, code, classification: 'SUPER_ETF', effective_from: '20261016',
  values: { commission_rate: 0.00005, commission_min_cents: 0 },
  evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') } });
const minOnly = (code, id) => ({ id, code, classification: 'OTHER_ETF', effective_from: '20261016',
  values: { commission_rate: null, commission_min_cents: 500 },
  evidence: { commission_rate: ev('UNKNOWN', 'proportional rate never observed'), commission_min_cents: ev('CONFIRMED') } });

// Synthetic billing-boundary observations (gross yuan, commission yuan). None is a real fill: the real
// samples live only in the operator's private calibration directory. Boundaries covered for the 0.00005
// tier: exact cent, exactly half a cent (half-up), just above and just below half, sub-5-yuan commissions
// with no minimum floor; for the minimum-only code: every fill billed at the 5-yuan minimum.
const SAMPLES = {
  '159558.SZ': [[4300.00, 0.22], [5299.00, 0.26], [3501.00, 0.18], [15150.40, 0.76]],
  '560390.SH': [[7600.00, 0.38], [6850.50, 0.34], [100.00, 0.01], [1111.00, 0.06]],
  '516080.SH': [[3210.00, 5.00], [7125.50, 5.00], [6800.00, 5.00], [3595.00, 5.00]],
};
const cents = yuan => Math.round(yuan * 100);
const ctx = {
  asOf: '20261021', accountId: 'real-main',
  profiles: [special('159558.SZ', 'p1'), special('560390.SH', 'p2'), minOnly('516080.SH', 'p3')],
};

test('twelve synthetic billing-boundary fills reproduce the commission one by one', () => {
  let count = 0;
  for (const [code, rows] of Object.entries(SAMPLES)) {
    const rules = feeRulesFor(ctx, code, 'ETF');
    for (const [gross, commission] of rows) {
      const fee = calculateFees(cents(gross), 'buy', rules);
      assert.equal(fee.commission_cents, cents(commission), `${code} ${gross}`);
      count += 1;
    }
    const batch = calibrateFees(rows.map(([g, c]) => ({ gross_cents: cents(g), commission_cents: cents(c) })), rules);
    assert.equal(batch.matched, true, code);
  }
  assert.equal(count, 12);
});

test('calibration profiles are effective-dated and never reach back before their evidence date', () => {
  const before = { ...ctx, asOf: '20261015' };
  for (const code of ['159558.SZ', '560390.SH', '516080.SH']) {
    const rules = feeRulesFor(before, code, 'ETF');
    assert.equal(rules.fee_model.classification, 'NORMAL_ETF', code);
    assert.equal(rules.commission_rate, 0.00025);
    assert.equal(rules.fee_model.evidence.commission_rate.level, 'ASSUMED');
  }
  const rules = feeRulesFor(ctx, '159558.SZ', 'ETF');
  assert.equal(rules.fee_model.estimated, true, 'fitting samples does not confirm rounding, aggregation or hidden billing units');
  assert.equal(rules.fee_model.rounding, 'UNKNOWN');
  assert.equal(rules.fee_model.aggregation, 'UNKNOWN');
  assert.equal(rules.fee_model.minimum_billing_unit, 'UNKNOWN');
});

test('super-ETF tagging is per exact code: a neighbouring code of the same family is not tagged', () => {
  for (const code of ['159559.SZ', '560391.SH', '516081.SH']) {
    assert.equal(feeRulesFor(ctx, code, 'ETF').fee_model.classification, 'NORMAL_ETF', code);
  }
});

test('per-field evidence: min-fee observed does not confirm the 516080 proportional rate', () => {
  const rules = feeRulesFor(ctx, '516080.SH', 'ETF');
  assert.equal(rules.fee_model.evidence.commission_min_cents.level, 'CONFIRMED');
  assert.equal(rules.fee_model.evidence.commission_rate.level, 'UNKNOWN');
  assert.equal(rules.fee_model.estimated, true);
  assert.notEqual(rules.fee_model.classification, 'SUPER_ETF');
  const fee = calculateFees(cents(3210), 'buy', rules);
  assert.equal(fee.assumed, true);
  assert.equal(rules.commission_rate, 0.00025, 'unknown rate falls back to the conservative default, still flagged');
});

test('159241/159278 stay ordinary ETFs; marking is per code and never by fund family', () => {
  for (const code of ['159241.SZ', '159278.SZ']) {
    const rules = feeRulesFor(ctx, code, 'ETF');
    assert.equal(rules.fee_model.classification, 'NORMAL_ETF');
    assert.equal(rules.commission_rate, 0.00025);
    assert.equal(rules.commission_min_cents, 500);
    assert.equal(rules.fee_model.evidence.commission_rate.level, 'ASSUMED');
  }
});

test('a bare SUPER_ETF mark carries the observed tier without a 5-yuan floor, still ASSUMED', () => {
  const mark = { id: 'mark', code: '159999.SZ', classification: 'SUPER_ETF', effective_from: '20260101', values: {}, evidence: {} };
  const rules = feeRulesFor({ asOf: '20261021', accountId: 'a', profiles: [mark] }, '159999.SZ', 'ETF');
  assert.equal(rules.fee_model.classification, 'SUPER_ETF');
  assert.equal(rules.commission_rate, 0.00005);
  assert.equal(rules.commission_min_cents, 0);
  assert.equal(rules.fee_model.evidence.commission_rate.level, 'ASSUMED');
  assert.equal(rules.fee_model.estimated, true);
  assert.equal(feeRulesFor({ asOf: '20261021', accountId: 'a', profiles: [mark] }, '159998.SZ', 'ETF').commission_min_cents, 500);
});

test('priority: code rule > broker category rule > category rule > default', () => {
  const cat = (id, patch) => ({ id, classification: 'SUPER_ETF', effective_from: '20200101', evidence: { commission_rate: ev('ASSUMED') }, ...patch });
  const profiles = [
    cat('general', { values: { commission_rate: 0.0001 } }),
    cat('broker', { broker_id: 'b1', values: { commission_rate: 0.00008 } }),
    { ...special('159999.SZ', 'code'), values: { commission_rate: 0.00003, commission_min_cents: 0 } },
    { id: 'mark2', code: '159888.SZ', classification: 'SUPER_ETF', effective_from: '20200101', values: {}, evidence: {} },
  ];
  const c = { asOf: '20261021', accountId: 'a', brokerId: 'b1', profiles };
  assert.equal(feeRulesFor(c, '159999.SZ', 'ETF').commission_rate, 0.00003);
  assert.equal(feeRulesFor(c, '159888.SZ', 'ETF').commission_rate, 0.00008);
  assert.equal(feeRulesFor({ ...c, brokerId: 'b2' }, '159888.SZ', 'ETF').commission_rate, 0.0001);
  assert.equal(feeRulesFor({ ...c, profiles: [] }, '159888.SZ', 'ETF').commission_rate, 0.00025);
});

test('fee administration is a local confirmed CLI; no public or private MCP tool can write it', () => {
  for (const tool of [...portfolioToolDefinitions, ...ashareToolDefinitions]) {
    assert.doesNotMatch(tool.name, /fee|ledger|import|record|completeness|confirm|profile/, tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  }
  assert.equal(run(['portfolio-import']).code, 0);
  assert.equal(run(['portfolio-ledger-init', '--account', 'fee-test', '--as-of', '20261018', '--cash', '100000']).code, 0);
  const file = join(dir, 'mark.json');
  writeFileSync(file, JSON.stringify({ id: 'mark-cli', code: '159999.SZ', classification: 'SUPER_ETF', effective_from: '20260101', values: {}, evidence: {} }));
  const refused = run(['portfolio-fees-set', '--account', 'fee-test', '--file', file]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--confirm/);
  const dry = run(['portfolio-fees-set', '--account', 'fee-test', '--file', file, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  const read = () => { const d = openPortfolioDb(process.env.ASHARE_PORTFOLIO_DB_PATH); try { return loadFeeContext(d, 'fee-test', '20261021').profiles; } finally { d.close(); } };
  assert.equal(read().length, 0, 'neither refusal nor dry-run persists anything');
  const saved = run(['portfolio-fees-set', '--account', 'fee-test', '--file', file, '--confirm']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.json.created, true);
  assert.equal(run(['portfolio-fees-set', '--account', 'fee-test', '--file', file, '--confirm']).json.created, false);
  assert.deepEqual(read().map(p => p.id), ['mark-cli']);
  const listed = run(['portfolio-fees-list', '--account', 'fee-test', '--date', '20261021']);
  assert.equal(listed.json.profiles[0].classification, 'SUPER_ETF');
});
