import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import {
  DEMO_SNAPSHOT, DEMO_SNAPSHOT_ID, accountSummary, importDemoSnapshot, importSnapshot,
  latestSnapshot, markSnapshotCurrent, readSnapshot, reconcile,
  type AccountSnapshot,
} from './account.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import {
  buildNavSeries, confirmRealAccount, importEvents, initBaseline, readAccountCompleteness, recordEvent,
  replayAccount, setAccountCompleteness, settlementCalendarFromDb, validateLedger,
  type LedgerEventInput, type PriceTable,
} from './ledger.js';
import { buildScenarioQuotes, openMarketCache, type ScenarioMode } from './quotes.js';
import { buildScenario, type EtfQuoteInput, type ScenarioAction } from './scenario.js';
import { DEFAULT_FEE_RULES, DEFAULT_STRESS_RULES } from './rules.js';
import { runDecisionCommand } from './decisionCli.js';
import { defaultTradeDate, runResearchSummaryCommand } from './researchCli.js';
import { listConfiguredAccounts, resolveAccountId, resolveAccountSnapshot, resolveAccountState } from './accounts.js';
import { evaluateAccountStatus } from './decision.js';
import { buildDailyReport } from './dailyReport.js';
import { screenEtfCandidates } from '../ashare/etfUniverse.js';
import { buildBenchmarkComparison } from './benchmarks.js';
import { runFeeCommand, FEE_USAGE } from './feeCli.js';
import { parseTradeCsv } from './tradeImport.js';
import { loadFeeContext } from './fees.js';
import {
  EVIDENCE_STATUSES, ensureEvidenceSchema, readEvidenceStatusHistory, recordResearchEvidence,
  revokeResearchEvidence, type EvidenceStatus,
} from './evidence.js';

/**
 * 账户子命令。输出到 stdout 的永远是 JSON（与 ashare CLI 一致），进度与错误走 stderr。
 * 所有子命令只读写独立的 portfolio.sqlite，不打开市场库，也不写市场库。
 */

export interface PortfolioCliHelpers {
  arg(name: string): string | undefined;
  flag(name: string): boolean;
  ymd(value: string | undefined, label: string): string;
  print(value: unknown): void;
}

