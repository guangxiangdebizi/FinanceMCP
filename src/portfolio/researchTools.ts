import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath, getAshareDb } from '../ashare/db.js';
import { resolveAccountId, resolveAccountSnapshot } from './accounts.js';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled } from './db.js';
import { buildDailyReport } from './dailyReport.js';
import { buildBenchmarkComparison } from './benchmarks.js';
import { screenEtfCandidates } from '../ashare/etfUniverse.js';

/**
 * 私有账户端点的"研究/日报"工具实现（V1.0 C2/C6/D1）。
 *
 * 与 `portfolio/tools.ts`、`decisionTool.ts` 一致的边界：
 * - 账户库只读；市场库只读；不写任何数据库，不访问网络。
 * - 不暴露写路径：成交录入、证据写入、完整性声明只能走本地 CLI。
 * - 市场缓存缺失时返回结构化的 DATA_INSUFFICIENT，不抛异常给客户端。
 */

type ToolResult = { content: { type: 'text'; text: string }[] };
const json = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });

const DISABLED = {
  refused: true,
  reason: 'portfolio_tools_disabled',
  message: '账户工具默认关闭。请设置 ASHARE_PRIVATE_PORTFOLIO_TOKEN 后再启动服务；公网 /mcp 端点永远不暴露账户数据。',
};

function readDb(): DatabaseSync {
  if (!portfolioEnabled()) throw new Error(DISABLED.message);
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false });
}

/** 只读市场缓存；缺失时返回 null，由调用方降级。
 *
 * 注意：这是**进程级共享**连接（`getAshareDb()`）。调用方**不得**关闭它——关闭会让
 * 公网 /mcp 的九个市场工具全部报 "database is not open"，直到进程重启。
 */
function readOnlyMarket(): DatabaseSync | null {
  try {
    if (!existsSync(ashareDbPath())) return null;
    return getAshareDb();
  } catch {
    return null;
  }
}

function ymd(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).replace(/-/g, '');
  if (!/^\d{8}$/.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  return value;
}

function latestTradeDayOf(market: DatabaseSync | null): string | undefined {
  if (!market) return undefined;
  try {
    const row = market.prepare("SELECT MAX(cal_date) AS d FROM trade_cal WHERE is_open = 1 AND cal_date <= ?")
      .get(new Date().toISOString().slice(0, 10).replace(/-/g, '')) as any;
    return row?.d ?? undefined;
  } catch {
    return undefined;
  }
}

export function runPortfolioResearchTool(name: string, args: Record<string, any>): ToolResult {
  switch (name) {
    case 'ashare_portfolio_daily_report': {
      const db = readDb();
      const market = readOnlyMarket();
      try {
        // 账户身份与持仓快照一起解析：缺省 account_id 指向本部署唯一的真实账户，
        // 且不再静默使用演示快照（C1）。
        const account = resolveAccountId(db, args.account_id);
        const resolved = resolveAccountSnapshot(db, account.account_id, args.snapshot_id);
        const snapshot = resolved.snapshot;
        const asOf = ymd(args.as_of_trade_date, 'as_of_trade_date')
          ?? latestTradeDayOf(market)
          ?? snapshot.as_of.replace(/-/g, '');
        const rawMax = args.max_actions;
        const maxActions = rawMax === undefined || rawMax === null ? undefined : Number(rawMax);
        if (maxActions !== undefined && (!Number.isInteger(maxActions) || maxActions < 0 || maxActions > 3)) {
          throw new Error('max_actions 需要 0–3 的整数');
        }
        const categories = Array.isArray(args.categories)
          ? args.categories.map(String)
          : args.categories ? [String(args.categories)] : undefined;
        const report = buildDailyReport({
          portfolioDb: db,
          marketDb: market,
          accountId: account.account_id,
          accountIdSource: account.source,
          asOfTradeDate: asOf,
          snapshotId: resolved.snapshot_id,
          maxActions,
          categories,
        });
        return json(report);
      } finally {
        // 只关闭账户库；市场缓存是共享连接，关闭会让公网市场工具全部失效。
        db.close();
      }
    }

    case 'ashare_etf_candidates': {
      const market = readOnlyMarket();
      try {
        const asOf = ymd(args.as_of_trade_date, 'as_of_trade_date') ?? latestTradeDayOf(market);
        if (!asOf) {
          return json({
            schema: 'ashare-etf-candidate-screen/1.0',
            status: 'DATA_INSUFFICIENT',
            reason: 'market_cache_or_calendar_unavailable',
            detail: '本地只读市场缓存或交易日历不可用，无法确定候选筛选的交易日；不伪造 as_of。',
          });
        }
        const categories = Array.isArray(args.categories)
          ? args.categories.map(String)
          : args.categories ? [String(args.categories)] : undefined;
        const limit = args.limit === undefined || args.limit === null ? undefined : Number(args.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new Error('limit 需要正整数');
        }
        return json(screenEtfCandidates(market, { asOf, categories, limit }));
      } finally {
        // 共享连接不关闭（见 readOnlyMarket 注释）。
      }
    }

    case 'ashare_portfolio_benchmarks': {
      const market = readOnlyMarket();
      try {
        return json(buildBenchmarkComparison({
          marketDb: market,
          start: ymd(args.start_date, 'start_date'),
          end: ymd(args.end_date, 'end_date'),
        }));
      } finally {
        // 共享连接不关闭（见 readOnlyMarket 注释）。
      }
    }

    default:
      throw new Error(`Unknown research tool: ${name}`);
  }
}

/** 供 dispatch.ts 判断一个私有工具是否由本模块实现。 */
export const RESEARCH_PRIVATE_TOOLS = new Set([
  'ashare_portfolio_daily_report',
  'ashare_etf_candidates',
  'ashare_portfolio_benchmarks',
]);
