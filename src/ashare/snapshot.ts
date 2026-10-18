import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESEARCH_SCORE_VERSION, SCORE_RULES, SCORE_VERSION, scanMarket, scoreRows,
  type MarketScan, type ScoreBreakdown,
} from './analysis.js';
import { ashareDataDir, ashareDbPath } from './db.js';
import { DATA_CONTRACT_VERSION } from './data.js';
import { ENGINE_VERSION, FACTOR_VERSION, applyObservationQuality, rawFactors, sourceQualityForDate } from './engine.js';
import {
  EVALUATION_VERSION, correlation, distribution, evaluateEvents, type EvaluationEvent,
} from './evaluation.js';
import { INDICATOR_VERSION } from './indicators.js';
import { checkQuality, previousTradeDay, shanghaiToday, tradeDaysBetween, type QualityReport } from './ingest.js';
import { SIGNAL_VERSION } from './signals.js';
import { WATCHLIST_RULES, WATCHLIST_VERSION, updateWatchlist } from './watchlist.js';

/**
 * Forward research snapshots (P1). A snapshot records what V1 and V2 would have
 * said at a trade date, using only data available up to that date, into a
 * separate research database. The live database is opened read-only and is
 * never written; reports, watchlists and scores are read for parity checks only.
 *
 * The V1 pool is the formal live watchlist of that date. The V2 pool is a
 * research-only pool advanced day by day from its own stored state, so it can
 * be observed from the first snapshot onward without pretending to be the
 * formal list.
 *
 * Chain rules (fwd-snapshot-1.1.0):
 * - `pool_state` holds the chain of ORIGINAL snapshots only (plus an optional
 *   one-time research seed); a REVISED snapshot never writes or overwrites it.
 * - A new snapshot inherits the state of the immediately preceding trade day.
 *   When that state is absent the command returns CHAIN_GAP and writes nothing
 *   instead of silently continuing from an older date.
 * - Each snapshot records the ORIGINAL snapshot id it actually inherited.
 * - `observation_type` (PROSPECTIVE / BACKFILLED) is an independent attribute
 *   of the observation time, stored beside status (ORIGINAL / REVISED).
 */
export const SNAPSHOT_PROTOCOL_VERSION = 'fwd-snapshot-1.1.0';
export const DEFAULT_HORIZON = 10;
export const SNAPSHOT_COSTS = { buy_fee_bps: 3, sell_fee_bps: 8, slippage_bps: 5, max_exit_delay: 5 };
export const SNAPSHOT_POOL_SOURCES = {
  v1: 'formal_live_watchlist',
  v2: 'research_v2_sequential',
} as const;

/** First trade date that counts as a true prospective observation (2026-10-19). */
export const PROSPECTIVE_START = '20261019';
/** Allowed delay from the live report's generated_at to the snapshot's created_at. */
export const PROSPECTIVE_WINDOW_HOURS = 24;
export const OBSERVATION_TYPES = { prospective: 'PROSPECTIVE', backfilled: 'BACKFILLED' } as const;
export type ObservationType = typeof OBSERVATION_TYPES[keyof typeof OBSERVATION_TYPES];
/** Where a pool_state row set came from: an ORIGINAL snapshot or the one-time research seed. */
export const POOL_STATE_SOURCES = { snapshot: 'original_snapshot', seed: 'seed' } as const;

