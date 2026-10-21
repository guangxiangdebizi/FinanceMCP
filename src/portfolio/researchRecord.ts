import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PLAN_TRACKING_SCHEMA, type DailyReportResult } from './dailyReport.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { canonicalJson, JOURNAL_VERSION, recordResearchJournal, type JournalObservation } from './researchJournal.js';

/**
 * 前瞻研究记录的写入路径（任务书 D5）。
 *
 * 边界与日报保持一致：
 * - 只写 `plan_tracking`（账户库中**唯一**可写的研究记录表）；不写市场库、不改账户、
 *   不写真实成交流水。建立该表是唯一的结构变更，且是显式命令触发的。
 * - 记录的是“当日的判断、候选、触发条件与失效原因”，不是成交；模拟预案与真实
 *   成交永远分开（本模块不写 `account_event`）。
 * - 哈希输入不含 `generated_at`，因此同一输入重复运行是幂等的（按 plan_id 去重），
 *   不会因为重跑而改写历史判断；只有内容真的变化才会产生新记录。
 * - 不修改过去：`plan_id` 由 as_of + 输入哈希决定，历史行永不 UPDATE。
 */

export interface ResearchRecordInput {
  portfolioDb: DatabaseSync;
  accountId: string;
  report: DailyReportResult;
  generatedAt?: string | null;
}

export interface ResearchRecordResult {
  recorded: boolean;
  plan_id: string;
  table_created: boolean;
  account_id: string;
  as_of_trade_date: string;
  status: string;
  action_count: number;
  db: string;
  note: string;
}

/** 日报中与前瞻记录有关、但不参与哈希的展示字段。 */
function hashInput(report: DailyReportResult, accountId: string): string {
  return createHash('sha256').update(JSON.stringify({
    schema: report.schema,
    account_id: accountId,
    as_of_trade_date: report.as_of_trade_date,
    status: report.status,
    account_status: report.account_status,
    data_quality: report.data_quality.tiers,
    actions: report.first_section.actions.map(action => ({
      code: action.code,
      kind: action.kind,
      title: action.title,
      legs: action.legs.map(leg => [leg.side, leg.ts_code, leg.quantity, leg.price_milli]),
      triggers: action.triggers,
      invalidation_conditions: action.invalidation_conditions,
    })),
    holdings: report.holdings.map(holding => [holding.ts_code, holding.quantity, holding.bar_quality, holding.stance]),
    candidates: report.candidate_vs_cash.entries.map(entry => [entry.ts_code, entry.status, entry.price_milli, entry.one_lot_cents]),
    concentration: report.concentration.hhi,
    gate_satisfied: report.gate.satisfied,
  })).digest('hex');
}

/** 一个稳定的、可读的预案 ID：日期 + 输入哈希前缀（不含时间戳）。 */
export function planIdFor(report: DailyReportResult, accountId: string): string {
  return `PLAN-${report.as_of_trade_date}-${hashInput(report, accountId).slice(0, 12)}`;
}

export function planTrackingTableExists(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plan_tracking'").get();
}

/**
 * 写入当日前瞻记录。已存在同一 plan_id 时幂等返回 `recorded: false`，不覆盖。
 * `createTable` 只由显式 CLI/定时路径传入 true；只读工具永远不会建表。
 */
