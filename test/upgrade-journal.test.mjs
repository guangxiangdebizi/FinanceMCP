import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
const root = process.env.UPGRADE_BUILD_DIR ?? resolve('build');
const journal = await import(pathToFileURL(resolve(root, 'portfolio/researchJournal.js')).href);
const record = (id = 'r1', extra = {}) => ({
  record_id: id, account_id: 'synthetic', source: 'vps', as_of_trade_date: '20261001',
  bundle_id: 'bundle-1', generated_at: '2026-10-01T21:40:00+08:00', versions: { rules: 'v1' },
  judgement: { conclusion: 'observe' }, candidates: ['510500.SH'],
  observations: [{ ts_code: '510500.SH', quantity: 100, trigger_price_milli: 1050, invalidation_price_milli: 900 }], evidence: [], ...extra,
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE trade_cal(cal_date TEXT PRIMARY KEY,is_open INTEGER);
    CREATE TABLE fund_daily(ts_code TEXT,trade_date TEXT,close REAL,high REAL,low REAL,PRIMARY KEY(ts_code,trade_date));
    CREATE TABLE fund_adj(ts_code TEXT,trade_date TEXT,adj_factor REAL,PRIMARY KEY(ts_code,trade_date));`);
  const days = ['20261001', '20261002', '20261005', '20261006', '20261007', '20261008', '20261009'];
  days.forEach((date, i) => {
    db.prepare('INSERT INTO trade_cal VALUES (?,1)').run(date);
    for (const code of ['510500.SH', '510300.SH']) {
      const close = 1 + i * (code === '510500.SH' ? 0.02 : 0.01);
      db.prepare('INSERT INTO fund_daily VALUES (?,?,?,?,?)').run(code, date, close, close + 0.01, close - 0.01);
      db.prepare('INSERT INTO fund_adj VALUES (?,?,1)').run(code, date);
    }
  });
  const feeEstimator = () => ({ total_cents: 100, estimated: true, version: 'synthetic-v1' });
  return { db, feeEstimator, evaluate: (extra = {}) => journal.evaluateResearchJournal({ portfolioDb: db, marketDb: db, accountId: 'synthetic', asOf: '20261008', horizons: [5], feeEstimator, ...extra }) };
}
test('journal imports are canonical, immutable, account isolated and corrections append', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(journal.listResearchJournal(db, { accountId: 'synthetic' }).length, 0);
    assert.equal(journal.recordResearchJournal(db, record()).created, true);
    assert.equal(journal.recordResearchJournal(db, record('r1', { versions: { rules: 'v1' } })).created, false);
    assert.throws(() => journal.recordResearchJournal(db, record('r1', { judgement: 'rewritten' })), /journal_id_conflict/);
    assert.throws(() => db.exec("UPDATE research_journal SET content_json='{}'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM research_journal'), /immutable/);
    assert.equal(journal.recordResearchJournal(db, record('r2', { correction_of: 'r1', judgement: 'corrected' })).created, true);
    assert.equal(journal.listResearchJournal(db, { accountId: 'other' }).length, 0);
    assert.deepEqual(journal.readResearchJournal(db, 'r1').judgement, { conclusion: 'observe' });
    assert.throws(() => journal.recordResearchJournal(db, record('r3', { account_id: 'other', correction_of: 'r1' })), /same account/);
  } finally { db.close(); }
});
test('ChatGPT and combined results require real provenance and actual source parents', () => {
  const db = new DatabaseSync(':memory:');
  const provenance = { author: 'external researcher', source_reference: 'actual-import-reference', obtained_at: '2026-10-01T21:45:00+08:00' };
  try {
    journal.recordResearchJournal(db, record());
    assert.throws(() => journal.recordResearchJournal(db, record('chat', { source: 'chatgpt' })), /provenance/);
    assert.throws(() => journal.recordResearchJournal(db, record('combined', { source: 'combined', provenance, parent_record_ids: ['r1'] })), /actual VPS and ChatGPT/);
    journal.recordResearchJournal(db, record('chat', { source: 'chatgpt', provenance }));
    journal.recordResearchJournal(db, record('combined', { source: 'combined', provenance, parent_record_ids: ['r1', 'chat'] }));
    assert.deepEqual(new Set(journal.listResearchJournal(db, { accountId: 'synthetic' }).map(row => row.source)), new Set(['vps', 'chatgpt', 'combined']));
  } finally { db.close(); }
});
test('evaluation matures on trading sessions, deducts costs and uses exact benchmark window', () => {
  const { db, evaluate } = fixture();
  try {
    journal.recordResearchJournal(db, record());
    const early = evaluate({ asOf: '20261007' })[0];
    assert.equal(early.status, 'PENDING');
    assert.equal(early.maturity_date, '20261008');
    const result = evaluate()[0];
    assert.equal(result.status, 'EVALUATED');
    assert.equal(result.observations[0].gross_return_pct, 10);
    assert.equal(result.observations[0].net_return_pct, 7.9208);
    assert.equal(result.observations[0].fees_cents, 200);
    assert.equal(result.observations[0].trigger, 'TRIGGERED');
    assert.equal(result.observations[0].invalidation, 'NOT_INVALIDATED');
    assert.ok(result.observations[0].excess_return_pct > 0);
    assert.deepEqual(journal.recordJournalEvaluations(db, [result]), { created: 1, existing: 0 });
    assert.deepEqual(journal.recordJournalEvaluations(db, [result]), { created: 0, existing: 1 });
    assert.throws(() => db.exec('DELETE FROM research_journal_evaluation'), /immutable/);
  } finally { db.close(); }
});
test('missing fees, intermediate prices, benchmark or factors never silently shorten an evaluation', () => {
  const { db, evaluate } = fixture();
  try {
    journal.recordResearchJournal(db, record());
    assert.equal(evaluate({ feeEstimator: undefined })[0].observations[0].reason, 'fee_rules_unavailable');
    db.prepare('DELETE FROM fund_daily WHERE ts_code=? AND trade_date=?').run('510300.SH', '20261005');
    assert.equal(evaluate()[0].observations[0].reason, 'benchmark_exact_window_unavailable');
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run('510500.SH', '20261005');
    assert.equal(evaluate()[0].observations[0].reason, 'adjustment_factor_missing');
    db.prepare('DELETE FROM fund_daily WHERE ts_code=? AND trade_date=?').run('510500.SH', '20261005');
    assert.equal(evaluate()[0].observations[0].reason, 'missing_exact_window_price');
    assert.equal(journal.readResearchJournal(db, 'r1').bundle_id, 'bundle-1');
  } finally { db.close(); }
});
test('corporate actions and backdated results are unavailable, never hypothetical successful predictions', () => {
  const { db, evaluate } = fixture();
  try {
    journal.recordResearchJournal(db, record());
    db.prepare('UPDATE fund_adj SET adj_factor=2 WHERE ts_code=? AND trade_date=?').run('510500.SH', '20261008');
    assert.equal(evaluate()[0].observations[0].reason, 'corporate_action_cashflows_unavailable');
    journal.recordResearchJournal(db, record('late', { generated_at: '2026-10-08T21:40:00+08:00' }));
    assert.equal(evaluate().find(row => row.record_id === 'late').reason, 'retrospective_record_not_prospective');
  } finally { db.close(); }
});
