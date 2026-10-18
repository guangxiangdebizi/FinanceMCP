import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { accountSummary, latestSnapshot, readSnapshot, reconcile } from './account.js';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled } from './db.js';
import type { EtfQuoteInput, ScenarioAction } from './scenario.js';
import { buildScenario } from './scenario.js';

/**
 * MCP 账户工具实现。与市场工具完全隔离：只打开 `portfolio.sqlite`（只读），
 * 不打开 `ashare.sqlite`，不写任何数据库，不调用外部数据源。
 *
 * 默认关闭（ASHARE_PORTFOLIO_ENABLED=1 才可用）。即使工具不可见，直接调用也会
 * 得到明确拒绝而不是账户数据。
 */

type ToolResult = { content: { type: 'text'; text: string }[] };
const json = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });

const DISABLED = {
  refused: true,
  reason: 'portfolio_tools_disabled',
  message: '账户工具默认关闭。请在受信任的私有部署中设置 ASHARE_PORTFOLIO_ENABLED=1 后再启动服务；公网 ashare_daily profile 不应暴露账户数据。',
};

function readDb(): DatabaseSync {
  if (!portfolioEnabled()) throw new Error(DISABLED.message);
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false });
}

function summaryTool(args: Record<string, any>): ToolResult {
  const db = readDb();
  try {
    const snapshot = args.snapshot_id ? readSnapshot(db, String(args.snapshot_id)) : latestSnapshot(db);
    if (!snapshot) throw new Error('账户库中没有任何快照，请先运行 finance-ashare portfolio-import');
    const body: Record<string, unknown> = {
      summary: accountSummary(snapshot),
      reconciliation: args.include_checks === false ? { ok: reconcile(snapshot).ok, reasons: reconcile(snapshot).reasons } : reconcile(snapshot),
      db: portfolioDbPath(),
    };
    return json(body);
  } finally {
    db.close();
  }
}

function scenarioTool(args: Record<string, any>): ToolResult {
  const db = readDb();
  try {
    const actionRaw = String(args.action ?? 'hold');
    if (actionRaw !== 'hold' && actionRaw !== 'sell-buy') throw new Error('action 需要 hold 或 sell-buy');
    const snapshot = latestSnapshot(db);
    if (!snapshot) throw new Error('账户库中没有任何快照，请先运行 finance-ashare portfolio-import');
    const summary = accountSummary(snapshot);
    const tradeDate = ymdOr(args.as_of_trade_date, snapshot.as_of.replace(/-/g, ''));
    const quoteDate = ymdOr(args.quote_date, tradeDate);

    const quotes = new Map<string, EtfQuoteInput>();
    if (args.sell_code && Number.isFinite(Number(args.sell_price))) {
      quotes.set(String(args.sell_code), {
        trade_date: quoteDate, close: Number(args.sell_price), quality: 'READY',
        list_status: args.sell_list_status ?? 'L', suspended: args.sell_suspended === true,
      });
    }
    if (args.buy_code && Number.isFinite(Number(args.buy_price))) {
      quotes.set(String(args.buy_code), {
        trade_date: quoteDate, close: Number(args.buy_price), quality: 'READY',
        list_status: args.buy_list_status ?? 'L', suspended: args.buy_suspended === true,
      });
    }

    let action: ScenarioAction;
    if (actionRaw === 'hold') {
      action = { type: 'HOLD' };
    } else {
      if (!args.sell_code || !args.buy_code) throw new Error('sell-buy 需要 sell_code 与 buy_code');
      const kind = String(args.buy_kind ?? 'etf').toLowerCase();
      if (kind !== 'etf' && kind !== 'stock') throw new Error('buy_kind 需要 etf 或 stock');
      action = {
        type: 'SELL_AND_BUY',
        sell_code: String(args.sell_code),
        sell_shares: Number(args.sell_shares),
        buy_code: String(args.buy_code),
        buy_instrument: { kind: kind === 'etf' ? 'ETF' : 'STOCK', board: args.buy_board ? String(args.buy_board) : undefined },
      };
    }

    // 缺失的 quotes 由 buildScenario 归一化为 NOT_READY，因此这里不伪造价格。
    return json(buildScenario({
      snapshot: summary,
      as_of_trade_date: tradeDate,
      quotes,
      action,
      evidence: args.advantage === undefined && args.advantage_basis === undefined
        ? null
        : { advantage: args.advantage === true, basis: String(args.advantage_basis ?? '') },
      share_data_available: false,
    }));
  } finally {
    db.close();
  }
}

function ymdOr(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).replace(/-/g, '');
  if (!/^\d{8}$/.test(value)) throw new Error('日期需要 YYYYMMDD 格式');
  return value;
}

export async function runPortfolioTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  if (!portfolioEnabled()) return json(DISABLED);
  switch (name) {
    case 'ashare_portfolio_summary': return summaryTool(args ?? {});
    case 'ashare_portfolio_scenario': return scenarioTool(args ?? {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
