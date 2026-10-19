import type { DatabaseSync } from 'node:sqlite';
import { fetchAll } from './fetch.js';
import { upsertRows } from './db.js';
import { addDays, isTradeDay, latestTradeDay, previousTradeDay, shanghaiToday, syncTradeCal, tradeDaysBetween } from './ingest.js';
import { adjustmentRatio, AdjustMode, DataQueryError, parseYmd } from './data.js';
import { ETF_CANDIDATE_DECLARATIONS } from './etfDeclarations.js';

/**
 * ETF 数据纵切（R0）：基金基础信息、日线、复权因子与份额。
 *
 * 与股票管线完全隔离：只读写 fund_* 表，不触碰 daily/adj_factor/stock_basic
 * 等既有表，也不改变既有工具、评分或报告。口径以 R0 基线审计的实测结果为准：
 * - fund_daily.vol 单位是手（1 手 = 100 份），amount 单位是千元；
 * - fund_share.fd_share 单位是万份，是时点存量，不是资金净流入；
 * - fund_daily 支持按 trade_date 取全市场，因此按交易日同步，而不是逐代码同步。
 */

/** R0 冻结的五只持仓 ETF。 */
export const ETF_UNIVERSE = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'] as const;

/** ETF 交易单位：1 手 = 100 份（场内 ETF 的申报单位）。 */
export const ETF_LOT_SIZE = 100;
export const ETF_TRADE_UNIT = { lot_size: ETF_LOT_SIZE, unit: 'share', lot_unit: '手' } as const;

/**
 * 行情晚于预期最近交易日、或（无交易日历时）距查询截止日超过该自然日数即为 STALE
 * （只标记，不替换；有交易日期时以“不是预期最近交易日”为准）。
 */
export const ETF_STALE_MAX_AGE_DAYS = 7;
/** 流动性统计窗口（交易日数）。 */
export const ETF_LIQUIDITY_WINDOW = 20;
/** 默认查询窗口：截至 end 往前 30 个自然日，用于找到最后一根行情。 */
export const ETF_DEFAULT_WINDOW_DAYS = 30;
/** 份额变化估计要求两个份额日相隔不超过该自然日数，否则不视为可比；份额日相对最新行情也按此容差判定是否滞后。 */
export const ETF_FLOW_MAX_DATE_GAP_DAYS = 45;
export const ETF_SOURCE = 'tushare.fund_daily';

/**
 * 全市场 ETF 日线的最小合理行数。实测 20261016 `fund_daily?trade_date=` 返回 2165 行，
 * 500 是保守下限：低于它的一日回答不是“全市场某交易日”，而是上游残缺或权限受限。
 * 无论前一交易日有多少行，低于该下限一律不判为 complete。
 */
export const ETF_DAILY_MIN_ROWS = 500;
/** 判定日线回答完整时，允许相对基准（前一交易日或已有快照）收缩的最大比例。 */
export const ETF_DAILY_MIN_RATIO = 0.97;

/**
 * 份额变化只能表述为“净申购规模估计”，且必须同时具备：
 * 两个可比日期的 fund_share、以及一个净值/收盘价代理。
 * 成交额（amount）与份额变化都不得表述为“资金净流入”。
 */
export const FLOW_LABEL_RULE =
  '仅当两个份额日期可比（间隔 ≤ ' + ETF_FLOW_MAX_DATE_GAP_DAYS + ' 个自然日、都是交易日、份额均为正的万份）、'
  + '价格代理取自最新份额日当天、且（前一份额日, 最新份额日] 内 fund_adj 因子未变化时，'
  + '份额变化 × 当日价格才可标记为 net_creation_estimate（净申购规模估计，单位元）；'
  + '因子变化只记为 factor_change_unclassified（公司行动待核实），不得据此断言拆分或份额折算；'
  + 'fund_daily.amount 是二级市场成交额，份额变化是基金份额存量变化，二者都不是“资金净流入”，不得如此表述。';

const FUND_BASIC_FIELDS = 'ts_code,name,management,custodian,fund_type,found_date,due_date,list_date,issue_date,delist_date,issue_amount,m_fee,c_fee,benchmark,status,invest_type,type,market';
const FUND_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';
const FUND_ADJ_FIELDS = 'ts_code,trade_date,adj_factor';
const FUND_SHARE_FIELDS = 'ts_code,trade_date,fd_share,fund_type,market';

export type EtfQualityStatus = 'READY' | 'DEGRADED' | 'NOT_READY';

/**
 * 独立的估值/份额数据层级（任务书 D1）。
 *
 * 一个综合 status 无法回答“这只 ETF 今天能不能用于估值/研究”：真实生产
 * 2026-10-19 的持仓日报把所有持仓都报成 NOT_READY，而原因是行情缺失；反过来，
 * fund_share 的披露滞后（份额数据天然晚于价格）也不应该把当天有效的收盘价
 * 判成不可用。因此这里把维度拆开：
 * - `price`：最新一根日线是否可校验、是否落在预期交易日 —— 决定能否估值；
 * - `adjustment`：复权因子是否覆盖最新 bar —— 决定能否做 qfq/hfq 比较；
 * - `flow`：份额是否可得、是否滞后 —— 只影响净申购估计，不影响估值。
 */
export interface EtfValuationTiers {
  price: {
    status: EtfQualityStatus;
    /** 最新一根日线日期（真实日期，不替代）。 */
    bar_date: string | null;
    /** 是否等于预期最近交易日。 */
    matches_expected: boolean | null;
    reasons: string[];
  };
  adjustment: { available: boolean; factor_date: string | null; reasons: string[] };
  flow: {
    /** READY=当日或最近交易日有份额；LAGGED=有份额但晚于 bar；MISSING=没有份额。 */
    status: 'READY' | 'LAGGED' | 'MISSING';
    latest_share_date: string | null;
    /** 份额日期相对最新 bar 滞后多少个自然日；无份额时为 null。 */
    lag_days: number | null;
    reasons: string[];
  };
}

/** ETF 表是否存在：旧缓存（含未迁移的生产库）上 tools/list 与普通工具仍可用。 */
export function etfSchemaReady(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fund_daily'").get();
  return !!row;
}

export const ETF_NOT_INITIALIZED = 'ETF 缓存未初始化，请先运行 finance-ashare etf-sync';

function assertEtfSchema(db: DatabaseSync): void {
  if (!etfSchemaReady(db)) throw new DataQueryError(ETF_NOT_INITIALIZED);
}

function logFundSync(db: DatabaseSync, dataset: string, key: string, rows: number, status: string, message = ''): void {
  db.prepare('INSERT OR REPLACE INTO fund_sync_log (dataset, key, rows, status, message, synced_at) VALUES (?,?,?,?,?,?)')
    .run(dataset, key, rows, status, message.slice(0, 500), new Date().toISOString());
}

function fundSyncedOk(db: DatabaseSync, dataset: string, key: string): boolean {
  const row = db.prepare('SELECT status FROM fund_sync_log WHERE dataset = ? AND key = ?').get(dataset, key) as any;
  return row?.status === 'ok';
}

