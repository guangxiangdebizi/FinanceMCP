#!/usr/bin/env node
/**
 * 定时任务入口：为真实账户生成收盘研究日报，并写下当日前瞻记录（D5）。
 *
 * 为什么是独立入口而不是塞进 `finance-ashare daily`：
 * - `daily` 是市场数据与股票池的正式流水线，运行在容器内的共享缓存上；
 * - 账户日报读取**独立**的 portfolio.sqlite（宿主机上的 mode 700 目录），并且是唯一
 *   会写研究记录（plan_tracking）的路径。两者生命周期不同，混在一起会让市场日报
 *   的失败牵连账户记录，反之亦然。
 *
 * 约束：
 * - 市场库只读；账户库只在写 plan_tracking 时以可写方式打开；
 * - 只写 plan_tracking，不写 account_event，也不写任何真实成交；
 * - 输出 JSON，失败时非零退出，便于 systemd 记录失败状态。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// CLI 的输出约定：进度走 stderr，结果走 stdout（与 build/ashare/cli.js 一致）。
console.log = (...args) => { if (process.env.ASHARE_VERBOSE) console.error(...args); };

const dataDir = process.env.ASHARE_DATA_DIR
  || process.env.ASHARE_HOST_DATA_DIR
  || join(process.env.HOME ?? '', '.local', 'share', 'finance-mcp-ashare');
process.env.ASHARE_DATA_DIR = dataDir;

const outDir = process.env.ASHARE_ACCOUNT_REPORT_DIR || join(dataDir, 'account-reports');
mkdirSync(outDir, { recursive: true });

const { buildDailyReport } = await import('../../build/portfolio/dailyReport.js');
const { openMarketCache } = await import('../../build/portfolio/quotes.js');
const { ashareDbPath } = await import('../../build/ashare/db.js');
const { recordPlanTracking, planIdFor } = await import('../../build/portfolio/researchRecord.js');
const { resolveAccountId, resolveAccountSnapshot } = await import('../../build/portfolio/accounts.js');
const { openPortfolioDb, portfolioDbPath } = await import('../../build/portfolio/db.js');
const { tradeCalendar } = await import('../../build/portfolio/quotes.js');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const requestedDate = arg('date');
const wantRecord = process.argv.includes('--record');
const marketPath = arg('market-db') || ashareDbPath();
if (!existsSync(marketPath)) {
  console.error(`[account-daily] 市场缓存不存在：${marketPath}`);
  process.exit(2);
}

const market = openMarketCache(marketPath);
// 账户库需要可写：本脚本是唯一写 plan_tracking 的路径（日报生成本身只读）。
const portfolio = openPortfolioDb(portfolioDbPath(), { writable: true });
try {
  const account = resolveAccountId(portfolio, arg('account'));
  const resolved = resolveAccountSnapshot(portfolio, account.account_id, arg('snapshot'));
  const asOf = requestedDate
    ?? tradeCalendar(market).latestTradeDay(new Date().toISOString().slice(0, 10).replace(/-/g, ''))
    ?? resolved.snapshot.as_of.replace(/-/g, '');
  const report = buildDailyReport({
    portfolioDb: portfolio,
    marketDb: market,
    accountId: account.account_id,
    accountIdSource: account.source,
    asOfTradeDate: asOf,
    snapshotId: resolved.snapshot_id,
    generatedAt: new Date().toISOString(),
  });

  let record = null;
  if (wantRecord && report.status !== 'DATA_INSUFFICIENT') {
    // 只有“数据足够、结论可复核”的一天才写入前瞻记录；数据不足日不产生历史判断。
    record = recordPlanTracking({ portfolioDb: portfolio, accountId: account.account_id, report });
  }
  const body = {
    generated_at: new Date().toISOString(),
    account_id: account.account_id,
    account_id_source: account.source,
    as_of_trade_date: asOf,
    status: report.status,
    actionable: report.actionable,
    plan_id: planIdFor(report, account.account_id),
    recorded: record ? record.recorded : false,
    report,
    record,
  };
  const file = join(outDir, `account-daily-${asOf}.json`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify(body, null, 2));
  process.stdout.write(JSON.stringify({
    path: file, as_of_trade_date: asOf, account_id: account.account_id, account_id_source: account.source,
    status: report.status, actionable: report.actionable,
    plan_id: body.plan_id, recorded: body.recorded,
    tiers: report.data_quality.tiers,
  }, null, 2) + '\n');
} catch (error) {
  console.error(`[account-daily] 失败: ${error?.stack || error}`);
  process.exit(1);
} finally {
  market?.close();
  portfolio.close();
}
