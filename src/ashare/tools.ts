import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ashareDbPath, getAshareDb } from './db.js';
import { checkQuality, CORE_INDICES, isTradeDay, latestTradeDay, recentTradeDays, shanghaiToday } from './ingest.js';
import { latestReportMeta, loadReport } from './report.js';
import { forEachStockBars } from './bars.js';
import { computeIndicators, INDICATOR_VERSION } from './indicators.js';
import { detectSignals, SIGNAL_BY_ID, technicalState } from './signals.js';
import { fundamentalRisk, fundamentalsAsOf } from './fundamentals.js';
import { loadVerdicts } from './evidence.js';
import { financialHistory, marketData, resolveCode, stockBasic, stockHistory } from './data.js';
import { factorSnapshot } from './engine.js';
import { etfQuotes, etfStatus } from './etf.js';
import { resolveResearchDate } from './researchDate.js';

export { ashareToolDefinitions, ASHARE_TOOL_NAMES } from './definitions.js';

type ToolResult = { content: { type: 'text'; text: string }[] };

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });
const json = (body: unknown): ToolResult => text(JSON.stringify(body));
const fmt = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : v == null ? '-' : String(v));

function resolveDate(db: DatabaseSync, raw: unknown): { date: string; note?: string } {
  if (raw != null && raw !== '') {
    const value = String(raw).replace(/-/g, '');
    if (!/^\d{8}$/.test(value)) throw new Error('date 需要 YYYYMMDD 格式');
    return { date: value };
  }
  const session = resolveResearchDate(db);
  if (!session.as_of_trade_date) {
    const last = latestTradeDay(db, shanghaiToday());
    if (!last) throw new Error('交易日历为空，请先运行 finance-ashare sync');
    return { date: last, note: `当前日期交易日历缺失，仅返回历史交易日 ${last}，不构成今日数据就绪声明` };
  }
  return { date: session.as_of_trade_date,
    ...(session.phase === 'PRE_CLOSE' ? { note: `当前交易日尚未收盘，使用最近已收盘交易日 ${session.as_of_trade_date}` }
      : session.phase === 'NON_TRADING_DAY' ? { note: `今天 ${session.shanghai_date} 非交易日，使用最近交易日 ${session.as_of_trade_date}` } : {}),
  };
}

function db(): DatabaseSync {
  if (!existsSync(ashareDbPath())) throw new Error(`A股缓存不存在（${ashareDbPath()}），请先运行 finance-ashare sync`);
  return getAshareDb();
}


// ---------------------------------------------------------------- status

function dataStatus(args: Record<string, any>): ToolResult {
  const d = db();
  const { date, note } = resolveDate(d, args.date);
  const quality = checkQuality(d, date, false);
  const days = recentTradeDays(d, date, 5);
  const recent = days.map(day => {
    const row = d.prepare('SELECT status, detail FROM quality_check WHERE trade_date = ?').get(day) as any;
    const q = row ? JSON.parse(row.detail) : checkQuality(d, day, false);
    return { trade_date: day, status: q.status, daily: q.counts.daily, daily_basic: q.counts.daily_basic, adj_factor: q.counts.adj_factor };
  });
  const latestDaily = (d.prepare('SELECT MAX(trade_date) d FROM daily').get() as any).d;
  const fina = d.prepare('SELECT key period, rows, synced_at FROM sync_log WHERE dataset = \'fina_indicator\' ORDER BY key DESC LIMIT 4').all();
  const lastSync = d.prepare('SELECT dataset, MAX(synced_at) synced_at FROM sync_log GROUP BY dataset ORDER BY dataset').all() as any[];
  const report = latestReportMeta(d, date);
  const latestReady = latestReportMeta(d, undefined, true, date);
  const evidence = loadVerdicts(d, date).meta;
  const auditRow = d.prepare('SELECT audit_id, created_at, start_date, end_date, status, summary FROM data_audit ORDER BY created_at DESC LIMIT 1').get() as any;
  const latestAudit = auditRow ? { ...auditRow, summary: JSON.parse(auditRow.summary) } : null;
  const status = {
    as_of_trade_date: date,
    note,
    quality,
    recent_days: recent,
    latest_daily_in_cache: latestDaily,
    core_indices: CORE_INDICES,
    fina_indicator_periods: fina,
    last_sync: lastSync,
    report_for_date: report ?? null,
    latest_ready_report: latestReady ?? null,
    evidence_window: evidence,
    latest_audit: latestAudit,
  };
  const lines = [
    `# A股数据状态 ${date}`,
    note ? `> ${note}` : '',
    `- 数据质量：**${quality.status}**${quality.reasons.length ? `（${quality.reasons.join('；')}）` : ''}`,
    `- 日线 ${quality.counts.daily} 条（前一交易日 ${quality.counts.prev_daily}），每日指标覆盖 ${quality.coverage.daily_basic_vs_daily}，复权因子覆盖 ${quality.coverage.adj_factor_vs_daily}`,
    `- 核心指数：${quality.indices_present.join(', ') || '无'}`,
    `- 缓存快照：${quality.snapshot.mixed ? quality.snapshot.note : `各数据集同一批次获取（相差 ${quality.snapshot.spread_minutes ?? '-'} 分钟）`}`,
    `- 最近一次历史缓存审计：${latestAudit ? `${latestAudit.audit_id}（${latestAudit.start_date}~${latestAudit.end_date}，${latestAudit.status}）` : '无'}`,
    `- 缓存最新日线：${latestDaily}`,
    `- 当日报告：${report ? `${report.report_id}（${report.status}，${report.generated_at}）` : '尚未发布'}`,
    `- 最近可用报告：${latestReady ? `${latestReady.report_id}（${latestReady.trade_date}）` : '无'}`,
    '',
    '```json',
    JSON.stringify(status, null, 2),
    '```',
  ];
  return text(lines.filter(l => l !== '').join('\n'));
}

