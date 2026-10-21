import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { calculateFees, resolveFeeRules } from './fees.js';
import { etfIdentity } from '../ashare/etfResearch.js';

export const JOURNAL_VERSION = 'research-journal-20261021-v1';
export const JOURNAL_SOURCES = ['vps', 'chatgpt', 'combined'] as const;
export type JournalSource = typeof JOURNAL_SOURCES[number];
export interface JournalObservation {
  ts_code: string;
  quantity: number;
  direction?: 'long' | 'observe';
  trigger_price_milli?: number;
  invalidation_price_milli?: number;
  benchmark_code?: string;
}
export interface ResearchJournalInput {
  record_id: string;
  account_id: string;
  source: JournalSource;
  as_of_trade_date: string;
  bundle_id: string;
  generated_at: string;
  versions: Record<string, string>;
  judgement: unknown;
  candidates: unknown[];
  observations: JournalObservation[];
  evidence: unknown[];
  parent_record_ids?: string[];
  correction_of?: string | null;
  provenance?: { author: string; source_reference: string; obtained_at: string };
  /** Actual quant bundle or externally obtained research; retained verbatim as JSON. */
  payload?: unknown;
}
export type JournalRecord = ResearchJournalInput & { content_hash: string; recorded_at: string };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS research_journal (
 record_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source TEXT NOT NULL,
 as_of_trade_date TEXT NOT NULL, bundle_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 content_json TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_journal_account_date ON research_journal(account_id,as_of_trade_date);
CREATE TRIGGER IF NOT EXISTS research_journal_no_update BEFORE UPDATE ON research_journal BEGIN SELECT RAISE(ABORT,'research_journal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_journal_no_delete BEFORE DELETE ON research_journal BEGIN SELECT RAISE(ABORT,'research_journal is immutable'); END;
CREATE TABLE IF NOT EXISTS research_journal_evaluation (
 evaluation_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, account_id TEXT NOT NULL,
 as_of_trade_date TEXT NOT NULL, content_hash TEXT NOT NULL, content_json TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS research_journal_evaluation_no_update BEFORE UPDATE ON research_journal_evaluation BEGIN SELECT RAISE(ABORT,'research_journal_evaluation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_journal_evaluation_no_delete BEFORE DELETE ON research_journal_evaluation BEGIN SELECT RAISE(ABORT,'research_journal_evaluation is immutable'); END;
`;
function table(db: DatabaseSync | null | undefined, name: string): boolean {
  return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
export function canonicalJson(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, sort(v[key])])) : v;
  const result = JSON.stringify(sort(value));
  if (result === undefined) throw new Error('JSON content is required');
  return result;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function ymd(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^\d{8}$/.test(result)) throw new Error(`${name} requires YYYYMMDD`);
  const d = new Date(`${result.slice(0, 4)}-${result.slice(4, 6)}-${result.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10).replace(/-/g, '') !== result) throw new Error(`${name} is not a calendar date`);
  return result;
}
function iso(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result)) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result)) throw new Error(`${name} requires an ISO timestamp with timezone`);
  return result;
}
function normalized(input: ResearchJournalInput): ResearchJournalInput {
  const record: ResearchJournalInput = {
    record_id: text(input.record_id, 'record_id'), account_id: text(input.account_id, 'account_id'),
    source: input.source, as_of_trade_date: ymd(input.as_of_trade_date, 'as_of_trade_date'),
    bundle_id: text(input.bundle_id, 'bundle_id'), generated_at: iso(input.generated_at, 'generated_at'),
    versions: input.versions, judgement: input.judgement, candidates: input.candidates,
    observations: input.observations, evidence: input.evidence,
    parent_record_ids: input.parent_record_ids ?? [], correction_of: input.correction_of ?? null,
    ...(input.provenance ? { provenance: { author: text(input.provenance.author, 'author'), source_reference: text(input.provenance.source_reference, 'source_reference'), obtained_at: iso(input.provenance.obtained_at, 'obtained_at') } } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
  if (!JOURNAL_SOURCES.includes(record.source)) throw new Error('source must be vps, chatgpt or combined');
  if (!record.versions || Array.isArray(record.versions) || !Object.keys(record.versions).length || Object.values(record.versions).some(value => typeof value !== 'string' || !value)) throw new Error('versions are required');
  if (record.judgement === undefined || !Array.isArray(record.candidates) || !Array.isArray(record.observations) || !Array.isArray(record.evidence)) throw new Error('judgement, candidates, observations and evidence are required');
  if (record.source !== 'vps' && !record.provenance) throw new Error('External research requires actual provenance; no synthetic ChatGPT conclusions');
  if (!Array.isArray(record.parent_record_ids) || record.parent_record_ids.some(id => typeof id !== 'string' || !id)) throw new Error('parent_record_ids must be IDs');
  for (const observation of record.observations) {
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(observation.ts_code) || !Number.isSafeInteger(observation.quantity) || observation.quantity <= 0) throw new Error('Observation requires security code and positive integer quantity');
    if (observation.direction && !['long', 'observe'].includes(observation.direction)) throw new Error('Unsupported observation direction');
    for (const price of [observation.trigger_price_milli, observation.invalidation_price_milli]) if (price !== undefined && (!Number.isSafeInteger(price) || price <= 0)) throw new Error('Trigger/invalidation prices require positive integer milli');
    if (observation.benchmark_code && !/^\d{6}\.(SH|SZ|BJ)$/.test(observation.benchmark_code)) throw new Error('Invalid benchmark code');
  }
  return JSON.parse(canonicalJson(record));
}

export function readResearchJournal(db: DatabaseSync, id: string): JournalRecord | null {
  if (!table(db, 'research_journal')) return null;
  const row = db.prepare('SELECT * FROM research_journal WHERE record_id=?').get(id) as any;
  return row ? { ...JSON.parse(row.content_json), content_hash: row.content_hash, recorded_at: row.recorded_at } : null;
}
export function recordResearchJournal(db: DatabaseSync, input: ResearchJournalInput) {
  const record = normalized(input), digest = hash(record);
  const existing = readResearchJournal(db, record.record_id);
  if (existing) {
    if (existing.content_hash !== digest) throw new Error(`journal_id_conflict: ${record.record_id}; append a correction with a new ID`);
    return { created: false, record: existing };
  }
  for (const id of [...record.parent_record_ids!, ...(record.correction_of ? [record.correction_of] : [])]) {
    const parent = readResearchJournal(db, id);
    if (!parent || parent.account_id !== record.account_id) throw new Error('Journal parent/correction must exist in the same account');
    if (parent.as_of_trade_date > record.as_of_trade_date) throw new Error('Journal parent cannot be later than the research date');
  }
  if (record.source === 'combined') {
    const sources = new Set(record.parent_record_ids!.map(id => readResearchJournal(db, id)!.source));
    if (!sources.has('vps') || !sources.has('chatgpt')) throw new Error('Combined research requires actual VPS and ChatGPT parent records');
  }
  db.exec(SCHEMA);
  const recordedAt = new Date().toISOString();
  db.prepare('INSERT INTO research_journal VALUES (?,?,?,?,?,?,?,?)').run(record.record_id, record.account_id, record.source, record.as_of_trade_date, record.bundle_id, digest, canonicalJson(record), recordedAt);
  return { created: true, record: { ...record, content_hash: digest, recorded_at: recordedAt } };
}
export function listResearchJournal(db: DatabaseSync, input: { accountId: string; asOf?: string; limit?: number }): JournalRecord[] {
  if (!table(db, 'research_journal')) return [];
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 100)));
  return (db.prepare('SELECT * FROM research_journal WHERE account_id=? AND as_of_trade_date<=? ORDER BY as_of_trade_date DESC,record_id LIMIT ?').all(input.accountId, input.asOf ?? '99991231', limit) as any[])
    .map(row => ({ ...JSON.parse(row.content_json), content_hash: row.content_hash, recorded_at: row.recorded_at }));
}

