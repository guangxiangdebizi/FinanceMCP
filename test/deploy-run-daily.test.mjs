import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// run-daily.sh is what systemd actually executes at 18:40 / 21:10, so the observation step is
// driven here through the real script with a fake `docker` on PATH. Nothing touches production.

const SCRIPT = join(process.cwd(), 'deploy/ashare/run-daily.sh');

function run({ dailyJson, observeJson, observeExit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'run-daily-'));
  const bin = join(dir, 'bin'); const log = join(dir, 'docker.log');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(dir, 'daily.json'), dailyJson);
  writeFileSync(join(dir, 'observe.json'), observeJson ?? '');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  info) exit 0 ;;
  inspect) echo "running/healthy"; exit 0 ;;
  exec)
    shift; shift   # exec CONTAINER
    case "$*" in
      "test -f "*) exit 0 ;;
      *" daily"*) cat "${dir}/daily.json"; exit 0 ;;
      *"research-validation observe"*) cat "${dir}/observe.json"; exit ${observeExit} ;;
    esac ;;
esac
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const r = spawnSync('sh', [SCRIPT], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASHARE_HOST_DATA_DIR: join(dir, 'data'), ASHARE_SG_REEXEC: '1', ASHARE_DOCKER_WAIT_SECONDS: '1' }, encoding: 'utf8' });
  return { ...r, dockerLog: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

// Pretty-printed like the real daily output: the old extraction was line-based.
const SYNC_LAST = JSON.stringify({ report: { trade_date: '20261023', status: 'READY' }, sync: { quality: [{ trade_date: '20261022' }] } }, null, 2);
const REPORT_LAST = JSON.stringify({ sync: { quality: [{ trade_date: '20261021' }] }, report: { trade_date: '20261023', status: 'READY' } }, null, 2);
const RECORDED = JSON.stringify({ id: 'OBS-1', type: 'TRUE_FORWARD_OBSERVATION' });
const unavailable = mismatched => JSON.stringify({ status: 'UNAVAILABLE', reason: 'matching_active_freeze_unavailable', mismatched, as_of: '20261023' });

test('D1 the observation date comes from report.trade_date, not from whichever trade_date line is last', () => {
  const r = run({ dailyJson: SYNC_LAST, observeJson: RECORDED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.dockerLog, /--as-of 20261023(\s|$)/, 'must observe the report date, not 20261022');
  assert.doesNotMatch(r.dockerLog, /--as-of 20261022/);
});

test('D2 a recorded observation says so', () => {
  const r = run({ dailyJson: REPORT_LAST, observeJson: RECORDED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /observation recorded/);
  assert.doesNotMatch(r.stderr, /NOT RECORDED/);
});

test('D3 UNAVAILABLE is never reported as finished: it says NOT RECORDED and names the mismatch (exit 79)', () => {
  const r = run({ dailyJson: REPORT_LAST, observeJson: unavailable(['implementation_hash']) });
  assert.equal(r.status, 79, r.stderr);
  assert.match(r.stderr, /NOT RECORDED/);
  assert.match(r.stderr, /implementation_hash/);
  assert.doesNotMatch(r.stdout, /observation (recorded|finished)/);
});

test('D4 a freeze whose start day has not arrived yet is expected: loud, but exit 0', () => {
  const r = run({ dailyJson: REPORT_LAST, observeJson: unavailable(['start_after_as_of']) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /NOT RECORDED/);
  assert.match(r.stderr, /start_after_as_of/);
});

test('D5 a daily output with no report.trade_date fails the observation step (exit 76) instead of guessing', () => {
  const r = run({ dailyJson: JSON.stringify({ sync: { quality: [{ trade_date: '20261022' }] } }, null, 2), observeJson: RECORDED });
  assert.equal(r.status, 76, r.stderr);
  assert.doesNotMatch(r.dockerLog, /research-validation observe/, 'must not run observe without a date');
});

test('D6 a failing observe command is still exit 76 and keeps the market report', () => {
  const r = run({ dailyJson: REPORT_LAST, observeJson: '', observeExit: 3 });
  assert.equal(r.status, 76, r.stderr);
  assert.match(r.stderr, /observation FAILED/);
});
