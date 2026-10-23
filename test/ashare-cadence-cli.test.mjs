import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The cadence is scheduled by a systemd unit that sets RESEARCH_CADENCE_ENABLED explicitly.
// These tests drive the real CLI process: a guard asserted only in a helper nobody calls is
// documentation, so the "disabled by default" and "no default account" rules are checked here.

const ROOT = process.cwd();
function cli(args, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-cli-'));
  const env = { ...process.env, TUSHARE_TOKEN: '', ASHARE_DATA_DIR: dir,
    ASHARE_DB_PATH: join(dir, 'market.sqlite'), ASHARE_PORTFOLIO_DB_PATH: join(dir, 'portfolio.sqlite'),
    ASHARE_RESEARCH_DB_PATH: join(dir, 'research.sqlite'), ...extraEnv };
  delete env.RESEARCH_CADENCE_ENABLED;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [join(ROOT, 'build/ashare/cli.js'), 'research-cadence', ...args], { cwd: dir, env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json, dir };
}

test('C1 unset RESEARCH_CADENCE_ENABLED means disabled, and nothing is written', () => {
  const r = cli(['weekly', '--as-of', '20261023', '--account-id', 'real-main']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.skip_reason, 'disabled');
  assert.equal(r.json.produced, false);
  assert.equal(r.json.written_to, null);
  assert.deepEqual(readdirSync(r.dir), [], 'a disabled run must not create any file');
});

test('C2 there is no default account: omitting --account-id fails instead of defaulting', () => {
  const r = cli(['monthly', '--as-of', '20261023'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--account-id is required/);
});

test('C3 an unknown cadence and a malformed as-of are rejected', () => {
  assert.notEqual(cli(['daily', '--as-of', '20261023', '--account-id', 'x']).status, 0);
  const bad = cli(['weekly', '--as-of', '2026-10-23', '--account-id', 'x'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /YYYYMMDD or latest/);
});

test('C4 enabled but with no market cache, it reports an outage rather than a quiet week, and writes nothing', () => {
  const r = cli(['weekly', '--as-of', '20261023', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.produced, false);
  assert.equal(r.json.skip_reason, 'diagnosis_unavailable');
  assert.match(r.json.detail, /行情缓存不存在/);
  assert.equal(existsSync(join(r.dir, 'research-cadence')), false);
});

test('C5 --as-of latest with no cache is reported as unavailable, not resolved to a guess', () => {
  const r = cli(['weekly', '--as-of', 'latest', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'UNAVAILABLE');
  assert.equal(r.json.reason, 'no_market_cache_to_resolve_latest');
});
