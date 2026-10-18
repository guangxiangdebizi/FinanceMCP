import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath, getAshareDb } from '../ashare/db.js';
import { accountSummary, latestSnapshot, readSnapshot } from './account.js';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled } from './db.js';
import { buildDecision, type DecisionAction, type DecisionInput, type RotationClaim } from './decision.js';

/**
 * 私有账户工具 `ashare_portfolio_decision` 的实现。
 *
 * 只在已认证的私有端点（`/private/mcp`）或本地 CLI 上可用；与 `portfolio/tools.ts`
 * 分开，避免与并行开发中的账本工具互相覆盖。行情**只**从只读市场缓存读取，
 * 调用方传入的任何价格参数都会被忽略。
 */

type ToolResult = { content: { type: 'text'; text: string }[] };
const json = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });

const DISABLED = {
  refused: true,
  reason: 'portfolio_tools_disabled',
  message: '账户工具默认关闭。请设置 ASHARE_PORTFOLIO_ENABLED=1 或配置 ASHARE_PRIVATE_PORTFOLIO_TOKEN 后再启动服务；公网 /mcp 端点永远不暴露账户数据。',
};

function readDb(): DatabaseSync {
  if (!portfolioEnabled()) throw new Error(DISABLED.message);
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false });
}

/** 只读市场缓存；缺失或结构过旧时返回 null（工具会给出 DATA_INSUFFICIENT，而不是抛异常）。 */
export function readOnlyMarketCache(): DatabaseSync | null {
  try {
    if (!existsSync(ashareDbPath())) return null;
    return getAshareDb();
  } catch {
    return null;
  }
}

function ymd(raw: unknown, label: string, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).replace(/-/g, '');
  if (!/^\d{8}$/.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  return value;
}

/** 把 MCP 参数映射成 DecisionInput。任何价格参数都不会被读取。 */
export function decisionInputFromArgs(args: Record<string, any>, db: DatabaseSync, market: DatabaseSync | null): DecisionInput {
  const snapshot = args.snapshot_id ? readSnapshot(db, String(args.snapshot_id)) : latestSnapshot(db);
  if (!snapshot) throw new Error('账户库中没有任何快照，请先运行 finance-ashare portfolio-import');
  const summary = accountSummary(snapshot);
  const asOf = ymd(args.as_of_trade_date, 'as_of_trade_date', snapshot.as_of.replace(/-/g, ''));
  const actionRaw = String(args.action ?? 'hold');

  let action: DecisionAction;
  if (actionRaw === 'hold') {
    action = { type: 'HOLD' };
  } else if (actionRaw === 'no-action') {
    action = { type: 'NO_ACTION', reason: args.reason ? String(args.reason) : undefined };
  } else if (actionRaw === 'reduce') {
    if (!args.sell_code) throw new Error('reduce 需要 sell_code');
    action = { type: 'REDUCE_EQUITY', sell_code: String(args.sell_code), sell_shares: Number(args.sell_shares) };
  } else if (actionRaw === 'sell-buy') {
    if (!args.sell_code || !args.buy_code) throw new Error('sell-buy 需要 sell_code 与 buy_code');
    const kind = String(args.buy_kind ?? 'etf').toLowerCase();
    if (kind !== 'etf' && kind !== 'stock') throw new Error('buy_kind 需要 etf 或 stock');
    action = {
      type: 'SELL_AND_BUY', sell_code: String(args.sell_code), sell_shares: Number(args.sell_shares),
      buy_code: String(args.buy_code), buy_kind: kind === 'stock' ? 'STOCK' : 'ETF',
    };
  } else {
    throw new Error('action 需要 hold、reduce、sell-buy 或 no-action');
  }

  const sourceRaw = String(args.advantage_source ?? '').toUpperCase();
  let evidence: RotationClaim | null = null;
  if (args.advantage_claim || args.advantage_source) {
    if (sourceRaw !== 'RESEARCH_VERIFIED' && sourceRaw !== 'UNVERIFIED') {
      throw new Error('advantage_source 需要 RESEARCH_VERIFIED 或 UNVERIFIED（不接受布尔值优势标记）');
    }
    evidence = {
      claim: String(args.advantage_claim ?? ''),
      source: sourceRaw as RotationClaim['source'],
      evidence_id: args.advantage_evidence_id ? String(args.advantage_evidence_id) : undefined,
      as_of: args.advantage_as_of ? ymd(args.advantage_as_of, 'advantage_as_of', asOf) : undefined,
    };
  }

  const stockPlan = args.stock_invalidation_price !== undefined
    ? {
        ts_code: String(args.stock_code ?? args.buy_code ?? ''),
        quantity: args.stock_quantity !== undefined ? Number(args.stock_quantity) : undefined,
        invalidation_milli: Math.round(Number(args.stock_invalidation_price) * 1000),
      }
    : null;

  return {
    account_id: String(args.account_id ?? 'default'),
    snapshot: summary,
    as_of_trade_date: asOf,
    market_db: market,
    // 私有端点传入的只读账户库：证据校验与真实账户门控都依赖它。
    portfolio_db: db,
    action,
    evidence,
    stock_plan: stockPlan,
  };
}

export async function runDecisionTool(args: Record<string, any>): Promise<ToolResult> {
  if (!portfolioEnabled()) return json(DISABLED);
  const db = readDb();
  try {
    const input = decisionInputFromArgs(args ?? {}, db, readOnlyMarketCache());
    return json(buildDecision(input));
  } finally {
    db.close();
  }
}