export type JournalFeeEstimator = (input: { ts_code: string; side: 'BUY' | 'SELL'; quantity: number; price_milli: number; trade_date: string }) => { total_cents: number; estimated: boolean; version: string } | null;

/** Shared account fee engine; unknown instrument identity cannot inherit a fabricated zero cost. */
export function journalFeeEstimator(portfolioDb: DatabaseSync, marketDb: DatabaseSync | null | undefined, accountId: string): JournalFeeEstimator {
  return input => {
    if (!marketDb) return null;
    let kind: 'ETF' | 'STOCK' | null = null;
    if (table(marketDb, 'stock_basic') && marketDb.prepare('SELECT ts_code FROM stock_basic WHERE ts_code=?').get(input.ts_code)) kind = 'STOCK';
    if (!kind && table(marketDb, 'fund_basic')) {
      const basic = marketDb.prepare('SELECT * FROM fund_basic WHERE ts_code=?').get(input.ts_code);
      if (etfIdentity(basic)) kind = 'ETF';
    }
    if (!kind) return null;
    const rules = resolveFeeRules({ db: portfolioDb, accountId, code: input.ts_code, kind, asOf: input.trade_date });
    const fees = calculateFees(Math.round(input.quantity * input.price_milli / 10), input.side === 'BUY' ? 'buy' : 'sell', rules);
    return { total_cents: fees.total_cents, estimated: fees.assumed, version: fees.fee_model?.version ?? 'unversioned-fee-estimate' };
  };
}
interface Price { raw: number; factor: number | null; high: number | null; low: number | null }
function price(db: DatabaseSync, code: string, date: string): Price | null {
  for (const [bars, adj, field] of [['fund_daily', 'fund_adj', 'adj_factor'], ['daily', 'adj_factor', 'adj_factor']]) {
    if (!table(db, bars)) continue;
    const bar = db.prepare(`SELECT close,high,low FROM ${bars} WHERE ts_code=? AND trade_date=?`).get(code, date) as any;
    if (!bar || !(bar.close > 0)) continue;
    const factor = table(db, adj) ? (db.prepare(`SELECT ${field} value FROM ${adj} WHERE ts_code=? AND trade_date=?`).get(code, date) as any)?.value : null;
    return { raw: bar.close, factor: factor > 0 ? factor : null, high: bar.high > 0 ? bar.high : null, low: bar.low > 0 ? bar.low : null };
  }
  return null;
}
const round = (n: number) => Math.round(n * 10000) / 10000;
export interface JournalEvaluation {
  evaluation_id: string; record_id: string; account_id: string; source: JournalSource;
  as_of_trade_date: string; horizon_trade_days: number; maturity_date: string | null;
  status: 'PENDING' | 'UNAVAILABLE' | 'EVALUATED'; reason: string | null;
  record_content_hash: string; evaluation_version: string;
  observations: Record<string, unknown>[];
}

