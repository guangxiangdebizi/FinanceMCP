import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// V1.0 work package B1/B2: importing a USER-CONFIRMED real snapshot.
//
// The fixture below is a *synthetic* snapshot in exactly the shape the user's
// confirmed 2026-10-16 baseline uses (integer cents / milli-yuan / shares).
// It is NOT the user's real account and must never be described as such.
// The real file lives only under the operator's private directory.

const dir = mkdtempSync(join(tmpdir(), 'ashare-v1-import-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { spawnSync } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { readSnapshot, currentSnapshot } = await import('../build/portfolio/account.js');
const { initBaseline, readAccountCompleteness } = await import('../build/portfolio/ledger.js');

const ROOT = process.cwd();
const CLI = join(ROOT, 'build', 'ashare', 'cli.js');

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      ASHARE_DATA_DIR: dir,
      ASHARE_DB_PATH: join(dir, 'ashare.sqlite'),
      ASHARE_PORTFOLIO_DB_PATH: join(dir, 'portfolio.sqlite'),
    },
    encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// Shape-compatible with the user's confirmed baseline; values are synthetic.
const SNAPSHOT = {
  account_id: 'synthetic-test',
  snapshot_id: 'test-confirmed-2026-10-16',
  as_of: '2026-10-16',
  source: 'synthetic_fixture_not_real',
  note: 'Synthetic import fixture; not the user account.',
  warnings: ['displayed_costs_rounded_to_0.001', 'broker_fees_unknown'],
  is_current: false,
  positions: [
    { ts_code: '159241.SZ', name: '航空航天ETF', quantity: 1000, ref_price_milli: 1005, ref_cost_milli: 1103, market_value_cents: 100500 },
    { ts_code: '159278.SZ', name: '机器人ETF', quantity: 1000, ref_price_milli: 796, ref_cost_milli: 1069, market_value_cents: 79600 },
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 58900, ref_price_milli: 935, ref_cost_milli: 1251, market_value_cents: 5507150 },
    { ts_code: '516080.SH', name: '创新药ETF', quantity: 10000, ref_price_milli: 636, ref_cost_milli: 388, market_value_cents: 636000 },
    { ts_code: '560390.SH', name: '电网设备ETF', quantity: 15000, ref_price_milli: 742, ref_cost_milli: 831, market_value_cents: 1113000 },
  ],
  totals: {
    total_assets_cents: 7577653,
    securities_mv_cents: 7436250,
    cash_cents: 141370,
    wealth_cents: 33,
    unrealized_pnl_cents: -1781287,
  },
};

