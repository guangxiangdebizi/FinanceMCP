import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildNavSeries, readBaseline, type PriceTable } from './ledger.js';
import { ledgerTablesPresent } from './db.js';

/**
 * 用户已批准的组合级风险政策（2026-10-22）。政策只触发"研究复核"，
 * 永远不产生卖出数量、不自动交易、不设强制仓位上限。
 * 写入只能走私有管理员 CLI（portfolio-risk-policy-set），没有 MCP/公开写工具。
 */
export const RISK_POLICY_SCHEMA = 'ashare-portfolio-risk-policy/1.0';
export const RISK_POLICY_RULE_VERSION = 'portfolio-drawdown-policy-1.0.0';
export const RISK_STATE_SCHEMA = 'ashare-portfolio-risk-state/1.0';
export const HISTORICAL_DRAWDOWN_UNAVAILABLE = 'HISTORICAL_DRAWDOWN_UNAVAILABLE';

export const PORTFOLIO_RISK_POLICY_DDL = `
CREATE TABLE IF NOT EXISTS portfolio_risk_policy (
  account_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  approved_on TEXT NOT NULL,
  approval_source TEXT NOT NULL,
  thresholds_json TEXT NOT NULL,
  per_trade_risk_budget_bps INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (account_id, rule_version)
);
`;

/** 阈值以基点保存，边界比较全程使用整数，避免浮点误差（恰好 10% 必须触发）。 */
export interface DrawdownTier { level: 'L1' | 'L2' | 'L3'; drawdown_bps: number; meaning: string; review: string }

export interface RiskPolicy {
  schema: typeof RISK_POLICY_SCHEMA;
  account_id: string;
  rule_version: string;
  approved_on: string;
  approval_source: string;
  tiers: DrawdownTier[];
  per_trade_risk_budget_bps: number;
  auto_reduce: false;
  auto_liquidate: false;
  position_cap: null;
  execution: 'manual_only';
  recorded_at: string;
}

export const DEFAULT_APPROVED_TIERS: DrawdownTier[] = [
  { level: 'L1', drawdown_bps: 1000, meaning: '一级预警', review: '复核仓位、集中度及风险来源' },
  { level: 'L2', drawdown_bps: 1500, meaning: '二级预警', review: '提高风险控制优先级，新增风险敞口需要更充分依据' },
  { level: 'L3', drawdown_bps: 2000, meaning: '三级预警', review: '优先比较降低风险、部分减仓和继续持有的方案' },
];

export const APPROVED_ON = '20261022';

export interface RiskPolicyInput {
  account_id: string;
  approved_on?: string;
  approval_source: string;
  rule_version?: string;
  recorded_at?: string;
}

export function ensureRiskPolicySchema(db: DatabaseSync): void { db.exec(PORTFOLIO_RISK_POLICY_DDL); }

function hasTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portfolio_risk_policy'").get());
}

function hashOf(parts: unknown): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

/**
 * 记录政策。幂等：同版本同内容 → created:false；同版本内容不同 → 抛错且不覆盖。
 * 阈值固定为用户批准值，CLI 不接受自定义阈值。
 */
