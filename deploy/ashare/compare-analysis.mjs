#!/usr/bin/env node
// Analysis-output regression between two builds on the same cache copy.
// Each build writes research-only reports (report --date → research DB of its own) for the given dates,
// then the deterministic parts (scores, watchlist, market, sectors, signals) are dumped for comparison.
// Usage: ASHARE_DATA_DIR=<copy> node compare-analysis.mjs <buildDir> <researchDb> <out.json> YYYYMMDD...
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [buildDir, researchDb, outPath, ...dates] = process.argv.slice(2);
if (!process.env.ASHARE_DATA_DIR || /finance-mcp-ashare\/?$/.test(resolve(process.env.ASHARE_DATA_DIR))) {
  throw new Error('ASHARE_DATA_DIR must point at a copy of the cache');
}
process.env.ASHARE_RESEARCH_DB_PATH = resolve(researchDb);
console.log = () => {};
const mod = p => import(resolve(buildDir, 'build/ashare', p));
const { openAshareDb, openResearchDb } = await mod('db.js');
const { runCommand } = await mod('commands.js');
const { loadReport } = await mod('report.js');

const db = openAshareDb();
const out = {};
for (const date of dates) {
  const sink = [];
  await runCommand(db, 'report', { arg: n => ({ date })[n], flag: () => false, ymd: v => v, print: v => sink.push(v) });
  const rdb = openResearchDb();
  const meta = rdb.prepare('SELECT * FROM report WHERE report_id = ?').get(sink[0].report_id);
  const r = loadReport(meta);
  out[date] = {
    status: r.status,
    scores: rdb.prepare('SELECT ts_code, score, rank, detail FROM stock_score WHERE trade_date = ? ORDER BY ts_code').all(date),
    watchlist: r.watchlist?.members.map(m => ({ ts_code: m.ts_code, score: m.score, rank: m.rank, signals: m.signals_today.map(s => s.id), fundamentals: m.fundamentals, risks: m.risks })),
    market: r.market,
    sectors: r.sectors?.all,
    signals: r.signals?.market_summary.map(s => ({ id: s.id, count: s.market_count, evidence: s.evidence })),
  };
  rdb.close();
}
db.close();
writeFileSync(outPath, JSON.stringify(out));
console.error(`wrote ${outPath}`);