function writeSnapshot(name, body) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test('B1: --dry-run validates and reconciles but writes nothing', () => {
  const file = writeSnapshot('dry.json', SNAPSHOT);
  const r = runCli(['portfolio-import', '--file', file, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.total_assets, 75776.53);
  assert.equal(r.json.securities_mv, 74362.5);
  assert.equal(r.json.cash, 1413.7);
  assert.equal(r.json.wealth, 0.33);
  assert.equal(r.json.reconciliation.ok, true, JSON.stringify(r.json.reconciliation));
  // Nothing was persisted.
  const db = openPortfolioDb(join(dir, 'portfolio.sqlite'));
  try {
    assert.equal(readSnapshot(db, SNAPSHOT.snapshot_id), undefined);
  } finally { db.close(); }
});

test('B1: import writes the snapshot and keeps the demo baseline intact', () => {
  const demo = runCli(['portfolio-import']);
  assert.equal(demo.code, 0, demo.stderr);
  const file = writeSnapshot('real.json', SNAPSHOT);
  const r = runCli(['portfolio-import', '--file', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.inserted, true);
  assert.equal(r.json.is_current, false);

  const db = openPortfolioDb(join(dir, 'portfolio.sqlite'));
  try {
    const stored = readSnapshot(db, SNAPSHOT.snapshot_id);
    assert.ok(stored);
    assert.equal(stored.positions.length, 5);
    assert.equal(stored.totals.total_assets_cents, 7577653);
    assert.equal(stored.source, 'synthetic_fixture_not_real');
    // The demo snapshot must still exist; a new import never overwrites evidence.
    assert.ok(readSnapshot(db, 'demo-2026-10-18'));
    assert.equal(currentSnapshot(db), undefined, 'neither snapshot is current without explicit confirmation');
  } finally { db.close(); }
});

test('B1: importing the same snapshot twice is idempotent; different content is refused', () => {
  const file = writeSnapshot('again.json', SNAPSHOT);
  const again = runCli(['portfolio-import', '--file', file]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.inserted, false);

  const changed = { ...SNAPSHOT, totals: { ...SNAPSHOT.totals, cash_cents: 141371 } };
  const bad = runCli(['portfolio-import', '--file', writeSnapshot('changed.json', changed)]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /拒绝覆盖|内容不同/);
});

test('B1: is_current in the file requires --confirm-current', () => {
  const claimed = { ...SNAPSHOT, snapshot_id: 'test-claimed-current', is_current: true };
  const refused = runCli(['portfolio-import', '--file', writeSnapshot('claimed.json', claimed)]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--confirm-current/);

  const ok = runCli(['portfolio-import', '--file', join(dir, 'claimed.json'), '--confirm-current']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.is_current, true);
  const db = openPortfolioDb(join(dir, 'portfolio.sqlite'));
  try {
    assert.equal(currentSnapshot(db).snapshot_id, 'test-claimed-current');
  } finally { db.close(); }
});

test('B1: malformed snapshots are rejected instead of silently defaulted', () => {
  const cases = [
    [{ ...SNAPSHOT, positions: [] }, /positions/],
    [{ ...SNAPSHOT, as_of: '16-10-2026' }, /as_of/],
    [{ ...SNAPSHOT, positions: [{ ...SNAPSHOT.positions[0], quantity: 10.5 }] }, /整数/],
    [{ ...SNAPSHOT, positions: [{ ...SNAPSHOT.positions[0], ref_price_milli: -1 }] }, /正整数|负数/],
    [{ ...SNAPSHOT, totals: undefined }, /totals/],
  ];
  for (const [body, pattern] of cases) {
    const r = runCli(['portfolio-import', '--file', writeSnapshot('bad.json', body), '--dry-run']);
    assert.notEqual(r.code, 0, JSON.stringify(body).slice(0, 80));
    assert.match(r.stderr, pattern);
  }
});

test('B2: the confirmed snapshot becomes the ledger baseline and the demo account stays separate', () => {
  const db = openPortfolioDb(join(dir, 'portfolio.sqlite'));
  try {
    const snap = readSnapshot(db, SNAPSHOT.snapshot_id);
    assert.ok(snap);
    const baseline = initBaseline(db, 'synthetic-test', { asOf: '20261016', snapshotId: snap.snapshot_id });
    assert.equal(baseline.created, true);
    assert.equal(baseline.cash_cents, 141370);
    assert.equal(baseline.positions, 5);
    // Re-initialising with the same values is idempotent, not a silent rewrite.
    const again = initBaseline(db, 'synthetic-test', { asOf: '20261016', snapshotId: snap.snapshot_id });
    assert.equal(again.created, false);
    // No completeness declaration exists until the user explicitly declares one.
    assert.equal(readAccountCompleteness(db, 'synthetic-test') ?? null, null);
  } finally { db.close(); }
});

test('B3: completeness declaration requires --confirm and defaults to unreported-trade risk', () => {
  const refused = runCli(['portfolio-completeness-set', '--account', 'synthetic-test', '--as-of', '20261016', '--recorded-by', 'operator']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--confirm/);

  const r = runCli([
    'portfolio-completeness-set', '--account', 'synthetic-test', '--as-of', '20261016',
    '--recorded-by', 'operator', '--events-through', '20261016', '--confirm',
  ]);
  assert.equal(r.code, 0, r.stderr);
  // `setAccountCompleteness` returns `{created, completeness}`.
  assert.equal(r.json.completeness.unreported_trade_risk, true, 'omitting --unreported-risk must stay conservative');

  const db = openPortfolioDb(join(dir, 'portfolio.sqlite'));
  try {
    const c = readAccountCompleteness(db, 'synthetic-test');
    assert.equal(c.reported_events_through, '20261016');
    assert.equal(c.unreported_trade_risk, true);
  } finally { db.close(); }
});
