import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import { latestSnapshot, readSnapshot } from './account.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { openMarketCache } from './quotes.js';
import { buildResearchSummary } from './researchSummary.js';
import type { PortfolioCliHelpers } from './cli.js';

/**
 * `portfolio-research-summary` 子命令（R2 工作包 B）。
 *
 * 只读：账户库以只读方式打开，市场缓存也只读打开。默认日期取持仓 ETF 的最新
 * bar 日期；没有缓存时退回快照 as_of。输出永远是 JSON，不产生交易数量。
 */

export const RESEARCH_SUMMARY_USAGE = `  portfolio-research-summary --account ID [--date YYYYMMDD] [--snapshot ID]
        [--candidate CODE] [--sell CODE --shares N] [--db PATH] [--market-db PATH] [--json]
        研究模式账户晚间摘要（只读、确定性）：五只 ETF 行情日期/权重/集中度、四类动作的
        客观约束、候选轮动示意与市场支持/反证；永远不是 ACTIONABLE`;

function requireArg(h: PortfolioCliHelpers, name: string): string {
  const value = h.arg(name);
  if (value === undefined || value.trim() === '') throw new Error(`需要 --${name}`);
  return value.trim();
}

function positiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} 需要正整数（${raw}）`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 需要正整数（${raw}）`);
  return value;
}

/** 持仓 ETF 的最新 bar 日期；缓存缺失或没有 bar 时退回快照 as_of。 */
function defaultTradeDate(market: DatabaseSync | null, snapshot: { as_of: string; positions: { ts_code: string }[] }): string {
  if (market) {
    let latest: string | null = null;
    try {
      if (market.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fund_daily'").get()) {
        for (const position of snapshot.positions) {
          const row = market.prepare('SELECT MAX(trade_date) AS d FROM fund_daily WHERE ts_code = ?').get(position.ts_code) as any;
          if (row?.d && (!latest || String(row.d) > latest)) latest = String(row.d);
        }
      }
    } catch {
      // 缓存不可读时由 buildResearchSummary 报 market_cache_unavailable，这里只负责默认日期。
    }
    if (latest) return latest;
  }
  return snapshot.as_of.replace(/-/g, '');
}

export function runResearchSummaryCommand(h: PortfolioCliHelpers): boolean {
  const accountId = requireArg(h, 'account');
  const dbPath = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(dbPath)) throw new Error(`账户数据库不存在（${dbPath}），请先运行 finance-ashare portfolio-import`);

  const snapshotId = h.arg('snapshot');
  const candidateCode = h.arg('candidate');
  const sellCode = h.arg('sell');
  const sellShares = positiveInt(h.arg('shares'), '--shares');
  if ((sellCode === undefined) !== (sellShares === undefined)) {
    throw new Error('--sell 与 --shares 必须同时提供');
  }

  const db = openPortfolioDb(dbPath, { writable: false });
  const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
  try {
    const snapshot = snapshotId ? readSnapshot(db, snapshotId) : latestSnapshot(db);
    if (!snapshot) {
      throw new Error(snapshotId ? `账户快照 ${snapshotId} 不存在` : '账户库中没有任何快照，请先运行 portfolio-import');
    }
    const asOf = h.arg('date') !== undefined
      ? h.ymd(h.arg('date'), '--date')
      : defaultTradeDate(market, snapshot);

    const summary = buildResearchSummary({
      portfolioDb: db,
      marketDb: market,
      accountId,
      asOfTradeDate: asOf,
      snapshotId,
      candidateCode,
      sell: sellCode && sellShares !== undefined ? { code: sellCode, shares: sellShares } : null,
    });
    // 固定输出 JSON；--json 只是显式声明，不改变格式。
    h.print(summary);
  } finally {
    market?.close();
    db.close();
  }
  return true;
}
