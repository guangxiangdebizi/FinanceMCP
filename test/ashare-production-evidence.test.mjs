// Phase B P1: production scheduling evidence must be scope-aware.
//
// The A-share timer lives in the systemd USER manager
// (~/.config/systemd/user/finance-ashare-daily.timer), so the old
// system-scope-only query wrongly reported "no A-share timer exists". These
// cases pin the parsers and the comparison: a user-scope timer is found, a
// missing timer FAILs, a disabled timer FAILs, a moved next-elapse passes (it
// moves as the timer fires), and a changed ExecStart or a system-scope-only
// timer FAILs.
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  compareScheduling,
  parseExecStart,
  parseTimers,
  parseTimersCalendar,
  parseUnitFiles,
  parseUnitShow,
  resolveUnitSpecifiers,
  summarizeScheduling,
} = await import('../deploy/ashare/verify-production-untouched.mjs');

const USER_TIMERS = `
NEXT                        LEFT           LAST PASSED UNIT                       ACTIVATES
Mon 2026-10-19 10:41:17 UTC 1 day 10h left n/a  n/a    finance-ashare-daily.timer finance-ashare-daily.service

1 timers listed.
`;

const USER_UNIT_FILES = `
UNIT FILE                        STATE    PRESET
finance-ashare-daily.service     static   -
finance-ashare-daily.timer       enabled  enabled

2 unit files listed.
`;

const TIMERS_CALENDAR = `TimersCalendar={ OnCalendar=Mon..Fri *-*-* 21:10:00 Asia/Shanghai ; next_elapse=Mon 2026-10-19 13:10:00 UTC }
TimersCalendar={ OnCalendar=Mon..Fri *-*-* 18:40:00 Asia/Shanghai ; next_elapse=Mon 2026-10-19 10:40:00 UTC }`;

const TIMER_SHOW = `${TIMERS_CALENDAR}
NextElapseUSecRealtime=Mon 2026-10-19 10:41:17 UTC
LastTriggerUSec=
Triggers=finance-ashare-daily.service
ActiveState=active
FragmentPath=/home/jcshi/.config/systemd/user/finance-ashare-daily.timer
DropInPaths=
UnitFileState=enabled`;

const SERVICE_SHOW = `WorkingDirectory=!/home/jcshi
ExecStart={ path=/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh ; argv[]=/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh ; ignore_errors=no ; start_time=[Fri 2026-10-16 23:45:32 UTC] ; stop_time=[Fri 2026-10-16 23:45:33 UTC] ; pid=2154036 ; code=exited ; status=0 }
ActiveState=inactive
UnitFileState=static`;

const SCRIPT_SHA = 'a15ba73022271b54930bccb71199294f7efa5d92dfae6d17581b4e9a21c1176a';

function fixture({
  scope = 'user',
  timersText = USER_TIMERS,
  unitFilesText = USER_UNIT_FILES,
  timerShow = TIMER_SHOW,
  serviceShow = SERVICE_SHOW,
  unit = 'finance-ashare-daily.timer',
} = {}) {
  const timers = parseTimers(timersText)
    .filter(t => /ashare/i.test(t.unit))
    .map(t => ({ ...t, scope }));
  const show = parseUnitShow(timerShow);
  const service = parseUnitShow(serviceShow);
  const execStart = parseExecStart(service.ExecStart);
  return summarizeScheduling({
    host: 'foodfactory-vm',
    user: 'jcshi',
    linger: 'yes',
    user_manager_available: true,
    timers: timers.map(t => ({
      ...t,
      unit: unit ?? t.unit,
      enabled: show.UnitFileState ?? null,
      active: show.ActiveState ?? null,
      next_elapse: show.NextElapseUSecRealtime || t.next_elapse,
      last_trigger: show.LastTriggerUSec || null,
      on_calendar: parseTimersCalendar(show.TimersCalendar).map(e => e.on_calendar),
      unit_file_path: show.FragmentPath ?? null,
      service: {
        exec_start: resolveUnitSpecifiers(execStart.path, { home: '/home/jcshi', user: 'jcshi' }),
        exec_start_argv: execStart.argv,
        working_directory: '/home/jcshi',
        script_path: execStart.argv[0],
        script_exists: true,
        script_sha256: SCRIPT_SHA,
      },
    })),
    unit_files: { user: parseUnitFiles(unitFilesText).filter(f => /ashare/i.test(f.unit)), system: [] },
  });
}

test('parseTimers reads the user-scope row without the pretty column widths', () => {
  const timers = parseTimers(USER_TIMERS);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unit, 'finance-ashare-daily.timer');
  assert.equal(timers[0].activates, 'finance-ashare-daily.service');
  assert.equal(timers[0].next_elapse, 'Mon 2026-10-19 10:41:17 UTC');
  assert.equal(timers[0].last_trigger, null);
});

test('parseTimers handles a real system-scope listing with padded columns', () => {
  const text = `NEXT                        LEFT          LAST                        PASSED       UNIT                                             ACTIVATES
Sun 2026-10-18 00:35:54 UTC 9min left     Sun 2026-10-18 00:11:26 UTC 15min ago    man-db.timer                                     man-db.service
n/a                         n/a           n/a                         n/a          ua-timer.timer                                   ua-timer.service

16 timers listed.
`;
  const timers = parseTimers(text);
  assert.deepEqual(timers.map(t => t.unit), ['man-db.timer', 'ua-timer.timer']);
  assert.equal(timers[1].next_elapse, null);
});

