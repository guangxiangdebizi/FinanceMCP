import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import { accountSummary } from './account.js';
import { resolveAccountId, resolveAccountSnapshot } from './accounts.js';
import { trustedEvidencePolicy } from './trustedEvidence.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { buildDecision, type DecisionAction, type RotationClaim } from './decision.js';
import type { PortfolioCliHelpers } from './cli.js';

/**
 * `portfolio-decision` 子命令（工作包 C）。
 *
 * 只读：账户库以只读方式打开，市场缓存也只读打开；任何价格都不接受命令行输入，
 * 候选行情必须来自 `--market-db` 指向的缓存（缺省为 ASHARE_DB_PATH）。
 */

export const DECISION_USAGE = `  portfolio-decision --account ID --action hold|reduce|sell-buy|no-action [--db PATH]
        [--snapshot ID] [--trade-date YYYYMMDD] [--market-db PATH]
        [--sell CODE --shares N] [--buy CODE --buy-kind etf|stock]
        [--advantage-source RESEARCH_VERIFIED|UNVERIFIED --advantage-claim TEXT --evidence-id ID]
        [--stock-code CODE --stock-quantity N --stock-invalidation 元]
        条件化配置比较（只读、确定性）：候选行情只来自服务端缓存，不接受自填价格`;

function requireArg(h: PortfolioCliHelpers, name: string): string {
  const value = h.arg(name);
  if (value === undefined || value === '') throw new Error(`需要 --${name}`);
  return value;
}

function openPortfolioReadOnly(path: string | undefined): DatabaseSync {
  const target = path ?? portfolioDbPath();
  if (!existsSync(target)) throw new Error(`账户数据库不存在（${target}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(target, { writable: false });
}

/** 只读打开市场缓存；不存在时返回 null，由 buildDecision 给出 DATA_INSUFFICIENT。 */
function openMarketReadOnly(path: string | undefined): DatabaseSync | null {
  const target = path ?? ashareDbPath();
  if (!existsSync(target)) return null;
  return new DatabaseSync(target, { readOnly: true });
}

export function runDecisionCommand(h: PortfolioCliHelpers): boolean {
  const requestedAccountId = h.arg('account');
  const actionRaw = h.arg('action') ?? 'hold';
  const snapshotId = h.arg('snapshot');

  const db = openPortfolioReadOnly(h.arg('db'));
  let market: DatabaseSync | null = null;
  try {
    const accountId = resolveAccountId(db, requestedAccountId).account_id;
    const snapshot = resolveAccountSnapshot(db, accountId, snapshotId).snapshot;
    if (!snapshot) throw new Error(snapshotId ? `账户快照 ${snapshotId} 不存在` : '账户库中没有任何快照，请先运行 portfolio-import');
    const summary = accountSummary(snapshot);
    const asOf = h.arg('trade-date') ? h.ymd(h.arg('trade-date'), '--trade-date') : snapshot.as_of.replace(/-/g, '');

    let action: DecisionAction;
    if (actionRaw === 'hold') {
      action = { type: 'HOLD' };
    } else if (actionRaw === 'no-action') {
      action = { type: 'NO_ACTION', reason: h.arg('reason') };
    } else if (actionRaw === 'reduce') {
      action = { type: 'REDUCE_EQUITY', sell_code: requireArg(h, 'sell'), sell_shares: Number(requireArg(h, 'shares')) };
    } else if (actionRaw === 'sell-buy') {
      const kind = (h.arg('buy-kind') ?? 'etf').toLowerCase();
      if (kind !== 'etf' && kind !== 'stock') throw new Error('--buy-kind 需要 etf 或 stock');
      action = {
        type: 'SELL_AND_BUY', sell_code: requireArg(h, 'sell'), sell_shares: Number(requireArg(h, 'shares')),
        buy_code: requireArg(h, 'buy'), buy_kind: kind === 'stock' ? 'STOCK' : 'ETF',
      };
    } else {
      throw new Error('--action 需要 hold、reduce、sell-buy 或 no-action');
    }

    const sourceRaw = (h.arg('advantage-source') ?? '').toUpperCase();
    let evidence: RotationClaim | null = null;
    if (sourceRaw || h.arg('advantage-claim')) {
      if (sourceRaw !== 'RESEARCH_VERIFIED' && sourceRaw !== 'UNVERIFIED') {
        throw new Error('--advantage-source 需要 RESEARCH_VERIFIED 或 UNVERIFIED（不接受布尔值优势标记）');
      }
      evidence = {
        claim: h.arg('advantage-claim') ?? '',
        source: sourceRaw as RotationClaim['source'],
        evidence_id: h.arg('evidence-id'),
        as_of: h.arg('evidence-as-of') ? h.ymd(h.arg('evidence-as-of'), '--evidence-as-of') : undefined,
      };
    }

    const invalidation = h.arg('stock-invalidation');
    const stockPlan = invalidation !== undefined
      ? {
          ts_code: h.arg('stock-code') ?? h.arg('buy') ?? '',
          quantity: h.arg('stock-quantity') !== undefined ? Number(h.arg('stock-quantity')) : undefined,
          invalidation_milli: Math.round(Number(invalidation) * 1000),
        }
      : null;

    market = openMarketReadOnly(h.arg('market-db'));
    h.print(buildDecision({
      account_id: accountId,
      snapshot: summary,
      as_of_trade_date: asOf,
      market_db: market,
      // 研究证据与真实账户门控只从独立账户库复核；没有它一律不可执行。
      portfolio_db: db,
      trusted_evidence_policy: trustedEvidencePolicy(),
      action,
      evidence,
      stock_plan: stockPlan,
    }));
  } finally {
    market?.close();
    db.close();
  }
  return true;
}
