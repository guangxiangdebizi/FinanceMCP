import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { initBaseline } = await import('../build/portfolio/ledger.js');
const { recordVpsResearchSnapshot } = await import('../build/portfolio/researchRecord.js');
const { appendChatgptResearchRecord, parseIntakeArgs, INTAKE_LIMITS } = await import('../build/portfolio/chatgptIntake.js');
const { readResearchJournal, listResearchJournal } = await import('../build/portfolio/researchJournal.js');
const { buildForwardReview } = await import('../build/portfolio/forwardReview.js');
const { getPrivateToolList, getAvailableToolList } = await import('../build/dispatch.js');

const TOOL = 'ashare_chatgpt_research_record_append';
const ACCOUNT = 'synthetic-intake';
const dir = mkdtempSync(join(tmpdir(), 'chatgpt-intake-'));
const MARKET_DB = join(dir, 'ashare.sqlite');
const PORTFOLIO_DB = join(dir, 'portfolio.sqlite');
const TOKEN = 'intake-test-token-0123456789';
const at = (ymd, hm = '12:00') => Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T${hm}:00+08:00`);
const shanghaiToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

let seq = 0;
function fresh() {
  const file = join(dir, `portfolio-${seq += 1}.sqlite`);
  const imported = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: file },
  });
  assert.equal(imported.status, 0, imported.stderr);
  const db = openPortfolioDb(file, { marketPath: MARKET_DB });
  initBaseline(db, ACCOUNT, { asOf: '20261018', snapshotId: 'demo-2026-10-18' });
  db.file = file;
  return db;
}
function vps(db, asOf, reportId) {
  recordVpsResearchSnapshot({ portfolioDb: db, accountId: ACCOUNT, bundle: { report_id: reportId, as_of_trade_date: asOf, status: 'READY', generated_at: `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6)}T18:00:00+08:00` } });
  return db;
}
const seeded = (asOf, reportId = 'RPT-1') => vps(fresh(), asOf, reportId);
// The journal stamps recorded_at from the process clock, so tests pin the clock to the simulated receipt time.
function appendAt(db, account, args, nowMs, limit) {
  const ActualDate = globalThis.Date;
  globalThis.Date = class extends ActualDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
  };
  try { return appendChatgptResearchRecord(db, account, args, nowMs, limit); } finally { globalThis.Date = ActualDate; }
}
const body = (extra = {}) => ({
  report_id: 'RPT-1', as_of_trade_date: '20261022',
  independent_judgement: '独立判断：行业估值偏高，保持观察。', final_conclusion: '维持观察，不构成交易建议。',
  additional_evidence: [{ claim: '央行公开市场操作净投放', kind: 'macro', source_url: 'https://example.com/a', published_at: '2026-10-22' }],
  counter_evidence: [{ claim: '行业景气度超预期的可能', source_url: 'https://example.com/b', published_at: '2026-10-21T10:00:00+08:00' }],
  ...extra,
});
const NOW = at('20261022', '20:00');
const counts = db => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
  .filter(t => !/^research_journal/.test(t.name)).map(t => [t.name, db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get().n]));

test('append is source-fixed, server-timed, linked to the VPS bundle, idempotent and returns only ids', () => {
  const db = seeded('20261022');
  try {
    const before = counts(db);
    const first = appendAt(db, ACCOUNT, body(), NOW);
    assert.deepEqual(Object.keys(first).sort(), ['content_hash', 'created', 'evidence_class', 'record_id']);
    assert.equal(first.created, true);
    assert.equal(first.evidence_class, 'TRUE_FORWARD');
    const stored = readResearchJournal(db, first.record_id);
    assert.equal(stored.source, 'chatgpt');
    assert.equal(stored.bundle_id, 'RPT-1');
    assert.equal(stored.generated_at, new Date(NOW).toISOString());
    assert.equal(stored.provenance.obtained_at, new Date(NOW).toISOString());
    assert.deepEqual(stored.observations, []);
    assert.equal(stored.parent_record_ids.length, 1);
    assert.match(stored.parent_record_ids[0], /^VPS-RPT-1-/);
    assert.equal(stored.evidence.length, 2);
    const again = appendAt(db, ACCOUNT, body(), NOW + 60000);
    assert.deepEqual({ ...again, created: true }, first);
    assert.equal(again.created, false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n, 1);
    assert.deepEqual(counts(db), before, 'ledger/holdings/policy/completeness tables are untouched');
  } finally { db.close(); }
});

test('forged source, timestamps, ids, hashes and forbidden account fields are rejected', () => {
  const db = seeded('20261022');
  try {
    const before = counts(db);
    for (const field of ['source', 'created_at', 'recorded_at', 'generated_at', 'record_id', 'content_hash', 'provenance', 'observations', 'positions', 'holdings',
      'events', 'ledger_events', 'account_completeness', 'orders', 'risk_policy', 'fees', 'payload', 'parent_record_ids', 'correction_of']) {
      assert.throws(() => appendAt(db, ACCOUNT, body({ [field]: field === 'source' ? 'vps' : [] }), NOW), /not accepted/, field);
    }
    assert.throws(() => appendAt(db, ACCOUNT, body({ additional_evidence: [{ claim: 'x', source_url: 'https://e.com', published_at: '2026-10-22', quantity: 100 }] }), NOW), /not accepted/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n, 0);
    assert.deepEqual(counts(db), before);
  } finally { db.close(); }
});

test('the bundle must exist and match; the date cannot be in the future; evidence needs real sources', () => {
  const db = seeded('20261022');
  try {
    assert.throws(() => appendAt(db, ACCOUNT, body({ report_id: 'NOPE' }), NOW), /bundle_not_found/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ as_of_trade_date: '20261021' }), NOW), /bundle_not_found/);
    assert.throws(() => appendAt(db, 'other-account', body(), NOW), /bundle_not_found/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ as_of_trade_date: '20261023' }), NOW), /later than today/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ additional_evidence: [{ claim: 'c', published_at: '2026-10-22' }] }), NOW), /source_url is required/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ additional_evidence: [{ claim: 'c', source_url: 'https://e.com' }] }), NOW), /published_at is required/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ additional_evidence: [{ claim: 'c', source_url: 'javascript:alert(1)', published_at: '2026-10-22' }] }), NOW), /http\(s\)/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ additional_evidence: [{ claim: 'c', source_url: 'https://e.com', published_at: '2026-12-01' }] }), NOW), /future/);
    assert.throws(() => appendAt(db, ACCOUNT, body({ independent_judgement: '  ' }), NOW), /required/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n, 0);
  } finally { db.close(); }
  const empty = new DatabaseSync(':memory:');
  assert.throws(() => appendAt(empty, ACCOUNT, body(), NOW), /bundle_not_found/);
  assert.equal(empty.prepare("SELECT COUNT(*) n FROM sqlite_master").get().n, 0, 'a refused call creates nothing');
});

test('size and count limits', () => {
  const ok = (extra) => parseIntakeArgs(body(extra), NOW);
  assert.throws(() => ok({ independent_judgement: 'x'.repeat(INTAKE_LIMITS.textChars + 1) }), /exceeds/);
  assert.throws(() => ok({ final_conclusion: 'x'.repeat(INTAKE_LIMITS.textChars + 1) }), /exceeds/);
  const item = { claim: 'c', source_url: 'https://e.com/x', published_at: '2026-10-22' };
  assert.throws(() => ok({ additional_evidence: Array(INTAKE_LIMITS.evidenceItems + 1).fill(item) }), /exceeds 20 items/);
  assert.throws(() => ok({ counter_evidence: Array(INTAKE_LIMITS.counterItems + 1).fill(item) }), /exceeds 10 items/);
  assert.throws(() => ok({ additional_evidence: [{ ...item, claim: 'x'.repeat(INTAKE_LIMITS.claimChars + 1) }] }), /exceeds/);
  assert.throws(() => ok({ idempotency_key: 'bad key!' }), /idempotency_key/);
  // 20 evidence items * 1000 chars + two 4000 texts is within the byte cap; push past it with long URLs/claims
  const fat = { claim: 'x'.repeat(1000), source_url: `https://e.com/${'a'.repeat(450)}`, published_at: '2026-10-22' };
  assert.throws(() => ok({ independent_judgement: 'y'.repeat(4000), final_conclusion: 'z'.repeat(4000), additional_evidence: Array(20).fill(fat), counter_evidence: Array(10).fill(fat) }), /bytes/);
  assert.ok(ok());
});

