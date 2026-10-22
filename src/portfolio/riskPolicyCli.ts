import { existsSync } from 'node:fs';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { resolveAccountId } from './accounts.js';
import { APPROVED_ON, buildPortfolioRiskState, loadActiveRiskPolicy, recordRiskPolicy } from './riskPolicy.js';
import type { PortfolioCliHelpers } from './cli.js';

export const RISK_POLICY_USAGE = `  portfolio-risk-policy-set --account ID --source TEXT [--approved-on YYYYMMDD] --confirm [--db PATH]
                                                       记录用户已批准的组合回撤政策（10/15/20%，仅限本地管理员；无 MCP 写工具）
  portfolio-risk-policy-show --account ID [--date YYYYMMDD] [--db PATH]
                                                       查看有效政策及当前回撤状态（只读）`;

export function runRiskPolicyCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (command !== 'portfolio-risk-policy-set' && command !== 'portfolio-risk-policy-show') return false;
  const path = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error('Account database must already exist');
  const write = command === 'portfolio-risk-policy-set';
  if (write && !h.flag('confirm')) throw new Error('记录风险政策需要显式 --confirm（只能由用户本人授权）');
  const db = openPortfolioDb(path, { writable: write });
  try {
    const accountId = resolveAccountId(db, h.arg('account')).account_id;
    if (write) {
      const source = h.arg('source');
      if (!source) throw new Error('--source 必填（批准来源）');
      const approvedOn = h.arg('approved-on') ? h.ymd(h.arg('approved-on'), '--approved-on') : APPROVED_ON;
      h.print(recordRiskPolicy(db, { account_id: accountId, approval_source: source, approved_on: approvedOn }));
    } else {
      const date = h.arg('date') ? h.ymd(h.arg('date'), '--date') : '99991231';
      const policy = loadActiveRiskPolicy(db, accountId, date);
      h.print({ policy, state: policy && date !== '99991231' ? buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId, asOf: date }) : null });
    }
  } finally { db.close(); }
  return true;
}
