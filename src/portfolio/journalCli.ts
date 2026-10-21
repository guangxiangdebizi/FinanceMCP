import { existsSync, readFileSync } from 'node:fs';
import { ashareDbPath } from '../ashare/db.js';
import { resolveAccountId } from './accounts.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { openMarketCache } from './quotes.js';
import type { PortfolioCliHelpers } from './cli.js';
import { evaluateResearchJournal, journalFeeEstimator, listResearchJournal, recordJournalEvaluations, recordResearchJournal } from './researchJournal.js';

export const JOURNAL_USAGE = `  portfolio-journal-import --file PATH --confirm [--db PATH]
      导入实际VPS/ChatGPT/综合研究，完整JSON不可变；同ID相同幂等、冲突拒绝
  portfolio-journal-list [--account ID] [--date YYYYMMDD] [--limit N] [--db PATH]
  portfolio-journal-evaluate [--account ID] --date YYYYMMDD [--horizons 5,10,20,60]
      [--record --confirm] [--db PATH] [--market-db PATH]
      固定交易日窗口评估；缺价格/复权/费用/基准即不可用，不伪造真实成交`;

/** Lead registers this helper from portfolio CLI; reads only local JSON and market cache. */
export function runJournalCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (!['portfolio-journal-import', 'portfolio-journal-list', 'portfolio-journal-evaluate'].includes(command)) return false;
  const path = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error('账户库不存在，请先初始化账户');
  const writable = command === 'portfolio-journal-import' || h.flag('record');
  if (writable && !h.flag('confirm')) throw new Error('写研究日志需要 --confirm');
  const db = openPortfolioDb(path, { writable });
  try {
    if (command === 'portfolio-journal-import') {
      const file = h.arg('file');
      if (!file) throw new Error('需要 --file，必须提供实际取得的研究JSON');
      const input = JSON.parse(readFileSync(file, 'utf8'));
      const account = resolveAccountId(db, input.account_id);
      if (account.account_id !== input.account_id) throw new Error('账户标识不匹配');
      h.print(recordResearchJournal(db, input));
      return true;
    }
    const accountId = resolveAccountId(db, h.arg('account')).account_id;
    const asOf = h.arg('date') ? h.ymd(h.arg('date'), '--date') : undefined;
    const limit = h.arg('limit') === undefined ? undefined : Number(h.arg('limit'));
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new Error('--limit requires 1..1000');
    if (command === 'portfolio-journal-list') {
      h.print({ schema: 'research-journal-list/1.0', account_id: accountId, records: listResearchJournal(db, { accountId, asOf, limit }) });
      return true;
    }
    if (!asOf) throw new Error('评估需要 --date YYYYMMDD，不能自行使用未来窗口');
    const horizons = h.arg('horizons')?.split(',').map(Number);
    const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
    try {
      const results = evaluateResearchJournal({ portfolioDb: db, marketDb: market, accountId, asOf, horizons, limit, feeEstimator: journalFeeEstimator(db, market, accountId) });
      h.print({ schema: 'research-journal-evaluations/1.0', account_id: accountId, as_of_trade_date: asOf, evaluations: results, recorded: h.flag('record') ? recordJournalEvaluations(db, results) : null });
    } finally { market?.close(); }
    return true;
  } finally { db.close(); }
}
