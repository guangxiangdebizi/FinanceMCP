import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ashareDataDir } from './db.js';
import { checkQuality, QualityReport, recentTradeDays } from './ingest.js';
import { scanMarket, SCORE_RULES, SCORE_VERSION, SectorRow, StockRow } from './analysis.js';
import { indexPerformance, marketBreadth, Regime, REGIME_LABELS, regimeSeries } from './market.js';
import { INDICATOR_VERSION } from './indicators.js';
import { SIGNAL_BY_ID, SIGNAL_VERSION } from './signals.js';
import { updateWatchlist, WATCHLIST_RULES, WATCHLIST_VERSION } from './watchlist.js';
import { EVIDENCE_VERSION, evaluateWatchlist, loadVerdicts, SignalVerdict } from './evidence.js';

export const REPORT_SCHEMA_VERSION = 'ashare-report-1.0.0';

export const DATA_SOURCES = [
  'Tushare Pro trade_cal（交易日历）',
  'Tushare Pro stock_basic（股票基础信息，行业为当前分类）',
  'Tushare Pro daily（日线行情，按交易日批量）',
  'Tushare Pro daily_basic（每日指标：估值/换手/市值）',
  'Tushare Pro adj_factor（复权因子）',
  'Tushare Pro stk_limit（涨跌停价）',
  'Tushare Pro index_daily（核心指数日线）',
  'Tushare Pro fina_indicator_vip（财务指标，按公告日约束）',
];