// ---------------------------------------------------------------- report

function notReadyText(date: string, reasons: string[], extra = ''): string {
  return [
    `# A股日报 ${date}：NOT_READY`,
    '',
    '核心数据缺失，本次不生成市场判断、股票池或交易建议，也不使用前一交易日数据替代。',
    '',
    ...reasons.map(r => `- ${r}`),
    extra,
  ].join('\n');
}

function reportMarkdown(r: any): string {
  if (r.status === 'NOT_READY') {
    const last = r.not_ready?.latest_ready_report;
    return notReadyText(r.as_of_trade_date, r.not_ready?.reasons ?? [],
      `\n报告ID：${r.report_id}｜生成时间：${r.generated_at}` + (last ? `\n最近可用报告（仅供参考，非今日数据）：${last.report_id}（${last.trade_date}）` : ''));
  }
  const m = r.market;
  const w = r.watchlist;
  const out: string[] = [
    `# A股日报 ${r.as_of_trade_date}（${r.status}）`,
    '',
    `报告ID：\`${r.report_id}\`｜生成：${r.generated_at}｜规则版本：${Object.entries(r.versions).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `数据完整性：日线 ${r.data.quality.counts.daily} 条，每日指标覆盖 ${r.data.quality.coverage.daily_basic_vs_daily}，复权因子覆盖 ${r.data.quality.coverage.adj_factor_vs_daily}${r.data.quality.reasons.length ? `；提示：${r.data.quality.reasons.join('；')}` : ''}`,
    '',
    `## 市场环境：${m.regime_label}（${m.tone}）`,
    ...m.judgement.map((p: string) => `- ${p}`),
    '',
    '| 指数 | 收盘 | 涨跌% | 5日% | 20日% | 成交额(亿) | >MA20 | >MA60 |',
    '|---|---|---|---|---|---|---|---|',
    ...m.indices.map((i: any) => `| ${i.name} | ${fmt(i.close)} | ${fmt(i.pct_chg)} | ${fmt(i.ret5)} | ${fmt(i.ret20)} | ${fmt(i.amount_yi, 0)} | ${i.above_ma20 ? '是' : '否'} | ${i.above_ma60 ? '是' : '否'} |`),
    '',
    `## 行业强弱`,
    `强势：${r.sectors.top.map((s: any) => `${s.industry}(20日${fmt(s.ret20_median_pct, 1)}%)`).join('、')}`,
    `弱势：${r.sectors.bottom.map((s: any) => `${s.industry}(20日${fmt(s.ret20_median_pct, 1)}%)`).join('、')}`,
    '',
    `## 股票池（${w.count} 只，候选 ${w.eligible_universe} 只；上一期 ${w.previous_date ?? '无'}）`,
    `新增：${w.added.map((c: any) => `${c.name}(${c.reason})`).join('；') || '无'}`,
    `移出：${w.removed.map((c: any) => `${c.name}(${c.reason})`).join('；') || '无'}`,
    `行业分布：${Object.entries(w.industry_distribution).map(([k, v]) => `${k}${v}`).join('、')}`,
    w.track_record?.dates
      ? `历史实际表现（研究记录，非预测）：近 ${w.track_record.dates} 个池日期，5 日超额均值 ${w.track_record.mean_excess_pct}%，跑赢比例 ${(w.track_record.hit_rate * 100).toFixed(0)}%。${w.track_record.note}`
      : '历史实际表现：样本不足',
    '',
    '| 代码 | 名称 | 行业 | 收盘 | 涨跌% | 评分 | 排名 | 状态 | 趋势 | RSI14 | 今日信号 | 风险 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...w.members.map((s: any) => `| ${s.ts_code} | ${s.name} | ${s.industry} | ${fmt(s.close)} | ${fmt(s.pct_chg)} | ${fmt(s.score, 1)} | ${s.rank} | ${s.status === 'new' ? '新增' : '保留'} | ${s.technical.trend} | ${fmt(s.technical.rsi14, 0)} | ${s.signals_today.map((g: any) => g.name).join('/') || '-'} | ${s.risks.join('；') || '-'} |`),
    '',
    '## 信号（全市场触发数）与证据分类',
    `> 证据分类均为样本内统计：evidence_supported 仅表示样本内方向性证据（收益窗口重叠、多重检验未校正），不代表策略有效或未来收益。`,
    ...r.signals.market_summary.map((g: any) => `- **${g.name}** ×${g.market_count}｜${g.evidence}（${g.evidence_basis}）｜触发：${g.trigger}｜失效：${g.invalidation}｜风险：${g.risk}`),
    '',
    `## 风险`,
    ...r.risks.map((x: string) => `- ${x}`),
    '',
    `> ${r.disclaimer}`,
  ];
  return out.join('\n');
}