export const PORTFOLIO_USAGE = `用法: finance-ashare portfolio-<command> [options]

  portfolio-import [--file PATH] [--dry-run] [--confirm-current] [--db PATH]
                                                      导入账户快照。无 --file 时导入 PRD §3 演示基线；
                                                      --file 读取用户真实快照 JSON（先 --dry-run 对账再确认）
  portfolio-summary [--db PATH] [--snapshot ID]      只读账户汇总：市值、权重、集中度、主题暴露、对账
  portfolio-mark-current --snapshot ID --confirmed-by WHO [--db PATH]
                                                      把用户确认过的快照标记为当前账户（唯一路径；演示基线不可）
  portfolio-scenario --action hold|sell-buy [--db PATH]
        [--sell CODE] [--buy CODE] [--shares N]      静态换仓情景（确定性、只读、不下单）
        [--trade-date YYYYMMDD]                      行情交易日；缺省为快照 as_of
        [--mode server|research]                     缺省 server：价格只来自只读市场缓存
        [--market-db PATH]                          市场缓存路径；缺省 ASHARE_DB_PATH
        [--sell-price X] [--buy-price X]             仅 --mode research 可用（元/份），结果最多 ILLUSTRATIVE
        [--quote-date YYYYMMDD]                      research 模式的报价日期
        [--advantage yes|no] [--basis TEXT]          相对优势声明（布尔本身不是已验证优势）
        [--advantage-source RESEARCH_VERIFIED|UNVERIFIED] [--evidence-id ID] [--evidence-as-of YYYYMMDD]
        [--buy-kind etf|stock] [--buy-board BOARD]   调用方声明，仅用于核对，身份以缓存为准
        [--stress -0.10] [--commission 0.00025] [--slippage 0.0005]
  portfolio-decision --account ID --action hold|reduce|sell-buy|no-action [--db PATH]
        [--snapshot ID] [--trade-date YYYYMMDD] [--market-db PATH]
        [--sell CODE --shares N] [--buy CODE --buy-kind etf|stock]
        [--advantage-source RESEARCH_VERIFIED|UNVERIFIED --advantage-claim TEXT --evidence-id ID]
        [--stock-code CODE --stock-quantity N --stock-invalidation 元]
                                                      条件化配置比较（只读、确定性；候选行情只来自缓存）

  P2 事件账本（同一 portfolio.sqlite；金额整数分，价格整数厘）：
  portfolio-ledger-init --account ID --as-of YYYYMMDD [--snapshot ID] [--cash 分] [--db PATH]
                                                       建立账户重建起点（幂等，起点不可静默改写）
  portfolio-ledger-record --account ID --type TYPE --event-id ID --date YYYYMMDD [--db PATH]
        [--ts-code CODE] [--quantity N] [--price-milli 厘] [--gross-cents 分]
        [--fee-cents 分] [--tax-cents 分] [--cash-delta-cents 分] [--settled-on YYYYMMDD]
        [--ratio 3/1] [--reverses EVENT_ID] [--note TEXT] [--source synthetic|broker_statement]
        [--dry-run]                                  记录一条事件（同 id 同内容幂等，不同内容拒绝覆盖）
  portfolio-ledger-import --account ID --file PATH [--continue-on-conflict] [--dry-run] [--db PATH]
                                                       批量导入 JSON 或券商 CSV（UTF-8）；默认冲突即整批回滚
${FEE_USAGE}
  portfolio-ledger-replay --account ID [--as-of YYYYMMDD] [--db PATH]
                                                       重放持仓/现金/成本/已实现盈亏
  portfolio-ledger-nav --account ID --from YYYYMMDD --to YYYYMMDD [--prices FILE] [--db PATH]
                                                       单位净值序列与基线之后的最大回撤
  portfolio-ledger-validate --account ID [--db PATH]   账本不变量检查（现金/数量/撤销/拆分）
  portfolio-ledger-confirm-real --account ID --confirm 用户显式确认为真实账户（无 --confirm 直接拒绝）

  账本完整性声明（跨日重建的产品前提；不改变账本数据）：
  portfolio-completeness-set --account ID --as-of YYYYMMDD --recorded-by WHO --confirm [--db PATH]
        [--last-reconciled-at ISO] [--events-through YYYYMMDD] [--unreported-risk yes|no] [--note TEXT]
                                                       声明"用户已核对到哪个时点"；缺省按存在未上报交易风险处理
  portfolio-completeness --account ID [--db PATH]      只读查看当前完整性声明
  portfolio-account-list [--db PATH]                   只读列出本部署配置的账户及默认解析结果（C1）

  研究证据（唯一写路径；不通过 MCP 暴露）：
  portfolio-evidence-record --id ID --kind ROTATION --buy CODE [--sell CODE]
        --strategy ID --as-of YYYYMMDD [--valid-until YYYYMMDD]
        --status PENDING|VERIFIED|REVOKED --recorded-by WHO [--note TEXT] --confirm [--dry-run] [--db PATH]
                                                       写入一条可复核的研究证据记录；无 --confirm 直接拒绝
  portfolio-evidence-revoke --id ID --recorded-by WHO --confirm [--reason TEXT] [--db PATH]
                                                       受控撤回（VERIFIED→REVOKED，追加审计事件，不改写原记录）
  portfolio-evidence-history --id ID [--db PATH]       查看某条证据的状态变更历史

  收盘日报与研究候选（D1/C2/C6）：
  portfolio-daily-report --account ID [--date YYYYMMDD] [--snapshot ID] [--max-actions 0..3]
        [--market-db PATH] [--db PATH]                 首屏给出"下一交易日最值得做的 0–3 个动作"
  portfolio-etf-candidates --date YYYYMMDD [--categories broad,industry,bond,gold,cross_border]
        [--limit N] [--market-db PATH]                 适格 ETF 动态候选筛选（数据缺失显式 DEGRADED）
  portfolio-benchmarks [--start YYYYMMDD] [--end YYYYMMDD] [--market-db PATH]
                                                       事先固定的对照基准比较
`;

/** 严格整数参数：拒绝小数、空串与超出安全整数范围的输入。 */
function intArg(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${label} 需要整数（${raw}）`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 超出安全整数范围`);
  return value;
}

function requireArg(h: PortfolioCliHelpers, name: string): string {
  const value = h.arg(name);
  if (value === undefined || value.trim() === '') throw new Error(`需要 --${name}`);
  return value.trim();
}

/**
 * 价格文件（厘价）。两种写法都接受，统一归一化成"按日期"的 `{日期: {代码: 厘价}}`：
 * - 按日期：`{"20261019": {"159999.SZ": 1000}}`
 * - 按代码：`{"159999.SZ": {"20261019": 1000}}`
 * 也接受外面再包一层 `{"prices": ...}`。空/缺价表示该日无价（停牌），不伪造。
 */