test('same key + same content is idempotent, same key + different content conflicts, corrections append', () => {
  const db = seeded('20261022');
  try {
    const a = appendAt(db, ACCOUNT, body({ idempotency_key: 'k1' }), NOW);
    assert.equal(appendAt(db, ACCOUNT, body({ idempotency_key: 'k1' }), NOW + 1000).created, false);
    assert.throws(() => appendAt(db, ACCOUNT, body({ idempotency_key: 'k1', final_conclusion: '改口' }), NOW), /journal_id_conflict/);
    assert.equal(readResearchJournal(db, a.record_id).judgement.final_conclusion, '维持观察，不构成交易建议。', 'the original is never rewritten');
    assert.throws(() => appendAt(db, ACCOUNT, body({ idempotency_key: 'k2', corrects_record_id: 'VPS-missing' }), NOW), /existing ChatGPT record/);
    const vpsId = readResearchJournal(db, a.record_id).parent_record_ids[0];
    assert.throws(() => appendAt(db, ACCOUNT, body({ idempotency_key: 'k2', corrects_record_id: vpsId }), NOW), /existing ChatGPT record/, 'VPS records cannot be "corrected" by ChatGPT');
    const fix = appendAt(db, ACCOUNT, body({ idempotency_key: 'k2', final_conclusion: '更正后的结论', corrects_record_id: a.record_id }), NOW + 5000);
    assert.equal(fix.created, true);
    assert.notEqual(fix.record_id, a.record_id);
    assert.equal(readResearchJournal(db, fix.record_id).correction_of, a.record_id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n, 2);
    assert.throws(() => db.exec("UPDATE research_journal SET content_json='{}' WHERE source='chatgpt'"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM research_journal WHERE source='chatgpt'"), /immutable/);
  } finally { db.close(); }
});

test('classification: TRUE_FORWARD only for the same Shanghai day on/after 20261022, otherwise RETROSPECTIVE_RECORD', () => {
  const db = seeded('20261022', 'RPT-A');
  vps(db, '20261023', 'RPT-B'); vps(db, '20261021', 'RPT-C');
  try {
    const same = appendAt(db, ACCOUNT, body({ report_id: 'RPT-A' }), at('20261022', '23:59'));
    assert.equal(same.evidence_class, 'TRUE_FORWARD');
    const late = appendAt(db, ACCOUNT, body({ report_id: 'RPT-A', idempotency_key: 'late' }), at('20261023', '00:05'));
    assert.equal(late.evidence_class, 'RETROSPECTIVE_RECORD');
    const pre = appendAt(db, ACCOUNT, body({ report_id: 'RPT-C', as_of_trade_date: '20261021', additional_evidence: [], counter_evidence: [] }), at('20261021', '21:00'));
    assert.notEqual(pre.evidence_class, 'TRUE_FORWARD', 'before the freeze date it is historical');
    const day2 = appendAt(db, ACCOUNT, body({ report_id: 'RPT-B', as_of_trade_date: '20261023' }), at('20261023', '19:00'));
    assert.equal(day2.evidence_class, 'TRUE_FORWARD');
    // forwardReview consumes the chatgpt source separately and counts only the forward ones in by_source.
    const review = buildForwardReview({ portfolioDb: db, marketDb: null, accountId: ACCOUNT, asOf: '20261023', horizons: [5] });
    assert.equal(review.records.by_source.chatgpt, 4);
    assert.equal(review.records.by_source.vps, 3);
    assert.deepEqual(Object.keys(review.by_source).sort(), ['chatgpt', 'vps']);
    assert.deepEqual(review.pre_forward_excluded.filter(r => r.source === 'chatgpt').map(r => r.class).sort(), ['PRE_FORWARD_HISTORICAL', 'RETROSPECTIVE_RECORD']);
  } finally { db.close(); }
});

test('daily cap applies to new records only', () => {
  const db = seeded('20261022', 'RPT-D');
  try {
    appendAt(db, ACCOUNT, body({ report_id: 'RPT-D', idempotency_key: 'a' }), NOW, 2);
    appendAt(db, ACCOUNT, body({ report_id: 'RPT-D', idempotency_key: 'b' }), NOW, 2);
    assert.throws(() => appendAt(db, ACCOUNT, body({ report_id: 'RPT-D', idempotency_key: 'c' }), NOW, 2), /rate_limited/);
    assert.equal(appendAt(db, ACCOUNT, body({ report_id: 'RPT-D', idempotency_key: 'a' }), NOW, 2).created, false);
  } finally { db.close(); }
});

test('schema lists exactly one append-only tool privately and nothing publicly', () => {
  const priv = getPrivateToolList();
  const writers = priv.filter(t => t.annotations.readOnlyHint !== true);
  assert.deepEqual(writers.map(t => t.name), [TOOL]);
  const schema = writers[0].inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['account_id', 'additional_evidence', 'corrects_record_id', 'counter_evidence', 'final_conclusion',
    'idempotency_key', 'independent_judgement', 'as_of_trade_date', 'report_id'].sort());
  assert.equal(writers[0].annotations.destructiveHint, false);
  assert.ok(!getAvailableToolList().some(t => t.name === TOOL));
});

// ------------------------------------------------------------- HTTP: auth, public isolation, end to end
async function reservePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}
async function startServer(env = {}) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '', NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB, ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PRIVATE_RATE_LIMIT: '1000', ...env },
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (const end = Date.now() + 10000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    async rpc(path, method, params = {}, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json };
    },
    stop: async () => { if (child.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); }); },
  };
}

