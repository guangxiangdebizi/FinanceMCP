import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { resolveResearchDate } from '../build/ashare/researchDate.js';

function calendar() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE trade_cal(cal_date TEXT PRIMARY KEY,is_open INTEGER)');
  for (const [date, open] of [['20260930',1],['20261001',0],['20261008',1],['20261016',1],['20261017',0],['20261018',0],['20261019',1],['20261020',1],['20261021',1]]) {
    db.prepare('INSERT INTO trade_cal VALUES(?,?)').run(date,open);
  }
  return db;
}

test('pre-open and intraday default to last closed session, not missing today close', () => {
  const db = calendar();
  try {
    for (const iso of ['2026-10-21T00:58:00Z','2026-10-21T06:59:00Z']) {
      const result = resolveResearchDate(db, undefined, new Date(iso));
      assert.equal(result.as_of_trade_date,'20261020');
      assert.equal(result.phase,'PRE_CLOSE');
      assert.equal(result.status,'READY');
    }
  } finally { db.close(); }
});

test('explicit unclosed session is refused, never replaced or fabricated', () => {
  const db = calendar();
  try {
    const result = resolveResearchDate(db,'20261021',new Date('2026-10-21T01:00:00Z'));
    assert.equal(result.as_of_trade_date,'20261021');
    assert.equal(result.status,'NOT_READY');
    assert.equal(result.reason,'session_not_closed');
  } finally { db.close(); }
});

test('after close targets today even with no cached prices; calendar drives readiness target', () => {
  const db = calendar();
  try {
    const result = resolveResearchDate(db,undefined,new Date('2026-10-21T07:00:00Z'));
    assert.equal(result.as_of_trade_date,'20261021');
    assert.equal(result.phase,'AFTER_CLOSE');
  } finally { db.close(); }
});

test('weekends and holidays resolve calendar trading days; explicit closure rejected', () => {
  const db = calendar();
  try {
    assert.equal(resolveResearchDate(db,undefined,new Date('2026-10-18T13:40:00Z')).as_of_trade_date,'20261016');
    assert.equal(resolveResearchDate(db,undefined,new Date('2026-10-01T13:40:00Z')).as_of_trade_date,'20260930');
    assert.equal(resolveResearchDate(db,'20261018',new Date('2026-10-21T00:00:00Z')).reason,'requested_date_not_trading_day');
  } finally { db.close(); }
});

test('invalid dates rejected; missing calendar stays unavailable', () => {
  const db=calendar();
  try {
    assert.throws(()=>resolveResearchDate(db,'20260230'),/有效/);
    assert.equal(resolveResearchDate(null).status,'NOT_READY');
    assert.equal(resolveResearchDate(db,undefined,new Date('2026-10-22T00:00:00Z')).reason,'trade_calendar_unavailable');
  } finally { db.close(); }
});
