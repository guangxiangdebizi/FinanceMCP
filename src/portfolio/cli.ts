import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import {
  DEMO_SNAPSHOT, DEMO_SNAPSHOT_ID, accountSummary, importDemoSnapshot, latestSnapshot, markSnapshotCurrent, readSnapshot, reconcile,
} from './account.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import {
  buildNavSeries, confirmRealAccount, importEvents, initBaseline, recordEvent, replayAccount, validateLedger,
  type LedgerEventInput, type PriceTable,
} from './ledger.js';
import { buildScenarioQuotes, openMarketCache, type ScenarioMode } from './quotes.js';
import { buildScenario, type EtfQuoteInput, type ScenarioAction } from './scenario.js';
import { DEFAULT_FEE_RULES, DEFAULT_STRESS_RULES } from './rules.js';
import { runDecisionCommand } from './decisionCli.js';

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

  portfolio-import                                   导入 PRD §3 基线快照（幂等，可用 --db PATH 指定账户库）
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
                                                       批量导入 JSON 事件数组；默认冲突即整批回滚
  portfolio-ledger-replay --account ID [--as-of YYYYMMDD] [--db PATH]
                                                       重放持仓/现金/成本/已实现盈亏
  portfolio-ledger-nav --account ID --from YYYYMMDD --to YYYYMMDD [--prices FILE] [--db PATH]
                                                       单位净值序列与基线之后的最大回撤
  portfolio-ledger-validate --account ID [--db PATH]   账本不变量检查（现金/数量/撤销/拆分）
  portfolio-ledger-confirm-real --account ID --confirm 用户显式确认为真实账户（无 --confirm 直接拒绝）
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

export function runPortfolioCommand(command: string, h: PortfolioCliHelpers): boolean {
  switch (command) {
    case 'portfolio-import': {
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
          note: '只导入 PRD §3 截图基线；不写入历史成交、出入金或收益。',
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
        const result = recordEvent(db, eventFromArgs(h, accountId), { mode: h.flag('dry-run') ? 'dry_run' : 'live' });
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
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error: any) {
        throw new Error(`事件文件不是合法 JSON：${error?.message ?? error}`);
      }
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as any)?.events) ? (parsed as any).events : null;
      if (!list) throw new Error('事件文件需要是 JSON 数组，或 {"events": [...]}');
      const db = openPortfolioDb(h.arg('db'));
      try {
        const result = importEvents(db, accountId, list as LedgerEventInput[], {
          continueOnConflict: h.flag('continue-on-conflict'),
          mode: h.flag('dry-run') ? 'dry_run' : 'live',
        });
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
  const snapshot = loadSnapshot(db, h.arg('snapshot'));
  const summary = accountSummary(snapshot);
  const tradeDate = h.arg('trade-date') ?? snapshot.as_of.replace(/-/g, '');

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
      preconditions: bundle.preconditions,
      rules: { fees, stress },
    }),
    quote_mode: bundle.mode,
  };
}
