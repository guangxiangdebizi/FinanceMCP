import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ashareDbPath } from '../ashare/db.js';
import { resolveAccountId } from './accounts.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { openMarketCache } from './quotes.js';
import type { PortfolioCliHelpers } from './cli.js';
import { buildForwardReview } from './forwardReview.js';
import { evaluateResearchJournal, journalFeeEstimator, listResearchJournal, recordJournalEvaluations, recordResearchJournal } from './researchJournal.js';

export const JOURNAL_USAGE = `  portfolio-journal-import --file PATH --confirm [--db PATH]
      导入实际VPS/ChatGPT/综合研究，完整JSON不可变；同ID相同幂等、冲突拒绝
  portfolio-journal-list [--account ID] [--date YYYYMMDD] [--limit N] [--db PATH]
  portfolio-journal-evaluate [--account ID] --date YYYYMMDD [--horizons 5,10,20,60]
      [--record --confirm] [--db PATH] [--market-db PATH]
      固定交易日窗口评估；缺价格/复权/费用/基准即不可用，不伪造真实成交
  portfolio-journal-review [--account ID] [--date YYYYMMDD] [--record --confirm] [--db PATH] [--market-db PATH] [--output-dir DIR]
      前瞻复盘：5/10/20/60日成熟窗口，扣费后相对沪深300/多资产篮子/初始五只ETF；默认日期取行情缓存最新日；
      --record 先追加写入评价再把复盘报告写成不可覆盖的私有文件；2026-10-22 前的记录只计数不入统计`;

/** Lead registers this helper from portfolio CLI; reads only local JSON and market cache. */
export function runJournalCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (!['portfolio-journal-import', 'portfolio-journal-list', 'portfolio-journal-evaluate', 'portfolio-journal-review'].includes(command)) return false;
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
    if (command === 'portfolio-journal-review') {
      const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
      try {
        let date = asOf;
        if (!date) {
          const latest = market?.prepare("SELECT MAX(trade_date) d FROM fund_daily").get() as any;
          if (!latest?.d) throw new Error('行情缓存没有 ETF 日线，无法确定复盘日期');
          date = String(latest.d);
        }
        const horizons = h.arg('horizons')?.split(',').map(Number);
        const feeEstimator = journalFeeEstimator(db, market, accountId);
        const evaluations = evaluateResearchJournal({ portfolioDb: db, marketDb: market, accountId, asOf: date, horizons, feeEstimator });
        const recorded = h.flag('record') ? recordJournalEvaluations(db, evaluations) : null;
        const review = buildForwardReview({ portfolioDb: db, marketDb: market, accountId, asOf: date, horizons, feeEstimator, evaluations });
        let output: string | null = null;
        if (h.flag('record')) {
          const folder = h.arg('output-dir') ?? join(dirname(path), 'forward-reviews');
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          chmodSync(folder, 0o700);
          output = join(folder, `${date}-${review.review_id}.json`);
          // Content-addressed and never overwritten: a changed review is a new file.
          if (!existsSync(output)) writeFileSync(output, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        }
        h.print({ ...review, recorded_evaluations: recorded, private_output: output });
      } finally { market?.close(); }
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