function countFundRows(db: DatabaseSync, table: string, date: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE trade_date = ?`).get(date) as any).n;
}

/** 6 位数字或代码名 → 交易所后缀（5/6 开头为 .SH，1/3 开头为 .SZ）。 */
function normalizeFundCode(raw: unknown): string {
  const text = String(raw ?? '').trim().toUpperCase();
  if (!text) throw new DataQueryError('缺少 ts_code');
  if (/^\d{6}\.(SH|SZ)$/.test(text)) return text;
  if (/^\d{6}$/.test(text)) return `${text}.${/^[56]/.test(text) ? 'SH' : 'SZ'}`;
  throw new DataQueryError(`无法识别的基金代码: ${text}`);
}

// ---------------------------------------------------------------- sync

export interface FundBasicSync {
  rows: number;
  fetched: boolean;
  /** 全市场请求失败的原因（逐只补齐后仍记录，不静默）。 */
  error?: string;
  /** 全市场结果里缺失、由逐只补查的代码。 */
  per_code_codes?: string[];
  /** 上游错误文本显示权限/积分不足，与普通网络失败区分开。 */
  permission_denied?: boolean;
}

/** 上游错误文本是否表示权限/积分不足（callTushare 的受限提示也含这些词）。 */
const FUND_PERMISSION_RE = /权限|积分/;
export function isFundPermissionError(message: string | undefined | null): boolean {
  return !!message && FUND_PERMISSION_RE.test(message);
}

/** fund_basic 最近一次同步是否因权限受限而缺失（供行情质量降级使用）。 */
export function fundBasicPermissionDenied(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT status, message FROM fund_sync_log WHERE dataset = 'fund_basic' ORDER BY synced_at DESC LIMIT 1").get() as any;
  return row?.status === 'permission_denied' || isFundPermissionError(row?.message);
}

/**
 * 基金基础信息。优先取场内全市场（market=E），失败时退回逐只查询，使权限较低的
 * token 也能同步这五只。
 *
 * 上游分页有陷阱：不带过滤条件的 fund_basic 按固定行数分页，某只 ETF 可能只出现在
 * 后面的页里。因此即使全市场请求成功，也要核对五只是否都已落库，缺哪只就单独补查
 * —— 不做“一次调用就覆盖全市场”的假设。只写 fund_basic，不触碰 stock_basic。
 */
export async function syncFundBasic(db: DatabaseSync): Promise<FundBasicSync> {
  assertEtfSchema(db);
  const now = new Date().toISOString();
  let rows: Record<string, any>[] = [];
  let error: string | undefined;
  try {
    rows = await fetchAll('fund_basic', { market: 'E' }, FUND_BASIC_FIELDS, 6000);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  const seen = new Set(rows.map(r => r.ts_code));
  const missing = ETF_UNIVERSE.filter(c => !seen.has(c));
  if (missing.length) {
    for (const code of missing) {
      try {
        rows.push(...await fetchAll('fund_basic', { ts_code: code }, FUND_BASIC_FIELDS));
      } catch (e: any) {
        error = [error, `${code}: ${String(e?.message ?? e)}`].filter(Boolean).join('; ');
      }
    }
  }
  const valid = rows.filter(r => r.ts_code);
  valid.forEach(r => { r.updated_at = now; });
  const n = upsertRows(db, 'fund_basic', [...FUND_BASIC_FIELDS.split(','), 'updated_at'], valid);
  const permission = isFundPermissionError(error);
  const notes = [error ? `whole-market error: ${error}` : '', missing.length ? `per-code filled: ${missing.join(',')}` : ''].filter(Boolean).join('; ');
  // 权限/积分不足与普通失败分开记录，行情查询据此给出 fund_basic_permission 而不是笼统的缺失。
  logFundSync(db, 'fund_basic', 'market=E', n, n ? 'ok' : permission ? 'permission_denied' : 'empty', notes);
  return {
    rows: n, fetched: true,
    ...(error ? { error: error.slice(0, 200) } : {}),
    ...(missing.length ? { per_code_codes: missing } : {}),
    ...(permission ? { permission_denied: true } : {}),
  };
}

export interface FundDateSync {
  rows: number;
  fetched: boolean;
  /** ok=完整；partial=有数据但不完整；unverifiable=日历给不出前一交易日，无法比对；empty=无数据。 */
  status: string;
  write: 'replaced' | 'merged' | 'none';
  error?: string;
}

/**
 * 按交易日同步全市场基金日线。与股票 syncTradeDate 同思路：一次请求取一天
 * 全市场，整日替换，因此上游修订或撤下的行不会残留；明显不完整的回答不覆盖
 * 已有的完整快照，而是合并或保留。
 */
export async function syncFundDaily(db: DatabaseSync, start: string, end: string, opts: { refresh?: boolean } = {}): Promise<Record<string, FundDateSync>> {
  assertEtfSchema(db);
  const days = tradeDaysBetween(db, start, end);
  if (!days.length) throw new DataQueryError(`交易日历在 ${start}-${end} 内为空，请先同步 trade_cal`);
  const out: Record<string, FundDateSync> = {};
  for (const date of days) {
    const before = countFundRows(db, 'fund_daily', date);
    if (!opts.refresh && fundSyncedOk(db, 'fund_daily', date)) {
      out[date] = { rows: before, fetched: false, status: before ? 'ok' : 'empty', write: 'none' };
      continue;
    }
    // 完整性基准必须是“上一个真实交易日”，不能用 date-1：周一的自然日前一日是周日，
    // 长假后的前一天也不开市，都会得到 0 行，从而把残缺回答误判为完整。
    const prevDay = previousTradeDay(db, date) ?? null;
    const prevCount = prevDay ? countFundRows(db, 'fund_daily', prevDay) : 0;
    let rows: Record<string, any>[];
    try {
      rows = await fetchAll('fund_daily', { trade_date: date }, FUND_DAILY_FIELDS, 6000);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      logFundSync(db, 'fund_daily', date, 0, before ? 'ok' : 'failed', 'request failed: ' + message);
      out[date] = { rows: before, fetched: true, status: before ? 'ok' : 'failed', write: 'none', error: message.slice(0, 200) };
      continue;
    }
    const valid = rows.filter(r => r.ts_code);
    // 三个独立条件同时成立才算完整：
    // 1) 绝对下限：全市场某交易日至少 ETF_DAILY_MIN_ROWS 行，即使前一交易日同样很少；
    // 2) 与基准可比：不低于基准（前一交易日行数，缺失时退化为已有快照行数）的 97%；
    // 3) 不缩小已有快照：不低于本日已有行数的 97%（显式写出，不依赖条件 2）。
    const baseline = prevCount || before;
    const floorOk = valid.length >= ETF_DAILY_MIN_ROWS;
    const comparable = baseline === 0 || valid.length >= baseline * ETF_DAILY_MIN_RATIO;
    const keepsExisting = valid.length >= before * ETF_DAILY_MIN_RATIO;
    // 日历给不出前一交易日时，完整性无法验证：即使行数达标也只记 unverifiable。
    const verifiable = !!prevDay;
    const complete = verifiable && floorOk && comparable && keepsExisting;
    let write: FundDateSync['write'];
    if (!floorOk) {
      // 低于全市场下限的回答不是“某天只有几百只 ETF 成交”，不写入缓存。
      write = 'none';
    } else if (complete) {
      db.prepare('DELETE FROM fund_daily WHERE trade_date = ?').run(date);
      upsertRows(db, 'fund_daily', FUND_DAILY_FIELDS.split(','), valid);
      write = 'replaced';
    } else if (!before) {
      upsertRows(db, 'fund_daily', FUND_DAILY_FIELDS.split(','), valid);
      write = 'merged';
    } else {
      write = 'none';
    }
    const after = countFundRows(db, 'fund_daily', date);
    const status = after ? (complete ? 'ok' : verifiable ? 'partial' : 'unverifiable') : 'empty';
    // 列出所有未通过的条件，便于定位是“上游残缺”还是“日历缺失”。
    const why = complete ? '' : [
      !floorOk ? `行数 ${valid.length} 低于全市场下限 ${ETF_DAILY_MIN_ROWS}` : '',
      !verifiable ? '交易日历缺少前一交易日，完整性不可验证' : '',
      verifiable && !comparable ? `行数 ${valid.length} 明显少于基准 ${baseline}（前一交易日 ${prevDay}）` : '',
      !keepsExisting ? `行数 ${valid.length} 少于已有快照 ${before}` : '',
    ].filter(Boolean).join('；');
    logFundSync(db, 'fund_daily', date, valid.length, status,
      `${write} ${before}->${after}${prevDay ? `; prev ${prevDay}=${prevCount}` : '; no previous trade day'}${why ? `; ${why}` : ''}`);
    out[date] = { rows: after, fetched: true, status, write, ...(why ? { error: why } : {}) };
  }
  return out;
}

/**
 * 复权因子。fund_adj 按代码区间取，逐只合并写入（不做整段替换，避免一次
 * 失败抹掉已有历史）。任何一只失败只记录该代码，不影响其他代码。
 * `codes` 缺省为五只持仓；日频流水线会把已声明的候选池也纳入，否则候选的
 * 复权口径永远是 raw_close_no_adj_factor。
 */
export async function syncFundAdj(
  db: DatabaseSync, start: string, end: string, opts: { codes?: readonly string[] } = {},
): Promise<Record<string, number>> {
  assertEtfSchema(db);
  const out: Record<string, number> = {};
  for (const code of opts.codes ?? ETF_UNIVERSE) {
    const key = `${code}:${start}-${end}`;
    try {
      const rows = (await fetchAll('fund_adj', { ts_code: code, start_date: start, end_date: end }, FUND_ADJ_FIELDS))
        .filter(r => r.ts_code && r.trade_date);
      const n = upsertRows(db, 'fund_adj', FUND_ADJ_FIELDS.split(','), rows);
      logFundSync(db, 'fund_adj', key, n, n ? 'ok' : 'empty');
      out[code] = n;
    } catch (e: any) {
      logFundSync(db, 'fund_adj', key, 0, 'failed', 'request failed: ' + String(e?.message ?? e));
      out[code] = 0;
    }
  }
  return out;
}

/** 基金份额（时点存量，万份）。同样按代码区间合并写入。 */
export async function syncFundShare(
  db: DatabaseSync, start: string, end: string, opts: { codes?: readonly string[] } = {},
): Promise<Record<string, number>> {
  assertEtfSchema(db);
  const out: Record<string, number> = {};
  for (const code of opts.codes ?? ETF_UNIVERSE) {
    const key = `${code}:${start}-${end}`;
    try {
      const rows = (await fetchAll('fund_share', { ts_code: code, start_date: start, end_date: end }, FUND_SHARE_FIELDS))
        .filter(r => r.ts_code && r.trade_date);
      const n = upsertRows(db, 'fund_share', FUND_SHARE_FIELDS.split(','), rows);
      logFundSync(db, 'fund_share', key, n, n ? 'ok' : 'empty');
      out[code] = n;
    } catch (e: any) {
      logFundSync(db, 'fund_share', key, 0, 'failed', 'request failed: ' + String(e?.message ?? e));
      out[code] = 0;
    }
  }
  return out;
}

export interface EtfSyncSummary {
  start: string;
  end: string;
  trade_days: number;
  fund_basic: FundBasicSync;
  fund_daily: Record<string, FundDateSync>;
  fund_adj: Record<string, number>;
  fund_share: Record<string, number>;
  errors: string[];
  seconds: number;
}

/** 五只 ETF 的完整同步：基础信息 → 逐交易日全市场日线 → 逐代码复权/份额。 */
export async function syncEtf(db: DatabaseSync, start: string, end: string, opts: { refresh?: boolean } = {}): Promise<EtfSyncSummary> {
  const t0 = Date.now();
  const errors: string[] = [];
  // 按交易日同步需要交易日历；缺失时先补该区间，不假设“工作日 = 交易日”。
  if (!tradeDaysBetween(db, start, end).length) await syncTradeCal(db, addDays(start, -10), addDays(end, 10));
  const basic = await syncFundBasic(db);
  if (basic.error) errors.push(`fund_basic: ${basic.error}`);
  const daily = await syncFundDaily(db, start, end, opts);
  for (const [date, r] of Object.entries(daily)) if (r.error) errors.push(`fund_daily ${date}: ${r.error}`);
  const adj = await syncFundAdj(db, start, end);
  const share = await syncFundShare(db, start, end);
  for (const [code, n] of Object.entries(adj)) if (!n) errors.push(`fund_adj ${code}: 无数据或请求失败`);
  for (const [code, n] of Object.entries(share)) if (!n) errors.push(`fund_share ${code}: 无数据或请求失败`);
  return {
    start, end,
    trade_days: Object.keys(daily).length,
    fund_basic: basic, fund_daily: daily, fund_adj: adj, fund_share: share,
    errors, seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// ---------------------------------------------------------------- daily pipeline integration

/** 已声明的候选池（C2）。稳定性：声明顺序即去重顺序。 */
export const ETF_CANDIDATE_CODES: readonly string[] = ETF_CANDIDATE_DECLARATIONS.map(d => d.ts_code);

/**
 * 日频流水线需要的全部代码：五只真实持仓在前（优先保障），其后是已声明的候选池。
 * 去重后持仓仍然排在第一位，逐代码兜底时先补持仓。
 */
export const ETF_PIPELINE_CODES: readonly string[] = [...new Set([...ETF_UNIVERSE, ...ETF_CANDIDATE_CODES])];

/** 候选池日线回看窗口（自然日）：60 根评分窗口 + 流动性 20 根，留足节假日余量。 */
export const ETF_CANDIDATE_HISTORY_DAYS = 120;
/** fund_basic 的无条件刷新间隔（自然日）。基础信息变化很慢，每天全量重拉只会浪费额度。 */
export const ETF_FUND_BASIC_REFRESH_DAYS = 7;

const FUND_DAILY_BAR_COLS = FUND_DAILY_FIELDS.split(',');
const FUND_ADJ_COLS = FUND_ADJ_FIELDS.split(',');
const FUND_SHARE_COLS = FUND_SHARE_FIELDS.split(',');

export interface FundHoldingFetch {
  ts_code: string;
  /** 上游返回的原始行情行数（0 表示上游确实没有这一天的基金行情，通常是停牌）。 */
  upstream_rows: number;
  written: number;
  /** 兜底是否真的发出了请求；已有合法 bar 时为 false（幂等，不重复调用）。 */
  fetched: boolean;
  error?: string;
}

/**
 * 逐只补齐某交易日的基金日线 —— 全市场回答缺失时的**兜底**，不是主路径。
 *
 * 触发场景（真实生产 2026-10-19）：`fund_daily?trade_date=` 返回了 2162 行，但
 * 五只持仓中有两只的上市日期晚于 Tushare 分页的稳定顺序，全市场分页在某些
 * 交易日会漏掉它们。缺失持仓基金是“不可估值”，必须在当天明确处理，而不是
 * 等下一个交易日。
 *
 * 安全条件：
 * - 已有合法 bar 且不是 `refresh` 时不发请求（幂等，不重复消耗额度）；
 * - 单只失败只记录该代码，不抛出、不影响其他代码，也不删除任何已有行；
 * - 上游确实没有该日行情（停牌）时返回 upstream_rows=0 并记录，不伪造。
 */
export async function syncFundDailyCodes(
  db: DatabaseSync, date: string, codes: readonly string[] = ETF_UNIVERSE, opts: { refresh?: boolean } = {},
): Promise<FundHoldingFetch[]> {
  assertEtfSchema(db);
  const out: FundHoldingFetch[] = [];
  for (const code of codes) {
    const existing = db.prepare('SELECT open, high, low, close, vol, amount FROM fund_daily WHERE ts_code = ? AND trade_date = ?')
      .get(code, date) as any;
    const existingValid = !!existing && validateFundBar(existing).valid;
    // 已有合法 bar 就跳过：全市场刷新（含 --refresh）已经覆盖了当天，“逐只兜底”
    // 只用于补齐全市场回答漏掉/坏掉的持仓，避免重复的 Tushare 调用与重复写入。
    if (existingValid) {
      out.push({ ts_code: code, upstream_rows: 0, written: 0, fetched: false });
      continue;
    }
    try {
      const rows = (await fetchAll('fund_daily', { ts_code: code, trade_date: date }, FUND_DAILY_FIELDS))
        .filter(r => r.ts_code && r.trade_date === date);
      let written = 0;
      if (rows.length) {
        // 只写这一只、这一天：不触碰同日其他代码，也不删除全市场已有的行。
        written = upsertRows(db, 'fund_daily', FUND_DAILY_BAR_COLS, rows);
      }
      const logKey = `${code}:${date}`;
      logFundSync(db, 'fund_daily_per_code', logKey, written, rows.length ? 'ok' : 'empty',
        rows.length ? 'per-code fallback' : `上游无该日行情（可能停牌）${date}`);
      out.push({ ts_code: code, upstream_rows: rows.length, written, fetched: true });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      logFundSync(db, 'fund_daily_per_code', `${code}:${date}`, 0, 'failed', 'request failed: ' + message);
      out.push({ ts_code: code, upstream_rows: 0, written: 0, fetched: true, error: message.slice(0, 200) });
    }
  }
  return out;
}

/** 某交易日五只持仓的覆盖情况：哪些有合法 bar，哪些上游确认无行情（停牌）。 */
export interface FundHoldingCoverage {
  date: string;
  ready: string[];
  /** 上游确认当日没有基金行情（停牌或未上市），不是同步失败。 */
  no_upstream_bar: string[];
  /** 既没有 bar 也没有上游确认（未请求或请求失败）。 */
  missing: string[];
  errors: { ts_code: string; error: string }[];
}

export function fundHoldingCoverage(
  db: DatabaseSync, date: string, fetches: readonly FundHoldingFetch[] = [], codes: readonly string[] = ETF_UNIVERSE,
): FundHoldingCoverage {
  const coverage: FundHoldingCoverage = { date, ready: [], no_upstream_bar: [], missing: [], errors: [] };
  for (const code of codes) {
    const row = db.prepare('SELECT open, high, low, close, vol, amount FROM fund_daily WHERE ts_code = ? AND trade_date = ?').get(code, date) as any;
    const fetch = fetches.find(f => f.ts_code === code);
    if (fetch?.error) coverage.errors.push({ ts_code: code, error: fetch.error });
    if (row && validateFundBar(row).valid) coverage.ready.push(code);
    else if (fetch && fetch.upstream_rows === 0 && !fetch.error) coverage.no_upstream_bar.push(code);
    else coverage.missing.push(code);
  }
  return coverage;
}

/** fund_basic 是否到了该刷新的时候（缺失、权限失败后重试、或超过刷新间隔）。 */
export function fundBasicRefreshDue(db: DatabaseSync, now = Date.now()): boolean {
  if (!etfSchemaReady(db)) return true;
  const present = (db.prepare('SELECT COUNT(*) n FROM fund_basic WHERE ts_code IN (?,?,?,?,?)')
    .get(...ETF_UNIVERSE) as any).n as number;
  if (present < ETF_UNIVERSE.length) return true;
  const row = db.prepare("SELECT status, synced_at FROM fund_sync_log WHERE dataset = 'fund_basic' ORDER BY synced_at DESC LIMIT 1").get() as any;
  if (!row) return true;
  // 权限/积分受限是暂时的：到期后必须重试，否则永远拿不到基础信息。
  if (row.status === 'permission_denied') return true;
  const age = (now - Date.parse(row.synced_at)) / 86400_000;
  return !Number.isFinite(age) || age >= ETF_FUND_BASIC_REFRESH_DAYS;
}

export interface EtfDailySyncSummary {
  dates: string[];
  /** 全市场日线按交易日的结果（缺失持仓会在这里标 partial/missing）。 */
  fund_daily: Record<string, FundDateSync>;
  /** 持仓逐只兜底结果；只有全市场回答未覆盖持仓时才真正发请求。 */
  holdings: Record<string, FundHoldingFetch[]>;
  /** 每个交易日的持仓覆盖，明确列出 READY / 上游无行情 / 缺失。 */
  coverage: Record<string, FundHoldingCoverage>;
  fund_basic: { refreshed: boolean; rows: number; error?: string; permission_denied?: boolean };
  fund_adj: Record<string, number>;
  fund_share: Record<string, number>;
  /** 按代码区间的复权/份额同步只覆盖最近窗口（候选池历史回看）。 */
  window: { adj_share_start: string; end: string };
  errors: string[];
  seconds: number;
}

/**
 * 日频流水线中的 ETF 部分。与股票同步**互相隔离**：
 * - 任何一步失败只记录在返回值里，绝不抛出，因此 ETF 故障不会中断股票日报；
 * - 失败的同步不会删除上一份已确认快照（同步函数本身按整日替换/合并写入）；
 * - 只同步“最近若干交易日”的全市场日线，不为候选池每天全量重拉历史。
 */
export async function syncEtfForDaily(
  db: DatabaseSync, end: string, opts: { refreshFrom?: string; days?: number } = {},
): Promise<EtfDailySyncSummary> {
  const t0 = Date.now();
  const errors: string[] = [];
  const days = opts.days ?? 5;
  const dates = tradeDaysBetween(db, addDays(end, -30), end).slice(-days);
  const summary: EtfDailySyncSummary = {
    dates,
    fund_daily: {},
    holdings: {},
    coverage: {},
    fund_basic: { refreshed: false, rows: 0 },
    fund_adj: {},
    fund_share: {},
    window: { adj_share_start: addDays(end, -ETF_CANDIDATE_HISTORY_DAYS), end },
    errors,
    seconds: 0,
  };
  if (!etfSchemaReady(db)) {
    errors.push(ETF_NOT_INITIALIZED);
    summary.seconds = Math.round((Date.now() - t0) / 1000);
    return summary;
  }
  if (!dates.length) {
    errors.push(`交易日历在 ${end} 之前没有交易日，跳过 ETF 同步`);
    summary.seconds = Math.round((Date.now() - t0) / 1000);
    return summary;
  }

  // 1) fund_basic：按需刷新，不无条件每天全量重拉。
  try {
    if (fundBasicRefreshDue(db)) {
      const basic = await syncFundBasic(db);
      summary.fund_basic = { refreshed: true, rows: basic.rows, ...(basic.error ? { error: basic.error } : {}), ...(basic.permission_denied ? { permission_denied: true } : {}) };
      if (basic.error) errors.push(`fund_basic: ${basic.error}`);
    }
  } catch (e: any) {
    summary.fund_basic = { refreshed: false, rows: 0, error: String(e?.message ?? e) };
    errors.push(`fund_basic: ${String(e?.message ?? e)}`);
  }

  // 2) 全市场日线：只刷最近若干交易日；上游修订不会残留（整日替换）。
  const refreshFrom = opts.refreshFrom;
  for (const date of dates) {
    const refresh = refreshFrom !== undefined && date >= refreshFrom;
    try {
      const perDate = await syncFundDaily(db, date, date, { refresh });
      summary.fund_daily[date] = perDate[date];
    } catch (e: any) {
      summary.fund_daily[date] = { rows: countFundRows(db, 'fund_daily', date), fetched: false, status: 'failed', write: 'none', error: String(e?.message ?? e) };
      summary.errors.push(`fund_daily ${date}: ${String(e?.message ?? e)}`);
    }
  }

  // 3) 逐只兜底：持仓必须先得到可校验的 bar（候选池不阻塞持仓）。
  for (const date of dates) {
    try {
      const fetches = await syncFundDailyCodes(db, date, ETF_UNIVERSE);
      summary.holdings[date] = fetches;
      const coverage = fundHoldingCoverage(db, date, fetches, ETF_UNIVERSE);
      summary.coverage[date] = coverage;
      for (const err of coverage.errors) errors.push(`fund_daily ${err.ts_code} ${date}: ${err.error}`);
    } catch (e: any) {
      summary.holdings[date] = [];
      summary.coverage[date] = fundHoldingCoverage(db, date, [], ETF_UNIVERSE);
      errors.push(`fund_daily per-code ${date}: ${String(e?.message ?? e)}`);
    }
  }

  // 4) 复权与份额：持仓 + 已声明候选池，按最近窗口逐代码合并写入。
  //    fund_share 允许披露滞后：缺失不会把有效日线降为不可估值（见 quoteOne）。
  try {
    summary.fund_adj = await syncFundAdj(db, summary.window.adj_share_start, end, { codes: ETF_PIPELINE_CODES });
  } catch (e: any) {
    errors.push(`fund_adj: ${String(e?.message ?? e)}`);
  }
  try {
    summary.fund_share = await syncFundShare(db, summary.window.adj_share_start, end, { codes: ETF_PIPELINE_CODES });
  } catch (e: any) {
    errors.push(`fund_share: ${String(e?.message ?? e)}`);
  }
  for (const [code, n] of Object.entries(summary.fund_adj)) {
    if (!n && (ETF_UNIVERSE as readonly string[]).includes(code)) errors.push(`fund_adj ${code}: 无数据或请求失败`);
  }

  summary.seconds = Math.round((Date.now() - t0) / 1000);
  return summary;
}

// ---------------------------------------------------------------- flow labelling

export interface FlowInput {
  /** 最新份额：时点存量，单位万份。 */
  latest: { trade_date: string; fd_share_wan: number } | null;
  /** 上一份额时点，必须早于 latest 且间隔可比。 */
  previous: { trade_date: string; fd_share_wan: number } | null;
  /** 净值或收盘价代理，单位元/份；必须取自最新份额日当天。 */
  nav_proxy: number | null;
  /** 价格代理所属日期。缺省视为未知（无法证明同日），不再是“同日”的默认值。 */
  nav_proxy_date?: string | null;
  /** 最新一根日线日期，用于判断份额数据是否明显滞后于行情。 */
  latest_bar_date?: string | null;
  /** (previous.trade_date, latest.trade_date] 内的复权因子变化；null 表示检查过且未变化。 */
  adjustment_event?: FlowFactorEvent | null;
  /** 是否成功检查过 fund_adj。false/缺省表示无法排除公司行动，不能给估计。 */
  adjustment_checked?: boolean;
  /** 两个份额日期是否都是交易日；null 表示日历缺失，无法判断。 */
  share_dates_are_trading_days?: boolean | null;
}

/** 复权因子变化事件。只说明因子变了，不据此断言拆分/份额折算。 */
export interface FlowFactorEvent {
  /** 变化前因子的最后观测日。 */
  from_date: string;
  /** 因子变化所在交易日。 */
  to_date: string;
  from_factor: number;
  to_factor: number;
  factor_ratio: number;
  /** fund_adj 的因子变化可能是拆分、份额折算或分红复权边界，未经核实不得断言具体类型。 */
  adjustment_kind: 'factor_change_unclassified';
}

export interface FlowClassification {
  /** 只有满足全部条件才是 net_creation_estimate，否则为 null。 */
  label: 'net_creation_estimate' | null;
  /** 净申购规模估计（元）：份额变化 × 价格代理；label 为 null 时也是 null。 */
  amount_cny: number | null;
  share_change_wan: number | null;
  unit: 'cny';
  /** 机器可读原因码（如 corporate_action_ambiguous）。 */
  reason: string;
  /** 人类可读补充说明；无可补充时为 null。 */
  detail: string | null;
  rule: string;
  /** 因子变化类型；未观察到变化时为 null。绝不等于“已确认拆分”。 */
  adjustment_kind: 'factor_change_unclassified' | null;
  /** 触发抑制的因子变化事件；未观察到时为 null。 */
  adjustment_event: FlowFactorEvent | null;
  /** 价格代理实际使用的日期（必须等于最新份额日期）。 */
  nav_proxy_date: string | null;
  latest_share_date: string | null;
  previous_share_date: string | null;
}

/** 日历日差（YYYYMMDD）。 */
function calendarDays(a: string, b: string): number {
  const toUtc = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((toUtc(b) - toUtc(a)) / 86400_000);
}

/**
 * 只给“净申购规模估计”打标签，绝不把成交额或份额变化称为“资金净流入”。
 * 条件：两个份额日可比（正的万份、间隔 ≤ ETF_FLOW_MAX_DATE_GAP_DAYS、都是交易日、不滞后于行情）、
 * 价格代理取自最新份额日当天、且区间内 fund_adj 因子没有变化（否则份额 delta 不可比）。
 * 因子变化只记录为 factor_change_unclassified，不得据此断言拆分或份额折算。
 */
export function classifyFlow(input: FlowInput): FlowClassification {
  const { latest, previous, nav_proxy: nav } = input;
  const base: Omit<FlowClassification, 'reason'> = {
    label: null, amount_cny: null, share_change_wan: null, unit: 'cny', rule: FLOW_LABEL_RULE, detail: null,
    adjustment_kind: null, adjustment_event: null,
    nav_proxy_date: input.nav_proxy_date ?? null,
    latest_share_date: latest?.trade_date ?? null,
    previous_share_date: previous?.trade_date ?? null,
  };
  if (!latest || !Number.isFinite(latest.fd_share_wan)) return { ...base, reason: 'share_missing' };
  if (!previous || !Number.isFinite(previous.fd_share_wan)) return { ...base, reason: 'share_prev_missing' };
  // fd_share 单位是万份的时点存量：非正或非有限值不具备可比性。
  if (!(latest.fd_share_wan > 0) || !(previous.fd_share_wan > 0)) {
    return { ...base, reason: 'share_units_invalid', detail: 'fund_share.fd_share 必须是正的万份存量' };
  }
  if (previous.trade_date >= latest.trade_date) return { ...base, reason: 'share_dates_not_comparable' };
  const gap = calendarDays(previous.trade_date, latest.trade_date);
  if (gap > ETF_FLOW_MAX_DATE_GAP_DAYS) {
    return { ...base, reason: `share_date_gap_${gap}d_exceeds_${ETF_FLOW_MAX_DATE_GAP_DAYS}d` };
  }
  if (input.share_dates_are_trading_days === false) {
    return { ...base, reason: 'share_date_not_trading_day', detail: '份额时点必须落在交易日历的交易日上' };
  }
  // 份额时点必须贴近最新行情，否则等于拿旧份额配新价格。
  if (input.latest_bar_date) {
    const lag = calendarDays(latest.trade_date, input.latest_bar_date);
    if (lag > ETF_FLOW_MAX_DATE_GAP_DAYS) {
      return {
        ...base, reason: 'share_stale_for_period',
        detail: `份额日 ${latest.trade_date} 距最新行情 ${input.latest_bar_date} 已 ${lag} 个自然日，超过 ${ETF_FLOW_MAX_DATE_GAP_DAYS} 日容差`,
      };
    }
  }
  // 因子在区间内变化：份额 delta 跨了公司行动边界，没有可核实的折算/申赎明细就不可比。
  if (input.adjustment_event) {
    return {
      ...base,
      reason: 'corporate_action_ambiguous',
      detail: `fund_adj 因子在 ${input.adjustment_event.to_date} 由 ${input.adjustment_event.from_factor} 变为 ${input.adjustment_event.to_factor}，`
        + '可能是拆分、份额折算或分红复权边界，未核实前不输出净申购估计',
      adjustment_kind: 'factor_change_unclassified',
      adjustment_event: input.adjustment_event,
    };
  }
  if (!input.adjustment_checked) {
    return { ...base, reason: 'corporate_action_unverified', detail: '缺少区间内 fund_adj 因子，无法排除拆分/份额折算' };
  }
  // 价格代理必须与最新份额同日，不能用最后一根 K 线的收盘价顶替。
  if (input.nav_proxy_date !== latest.trade_date) {
    return {
      ...base, reason: 'nav_proxy_date_mismatch',
      detail: `价格代理日期 ${input.nav_proxy_date ?? '缺失'} 不等于最新份额日 ${latest.trade_date}`,
    };
  }
  if (nav == null || !Number.isFinite(nav) || nav <= 0) return { ...base, reason: 'nav_proxy_invalid' };
  const changeWan = latest.fd_share_wan - previous.fd_share_wan;
  return {
    ...base,
    label: 'net_creation_estimate',
    amount_cny: Math.round(changeWan * 1e4 * nav * 100) / 100,
    share_change_wan: Math.round(changeWan * 10000) / 10000,
    reason: 'two comparable share dates and a same-date price proxy are available',
  };
}

// ---------------------------------------------------------------- queries

export interface EtfQuotesQuery {
  start?: unknown;
  end?: unknown;
  adjust?: unknown;
  /** 以交易日历为准的“预期最近交易日”；MCP 层按上海时区今天传入，缺省用 end。 */
  asOfDate?: unknown;
}

const round4 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);

/** qfq 基准：end 当日或之前最后一个复权因子，绝不使用 end 之后的因子。 */
export function fundBaseFactor(db: DatabaseSync, code: string, asOf: string): { trade_date: string; adj_factor: number } | null {
  const row = db.prepare('SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1')
    .get(code, asOf) as any;
  return row ? { trade_date: row.trade_date, adj_factor: row.adj_factor } : null;
}

function latestFundDailyDate(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(trade_date) d FROM fund_daily').get() as any)?.d ?? null;
}

export interface EtfQuote {
  ts_code: string;
  name: string | null;
  fund_type: string | null;
  invest_type: string | null;
  market: string | null;
  list_date: string | null;
  delist_date: string | null;
  status: string | null;
  benchmark: string | null;
  trade_unit: typeof ETF_TRADE_UNIT;
  as_of_trade_date: string;
  latest_bar: {
    trade_date: string;
    open: number | null; high: number | null; low: number | null; close: number | null;
    pre_close: number | null; change: number | null; pct_chg: number | null;
    vol_lots: number | null; amount_kcny: number | null;
    close_cny: number | null; amount_cny: number | null; volume_shares: number | null;
    /** 最新一根日线是否通过价格/成交量校验。 */
    valid: boolean;
    /** 未通过校验的原因码（invalid_ohlc / nonpositive_close / missing_close / negative_volume）。 */
    validation_reasons: string[];
  } | null;
  /** 可执行参考价（元/份）：只有最新日线通过校验且整只 READY 时才有值，否则为 null。 */
  executable_price_cny: number | null;
  adjusted: { mode: AdjustMode; base: { trade_date: string; adj_factor: number } | null; open: number | null; high: number | null; low: number | null; close: number | null };
  /** 窗口内逐日复权价（与 adjusted.mode 同口径），用于核对拆分前后的连续序列。 */
  adjusted_rows: { trade_date: string; open: number | null; high: number | null; low: number | null; close: number | null }[];
  share: {
    fd_share_wan: number | null;
    fd_share_wan_prev: number | null;
    share_change_wan: number | null;
    share_change_pct: number | null;
    latest_share_date: string | null;
    previous_share_date: string | null;
  };
  flow: FlowClassification;
  /** 窗口内复权因子发生变化的交易日（拆分/份额折算），原始价格不被平滑掉。 */
  adjustment_events: { trade_date: string; from_factor: number; to_factor: number; factor_ratio: number }[];
  liquidity: { window: number; bars_used: number; mean_amount_cny: number | null; zero_volume_days: number; max_gap_days: number | null };
  quality: { status: EtfQualityStatus; reasons: string[]; missing: string[] };
  /** 独立的数据层级：价格可估值性 / 复权 / 份额，互不替代（D1）。 */
  tiers: EtfValuationTiers;
  stale: boolean;
  expected_trade_date: string | null;
  bar_matches_expected: boolean | null;
  source: string;
  synced_at: string | null;
}

export interface EtfQuotesResult {
  query: { start_date: string; end_date: string; adjust: AdjustMode };
  as_of_trade_date: string;
  expected_trade_date: string | null;
  units: Record<string, string>;
  quotes: EtfQuote[];
  warnings: string[];
  source: string;
  flow_label_rule: string;
}

/**
 * 五只（或指定）ETF 的行情快照。每个代码独立判定质量：
 * - 窗口内没有任何行情 → NOT_READY，价格字段为 null，不伪造；
 * - 有行情但晚于预期最近交易日或超过 7 个自然日 → 仍返回该行情，同时标记 STALE/DEGRADED；
 * - 份额、复权因子、基础信息缺失 → DEGRADED 并列出 missing 字段名。
 */
export function etfQuotes(db: DatabaseSync, codes: unknown, q: EtfQuotesQuery = {}): EtfQuotesResult {
  assertEtfSchema(db);
  const adjust = (q.adjust == null || q.adjust === '' ? 'none' : String(q.adjust)) as AdjustMode;
  if (!['none', 'qfq', 'hfq'].includes(adjust)) throw new DataQueryError('adjust 只能是 none、qfq 或 hfq');
  const rawEnd = parseYmd(q.end, 'end_date');
  const asOf = parseYmd(q.asOfDate, 'as_of_date');
  const calendarEnd = asOf && (!rawEnd || rawEnd < asOf) ? asOf : rawEnd;
  const end = rawEnd ?? latestTradeDay(db, calendarEnd ?? shanghaiToday()) ?? latestFundDailyDate(db) ?? shanghaiToday();
  const start = parseYmd(q.start, 'start_date') ?? addDays(end, -ETF_DEFAULT_WINDOW_DAYS);
  if (start > end) throw new DataQueryError(`start_date ${start} 晚于 end_date ${end}`);
  const requested = codes == null || (Array.isArray(codes) && codes.length === 0) || codes === ''
    ? [...ETF_UNIVERSE] : (Array.isArray(codes) ? codes : [codes]);
  // 未显式指定 end 时，预期交易日按“今天”而不是窗口终点，否则历史窗口会永远 READY。
  const expected = latestTradeDay(db, calendarEnd ?? end) ?? null;

  const warnings: string[] = [];
  if (!expected) warnings.push('交易日历缺少该区间，无法判断行情是否落后于最近交易日；仅按 7 个自然日判定 STALE');

  const quotes = requested.map(raw => quoteOne(db, normalizeFundCode(raw), start, end, adjust, expected));
  return {
    query: { start_date: start, end_date: end, adjust },
    as_of_trade_date: end,
    expected_trade_date: expected,
    units: { price: '元/份', vol: '手（1 手 = 100 份）', amount: '千元', fd_share: '万份', amount_cny: '元', volume_shares: '份' },
    quotes,
    warnings,
    source: ETF_SOURCE,
    flow_label_rule: FLOW_LABEL_RULE,
  };
}

/**
 * 单根日线的价格/成交量校验。返回的原因码直接进入 quality.reasons：
 * close 缺失/非有限 → missing_close，close ≤ 0 → nonpositive_close，
 * 出现的 open/high/low ≤ 0 或非有限、high < low → invalid_ohlc，
 * vol/amount 为负或非有限 → negative_volume。
 */
export function validateFundBar(row: { open?: unknown; high?: unknown; low?: unknown; close?: unknown; vol?: unknown; amount?: unknown }): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const close = num(row.close);
  if (close == null || !Number.isFinite(close)) reasons.push('missing_close');
  else if (close <= 0) reasons.push('nonpositive_close');
  for (const key of ['open', 'high', 'low'] as const) {
    const v = num(row[key]);
    if (v != null && (!Number.isFinite(v) || v <= 0)) reasons.push('invalid_ohlc');
  }
  const high = num(row.high);
  const low = num(row.low);
  if (high != null && low != null && Number.isFinite(high) && Number.isFinite(low) && high < low) reasons.push('invalid_ohlc');
  for (const key of ['vol', 'amount'] as const) {
    const v = num(row[key]);
    if (v != null && (!Number.isFinite(v) || v < 0)) reasons.push('negative_volume');
  }
  const unique = [...new Set(reasons)];
  return { valid: unique.length === 0, reasons: unique };
}

/**
 * (fromDate, toDate] 内的复权因子变化。checked=false 表示缺少基准因子，无法排除公司行动。
 * 因子变化只返回 factor_change_unclassified，不断言拆分。
 */
function flowFactorChange(db: DatabaseSync, code: string, fromDate: string, toDate: string): { checked: boolean; event: FlowFactorEvent | null } {
  const base = db.prepare('SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1')
    .get(code, fromDate) as any;
  if (!base) return { checked: false, event: null };
  const rows = db.prepare('SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date > ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date')
    .all(code, fromDate, toDate) as any[];
  let running = base.adj_factor;
  for (const row of rows) {
    if (Math.abs(row.adj_factor - running) > 1e-9) {
      return {
        checked: true,
        event: {
          from_date: base.trade_date, to_date: row.trade_date,
          from_factor: running, to_factor: row.adj_factor,
          factor_ratio: Math.round((row.adj_factor / running) * 10000) / 10000,
          adjustment_kind: 'factor_change_unclassified',
        },
      };
    }
    running = row.adj_factor;
  }
  return { checked: true, event: null };
}

/** 两个份额日是否都在交易日历上是交易日；日历缺失返回 null（无法判断）。 */
function shareDatesTradingDays(db: DatabaseSync, dates: string[]): boolean | null {
  const flags = dates.map(d => isTradeDay(db, d));
  if (flags.some(f => f === false)) return false;
  if (flags.some(f => f === undefined)) return null;
  return true;
}

function quoteOne(db: DatabaseSync, code: string, start: string, end: string, adjust: AdjustMode, expected: string | null): EtfQuote {
  const reasons: string[] = [];
  const missing: string[] = [];
  const basic = db.prepare('SELECT * FROM fund_basic WHERE ts_code = ?').get(code) as any;
  if (!basic) {
    reasons.push('fund_basic_missing');
    missing.push('fund_basic');
    // 上游权限/积分不足与普通缺失区分开，便于判断“补同步”是否有用。
    if (fundBasicPermissionDenied(db)) reasons.push('fund_basic_permission');
  }
  const bars = db.prepare(`
    SELECT trade_date, open, high, low, close, pre_close, change, pct_chg, vol, amount
    FROM fund_daily WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date`).all(code, start, end) as any[];
  const last = bars.at(-1);
  if (!bars.length) { reasons.push('no_bar_in_window'); missing.push('fund_daily'); }
  // 逐行校验：非法 K 线不得让整只 ETF 变成 READY。
  const checks = bars.map(b => validateFundBar(b));
  for (const check of checks) for (const r of check.reasons) if (!reasons.includes(r)) reasons.push(r);
  const lastCheck = checks.at(-1) ?? null;
  const barInvalid = !!lastCheck && !lastCheck.valid;

  let stale = false;
  if (last) {
    const age = calendarDays(last.trade_date, end);
    if (expected && last.trade_date !== expected) {
      stale = true;
      reasons.push(`stale_bar: 最新行情 ${last.trade_date}，预期最近交易日 ${expected}`);
    }
    // 没有交易日历时无法判断“落后几个交易日”，只能按自然日放宽阈值。
    if ((!expected && age > ETF_STALE_MAX_AGE_DAYS) || (expected && age > ETF_STALE_MAX_AGE_DAYS * 2)) {
      stale = true;
      reasons.push(`stale_bar: 最新行情 ${last.trade_date} 距查询截止日 ${end} 已 ${age} 个自然日`);
    }
  }

  // 复权：与 data.ts 的股票口径一致（qfq 以 end 之前最后一个因子为基准）。
  // 因子缺失只影响复权比较，不影响“今天的收盘价能不能估值”（原始价仍可执行）。
  const factor = last ? (db.prepare('SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date = ?').get(code, last.trade_date) as any)?.adj_factor : null;
  const base = adjust === 'qfq' ? fundBaseFactor(db, code, end) : null;
  if (last && adjust !== 'none' && !(factor > 0)) { reasons.push('adj_factor_missing'); missing.push('fund_adj'); }
  if (last && adjust === 'qfq' && !base) { reasons.push('adj_factor_missing'); if (!missing.includes('fund_adj')) missing.push('fund_adj'); }
  // 未复权不需要因子；qfq/hfq 缺少因子时价格只能为 null，不能拿原始价冒充复权价。
  // 每一根 K 线用当日因子，qfq 的基准固定为 end 之前最后一个因子，因此拆分前后连续。
  const factors = new Map((db.prepare(`
    SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ?`)
    .all(code, start, end) as any[]).map(r => [r.trade_date, r.adj_factor]));
  const barRatio = (date: string) => {
    const f = factors.get(date);
    return adjust === 'none' ? 1 : adjustmentRatio(adjust, f > 0 ? f : NaN, base?.adj_factor ?? NaN);
  };
  const ratio = last ? barRatio(last.trade_date) : NaN;
  const adjPrice = (v: number | null) => (v == null || !Number.isFinite(ratio) ? null : round4(v * ratio));

  // 份额：最新与上一时点（都在 end 之前）。份额披露天然滞后于价格：
  // 缺失或滞后只影响净申购估计，不会把有效的日线判成不可估值（D1）。
  const shareRows = db.prepare('SELECT trade_date, fd_share FROM fund_share WHERE ts_code = ? AND trade_date <= ? AND fd_share IS NOT NULL ORDER BY trade_date DESC LIMIT 2')
    .all(code, end) as any[];
  const latestShare = shareRows[0] ?? null;
  const prevShare = shareRows[1] ?? null;
  if (!latestShare) { reasons.push('share_missing'); missing.push('fund_share'); }
  else if (!prevShare) reasons.push('share_prev_missing');
  const changeWan = latestShare && prevShare ? round4(latestShare.fd_share - prevShare.fd_share) : null;
  const changePct = latestShare && prevShare && prevShare.fd_share > 0
    ? Math.round(((latestShare.fd_share - prevShare.fd_share) / prevShare.fd_share) * 10000) / 100 : null;

  // 可执行价格：最新日线未通过校验时一律为 null，绝不用坏 close 冒充可成交价。
  const executable = !!last && !barInvalid;
  const closeCny = executable ? (last!.close ?? null) : null;
  // 净申购估计的价格代理必须取自最新份额日当天的行情，而不是最后一根 K 线的收盘价。
  const shareBar = latestShare
    ? db.prepare('SELECT trade_date, open, high, low, close, vol, amount FROM fund_daily WHERE ts_code = ? AND trade_date = ?').get(code, latestShare.trade_date) as any
    : null;
  const navProxy = shareBar && validateFundBar(shareBar).valid ? (shareBar.close as number) : null;
  const adjustment = latestShare && prevShare
    ? flowFactorChange(db, code, prevShare.trade_date, latestShare.trade_date)
    : { checked: false, event: null as FlowFactorEvent | null };
  const flow = classifyFlow({
    latest: latestShare ? { trade_date: latestShare.trade_date, fd_share_wan: latestShare.fd_share } : null,
    previous: prevShare ? { trade_date: prevShare.trade_date, fd_share_wan: prevShare.fd_share } : null,
    nav_proxy: navProxy,
    nav_proxy_date: navProxy == null ? null : latestShare?.trade_date ?? null,
    latest_bar_date: last?.trade_date ?? null,
    adjustment_event: adjustment.event,
    adjustment_checked: adjustment.checked,
    share_dates_are_trading_days: latestShare && prevShare ? shareDatesTradingDays(db, [latestShare.trade_date, prevShare.trade_date]) : null,
  });

  // 流动性单独取最近 20 根行情，不依赖调用方的展示窗口：短窗口只影响返回的行情，
  // 不把完整缓存判成 DEGRADED。bars_used 如实反映实际参与计算的根数（新上市不足
  // 20 日时为真实根数，不视为数据缺陷）。
  const liquidityBars = (db.prepare(`
    SELECT trade_date, vol, amount FROM fund_daily WHERE ts_code = ? AND trade_date <= ?
    ORDER BY trade_date DESC LIMIT ?`).all(code, end, ETF_LIQUIDITY_WINDOW) as any[]).reverse();
  // 负成交额是坏数据，不参与均值（仍由 negative_volume 原因码标记）。
  const amounts = liquidityBars.map(r => (r.amount == null ? null : r.amount * 1000)).filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  let maxGap: number | null = null;
  for (let i = 1; i < liquidityBars.length; i++) {
    const gap = calendarDays(liquidityBars[i - 1].trade_date, liquidityBars[i].trade_date);
    if (maxGap == null || gap > maxGap) maxGap = gap;
  }

  // 拆分/份额折算：列出窗口内复权因子发生变化的交易日，不把原始价格的不连续
  // 悄悄平滑掉。raw 价格始终保留，复权价按因子换算。
  const factorRows = db.prepare(`
    SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ? AND adj_factor > 0
    ORDER BY trade_date`).all(code, start, end) as any[];
  const adjustmentEvents: { trade_date: string; from_factor: number; to_factor: number; factor_ratio: number }[] = [];
  for (let i = 1; i < factorRows.length; i++) {
    const prev = factorRows[i - 1];
    const cur = factorRows[i];
    if (Math.abs(cur.adj_factor - prev.adj_factor) > 1e-9) {
      adjustmentEvents.push({
        trade_date: cur.trade_date,
        from_factor: prev.adj_factor,
        to_factor: cur.adj_factor,
        factor_ratio: Math.round((cur.adj_factor / prev.adj_factor) * 10000) / 10000,
      });
    }
  }

  // 质量分层：价格（能否估值）/ 复权（能否做复权比较）/ 份额（只影响净申购估计）。
  // 综合 status 只由价格层级与**会改变可执行价格**的原因决定：
  // - 无 bar / bar 非法 / 落后预期交易日 → NOT_READY（不可估值）；
  // - 复权因子或份额缺失 → 只降级 DEGRADED，价格仍可执行（原始收盘价）。
  // 真实生产 2026-10-19 的教训：份额披露滞后与行情缺失被混为同一状态，日报因此
  // 无法区分“今天没有价格”与“今天有价格、只是份额晚了一两天”。
  const priceReasons: string[] = [];
  if (!last) priceReasons.push('no_bar_in_window');
  else if (barInvalid) priceReasons.push(...(lastCheck?.reasons ?? ['invalid_bar']));
  if (stale) for (const reason of reasons.filter(r => r.startsWith('stale_bar'))) if (!priceReasons.includes(reason)) priceReasons.push(reason);
  const priceStatus: EtfQualityStatus = !last || barInvalid || stale ? 'NOT_READY' : 'READY';
  const adjustmentAvailable = !!last && factor > 0 && (adjust !== 'qfq' || !!base);
  const adjustmentReasons: string[] = [];
  if (last && !(factor > 0)) adjustmentReasons.push('adj_factor_missing');
  if (last && adjust === 'qfq' && !base) adjustmentReasons.push('qfq_base_factor_missing');
  const shareLagDays = latestShare && last ? calendarDays(latestShare.trade_date, last.trade_date) : null;
  const flowStatus: EtfValuationTiers['flow']['status'] = !latestShare
    ? 'MISSING'
    : !last || latestShare.trade_date >= last.trade_date ? 'READY' : 'LAGGED';
  const flowReasons: string[] = [];
  if (!latestShare) flowReasons.push('share_missing');
  else if (!prevShare) flowReasons.push('share_prev_missing');
  if (flowStatus === 'LAGGED') flowReasons.push(`share_lagged: 份额日期 ${latestShare.trade_date} 早于最新行情 ${last?.trade_date}`);
  const tiers: EtfValuationTiers = {
    price: { status: priceStatus, bar_date: last?.trade_date ?? null, matches_expected: last && expected ? last.trade_date === expected : null, reasons: priceReasons },
    adjustment: { available: adjustmentAvailable, factor_date: last && factor > 0 ? last.trade_date : null, reasons: adjustmentReasons },
    flow: { status: flowStatus, latest_share_date: latestShare?.trade_date ?? null, lag_days: shareLagDays, reasons: flowReasons },
  };

  // 最新日线非法或缺失 → NOT_READY（即使其他数据齐全）；其余原因只降级到 DEGRADED。
  const status: EtfQualityStatus = !last || barInvalid ? 'NOT_READY' : reasons.length ? 'DEGRADED' : 'READY';
  const logRow = last ? db.prepare("SELECT synced_at FROM fund_sync_log WHERE dataset = 'fund_daily' AND key = ?").get(last.trade_date) as any : null;

  return {
    ts_code: code,
    name: basic?.name ?? null,
    fund_type: basic?.fund_type ?? null,
    invest_type: basic?.invest_type ?? null,
    market: basic?.market ?? null,
    list_date: basic?.list_date ?? null,
    delist_date: basic?.delist_date || null,
    status: basic?.status ?? null,
    benchmark: basic?.benchmark ?? null,
    trade_unit: ETF_TRADE_UNIT,
    as_of_trade_date: end,
    latest_bar: last ? {
      trade_date: last.trade_date,
      open: last.open ?? null, high: last.high ?? null, low: last.low ?? null,
      // 原始 close 原样保留，close_cny 才是可执行价格：校验失败时为 null。
      close: last.close ?? null,
      pre_close: last.pre_close ?? null, change: last.change ?? null, pct_chg: last.pct_chg ?? null,
      vol_lots: last.vol ?? null, amount_kcny: last.amount ?? null,
      close_cny: closeCny,
      amount_cny: last.amount == null ? null : Math.round(last.amount * 1000 * 100) / 100,
      volume_shares: last.vol == null ? null : Math.round(last.vol * ETF_LOT_SIZE * 100) / 100,
      valid: !barInvalid,
      validation_reasons: lastCheck?.reasons ?? [],
    } : null,
    executable_price_cny: status === 'READY' ? closeCny : null,
    adjusted: {
      mode: adjust,
      base,
      // 非法 K 线不换算复权价，避免用坏价格驱动预案。
      open: executable ? adjPrice(last?.open) : null,
      high: executable ? adjPrice(last?.high) : null,
      low: executable ? adjPrice(last?.low) : null,
      close: executable ? adjPrice(last?.close) : null,
    },
    adjusted_rows: bars.map((b, i) => {
      const r = barRatio(b.trade_date);
      // 非法 K 线不进入复权序列，避免用坏价格核对连续性。
      const p = (v: number | null) => (v == null || !Number.isFinite(r) || !checks[i].valid ? null : round4(v * r));
      return { trade_date: b.trade_date, open: p(b.open), high: p(b.high), low: p(b.low), close: p(b.close) };
    }),
    share: {
      fd_share_wan: latestShare?.fd_share ?? null,
      fd_share_wan_prev: prevShare?.fd_share ?? null,
      share_change_wan: changeWan,
      share_change_pct: changePct,
      latest_share_date: latestShare?.trade_date ?? null,
      previous_share_date: prevShare?.trade_date ?? null,
    },
    flow,
    liquidity: {
      window: ETF_LIQUIDITY_WINDOW,
      bars_used: liquidityBars.length,
      mean_amount_cny: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length * 100) / 100 : null,
      zero_volume_days: liquidityBars.filter(r => r.vol === 0 || r.vol == null).length,
      max_gap_days: maxGap,
    },
    adjustment_events: adjustmentEvents,
    quality: { status, reasons, missing },
    tiers,
    stale,
    expected_trade_date: expected,
    bar_matches_expected: last && expected ? last.trade_date === expected : null,
    source: ETF_SOURCE,
    synced_at: logRow?.synced_at ?? null,
  };
}

// ---------------------------------------------------------------- status

export interface EtfStatusResult {
  initialized: boolean;
  as_of_trade_date: string;
  expected_trade_date: string | null;
  latest_fund_daily_date: string | null;
  universe: readonly string[];
  universe_size: number;
  coverage: { codes_with_bar_on_latest: number; codes_with_basic: number; codes_with_share: number };
  /** permission_denied：最近一次 fund_basic 同步因权限/积分受限，缺失不是“代码不存在”。 */
  fund_basic: { codes_present: string[]; missing: string[]; permission_denied: boolean };
  fund_share: { available: boolean; codes_with_share: number; latest_date: string | null };
  codes: { ts_code: string; name: string | null; status: EtfQualityStatus; reasons: string[]; latest_bar_date: string | null; stale: boolean; share_available: boolean }[];
  quality: { status: EtfQualityStatus; reasons: string[] };
  last_sync: { dataset: string; key: string; rows: number; status: string; synced_at: string }[];
  source: string;
  flow_label_rule: string;
}

/** ETF 数据状态：最新日线日期、五只覆盖、逐只就绪度与份额可得性。空库返回 NOT_READY，不抛异常。 */
export function etfStatus(db: DatabaseSync, q: { date?: unknown } = {}): EtfStatusResult {
  const requested = parseYmd(q.date, 'date');
  const base: EtfStatusResult = {
    initialized: etfSchemaReady(db),
    as_of_trade_date: requested ?? latestTradeDay(db, shanghaiToday()) ?? shanghaiToday(),
    expected_trade_date: null,
    latest_fund_daily_date: null,
    universe: ETF_UNIVERSE,
    universe_size: ETF_UNIVERSE.length,
    coverage: { codes_with_bar_on_latest: 0, codes_with_basic: 0, codes_with_share: 0 },
    fund_basic: { codes_present: [], missing: [...ETF_UNIVERSE], permission_denied: false },
    fund_share: { available: false, codes_with_share: 0, latest_date: null },
    codes: [],
    quality: { status: 'NOT_READY', reasons: [] },
    last_sync: [],
    source: ETF_SOURCE,
    flow_label_rule: FLOW_LABEL_RULE,
  };
  if (!base.initialized) {
    base.quality.reasons.push(ETF_NOT_INITIALIZED);
    return base;
  }
  const date = base.as_of_trade_date;
  base.expected_trade_date = latestTradeDay(db, date) ?? null;
  base.latest_fund_daily_date = latestFundDailyDate(db);
  const basics = db.prepare('SELECT ts_code, name FROM fund_basic').all() as any[];
  base.fund_basic.codes_present = basics.map(r => r.ts_code).filter(c => (ETF_UNIVERSE as readonly string[]).includes(c));
  base.fund_basic.missing = ETF_UNIVERSE.filter(c => !base.fund_basic.codes_present.includes(c));
  base.fund_basic.permission_denied = fundBasicPermissionDenied(db);
  base.coverage.codes_with_basic = base.fund_basic.codes_present.length;
  const share = db.prepare(`SELECT COUNT(DISTINCT ts_code) n, MAX(trade_date) d FROM fund_share WHERE ts_code IN (${ETF_UNIVERSE.map(() => '?').join(',')})`)
    .get(...ETF_UNIVERSE) as any;
  base.fund_share.codes_with_share = share?.n ?? 0;
  base.fund_share.latest_date = share?.d ?? null;
  base.fund_share.available = (share?.n ?? 0) > 0;

  const quotes = etfQuotes(db, [...ETF_UNIVERSE], { start: addDays(date, -ETF_DEFAULT_WINDOW_DAYS), end: date, adjust: 'none' });
  base.codes = quotes.quotes.map(x => ({
    ts_code: x.ts_code,
    name: x.name,
    status: x.quality.status,
    reasons: x.quality.reasons,
    latest_bar_date: x.latest_bar?.trade_date ?? null,
    stale: x.stale,
    share_available: x.share.fd_share_wan != null,
  }));
  base.coverage.codes_with_bar_on_latest = base.codes.filter(c => c.latest_bar_date === date).length;
  const latest = base.latest_fund_daily_date;
  if (!latest) base.quality.reasons.push('ETF 日线缓存为空，请先运行 finance-ashare etf-sync');
  else if (base.expected_trade_date && latest !== base.expected_trade_date) {
    base.quality.reasons.push(`最新 ETF 日线 ${latest} 落后于最近交易日 ${base.expected_trade_date}`);
  }
  for (const c of base.codes) if (c.status !== 'READY') base.quality.reasons.push(`${c.ts_code}: ${c.reasons.join('; ') || c.status}`);
  base.quality.status = !latest ? 'NOT_READY'
    : base.codes.every(c => c.status === 'READY') && !base.quality.reasons.length ? 'READY' : 'DEGRADED';
  base.last_sync = db.prepare('SELECT dataset, key, rows, status, synced_at FROM fund_sync_log ORDER BY synced_at DESC LIMIT 10').all() as any[];
  return base;
}