function loadPrices(path: string): PriceTable {
  if (!existsSync(path)) throw new Error(`价格文件不存在：${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: any) {
    throw new Error(`价格文件不是合法 JSON：${error?.message ?? error}`);
  }
  const table = (raw && typeof raw === 'object' && 'prices' in (raw as Record<string, unknown>))
    ? (raw as Record<string, unknown>).prices
    : raw;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error('价格文件需要形如 {"20261019": {"159999.SZ": 1000}} 或 {"159999.SZ": {"20261019": 1000}} 的对象');
  }
  const outer = Object.entries(table as Record<string, unknown>);
  // 外层键是 8 位日期 → 按日期；否则按代码（内层键必须是日期）。
  const dateMajor = outer.length === 0 || outer.every(([key]) => /^\d{8}$/.test(key));
  const result: PriceTable = {};
  const put = (date: string, code: string, price: unknown) => {
    if (!/^\d{8}$/.test(date)) throw new Error(`价格文件日期 ${date} 需要 YYYYMMDD`);
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price <= 0) {
      throw new Error(`价格文件 ${code} ${date} 需要正整数厘价`);
    }
    (result[date] ??= {})[code] = price;
  };
  for (const [key, value] of outer) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`价格文件 ${key} 的映射不合法`);
    for (const [inner, price] of Object.entries(value as Record<string, unknown>)) {
      if (dateMajor) put(key, inner, price);
      else put(inner, key, price);
    }
  }
  return result;
}

/** 从 CLI 参数拼一条账本事件；字段齐全与否交给 normalizeEvent 统一校验。 */
function eventFromArgs(h: PortfolioCliHelpers, accountId: string): LedgerEventInput {
  const ratioRaw = h.arg('ratio');
  let ratioNum = intArg(h.arg('ratio-num'), '--ratio-num');
  let ratioDen = intArg(h.arg('ratio-den'), '--ratio-den');
  if (ratioRaw !== undefined) {
    const match = /^(\d+)\s*[:/]\s*(\d+)$/.exec(ratioRaw.trim());
    if (!match) throw new Error('--ratio 需要形如 3/1');
    ratioNum = Number(match[1]);
    ratioDen = Number(match[2]);
  }
  return {
    event_id: requireArg(h, 'event-id'),
    account_id: accountId,
    event_type: requireArg(h, 'type'),
    occurred_on: h.ymd(requireArg(h, 'date'), '--date'),
    settled_on: h.arg('settled-on') ? h.ymd(h.arg('settled-on'), '--settled-on') : null,
    ts_code: h.arg('ts-code') ?? null,
    quantity: intArg(h.arg('quantity'), '--quantity') ?? null,
    price_milli: intArg(h.arg('price-milli'), '--price-milli') ?? null,
    gross_cents: intArg(h.arg('gross-cents'), '--gross-cents') ?? null,
    fee_cents: intArg(h.arg('fee-cents'), '--fee-cents') ?? null,
    tax_cents: intArg(h.arg('tax-cents'), '--tax-cents') ?? null,
    cash_delta_cents: intArg(h.arg('cash-delta-cents'), '--cash-delta-cents') ?? null,
    ratio_num: ratioNum ?? null,
    ratio_den: ratioDen ?? null,
    reverses_event_id: h.arg('reverses') ?? null,
    note: h.arg('note') ?? '',
    source: h.arg('source') ?? 'synthetic',
  };
}


/** 只读打开账户库：库不存在时报错而不是创建空库。 */
function openReadOnly(dbPath: string | undefined, marketPath?: string): DatabaseSync {
  const path = dbPath ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false, marketPath });
}

function loadSnapshot(db: DatabaseSync, id: string | undefined) {
  const snapshot = id ? readSnapshot(db, id) : latestSnapshot(db);
  if (!snapshot) throw new Error(id ? `账户快照 ${id} 不存在` : '账户库中没有任何快照，请先运行 portfolio-import');
  return snapshot;
}

function positiveNumber(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 需要正数`);
  return value;
}

/**
 * 读取用户提供的真实账户快照 JSON。字段口径与 `AccountSnapshot` 完全一致
 * （金额整数分、价格整数厘、数量整数份/股），因此不引入第二套格式。
 * 只做结构校验：任何缺字段/类型不符/负数一律拒绝，绝不替调用方补默认值。
 */
