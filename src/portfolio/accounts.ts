import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled } from './db.js';
import { DEMO_SNAPSHOT_ID, latestSnapshot, readSnapshot, type AccountSnapshot } from './account.js';

/**
 * 真实账户解析（V1.0 C1）。
 *
 * 修复的真实缺陷：私有工具的 `account_id` 缺省值曾是字符串 `'default'`。
 * 生产上唯一的真实账户是 `real-main`，因此"不传 account_id"会静默落到一个
 * 不存在的 `default` 账户，返回 `REAL_ACCOUNT_PENDING`；显式传
 * `account_id="real-main"` 才返回 `REAL_ACCOUNT_VERIFIED`。同一个查询因是否
 * 传参数得到相反的账户身份结论，这是错误的默认值。
 *
 * 规则（与任务书 C1 一致）：
 * - 显式 account_id 必须是本部署实际配置的账户（有基线/完整性声明/真实账户
 *   确认/事件），否则拒绝 —— 不允许拿一个不存在的 ID 去读别人的快照。
 * - 省略 account_id 时：若只有一个已确认真实账户，就用它；若有多个，要求调用方
 *   显式选择（绝不猜）；若没有已确认账户但恰好只有一个配置账户，就用它（它会
 *   如实报告 PENDING）。
 * - 绝不静默落到演示快照或不相关的 `default`。演示账户只能被显式点名。
 */

export interface ConfiguredAccount {
  account_id: string;
  /** 用户显式确认过 `real_account_verified:<id>=1`。 */
  verified: boolean;
  verified_at: string | null;
  /** 账本重建起点；没有基线的账户无法用于跨日重建。 */
  baseline_as_of: string | null;
  baseline_snapshot_id: string | null;
}

/** 本部署实际配置的账户集合（并集，按 account_id 排序）。 */
export function listConfiguredAccounts(db: DatabaseSync): ConfiguredAccount[] {
  const accounts = new Map<string, ConfiguredAccount>();
  const ensure = (id: string): ConfiguredAccount => {
    let row = accounts.get(id);
    if (!row) {
      row = { account_id: id, verified: false, verified_at: null, baseline_as_of: null, baseline_snapshot_id: null };
      accounts.set(id, row);
    }
    return row;
  };
  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

  if (tableExists('account_baseline')) {
    for (const row of db.prepare('SELECT account_id, as_of, snapshot_id FROM account_baseline').all() as any[]) {
      const entry = ensure(String(row.account_id));
      entry.baseline_as_of = String(row.as_of);
      entry.baseline_snapshot_id = String(row.snapshot_id);
    }
  }
  if (tableExists('account_meta')) {
    for (const row of db.prepare("SELECT key, value FROM account_meta WHERE key LIKE 'real_account_verified:%'").all() as any[]) {
      if (row.value !== '1') continue;
      const id = String(row.key).slice('real_account_verified:'.length);
      const entry = ensure(id);
      entry.verified = true;
      const at = db.prepare('SELECT value FROM account_meta WHERE key = ?').get(`real_account_verified_at:${id}`) as any;
      entry.verified_at = at?.value ? String(at.value) : null;
    }
  }
  if (tableExists('account_completeness')) {
    for (const row of db.prepare('SELECT account_id FROM account_completeness').all() as any[]) ensure(String(row.account_id));
  }
  if (tableExists('account_event')) {
    for (const row of db.prepare('SELECT DISTINCT account_id FROM account_event').all() as any[]) ensure(String(row.account_id));
  }
  return [...accounts.values()].sort((a, b) => a.account_id.localeCompare(b.account_id));
}

export class AccountResolutionError extends Error {
  code: 'account_not_configured' | 'account_selection_required' | 'no_default_account';
  configured: string[];
  constructor(code: AccountResolutionError['code'], message: string, configured: string[] = []) {
    super(`${code}: ${message}`);
    this.code = code;
    this.configured = configured;
  }
}

