#!/usr/bin/env node
// Production-untouched evidence for the phase B freeze round.
//
// Records, without modifying anything, that:
//  - the production container image, start time, health and restart count are
//    unchanged, and /app/build/ashare inside the image is the same file list;
//  - the production data directory's SQLite file is byte-identical;
//  - the live report / watchlist / stock_score / quality_check tables have the
//    same row counts;
//  - the A-share timer still exists, in the SAME systemd scope, enabled, with
//    the same OnCalendar and ExecStart.
//
// Scheduling scope: the A-share timer is installed in the systemd USER manager
// (`~/.config/systemd/user/finance-ashare-daily.timer`, linger enabled), not in
// the system manager. A system-scope-only query therefore reports "no timer",
// which is why this script queries `systemctl --user` and `systemctl`
// separately and records both inventories. A missing A-share timer is a FAIL,
// never a silent pass.
//
// Usage:
//   node deploy/ashare/verify-production-untouched.mjs --baseline BASELINE.json
//   node deploy/ashare/verify-production-untouched.mjs BASELINE.json OUTPUT.json
// BASELINE.json is a snapshot produced by this script with --baseline.
//
// Read-only: every command below inspects state (systemctl show/list/cat,
// docker inspect/exec, file hashing, SQLite read-only queries). Nothing starts,
// stops, enables, disables or edits a timer, service, container or database.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIVE_DIR = process.env.ASHARE_LIVE_DIR || '/home/jcshi/.local/share/finance-mcp-ashare';
const CONTAINER = process.env.ASHARE_CONTAINER || 'finance-mcp-ashare';
const DB = `${LIVE_DIR}/ashare.sqlite`;
const TABLES = ['report', 'watchlist', 'watchlist_change', 'stock_score', 'quality_check', 'signal_evidence', 'data_audit'];
const ASHARE_UNIT_RE = /finance-ashare|ashare/i;

// ---------------------------------------------------------------------------
// Pure parsers. Exported so the evidence logic can be tested without docker or
// systemd (test/ashare-production-evidence.test.mjs).
// ---------------------------------------------------------------------------

export function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `ERROR: ${error?.message ?? error}`;
  }
}

export function isAshareUnit(name) {
  return ASHARE_UNIT_RE.test(String(name ?? ''));
}

// `systemctl show` prints KEY=VALUE, one per line, and repeats a key once per
// value (TimersCalendar, ExecStart). Repeated keys become arrays.
export function parseUnitShow(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('ERROR:') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    else out[key] = value;
  }
  return out;
}

// `systemctl list-timers --all --no-pager` columns are NEXT LEFT LAST PASSED
// UNIT ACTIVATES, padded with a single space when a value fills its width, so
// splitting on runs of spaces is not reliable. UNIT is the only token ending in
// `.timer`; the time columns are matched by their pretty format ("Mon
// 2026-10-19 10:41:17 UTC"), and "n/a" rows yield nulls.
export function parseTimers(text) {
  const timers = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('ERROR:') || /^NEXT\s+LEFT\b/.test(trimmed)) continue;
    if (/^\d+ timers? listed\.$/.test(trimmed)) continue;
    const tail = /^(.*?)\s+(\S+\.timer)\s+(\S+)$/.exec(line);
    if (!tail) continue;
    const [, prefix, unit, activates] = tail;
    const stamps = prefix.match(/\b[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/g) ?? [];
    timers.push({
      unit,
      activates,
      next_elapse: stamps[0] ?? null,
      last_trigger: stamps[1] ?? null,
      raw: trimmed,
    });
  }
  return timers;
}

// `systemctl list-unit-files --no-pager` columns are UNIT FILE STATE PRESET.
export function parseUnitFiles(text) {
  const files = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('ERROR:') || /^UNIT FILE\b/.test(line)) continue;
    if (/unit files? listed/i.test(line)) continue;
    const [unit, state, preset] = line.split(/\s+/);
    if (!unit?.includes('.')) continue;
    files.push({ unit, state: state ?? null, preset: preset ?? null });
  }
  return files;
}

