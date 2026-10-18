import type { DatabaseSync } from 'node:sqlite';
import { inPortfolioTransaction } from './db.js';
import { normalizeSecurityCode } from './instrument.js';

/**
 * 研究证据存储（R2 工作包 A1）。
 *
 * 轮动/买入研究结论只有落成**持久、可按 ID 复核**的记录，才可能支持条件化预案。
 * 本模块只做三件事：建表、写入（唯一写路径，必须显式 confirm）、校验。
 *
 * 边界：
 * - 表在**独立的账户库**里，不写入公开市场库；`ensureEvidenceSchema` 只由写路径和
 *   显式初始化调用，读取路径不建表。
 * - 不提供 MCP 工具、不接受布尔型"已验证"、不生成 evidence_id，也不补默认日期。
 * - 状态只有 VERIFIED / REVOKED / PENDING；其它值一律拒绝，不做"未知即有效"的降级。
 */

export const EVIDENCE_STATUSES = ['VERIFIED', 'REVOKED', 'PENDING'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** 证据类型可扩展；ROTATION 用于轮动优势，ENTRY 用于单标的入场研究。 */
export type EvidenceKind = 'ROTATION' | 'ENTRY' | (string & {});

export interface ResearchEvidenceRecord {
  evidence_id: string;
  kind: EvidenceKind;
  buy_code: string;
  sell_code: string | null;
  strategy_id: string;
  /** YYYYMMDD，证据结论对应的交易日。 */
  as_of: string;
  /** YYYYMMDD，可空；为空表示未声明失效日。 */
  valid_until: string | null;
  status: EvidenceStatus;
  recorded_by: string;
  recorded_at: string;
  note: string;
}

export type EvidenceRecordInput = Omit<ResearchEvidenceRecord, 'recorded_at' | 'note'> & {
  recorded_at?: string;
  note?: string;
};

export type EvidenceReason =
  | 'evidence_not_found'
  | 'evidence_revoked'
  | 'evidence_code_mismatch'
  | 'evidence_expired'
  | 'evidence_not_yet_valid'
  | 'evidence_status_not_verified';

export const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_evidence (
  evidence_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  buy_code TEXT NOT NULL,
  sell_code TEXT,
  strategy_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_research_evidence_codes
  ON research_evidence (buy_code, sell_code, as_of);
`;

/**
 * 证据状态变更审计（R2 A5）。**只追加**：每次状态迁移写一行，不删不改。
 * 原记录的经济字段（代码、日期、结论）永远不会因为撤回而被改写。
 */
export const EVIDENCE_STATUS_EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_evidence_status_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_research_evidence_status_event
  ON research_evidence_status_event (evidence_id, id);
`;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 建表辅助；不在任何只读读取路径上调用。 */
export function ensureEvidenceSchema(db: DatabaseSync): void {
  db.exec(EVIDENCE_SCHEMA);
  db.exec(EVIDENCE_STATUS_EVENT_SCHEMA);
}

function requireText(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

function requireYmd(value: unknown, label: string): string {
  const text = String(value ?? '').trim().replace(/-/g, '');
  if (!/^\d{8}$/.test(text)) throw new Error(`${label} 需要 YYYYMMDD 格式，收到 ${String(value ?? '')}`);
  return text;
}

function normalizeRecord(input: EvidenceRecordInput): ResearchEvidenceRecord {
  const id = requireText(input.evidence_id, 'evidence_id');
  const kind = requireText(input.kind, 'kind');
  const buyCode = normalizeSecurityCode(requireText(input.buy_code, 'buy_code'));
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(buyCode)) throw new Error(`buy_code 无法识别：${input.buy_code}`);
  const sellRaw = input.sell_code == null || String(input.sell_code).trim() === '' ? null : String(input.sell_code);
  const sellCode = sellRaw === null ? null : normalizeSecurityCode(sellRaw);
  if (sellCode !== null && !/^\d{6}\.(SH|SZ|BJ)$/.test(sellCode)) throw new Error(`sell_code 无法识别：${sellRaw}`);
  const strategyId = requireText(input.strategy_id, 'strategy_id');
  const asOf = requireYmd(input.as_of, 'as_of');
  const validUntil = input.valid_until == null || String(input.valid_until).trim() === ''
    ? null : requireYmd(input.valid_until, 'valid_until');
  if (validUntil !== null && validUntil < asOf) throw new Error(`valid_until (${validUntil}) 不能早于 as_of (${asOf})`);
  if (!EVIDENCE_STATUSES.includes(input.status as EvidenceStatus)) {
    throw new Error(`status 必须是 ${EVIDENCE_STATUSES.join('/')}，收到 ${String(input.status)}`);
  }
  const recordedBy = requireText(input.recorded_by, 'recorded_by');
  return {
    evidence_id: id,
    kind,
    buy_code: buyCode,
    sell_code: sellCode,
    strategy_id: strategyId,
    as_of: asOf,
    valid_until: validUntil,
    status: input.status as EvidenceStatus,
    recorded_by: recordedBy,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    note: String(input.note ?? ''),
  };
}

function rowToRecord(row: any): ResearchEvidenceRecord {
  return {
    evidence_id: row.evidence_id,
    kind: row.kind,
    buy_code: row.buy_code,
    sell_code: row.sell_code ?? null,
    strategy_id: row.strategy_id,
    as_of: row.as_of,
    valid_until: row.valid_until ?? null,
    status: row.status,
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at,
    note: row.note ?? '',
  };
}

export interface RecordEvidenceResult {
  evidence_id: string;
  created: boolean;
  record: ResearchEvidenceRecord;
}

/**
 * 唯一写路径。没有 `confirm: true` 直接拒绝；状态只能是三种已知值。
 * 同一 evidence_id 内容相同即幂等，内容不同拒绝覆盖（证据不能被静默改写）。
 */
export function recordResearchEvidence(
  db: DatabaseSync, input: EvidenceRecordInput, options: { confirm?: boolean } = {},
): RecordEvidenceResult {
  if (options.confirm !== true) {
    throw new Error('记录研究证据需要显式 confirm: true；该动作不能由读取/决策路径自动完成');
  }
  const record = normalizeRecord(input);
  ensureEvidenceSchema(db);
  const existingRow = db.prepare('SELECT * FROM research_evidence WHERE evidence_id = ?').get(record.evidence_id);
  if (existingRow) {
    const existing = rowToRecord(existingRow);
    const same = existing.kind === record.kind && existing.buy_code === record.buy_code
      && existing.sell_code === record.sell_code && existing.strategy_id === record.strategy_id
      && existing.as_of === record.as_of && existing.valid_until === record.valid_until
      && existing.status === record.status && existing.recorded_by === record.recorded_by
      && existing.note === record.note;
    if (!same) throw new Error(`研究证据 ${record.evidence_id} 已存在且内容不同，拒绝覆盖`);
    return { evidence_id: record.evidence_id, created: false, record: existing };
  }
  inPortfolioTransaction(db, () => {
    db.prepare(`INSERT INTO research_evidence
      (evidence_id, kind, buy_code, sell_code, strategy_id, as_of, valid_until, status, recorded_by, recorded_at, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.evidence_id, record.kind, record.buy_code, record.sell_code, record.strategy_id,
      record.as_of, record.valid_until, record.status, record.recorded_by, record.recorded_at, record.note,
    );
  });
  return { evidence_id: record.evidence_id, created: true, record };
}

export interface EvidenceStatusEvent {
  evidence_id: string;
  from_status: string;
  to_status: string;
  recorded_by: string;
  recorded_at: string;
  reason: string;
}

/**
 * 读取一条证据的状态迁移历史（按写入顺序，最早在前）。
 * 表不存在或没有历史时返回空数组——只读路径不建表、不抛错。
 */
export function readEvidenceStatusHistory(
  db: DatabaseSync | null | undefined, evidenceId: string,
): EvidenceStatusEvent[] {
  if (!db || !evidenceId) return [];
  try {
    if (!tableExists(db, 'research_evidence_status_event')) return [];
    const rows = db.prepare(
      'SELECT * FROM research_evidence_status_event WHERE evidence_id = ? ORDER BY id ASC',
    ).all(evidenceId) as any[];
    return rows.map(row => ({
      evidence_id: row.evidence_id,
      from_status: row.from_status,
      to_status: row.to_status,
      recorded_by: row.recorded_by,
      recorded_at: row.recorded_at,
      reason: row.reason ?? '',
    }));
  } catch {
    return [];
  }
}

export interface RevokeEvidenceResult {
  evidence_id: string;
  previous_status: string;
  status: 'REVOKED';
  revoked_at: string;
  revoked_by: string;
  /** 重复撤回时为 true：状态没有变化，也没有新增审计行。 */
  already_revoked: boolean;
}

/**
 * 显式、受控、可审计的 VERIFIED → REVOKED（R2 A5）。
 *
 * 只做状态迁移：**不删除、不改写**原记录的经济字段（代码/日期/策略/结论），
 * 只把 `status` 改成 REVOKED，并向 `research_evidence_status_event` 追加一行。
 * 必须 `confirm: true` 且 `recordedBy` 非空；记录不存在或已是 REVOKED 都拒绝
 * （已撤回时返回同一形状并标 `already_revoked: true`，不重复写审计行）。
 */
export function revokeResearchEvidence(
  db: DatabaseSync, evidenceId: string,
  options: { confirm?: boolean; recordedBy?: string; reason?: string } = {},
): RevokeEvidenceResult {
  if (options.confirm !== true) {
    throw new Error('撤回研究证据需要显式 confirm: true；该动作不能由读取/决策路径自动完成');
  }
  const recordedBy = String(options.recordedBy ?? '').trim();
  if (!recordedBy) throw new Error('撤回研究证据需要非空 recordedBy（谁撤回的）');
  const id = requireText(evidenceId, 'evidence_id');
  const existing = readResearchEvidence(db, id);
  if (!existing) throw new Error(`研究证据 ${id} 不存在，无法撤回`);

  const at = new Date().toISOString();
  if (existing.status === 'REVOKED') {
    const prior = readEvidenceStatusHistory(db, id).filter(e => e.to_status === 'REVOKED').pop();
    return {
      evidence_id: id,
      previous_status: 'REVOKED',
      status: 'REVOKED',
      revoked_at: prior?.recorded_at ?? at,
      revoked_by: prior?.recorded_by ?? recordedBy,
      already_revoked: true,
    };
  }

  ensureEvidenceSchema(db);
  inPortfolioTransaction(db, () => {
    // 只改状态列；经济字段原样保留（内容哈希因此只会在状态上变化）。
    db.prepare('UPDATE research_evidence SET status = ? WHERE evidence_id = ?').run('REVOKED', id);
    db.prepare(`INSERT INTO research_evidence_status_event
      (evidence_id, from_status, to_status, recorded_by, recorded_at, reason)
      VALUES (?,?,?,?,?,?)`).run(id, existing.status, 'REVOKED', recordedBy, at, String(options.reason ?? ''));
  });
  return {
    evidence_id: id,
    previous_status: existing.status,
    status: 'REVOKED',
    revoked_at: at,
    revoked_by: recordedBy,
    already_revoked: false,
  };
}

/** 只读按 ID 取记录；表不存在返回 undefined（不建表、不抛错）。 */
export function readResearchEvidence(db: DatabaseSync | null | undefined, evidenceId: string): ResearchEvidenceRecord | undefined {
  if (!db || !evidenceId) return undefined;
  try {
    if (!tableExists(db, 'research_evidence')) return undefined;
    const row = db.prepare('SELECT * FROM research_evidence WHERE evidence_id = ?').get(evidenceId) as any;
    return row ? rowToRecord(row) : undefined;
  } catch {
    return undefined;
  }
}

export interface EvidenceClaimInput {
  evidence_id?: string | null;
}

export interface VerifyEvidenceOptions {
  buyCode: string;
  sellCode?: string | null;
  /** 决策适用的交易日 YYYYMMDD。 */
  asOf: string;
}

export interface VerifyEvidenceResult {
  verified: boolean;
  reason: EvidenceReason | null;
  record: ResearchEvidenceRecord | null;
  detail: string;
}

/**
 * 校验一条证据声明。只有同时满足以下条件才 verified:true：
 * 记录存在、状态 VERIFIED、买入代码一致、记录声明了卖出代码时卖出代码也一致、
 * `as_of <= asOf`、`valid_until` 为空或 >= asOf、声明的 evidence_id 与记录一致。
 * 任何一条不满足都给出具体原因，绝不把"查不到"当成"通过"。
 */
export function verifyResearchEvidence(
  db: DatabaseSync | null | undefined,
  claim: EvidenceClaimInput | null | undefined,
  options: VerifyEvidenceOptions,
): VerifyEvidenceResult {
  const evidenceId = String(claim?.evidence_id ?? '').trim();
  if (!evidenceId) {
    return { verified: false, reason: 'evidence_not_found', record: null, detail: '未提供 evidence_id' };
  }
  const asOf = String(options.asOf ?? '').trim();
  if (!/^\d{8}$/.test(asOf)) {
    return { verified: false, reason: 'evidence_not_yet_valid', record: null, detail: `asOf 不是 YYYYMMDD：${options.asOf}` };
  }
  if (!db) {
    return { verified: false, reason: 'evidence_not_found', record: null, detail: '未提供账户库，无法复核研究证据' };
  }
  const record = readResearchEvidence(db, evidenceId);
  if (!record || record.evidence_id !== evidenceId) {
    return { verified: false, reason: 'evidence_not_found', record: null, detail: `研究证据 ${evidenceId} 不存在` };
  }
  if (record.status === 'REVOKED') {
    return { verified: false, reason: 'evidence_revoked', record, detail: `研究证据 ${evidenceId} 已被撤回` };
  }
  if (record.status !== 'VERIFIED') {
    return { verified: false, reason: 'evidence_status_not_verified', record, detail: `研究证据 ${evidenceId} 状态为 ${record.status}` };
  }
  const buyCode = normalizeSecurityCode(options.buyCode);
  if (record.buy_code !== buyCode) {
    return { verified: false, reason: 'evidence_code_mismatch', record, detail: `证据买入 ${record.buy_code} 与本次 ${buyCode} 不一致` };
  }
  if (record.sell_code !== null) {
    const sellCode = options.sellCode == null ? null : normalizeSecurityCode(options.sellCode);
    if (sellCode === null || record.sell_code !== sellCode) {
      return { verified: false, reason: 'evidence_code_mismatch', record, detail: `证据卖出 ${record.sell_code} 与本次 ${sellCode ?? '（未指定）'} 不一致` };
    }
  }
  if (record.as_of > asOf) {
    return { verified: false, reason: 'evidence_not_yet_valid', record, detail: `证据 as_of ${record.as_of} 晚于决策日 ${asOf}` };
  }
  if (record.valid_until !== null && record.valid_until < asOf) {
    return { verified: false, reason: 'evidence_expired', record, detail: `证据有效期至 ${record.valid_until}，早于决策日 ${asOf}` };
  }
  return { verified: true, reason: null, record, detail: '研究证据存在、状态有效、代码与日期匹配' };
}
