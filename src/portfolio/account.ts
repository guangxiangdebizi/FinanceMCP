import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { inPortfolioTransaction } from './db.js';

/**
 * 账户快照与汇总（PRD §3）。所有金额为整数分，价格为整数厘（0.001 元）。
 *
 * 边界（PRD §3/§8）：
 * - 这是 2026-10-18 用户提供截图的**演示基线**，不是当前账户，也不是实时余额。
 * - 没有账户历史净值、出入金和费用记录，因此不能计算历史收益或历史最大回撤；
 *   持仓浮亏不是历史最大回撤。本模块显式返回 `available: false`。
 * - 不推断真实成交、累计入金或分红。
 */

// ---------------------------------------------------------------- 类型

export interface SnapshotPosition {
  ts_code: string;
  name: string;
  /** 份数。 */
  quantity: number;
  /** 参考市价，厘。 */
  ref_price_milli: number;
  /** 参考成本价，厘。 */
  ref_cost_milli: number;
  /** 截图市值，分。 */
  market_value_cents: number;
}

export interface SnapshotTotals {
  total_assets_cents: number;
  securities_mv_cents: number;
  cash_cents: number;
  wealth_cents: number;
  /** 截图浮动盈亏；无法与 qty×cost 完全对上时由 reconcile 报出差异。 */
  unrealized_pnl_cents: number;
}

export interface AccountSnapshot {
  snapshot_id: string;
  as_of: string;
  source: string;
  note: string;
  warnings: string[];
  is_current: boolean;
  positions: SnapshotPosition[];
  totals: SnapshotTotals;
}

// ---------------------------------------------------------------- 演示基线（PRD §3 原表）

export const DEMO_SNAPSHOT_ID = 'demo-2026-10-18';

/** 必须随每次账户输出一起返回的三条边界说明。 */
export const DEMO_WARNINGS = [
  'not_latest_account',
  'historical_drawdown_unknown',
  'trade_dates_unverified',
] as const;

/**
 * PRD §3 的五只持仓与合计数，逐项照抄，不做任何"修正"。
 * 市值列按 PRD 原值写入；reconcile 会独立核对 qty×ref_price 是否与之相符。
 */
export const DEMO_SNAPSHOT: AccountSnapshot = {
  snapshot_id: DEMO_SNAPSHOT_ID,
  as_of: '2026-10-18',
  source: 'prd-screenshot-v1.0',
  note: '用户提供的证券账户截图基线；截图时间戳与后续成交未核对，不代表当前余额或实时行情',
  warnings: [...DEMO_WARNINGS],
  is_current: false,
  positions: [
    { ts_code: '159241.SZ', name: '航空航天ETF', quantity: 1000, ref_price_milli: 1005, ref_cost_milli: 1103, market_value_cents: 100500 },
    { ts_code: '159278.SZ', name: '机器人ETF', quantity: 1000, ref_price_milli: 796, ref_cost_milli: 1069, market_value_cents: 79600 },
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 58900, ref_price_milli: 935, ref_cost_milli: 1251, market_value_cents: 5507150 },
    { ts_code: '516080.SH', name: '创新药ETF', quantity: 10000, ref_price_milli: 636, ref_cost_milli: 388, market_value_cents: 636000 },
    { ts_code: '560390.SH', name: '电网设备ETF', quantity: 15000, ref_price_milli: 742, ref_cost_milli: 831, market_value_cents: 1113000 },
  ],
  totals: {
    total_assets_cents: 7577653,   // 75,776.53
    securities_mv_cents: 7436250,  // 74,362.50
    cash_cents: 141370,            // 1,413.70
    wealth_cents: 33,              // 0.33
    unrealized_pnl_cents: -1781287, // -17,812.87
  },
};

// ---------------------------------------------------------------- 主题映射（冻结）