// ExecStart is printed as a structured value:
//   { path=/x ; argv[]=/x ; ignore_errors=no ; start_time=[...] ; ... }
// Older systemd prints the plain command line instead.
export function parseExecStart(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string' || !first) return { path: null, argv: [] };
  const body = /\{([^}]*)\}/.exec(first)?.[1];
  if (!body) return { path: first.trim(), argv: [first.trim()] };
  const path = /(?:^|;)\s*path=([^;]*)/.exec(body)?.[1]?.trim() || null;
  const argvText = /(?:^|;)\s*argv\[\]=([^;]*)/.exec(body)?.[1]?.trim() ?? '';
  const argv = argvText ? argvText.split(/\s+/).filter(Boolean) : [];
  return { path, argv };
}

// TimersCalendar is printed once per OnCalendar line:
//   { OnCalendar=Mon..Fri *-*-* 18:40:00 Asia/Shanghai ; next_elapse=Mon ... }
export function parseTimersCalendar(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const entry of values) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    const m = /\{\s*OnCalendar=(.*?)\s*;\s*next_elapse=(.*?)\s*\}/.exec(text);
    if (m) out.push({ on_calendar: m[1].trim(), next_elapse: m[2].trim() });
    else out.push({ on_calendar: text, next_elapse: null });
  }
  return out;
}

// Unit files use specifiers; the user manager resolves %h to the home directory.
export function resolveUnitSpecifiers(text, { home = homedir(), user = '' } = {}) {
  return String(text ?? '')
    .replaceAll('%%', '\u0000')
    .replaceAll('%h', home)
    .replaceAll('%u', user)
    .replaceAll('\u0000', '%');
}

function isoTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Build the unambiguous scheduling summary from per-scope inventory records.
// `timers` is the merged A-share timer list; each record carries the timer's
// own state and its activated service's ExecStart/script.
export function summarizeScheduling(input = {}) {
  const timers = Array.isArray(input.timers) ? input.timers : [];
  const sorted = [...timers].sort((a, b) => `${a.scope}:${a.unit}`.localeCompare(`${b.scope}:${b.unit}`));
  const primary = sorted[0] ?? null;
  const service = primary?.service ?? {};
  return {
    host: input.host ?? hostname(),
    user: input.user ?? null,
    linger: input.linger ?? null,
    user_manager_available: input.user_manager_available === true,
    a_share_timers_found: sorted.length > 0,
    timer_count: sorted.length,
    scope: primary?.scope ?? null,
    timer_unit: primary?.unit ?? null,
    service_unit: primary?.activates ?? null,
    enabled: primary?.enabled ?? null,
    active_state: primary?.active ?? null,
    next_elapse: primary?.next_elapse ?? null,
    next_elapse_iso: isoTimestamp(primary?.next_elapse),
    last_trigger: primary?.last_trigger ?? null,
    last_trigger_iso: isoTimestamp(primary?.last_trigger),
    on_calendar: primary?.on_calendar ?? [],
    unit_file_path: primary?.unit_file_path ?? null,
    exec_start: service.exec_start ?? null,
    exec_start_argv: service.exec_start_argv ?? [],
    working_directory: service.working_directory ?? null,
    working_directory_defaulted: service.working_directory_defaulted === true,
    script_path: service.script_path ?? null,
    script_exists: service.script_exists ?? null,
    script_sha256: service.script_sha256 ?? null,
    timer_inventory: sorted.map(t => ({
      scope: t.scope,
      unit: t.unit,
      activates: t.activates,
      enabled: t.enabled,
      active: t.active,
      next_elapse: t.next_elapse,
      last_trigger: t.last_trigger,
      on_calendar: t.on_calendar ?? [],
      exec_start: t.service?.exec_start ?? null,
      script_path: t.service?.script_path ?? null,
      script_sha256: t.service?.script_sha256 ?? null,
    })),
    unit_files: input.unit_files ?? { user: [], system: [] },
    errors: input.errors ?? [],
  };
}