test('HTTP: auth is required, the public endpoint refuses, an authenticated call appends only to the journal, and the kill switch works', async () => {
  const today = shanghaiToday();
  const db = seeded(today, 'RPT-HTTP');
  const file = db.file;
  const before = counts(db);
  db.close();
  const args = body({ report_id: 'RPT-HTTP', as_of_trade_date: today, account_id: ACCOUNT, additional_evidence: [{ claim: 'c', source_url: 'https://e.com/x', published_at: '2020-01-01' }], counter_evidence: [] });
  const server = await startServer({ ASHARE_PORTFOLIO_DB_PATH: file });
  try {
    const anon = await server.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: args });
    assert.equal(anon.status, 401);
    const wrong = await server.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: args }, { Authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    const pub = await server.rpc('/mcp', 'tools/call', { name: TOOL, arguments: args });
    assert.equal(pub.status, 400);
    assert.match(pub.body.error.message, /private_endpoint_required/);
    const pubList = await server.rpc('/mcp', 'tools/list', {});
    assert.ok(!pubList.body.result.tools.some(t => t.name === TOOL));
    const probe = new DatabaseSync(file, { readOnly: true });
    assert.equal(probe.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt'").get().n, 0, 'refused calls wrote nothing');
    probe.close();

    const AUTH = { Authorization: `Bearer ${TOKEN}` };
    const list = await server.rpc('/private/mcp', 'tools/list', {}, AUTH);
    assert.ok(list.body.result.tools.some(t => t.name === TOOL));
    const forged = await server.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: { ...args, source: 'vps', created_at: '2020-01-01T00:00:00Z' } }, AUTH);
    assert.equal(forged.status, 400);
    assert.match(forged.body.error.message, /not accepted/);
    const ok = await server.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: args }, AUTH);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const result = JSON.parse(ok.body.result.content[0].text);
    assert.deepEqual(Object.keys(result).sort(), ['content_hash', 'created', 'evidence_class', 'record_id']);
    assert.equal(result.evidence_class, 'TRUE_FORWARD');
    const replay = JSON.parse((await server.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: args }, AUTH)).body.result.content[0].text);
    assert.equal(replay.created, false);
    assert.equal(replay.record_id, result.record_id);
    const after = openPortfolioDb(file, { writable: false });
    try {
      const rows = listResearchJournal(after, { accountId: ACCOUNT }).filter(r => r.source === 'chatgpt');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'chatgpt');
      assert.deepEqual(counts(after), before, 'ledger/holdings/policy/completeness tables unchanged');
    } finally { after.close(); }
  } finally { await server.stop(); }
  const off = await startServer({ ASHARE_PORTFOLIO_DB_PATH: file, ASHARE_CHATGPT_INTAKE_DISABLED: '1' });
  try {
    const res = await off.rpc('/private/mcp', 'tools/call', { name: TOOL, arguments: { ...args, idempotency_key: 'off' } }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /chatgpt_intake_disabled/);
  } finally { await off.stop(); }
});
