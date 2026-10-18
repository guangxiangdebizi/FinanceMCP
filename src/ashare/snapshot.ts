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
import { checkQuality, shanghaiToday, tradeDaysBetween, type QualityReport } from './ingest.js';
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
 */
export const SNAPSHOT_PROTOCOL_VERSION = 'fwd-snapshot-1.0.0';
export const DEFAULT_HORIZON = 10;
export const SNAPSHOT_COSTS = { buy_fee_bps: 3, sell_fee_bps: 8, slippage_bps: 5, max_exit_delay: 5 };
export const SNAPSHOT_POOL_SOURCES = {
  v1: 'formal_live_watchlist',
  v2: 'research_v2_sequential',
} as const;

const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  status TEXT NOT NULL,
  revises TEXT,
  created_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content TEXT NOT NULL
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
-- Latest persisted V2 pool per trade date; the previous pool for a new
-- snapshot is the latest row set strictly before its date.
CREATE TABLE IF NOT EXISTS pool_state (
  version TEXT NOT NULL, trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, entered_on TEXT NOT NULL,
  PRIMARY KEY (version, trade_date, ts_code)
) WITHOUT ROWID;
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

function openSnapshotDb(path: string, livePath: string = ashareDbPath()): DatabaseSync {
  const resolved = assertSeparateFromLive(path, livePath);
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000;');
  db.exec(SNAPSHOT_SCHEMA);
  return db;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value);

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

interface PoolMember {
  ts_code: string; name?: string | null; score: number; rank: number; industry: string; status: string; reason: string;
  entered_on: string; signals: string[];
}

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

function previousV2Pool(snap: DatabaseSync, date: string) {
  return snap.prepare(`SELECT trade_date, ts_code, entered_on FROM pool_state
    WHERE version = ? AND trade_date = (SELECT MAX(trade_date) FROM pool_state WHERE version = ? AND trade_date < ?)
    ORDER BY ts_code`).all(RESEARCH_SCORE_VERSION, RESEARCH_SCORE_VERSION, date) as any[];
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
    for (const p of previous) w.run(pdate, p.ts_code, 0, 0, null, 'kept', '', p.entered_on);
  }
  return state;
}

function computeSnapshot(live: DatabaseSync, snap: DatabaseSync, date: string, horizon: number, report: any, quality: QualityReport): ComputedSnapshot {
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

  const previous = previousV2Pool(snap, date);
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
      previous_date: previous.length ? previous[0].trade_date : null,
      members: v2Pool,
      note: '研究用 V2 股票池，按 wl-1.0.0 规则从上一份 V2 研究池逐日推进，与正式 V1 股票池相互独立；不是正式发布列表。',
    },
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

/**
 * `research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]`.
 * Writes only to the research snapshot database; returns a JSON summary.
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
    const existing = snap.prepare('SELECT snapshot_id, status, revises, created_at, content_digest, content FROM snapshot WHERE trade_date = ? ORDER BY created_at, snapshot_id').all(date) as any[];

    if (existing.length && !options.revise) {
      const computed = computeSnapshot(live, snap, date, horizon, report, quality);
      return {
        status: 'EXISTS',
        snapshot_id: existing[0].snapshot_id,
        trade_date: date,
        stored_status: existing[0].status,
        revisions: existing.filter(r => r.status === 'REVISED').length,
        content_digest: existing[0].content_digest,
        recomputed_snapshot_id: computed.snapshot_id,
        content_matches_stored: computed.content_digest === existing[0].content_digest,
        db: dbPath,
      };
    }

    const computed = computeSnapshot(live, snap, date, horizon, report, quality);
    const original = existing.find(r => r.status === 'ORIGINAL') ?? existing[0];
    const revisionSeq = existing.filter(r => r.status === 'REVISED').length + 1;
    const snapshotId = existing.length ? `${computed.snapshot_id}-R${revisionSeq}` : computed.snapshot_id;
    const status = existing.length ? 'REVISED' : 'ORIGINAL';
    const revises = existing.length ? (original?.snapshot_id ?? null) : null;
    const createdAt = new Date().toISOString();

    computed.content.snapshot_id = snapshotId;
    computed.content.status = status;
    computed.content.revises = revises;
    const contentDigest = sha256(canonical(computed.content));

    snap.exec('BEGIN IMMEDIATE');
    try {
      snap.prepare('INSERT INTO snapshot (snapshot_id, trade_date, status, revises, created_at, content_digest, content) VALUES (?,?,?,?,?,?,?)')
        .run(snapshotId, date, status, revises, createdAt, contentDigest, canonical(computed.content));
      const insMember = snap.prepare('INSERT INTO snapshot_member (snapshot_id, version, ts_code, score, rank, industry, status, reason, entered_on, signals) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const { version, row } of computed.members) {
        insMember.run(snapshotId, version, row.ts_code, row.score, row.rank, row.industry, row.status, row.reason, row.entered_on, canonical(row.signals));
      }
      const insFactor = snap.prepare('INSERT INTO snapshot_factor (snapshot_id, ts_code, industry, eligible, raw, v1, v2) VALUES (?,?,?,?,?,?,?)');
      for (const f of computed.factors) {
        insFactor.run(snapshotId, f.ts_code, f.industry, 1, canonical(f.raw), canonical(f.v1), canonical(f.v2));
      }
      snap.prepare('DELETE FROM pool_state WHERE version = ? AND trade_date = ?').run(RESEARCH_SCORE_VERSION, date);
      const insPool = snap.prepare('INSERT INTO pool_state (version, trade_date, ts_code, entered_on) VALUES (?,?,?,?)');
      for (const m of computed.v2Pool) insPool.run(RESEARCH_SCORE_VERSION, date, m.ts_code, m.entered_on);
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
      universe: computed.content.universe,
      v1_pool: { source: SNAPSHOT_POOL_SOURCES.v1, count: computed.content.v1_pool.count },
      v2_pool: { source: SNAPSHOT_POOL_SOURCES.v2, count: computed.content.v2_pool.count, previous_date: computed.content.v2_pool.previous_date },
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
    const rows = snap.prepare('SELECT snapshot_id, status, revises, created_at, content FROM snapshot WHERE trade_date = ? ORDER BY created_at, snapshot_id').all(date) as any[];
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