const nowCst = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00');
const r2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function newReportId(date: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `ASR-${date}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export interface ReportMeta {
  report_id: string;
  trade_date: string;
  status: string;
  generated_at: string;
  path: string;
}

function signalView(id: string, verdicts: Map<string, SignalVerdict>) {
  const def = SIGNAL_BY_ID.get(id)!;
  const v = verdicts.get(id);
  return {
    id,
    name: def.name,
    direction: def.direction,
    trigger: def.trigger,
    invalidation: def.invalidation,
    risk: def.risk,
    evidence: v?.classification ?? 'research_only',
    evidence_basis: v?.basis ?? '尚无历史检验结果',
  };
}

function memberView(row: StockRow, verdicts: Map<string, SignalVerdict>, extra: Record<string, unknown>) {
  const f = row.fundamentals;
  return {
    ts_code: row.ts_code,
    name: row.name,
    industry: row.industry,
    close: r2(row.close),
    pct_chg: r2(row.pct_chg),
    score: row.score,
    rank: row.rank,
    ...extra,
    components: row.components,
    technical: {
      trend: row.state.trend,
      ret5_pct: r2(row.state.ret5 * 100),
      ret20_pct: r2(row.state.ret20 * 100),
      ret60_pct: r2(row.state.ret60 * 100),
      rsi14: r2(row.state.rsi14, 1),
      atr_pct: r2(row.state.atr_pct * 100),
      ma20: r2(row.ma20),
      ma60: r2(row.ma60),
    },
    fundamentals: f ? {
      report_period: f.end_date,
      announced: f.ann_date,
      roe: r2(f.roe),
      netprofit_yoy: r2(f.netprofit_yoy),
      ocf_to_profit: r2(f.ocf_to_profit),
      debt_to_assets: r2(f.debt_to_assets),
    } : null,
    valuation: { pe_ttm: r2(row.pe_ttm), pb: r2(row.pb) },
    signals_today: row.signals.map(id => signalView(id, verdicts)),
    watch_invalidation: [
      `收盘价跌破 MA60（约 ${r2(row.ma60)}）视为趋势条件失效`,
      `评分排名跌出前 ${WATCHLIST_RULES.exit_rank} 或不再满足准入条件时移出股票池`,
    ],
    risks: row.risk_flags,
  };
}

function marketJudgement(regime: Regime | undefined, breadth: ReturnType<typeof marketBreadth>, pctMa20: number, pctMa60: number, indices: ReturnType<typeof indexPerformance>) {
  const points: string[] = [];
  if (regime) points.push(`沪深300 趋势状态：${REGIME_LABELS[regime]}（规则：收盘相对 MA60 与 MA20 五日斜率）`);
  points.push(`上涨 ${breadth.up} 家 / 下跌 ${breadth.down} 家（上涨占比 ${(breadth.up_ratio * 100).toFixed(1)}%），涨停 ${breadth.limit_up}、跌停 ${breadth.limit_down}`);
  points.push(`站上 MA20 的个股占比 ${(pctMa20 * 100).toFixed(1)}%，站上 MA60 占比 ${(pctMa60 * 100).toFixed(1)}%`);
  if (breadth.amount_ma20_yi) {
    const ratio = breadth.amount_yi / breadth.amount_ma20_yi;
    points.push(`两市成交额 ${breadth.amount_yi.toFixed(0)} 亿，为 20 日均值的 ${(ratio * 100).toFixed(0)}%（${ratio > 1.1 ? '放量' : ratio < 0.9 ? '缩量' : '量能持平'}）`);
  }
  const big = indices.find(i => i.ts_code === '000300.SH');
  const small = indices.find(i => i.ts_code === '000852.SH');
  if (big?.ret20 != null && small?.ret20 != null) {
    const diff = small.ret20 - big.ret20;
    points.push(`近 20 日中证1000 相对沪深300 ${diff >= 0 ? '强' : '弱'} ${Math.abs(diff).toFixed(1)} 个百分点（${diff >= 0 ? '小盘占优' : '大盘占优'}）`);
  }
  let tone: 'risk_on' | 'neutral' | 'risk_off' = 'neutral';
  if (breadth.up_ratio >= 0.6 && pctMa20 >= 0.5) tone = 'risk_on';
  else if (breadth.up_ratio <= 0.35 && pctMa20 <= 0.4) tone = 'risk_off';
  return { tone, points };
}

function sectorView(s: SectorRow) {
  return {
    industry: s.industry, rank: s.rank, strength: r2(s.strength, 3), stocks: s.stocks,
    ret5_median_pct: r2(s.ret5_median * 100), ret20_median_pct: r2(s.ret20_median * 100),
    pct_above_ma20: r2(s.pct_above_ma20 * 100, 1), amount20_yi: r2(s.amount_yi, 0),
  };
}

function versions() {
  return {
    report_schema: REPORT_SCHEMA_VERSION,
    indicators: INDICATOR_VERSION,
    signals: SIGNAL_VERSION,
    score: SCORE_VERSION,
    watchlist: WATCHLIST_VERSION,
    evidence: EVIDENCE_VERSION,
  };
}

function persist(db: DatabaseSync, report: any): ReportMeta {
  const dir = join(ashareDataDir(), 'reports', report.as_of_trade_date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.report_id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(report, null, 2));
  // Store the path relative to the data directory so host and container (/data) agree.
  db.prepare('INSERT INTO report (report_id, trade_date, status, generated_at, path) VALUES (?,?,?,?,?)')
    .run(report.report_id, report.as_of_trade_date, report.status, report.generated_at, join('reports', report.as_of_trade_date, `${report.report_id}.json`));
  return { report_id: report.report_id, trade_date: report.as_of_trade_date, status: report.status, generated_at: report.generated_at, path };
}

export function latestReportMeta(db: DatabaseSync, date?: string, readyOnly = false): ReportMeta | undefined {
  const cond = [date ? 'trade_date = ?' : '1=1', readyOnly ? "status != 'NOT_READY'" : '1=1'].join(' AND ');
  return db.prepare(`SELECT * FROM report WHERE ${cond} ORDER BY generated_at DESC LIMIT 1`).get(...(date ? [date] : [])) as ReportMeta | undefined;
}

export function resolveReportPath(stored: string): string {
  if (!isAbsolute(stored)) return join(ashareDataDir(), stored);
  if (existsSync(stored)) return stored;
  // Absolute paths written by another runtime (e.g. /data inside the container).
  const i = stored.lastIndexOf('/reports/');
  return i >= 0 ? join(ashareDataDir(), stored.slice(i + 1)) : stored;
}

export function loadReport(meta: ReportMeta): any {
  const path = resolveReportPath(meta.path);
  if (!existsSync(path)) throw new Error(`报告文件不存在: ${meta.path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Build and persist the report for one trading day from the local cache.
 * When core data for that day is missing, the report is NOT_READY and carries
 * no watchlist or signals; earlier days are never substituted.
 */
export type RunMode = 'live' | 'replay' | 'manual';

export function generateReport(db: DatabaseSync, date: string, mode: RunMode = 'manual'): { meta: ReportMeta; report: any } {
  const quality: QualityReport = checkQuality(db, date);
  const generatedAt = nowCst();
  const base = {
    report_id: newReportId(date),
    schema: REPORT_SCHEMA_VERSION,
    as_of_trade_date: date,
    generated_at: generatedAt,
    status: quality.status,
    run_mode: mode,
    run_mode_note: mode === 'replay'
      ? '历史重放：基于本地缓存在事后生成，行业分类为当前口径，非当日实时发布'
      : mode === 'live' ? '日常流水线（同步→检查→分析→发布）生成，生成时间见 generated_at' : '手动生成',
    versions: versions(),
    data: {
      sources: DATA_SOURCES,
      quality,
      last_sync: db.prepare("SELECT dataset, MAX(synced_at) synced_at FROM sync_log GROUP BY dataset").all(),
    },
  };

  if (quality.status === 'NOT_READY') {
    const lastReady = latestReportMeta(db, undefined, true);
    const report = {
      ...base,
      not_ready: {
        reasons: quality.reasons,
        policy: '核心数据缺失，本报告不生成市场判断、股票池或交易信号，也不使用前一交易日数据替代。',
        latest_ready_report: lastReady ? { report_id: lastReady.report_id, trade_date: lastReady.trade_date } : null,
      },
      disclaimer: '本报告仅为研究辅助，不构成投资建议。',
    };
    return { meta: persist(db, report), report };
  }

  const scan = scanMarket(db, date);
  const watch = updateWatchlist(db, scan);
  const { verdicts, meta: evidenceMeta } = loadVerdicts(db);
  const regimes = regimeSeries(db, date);
  const regime = regimes.get(date);
  const indices = indexPerformance(db, date);
  const breadth = marketBreadth(db, date);
  const judgement = marketJudgement(regime, breadth, scan.pct_above_ma20, scan.pct_above_ma60, indices);
  const byCode = new Map(scan.rows.map(r => [r.ts_code, r]));
  const { per_date: _perDate, ...trackRecord } = evaluateWatchlist(db, recentTradeDays(db, date, 65)[0], date, 5);

  const members = watch.members.map(m => memberView(byCode.get(m.ts_code)!, verdicts, {
    status: m.status, entered_on: m.entered_on, membership_reason: m.reason,
  }));
  const signalSummary = Object.entries(scan.signal_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ ...signalView(id, verdicts), market_count: count }));

  const report = {
    ...base,
    market: {
      regime: regime ?? null,
      regime_label: regime ? REGIME_LABELS[regime] : '历史不足',
      tone: judgement.tone,
      judgement: judgement.points,
      indices,
      breadth: { ...breadth, pct_above_ma20: r2(scan.pct_above_ma20 * 100, 1), pct_above_ma60: r2(scan.pct_above_ma60 * 100, 1) },
      suspended_or_missing: scan.suspended_or_missing,
    },
    sectors: {
      method: '行业为 Tushare stock_basic 行业；强度 = 0.5·pr(20日中位收益) + 0.3·pr(5日中位收益) + 0.2·pr(站上MA20比例)',
      top: scan.sectors.slice(0, 8).map(sectorView),
      bottom: scan.sectors.slice(-5).reverse().map(sectorView),
      all: scan.sectors.map(sectorView),
    },
    watchlist: {
      rules: WATCHLIST_RULES,
      score_rules: SCORE_RULES,
      previous_date: watch.previous_date,
      count: members.length,
      eligible_universe: scan.rows.filter(r => r.eligible).length,
      industry_distribution: watch.industry_distribution,
      track_record: {
        ...trackRecord,
        method: '近 60 个交易日内每个股票池日期：成员次日开盘至第 5 个交易日收盘的等权收益，减去全市场等权收益',
      },
      added: watch.changes.filter(c => c.action === 'add'),
      removed: watch.changes.filter(c => c.action === 'remove'),
      members,
    },
    signals: {
      market_summary: signalSummary,
      evidence_window: evidenceMeta,
      note: 'evidence=evidence_supported 表示历史样本内超额收益统计显著；research_only 为研究指标，不应视为交易规则。',
    },
    risks: [
      ...(quality.status === 'DEGRADED' ? quality.reasons.map(r => `数据降级：${r}`) : []),
      ...(judgement.tone === 'risk_off' ? ['市场宽度弱，技术信号失败率通常上升'] : []),
      '行业分类为当前口径，历史重放存在行业归属偏差',
    ],
    disclaimer: '评分为启发式规则排序，不代表盈利概率；本报告仅为研究辅助，不构成投资建议。',
  };
  return { meta: persist(db, report), report };
}