// Compare the observed summary against the baseline summary. The next elapse
// legitimately moves as the timer fires, so it is recorded but not compared;
// the unit's existence, scope, enabled state, OnCalendar and ExecStart are.
export function compareScheduling(observed = {}, baseline = {}) {
  const inventory = s => (s?.timer_inventory ?? [])
    .map(t => `${t.scope}:${t.unit}:${t.activates}:${t.enabled}`)
    .sort();
  const observedInventory = inventory(observed);
  const baselineInventory = inventory(baseline);
  const listEqual = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return {
    scheduling_host_unchanged: observed.host != null && observed.host === baseline.host && observed.user === baseline.user,
    user_manager_available: observed.user_manager_available === true,
    a_share_timers_found: observed.a_share_timers_found === true && baseline.a_share_timers_found === true,
    ashare_timer_inventory_unchanged:
      observedInventory.length > 0 && JSON.stringify(observedInventory) === JSON.stringify(baselineInventory),
    ashare_timer_scope: observed.scope != null && observed.scope === baseline.scope,
    ashare_timer_enabled: observed.enabled === 'enabled' && baseline.enabled === 'enabled',
    ashare_timer_schedule_unchanged:
      (observed.on_calendar ?? []).length > 0 && listEqual(observed.on_calendar, baseline.on_calendar),
    ashare_timer_exec_start_unchanged: observed.exec_start != null && observed.exec_start === baseline.exec_start,
    ashare_timer_script_unchanged:
      observed.script_path != null &&
      observed.script_path === baseline.script_path &&
      observed.script_sha256 != null &&
      observed.script_sha256 === baseline.script_sha256,
    ashare_timer_armed: observed.next_elapse != null && observed.next_elapse !== '',
  };
}

// ---------------------------------------------------------------------------
// Collection (read-only commands only).
// ---------------------------------------------------------------------------

