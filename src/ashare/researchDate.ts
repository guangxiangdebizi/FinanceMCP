import type { DatabaseSync } from 'node:sqlite';

export interface ResearchDateResolution {
  requested_trade_date: string | null;
  as_of_trade_date: string | null;
  latest_closed_trade_date: string | null;
  shanghai_date: string;
  phase: 'PRE_CLOSE' | 'AFTER_CLOSE' | 'NON_TRADING_DAY' | 'CALENDAR_UNAVAILABLE';
  status: 'READY' | 'NOT_READY';
  reason: string | null;
}

/** Resolve the calendar session independently of cached prices; missing bars never move the target back. */
export function resolveResearchDate(db: DatabaseSync | null | undefined, requested?: unknown, now = new Date()): ResearchDateResolution {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid research clock');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (kind: string) => parts.find(item => item.type === kind)!.value;
  const today = `${part('year')}${part('month')}${part('day')}`;
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const raw = requested === undefined || requested === null || requested === '' ? null : String(requested).replace(/-/g, '');
  if (raw !== null && (!/^\d{8}$/.test(raw) || !validYmd(raw))) throw new Error('as_of_trade_date 需要有效的 YYYYMMDD 日期');
  const result: ResearchDateResolution = {
    requested_trade_date: raw, as_of_trade_date: raw, latest_closed_trade_date: null, shanghai_date: today,
    phase: 'CALENDAR_UNAVAILABLE', status: 'NOT_READY', reason: 'trade_calendar_unavailable',
  };
  if (!db) return result;
  try {
    const session = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(today) as any;
    // An explicit historical date remains queryable when the live calendar has not yet been refreshed.
    const historical = raw !== null && raw < today;
    if (!session && !historical) return result;
    const open = session?.is_open === 1;
    const beforeClose = open && minutes < 15 * 60;
    result.phase = !session ? 'CALENDAR_UNAVAILABLE' : !open ? 'NON_TRADING_DAY' : beforeClose ? 'PRE_CLOSE' : 'AFTER_CLOSE';
    const last = db.prepare('SELECT MAX(cal_date) d FROM trade_cal WHERE is_open=1 AND cal_date <= ?')
      .get(beforeClose ? previousDay(today) : today) as any;
    result.latest_closed_trade_date = last?.d ?? null;
    result.as_of_trade_date = raw ?? result.latest_closed_trade_date;
    if (raw !== null) {
      const requestedSession = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(raw) as any;
      if (!requestedSession) { result.reason = 'requested_calendar_date_unknown'; return result; }
      if (requestedSession.is_open !== 1) { result.reason = 'requested_date_not_trading_day'; return result; }
      if (raw > today || (raw === today && beforeClose)) { result.reason = 'session_not_closed'; return result; }
    }
    if (result.as_of_trade_date === null) return result;
    result.status = 'READY';
    result.reason = beforeClose && raw === null ? 'using_latest_closed_session_before_close' : null;
    return result;
  } catch {
    return result;
  }
}

function previousDay(date: string): string {
  const utc = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10).replace(/-/g, '');
}

function validYmd(date: string): boolean {
  const value = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10).replace(/-/g, '') === date;
}
