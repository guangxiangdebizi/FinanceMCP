#!/usr/bin/env node
// The CLI writes progress to stderr and machine-readable results to stdout. The
// override must run before any module (config.ts logs at import time) is loaded.
console.log = (...args: unknown[]) => { if (process.env.ASHARE_VERBOSE) console.error(...args); };

const USAGE = `用法: finance-ashare <command> [options]

  sync --start YYYYMMDD [--end YYYYMMDD] [--force] [--no-fina]   批量同步区间内的交易日数据
  daily [--date YYYYMMDD]                                        定时任务入口：同步 → 分析 → 发布当日报告
  report --date YYYYMMDD                                         仅基于本地缓存生成指定交易日报告（始终写入研究库，不改动正式数据）
  replay --start YYYYMMDD --end YYYYMMDD                         历史日期重放（研究库 research.sqlite，不改动正式数据）
  evidence [--start YYYYMMDD] [--end YYYYMMDD]                   计算信号历史效果统计（样本内）
  pool-eval --start YYYYMMDD --end YYYYMMDD [--horizon 5] [--research]  股票池历史实际表现（截至 end，研究记录）
  status [--date YYYYMMDD]                                       数据完整性状态
  etf-sync --start YYYYMMDD [--end YYYYMMDD] [--refresh]         同步五只 ETF 的基础信息/日线/复权/份额（独立 fund_* 表）
  etf-status [--date YYYYMMDD]                                   ETF 数据状态（最新日线、逐只就绪度、份额可得性）
  etf-quotes [--codes a,b] [--start YYYYMMDD] [--end YYYYMMDD] [--adjust none|qfq|hfq]
                                                                 ETF 行情快照（含单位换算、复权、份额与质量标记）
  acceptance [--days 3] [--end YYYYMMDD] [--allow-degraded]      连续真实交易日验收（两次定时运行、当日复查行情、最终 READY、MCP 一致、股票池连续）
  quality --date YYYYMMDD                                        重新执行数据质量检查
  audit [--start YYYYMMDD] [--end YYYYMMDD] [--fix]              历史缓存缺口审计（停牌/退市/真实缺口），--fix 只补齐缺失部分
  research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]
                                                                 保存指定交易日的 V1/V2 前瞻研究快照（只读正式库，写入独立研究库）
  research-evaluate --date YYYYMMDD [--db PATH] [--as-of YYYYMMDD] [--horizon 10]
                                                                 用已保存的快照评价持有期收益；未到期保持 PENDING
  research-seed --date YYYYMMDD [--db PATH]                      以该日正式 V1 股票池写入一次性 V1/V2 共同起点（只读正式库）
  migrate                                                        将旧版缓存主键布局迁移为按股票连续存储`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function ymd(value: string | undefined, label: string): string {
  if (!value || !/^\d{8}$/.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  return value;
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const { openAshareDb } = await import('./db.js');
  const { checkQuality, shanghaiToday } = await import('./ingest.js');
  const { syncRange } = await import('./sync.js');
  const command = process.argv[2];
  // Research commands open the live cache read-only themselves and must not
  // create or migrate a writable live connection.
  if (command === 'research-snapshot' || command === 'research-evaluate' || command === 'research-seed') {
    const { runCommand } = await import('./commands.js');
    if (!(await runCommand(undefined as any, command, { arg, flag, ymd, print }))) process.exitCode = 2;
    return;
  }
  const db = openAshareDb();
  switch (command) {
    case 'sync': {
      const start = ymd(arg('start'), '--start');
      const end = arg('end') ? ymd(arg('end'), '--end') : shanghaiToday();
      const summary = await syncRange(db, start, end, { force: flag('force'), fina: !flag('no-fina') });
      print(summary);
      break;
    }
    case 'migrate': {
      const { migrateAshareDb } = await import('./db.js');
      print({ migrated: migrateAshareDb(db) });
      break;
    }
    case 'quality': {
      print(checkQuality(db, ymd(arg('date'), '--date')));
      break;
    }
    default: {
      const { runCommand } = await import('./commands.js');
      if (!command || !(await runCommand(db, command, { arg, flag, ymd, print }))) {
        process.stderr.write(USAGE + '\n');
        process.exitCode = 2;
      }
    }
  }
  db.close();
}

main().catch(error => {
  process.stderr.write(`[ashare] 失败: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