export function recordPlanTracking(input: ResearchRecordInput): ResearchRecordResult {
  const { portfolioDb, report, accountId } = input;
  if (!/^\d{8}$/.test(report.as_of_trade_date)) throw new Error('as_of_trade_date 需要 YYYYMMDD');
  let tableCreated = false;
  if (!planTrackingTableExists(portfolioDb)) {
    portfolioDb.exec(PLAN_TRACKING_SCHEMA);
    tableCreated = true;
  }
  const planId = planIdFor(report, accountId);
  const existing = portfolioDb.prepare('SELECT plan_id FROM plan_tracking WHERE plan_id = ?').get(planId);
  if (existing) {
    return {
      recorded: false, plan_id: planId, table_created: tableCreated, account_id: accountId,
      as_of_trade_date: report.as_of_trade_date, status: report.status,
      action_count: report.first_section.actions.length, db: portfolioDbPath(),
      note: '同一输入的历史预案已存在（幂等）：不覆盖、不追写。',
    };
  }
  const actions = report.first_section.actions;
  const actionCode = actions.length === 0 ? 'NO_ACTION' : actions.map(action => action.code).join('+');
  const actionSummary = actions.length === 0
    ? (report.first_section.no_action_reason ?? '无可执行动作')
    : actions.map(action => action.title).join('；');
  const legs = actions.flatMap(action => action.legs.map(leg => ({
    side: leg.side, ts_code: leg.ts_code, quantity: leg.quantity, price_milli: leg.price_milli,
    executable: leg.executable, reason: leg.reason,
  })));
  const observationTriggers = report.first_section.observation_triggers;
  const invalidation = actions.flatMap(action => action.invalidation_conditions);
  const expectedBy = report.expected_next_trade_date;
  // 记录生成时间的唯一用途是审计；它不参与 plan_id，也不参与排名。
  const generatedAt = input.generatedAt ?? report.timestamps.generated_at ?? new Date().toISOString();
  portfolioDb.prepare(`INSERT INTO plan_tracking
    (plan_id, account_id, as_of_trade_date, generated_at, status, action_code, action_summary,
     legs_json, observation_triggers_json, invalidation_conditions_json, expected_by, note, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    planId, accountId, report.as_of_trade_date, generatedAt, report.status, actionCode, actionSummary,
    JSON.stringify(legs), JSON.stringify(observationTriggers), JSON.stringify(invalidation),
    expectedBy,
    // 明确区分模拟预案与真实成交；同时标注基准权重的 provisional 状态。
    '前瞻研究记录（模拟预案，不是成交）：status 与 legs 只是当日研究结论；'
    + '所有可执行性以日报 gate 为准；对照基准权重在用户批准前为 provisional。',
    new Date().toISOString(),
  );
  return {
    recorded: true, plan_id: planId, table_created: tableCreated, account_id: accountId,
    as_of_trade_date: report.as_of_trade_date, status: report.status,
    action_count: actions.length, db: portfolioDbPath(),
    note: '已写入 plan_tracking（仅研究记录；不写账户事件，也不写真实成交）。',
  };
}

/** 保存实际量化bundle完整快照，包括数据不足日；legacy预案记录保留不动。 */
export function recordVpsResearchSnapshot(input: {
  portfolioDb: DatabaseSync;
  accountId: string;
  bundle: { report_id: string; as_of_trade_date: string; generated_at?: string; [key: string]: unknown };
  observations?: JournalObservation[];
  versions?: Record<string, string>;
  generatedAt?: string;
}) {
  const { bundle } = input;
  const generatedAt = input.generatedAt ?? bundle.generated_at;
  if (!generatedAt) throw new Error('实际VPS快照需要generated_at，不能以导入时间补造生成时间');
  const revision = createHash('sha256').update(canonicalJson({ bundle, observations: input.observations ?? [], versions: input.versions ?? {}, generated_at: generatedAt })).digest('hex').slice(0, 16);
  return recordResearchJournal(input.portfolioDb, {
    record_id: `VPS-${bundle.report_id}-${revision}`,
    account_id: input.accountId,
    source: 'vps',
    as_of_trade_date: bundle.as_of_trade_date,
    bundle_id: bundle.report_id,
    generated_at: generatedAt,
    versions: { journal: JOURNAL_VERSION, ...(input.versions ?? {}) },
    judgement: bundle.status ?? 'UNAVAILABLE',
    candidates: [],
    observations: input.observations ?? [],
    evidence: [],
    payload: bundle,
  });
}

/** 打开可写账户库（仅 CLI/定时任务使用；MCP 工具始终只读）。 */
export function openWritablePortfolioDb(path = portfolioDbPath()): DatabaseSync {
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: true });
}