/**
 * 把调用方的 account_id（可能缺省）解析为实际账户。
 * 返回值带 `source`，便于调用方在输出里说明"这是默认解析"还是"调用方显式指定"。
 */
export function resolveAccountId(
  db: DatabaseSync, requested?: unknown,
): { account_id: string; source: 'explicit' | 'default' } {
  const configured = listConfiguredAccounts(db);
  const ids = configured.map(account => account.account_id);
  const tablePresent = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const raw = requested === undefined || requested === null ? '' : String(requested).trim();

  if (raw !== '') {
    // 演示快照是 PRD §3 的样例账户（snapshot_id = demo-2026-10-18），按名字查询必须
    // 允许；它永远不是真实账户，门控会如实返回 PENDING。
    // 演示快照是 PRD §3 的样例账户（snapshot_id = demo-2026-10-18），按名字查询必须
    // 允许；它永远不是真实账户，门控会如实返回 PENDING。演示账户的常见别名也接受，
    // 因为旧版工具契约里示例就是 account_id="demo"。
    const isDemoAccount = (raw === DEMO_SNAPSHOT_ID || raw === 'demo' || raw === 'default')
      && !ids.includes(raw)
      && tablePresent('account_snapshot')
      && !!db.prepare('SELECT 1 FROM account_snapshot WHERE snapshot_id = ?').get(DEMO_SNAPSHOT_ID);
    if (!isDemoAccount && !ids.includes(raw)) {
      throw new AccountResolutionError(
        'account_not_configured',
        `账户 ${raw} 不在本部署配置的账户中（已配置：${ids.join('、') || '无'}）。`
        + '私有端点只提供本部署账本内的账户，不会用其他账户的快照代替。',
        ids,
      );
    }
    return { account_id: isDemoAccount ? DEMO_SNAPSHOT_ID : raw, source: 'explicit' };
  }

  const verified = configured.filter(account => account.verified);
  if (verified.length === 1) return { account_id: verified[0].account_id, source: 'default' };
  if (verified.length > 1) {
    throw new AccountResolutionError(
      'account_selection_required',
      `本部署有多个已确认真实账户（${verified.map(a => a.account_id).join('、')}），请显式提供 account_id。`
      + '不会猜测调用方指的是哪一个。',
      ids,
    );
  }
  if (configured.length === 1) return { account_id: configured[0].account_id, source: 'default' };
  if (configured.length > 1) {
    throw new AccountResolutionError(
      'account_selection_required',
      `本部署有多个账户（${ids.join('、')}），但没有唯一的已确认真实账户，请显式提供 account_id。`,
      ids,
    );
  }
  // 库里只有一个快照且没有账本（例如仅导入过演示快照）：可以把它当作展示用的
  // 唯一账户，但**不是**默认值猜测 —— 门控仍会返回 REAL_ACCOUNT_PENDING。
  // 真正要避免的是“有真实账户却静默落到演示账户”，这种情况在下面被拒绝。
  if (tablePresent('account_snapshot')) {
    const snapshots = db.prepare('SELECT snapshot_id FROM account_snapshot').all() as any[];
    if (snapshots.length === 1) return { account_id: String(snapshots[0].snapshot_id), source: 'default' };
  }
  throw new AccountResolutionError(
    'no_default_account',
    '本部署没有配置任何真实账户（没有账本基线或真实账户确认）。请先用 finance-ashare 导入账户并确认；'
    + '不会回落到演示账户或名为 default 的账户。',
    [],
  );
}

/**
 * 解析账户对应的持仓快照。
 *
 * 生产上的真实账户由 CLI 导入真实快照（`user-confirmed-eod-2026-10-16`）并建立
 * 账本基线；演示快照（`demo-2026-10-18`）只是 PRD §3 的样例，不属于任何账户。
 * 修复前的实现一律取 `latestSnapshot()`，因此查询 `real-main` 时可能返回演示
 * 快照的持仓 —— 账户身份是 real-main、持仓却是演示数据。这里改为：
 * 1. 账户有账本基线 → 用基线的快照；
 * 2. 否则只有一个非演示快照 → 用它（旧数据没有基线的兼容路径）；
 * 3. 有多个非演示快照 → 拒绝猜测，要求显式 snapshot_id；
 * 4. 只有演示快照 → 只有显式指定 snapshot_id 才允许（演示账户按名字查询）。
 */
