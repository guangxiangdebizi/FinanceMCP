import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Root directory for the SQLite cache and JSON report snapshots. */
export function ashareDataDir(): string {
  return resolve(process.env.ASHARE_DATA_DIR?.trim() || join(process.cwd(), 'data', 'ashare'));
}

export function ashareDbPath(): string {
  return process.env.ASHARE_DB_PATH?.trim() || join(ashareDataDir(), 'ashare.sqlite');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade_cal (
  cal_date TEXT PRIMARY KEY,
  is_open INTEGER NOT NULL,
  pretrade_date TEXT
);
CREATE TABLE IF NOT EXISTS stock_basic (
  ts_code TEXT PRIMARY KEY,
  symbol TEXT, name TEXT, area TEXT, industry TEXT, market TEXT, exchange TEXT,
  list_date TEXT, delist_date TEXT, list_status TEXT, is_hs TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS daily (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, pre_close REAL,
  pct_chg REAL, vol REAL, amount REAL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daily_basic (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
  turnover_rate REAL, turnover_rate_f REAL, volume_ratio REAL,
  pe_ttm REAL, pb REAL, ps_ttm REAL, dv_ttm REAL,
  total_mv REAL, circ_mv REAL,
  PRIMARY KEY (trade_date, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adj_factor (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, adj_factor REAL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stk_limit (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, up_limit REAL, down_limit REAL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS index_daily (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, pre_close REAL, pct_chg REAL, vol REAL, amount REAL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fina_indicator (
  ts_code TEXT NOT NULL, end_date TEXT NOT NULL, ann_date TEXT NOT NULL,
  roe REAL, roe_dt REAL, netprofit_yoy REAL, dt_netprofit_yoy REAL, or_yoy REAL,
  grossprofit_margin REAL, debt_to_assets REAL, ocf_to_profit REAL, ocfps REAL, eps REAL,
  PRIMARY KEY (ts_code, end_date, ann_date)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fina_ann ON fina_indicator(ann_date);
CREATE TABLE IF NOT EXISTS sync_log (
  dataset TEXT NOT NULL, key TEXT NOT NULL,
  rows INTEGER NOT NULL, status TEXT NOT NULL, message TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (dataset, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS quality_check (
  trade_date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_score (
  trade_date TEXT NOT NULL, ts_code TEXT NOT NULL,
  score REAL NOT NULL, rank INTEGER NOT NULL, detail TEXT NOT NULL,
  PRIMARY KEY (trade_date, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS watchlist (
  trade_date TEXT NOT NULL, ts_code TEXT NOT NULL,
  score REAL NOT NULL, rank INTEGER NOT NULL, industry TEXT,
  status TEXT NOT NULL, reason TEXT NOT NULL, entered_on TEXT NOT NULL,
  PRIMARY KEY (trade_date, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS watchlist_change (
  trade_date TEXT NOT NULL, ts_code TEXT NOT NULL, action TEXT NOT NULL,
  score REAL, rank INTEGER, reason TEXT NOT NULL,
  PRIMARY KEY (trade_date, ts_code, action)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS report (
  report_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL, status TEXT NOT NULL,
  generated_at TEXT NOT NULL, path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_date ON report(trade_date);
CREATE TABLE IF NOT EXISTS signal_evidence (
  computed_at TEXT NOT NULL, signal TEXT NOT NULL, regime TEXT NOT NULL, horizon INTEGER NOT NULL,
  n INTEGER NOT NULL, days INTEGER NOT NULL, mean_excess REAL, hit_rate REAL, t_stat REAL,
  start_date TEXT, end_date TEXT,
  PRIMARY KEY (signal, regime, horizon)
) WITHOUT ROWID;
`;

// Per-stock tables are keyed (ts_code, trade_date) so a stock's history is one
// contiguous range; the trade_date index serves whole-market daily queries.
const STOCK_FIRST_TABLES = ['daily', 'adj_factor', 'stk_limit'];

function isDateFirst(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as any;
  return /PRIMARY KEY \(trade_date, ts_code\)/.test(row?.sql ?? '');
}

function ensureDateIndexes(db: DatabaseSync): void {
  for (const table of STOCK_FIRST_TABLES) {
    if (!isDateFirst(db, table)) db.exec(`CREATE INDEX IF NOT EXISTS ${table}_date ON ${table}(trade_date)`);
  }
}

/** One-time rebuild of caches created with the earlier (trade_date, ts_code) keys. */
export function migrateAshareDb(db: DatabaseSync): string[] {
  const migrated: string[] = [];
  for (const table of STOCK_FIRST_TABLES) {
    if (!isDateFirst(db, table)) continue;
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as any).sql as string;
    inTransaction(db, () => {
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      db.exec(sql.replace('PRIMARY KEY (trade_date, ts_code)', 'PRIMARY KEY (ts_code, trade_date)'));
      db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_old ORDER BY ts_code, trade_date`);
      db.exec(`DROP TABLE ${table}_old`);
    });
    migrated.push(table);
  }
  ensureDateIndexes(db);
  return migrated;
}

let shared: DatabaseSync | undefined;

export function openAshareDb(path = ashareDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // temp_store=MEMORY: the container root and /tmp are small; large scans must not spill to disk.
  // mmap avoids a read syscall per page on full-market scans.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 2147483648;');
  db.exec(SCHEMA);
  if (STOCK_FIRST_TABLES.some(t => isDateFirst(db, t))) {
    console.error('[ashare] 缓存使用旧主键布局，请运行 `finance-ashare migrate` 以提升扫描性能');
  } else {
    ensureDateIndexes(db);
  }
  return db;
}

/** Process-wide connection used by the MCP tools (read-mostly). */
export function getAshareDb(): DatabaseSync {
  if (!shared) shared = openAshareDb();
  return shared;
}

export function closeAshareDb(): void {
  shared?.close();
  shared = undefined;
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Insert-or-replace rows into a table using only the listed columns. */
export function upsertRows(db: DatabaseSync, table: string, columns: string[], rows: Record<string, any>[]): number {
  if (rows.length === 0) return 0;
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  const stmt = db.prepare(sql);
  inTransaction(db, () => {
    for (const row of rows) {
      stmt.run(...columns.map(col => {
        const value = row[col];
        return value === undefined ? null : value;
      }));
    }
  });
  return rows.length;
}

export function logSync(db: DatabaseSync, dataset: string, key: string, rows: number, status: string, message = ''): void {
  db.prepare('INSERT OR REPLACE INTO sync_log (dataset, key, rows, status, message, synced_at) VALUES (?,?,?,?,?,?)')
    .run(dataset, key, rows, status, message.slice(0, 500), new Date().toISOString());
}
