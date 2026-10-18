import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  DEMO_SNAPSHOT, DEMO_SNAPSHOT_ID, accountSummary, importDemoSnapshot, latestSnapshot, readSnapshot, reconcile,
} from './account.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { buildScenario, type EtfQuoteInput, type ScenarioAction } from './scenario.js';
import { DEFAULT_FEE_RULES, DEFAULT_STRESS_RULES } from './rules.js';

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
  portfolio-scenario --action hold|sell-buy [--db PATH]
        [--sell CODE] [--buy CODE] [--shares N]      静态换仓情景（确定性、只读、不下单）
        [--trade-date YYYYMMDD]                      行情交易日；缺省为最近一个快照 as_of
        [--sell-price X] [--buy-price X]             人为给出的价格（元/份），仅用于离线演示
        [--quote-date YYYYMMDD]                      报价日期；与 --trade-date 不同则标记为过期
        [--advantage yes|no] [--basis TEXT]          候选相对优势证据
        [--buy-kind etf|stock] [--buy-board BOARD]   品种与板块，用于权限检查
        [--stress -0.10] [--commission 0.00025] [--slippage 0.0005]
`;

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
    default:
      return false;
  }
}

/** 供 CLI 与 MCP 共用；所有参数都显式，不读 process.argv。 */
export function runScenario(db: DatabaseSync, action: string, h: PortfolioCliHelpers) {
  const snapshot = loadSnapshot(db, h.arg('snapshot'));
  const summary = accountSummary(snapshot);
  const tradeDate = h.arg('trade-date') ?? snapshot.as_of.replace(/-/g, '');
  const quoteDate = h.arg('quote-date') ?? tradeDate;

  const quotes = new Map<string, EtfQuoteInput>();
  const sellCode = h.arg('sell');
  const buyCode = h.arg('buy');
  const sellPrice = positiveNumber(h.arg('sell-price'), '--sell-price');
  const buyPrice = positiveNumber(h.arg('buy-price'), '--buy-price');
  if (sellCode && sellPrice !== undefined) quotes.set(sellCode, { trade_date: quoteDate, close: sellPrice, quality: 'READY', list_status: 'L' });
  if (buyCode && buyPrice !== undefined) quotes.set(buyCode, { trade_date: quoteDate, close: buyPrice, quality: 'READY', list_status: 'L' });

  let scenarioAction: ScenarioAction;
  if (action === 'hold') {
    scenarioAction = { type: 'HOLD' };
  } else {
    if (!sellCode || !buyCode) throw new Error('sell-buy 需要 --sell 与 --buy');
    const sharesRaw = h.arg('shares');
    if (!sharesRaw) throw new Error('sell-buy 需要 --shares');
    const sellShares = Number(sharesRaw);
    const kind = (h.arg('buy-kind') ?? 'etf').toLowerCase();
    if (kind !== 'etf' && kind !== 'stock') throw new Error('--buy-kind 需要 etf 或 stock');
    scenarioAction = {
      type: 'SELL_AND_BUY', sell_code: sellCode, sell_shares: sellShares, buy_code: buyCode,
      buy_instrument: { kind: kind === 'etf' ? 'ETF' : 'STOCK', board: h.arg('buy-board') },
    };
  }

  const advantageRaw = h.arg('advantage');
  const evidence = advantageRaw === undefined && !h.arg('basis')
    ? null
    : { advantage: advantageRaw === 'yes', basis: h.arg('basis') ?? '' };

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

  return buildScenario({
    snapshot: summary,
    as_of_trade_date: tradeDate,
    quotes,
    action: scenarioAction,
    evidence,
    rules: { fees, stress },
  });
}
