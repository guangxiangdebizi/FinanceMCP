import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ashareDataDir, ashareDbPath } from '../ashare/db.js';

/**
 * 私有账户账本（P2）。与公开市场库物理隔离：默认写入
 * `<ASHARE_DATA_DIR>/portfolio.sqlite`，绝不写入 `ashare.sqlite`。
 *
 * 单位约定（全模块一致）：
 * - 金额一律用整数**分**（cents）。
 * - 价格一律用整数**厘**（milli-yuan，1 厘 = 0.001 元）。A 股 ETF 最小变动价位
 *   是 0.001 元，用分存 1.005 会丢精度，因此价格单独用厘，并在字段名里写明 `_milli`。
 * - 数量用整数**份/股**。
 *
 * R0 只写入一次基线快照；`flow` 表为后续真实出入金/分红预留，本轮没有写入路径。
 */

export function portfolioDbPath(): string {
  return process.env.ASHARE_PORTFOLIO_DB_PATH?.trim() || join(ashareDataDir(), 'portfolio.sqlite');
}

/** 账户工具默认关闭：公网 ashare_daily profile 不应暴露账户数据。 */
export function portfolioEnabled(): boolean {
  return process.env.ASHARE_PORTFOLIO_ENABLED === '1';
}

const PORTFOLIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL,
  warnings TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  total_assets_cents INTEGER NOT NULL,
  securities_mv_cents INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  wealth_cents INTEGER NOT NULL,
  unrealized_pnl_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS position (
  snapshot_id TEXT NOT NULL,
  ts_code TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  ref_price_milli INTEGER NOT NULL,
  ref_cost_milli INTEGER NOT NULL,
  market_value_cents INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, ts_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS flow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
`;

/**
 * 把路径解析成"最深的已存在祖先的真实路径 + 未创建的后缀"，因此尚未创建的
 * 账户库也能与市场库按真实路径比较（与 ashare/snapshot.ts 的研究库守卫同一思路）。
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

/** `dev:ino`；文件不存在时返回 null。用于识别硬链接。 */
function fileIdentity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * 拒绝把账户库指向市场库：绝对/相对路径、`..`、符号链接、硬链接、符号链接的父目录
 * 都算同一个文件。返回解析后的账户库路径。必须在创建任何文件之前调用。
 */
export function assertPortfolioSeparateFromMarket(path: string, marketPath: string = ashareDbPath()): string {
  const portfolio = realPathOfNearestAncestor(path);
  const market = realPathOfNearestAncestor(marketPath);
  const reject = () => new Error(`账户数据库不能与正式市场数据库相同（${portfolio}），拒绝执行`);
  if (portfolio === market) throw reject();
  const portfolioId = fileIdentity(portfolio);
  if (portfolioId !== null && portfolioId === fileIdentity(market)) throw reject();
  return portfolio;
}

/**
 * 打开账户账本。`writable` 为 false 时以只读方式打开，供 MCP 工具使用；
 * 只读打开不会创建文件。任何路径别名都会在打开前被拒绝。
 */
export function openPortfolioDb(path = portfolioDbPath(), options: { writable?: boolean; marketPath?: string } = {}): DatabaseSync {
  const resolved = assertPortfolioSeparateFromMarket(path, options.marketPath ?? ashareDbPath());
  const writable = options.writable !== false;
  if (writable) {
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000;');
    db.exec(PORTFOLIO_SCHEMA);
    return db;
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 15000;');
  return db;
}

export function inPortfolioTransaction<T>(db: DatabaseSync, fn: () => T): T {
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