export function recordRiskPolicy(db: DatabaseSync, input: RiskPolicyInput): { created: boolean; policy: RiskPolicy } {
  const approvedOn = input.approved_on ?? APPROVED_ON;
  if (!/^\d{8}$/.test(approvedOn)) throw new Error('approved_on 需要 YYYYMMDD');
  const source = String(input.approval_source ?? '').trim();
  if (!source) throw new Error('approval_source 必填（批准来源）');
  const accountId = String(input.account_id ?? '').trim();
  if (!accountId) throw new Error('account_id 必填');
  const version = input.rule_version ?? RISK_POLICY_RULE_VERSION;
  ensureRiskPolicySchema(db);
  const thresholds = JSON.stringify(DEFAULT_APPROVED_TIERS);
  const hash = hashOf({ accountId, version, approvedOn, source, thresholds, budget: 50 });
  const existing = db.prepare('SELECT content_hash FROM portfolio_risk_policy WHERE account_id=? AND rule_version=?').get(accountId, version) as any;
  if (existing) {
    if (existing.content_hash !== hash) throw new Error(`风险政策 ${version} 已存在且内容不同；历史不可覆盖，请使用新的 rule_version`);
    return { created: false, policy: loadPolicyRow(db, accountId, version)! };
  }
  db.prepare(`INSERT INTO portfolio_risk_policy
    (account_id,rule_version,approved_on,approval_source,thresholds_json,per_trade_risk_budget_bps,content_hash,recorded_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(accountId, version, approvedOn, source, thresholds, 50, hash, input.recorded_at ?? new Date().toISOString());
  return { created: true, policy: loadPolicyRow(db, accountId, version)! };
}

function loadPolicyRow(db: DatabaseSync, accountId: string, version: string): RiskPolicy | null {
  const row = db.prepare('SELECT * FROM portfolio_risk_policy WHERE account_id=? AND rule_version=?').get(accountId, version) as any;
  return row ? toPolicy(row) : null;
}

function toPolicy(row: any): RiskPolicy {
  return {
    schema: RISK_POLICY_SCHEMA, account_id: row.account_id, rule_version: row.rule_version,
    approved_on: row.approved_on, approval_source: row.approval_source,
    tiers: JSON.parse(row.thresholds_json), per_trade_risk_budget_bps: row.per_trade_risk_budget_bps,
    auto_reduce: false, auto_liquidate: false, position_cap: null, execution: 'manual_only', recorded_at: row.recorded_at,
  };
}

/**
 * 解析 asOf 日有效的政策：只取 approved_on <= asOf 的最新版本，
 * 因此批准日之前的历史日报/研究记录不会出现政策字段，保持可复现。
 */
export function loadActiveRiskPolicy(db: DatabaseSync, accountId: string, asOf: string): RiskPolicy | null {
  if (!hasTable(db)) return null;
  const row = db.prepare(`SELECT * FROM portfolio_risk_policy WHERE account_id=? AND approved_on<=?
    ORDER BY approved_on DESC, rule_version DESC LIMIT 1`).get(accountId, asOf);
  return row ? toPolicy(row) : null;
}

/** 从行情库为账本涉及的代码构造价格表（厘）。只读；缺价就缺价，不伪造。 */
export function buildLedgerPriceTable(portfolioDb: DatabaseSync, marketDb: DatabaseSync | null, accountId: string, from: string, to: string): PriceTable {
  const table: PriceTable = {};
  if (!marketDb) return table;
  const codes = new Set<string>();
  const baseline = readBaseline(portfolioDb, accountId);
  if (baseline?.snapshot_id) {
    for (const r of portfolioDb.prepare('SELECT ts_code FROM position WHERE snapshot_id=?').all(baseline.snapshot_id) as any[]) codes.add(r.ts_code);
  }
  for (const r of portfolioDb.prepare("SELECT DISTINCT ts_code FROM account_event WHERE account_id=? AND ts_code IS NOT NULL").all(accountId) as any[]) codes.add(r.ts_code);
  if (!codes.size) return table;
  for (const source of ['fund_daily', 'daily']) {
    if (!marketDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(source)) continue;
    const stmt = marketDb.prepare(`SELECT trade_date, close FROM ${source} WHERE ts_code=? AND trade_date>=? AND trade_date<=? AND close>0`);
    for (const code of codes) {
      for (const row of stmt.all(code, from, to) as any[]) {
        const day = (table[row.trade_date] ??= {});
        if (day[code] === undefined) day[code] = Math.round(Number(row.close) * 1000);
      }
    }
  }
  return table;
}

export interface DrawdownAssessment {
  status: 'AVAILABLE' | typeof HISTORICAL_DRAWDOWN_UNAVAILABLE;
  reason: string | null;
  basis: 'verified_cashflow_adjusted_account_nav';
  current_drawdown_bps: number | null;
  current_drawdown_pct: number | null;
  peak_nav: number | null;
  peak_date: string | null;
  current_nav: number | null;
  current_date: string | null;
  max_drawdown_pct: number | null;
  valuation_quality: 'exact' | 'incomplete' | null;
  points_used: number;
  excluded_bases: string[];
}

const EXCLUDED = ['cumulative_unrealized_loss', 'etf_own_max_drawdown', 'single_stress_loss'];

function unavailable(reason: string, pointsUsed = 0): DrawdownAssessment {
  return { status: HISTORICAL_DRAWDOWN_UNAVAILABLE, reason, basis: 'verified_cashflow_adjusted_account_nav',
    current_drawdown_bps: null, current_drawdown_pct: null, peak_nav: null, peak_date: null, current_nav: null, current_date: null,
    max_drawdown_pct: null, valuation_quality: null, points_used: pointsUsed, excluded_bases: EXCLUDED };
}

/**
 * 当前回撤 = 1 − 当日单位净值 / 历史峰值单位净值，全部来自 buildNavSeries
 * （单位净值法，出入金不改变净值）。账户未核验、无基线、可用点不足、
 * 目标日无净值 → HISTORICAL_DRAWDOWN_UNAVAILABLE。
 */
export function assessAccountDrawdown(db: DatabaseSync, marketDb: DatabaseSync | null, accountId: string, asOf: string, prices?: PriceTable): DrawdownAssessment {
  if (!ledgerTablesPresent(db) || !readBaseline(db, accountId)) return unavailable('no_baseline');
  const baseline = readBaseline(db, accountId)!;
  if (baseline.as_of > asOf) return unavailable('baseline_after_as_of');
  const series = buildNavSeries(db, accountId, { to: asOf, prices: prices ?? buildLedgerPriceTable(db, marketDb, accountId, baseline.as_of, asOf) });
  if (!series.performance_available) return unavailable('account_not_verified_real');
  const usable = series.points.filter(p => p.nav_per_unit !== null);
  if (usable.length < 2) return unavailable('insufficient_history', usable.length);
  const last = series.points[series.points.length - 1];
  if (!last || last.date !== asOf || last.nav_per_unit === null) return unavailable('nav_unavailable_on_as_of', usable.length);
  let peak = usable[0];
  for (const p of usable) if (p.nav_per_unit! > peak.nav_per_unit!) peak = p;
  const micro = (n: number) => Math.round(n * 1e6);
  const peakM = micro(peak.nav_per_unit!);
  const curM = micro(last.nav_per_unit);
  // 基点：向下取整到 0.01%，再与阈值整数比较前使用精确乘法判定（见 levelFor）。
  const ddBps = peakM > 0 ? Math.max(0, Math.floor((peakM - curM) * 10000 / peakM)) : 0;
  const md = series.max_drawdown;
  return {
    status: 'AVAILABLE', reason: null, basis: 'verified_cashflow_adjusted_account_nav',
    current_drawdown_bps: ddBps, current_drawdown_pct: peakM > 0 ? Math.round((peakM - curM) / peakM * 1e6) / 1e4 : 0,
    peak_nav: peak.nav_per_unit, peak_date: peak.date, current_nav: last.nav_per_unit, current_date: last.date,
    max_drawdown_pct: md.available ? Math.round(-md.value * 1e6) / 1e4 : null,
    valuation_quality: series.points.every(p => p.confidence === 'exact') ? 'exact' : 'incomplete',
    points_used: usable.length, excluded_bases: EXCLUDED,
  };
}

/** 整数比较：cur <= peak × (1 − t)，恰好等于阈值即触发。 */
export function levelFor(peakMicro: number, curMicro: number, tiers: DrawdownTier[]): DrawdownTier | null {
  let hit: DrawdownTier | null = null;
  for (const tier of [...tiers].sort((a, b) => a.drawdown_bps - b.drawdown_bps)) {
    if (curMicro * 10000 <= peakMicro * (10000 - tier.drawdown_bps)) hit = tier;
  }
  return hit;
}

export interface RiskStateInput {
  portfolioDb: DatabaseSync;
  marketDb: DatabaseSync | null;
  accountId: string;
  asOf: string;
  concentration?: unknown;
  exposure?: unknown;
  stress?: unknown;
}

/** 返回 null 表示 asOf 日尚无已批准政策（保持旧报告字节不变）。 */
export function buildPortfolioRiskState(input: RiskStateInput): any | null {
  const policy = loadActiveRiskPolicy(input.portfolioDb, input.accountId, input.asOf);
  if (!policy) return null;
  const dd = assessAccountDrawdown(input.portfolioDb, input.marketDb, input.accountId, input.asOf);
  let level: DrawdownTier | null = null;
  if (dd.status === 'AVAILABLE' && dd.peak_nav !== null && dd.current_nav !== null) {
    level = levelFor(Math.round(dd.peak_nav * 1e6), Math.round(dd.current_nav * 1e6), policy.tiers);
  }
  return {
    schema: RISK_STATE_SCHEMA,
    policy: { rule_version: policy.rule_version, approved_on: policy.approved_on, approval_source: policy.approval_source,
      tiers: policy.tiers.map(t => ({ level: t.level, drawdown_pct: t.drawdown_bps / 100, review: t.review })),
      per_trade_risk_budget_pct: policy.per_trade_risk_budget_bps / 100,
      auto_reduce: false, auto_liquidate: false, position_cap: null, execution: 'manual_only' },
    drawdown: dd,
    warning: dd.status === 'AVAILABLE'
      ? { level: level?.level ?? 'NONE', triggered: Boolean(level), required_review: level?.review ?? null }
      : { level: 'UNKNOWN', triggered: false, required_review: null, reason: HISTORICAL_DRAWDOWN_UNAVAILABLE },
    concentration: input.concentration ?? null,
    exposure: input.exposure ?? null,
    stress: input.stress ?? null,
    action_boundary: {
      triggers: 'research_review_only', sell_quantity: null, auto_trade: false,
      note: '预警只触发研究复核；不生成卖出数量，不自动减仓或清仓，实际交易由用户手动决定。集中度、敞口与压力情景在回撤不可用时仍提供。',
    },
  };
}