test('parseUnitShow keeps repeated keys and parses ExecStart / TimersCalendar', () => {
  const show = parseUnitShow(TIMERS_CALENDAR);
  assert.equal(show.TimersCalendar.length, 2);
  const calendar = parseTimersCalendar(show.TimersCalendar).map(e => e.on_calendar).sort();
  assert.deepEqual(calendar, [
    'Mon..Fri *-*-* 18:40:00 Asia/Shanghai',
    'Mon..Fri *-*-* 21:10:00 Asia/Shanghai',
  ]);
  const exec = parseExecStart(parseUnitShow(SERVICE_SHOW).ExecStart);
  assert.equal(exec.path, '/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh');
  assert.deepEqual(exec.argv, ['/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh']);
});

test('summarizeScheduling records a user-scope timer unambiguously', () => {
  const s = fixture();
  assert.equal(s.a_share_timers_found, true);
  assert.equal(s.scope, 'user');
  assert.equal(s.timer_unit, 'finance-ashare-daily.timer');
  assert.equal(s.service_unit, 'finance-ashare-daily.service');
  assert.equal(s.enabled, 'enabled');
  assert.equal(s.next_elapse, 'Mon 2026-10-19 10:41:17 UTC');
  assert.equal(s.next_elapse_iso, '2026-10-19T10:41:17.000Z');
  assert.equal(s.last_trigger, null);
  assert.equal(s.unit_file_path, '/home/jcshi/.config/systemd/user/finance-ashare-daily.timer');
  assert.equal(s.exec_start, '/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh');
  assert.equal(s.script_sha256, SCRIPT_SHA);
});

test('a user-scope timer passes the scope-aware checks', () => {
  const observed = fixture();
  const baseline = fixture();
  const checks = compareScheduling(observed, baseline);
  assert.equal(Object.values(checks).every(Boolean), true, JSON.stringify(checks));
  assert.equal(checks.ashare_timer_scope, true);
});

test('no A-share timer at all is a FAIL, never a silent pass', () => {
  const observed = summarizeScheduling({
    host: 'foodfactory-vm', user: 'jcshi', linger: 'yes', user_manager_available: true,
    timers: [], unit_files: { user: [], system: [] },
  });
  const baseline = fixture();
  assert.equal(observed.a_share_timers_found, false);
  const checks = compareScheduling(observed, baseline);
  assert.equal(checks.a_share_timers_found, false);
  assert.equal(checks.ashare_timer_inventory_unchanged, false);
  assert.equal(checks.ashare_timer_scope, false);
});

test('a timer present only in the system scope does not match a user-scope baseline', () => {
  const observed = fixture({ scope: 'system' });
  const baseline = fixture({ scope: 'user' });
  assert.equal(observed.a_share_timers_found, true);
  assert.equal(observed.scope, 'system');
  const checks = compareScheduling(observed, baseline);
  assert.equal(checks.ashare_timer_inventory_unchanged, false);
  assert.equal(checks.ashare_timer_scope, false);
});

test('a disabled timer FAILs', () => {
  const observed = fixture({ timerShow: TIMER_SHOW.replace('UnitFileState=enabled', 'UnitFileState=disabled') });
  const baseline = fixture();
  const checks = compareScheduling(observed, baseline);
  assert.equal(observed.enabled, 'disabled');
  assert.equal(checks.ashare_timer_enabled, false);
  assert.equal(checks.ashare_timer_inventory_unchanged, false);
});

test('a moved next elapse is recorded but does not FAIL the comparison', () => {
  const observed = fixture({ timerShow: TIMER_SHOW.replace('Mon 2026-10-19 10:41:17 UTC', 'Tue 2026-10-20 10:41:03 UTC') });
  const baseline = fixture();
  assert.equal(observed.next_elapse, 'Tue 2026-10-20 10:41:03 UTC');
  const checks = compareScheduling(observed, baseline);
  assert.equal(Object.values(checks).every(Boolean), true, JSON.stringify(checks));
});

test('a changed ExecStart FAILs', () => {
  const moved = SERVICE_SHOW.replaceAll(
    '/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh',
    '/home/jcshi/workspace/FinanceMCP-v2/deploy/ashare/run-daily.sh',
  );
  const observed = fixture({ serviceShow: moved });
  const baseline = fixture();
  assert.notEqual(observed.exec_start, baseline.exec_start);
  const checks = compareScheduling(observed, baseline);
  assert.equal(checks.ashare_timer_exec_start_unchanged, false);
  assert.equal(checks.ashare_timer_script_unchanged, false);
});

test('a changed OnCalendar FAILs', () => {
  const observed = fixture({
    timerShow: `${TIMER_SHOW}\nTimersCalendar={ OnCalendar=Mon..Fri *-*-* 19:00:00 Asia/Shanghai ; next_elapse=Mon 2026-10-19 11:00:00 UTC }`,
  });
  const baseline = fixture();
  assert.notDeepEqual(observed.on_calendar, baseline.on_calendar);
  const checks = compareScheduling(observed, baseline);
  assert.equal(checks.ashare_timer_schedule_unchanged, false);
});

test('resolveUnitSpecifiers expands %h and %u for the user manager', () => {
  assert.equal(
    resolveUnitSpecifiers('%h/workspace/FinanceMCP/deploy/ashare/run-daily.sh', { home: '/home/jcshi', user: 'jcshi' }),
    '/home/jcshi/workspace/FinanceMCP/deploy/ashare/run-daily.sh',
  );
  assert.equal(resolveUnitSpecifiers('%%h', { home: '/home/jcshi' }), '%h');
});