/** 五只持仓的行业/主题归类。新增标的必须先更新此表，未知代码按 unknown 处理。 */
export const THEME_BY_CODE: Record<string, string> = {
  '159558.SZ': 'semiconductor_equipment',
  '159241.SZ': 'aerospace',
  '159278.SZ': 'robotics',
  '516080.SH': 'innovative_drug',
  '560390.SH': 'power_grid_equipment',
};

export const THEME_LABELS: Record<string, string> = {
  semiconductor_equipment: '半导体设备',
  aerospace: '航空航天',
  robotics: '机器人',
  innovative_drug: '创新药',
  power_grid_equipment: '电网设备',
  unknown: '未归类',
};

// ---------------------------------------------------------------- 工具

/** 统一舍入边界：只在这里对浮点数取整，结果保留 `digits` 位小数。 */
export function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return NaN;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** 分 → 元（字符串，固定 2 位），仅用于展示。 */
export const yuan = (cents: number): string => (cents / 100).toFixed(2);
/** 厘 → 元（字符串，固定 3 位），仅用于展示。 */
export const yuanFromMilli = (milli: number): string => (milli / 1000).toFixed(3);

/** 份数 × 厘价 → 分。1000 份 × 1000 厘 = 1,000,000 厘 = 100,000 分。 */
export function valueCents(quantity: number, priceMilli: number): number {
  return Math.round((quantity * priceMilli) / 10);
}