const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  status TEXT NOT NULL,
  revises TEXT,
  created_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content TEXT NOT NULL,
  observation_type TEXT,
  observation_reason TEXT,
  report_generated_at TEXT,
  prospective_start TEXT,
  window_hours REAL
);
CREATE INDEX IF NOT EXISTS snapshot_date ON snapshot(trade_date);
CREATE TABLE IF NOT EXISTS snapshot_member (
  snapshot_id TEXT NOT NULL, version TEXT NOT NULL, ts_code TEXT NOT NULL,
  score REAL, rank INTEGER, industry TEXT, status TEXT, reason TEXT, entered_on TEXT,
  signals TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, version, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshot_factor (
  snapshot_id TEXT NOT NULL, ts_code TEXT NOT NULL, industry TEXT, eligible INTEGER NOT NULL,
  raw TEXT NOT NULL, v1 TEXT NOT NULL, v2 TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshot_evaluation (
  snapshot_id TEXT NOT NULL, version TEXT NOT NULL, as_of TEXT NOT NULL, horizon INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, version, as_of, horizon)
) WITHOUT ROWID;
-- The V2 state chain. Only ORIGINAL snapshots and the one-time research seed
-- write here; REVISED snapshots never do. previous_snapshot_id names the
-- ORIGINAL snapshot whose state was inherited (null for a chain start/seed).
CREATE TABLE IF NOT EXISTS pool_state (
  version TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, entered_on TEXT NOT NULL,
  score REAL, rank INTEGER, industry TEXT, status TEXT,
  previous_snapshot_id TEXT, state_source TEXT, source_id TEXT, seed_id TEXT,
  PRIMARY KEY (version, trade_date, ts_code)
) WITHOUT ROWID;
-- One-time common starting state for the V1/V2 comparison, taken from the last
-- formal V1 watchlist before the prospective window opens.
CREATE TABLE IF NOT EXISTS pool_seed (
  seed_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  source_report_id TEXT NOT NULL,
  source_report_generated_at TEXT,
  members_digest TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  content TEXT NOT NULL
);
`;

const LIVE_PRAGMAS = 'PRAGMA busy_timeout = 15000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 2147483648;';

/** Research snapshot database; never read by the live pipeline or MCP tools. */
export function researchSnapshotDbPath(): string {
  return join(ashareDataDir(), 'research', 'forward-observations.sqlite');
}

/** The live cache, opened read-only so no statement can modify it. */
export function openLiveReadOnly(path = ashareDbPath()): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(LIVE_PRAGMAS);
  return db;
}

/**
 * Resolve a path to an absolute path with every existing component symlink-free.
 * The tail below the deepest existing ancestor is appended unchanged, so a
 * research database that does not exist yet is still compared through symlinked
 * parent directories.
 */
function realPathOfNearestAncestor(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    tail.unshift(basename(current));
    current = parent;
  }
  let base: string;
  try { base = realpathSync.native(current); } catch { base = current; }
  return tail.length ? join(base, ...tail) : base;
}

/** `dev:ino` of an existing file; null when it cannot be stat'ed (missing path). */
function fileIdentity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Refuse a research database that is the live database under any alias: a
 * relative path, `.`/`..` segments, a symlink, a hard link, or a symlinked
 * parent directory. Returns the resolved research path. Runs before anything is
 * created or opened writable on the research path.
 */
export function assertSeparateFromLive(researchPath: string, livePath: string = ashareDbPath()): string {
  const research = realPathOfNearestAncestor(researchPath);
  const live = realPathOfNearestAncestor(livePath);
  const reject = () => new Error(`研究快照数据库与正式数据库指向同一文件（${research}），拒绝执行`);
  if (research === live) throw reject();
  // A hard link has a different path but the same inode. Symlinks are already
  // resolved above; the identity check also covers case-insensitive filesystems,
  // where a differently-cased path opens the live file. A missing research path
  // cannot be a hard link, so identity is only compared when both stat succeed.
  const researchId = fileIdentity(research);
  if (researchId !== null && researchId === fileIdentity(live)) throw reject();
  return research;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value);

function ensureColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r => r.name as string));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Add the columns introduced by fwd-snapshot-1.1.0 to a database created by an
 * earlier build, and classify rows written before the column existed from the
 * facts they already stored. Existing snapshot ids and content are untouched.
 */
function migrateSnapshotDb(db: DatabaseSync): void {
  ensureColumns(db, 'snapshot', {
    observation_type: 'TEXT', observation_reason: 'TEXT', report_generated_at: 'TEXT',
    prospective_start: 'TEXT', window_hours: 'REAL',
  });
  ensureColumns(db, 'pool_state', {
    score: 'REAL', rank: 'INTEGER', industry: 'TEXT', status: 'TEXT',
    previous_snapshot_id: 'TEXT', state_source: 'TEXT', source_id: 'TEXT', seed_id: 'TEXT',
  });
  const pending = db.prepare('SELECT snapshot_id, trade_date, created_at, content FROM snapshot WHERE observation_type IS NULL').all() as any[];
  if (!pending.length) return;
  const update = db.prepare(`UPDATE snapshot SET observation_type = ?, observation_reason = ?, report_generated_at = ?,
    prospective_start = ?, window_hours = ? WHERE snapshot_id = ?`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of pending) {
      let content: any = {};
      try { content = JSON.parse(row.content); } catch { content = {}; }
      const observation = classifyObservation({
        tradeDate: row.trade_date,
        dataCutoff: content.data_cutoff ?? null,
        reportGeneratedAt: content.report?.generated_at ?? null,
        createdAt: row.created_at,
      });
      update.run(observation.type, observation.reason, observation.report_generated_at,
        observation.prospective_start, observation.window_hours, row.snapshot_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // Older builds only wrote pool_state from the original snapshot flow; label
  // those rows so the chain lookup can treat them as original-derived.
  db.prepare(`UPDATE pool_state SET state_source = '${POOL_STATE_SOURCES.snapshot}'
    WHERE state_source IS NULL AND version = ?`).run(RESEARCH_SCORE_VERSION);
  db.prepare(`UPDATE pool_state SET source_id = (
      SELECT s.snapshot_id FROM snapshot s WHERE s.trade_date = pool_state.trade_date AND s.status = 'ORIGINAL'
      ORDER BY s.created_at, s.snapshot_id LIMIT 1)
    WHERE source_id IS NULL AND state_source = ?`).run(POOL_STATE_SOURCES.snapshot);
}

function openSnapshotDb(path: string, livePath: string = ashareDbPath()): DatabaseSync {
  // Path identity is checked before anything is created or opened writable.
  const resolved = assertSeparateFromLive(path, livePath);
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000;');
  db.exec(SNAPSHOT_SCHEMA);
  migrateSnapshotDb(db);
  return db;
}

let cachedBuild: string | undefined;
/** SHA256 over every built ashare module, so a snapshot names the code that produced it. */
export function buildSha256(): string {
  if (cachedBuild) return cachedBuild;
  const dir = dirname(fileURLToPath(import.meta.url));
  const h = createHash('sha256');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    h.update(file).update('\0').update(readFileSync(join(dir, file))).update('\0');
  }
  return (cachedBuild = h.digest('hex'));
}

export function snapshotVersions() {
  return {
    engine: ENGINE_VERSION, factor: FACTOR_VERSION, indicator: INDICATOR_VERSION, signal: SIGNAL_VERSION,
    score_v1: SCORE_VERSION, score_v2: RESEARCH_SCORE_VERSION, watchlist: WATCHLIST_VERSION,
    evaluation: EVALUATION_VERSION, data: DATA_CONTRACT_VERSION, snapshot: SNAPSHOT_PROTOCOL_VERSION,
  };
}

function validateDate(raw: string, label = '--date'): string {
  if (!/^\d{8}$/.test(String(raw ?? ''))) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  const d = new Date(Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8)));
  if (d.toISOString().slice(0, 10).replace(/-/g, '') !== raw) throw new Error(`${label} 不是有效日期: ${raw}`);
  return raw;
}

function horizonOf(raw: number | undefined): number {
  const horizon = raw == null ? DEFAULT_HORIZON : Number(raw);
  if (!Number.isInteger(horizon) || horizon < 2) throw new Error('horizon 需要 ≥ 2 的整数（A 股 T+1）');
  return horizon;
}

const dataCutoff = (db: DatabaseSync): string | null =>
  ((db.prepare('SELECT MAX(trade_date) d FROM daily').get() as any)?.d as string) ?? null;

const liveReport = (db: DatabaseSync, date: string) =>
  db.prepare("SELECT * FROM report WHERE trade_date = ? AND run_mode = 'live' ORDER BY generated_at DESC, report_id DESC LIMIT 1").get(date) as any;

/** The wall-clock `checked_at` is excluded so identical inputs stay byte-identical. */
function stripQuality(q: QualityReport) {
  const { checked_at: _checked, ...rest } = q;
  return rest;
}

function latestSync(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT dataset, MAX(synced_at) t FROM sync_log GROUP BY dataset ORDER BY dataset').all() as any[];
  return Object.fromEntries(rows.map(r => [r.dataset, r.t]));
}

/** The h-th open trade day after `date`, or null when the calendar does not reach it. */
function plannedExitDate(db: DatabaseSync, date: string, horizon: number): string | null {
  const days = tradeDaysBetween(db, date, '99991231');
  const i = days.indexOf(date);
  return i >= 0 ? days[i + horizon] ?? null : null;
}

// ------------------------------------------------------------- observation time

export interface ObservationFacts {
  tradeDate: string;
  dataCutoff: string | null;
  reportGeneratedAt: string | null;
  createdAt: string;
}

export interface Observation {
  type: ObservationType;
  reason: string | null;
  report_generated_at: string | null;
  prospective_start: string;
  window_hours: number;
}

/**
 * Deterministic classification of the observation time from stored facts only:
 * - the trade date must be on/after PROSPECTIVE_START;
 * - the snapshot must have been created within PROSPECTIVE_WINDOW_HOURS after
 *   the live report's generated_at (parsed with its +08:00 offset);
 * - the data cutoff must equal the trade date (no later data was used).
 * Everything else is BACKFILLED with a machine-readable reason.
 */
export function classifyObservation(facts: ObservationFacts): Observation {
  const base = {
    report_generated_at: facts.reportGeneratedAt ?? null,
    prospective_start: PROSPECTIVE_START,
    window_hours: PROSPECTIVE_WINDOW_HOURS,
  };
  const backfilled = (reason: string): Observation => ({ ...base, type: OBSERVATION_TYPES.backfilled, reason });
  if (facts.tradeDate < PROSPECTIVE_START) return backfilled('before_prospective_start');
  const generated = Date.parse(facts.reportGeneratedAt ?? '');
  const created = Date.parse(facts.createdAt ?? '');
  if (!Number.isFinite(generated)) return backfilled('report_time_unknown');
  if (!Number.isFinite(created)) return backfilled('snapshot_time_unknown');
  if (created < generated) return backfilled('report_generated_after_snapshot');
  if (created - generated > PROSPECTIVE_WINDOW_HOURS * 3600_000) return backfilled('created_after_window');
  if (facts.dataCutoff !== facts.tradeDate) return backfilled('data_cutoff_after_trade_date');
  return { ...base, type: OBSERVATION_TYPES.prospective, reason: null };
}

// ------------------------------------------------------------------ state chain

export interface PoolMember {
  ts_code: string; name?: string | null; score: number; rank: number; industry: string; status: string; reason: string;
  entered_on: string; signals: string[];
}

export interface ChainSeed {
  seed_id: string; seed_date: string; source_report_id: string; members_digest: string; member_count: number;
}

export interface ChainPredecessor {
  /** Trade date of the inherited state (null for a chain start). */
  previous_date: string | null;
  /** ORIGINAL snapshot id whose state was inherited (null for a seed or a chain start). */
  previous_snapshot_id: string | null;
  previous_state_source: 'snapshot' | 'seed' | 'chain_start';
  seed: ChainSeed | null;
  rows: any[];
}

export interface ChainGap {
  status: 'CHAIN_GAP';
  date: string;
  expected_previous_trade_date: string | null;
  found_state_date: string | null;
  missing: string;
  note: string;
}

export type ChainResolution = { ok: true; predecessor: ChainPredecessor } | { ok: false; gap: ChainGap };

const CHAIN_GAP_NOTE = '按顺序补齐缺失交易日后再继续';

function previousStateRows(snap: DatabaseSync, date: string): { date: string | null; rows: any[] } {
  const prevDate = (snap.prepare('SELECT MAX(trade_date) d FROM pool_state WHERE version = ? AND trade_date < ?')
    .get(RESEARCH_SCORE_VERSION, date) as any)?.d as string | null;
  if (!prevDate) return { date: null, rows: [] };
  const rows = snap.prepare(`SELECT trade_date, ts_code, entered_on, score, rank, industry, status,
      previous_snapshot_id, state_source, source_id, seed_id
    FROM pool_state WHERE version = ? AND trade_date = ? ORDER BY ts_code`).all(RESEARCH_SCORE_VERSION, prevDate) as any[];
  return { date: prevDate, rows };
}

function seedBefore(snap: DatabaseSync, date: string): ChainSeed | null {
  const row = snap.prepare(`SELECT seed_id, trade_date, source_report_id, members_digest, member_count
    FROM pool_seed WHERE version = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`)
    .get(RESEARCH_SCORE_VERSION, date) as any;
  return row ? {
    seed_id: row.seed_id, seed_date: row.trade_date, source_report_id: row.source_report_id,
    members_digest: row.members_digest, member_count: row.member_count,
  } : null;
}

/**
 * Resolve the state a new ORIGINAL snapshot of `date` inherits. The predecessor
 * must be the immediately preceding trade day's ORIGINAL snapshot state (or the
 * seed on that day); otherwise the chain is broken and nothing may be written.
 */
function resolveChain(live: DatabaseSync, snap: DatabaseSync, date: string): ChainResolution {
  const prev = previousStateRows(snap, date);
  const expected = previousTradeDay(live, date) ?? null;
  const gap = (missing: string, found: string | null, note = CHAIN_GAP_NOTE): ChainResolution => ({
    ok: false,
    gap: { status: 'CHAIN_GAP', date, expected_previous_trade_date: expected, found_state_date: found, missing, note },
  });

  if (!prev.date) {
    const seedOnDate = snap.prepare('SELECT seed_id FROM pool_seed WHERE version = ? AND trade_date = ?')
      .get(RESEARCH_SCORE_VERSION, date) as any;
    if (seedOnDate) {
      return gap('seed_date_conflict', null, '该日期已是共同起点种子，不能在种子当日再写入原始快照；请从下一交易日起记录');
    }
    if (seedBefore(snap, date)) return gap('seed_state_missing', null, '种子状态缺失：pool_state 中没有种子行，拒绝以空池初始化');
    const earlier = snap.prepare("SELECT snapshot_id, trade_date FROM snapshot WHERE trade_date < ? AND status = 'ORIGINAL' ORDER BY trade_date DESC LIMIT 1").get(date) as any;
    if (earlier) return gap('pool_state_missing', earlier.trade_date, '存在更早的原始快照但没有对应的池状态，拒绝以空池初始化');
    // A chain start may only be appended at the end of the recorded chain.
    const later = snap.prepare("SELECT snapshot_id, trade_date FROM snapshot WHERE trade_date > ? AND status = 'ORIGINAL' ORDER BY trade_date LIMIT 1").get(date) as any;
    if (later) {
      return gap('preceding_original_snapshot', null, `该日期之后已有原始快照（${later.trade_date}），不能在此插入新的链首；请按交易日顺序补齐`);
    }
    return {
      ok: true,
      predecessor: { previous_date: null, previous_snapshot_id: null, previous_state_source: 'chain_start', seed: null, rows: [] },
    };
  }

  if (!expected) return gap('trade_calendar_missing', prev.date, '交易日历中找不到该日期之前的交易日');
  if (prev.date !== expected) return gap('original_snapshot', prev.date);

  const source = prev.rows[0]?.state_source ?? POOL_STATE_SOURCES.snapshot;
  if (source === POOL_STATE_SOURCES.seed) {
    const seedId = prev.rows[0]?.seed_id ?? null;
    const row = seedId ? snap.prepare('SELECT * FROM pool_seed WHERE seed_id = ?').get(seedId) as any : undefined;
    if (!row) return gap('seed_state_missing', prev.date);
    return {
      ok: true,
      predecessor: {
        previous_date: prev.date, previous_snapshot_id: null, previous_state_source: 'seed',
        seed: {
          seed_id: row.seed_id, seed_date: row.trade_date, source_report_id: row.source_report_id,
          members_digest: row.members_digest, member_count: row.member_count,
        },
        rows: prev.rows,
      },
    };
  }

  const original = snap.prepare("SELECT snapshot_id FROM snapshot WHERE trade_date = ? AND status = 'ORIGINAL' ORDER BY created_at, snapshot_id LIMIT 1")
    .get(prev.date) as any;
  if (!original) return gap('original_snapshot', prev.date);
  const recorded = prev.rows[0]?.source_id ?? null;
  if (recorded && recorded !== original.snapshot_id) {
    return gap('pool_state_source_mismatch', prev.date, '池状态记录来源与当日原始快照不一致');
  }
  return {
    ok: true,
    predecessor: {
      previous_date: prev.date, previous_snapshot_id: original.snapshot_id,
      previous_state_source: 'snapshot', seed: seedBefore(snap, date), rows: prev.rows,
    },
  };
}

/**
 * The predecessor a REVISED snapshot (or an EXISTS recomputation) must use: the
 * one the ORIGINAL row recorded. A revision only appends evidence, so it never
 * changes the chain and must not be blocked by later dates.
 */
function recordedPredecessor(snap: DatabaseSync, originalRow: any, date: string): ChainResolution {
  let content: any = {};
  try { content = JSON.parse(originalRow.content); } catch { content = {}; }
  const pool = content.v2_pool ?? {};
  const gap = (missing: string, found: string | null, note = CHAIN_GAP_NOTE): ChainResolution => ({
    ok: false,
    gap: { status: 'CHAIN_GAP', date, expected_previous_trade_date: null, found_state_date: found, missing, note },
  });
  const source = pool.previous_state_source
    ?? (pool.previous_date == null ? 'chain_start' : POOL_STATE_SOURCES.snapshot);
  if (source === 'chain_start') {
    return {
      ok: true,
      predecessor: { previous_date: null, previous_snapshot_id: null, previous_state_source: 'chain_start', seed: null, rows: [] },
    };
  }
  if (source === 'seed') {
    const seedId = pool.seed?.seed_id ?? null;
    const seedRow = seedId ? snap.prepare('SELECT * FROM pool_seed WHERE seed_id = ?').get(seedId) as any : undefined;
    if (!seedRow) return gap('seed_state_missing', pool.previous_date ?? null);
    const prev = previousStateRows(snap, date);
    if (prev.date !== seedRow.trade_date) return gap('seed_state_missing', prev.date);
    return {
      ok: true,
      predecessor: {
        previous_date: prev.date, previous_snapshot_id: null, previous_state_source: 'seed',
        seed: {
          seed_id: seedRow.seed_id, seed_date: seedRow.trade_date, source_report_id: seedRow.source_report_id,
          members_digest: seedRow.members_digest, member_count: seedRow.member_count,
        },
        rows: prev.rows,
      },
    };
  }
  const prev = previousStateRows(snap, date);
  if (!prev.date || (pool.previous_date != null && prev.date !== pool.previous_date)) {
    return gap('predecessor_state_missing', prev.date);
  }
  const original = snap.prepare("SELECT snapshot_id FROM snapshot WHERE trade_date = ? AND status = 'ORIGINAL' ORDER BY created_at, snapshot_id LIMIT 1")
    .get(prev.date) as any;
  if (!original) return gap('original_snapshot', prev.date);
  if (pool.previous_snapshot_id && pool.previous_snapshot_id !== original.snapshot_id) {
    return gap('predecessor_state_missing', prev.date, '记录的上一快照 ID 与当日原始快照不一致');
  }
  return {
    ok: true,
    predecessor: {
      previous_date: prev.date, previous_snapshot_id: original.snapshot_id,
      previous_state_source: 'snapshot', seed: seedBefore(snap, date), rows: prev.rows,
    },
  };
}

// ---------------------------------------------------------------------- compute

interface ComputedSnapshot {
  snapshot_id: string;
  content: any;
  content_digest: string;
  members: { version: string; row: PoolMember }[];
  factors: any[];
  v2Pool: PoolMember[];
}

/** Formal V1 scores/ranks must equal the live stock_score rows of that date. */
function v1Parity(live: DatabaseSync, date: string, scan: ReturnType<typeof scanMarket>, watch: any[]) {
  const stored = live.prepare('SELECT ts_code, score, rank FROM stock_score WHERE trade_date = ?').all(date) as any[];
  const storedBy = new Map(stored.map(r => [r.ts_code, r]));
  const eligible = scan.rows.filter(r => r.eligible);
  const eligibleCodes = new Set(eligible.map(r => r.ts_code));
  const sample: any[] = [];
  let scoreMismatches = 0, rankMismatches = 0;
  for (const row of eligible) {
    const s = storedBy.get(row.ts_code);
    if (!s) { if (sample.length < 10) sample.push({ ts_code: row.ts_code, issue: 'missing_in_stock_score' }); scoreMismatches++; continue; }
    if (s.score !== row.score) { scoreMismatches++; if (sample.length < 10) sample.push({ ts_code: row.ts_code, issue: 'score', scan: row.score, stored: s.score }); }
    if (s.rank !== row.rank) { rankMismatches++; if (sample.length < 10) sample.push({ ts_code: row.ts_code, issue: 'rank', scan: row.rank, stored: s.rank }); }
  }
  const extra = stored.filter(r => !eligibleCodes.has(r.ts_code)).map(r => r.ts_code);
  const watchMismatches = watch.filter(m => {
    const s = storedBy.get(m.ts_code);
    return !s || s.score !== m.score || s.rank !== m.rank;
  }).map(m => m.ts_code);
  return {
    ok: scoreMismatches === 0 && rankMismatches === 0 && extra.length === 0 && watchMismatches.length === 0,
    stock_score_rows: stored.length,
    eligible: eligible.length,
    missing_in_stock_score: eligible.filter(r => !storedBy.has(r.ts_code)).length,
    extra_in_stock_score: extra.length,
    score_mismatches: scoreMismatches,
    rank_mismatches: rankMismatches,
    watchlist_members: watch.length,
    watchlist_mismatches: watchMismatches,
    sample,
  };
}

/**
 * In-memory state database for the V2 pool: the same watchlist schema and the
 * live trade calendar (needed by tradeDaysHeld), seeded with the previous V2 pool.
 */
function buildV2StateDb(live: DatabaseSync, previous: any[]): DatabaseSync {
  const state = new DatabaseSync(':memory:');
  state.exec(`CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER);
    CREATE TABLE watchlist (trade_date TEXT, ts_code TEXT, score REAL, rank INTEGER, industry TEXT, status TEXT, reason TEXT, entered_on TEXT);
    CREATE TABLE watchlist_change (trade_date TEXT, ts_code TEXT, action TEXT, score REAL, rank INTEGER, reason TEXT, PRIMARY KEY (trade_date, ts_code, action));
    CREATE TABLE stock_score (trade_date TEXT, ts_code TEXT, score REAL, rank INTEGER, detail TEXT);`);
  const ins = state.prepare('INSERT INTO trade_cal (cal_date, is_open) VALUES (?,?)');
  for (const d of live.prepare('SELECT cal_date, is_open FROM trade_cal ORDER BY cal_date').all() as any[]) ins.run(d.cal_date, d.is_open);
  if (previous.length) {
    const pdate = previous[0].trade_date as string;
    const w = state.prepare('INSERT INTO watchlist (trade_date, ts_code, score, rank, industry, status, reason, entered_on) VALUES (?,?,?,?,?,?,?,?)');
    for (const p of previous) w.run(pdate, p.ts_code, p.score ?? 0, p.rank ?? 0, p.industry ?? null, 'kept', '', p.entered_on);
  }
  return state;
}

function computeSnapshot(live: DatabaseSync, date: string, horizon: number, report: any, quality: QualityReport,
  predecessor: ChainPredecessor): ComputedSnapshot {
  const cutoff = dataCutoff(live);
  const scan = scanMarket(live, date);
  const sourceQuality = sourceQualityForDate(live, date);
  const qualityOf = (code: string) => sourceQuality.get(code) ?? {};
  const signalsOf = (code: string) => {
    const row = scan.rows.find(r => r.ts_code === code);
    return !row || qualityOf(code).technical_invalid ? [] : [...row.signals];
  };

  // V2 is scored on an identical clone of the V1 universe, so the normalization
  // and eligibility set are exactly the same. V1 rows are then re-scored with
  // the same deterministic function to obtain its breakdown map; the parity
  // check below proves the formal values did not move.
  const v2Rows = structuredClone(scan.rows);
  const v2Break = scoreRows(v2Rows, scan.sectors, RESEARCH_SCORE_VERSION);
  const v1Break = scoreRows(scan.rows, scan.sectors, SCORE_VERSION);
  const v2ByCode = new Map(v2Rows.map(r => [r.ts_code, r]));

  const watchRows = live.prepare('SELECT ts_code, score, rank, industry, status, reason, entered_on FROM watchlist WHERE trade_date = ? ORDER BY rank, ts_code').all(date) as any[];
  const parity = v1Parity(live, date, scan, watchRows);
  if (!parity.ok) {
    throw new Error(`V1 一致性校验失败：正式 stock_score 与当日只读重算不一致（score ${parity.score_mismatches}，rank ${parity.rank_mismatches}，额外 ${parity.extra_in_stock_score}，股票池 ${parity.watchlist_mismatches}）。拒绝写入前瞻快照。${JSON.stringify(parity.sample)}`);
  }

  const eligible = scan.rows.filter(r => r.eligible);
  const detailOf = (d: ScoreBreakdown | undefined) => d ? {
    components: d.components, normalized: d.normalized, factor_contributions: d.factor_contributions, imputations: d.imputations,
  } : null;
  const factors = eligible.map(row => {
    const q = qualityOf(row.ts_code);
    const d1 = v1Break.get(row.ts_code);
    const d2 = v2Break.get(row.ts_code);
    if (d1) applyObservationQuality(d1, q);
    if (d2) applyObservationQuality(d2, q);
    const v2 = v2ByCode.get(row.ts_code)!;
    return {
      ts_code: row.ts_code, name: row.name, industry: row.industry, eligible: true,
      raw: rawFactors(row, q),
      v1: { score: row.score ?? null, rank: row.rank ?? null, ...detailOf(d1) },
      v2: { score: v2.score ?? null, rank: v2.rank ?? null, ...detailOf(d2) },
    };
  });

  const v1Pool: PoolMember[] = watchRows.map(m => {
    const row = scan.rows.find(r => r.ts_code === m.ts_code);
    return { ...m, name: row?.name ?? null, signals: signalsOf(m.ts_code) };
  });

  const previous = predecessor.rows;
  const state = buildV2StateDb(live, previous);
  let v2Pool: PoolMember[];
  try {
    const result = updateWatchlist(state, {
      trade_date: date, rows: v2Rows, sectors: scan.sectors, suspended_or_missing: scan.suspended_or_missing,
      signal_counts: scan.signal_counts, pct_above_ma20: scan.pct_above_ma20, pct_above_ma60: scan.pct_above_ma60,
    } as MarketScan);
    v2Pool = result.members.map(m => ({ ...m, signals: signalsOf(m.ts_code) }));
  } finally {
    state.close();
  }

  const v1Codes = new Set(v1Pool.map(m => m.ts_code));
  const v2Codes = new Set(v2Pool.map(m => m.ts_code));
  const poolDiff = {
    common: [...v1Codes].filter(c => v2Codes.has(c)).sort(),
    v1_only: [...v1Codes].filter(c => !v2Codes.has(c)).sort(),
    v2_only: [...v2Codes].filter(c => !v1Codes.has(c)).sort(),
  };

  const v2By = new Map(v2Rows.map(r => [r.ts_code, r]));
  const allDiffs = eligible.map(row => {
    const b = v2By.get(row.ts_code)!;
    const x = v1Break.get(row.ts_code), y = v2Break.get(row.ts_code);
    return {
      ts_code: row.ts_code, industry: row.industry, cash_pct: row.fundamentals?.ocf_to_profit ?? null,
      v1_score: row.score, v2_score: b.score, score_delta: (b.score ?? 0) - (row.score ?? 0),
      v1_rank: row.rank, v2_rank: b.rank, rank_delta: (b.rank ?? 0) - (row.rank ?? 0),
      cash_contribution_delta: x && y ? y.factor_contributions.cash - x.factor_contributions.cash : null,
    };
  });
  const diffs = allDiffs.filter(d => d.score_delta !== 0);

  const versions = snapshotVersions();
  const identity = {
    protocol: SNAPSHOT_PROTOCOL_VERSION,
    trade_date: date,
    data_cutoff: cutoff,
    report: { report_id: report.report_id, status: report.status, generated_at: report.generated_at },
    quality: { status: quality.status, cache_status: quality.cache_status, reasons: quality.reasons },
    data_snapshot: {
      written_at: quality.snapshot.written_at, spread_minutes: quality.snapshot.spread_minutes, mixed: quality.snapshot.mixed,
      counts: quality.counts, latest_sync: latestSync(live),
    },
    versions,
    build_sha256: buildSha256(),
    score_inputs: { score_rules: SCORE_RULES, watchlist_rules: WATCHLIST_RULES },
    parameters: { horizon, ...SNAPSHOT_COSTS },
    previous_v2_pool: previous.map(p => [p.ts_code, p.entered_on]),
  };
  const snapshotId = `FWD-${date}-${sha256(canonical(identity)).slice(0, 16)}`;

  const members = [
    ...v1Pool.map(row => ({ version: SCORE_VERSION, row })),
    ...v2Pool.map(row => ({ version: RESEARCH_SCORE_VERSION, row })),
  ];
  const membersDigest = sha256(canonical(members));
  const factorsDigest = sha256(canonical(factors));

  const content = {
    snapshot_id: snapshotId,
    schema: SNAPSHOT_PROTOCOL_VERSION,
    status: 'ORIGINAL',
    revises: null,
    trade_date: date,
    data_cutoff: cutoff,
    report: { report_id: report.report_id, status: report.status, generated_at: report.generated_at, run_mode: report.run_mode },
    quality_status: quality.status,
    quality: stripQuality(quality),
    data_snapshot: {
      ...quality.snapshot,
      counts: quality.counts,
      latest_sync: latestSync(live),
    },
    versions,
    build_sha256: buildSha256(),
    parameters: { horizon, ...SNAPSHOT_COSTS },
    score_inputs: { score_rules: SCORE_RULES, watchlist_rules: WATCHLIST_RULES },
    universe: {
      scanned: scan.rows.length,
      eligible: eligible.length,
      ineligible: scan.rows.length - eligible.length,
      suspended_or_missing: scan.suspended_or_missing,
      signal_counts: scan.signal_counts,
      factor_rows: factors.length,
      members_digest: membersDigest,
      factors_digest: factorsDigest,
    },
    v1_pool: { source: SNAPSHOT_POOL_SOURCES.v1, count: v1Pool.length, members: v1Pool },
    v2_pool: {
      source: SNAPSHOT_POOL_SOURCES.v2,
      count: v2Pool.length,
      previous_date: predecessor.previous_date,
      previous_snapshot_id: predecessor.previous_snapshot_id,
      previous_state_source: predecessor.previous_state_source,
      seed: predecessor.previous_snapshot_id === null ? (predecessor.seed
        ? { ...predecessor.seed, source: 'seed' }
        : {
          source: 'chain_start', trade_date: null,
          note: '链首快照：此前没有原始快照或种子状态，V2 池按 wl-1.0.0 初始建池规则初始化。',
        }) : null,
      members: v2Pool,
      note: '研究用 V2 股票池，按 wl-1.0.0 规则从上一份 V2 研究池逐日推进，与正式 V1 股票池相互独立；不是正式发布列表。',
    },
    comparison_baseline: predecessor.seed ? {
      seed_date: predecessor.seed.seed_date,
      seed_report_id: predecessor.seed.source_report_id,
      seed_members_digest: predecessor.seed.members_digest,
      note: 'V1 与 V2 的共同初始状态；此后两版成员差异只能归因于评分规则与由评分驱动的状态演化。',
    } : null,
    pool_diff: poolDiff,
    v1_v2: {
      changed_scores: diffs.length,
      score_delta: distribution(diffs.map(d => d.score_delta)),
      rank_correlation: correlation(allDiffs.map(d => [d.v1_rank, d.v2_rank])),
      diffs,
      note: '两版使用同一可评分集合与同一归一化，仅现金流项阈值不同；逐股差异见 diffs 与 snapshot_factor。',
    },
    v1_parity: parity,
    future_returns: {
      status: 'PENDING',
      horizon,
      planned_exit_date: plannedExitDate(live, date, horizon),
      as_of: cutoff,
      note: '持有期尚未结束或尚未评价；不计算任何假定未来收益。到期后使用 research-evaluate。',
    },
    limitations: [
      '行业、名称与 ST 标记为当前 stock_basic 口径，不是当日历史时点。',
      'V2 股票池是独立研究池，成员与正式 V1 池不同不构成正式建议。',
      '快照只记录当日及之前缓存可见的数据；后续数据修订不会覆盖原始快照，只能另存 REVISED 记录。',
      'pool_state 只记录原始快照与共同起点种子；修订记录不进入状态链。',
    ],
  };

  return {
    snapshot_id: snapshotId,
    content,
    content_digest: sha256(canonical(content)),
    members,
    factors,
    v2Pool,
  };
}

// ------------------------------------------------------------------- snapshot

export interface ResearchSnapshotOptions {
  date: string;
  dbPath?: string;
  revise?: boolean;
  horizon?: number;
  liveDbPath?: string;
}

export interface ResearchEvaluateOptions {
  date: string;
  dbPath?: string;
  asOf?: string;
  horizon?: number;
  liveDbPath?: string;
}

interface StoredObservation {
  type: string | null; reason: string | null; report_generated_at: string | null;
  prospective_start: string | null; window_hours: number | null;
}

const observationOf = (row: any): StoredObservation => ({
  type: row?.observation_type ?? null,
  reason: row?.observation_reason ?? null,
  report_generated_at: row?.report_generated_at ?? null,
  prospective_start: row?.prospective_start ?? null,
  window_hours: row?.window_hours ?? null,
});

/**
 * `research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]`.
 * Writes only to the research snapshot database; returns a JSON summary.
 * A REVISED snapshot appends evidence but never touches the pool_state chain.
 */
export function runResearchSnapshot(options: ResearchSnapshotOptions) {
  const date = validateDate(options.date);
  const horizon = horizonOf(options.horizon);
  const livePath = options.liveDbPath ?? ashareDbPath();
  const dbPath = options.dbPath ?? researchSnapshotDbPath();
  // Refuse a research path that aliases the live database before opening either file.
  assertSeparateFromLive(dbPath, livePath);
  const live = openLiveReadOnly(livePath);
  let snap: DatabaseSync | undefined;
  try {
    const cal = live.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(date) as any;
    if (!cal) return { status: 'NOT_TRADE_DAY', date, is_open: null, reason: '交易日历缺少该日期', live_db: livePath };
    if (cal.is_open !== 1) return { status: 'NOT_TRADE_DAY', date, is_open: false, reason: '非交易日', live_db: livePath };
    const cutoff = dataCutoff(live);
    const today = shanghaiToday();
    if (!cutoff) return { status: 'PENDING', date, reason: 'no_cached_daily_data', today, data_cutoff: null };
    if (date > cutoff) return { status: 'PENDING', date, reason: 'date_after_data_cutoff', today, data_cutoff: cutoff };
    if (date > today) return { status: 'PENDING', date, reason: 'date_in_future', today, data_cutoff: cutoff };

    const quality = checkQuality(live, date, false);
    if (quality.counts.daily === 0) return { status: 'PENDING', date, reason: 'no_daily_rows', data_cutoff: cutoff, quality_status: quality.status };
    if (quality.status === 'NOT_READY') {
      return { status: 'NOT_READY', date, data_cutoff: cutoff, quality_status: quality.status, reasons: quality.reasons, quality: stripQuality(quality) };
    }
    const report = liveReport(live, date);
    if (!report) return { status: 'PENDING', date, reason: 'no_live_report', data_cutoff: cutoff, quality_status: quality.status };

    snap = openSnapshotDb(dbPath, livePath);
    const existing = snap.prepare('SELECT * FROM snapshot WHERE trade_date = ? ORDER BY created_at, snapshot_id').all(date) as any[];
    const createdAt = new Date().toISOString();
    const originalRow = existing.find(r => r.status === 'ORIGINAL') ?? existing[0] ?? null;

    if (existing.length) {
      // Recomputing a stored date (EXISTS or --revise) reuses the predecessor the
      // ORIGINAL row recorded, so a revision can never pick up a later chain.
      const recorded = recordedPredecessor(snap, originalRow, date);
      if (!options.revise) {
        if (!recorded.ok) {
          return {
            status: 'EXISTS',
            snapshot_id: existing[0].snapshot_id,
            trade_date: date,
            stored_status: existing[0].status,
            revisions: existing.filter(r => r.status === 'REVISED').length,
            content_digest: existing[0].content_digest,
            recomputed_snapshot_id: null,
            content_matches_stored: null,
            observation: observationOf(existing[0]),
            chain_gap: recorded.gap,
            db: dbPath,
          };
        }
        const recomputed = computeSnapshot(live, date, horizon, report, quality, recorded.predecessor);
        return {
          status: 'EXISTS',
          snapshot_id: existing[0].snapshot_id,
          trade_date: date,
          stored_status: existing[0].status,
          revisions: existing.filter(r => r.status === 'REVISED').length,
          content_digest: existing[0].content_digest,
          recomputed_snapshot_id: recomputed.snapshot_id,
          content_matches_stored: recomputed.content_digest === existing[0].content_digest,
          observation: observationOf(existing[0]),
          db: dbPath,
        };
      }
      // --revise: append evidence only; the state chain stays untouched.
      if (!recorded.ok) return { ...recorded.gap, db: dbPath };
      const predecessor = recorded.predecessor;
      const computed = computeSnapshot(live, date, horizon, report, quality, predecessor);
      const revisionSeq = existing.filter(r => r.status === 'REVISED').length + 1;
      const snapshotId = `${computed.snapshot_id}-R${revisionSeq}`;
      const status = 'REVISED';
      const revises = originalRow?.snapshot_id ?? null;
      // The observation-time attribute belongs to the original observation: a
      // revision keeps it verbatim and can never be relabelled by re-running.
      const observation: Observation | StoredObservation = observationOf(originalRow);

      computed.content.snapshot_id = snapshotId;
      computed.content.status = status;
      computed.content.revises = revises;
      const contentDigest = sha256(canonical(computed.content));

      snap.exec('BEGIN IMMEDIATE');
      try {
        snap.prepare(`INSERT INTO snapshot (snapshot_id, trade_date, status, revises, created_at, content_digest, content,
            observation_type, observation_reason, report_generated_at, prospective_start, window_hours)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(snapshotId, date, status, revises, createdAt, contentDigest, canonical(computed.content),
            observation.type, observation.reason, observation.report_generated_at,
            observation.prospective_start, observation.window_hours);
        const insMember = snap.prepare('INSERT INTO snapshot_member (snapshot_id, version, ts_code, score, rank, industry, status, reason, entered_on, signals) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const { version, row } of computed.members) {
          insMember.run(snapshotId, version, row.ts_code, row.score, row.rank, row.industry, row.status, row.reason, row.entered_on, canonical(row.signals));
        }
        const insFactor = snap.prepare('INSERT INTO snapshot_factor (snapshot_id, ts_code, industry, eligible, raw, v1, v2) VALUES (?,?,?,?,?,?,?)');
        for (const f of computed.factors) {
          insFactor.run(snapshotId, f.ts_code, f.industry, 1, canonical(f.raw), canonical(f.v1), canonical(f.v2));
        }
        snap.exec('COMMIT');
      } catch (error) {
        snap.exec('ROLLBACK');
        throw error;
      }
      return {
        status, snapshot_id: snapshotId, revises, trade_date: date, data_cutoff: cutoff,
        report_id: report.report_id, report_status: report.status, quality_status: quality.status,
        created_at: createdAt, content_digest: contentDigest, observation,
        chain: {
          previous_date: predecessor.previous_date,
          previous_snapshot_id: predecessor.previous_snapshot_id,
          previous_state_source: predecessor.previous_state_source,
          seed_id: predecessor.seed?.seed_id ?? null,
          chain_updated: false,
        },
        comparison_baseline: computed.content.comparison_baseline,
        universe: computed.content.universe,
        v1_pool: { source: SNAPSHOT_POOL_SOURCES.v1, count: computed.content.v1_pool.count },
        v2_pool: {
          source: SNAPSHOT_POOL_SOURCES.v2, count: computed.content.v2_pool.count,
          previous_date: computed.content.v2_pool.previous_date,
          previous_snapshot_id: computed.content.v2_pool.previous_snapshot_id,
        },
        pool_diff: { common: computed.content.pool_diff.common.length, v1_only: computed.content.pool_diff.v1_only.length, v2_only: computed.content.pool_diff.v2_only.length },
        v1_parity: { ok: true, eligible: computed.content.v1_parity.eligible, stock_score_rows: computed.content.v1_parity.stock_score_rows },
        changed_scores: computed.content.v1_v2.changed_scores,
        db: dbPath,
      };
    }

    const chain = resolveChain(live, snap, date);
    // A broken chain must never be papered over.
    if (!chain.ok) return { ...chain.gap, db: dbPath };
    const predecessor = chain.predecessor;
    const computed = computeSnapshot(live, date, horizon, report, quality, predecessor);
    const snapshotId = computed.snapshot_id;
    const status = 'ORIGINAL';
    const revises = null;
    const observation = classifyObservation({
      tradeDate: date, dataCutoff: cutoff,
      reportGeneratedAt: report.generated_at ?? null, createdAt,
    });

    computed.content.snapshot_id = snapshotId;
    computed.content.status = status;
    computed.content.revises = revises;
    const contentDigest = sha256(canonical(computed.content));

    snap.exec('BEGIN IMMEDIATE');
    try {
      snap.prepare(`INSERT INTO snapshot (snapshot_id, trade_date, status, revises, created_at, content_digest, content,
          observation_type, observation_reason, report_generated_at, prospective_start, window_hours)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(snapshotId, date, status, revises, createdAt, contentDigest, canonical(computed.content),
          observation.type, observation.reason, observation.report_generated_at,
          observation.prospective_start, observation.window_hours);
      const insMember = snap.prepare('INSERT INTO snapshot_member (snapshot_id, version, ts_code, score, rank, industry, status, reason, entered_on, signals) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const { version, row } of computed.members) {
        insMember.run(snapshotId, version, row.ts_code, row.score, row.rank, row.industry, row.status, row.reason, row.entered_on, canonical(row.signals));
      }
      const insFactor = snap.prepare('INSERT INTO snapshot_factor (snapshot_id, ts_code, industry, eligible, raw, v1, v2) VALUES (?,?,?,?,?,?,?)');
      for (const f of computed.factors) {
        insFactor.run(snapshotId, f.ts_code, f.industry, 1, canonical(f.raw), canonical(f.v1), canonical(f.v2));
      }
      // Only ORIGINAL snapshots enter the state chain.
      snap.prepare('DELETE FROM pool_state WHERE version = ? AND trade_date = ?').run(RESEARCH_SCORE_VERSION, date);
      const insPool = snap.prepare(`INSERT INTO pool_state (version, trade_date, ts_code, entered_on, score, rank, industry, status,
          previous_snapshot_id, state_source, source_id, seed_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const m of computed.v2Pool) {
        insPool.run(RESEARCH_SCORE_VERSION, date, m.ts_code, m.entered_on, m.score, m.rank, m.industry, m.status,
          predecessor.previous_snapshot_id, POOL_STATE_SOURCES.snapshot, snapshotId, null);
      }
      snap.exec('COMMIT');
    } catch (error) {
      snap.exec('ROLLBACK');
      throw error;
    }

    return {
      status,
      snapshot_id: snapshotId,
      revises,
      trade_date: date,
      data_cutoff: cutoff,
      report_id: report.report_id,
      report_status: report.status,
      quality_status: quality.status,
      created_at: createdAt,
      content_digest: contentDigest,
      observation,
      chain: {
        previous_date: predecessor.previous_date,
        previous_snapshot_id: predecessor.previous_snapshot_id,
        previous_state_source: predecessor.previous_state_source,
        seed_id: predecessor.seed?.seed_id ?? null,
        chain_updated: true,
      },
      comparison_baseline: computed.content.comparison_baseline,
      universe: computed.content.universe,
      v1_pool: { source: SNAPSHOT_POOL_SOURCES.v1, count: computed.content.v1_pool.count },
      v2_pool: {
        source: SNAPSHOT_POOL_SOURCES.v2, count: computed.content.v2_pool.count,
        previous_date: computed.content.v2_pool.previous_date,
        previous_snapshot_id: computed.content.v2_pool.previous_snapshot_id,
      },
      pool_diff: { common: computed.content.pool_diff.common.length, v1_only: computed.content.pool_diff.v1_only.length, v2_only: computed.content.pool_diff.v2_only.length },
      v1_parity: { ok: true, eligible: computed.content.v1_parity.eligible, stock_score_rows: computed.content.v1_parity.stock_score_rows },
      changed_scores: computed.content.v1_v2.changed_scores,
      db: dbPath,
    };
  } finally {
    snap?.close();
    live.close();
  }
}

