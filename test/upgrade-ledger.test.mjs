import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseTradeCsv, decimalToInteger } from '../build/portfolio/tradeImport.js';
import { PORTFOLIO_LEDGER_SCHEMA, PORTFOLIO_COMPLETENESS_SCHEMA } from '../build/portfolio/db.js';
import { importEvents, initBaseline, replayAccount, setAccountCompleteness, readAccountCompleteness } from '../build/portfolio/ledger.js';
import { resolveAccountId, resolveAccountSnapshot, resolveAccountState } from '../build/portfolio/accounts.js';

const header = '流水号,成交日期,业务名称,证券代码,成交数量,成交价格,成交金额,佣金,印花税,资金发生额';
const csv = `${header}\r\nfill-1,2026-10-19,买入,159999,100,1.250,125.00,0.01,0,-125.01\r\nfill-2,2026-10-20,卖出,159999,100,1.350,135.00,0.02,0,134.98\r\n`;
function fixture() {
  const d = new DatabaseSync(':memory:');
  d.exec(PORTFOLIO_LEDGER_SCHEMA); d.exec(PORTFOLIO_COMPLETENESS_SCHEMA);
  d.exec(`CREATE TABLE account_snapshot(snapshot_id TEXT PRIMARY KEY, as_of TEXT,source TEXT,note TEXT,warnings TEXT,is_current INTEGER,total_assets_cents INTEGER,securities_mv_cents INTEGER,cash_cents INTEGER,wealth_cents INTEGER,unrealized_pnl_cents INTEGER,created_at TEXT);
    CREATE TABLE position(snapshot_id TEXT,ts_code TEXT,name TEXT,quantity INTEGER,ref_price_milli INTEGER,ref_cost_milli INTEGER,market_value_cents INTEGER);`);
  d.prepare('INSERT INTO account_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('baseline', '2026-10-16', 'synthetic', '', '[]', 0, 100000, 0, 100000, 0, 0, '2026-10-16');
  initBaseline(d, 'synthetic', { asOf: '20261016', snapshotId: 'baseline' });
  return d;
}

test('CSV parses fixed-point broker facts; repeated imports do not duplicate cash or fees', () => {
  const d = fixture();
  try {
    const parsed = parseTradeCsv('﻿' + csv, { accountId: 'synthetic', brokerId: 'fixture' });
    assert.equal(parsed.events[0].price_milli, 1250);
    assert.equal(parsed.events[0].fee_cents, 1);
    assert.equal(importEvents(d, 'synthetic', parsed.events).counts.recorded, 2);
    assert.equal(importEvents(d, 'synthetic', parsed.events).counts.duplicate, 2);
    const replay = replayAccount(d, 'synthetic', { asOf: '20261021' });
    assert.equal(replay.cash.balance_cents, 100997);
    assert.equal(replay.totals.fees_cents, 3);
    assert.equal(replay.positions.filter(p => p.quantity > 0).length, 0);
  } finally { d.close(); }
});

test('CSV missing fee/id and content conflicts fail closed; decimals do not use float multiplication', () => {
  assert.equal(decimalToInteger('0.29', 2, 'amount'), 29);
  assert.throws(() => decimalToInteger('0.001', 2, 'amount'), /precision/);
  assert.throws(() => parseTradeCsv(csv.replace('0.01,0', ',0'), { accountId: 'synthetic' }), /explicit/);
  assert.throws(() => parseTradeCsv(csv.replace('fill-1,', ','), { accountId: 'synthetic' }), /stable/);
  assert.throws(() => parseTradeCsv(`${csv}fill-1,2026-10-19,买入,159999,100,1.260,126.00,0.01,0,-126.01\n`, { accountId: 'synthetic' }), /Conflicting/);
});

test('event-derived view includes new securities and cash, and new facts invalidate completeness', () => {
  const d = fixture();
  try {
    setAccountCompleteness(d, 'synthetic', { as_of: '20261021', reported_events_through: '20261021', unreported_trade_risk: false }, { confirm: true, recordedBy: 'fixture' });
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events.slice(0, 1);
    importEvents(d, 'synthetic', events);
    assert.equal(readAccountCompleteness(d, 'synthetic').unreported_trade_risk, true);
    const state = resolveAccountState(d, 'synthetic', '20261021');
    assert.equal(state.snapshot.positions[0].quantity, 100);
    assert.equal(state.snapshot.positions[0].ts_code, '159999.SZ');
    assert.equal(state.snapshot.totals.cash_cents, 87499);
    assert.equal(state.reconstruction.basis, 'baseline_plus_events');
    assert.equal(d.prepare('SELECT cash_cents FROM account_snapshot').get().cash_cents, 100000);
    setAccountCompleteness(d, 'synthetic', { as_of: '20261021', reported_events_through: '20261021', unreported_trade_risk: false }, { confirm: true, recordedBy: 'fixture' });
    importEvents(d, 'synthetic', events);
    assert.equal(readAccountCompleteness(d, 'synthetic').unreported_trade_risk, false);
  } finally { d.close(); }
});

test('unknown or multiple accounts and foreign explicit snapshots are rejected', () => {
  const d = fixture();
  try {
    assert.equal(resolveAccountId(d).account_id, 'synthetic');
    assert.throws(() => resolveAccountId(d, 'missing'), /account_not_configured/);
    d.prepare('INSERT INTO account_snapshot SELECT ?,as_of,source,note,warnings,is_current,total_assets_cents,securities_mv_cents,cash_cents,wealth_cents,unrealized_pnl_cents,created_at FROM account_snapshot WHERE snapshot_id=?').run('foreign', 'baseline');
    initBaseline(d, 'other', { asOf: '20261016', snapshotId: 'foreign' });
    assert.throws(() => resolveAccountId(d), /account_selection_required/);
    assert.throws(() => resolveAccountSnapshot(d, 'synthetic', 'foreign'), /not associated/);
  } finally { d.close(); }
});