/** 快照内容签名：用于防止同一 snapshot_id 被静默改写。 */
function snapshotSignature(snapshot: AccountSnapshot): string {
  const canonical = JSON.stringify({
    snapshot_id: snapshot.snapshot_id,
    as_of: snapshot.as_of,
    source: snapshot.source,
    is_current: snapshot.is_current,
    warnings: snapshot.warnings,
    totals: snapshot.totals,
    positions: snapshot.positions.map(p => [p.ts_code, p.name, p.quantity, p.ref_price_milli, p.ref_cost_milli, p.market_value_cents]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------- 导入

export interface ImportResult {
  inserted: boolean;
  snapshot_id: string;
  positions: number;
  db_signature: string;
}

/**
 * 幂等导入基线快照：以固定 `snapshot_id` 为主键，重复执行不会产生重复行。
 * 若已存在但内容不同，拒绝覆盖（冻结基线不能被静默改写），并报告差异。
 */
export function importDemoSnapshot(db: DatabaseSync, snapshot: AccountSnapshot = DEMO_SNAPSHOT): ImportResult {
  const signature = snapshotSignature(snapshot);
  const existing = db.prepare('SELECT snapshot_id FROM account_snapshot WHERE snapshot_id = ?').get(snapshot.snapshot_id);
  if (existing) {
    const stored = readSnapshot(db, snapshot.snapshot_id)!;
    if (snapshotSignature(stored) !== signature) {
      throw new Error(`快照 ${snapshot.snapshot_id} 已存在且内容不同，拒绝覆盖冻结基线`);
    }
    const n = (db.prepare('SELECT COUNT(*) n FROM position WHERE snapshot_id = ?').get(snapshot.snapshot_id) as any).n as number;
    return { inserted: false, snapshot_id: snapshot.snapshot_id, positions: n, db_signature: signature };
  }
  inPortfolioTransaction(db, () => {
    db.prepare(`INSERT INTO account_snapshot
      (snapshot_id, as_of, source, note, warnings, is_current, total_assets_cents, securities_mv_cents, cash_cents, wealth_cents, unrealized_pnl_cents, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      snapshot.snapshot_id, snapshot.as_of, snapshot.source, snapshot.note, JSON.stringify(snapshot.warnings),
      snapshot.is_current ? 1 : 0, snapshot.totals.total_assets_cents, snapshot.totals.securities_mv_cents,
      snapshot.totals.cash_cents, snapshot.totals.wealth_cents, snapshot.totals.unrealized_pnl_cents,
      new Date().toISOString(),
    );
    const insert = db.prepare(`INSERT INTO position
      (snapshot_id, ts_code, name, quantity, ref_price_milli, ref_cost_milli, market_value_cents)
      VALUES (?,?,?,?,?,?,?)`);
    for (const p of snapshot.positions) {
      insert.run(snapshot.snapshot_id, p.ts_code, p.name, p.quantity, p.ref_price_milli, p.ref_cost_milli, p.market_value_cents);
    }
  });
  return { inserted: true, snapshot_id: snapshot.snapshot_id, positions: snapshot.positions.length, db_signature: signature };
}

/** 从账户库读回快照；不存在时返回 undefined。 */
export function readSnapshot(db: DatabaseSync, snapshotId: string): AccountSnapshot | undefined {
  const row = db.prepare('SELECT * FROM account_snapshot WHERE snapshot_id = ?').get(snapshotId) as any;
  if (!row) return undefined;
  const positions = db.prepare('SELECT * FROM position WHERE snapshot_id = ? ORDER BY ts_code').all(snapshotId) as any[];
  return {
    snapshot_id: row.snapshot_id,
    as_of: row.as_of,
    source: row.source,
    note: row.note,
    warnings: JSON.parse(row.warnings),
    is_current: row.is_current === 1,
    positions: positions.map(p => ({
      ts_code: p.ts_code, name: p.name, quantity: p.quantity,
      ref_price_milli: p.ref_price_milli, ref_cost_milli: p.ref_cost_milli, market_value_cents: p.market_value_cents,
    })),
    totals: {
      total_assets_cents: row.total_assets_cents,
      securities_mv_cents: row.securities_mv_cents,
      cash_cents: row.cash_cents,
      wealth_cents: row.wealth_cents,
      unrealized_pnl_cents: row.unrealized_pnl_cents,
    },
  };
}

/** 最新快照（按 as_of 倒序）。R0 只有一条。 */
export function latestSnapshot(db: DatabaseSync): AccountSnapshot | undefined {
  const row = db.prepare('SELECT snapshot_id FROM account_snapshot ORDER BY as_of DESC, created_at DESC LIMIT 1').get() as any;
  return row ? readSnapshot(db, row.snapshot_id) : undefined;
}

// ---------------------------------------------------------------- 汇总

export interface PositionWeight {
  ts_code: string;
  name: string;
  quantity: number;
  ref_price_milli: number;
  /** 元/份，仅展示。 */
  ref_price: number;
  market_value_cents: number;
  /** 占总资产比例（0–1）。 */
  weight: number;
  /** 占证券市值比例（0–1）。 */
  weight_of_securities: number;
  theme: string;
}

export interface AccountSummary {
  snapshot_id: string;
  as_of: string;
  source: string;
  is_current: boolean;
  warnings: readonly string[];
  totals: SnapshotTotals & { total_assets: number; securities_mv: number; cash: number; wealth: number };
  positions: PositionWeight[];
  /** 证券市值 / 总资产。 */
  securities_ratio: number;
  cash_ratio: number;
  wealth_ratio: number;
  /** 赫芬达尔指数（以总资产为分母的持仓权重平方和）。 */
  concentration: { hhi: number; effective_positions: number };
  top_position: { ts_code: string; name: string; weight: number } | null;
  theme_exposure: { theme: string; label: string; weight: number; weight_of_securities: number; market_value_cents: number }[];
  equity_theme_exposure: { weight_of_securities: number; note: string };
  historical_performance: { available: false; reason: 'no_history' };
  max_drawdown: { available: false; reason: 'no_history' };
  disclaimer: string;
}

const NO_HISTORY = { available: false as const, reason: 'no_history' as const };

/**
 * 账户汇总。只做确定性的加总与比例，不推断历史、不预测收益。
 * 分母统一为快照总资产（含现金与理财）。
 */
export function accountSummary(snapshot: AccountSnapshot): AccountSummary {
  const { totals, positions } = snapshot;
  const total = totals.total_assets_cents;
  const sec = totals.securities_mv_cents;
  const denom = (v: number) => (total > 0 ? round(v / total, 6) : 0);
  const secDenom = (v: number) => (sec > 0 ? round(v / sec, 6) : 0);

  const rows: PositionWeight[] = positions.map(p => ({
    ts_code: p.ts_code,
    name: p.name,
    quantity: p.quantity,
    ref_price_milli: p.ref_price_milli,
    ref_price: round(p.ref_price_milli / 1000, 3),
    market_value_cents: p.market_value_cents,
    weight: denom(p.market_value_cents),
    weight_of_securities: secDenom(p.market_value_cents),
    theme: THEME_BY_CODE[p.ts_code] ?? 'unknown',
  }));

  const hhi = round(rows.reduce((acc, r) => acc + r.weight * r.weight, 0), 6);
  const top = rows.length ? rows.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;

  const byTheme = new Map<string, number>();
  for (const r of rows) byTheme.set(r.theme, (byTheme.get(r.theme) ?? 0) + r.market_value_cents);
  const themeExposure = [...byTheme.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([theme, mv]) => ({
      theme,
      label: THEME_LABELS[theme] ?? theme,
      weight: denom(mv),
      weight_of_securities: secDenom(mv),
      market_value_cents: mv,
    }));

  return {
    snapshot_id: snapshot.snapshot_id,
    as_of: snapshot.as_of,
    source: snapshot.source,
    is_current: snapshot.is_current,
    warnings: snapshot.warnings,
    totals: {
      ...totals,
      total_assets: round(total / 100, 2),
      securities_mv: round(sec / 100, 2),
      cash: round(totals.cash_cents / 100, 2),
      wealth: round(totals.wealth_cents / 100, 2),
    },
    positions: rows,
    securities_ratio: denom(sec),
    cash_ratio: denom(totals.cash_cents),
    wealth_ratio: denom(totals.wealth_cents),
    concentration: { hhi, effective_positions: hhi > 0 ? round(1 / hhi, 4) : 0 },
    top_position: top ? { ts_code: top.ts_code, name: top.name, weight: top.weight } : null,
    theme_exposure: themeExposure,
    equity_theme_exposure: {
      weight_of_securities: rows.length > 0 ? 1 : 0,
      note: '五只持仓均为权益行业/主题 ETF；占证券市值 100%，占总资产约 98.13%',
    },
    historical_performance: NO_HISTORY,
    max_drawdown: NO_HISTORY,
    disclaimer: '本账户为 PRD §3 截图基线的只读演示数据，不是用户当前账户；历史净值、回撤、成交与出入金均未知，不做推断。',
  };
}

// ---------------------------------------------------------------- 对账

export interface ReconcileCheck {
  id: string;
  /** hard：必须通过；advisory：只报告，不改变 ok。 */
  severity: 'hard' | 'advisory';
  ok: boolean;
  expected_cents: number | null;
  actual_cents: number | null;
  delta_cents: number | null;
  detail: string;
}

export interface ReconcileResult {
  ok: boolean;
  tolerance_cents: number;
  checks: ReconcileCheck[];
  deltas: {
    position_sum_vs_securities_mv_cents: number;
    components_vs_total_cents: number;
    unrealized_pnl_recomputed_vs_stated_cents: number;
  };
  reasons: string[];
}

const TOLERANCE_CENTS = 1;

/**
 * 核对 PRD 数字。**不修正任何输入**：如果对不上，就把差异原样报出来。
 *
 * 硬性检查（任一失败则 ok=false）：
 * 1. Σ 持仓市值 == 证券市值；
 * 2. 证券市值 + 现金 + 理财 == 总资产；
 * 3. 每个持仓的截图市值 == 数量 × 参考市价。
 * 提示性检查（不改变 ok，但会进入 reasons）：
 * 4. 逐项 (市值 − 数量×成本价) 求和 == 截图浮动盈亏。
 */
export function reconcile(snapshot: AccountSnapshot): ReconcileResult {
  const { totals, positions } = snapshot;
  const checks: ReconcileCheck[] = [];
  const reasons: string[] = [];

  const sumMv = positions.reduce((acc, p) => acc + p.market_value_cents, 0);
  const dMv = sumMv - totals.securities_mv_cents;
  checks.push({
    id: 'position_sum_vs_securities_mv',
    severity: 'hard',
    ok: Math.abs(dMv) <= TOLERANCE_CENTS,
    expected_cents: totals.securities_mv_cents,
    actual_cents: sumMv,
    delta_cents: dMv,
    detail: `Σ 持仓市值 ${yuan(sumMv)} 元 vs 证券市值 ${yuan(totals.securities_mv_cents)} 元`,
  });

  const componentSum = totals.securities_mv_cents + totals.cash_cents + totals.wealth_cents;
  const dTotal = componentSum - totals.total_assets_cents;
  checks.push({
    id: 'components_vs_total',
    severity: 'hard',
    ok: Math.abs(dTotal) <= TOLERANCE_CENTS,
    expected_cents: totals.total_assets_cents,
    actual_cents: componentSum,
    delta_cents: dTotal,
    detail: `证券 ${yuan(totals.securities_mv_cents)} + 现金 ${yuan(totals.cash_cents)} + 理财 ${yuan(totals.wealth_cents)} = ${yuan(componentSum)} vs 总资产 ${yuan(totals.total_assets_cents)}`,
  });

  for (const p of positions) {
    const computed = valueCents(p.quantity, p.ref_price_milli);
    const d = p.market_value_cents - computed;
    checks.push({
      id: `position_mv_vs_qty_price:${p.ts_code}`,
      severity: 'hard',
      ok: Math.abs(d) <= TOLERANCE_CENTS,
      expected_cents: computed,
      actual_cents: p.market_value_cents,
      delta_cents: d,
      detail: `${p.ts_code} ${p.quantity} 份 × ${yuanFromMilli(p.ref_price_milli)} 元 = ${yuan(computed)} 元 vs 截图市值 ${yuan(p.market_value_cents)} 元`,
    });
  }

  const costBasis = positions.reduce((acc, p) => acc + valueCents(p.quantity, p.ref_cost_milli), 0);
  const recomputedPnl = sumMv - costBasis;
  const dPnl = recomputedPnl - totals.unrealized_pnl_cents;
  checks.push({
    id: 'unrealized_pnl_recomputed_vs_stated',
    severity: 'advisory',
    ok: Math.abs(dPnl) <= TOLERANCE_CENTS,
    expected_cents: totals.unrealized_pnl_cents,
    actual_cents: recomputedPnl,
    delta_cents: dPnl,
    detail: `按 数量×(市价−成本价) 重算浮亏 ${yuan(recomputedPnl)} 元 vs 截图 ${yuan(totals.unrealized_pnl_cents)} 元（成本合计 ${yuan(costBasis)} 元）`,
  });

  for (const c of checks) {
    if (c.ok) continue;
    if (c.severity === 'advisory') {
      reasons.push(`unrealized_pnl_mismatch: ${c.detail}，差 ${yuan(c.delta_cents!)} 元；可能是截图中成本价含费用或口径不同，未做调整`);
    } else {
      reasons.push(`reconcile_failed:${c.id}: ${c.detail}，差 ${yuan(c.delta_cents!)} 元`);
    }
  }

  return {
    ok: checks.every(c => c.severity !== 'hard' || c.ok),
    tolerance_cents: TOLERANCE_CENTS,
    checks,
    deltas: {
      position_sum_vs_securities_mv_cents: dMv,
      components_vs_total_cents: dTotal,
      unrealized_pnl_recomputed_vs_stated_cents: dPnl,
    },
    reasons,
  };
}
