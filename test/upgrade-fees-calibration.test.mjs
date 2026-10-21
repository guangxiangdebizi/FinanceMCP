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
const special = (code, id) => ({ id, code, classification: 'SUPER_ETF', effective_from: '20200101',
  values: { commission_rate: 0.00005, commission_min_cents: 0 },
  evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') } });
const minOnly = (code, id) => ({ id, code, classification: 'OTHER_ETF', effective_from: '20200101',
  values: { commission_rate: null, commission_min_cents: 500 },
  evidence: { commission_rate: ev('UNKNOWN', 'proportional rate never observed'), commission_min_cents: ev('CONFIRMED') } });

// The 12 historical observations from the goal specification (gross yuan, commission yuan) -> cents.
const SAMPLES = {
  '159558.SZ': [[9990.00, 0.50], [9149.20, 0.46], [19901.70, 1.00], [3330.00, 0.17]],
  '560390.SH': [[3980.00, 0.20], [2511.00, 0.13], [1674.00, 0.08], [4295.00, 0.21]],
  '516080.SH': [[3485.00, 5.00], [7540.00, 5.00], [6970.00, 5.00], [3465.00, 5.00]],
};
const cents = yuan => Math.round(yuan * 100);
const ctx = {
  asOf: '20261021', accountId: 'real-main',
  profiles: [special('159558.SZ', 'p1'), special('560390.SH', 'p2'), minOnly('516080.SH', 'p3')],
};

test('the twelve historical fills reproduce the actual commission one by one', () => {
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

test('per-field evidence: min-fee observed does not confirm the 516080 proportional rate', () => {
  const rules = feeRulesFor(ctx, '516080.SH', 'ETF');
  assert.equal(rules.fee_model.evidence.commission_min_cents.level, 'CONFIRMED');
  assert.equal(rules.fee_model.evidence.commission_rate.level, 'UNKNOWN');
  assert.equal(rules.fee_model.estimated, true);
  assert.notEqual(rules.fee_model.classification, 'SUPER_ETF');
  const fee = calculateFees(cents(3485), 'buy', rules);
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