function dailyReport(args: Record<string, any>): ToolResult {
  const d = db();
  const { date, note } = resolveDate(d, args.date);
  const meta = latestReportMeta(d, date);
  if (!meta) {
    const q = checkQuality(d, date, false);
    if (q.status === 'NOT_READY') return text(notReadyText(date, q.reasons, note ? `\n> ${note}` : ''));
    return text(`# A股日报 ${date}：PENDING\n\n数据检查为 ${q.status}，但定时任务尚未发布该交易日报告。请稍后重试或运行 \`finance-ashare report --date ${date}\`。`);
  }
  const report = loadReport(meta);
  if (args.format === 'json') return text(JSON.stringify(report, null, 2));
  return text((note ? `> ${note}\n\n` : '') + reportMarkdown(report));
}

// ---------------------------------------------------------------- watchlist

function watchlist(args: Record<string, any>): ToolResult {
  const d = db();
  const { date, note } = resolveDate(d, args.date);
  const meta = latestReportMeta(d, date);
  if (!meta || meta.status === 'NOT_READY') {
    const q = checkQuality(d, date, false);
    return text(notReadyText(date, q.reasons.length ? q.reasons : ['该交易日股票池尚未生成'], note ? `\n> ${note}` : ''));
  }
  const report = loadReport(meta);
  const historyDays = Math.min(30, Math.max(1, Number(args.history_days) || 5));
  const days = recentTradeDays(d, date, historyDays);
  const history = d.prepare(`SELECT c.trade_date, c.ts_code, b.name, c.action, c.score, c.rank, c.reason
    FROM watchlist_change c LEFT JOIN stock_basic b ON b.ts_code = c.ts_code
    WHERE c.trade_date BETWEEN ? AND ? ORDER BY c.trade_date DESC, c.action`).all(days[0], date);
  const w = report.watchlist;
  const body = {
    report_id: report.report_id,
    as_of_trade_date: date,
    note,
    versions: { score: report.versions.score, watchlist: report.versions.watchlist },
    count: w.count,
    industry_distribution: w.industry_distribution,
    track_record: w.track_record ?? null,
    added: w.added,
    removed: w.removed,
    members: w.members.map((s: any) => ({
      ts_code: s.ts_code, name: s.name, industry: s.industry, score: s.score, rank: s.rank, status: s.status,
      entered_on: s.entered_on, close: s.close, pct_chg: s.pct_chg, trend: s.technical.trend,
      signals_today: s.signals_today.map((g: any) => g.name), risks: s.risks, watch_invalidation: s.watch_invalidation,
    })),
    history,
    disclaimer: '评分为启发式规则排序，不代表盈利概率。',
  };
  return text(JSON.stringify(body, null, 2));
}