// ----------------------------------------------------------------------- seed

export interface ResearchSeedOptions {
  date: string;
  dbPath?: string;
  liveDbPath?: string;
}

export interface SeedMember {
  ts_code: string; score: number | null; rank: number | null; industry: string | null;
  status: string | null; reason: string | null; entered_on: string;
}

/**
 * `research-seed --date YYYYMMDD [--db PATH]`: write the one-time common starting
 * state for the V1/V2 comparison from the last formal V1 watchlist. V1 stays the
 * formal published list; V2 advances in the research database from this state,
 * keeping every member's entry date. Idempotent for identical content; refuses
 * once the research chain has started.
 */
export function runResearchSeed(options: ResearchSeedOptions) {
  const date = validateDate(options.date);
  const livePath = options.liveDbPath ?? ashareDbPath();
  const dbPath = options.dbPath ?? researchSnapshotDbPath();
  assertSeparateFromLive(dbPath, livePath);
  const live = openLiveReadOnly(livePath);
  let snap: DatabaseSync | undefined;
  try {
    const cal = live.prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?').get(date) as any;
    if (!cal || cal.is_open !== 1) return { status: 'REFUSED', reason: 'not_trade_day', trade_date: date, db: dbPath };
    const members = live.prepare(`SELECT ts_code, score, rank, industry, status, reason, entered_on
      FROM watchlist WHERE trade_date = ? ORDER BY rank, ts_code`).all(date) as unknown as SeedMember[];
    if (!members.length) return { status: 'REFUSED', reason: 'no_formal_watchlist', trade_date: date, db: dbPath };
    const report = liveReport(live, date);
    if (!report) return { status: 'REFUSED', reason: 'no_live_report', trade_date: date, db: dbPath };

    const membersDigest = sha256(canonical(members));
    const seedId = `SEED-${date}-${membersDigest.slice(0, 16)}`;
    snap = openSnapshotDb(dbPath, livePath);
    const existingSeed = snap.prepare('SELECT * FROM pool_seed WHERE version = ?').all(RESEARCH_SCORE_VERSION) as any[];
    const sameDate = existingSeed.find(r => r.trade_date === date);
    if (sameDate) {
      if (sameDate.members_digest !== membersDigest) {
        throw new Error(`种子内容冲突：${date} 已存在成员摘要 ${sameDate.members_digest}，当前正式股票池摘要为 ${membersDigest}；种子只能设置一次`);
      }
      return {
        status: 'EXISTS', seed_id: sameDate.seed_id, trade_date: date, version: RESEARCH_SCORE_VERSION,
        source_report_id: sameDate.source_report_id, source_report_generated_at: sameDate.source_report_generated_at,
        member_count: sameDate.member_count, members_digest: sameDate.members_digest,
        created_at: sameDate.created_at, db: dbPath,
      };
    }
    if (existingSeed.length) {
      return {
        status: 'REFUSED', reason: 'seed_already_exists', trade_date: date,
        existing_seed: existingSeed.map(r => ({ seed_id: r.seed_id, trade_date: r.trade_date })), db: dbPath,
      };
    }
    const later = snap.prepare("SELECT snapshot_id, trade_date FROM snapshot WHERE status = 'ORIGINAL' AND trade_date > ? ORDER BY trade_date")
      .all(date) as any[];
    if (later.length) {
      return { status: 'REFUSED', reason: 'later_original_snapshot_exists', trade_date: date, later_snapshots: later, db: dbPath };
    }
    const sameDay = snap.prepare("SELECT snapshot_id FROM snapshot WHERE status = 'ORIGINAL' AND trade_date = ?").get(date) as any;
    if (sameDay) {
      return {
        status: 'REFUSED', reason: 'original_snapshot_on_seed_date', trade_date: date,
        snapshot_id: sameDay.snapshot_id, note: '该日期已有原始快照及其池状态；种子只能写入没有快照链的日期', db: dbPath,
      };
    }

    const createdAt = new Date().toISOString();
    const content = {
      seed_id: seedId, version: RESEARCH_SCORE_VERSION, trade_date: date,
      source_report_id: report.report_id, source_report_generated_at: report.generated_at,
      members_digest: membersDigest, member_count: members.length, created_at: createdAt, members,
    };
    snap.exec('BEGIN IMMEDIATE');
    try {
      snap.prepare(`INSERT INTO pool_seed (seed_id, version, trade_date, source_report_id, source_report_generated_at,
          members_digest, member_count, created_at, content) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(seedId, RESEARCH_SCORE_VERSION, date, report.report_id, report.generated_at,
          membersDigest, members.length, createdAt, canonical(content));
      snap.prepare('DELETE FROM pool_state WHERE version = ? AND trade_date = ?').run(RESEARCH_SCORE_VERSION, date);
      const insPool = snap.prepare(`INSERT INTO pool_state (version, trade_date, ts_code, entered_on, score, rank, industry, status,
          previous_snapshot_id, state_source, source_id, seed_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const m of members) {
        insPool.run(RESEARCH_SCORE_VERSION, date, m.ts_code, m.entered_on, m.score, m.rank, m.industry, m.status,
          null, POOL_STATE_SOURCES.seed, seedId, seedId);
      }
      snap.exec('COMMIT');
    } catch (error) {
      snap.exec('ROLLBACK');
      throw error;
    }
    return {
      status: 'SEEDED', seed_id: seedId, trade_date: date, version: RESEARCH_SCORE_VERSION,
      source_report_id: report.report_id, source_report_generated_at: report.generated_at,
      member_count: members.length, members_digest: membersDigest, created_at: createdAt, db: dbPath,
    };
  } finally {
    snap?.close();
    live.close();
  }
}

// ------------------------------------------------------------------ evaluate

/**
 * Only true prospective observations, so later statistics can exclude
 * backfilled history. The observation attribute is stored at write time and is
 * never updated by any command.
 */
export function prospectiveSnapshots(dbPath = researchSnapshotDbPath()) {
  if (!existsSync(dbPath)) return [];
  // Opening through openSnapshotDb also applies the fwd-snapshot-1.1.0 column
  // migration to databases written by the previous build; the path guard runs first.
  const snap = openSnapshotDb(dbPath);
  try {
    return snap.prepare(`SELECT snapshot_id, trade_date, status, revises, created_at,
        observation_type, observation_reason, report_generated_at, prospective_start, window_hours
      FROM snapshot WHERE observation_type = ? ORDER BY trade_date, created_at, snapshot_id`)
      .all(OBSERVATION_TYPES.prospective);
  } finally {
    snap.close();
  }
}

/**
 * `research-evaluate --date YYYYMMDD [--db PATH] [--as-of YYYYMMDD] [--horizon 10]`.
 * Evaluates every saved snapshot of that date (original and revisions) with the
 * same method and as-of date. Immature horizons stay PENDING; nothing is
 * overwritten and no return is fabricated.
 */
export function runResearchEvaluate(options: ResearchEvaluateOptions) {
  const date = validateDate(options.date);
  const horizon = horizonOf(options.horizon);
  const livePath = options.liveDbPath ?? ashareDbPath();
  const dbPath = options.dbPath ?? researchSnapshotDbPath();
  // Path identity is checked first: an alias of the live database must be
  // rejected even though the file exists.
  assertSeparateFromLive(dbPath, livePath);
  if (!existsSync(dbPath)) throw new Error(`快照数据库不存在: ${dbPath}（请先运行 research-snapshot）`);
  const live = openLiveReadOnly(livePath);
  const snap = openSnapshotDb(dbPath, livePath);
  try {
    const rows = snap.prepare('SELECT * FROM snapshot WHERE trade_date = ? ORDER BY created_at, snapshot_id').all(date) as any[];
    if (!rows.length) return { status: 'PENDING', reason: 'no_snapshot_for_date', trade_date: date, db: dbPath };
    const cutoff = dataCutoff(live);
    if (!cutoff) throw new Error('正式缓存没有日线数据');
    const requested = options.asOf ? validateDate(options.asOf, '--as-of') : shanghaiToday();
    const asOf = requested < cutoff ? requested : cutoff;
    if (asOf < date) throw new Error(`--as-of ${asOf} 早于快照日期 ${date}`);

    const days = tradeDaysBetween(live, date, asOf);
    const i = days.indexOf(date);
    // The exit date comes from the full calendar so a pending evaluation still
    // reports when it will mature; maturity additionally requires exit <= asOf.
    const plannedExit = plannedExitDate(live, date, horizon);
    const matured = plannedExit !== null && plannedExit <= asOf && i >= 0;
    const createdAt = new Date().toISOString();
    const evaluationOptions = {
      asOf, horizon, buyFeeBps: SNAPSHOT_COSTS.buy_fee_bps, sellFeeBps: SNAPSHOT_COSTS.sell_fee_bps,
      slippageBps: SNAPSHOT_COSTS.slippage_bps, maxExitDelay: SNAPSHOT_COSTS.max_exit_delay,
    };

    const snapshots = rows.map(row => {
      const content = JSON.parse(row.content);
      const versions: Record<string, any> = {};
      for (const [version, poolKey] of [[SCORE_VERSION, 'v1_pool'], [RESEARCH_SCORE_VERSION, 'v2_pool']] as const) {
        const members = content[poolKey]?.members ?? [];
        const events: EvaluationEvent[] = members.map((m: any) => ({
          date, ts_code: m.ts_code, score: m.score ?? null, industry: m.industry ?? null, signals: m.signals ?? [],
        }));
        const result = evaluateEvents(live, events, evaluationOptions);
        const status = matured ? 'MATURED' : 'PENDING';
        const stored = {
          snapshot_id: row.snapshot_id, version, trade_date: date, as_of: asOf, horizon, matured, status,
          planned_exit_date: plannedExit,
          pool_source: content[poolKey]?.source ?? null,
          events: events.length,
          evaluation: result,
        };
        const existing = snap.prepare('SELECT status, content FROM snapshot_evaluation WHERE snapshot_id = ? AND version = ? AND as_of = ? AND horizon = ?')
          .get(row.snapshot_id, version, asOf, horizon) as any;
        if (existing) {
          versions[version] = JSON.parse(existing.content);
        } else {
          snap.prepare('INSERT INTO snapshot_evaluation (snapshot_id, version, as_of, horizon, status, created_at, content) VALUES (?,?,?,?,?,?,?)')
            .run(row.snapshot_id, version, asOf, horizon, status, createdAt, canonical(stored));
          versions[version] = stored;
        }
      }
      return {
        snapshot_id: row.snapshot_id,
        stored_status: row.status,
        revises: row.revises,
        observation: observationOf(row),
        as_of: asOf,
        horizon,
        matured,
        planned_exit_date: plannedExit,
        versions: Object.fromEntries(Object.entries(versions).map(([version, v]: [string, any]) => [version, {
          status: v.status,
          pool_source: v.pool_source,
          events: v.events,
          denominators: v.evaluation.summary.denominators,
          net_return: v.evaluation.summary.net_return,
        }])),
      };
    });

    return { status: 'EVALUATED', trade_date: date, as_of: asOf, horizon, matured, planned_exit_date: plannedExit, db: dbPath, snapshots };
  } finally {
    snap.close();
    live.close();
  }
}