async function sha256(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

function rowCounts() {
  // Run inside the container so the same file and SQLite build as production are used.
  const script = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify('/data/ashare.sqlite')},{readOnly:true});const out={};for(const t of ${JSON.stringify(TABLES)}){try{out[t]=d.prepare('SELECT COUNT(*) n FROM '+t).get().n}catch(e){out[t]=null}}process.stdout.write(JSON.stringify(out))`;
  const text = sh('docker', ['exec', CONTAINER, 'node', '-e', script]);
  try { return JSON.parse(text); } catch { return { error: text }; }
}

function scopeArgs(scope) {
  return scope === 'user' ? ['--user'] : [];
}

function collectScope(scope) {
  const args = scopeArgs(scope);
  const timersText = sh('systemctl', [...args, 'list-timers', '--all', '--no-pager']);
  const unitFilesText = sh('systemctl', [...args, 'list-unit-files', '--no-pager']);
  return {
    scope,
    timers: parseTimers(timersText),
    unitFiles: parseUnitFiles(unitFilesText),
    errors: [timersText, unitFilesText].filter(text => text.startsWith('ERROR:')),
  };
}

async function collectTimer(scope, unit, inventoryRecord) {
  const args = scopeArgs(scope);
  const show = parseUnitShow(sh('systemctl', [...args, 'show', unit, '--no-pager',
    '-p', 'UnitFileState', '-p', 'ActiveState', '-p', 'NextElapseUSecRealtime', '-p', 'LastTriggerUSec',
    '-p', 'Triggers', '-p', 'TimersCalendar', '-p', 'FragmentPath', '-p', 'DropInPaths',
    '-p', 'Result', '-p', 'ExecMainStartTimestamp', '-p', 'ExecMainStatus']));
  const activates = show.Triggers || inventoryRecord?.activates || unit.replace(/\.timer$/, '.service');
  const serviceShow = parseUnitShow(sh('systemctl', [...args, 'show', activates, '--no-pager',
    '-p', 'UnitFileState', '-p', 'ActiveState', '-p', 'ExecStart', '-p', 'WorkingDirectory',
    '-p', 'FragmentPath', '-p', 'Result', '-p', 'ExecMainStartTimestamp', '-p', 'ExecMainStatus']));
  const unitFileContents = sh('systemctl', [...args, 'cat', unit, activates, '--no-pager']);
  const specifiers = { home: homedir(), user: userInfo().username };
  const execStart = parseExecStart(serviceShow.ExecStart);
  const execPath = execStart.path ? resolveUnitSpecifiers(execStart.path, specifiers) : null;
  const execArgv = execStart.argv.map(arg => resolveUnitSpecifiers(arg, specifiers));
  const scriptPath = execArgv[0] ?? execPath;
  // systemd prefixes a defaulted value with "!" (here: the user manager's
  // home directory because the unit sets no WorkingDirectory).
  const rawWorkingDirectory = String(serviceShow.WorkingDirectory ?? '');
  const workingDirectoryDefaulted = rawWorkingDirectory === '' || rawWorkingDirectory.startsWith('!');
  const declaredWorkingDirectory = workingDirectoryDefaulted
    ? null
    : resolveUnitSpecifiers(rawWorkingDirectory, specifiers);
  const workingDirectory = declaredWorkingDirectory
    ?? (resolveUnitSpecifiers(rawWorkingDirectory.replace(/^!/, ''), specifiers) || homedir());
  const calendar = parseTimersCalendar(show.TimersCalendar);
  const scriptExists = scriptPath ? existsSync(scriptPath) : false;
  const enabled = show.UnitFileState || inventoryRecord?.enabled || null;
  return {
    scope,
    unit,
    activates,
    enabled,
    active: show.ActiveState ?? null,
    next_elapse: show.NextElapseUSecRealtime || inventoryRecord?.next_elapse || null,
    last_trigger: show.LastTriggerUSec || null,
    on_calendar: calendar.map(entry => entry.on_calendar),
    unit_file_path: show.FragmentPath || null,
    unit_file_contents: unitFileContents.startsWith('ERROR:') ? null : unitFileContents,
    timer_show: show,
    service: {
      unit: activates,
      enabled: serviceShow.UnitFileState ?? null,
      active: serviceShow.ActiveState ?? null,
      exec_start: execPath,
      exec_start_argv: execArgv,
      working_directory: workingDirectory,
      working_directory_defaulted: workingDirectoryDefaulted,
      script_path: scriptPath,
      script_exists: scriptExists,
      script_sha256: scriptExists ? await sha256(scriptPath) : null,
      unit_file_path: serviceShow.FragmentPath || null,
      service_show: serviceShow,
    },
  };
}

async function collectScheduling() {
  const user = userInfo().username;
  const userProbe = sh('systemctl', ['--user', 'show-environment']);
  const lingerShow = parseUnitShow(sh('loginctl', ['show-user', user, '-p', 'Linger']));
  const userScope = collectScope('user');
  const systemScope = collectScope('system');
  const errors = [
    ...(userProbe.startsWith('ERROR:') ? [`systemctl --user: ${userProbe}`] : []),
    ...userScope.errors,
    ...systemScope.errors,
  ];

  const ashareTimers = [
    ...userScope.timers.filter(t => isAshareUnit(t.unit)).map(t => ({ ...t, scope: 'user' })),
    ...systemScope.timers.filter(t => isAshareUnit(t.unit)).map(t => ({ ...t, scope: 'system' })),
  ];
  // A unit file can be installed without appearing in list-timers (e.g. a
  // disabled timer); include it so a disabled timer is still recorded and
  // compared instead of looking absent.
  const known = new Set(ashareTimers.map(t => `${t.scope}:${t.unit}`));
  for (const scope of [userScope, systemScope]) {
    for (const file of scope.unitFiles) {
      if (!isAshareUnit(file.unit) || !file.unit.endsWith('.timer')) continue;
      const key = `${scope.scope}:${file.unit}`;
      if (known.has(key)) continue;
      known.add(key);
      ashareTimers.push({ scope: scope.scope, unit: file.unit, activates: null, enabled: file.state, next_elapse: null, last_trigger: null });
    }
  }

  const records = [];
  for (const timer of ashareTimers) records.push(await collectTimer(timer.scope, timer.unit, timer));

  const ashareUnitFiles = scope => scope.unitFiles.filter(f => isAshareUnit(f.unit));
  return summarizeScheduling({
    host: hostname(),
    user,
    linger: lingerShow.Linger ?? null,
    user_manager_available: !userProbe.startsWith('ERROR:'),
    timers: records,
    unit_files: {
      user: ashareUnitFiles(userScope),
      system: ashareUnitFiles(systemScope),
    },
    errors,
  });
}

async function collect() {
  const container = sh('docker', ['inspect', CONTAINER, '--format',
    '{{.Id}}|{{.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}|{{.RestartCount}}']);
  const image = sh('docker', ['image', 'inspect', 'finance-mcp-ashare:local', '--format', '{{.Id}}|{{.Created}}']);
  return {
    captured_at: new Date().toISOString(),
    live_dir: LIVE_DIR,
    live_db: { path: DB, size: existsSync(DB) ? statSync(DB).size : null, sha256: existsSync(DB) ? await sha256(DB) : null },
    container,
    image,
    tables: rowCounts(),
    container_build_files: sh('docker', ['exec', CONTAINER, 'sh', '-c', 'ls /app/build/ashare | sort | tr "\\n" " "']),
    scheduling: await collectScheduling(),
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

async function main(argv) {
  const baselineMode = argv[0] === '--baseline';
  if (!baselineMode && argv.length < 2) {
    process.stderr.write('usage: verify-production-untouched.mjs --baseline BASELINE.json\n'
      + '       verify-production-untouched.mjs BASELINE.json OUTPUT.json\n');
    process.exitCode = 2;
    return;
  }
  const baselinePath = baselineMode ? null : resolve(argv[0]);
  const outputPath = resolve(argv[1]);

  const observed = await collect();

  if (baselineMode) {
    writeFileSync(outputPath, JSON.stringify(observed, null, 2));
    process.stdout.write(JSON.stringify({
      mode: 'baseline',
      output: outputPath,
      live_db_sha256: observed.live_db.sha256,
      tables: observed.tables,
      scheduling: observed.scheduling,
    }) + '\n');
    return;
  }

  if (!existsSync(baselinePath)) throw new Error(`Baseline not found: ${baselinePath}`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const schedulingChecks = compareScheduling(observed.scheduling, baseline.scheduling);
  const checks = {
    live_db_bytes_unchanged: observed.live_db.sha256 === baseline.live_db.sha256,
    live_db_size_unchanged: observed.live_db.size === baseline.live_db.size,
    container_identity_unchanged: observed.container === baseline.container,
    image_unchanged: observed.image === baseline.image,
    table_row_counts_unchanged: same(observed.tables, baseline.tables),
    container_build_unchanged: observed.container_build_files === baseline.container_build_files,
    ...schedulingChecks,
  };
  const result = {
    status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    baseline: {
      captured_at: baseline.captured_at,
      live_db_sha256: baseline.live_db?.sha256,
      container: baseline.container,
      tables: baseline.tables,
      scheduling: baseline.scheduling,
    },
    observed,
    note: 'Read-only evidence. systemd user and system scopes are queried separately: the A-share timer lives in the user manager (~/.config/systemd/user, linger enabled), so a system-scope-only query would wrongly report no timer. The timer must still exist in the same scope, enabled, with the same OnCalendar and ExecStart; a missing timer is a FAIL. The next elapse is recorded but not compared (it moves as the timer fires). The container is inspected, the SQLite file is only hashed, and row counts are queried with a read-only connection. No deploy, restart, timer, notification or ChatGPT task was changed in this round.',
  };
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ status: result.status, output: outputPath, checks }) + '\n');
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