export function resolveAccountSnapshot(
  db: DatabaseSync, accountId: string, explicitSnapshotId?: unknown,
): { snapshot: AccountSnapshot; snapshot_id: string; source: 'ledger_baseline' | 'single_snapshot' | 'explicit' | 'demo' } {
  if (explicitSnapshotId !== undefined && explicitSnapshotId !== null && String(explicitSnapshotId).trim() !== '') {
    const id = String(explicitSnapshotId).trim();
    const snapshot = readSnapshot(db, id);
    if (!snapshot) throw new Error(`账户快照 ${id} 不存在`);
    return { snapshot, snapshot_id: id, source: id === DEMO_SNAPSHOT_ID ? 'demo' : 'explicit' };
  }
  const baseline = baselineSnapshotId(db, accountId);
  if (baseline) {
    const snapshot = readSnapshot(db, baseline);
    if (snapshot) return { snapshot, snapshot_id: baseline, source: 'ledger_baseline' };
  }
  const rows = db.prepare('SELECT snapshot_id FROM account_snapshot ORDER BY as_of DESC, created_at DESC').all() as any[];
  const nonDemo = rows.map(row => String(row.snapshot_id)).filter(id => id !== DEMO_SNAPSHOT_ID);
  if (nonDemo.length === 1) {
    const snapshot = readSnapshot(db, nonDemo[0])!;
    return { snapshot, snapshot_id: nonDemo[0], source: 'single_snapshot' };
  }
  if (nonDemo.length > 1) {
    throw new AccountResolutionError(
      'account_selection_required',
      `账户 ${accountId} 没有账本基线，而库中有多个快照（${nonDemo.join('、')}），无法确定它对应哪一个；`
      + '请显式提供 snapshot_id，或先为该账户建立账本基线（portfolio-ledger-init）。',
      nonDemo,
    );
  }
  if (accountId === DEMO_SNAPSHOT_ID && rows.length === 1) {
    // 演示账户：只有显式点名 demo-2026-10-18 才返回演示持仓。
    return { snapshot: readSnapshot(db, DEMO_SNAPSHOT_ID)!, snapshot_id: DEMO_SNAPSHOT_ID, source: 'demo' };
  }
  const fallback = latestSnapshot(db);
  if (!fallback) throw new Error('账户库中没有任何快照，请先运行 finance-ashare portfolio-import');
  throw new AccountResolutionError(
    'account_selection_required',
    `账户 ${accountId} 没有账本基线，也找不到唯一的持仓快照；请显式提供 snapshot_id。`,
    rows.map(row => String(row.snapshot_id)),
  );
}

/** 账户所属的基线快照；没有基线时返回 null。 */
export function baselineSnapshotId(db: DatabaseSync, accountId: string): string | null {
  const tableExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_baseline'").get();
  if (!tableExists) return null;
  const row = db.prepare('SELECT snapshot_id FROM account_baseline WHERE account_id = ?').get(accountId) as any;
  return row?.snapshot_id ? String(row.snapshot_id) : null;
}

/**
 * 私有端点可读的账户库句柄。与各工具里既有实现一致：未授权或库不存在时报错，
 * 只读打开，绝不创建或写入。
 */
export function openReadOnlyPortfolioDb(): DatabaseSync {
  if (!portfolioEnabled()) {
    throw new Error('账户工具默认关闭。请设置 ASHARE_PRIVATE_PORTFOLIO_TOKEN 后再启动服务；公网 /mcp 端点永远不暴露账户数据。');
  }
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false });
}