// ---------------------------------------------------------------- stock

function stockAnalysis(args: Record<string, any>): ToolResult {
  const d = db();
  const { date, note } = resolveDate(d, args.date);
  const code = resolveCode(d, args.ts_code);
  const info = d.prepare('SELECT * FROM stock_basic WHERE ts_code = ?').get(code) as any;
  const days = recentTradeDays(d, date, 260);
  let result: any;
  forEachStockBars(d, days[0], date, (_c, b) => {
    const i = b.dates.length - 1;
    const x = computeIndicators(b);
    const scale = b.rawClose[i] / b.close[i];
    const last = (k: number) => b.dates.slice(-k);
    const series = (arr: number[], k = 10, s = 1) => arr.slice(-k).map(v => (Number.isFinite(v) ? Math.round(v * s * 1000) / 1000 : null));
    const recentSignals: any[] = [];
    const adjMissing = b.adjMissing ?? 0;
    for (let k = Math.max(0, i - 19); k <= i && !adjMissing; k++) {
      for (const id of detectSignals(b, x, k)) recentSignals.push({ trade_date: b.dates[k], id, name: SIGNAL_BY_ID.get(id)!.name });
    }
    result = {
      last_bar: b.dates[i],
      stale: b.dates[i] !== date,
      adjustment_warning: adjMissing
        ? `区间内 ${adjMissing} 根K线缺少复权因子，复权价格序列不连续：技术指标仅供参考，不输出信号`
        : undefined,
      state: technicalState(b, x, i),
      latest: {
        close: b.rawClose[i],
        ma5: x.ma5[i] * scale, ma10: x.ma10[i] * scale, ma20: x.ma20[i] * scale, ma60: x.ma60[i] * scale, ma120: x.ma120[i] * scale,
        dif: x.dif[i], dea: x.dea[i], macd_hist: x.hist[i],
        rsi6: x.rsi6[i], rsi14: x.rsi14[i], cci14: x.cci14[i],
        boll_up: x.bollUp[i] * scale, boll_mid: x.bollMid[i] * scale, boll_low: x.bollLow[i] * scale,
        atr14: x.atr14[i] * scale,
        vol_ratio_20: b.vol[i] / x.volMa20[i],
        amount20_yi: x.amountMa20[i] / 1e5,
      },
      last_10_days: {
        dates: last(10),
        close_raw: b.rawClose.slice(-10),
        rsi14: series(x.rsi14), dif: series(x.dif), dea: series(x.dea), cci14: series(x.cci14),
      },
      recent_signals: recentSignals,
    };
  }, [code]);
  if (!result) return text(`${code} 在 ${date} 前无本地行情数据`);

  const verdicts = loadVerdicts(d, date).verdicts;
  const f = fundamentalsAsOf(d, date).get(code);
  const basic = d.prepare('SELECT * FROM daily_basic WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1').get(code, date) as any;
  const score = d.prepare('SELECT trade_date, score, rank, detail FROM stock_score WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1').get(code, date) as any;
  const member = d.prepare('SELECT * FROM watchlist WHERE ts_code = ? AND trade_date = (SELECT MAX(trade_date) FROM watchlist WHERE trade_date <= ?)').get(code, date) as any;
  const body = {
    ts_code: code,
    name: info?.name,
    industry: info?.industry,
    as_of_trade_date: date,
    note: result.stale ? `${code} 在 ${date} 无行情（停牌或数据缺失），以下为最近一根K线 ${result.last_bar} 的结果` : note,
    indicator_version: INDICATOR_VERSION,
    adjust: '前复权（以 as-of 日为基准），价格类指标已换算回当日未复权价位',
    ...result,
    signal_details: [...new Set(result.recent_signals.map((s: any) => s.id))].map((id: any) => {
      const def = SIGNAL_BY_ID.get(id)!;
      return { id, name: def.name, trigger: def.trigger, invalidation: def.invalidation, risk: def.risk, evidence: verdicts.get(id)?.classification, evidence_basis: verdicts.get(id)?.basis };
    }),
    fundamentals: f ? { ...f, note: '按公告日约束：仅使用 as-of 日之前已公告的财报' } : null,
    fundamental_risks: fundamentalRisk(f, info?.industry ?? null).flags,
    valuation: basic ? { trade_date: basic.trade_date, pe_ttm: basic.pe_ttm, pb: basic.pb, ps_ttm: basic.ps_ttm, dv_ttm: basic.dv_ttm, total_mv_yi: basic.total_mv / 1e4, turnover_rate: basic.turnover_rate } : null,
    score: score ? { trade_date: score.trade_date, score: score.score, rank: score.rank, components: JSON.parse(score.detail) } : '不在评分候选范围（未满足准入条件或尚未生成报告）',
    watchlist: member ? { trade_date: member.trade_date, status: member.status, entered_on: member.entered_on, reason: member.reason } : null,
  };
  return text(JSON.stringify(body, (_k, v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v), 2));
}