/** Pure evaluation: requires exact fixed endpoints and every intervening session; never edits conclusions. */
export function evaluateResearchJournal(input: { portfolioDb: DatabaseSync; marketDb: DatabaseSync | null | undefined; accountId: string; asOf: string; horizons?: number[]; feeEstimator?: JournalFeeEstimator; limit?: number }): JournalEvaluation[] {
  const asOf = ymd(input.asOf, 'asOf');
  const horizons = [...new Set(input.horizons ?? [5, 10, 20, 60])];
  if (horizons.some(n => !Number.isInteger(n) || n < 1 || n > 252)) throw new Error('horizons require 1..252 trading days');
  const db = input.marketDb;
  return listResearchJournal(input.portfolioDb, { accountId: input.accountId, asOf, limit: input.limit ?? 1000 }).flatMap(record => horizons.map(horizon => {
    const base: JournalEvaluation = {
      evaluation_id: '', record_id: record.record_id, account_id: record.account_id, source: record.source,
      as_of_trade_date: asOf, horizon_trade_days: horizon, maturity_date: null,
      status: 'UNAVAILABLE', reason: null, record_content_hash: record.content_hash, evaluation_version: JOURNAL_VERSION, observations: [],
    };
    const finish = () => { base.evaluation_id = `JE-${hash({ ...base, evaluation_id: undefined }).slice(0, 32)}`; return base; };
    if (!db || !table(db, 'trade_cal')) { base.reason = 'trade_calendar_unavailable'; return finish(); }
    const startOpen = db.prepare('SELECT is_open FROM trade_cal WHERE cal_date=?').get(record.as_of_trade_date) as any;
    if (startOpen?.is_open !== 1) { base.reason = 'research_date_not_open_in_calendar'; return finish(); }
    const dates = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date>? ORDER BY cal_date LIMIT ?').all(record.as_of_trade_date, horizon) as any[]).map(row => String(row.cal_date));
    base.maturity_date = dates.length === horizon ? dates.at(-1)! : null;
    if (!base.maturity_date || base.maturity_date > asOf) { base.status = 'PENDING'; base.reason = base.maturity_date ? 'observation_window_not_mature' : 'future_calendar_insufficient'; return finish(); }
    // Backdated imports are preserved but never counted as prospective predictions.
    const generatedDate = new Date(Date.parse(record.generated_at) + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    if (generatedDate > record.as_of_trade_date) { base.reason = 'retrospective_record_not_prospective'; return finish(); }
    base.observations = record.observations.map(observation => {
      const result: Record<string, any> = { ts_code: observation.ts_code, quantity: observation.quantity, status: 'UNAVAILABLE', reason: null, trigger: 'UNKNOWN', invalidation: 'UNKNOWN', gross_return_pct: null, net_return_pct: null, benchmark_net_return_pct: null, excess_return_pct: null, fees_cents: null, max_drawdown_pct: null, unexpected_loss: 'UNKNOWN' };
      const fail = (reason: string) => ({ ...result, reason });
      const allDates = [record.as_of_trade_date, ...dates];
      const series = allDates.map(date => price(db, observation.ts_code, date));
      if (series.some(row => !row)) return fail('missing_exact_window_price');
      const rows = series as Price[];
      if (rows.some(row => row.factor === null)) return fail('adjustment_factor_missing');
      if (rows.some(row => row.factor !== rows[0].factor)) return fail('corporate_action_cashflows_unavailable');
      // Conditions are checked from the next session, never on the research day's already-known bar.
      const future = rows.slice(1);
      result.trigger = observation.trigger_price_milli === undefined ? 'NOT_DEFINED' : future.some(row => row.high !== null && row.high * 1000 >= observation.trigger_price_milli!) ? 'TRIGGERED' : future.some(row => row.high === null) ? 'UNKNOWN' : 'NOT_TRIGGERED';
      result.invalidation = observation.invalidation_price_milli === undefined ? 'NOT_DEFINED' : future.some(row => row.low !== null && row.low * 1000 <= observation.invalidation_price_milli!) ? 'INVALIDATED' : future.some(row => row.low === null) ? 'UNKNOWN' : 'NOT_INVALIDATED';
      const start = rows[0], end = rows.at(-1)!;
      result.gross_return_pct = round((end.raw / start.raw - 1) * 100);
      let peak = start.raw, dd = 0;
      for (const row of rows) { peak = Math.max(peak, row.raw); dd = Math.min(dd, row.raw / peak - 1); }
      result.max_drawdown_pct = round(dd * 100);
      result.unexpected_loss = observation.invalidation_price_milli === undefined ? 'NOT_DEFINED' : result.invalidation === 'INVALIDATED' ? 'LOSS_THRESHOLD_BREACHED' : 'NOT_BREACHED';
      const fees = (code: string, first: Price, last: Price, quantity = observation.quantity) => {
        if (!input.feeEstimator) return null;
        const buy = input.feeEstimator({ ts_code: code, side: 'BUY', quantity, price_milli: Math.round(first.raw * 1000), trade_date: record.as_of_trade_date });
        const sell = input.feeEstimator({ ts_code: code, side: 'SELL', quantity, price_milli: Math.round(last.raw * 1000), trade_date: base.maturity_date! });
        if (!buy || !sell || !Number.isSafeInteger(buy.total_cents) || !Number.isSafeInteger(sell.total_cents) || buy.total_cents < 0 || sell.total_cents < 0) return null;
        const invested = Math.round(quantity * first.raw * 100) + buy.total_cents;
        const proceeds = Math.round(quantity * last.raw * 100) - sell.total_cents;
        return { total: buy.total_cents + sell.total_cents, invested, proceeds, net: round((proceeds / invested - 1) * 100), estimated: buy.estimated || sell.estimated, versions: [buy.version, sell.version] };
      };
      const cost = fees(observation.ts_code, start, end);
      if (!cost) return fail('fee_rules_unavailable');
      result.fees_cents = cost.total; result.net_return_pct = cost.net; result.fees_estimated = cost.estimated; result.fee_versions = cost.versions;
      const benchmarkCode = observation.benchmark_code ?? '510300.SH';
      const benchmark = allDates.map(date => price(db, benchmarkCode, date));
      result.benchmark_code = benchmarkCode;
      if (benchmark.some(row => !row || row.factor === null)) return fail('benchmark_exact_window_unavailable');
      const benchRows = benchmark as Price[];
      if (benchRows.some(row => row.factor !== benchRows[0].factor)) return fail('benchmark_corporate_action_cashflows_unavailable');
      // Equal initial cash budget, not equal share count: minimum commissions depend on trade size.
      const initialBudget = cost.invested;
      let benchmarkQuantity = Math.floor(initialBudget / (benchRows[0].raw * 10000)) * 100;
      let benchmarkFees = benchmarkQuantity > 0 ? fees(benchmarkCode, benchRows[0], benchRows.at(-1)!, benchmarkQuantity) : null;
      while (benchmarkQuantity > 0 && benchmarkFees && benchmarkFees.invested > initialBudget) {
        benchmarkQuantity -= 100;
        benchmarkFees = benchmarkQuantity > 0 ? fees(benchmarkCode, benchRows[0], benchRows.at(-1)!, benchmarkQuantity) : null;
      }
      if (benchmarkQuantity <= 0) return fail('benchmark_budget_below_one_lot');
      if (!benchmarkFees) return fail('benchmark_fee_rules_unavailable');
      const residualCash = initialBudget - benchmarkFees.invested;
      const benchmarkNet = round(((benchmarkFees.proceeds + residualCash) / initialBudget - 1) * 100);
      result.benchmark_quantity = benchmarkQuantity;
      result.benchmark_cash_cents = residualCash;
      result.benchmark_net_return_pct = benchmarkNet;
      result.excess_return_pct = round(cost.net - benchmarkNet);
      result.status = 'EVALUATED';
      result.note = '固定窗口的假设买入卖出含费用观察；基准使用相同初始资金预算、整手和剩余现金。不是实际成交收益，也不推断触发顺序或盘中可成交价。';
      return result;
    });
    base.status = base.observations.length && base.observations.every(row => row.status === 'EVALUATED') ? 'EVALUATED' : 'UNAVAILABLE';
    base.reason = base.status === 'EVALUATED' ? null : base.observations.length ? 'observation_dependencies_unavailable' : 'no_observations';
    return finish();
  }));
}

export function recordJournalEvaluations(db: DatabaseSync, results: JournalEvaluation[]) {
  db.exec(SCHEMA);
  let created = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const result of results) {
      const original = readResearchJournal(db, result.record_id);
      if (!original || original.account_id !== result.account_id || original.content_hash !== result.record_content_hash) throw new Error('Evaluation original record mismatch');
      const digest = hash(result);
      const row = db.prepare('SELECT content_hash FROM research_journal_evaluation WHERE evaluation_id=?').get(result.evaluation_id) as any;
      if (row) { if (row.content_hash !== digest) throw new Error('evaluation_id_conflict'); continue; }
      db.prepare('INSERT INTO research_journal_evaluation VALUES (?,?,?,?,?,?,?)').run(result.evaluation_id, result.record_id, result.account_id, result.as_of_trade_date, digest, canonicalJson(result), new Date().toISOString());
      created++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { created, existing: results.length - created };
}