function parseSnapshotFile(path: string): AccountSnapshot {
  if (!existsSync(path)) throw new Error(`账户快照文件不存在：${path}`);
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: any) {
    throw new Error(`账户快照文件不是合法 JSON：${error?.message ?? error}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('账户快照文件需要是一个 JSON 对象');
  const snapshot = raw as Record<string, any>;

  const text = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`账户快照缺少 ${label}（需要非空字符串）`);
    return value.trim();
  };
  const int = (value: unknown, label: string, allowNegative = false): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`账户快照 ${label} 必须是整数`);
    if (!allowNegative && value < 0) throw new Error(`账户快照 ${label} 不能为负数`);
    return value;
  };

  const snapshotId = text(snapshot.snapshot_id, 'snapshot_id');
  const asOfRaw = text(snapshot.as_of, 'as_of');
  // 只接受两种明确写法；不做"去掉所有短横线"的宽松归一化，避免 16-10-2026 被
  // 误当成 16102026 这样的合法日期。
  let asOfDigits: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) asOfDigits = asOfRaw.replace(/-/g, '');
  else if (/^\d{8}$/.test(asOfRaw)) asOfDigits = asOfRaw;
  else throw new Error(`账户快照 as_of 需要 YYYYMMDD 或 YYYY-MM-DD，收到 ${asOfRaw}`);
  if (!/^\d{8}$/.test(asOfDigits)) throw new Error(`账户快照 as_of 需要 YYYYMMDD 或 YYYY-MM-DD，收到 ${asOfRaw}`);
  const asOf = `${asOfDigits.slice(0, 4)}-${asOfDigits.slice(4, 6)}-${asOfDigits.slice(6, 8)}`;

  if (!Array.isArray(snapshot.positions) || snapshot.positions.length === 0) {
    throw new Error('账户快照 positions 需要是非空数组');
  }
  const positions = snapshot.positions.map((p: any, i: number) => {
    if (!p || typeof p !== 'object') throw new Error(`账户快照 positions[${i}] 不是对象`);
    const quantity = int(p.quantity, `positions[${i}].quantity`);
    const refPrice = int(p.ref_price_milli, `positions[${i}].ref_price_milli`);
    const refCost = int(p.ref_cost_milli, `positions[${i}].ref_cost_milli`);
    if (quantity <= 0) throw new Error(`账户快照 positions[${i}].quantity 必须为正整数`);
    if (refPrice <= 0) throw new Error(`账户快照 positions[${i}].ref_price_milli 必须为正整数（厘）`);
    return {
      ts_code: text(p.ts_code, `positions[${i}].ts_code`),
      name: text(p.name, `positions[${i}].name`),
      quantity,
      ref_price_milli: refPrice,
      ref_cost_milli: refCost,
      market_value_cents: int(p.market_value_cents, `positions[${i}].market_value_cents`),
    };
  });

  const totalsRaw = snapshot.totals;
  if (!totalsRaw || typeof totalsRaw !== 'object') throw new Error('账户快照缺少 totals');
  const totals = {
    total_assets_cents: int(totalsRaw.total_assets_cents, 'totals.total_assets_cents'),
    securities_mv_cents: int(totalsRaw.securities_mv_cents, 'totals.securities_mv_cents'),
    cash_cents: int(totalsRaw.cash_cents, 'totals.cash_cents'),
    wealth_cents: int(totalsRaw.wealth_cents, 'totals.wealth_cents'),
    // 截图浮亏与按成本复算可能有差额（三位小数舍入），允许为负，也允许缺省。
    unrealized_pnl_cents: totalsRaw.unrealized_pnl_cents === undefined || totalsRaw.unrealized_pnl_cents === null
      ? 0 : int(totalsRaw.unrealized_pnl_cents, 'totals.unrealized_pnl_cents', true),
  };

  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.map((w: unknown) => String(w)) : [];
  return {
    snapshot_id: snapshotId,
    as_of: asOf,
    source: text(snapshot.source, 'source'),
    note: typeof snapshot.note === 'string' ? snapshot.note : '',
    warnings,
    // 真实快照的 is_current 由文件声明，但真正写入仍必须经 --confirm-current（见 CLI）。
    is_current: snapshot.is_current === true,
    positions,
    totals,
  };
}

export function runPortfolioCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (runFeeCommand(command, h)) return true;
  switch (command) {
    case 'portfolio-import': {
      const file = h.arg('file');
      const dryRun = h.flag('dry-run');
      const confirmCurrent = h.flag('confirm-current');
      // 无 --file：保留既有演示基线导入（幂等）。
      if (!file) {
        const db = openPortfolioDb(h.arg('db'));
        try {
          const result = importDemoSnapshot(db);
          const reload = readSnapshot(db, DEMO_SNAPSHOT_ID)!;
          h.print({
            ...result,
            db: portfolioDbPath(),
            source: DEMO_SNAPSHOT.source,
            warnings: DEMO_SNAPSHOT.warnings,
            reconciliation: reconcile(reload),
            note: '只导入 PRD §3 截图基线；不写入历史成交、出入金或收益。真实账户请用 --file。',
          });
        } finally {
          db.close();
        }
        return true;
      }

      // 真实快照导入：解析 → （dry-run 只校验/对账）→ 用户确认 → 写入。
      const snapshot = parseSnapshotFile(file);
      if (snapshot.is_current && !confirmCurrent) {
        // 文件声明当前账户，但没有显式确认：拒绝，避免"自认当前"。
        throw new Error(`快照 ${snapshot.snapshot_id} 声明 is_current=true，但缺少 --confirm-current（只能由用户本人确认）`);
      }
      const effective: AccountSnapshot = confirmCurrent ? { ...snapshot, is_current: true } : { ...snapshot, is_current: false };
      const recon = reconcile(effective);

      if (dryRun) {
        h.print({
          dry_run: true,
          file,
          db: portfolioDbPath(),
          snapshot_id: effective.snapshot_id,
          as_of: effective.as_of,
          source: effective.source,
          is_current: effective.is_current,
          positions: effective.positions.length,
          securities_mv: effective.totals.securities_mv_cents / 100,
          cash: effective.totals.cash_cents / 100,
          wealth: effective.totals.wealth_cents / 100,
          total_assets: effective.totals.total_assets_cents / 100,
          reconciliation: recon,
          note: 'dry-run：只解析并逐项对账，未写入任何数据。确认无误后去掉 --dry-run 重新执行。',
        });
        return true;
      }

      const db = openPortfolioDb(h.arg('db'));
      try {
        const before = latestSnapshot(db);
        const result = importSnapshot(db, effective, { confirmCurrent });
        const reload = readSnapshot(db, effective.snapshot_id)!;
        h.print({
          ...result,
          file,
          db: portfolioDbPath(),
          source: effective.source,
          as_of: effective.as_of,
          is_current: effective.is_current,
          warnings: effective.warnings,
          reconciliation: reconcile(reload),
          previous_snapshot: before ? before.snapshot_id : null,
          note: '真实账户快照只落在本地私有账户库；不要把它提交到公开仓库。历史净值/回撤仍需基线之后的账本事件。',
        });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-summary': {
      const db = openReadOnly(h.arg('db'));
      try {
        const snapshot = loadSnapshot(db, h.arg('snapshot'));
        h.print({ summary: accountSummary(snapshot), reconciliation: reconcile(snapshot) });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-mark-current': {
      // 唯一能把快照标记为"当前账户"的路径：必须显式给出确认人；演示基线永远不能。
      const snapshotId = h.arg('snapshot');
      if (!snapshotId) throw new Error('portfolio-mark-current 需要 --snapshot ID');
      const confirmedBy = h.arg('confirmed-by');
      if (!confirmedBy) throw new Error('portfolio-mark-current 需要 --confirmed-by（谁确认的）');
      const db = openPortfolioDb(h.arg('db'));
      try {
        const result = markSnapshotCurrent(db, snapshotId, { confirmedBy });
        h.print({
          ...result,
          db: portfolioDbPath(),
          note: '只有用户确认过的真实快照才能标记为当前账户；此前 is_current=false 的快照只能产出演示（ILLUSTRATIVE）预案。',
        });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-scenario': {
      const action = h.arg('action') ?? 'hold';
      if (action !== 'hold' && action !== 'sell-buy') throw new Error('--action 需要 hold 或 sell-buy');
      const db = openReadOnly(h.arg('db'));
      try {
        h.print(runScenario(db, action, h));
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-decision':
      // 条件化配置比较：候选行情只从只读市场缓存读取（见 decisionCli.ts）。
      return runDecisionCommand(h);
    case 'portfolio-research-summary':
      // 研究模式晚间摘要：只读账户库与市场缓存，输出永远不是 ACTIONABLE。
      return runResearchSummaryCommand(h);
    case 'portfolio-completeness-set': {
      const accountId = requireArg(h, 'account');
      if (!h.flag('confirm')) throw new Error('声明账本完整性需要显式 --confirm（该动作只能由用户本人执行）');
      const db = openPortfolioDb(h.arg('db'));
      try {
        const result = setAccountCompleteness(db, accountId, {
          as_of: h.ymd(requireArg(h, 'as-of'), '--as-of'),
          last_user_reconciled_at: h.arg('last-reconciled-at') ?? null,
          reported_events_through: h.arg('events-through') ? h.ymd(h.arg('events-through')!, '--events-through') : null,
          // --unreported-risk yes|no：缺省保守为「存在未上报交易风险」。
          unreported_trade_risk: (h.arg('unreported-risk') ?? 'yes').toLowerCase() !== 'no',
          note: h.arg('note') ?? '',
        }, { confirm: true, recordedBy: requireArg(h, 'recorded-by') });
        h.print({ ...result, db: portfolioDbPath(), note: '完整性声明只描述"用户已核对到哪个时点"，不代表券商实时余额。' });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-account-list': {
      // C1：私有端点/日报省略 account_id 时使用的默认账户必须是“实际配置的唯一真实账户”。
      // 这里显式列出配置来源，供部署核对与验收使用；只读。
      const db = openReadOnly(h.arg('db'));
      try {
        const accounts = listConfiguredAccounts(db);
        const defaultResolution = (() => {
          try { return resolveAccountId(db, undefined); } catch (error: any) { return { error: error?.message ?? String(error) }; }
        })();
        h.print({
          accounts,
          default_resolution: defaultResolution,
          note: '默认账户解析规则：唯一已确认真实账户 → 用它；多个 → 要求显式 account_id；未知账户 → 拒绝。演示快照只能被显式点名。',
          db: portfolioDbPath(),
        });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-completeness': {
      const accountId = requireArg(h, 'account');
      const db = openReadOnly(h.arg('db'));
      try {
        h.print({ account_id: accountId, completeness: readAccountCompleteness(db, accountId), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-evidence-record': {
      const input = {
        evidence_id: requireArg(h, 'id'),
        kind: h.arg('kind') ?? 'ROTATION',
        buy_code: requireArg(h, 'buy'),
        sell_code: h.arg('sell')?.trim() || null,
        strategy_id: requireArg(h, 'strategy'),
        as_of: h.ymd(requireArg(h, 'as-of'), '--as-of'),
        valid_until: h.arg('valid-until') ? h.ymd(h.arg('valid-until'), '--valid-until') : null,
        status: (h.arg('status') ?? 'PENDING').toUpperCase() as EvidenceStatus,
        recorded_by: requireArg(h, 'recorded-by'),
      };
      if (!EVIDENCE_STATUSES.includes(input.status)) {
        throw new Error(`--status 需要 ${EVIDENCE_STATUSES.join(' / ')}`);
      }
      if (!h.flag('confirm') || h.flag('dry-run')) {
        // dry-run 只打印将要写入的内容，不建表、不写库；confirm 是唯一的写入门。
        h.print({ dry_run: true, would_record: input, note: '未加 --confirm：不写入。确认后由用户本人重新执行并加 --confirm。' });
        return true;
      }
      const db = openPortfolioDb(h.arg('db'));
      try {
        ensureEvidenceSchema(db);
        const result = recordResearchEvidence(db, input, { confirm: true });
        h.print({ ...result, db: portfolioDbPath(), note: '研究证据不代表收益保证；只有状态 VERIFIED 且代码/日期匹配时才可能支持条件化预案。' });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-evidence-revoke': {
      // 受控撤回：不删除、不改写原记录的经济字段，只追加状态变更事件。
      const evidenceId = requireArg(h, 'id');
      const recordedBy = requireArg(h, 'recorded-by');
      if (!h.flag('confirm') || h.flag('dry-run')) {
        h.print({
          dry_run: true,
          would_revoke: evidenceId,
          recorded_by: recordedBy,
          note: '未加 --confirm：不写入。撤回会让该证据立刻不再支持可执行预案，请确认后由用户本人重新执行。',
        });
        return true;
      }
      const db = openPortfolioDb(h.arg('db'));
      try {
        const result = revokeResearchEvidence(db, evidenceId, {
          confirm: true, recordedBy, reason: h.arg('reason') ?? '',
        });
        h.print({ ...result, db: portfolioDbPath(), note: '撤回只改变证据状态；原始记录与历史状态变更均可审计。' });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-evidence-history': {
      const evidenceId = requireArg(h, 'id');
      const db = openReadOnly(h.arg('db'));
      try {
        h.print({ evidence_id: evidenceId, history: readEvidenceStatusHistory(db, evidenceId), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-daily-report': {
      // D1 收盘日报：首屏就是"下一交易日最值得做的 0–3 个动作"。
      // --account 可选：缺省与私有 MCP 同一口径（本部署唯一真实账户），不再落到 'default'。
      const dbPath = h.arg('db') ?? portfolioDbPath();
      if (!existsSync(dbPath)) throw new Error(`账户数据库不存在（${dbPath}），请先运行 finance-ashare portfolio-import`);
      const db = openPortfolioDb(dbPath, { writable: false });
      const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
      try {
        const account = resolveAccountId(db, h.arg('account'));
        const resolved = resolveAccountSnapshot(db, account.account_id, h.arg('snapshot'));
        const asOf = h.arg('date') ? h.ymd(h.arg('date'), '--date') : defaultTradeDate(market, resolved.snapshot);
        const maxActions = intArg(h.arg('max-actions'), '--max-actions');
        const report = buildDailyReport({
          portfolioDb: db,
          marketDb: market,
          accountId: account.account_id,
          accountIdSource: account.source,
          asOfTradeDate: asOf,
          snapshotId: resolved.snapshot_id,
          maxActions: maxActions === undefined ? undefined : maxActions,
        });
        h.print(report);
      } finally {
        market?.close();
        db.close();
      }
      return true;
    }
    case 'portfolio-etf-candidates': {
      // C2 适格 ETF 候选筛选：只读市场缓存，数据缺失时显式 DEGRADED。
      const asOf = h.ymd(requireArg(h, 'date'), '--date');
      const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
      if (!market) throw new Error(`市场缓存不存在（${h.arg('market-db') ?? ashareDbPath()}）`);
      try {
        const categories = h.arg('categories')?.split(',').map(c => c.trim()).filter(Boolean);
        h.print(screenEtfCandidates(market, {
          asOf,
          categories: categories?.length ? categories : undefined,
          limit: intArg(h.arg('limit'), '--limit'),
        }));
      } finally {
        market.close();
      }
      return true;
    }
    case 'portfolio-benchmarks': {
      // C6 事先固定的对照基准（沪深300 ETF / 固定多资产篮子 / 原五只不动）。
      const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
      if (!market) throw new Error(`市场缓存不存在（${h.arg('market-db') ?? ashareDbPath()}）`);
      try {
        h.print(buildBenchmarkComparison({
          marketDb: market,
          start: h.arg('start') ? h.ymd(h.arg('start'), '--start') : undefined,
          end: h.arg('end') ? h.ymd(h.arg('end'), '--end') : undefined,
        }));
      } finally {
        market.close();
      }
      return true;
    }
    case 'portfolio-ledger-init': {
      const accountId = requireArg(h, 'account');
      const asOf = h.ymd(requireArg(h, 'as-of'), '--as-of');
      const db = openPortfolioDb(h.arg('db'));
      try {
        const result = initBaseline(db, accountId, {
          asOf,
          snapshotId: h.arg('snapshot'),
          cashCents: intArg(h.arg('cash'), '--cash'),
          note: h.arg('note') ?? '',
        });
        h.print({
          ...result,
          db: portfolioDbPath(),
          note: '基线是重放起点：此后只追加成交/出入金/分红/费用/公司行动，基线之前的持仓已包含在内，不要再重复录入。',
        });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-record': {
      const accountId = requireArg(h, 'account');
      const db = openPortfolioDb(h.arg('db'));
      try {
        resolveAccountId(db, accountId);
        const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
        let result;
        try { result = recordEvent(db, eventFromArgs(h, accountId), { mode: h.flag('dry-run') ? 'dry_run' : 'live', calendar: market ? settlementCalendarFromDb(market) : undefined }); }
        finally { market?.close(); }
        h.print({ ...result, db: portfolioDbPath(), dry_run: h.flag('dry-run') });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-import': {
      const accountId = requireArg(h, 'account');
      const file = requireArg(h, 'file');
      if (!existsSync(file)) throw new Error(`事件文件不存在：${file}`);
      let parsed: unknown;
      const text = readFileSync(file, 'utf8');
      if (h.arg('format') === 'csv' || /\.csv$/i.test(file)) {
        parsed = parseTradeCsv(text, { accountId, brokerId: h.arg('broker') }).events;
      } else {
        try { parsed = JSON.parse(text); }
        catch (error: any) { throw new Error(`事件文件不是合法 JSON：${error?.message ?? error}`); }
      }
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as any)?.events) ? (parsed as any).events : null;
      if (!list) throw new Error('事件文件需要 JSON events 或券商 CSV');
      const db = openPortfolioDb(h.arg('db'));
      try {
        resolveAccountId(db, accountId);
        const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
        let result;
        try {
          result = importEvents(db, accountId, list as LedgerEventInput[], {
            continueOnConflict: h.flag('continue-on-conflict'),
            mode: h.flag('dry-run') ? 'dry_run' : 'live',
            calendar: market ? settlementCalendarFromDb(market) : undefined,
          });
        } finally { market?.close(); }
        h.print({
          ...result,
          file,
          db: portfolioDbPath(),
          note: result.aborted
            ? '冲突导致整批回滚：账本事件零部分写入；冲突本身已单独留痕。'
            : '重复导入同 id 同内容为 DUPLICATE（不新增行）；同 id 不同内容只写冲突表，不覆盖原记录。',
        });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-replay': {
      const accountId = requireArg(h, 'account');
      const db = openReadOnly(h.arg('db'));
      try {
        h.print({ ...replayAccount(db, accountId, { asOf: h.arg('as-of') ? h.ymd(h.arg('as-of'), '--as-of') : undefined }), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-nav': {
      const accountId = requireArg(h, 'account');
      const from = h.arg('from') ? h.ymd(h.arg('from'), '--from') : undefined;
      const to = h.ymd(requireArg(h, 'to'), '--to');
      const prices = h.arg('prices') ? loadPrices(h.arg('prices')!) : {};
      const db = openReadOnly(h.arg('db'));
      try {
        h.print({ ...buildNavSeries(db, accountId, { from, to, prices }), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-validate': {
      const accountId = requireArg(h, 'account');
      const db = openReadOnly(h.arg('db'));
      try {
        h.print({ ...validateLedger(db, accountId), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    case 'portfolio-ledger-confirm-real': {
      const accountId = requireArg(h, 'account');
      if (!h.flag('confirm')) {
        throw new Error('确认真实账户必须显式给出 --confirm；该动作只能由用户本人执行');
      }
      const db = openPortfolioDb(h.arg('db'));
      try {
        h.print({ ...confirmRealAccount(db, accountId, { confirm: true, note: h.arg('note') ?? '' }), db: portfolioDbPath() });
      } finally {
        db.close();
      }
      return true;
    }
    default:
      return false;
  }
}

/** 供 CLI 与 MCP 共用；所有参数都显式，不读 process.argv。 */
export function runScenario(db: DatabaseSync, action: string, h: PortfolioCliHelpers) {
  const accountId = resolveAccountId(db, h.arg('account')).account_id;
  const original = resolveAccountSnapshot(db, accountId, h.arg('snapshot')).snapshot;
  const tradeDate = h.arg('trade-date') ?? original.as_of.replace(/-/g, '');
  const snapshot = resolveAccountState(db, accountId, tradeDate, h.arg('snapshot')).snapshot;
  const summary = accountSummary(snapshot);
  const accountGate = evaluateAccountStatus(db, original, accountId, tradeDate);

  // 默认只信任服务端只读缓存（--market-db，缺省 ASHARE_DB_PATH）；
  // 只有显式 --mode research 才接受 --sell-price/--buy-price 的自填价格。
  const mode: ScenarioMode = (h.arg('mode') ?? 'server').toLowerCase() === 'research' ? 'research' : 'server';
  const marketPath = h.arg('market-db');
  const market = openMarketCache(marketPath ?? ashareDbPath());

  let bundle;
  try {
    const callerQuotes = new Map<string, EtfQuoteInput>();
    if (mode === 'research') {
      const quoteDate = h.arg('quote-date') ?? tradeDate;
      const sellCode = h.arg('sell');
      const buyCode = h.arg('buy');
      const sellPrice = positiveNumber(h.arg('sell-price'), '--sell-price');
      const buyPrice = positiveNumber(h.arg('buy-price'), '--buy-price');
      if (sellCode && sellPrice !== undefined) callerQuotes.set(sellCode, { trade_date: quoteDate, close: sellPrice, quality: 'READY' });
      if (buyCode && buyPrice !== undefined) callerQuotes.set(buyCode, { trade_date: quoteDate, close: buyPrice, quality: 'READY' });
    }
    bundle = buildScenarioQuotes({
      marketDb: market, asOf: tradeDate,
      sellCode: h.arg('sell'), buyCode: h.arg('buy'), mode, callerQuotes,
    });
  } finally {
    market?.close();
  }

  let scenarioAction: ScenarioAction;
  if (action === 'hold') {
    scenarioAction = { type: 'HOLD' };
  } else {
    const sellCode = h.arg('sell');
    const buyCode = h.arg('buy');
    if (!sellCode || !buyCode) throw new Error('sell-buy 需要 --sell 与 --buy');
    const sharesRaw = h.arg('shares');
    if (!sharesRaw) throw new Error('sell-buy 需要 --shares');
    const sellShares = Number(sharesRaw);
    const kind = (h.arg('buy-kind') ?? 'etf').toUpperCase();
    if (kind !== 'ETF' && kind !== 'STOCK') throw new Error('--buy-kind 需要 etf 或 stock');
    scenarioAction = {
      type: 'SELL_AND_BUY', sell_code: sellCode, sell_shares: sellShares, buy_code: buyCode,
      buy_instrument: { kind, board: h.arg('buy-board') },
    };
  }

  const sourceRaw = (h.arg('advantage-source') ?? '').toUpperCase();
  const advantageRaw = h.arg('advantage');
  const evidence = sourceRaw === '' && advantageRaw === undefined && !h.arg('basis') && !h.arg('evidence-id')
    ? null
    : {
        advantage: advantageRaw === undefined ? true : advantageRaw === 'yes',
        basis: h.arg('basis') ?? '',
        source: sourceRaw === 'RESEARCH_VERIFIED' ? 'RESEARCH_VERIFIED' as const : 'UNVERIFIED' as const,
        evidence_id: h.arg('evidence-id'),
        as_of: h.arg('evidence-as-of'),
      };

  // 只覆盖显式给出的假设值，其余沿用 rules.ts 的默认假设。
  const fees = {
    ...DEFAULT_FEE_RULES,
    ...(h.arg('commission') ? { commission_rate: Number(h.arg('commission')) } : {}),
    ...(h.arg('slippage') ? { slippage_rate_per_side: Number(h.arg('slippage')) } : {}),
  };
  const stress = h.arg('stress')
    ? { ...DEFAULT_STRESS_RULES, shock_pct: Number(h.arg('stress')) }
    : DEFAULT_STRESS_RULES;
  if (!Number.isFinite(fees.commission_rate) || fees.commission_rate < 0) throw new Error('--commission 需要非负数');
  if (!Number.isFinite(fees.slippage_rate_per_side) || fees.slippage_rate_per_side < 0) throw new Error('--slippage 需要非负数');
  if (!Number.isFinite(stress.shock_pct) || stress.shock_pct > 0) throw new Error('--stress 需要非正数（如 -0.10）');

  return {
    ...buildScenario({
      snapshot: summary,
      as_of_trade_date: tradeDate,
      quotes: bundle.quotes,
      action: scenarioAction,
      evidence,
      resolved: bundle.resolved,
      preconditions: [...bundle.preconditions, ...(!accountGate.ok || accountGate.unreported_trade_risk ? [{ code: 'account_not_current' as const, detail: 'Account ledger completeness or verification is insufficient' }] : [])],
      ...(!h.arg('commission') && !h.arg('slippage') ? { fee_context: loadFeeContext(db, accountId, tradeDate) } : {}),
      rules: { fees, stress },
    }),
    quote_mode: bundle.mode,
  };
}