// ---------------------------------------------------------------- sectors

function sectorRankTool(args: Record<string, any>): ToolResult {
  const d = db();
  const { date, note } = resolveDate(d, args.date);
  const meta = latestReportMeta(d, date);
  if (!meta || meta.status === 'NOT_READY') {
    const q = checkQuality(d, date, false);
    return text(notReadyText(date, q.reasons.length ? q.reasons : ['该交易日行业排名尚未生成'], note ? `\n> ${note}` : ''));
  }
  const report = loadReport(meta);
  const top = Number(args.top) > 0 ? Number(args.top) : undefined;
  const rows = top ? report.sectors.all.slice(0, top) : report.sectors.all;
  const lines = [
    `# 行业强弱排名 ${date}（报告 ${report.report_id}）`,
    note ? `> ${note}` : '',
    report.sectors.method,
    '',
    '| 排名 | 行业 | 强度 | 股票数 | 5日中位% | 20日中位% | 站上MA20% | 20日均成交额(亿) |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((s: any) => `| ${s.rank} | ${s.industry} | ${fmt(s.strength, 3)} | ${s.stocks} | ${fmt(s.ret5_median_pct)} | ${fmt(s.ret20_median_pct)} | ${fmt(s.pct_above_ma20, 1)} | ${fmt(s.amount20_yi, 0)} |`),
  ];
  return text(lines.filter(l => l !== '').join('\n'));
}

// ---------------------------------------------------------------- ETF

/**
 * ETF 工具在旧库（未运行过 etf-sync）上必须返回明确提示而不是崩溃，
 * 因此这里不使用 db()：只读打开连接，表不存在时由 etf.ts 抛出可读错误。
 */
function etfDb(): DatabaseSync {
  if (!existsSync(ashareDbPath())) throw new Error(`A股缓存不存在（${ashareDbPath()}），请先运行 finance-ashare sync`);
  return getAshareDb();
}

function etfQuotesTool(args: Record<string, any>): ToolResult {
  const codes = args.ts_codes == null || args.ts_codes === '' ? undefined
    : Array.isArray(args.ts_codes) ? args.ts_codes : String(args.ts_codes).split(/[,，\s]+/).filter(Boolean);
  const market = etfDb();
  const target = resolveDate(market, undefined).date;
  return json(etfQuotes(market, codes, { start: args.start_date, end: args.end_date, adjust: args.adjust, asOfDate: target }));
}

function etfStatusTool(args: Record<string, any>): ToolResult {
  const market = etfDb();
  return json(etfStatus(market, { date: args.date ?? resolveDate(market, undefined).date }));
}

export async function runAshareTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  switch (name) {
    case 'ashare_data_status': return dataStatus(args);
    case 'ashare_daily_report': return dailyReport(args);
    case 'ashare_watchlist': return watchlist(args);
    case 'ashare_stock_analysis': return stockAnalysis(args);
    case 'ashare_sector_rank': return sectorRankTool(args);
    case 'ashare_factor_snapshot': return json(factorSnapshot(db(), args));
    case 'ashare_stock_history': return json(stockHistory(db(), args));
    case 'ashare_financial_data': return json(financialHistory(db(), args));
    case 'ashare_market_data': return json(marketData(db(), args));
    case 'ashare_stock_basic': return json(stockBasic(db(), args));
    case 'ashare_etf_quotes': return etfQuotesTool(args);
    case 'ashare_etf_status': return etfStatusTool(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
