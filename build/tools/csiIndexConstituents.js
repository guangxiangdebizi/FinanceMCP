import { TUSHARE_CONFIG } from '../config.js';
function normalizeIndexCode(input) {
    const s = (input || '').trim();
    if (!s)
        return s;
    if (s.includes('.') && s.split('.').length === 2) {
        const [left, right] = s.split('.');
        return `${left}.${right.toUpperCase()}`;
    }
    const low = s.toLowerCase();
    if (low.startsWith('sz') || low.startsWith('sh')) {
        const market = s.substring(0, 2).toUpperCase();
        const digits = s.substring(2);
        return `${digits}.${market}`;
    }
    return s;
}
function parseDateString(input) {
    const s = (input || '').trim();
    if (!s)
        throw new Error('日期不能为空');
    if (s.includes('-')) {
        // YYYY-MM-DD -> YYYYMMDD
        return s.replaceAll('-', '');
    }
    if (/^\d{8}$/.test(s))
        return s;
    throw new Error('日期格式不正确，应为 YYYYMMDD 或 YYYY-MM-DD');
}
function addDaysYYYYMMDD(base, deltaDays) {
    const year = Number(base.slice(0, 4));
    const month = Number(base.slice(4, 6)) - 1;
    const day = Number(base.slice(6, 8));
    const dt = new Date(Date.UTC(year, month, day));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}
function mapTushareItemsToObjects(fields, items) {
    return items.map((row) => {
        const obj = {};
        fields.forEach((f, idx) => {
            obj[f] = row[idx];
        });
        return obj;
    });
}
async function callTushare(api_name, params, fields) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        const body = {
            api_name,
            token: TUSHARE_CONFIG.API_TOKEN,
            params,
            ...(fields ? { fields } : {})
        };
        const resp = await fetch(TUSHARE_CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!resp.ok)
            throw new Error(`Tushare API请求失败: ${resp.status}`);
        const data = await resp.json();
        if (data.code !== 0)
            throw new Error(`Tushare API错误: ${data.msg}`);
        const fieldsArr = data.data?.fields ?? [];
        const items = data.data?.items ?? [];
        return mapTushareItemsToObjects(fieldsArr, items);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
function summarizePrices(rows) {
    if (!rows || rows.length === 0) {
        return {
            open_at_start: null,
            low_min: null,
            low_min_date: null,
            high_max: null,
            high_max_date: null,
            close_at_end: null
        };
    }
    // 确保按日期升序
    const sorted = [...rows].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    const openAtStart = sorted[0]?.open != null ? Number(sorted[0].open) : null;
    const closeAtEnd = sorted[sorted.length - 1]?.close != null ? Number(sorted[sorted.length - 1].close) : null;
    let lowMin = null;
    let lowMinDate = null;
    let highMax = null;
    let highMaxDate = null;
    for (const r of sorted) {
        const low = r.low != null ? Number(r.low) : null;
        const high = r.high != null ? Number(r.high) : null;
        const date = String(r.trade_date);
        if (low != null && (lowMin == null || low < lowMin)) {
            lowMin = low;
            lowMinDate = date;
        }
        if (high != null && (highMax == null || high > highMax)) {
            highMax = high;
            highMaxDate = date;
        }
    }
    return {
        open_at_start: openAtStart,
        low_min: lowMin,
        low_min_date: lowMinDate,
        high_max: highMax,
        high_max_date: highMaxDate,
        close_at_end: closeAtEnd
    };
}
function calcReturn(openStart, closeEnd) {
    if (openStart == null || closeEnd == null || openStart === 0)
        return null;
    return (closeEnd - openStart) / openStart;
}
async function getIndexDaily(ts_code, start, end) {
    const rows = await callTushare('index_daily', { ts_code, start_date: start, end_date: end }, 'trade_date,open,high,low,close');
    return rows;
}
async function getStockDaily(ts_code, start, end) {
    const rows = await callTushare('daily', { ts_code, start_date: start, end_date: end }, 'trade_date,open,high,low,close');
    return rows;
}
async function getDailyBasicMapByDate(date) {
    // 拉取指定交易日全市场基础指标，构建 ts_code -> 估值映射
    const rows = await callTushare('daily_basic', { trade_date: date }, 'ts_code,pe_ttm,pb,dv_ratio');
    const out = {};
    for (const r of rows) {
        const code = String(r.ts_code || '').trim();
        if (!code)
            continue;
        const peTtm = r.pe_ttm != null ? Number(r.pe_ttm) : null;
        const pb = r.pb != null ? Number(r.pb) : null;
        const dvRatio = r.dv_ratio != null ? Number(r.dv_ratio) : null; // 按百分比数值
        out[code] = {
            pe_ttm: isFinite(Number(peTtm)) ? peTtm : null,
            pb: isFinite(Number(pb)) ? pb : null,
            dividend_yield_pct: isFinite(Number(dvRatio)) ? dvRatio : null
        };
    }
    return out;
}
async function getNearestDailyBasicMap(end, maxBackDays = 10) {
    for (let i = 0; i <= maxBackDays; i++) {
        const d = addDaysYYYYMMDD(end, -i);
        try {
            const map = await getDailyBasicMapByDate(d);
            if (Object.keys(map).length > 0) {
                return { date: d, map };
            }
        }
        catch {
            // 忽略该日错误，继续回退
        }
    }
    return { date: null, map: {} };
}
async function getFinaIndicatorLatest(ts_code, end) {
    // 限定窗口，避免返回过多数据：向前约 800 天
    const start = addDaysYYYYMMDD(end, -800);
    try {
        const rows = await callTushare('fina_indicator', { ts_code, start_date: start, end_date: end }, 'ts_code,ann_date,end_date,roe,roa,netprofit_margin,ocfps,debt_to_assets,or_yoy,assets_turn,grossprofit_margin,saleexp_to_gr,adminexp_of_gr,finaexp_of_gr,eps');
        if (!rows || rows.length === 0)
            return null;
        const sorted = [...rows].sort((a, b) => {
            const aKey = String(a.ann_date || a.end_date || '');
            const bKey = String(b.ann_date || b.end_date || '');
            return bKey.localeCompare(aKey);
        });
        const top = sorted[0] || {};
        const roe = top.roe != null ? Number(top.roe) : null; // 已为百分比
        const roa = top.roa != null ? Number(top.roa) : null; // 已为百分比
        const npm = top.netprofit_margin != null ? Number(top.netprofit_margin) : null; // 已为百分比
        const ocfps = top.ocfps != null ? Number(top.ocfps) : null; // 元
        const dta = top.debt_to_assets != null ? Number(top.debt_to_assets) : null; // 百分比
        const orYoy = top.or_yoy != null ? Number(top.or_yoy) : null; // 百分比
        const assetsTurn = top.assets_turn != null ? Number(top.assets_turn) : null; // 次
        const grossMargin = top.grossprofit_margin != null ? Number(top.grossprofit_margin) : null; // 百分比
        const saleToGr = top.saleexp_to_gr != null ? Number(top.saleexp_to_gr) : null; // 百分比
        const adminToGr = top.adminexp_of_gr != null ? Number(top.adminexp_of_gr) : null; // 百分比
        const finaToGr = top.finaexp_of_gr != null ? Number(top.finaexp_of_gr) : null; // 百分比
        const eps = top.eps != null ? Number(top.eps) : null; // 元
        const threeArr = [saleToGr, adminToGr, finaToGr].map(v => (v != null && isFinite(Number(v)) ? Number(v) : 0));
        const threeExpense = threeArr.reduce((acc, v) => acc + v, 0);
        return {
            roe_pct: isFinite(Number(roe)) ? roe : null,
            roa_pct: isFinite(Number(roa)) ? roa : null,
            netprofit_margin_pct: isFinite(Number(npm)) ? npm : null,
            ocfps: isFinite(Number(ocfps)) ? ocfps : null,
            debt_to_assets_pct: isFinite(Number(dta)) ? dta : null,
            revenue_yoy_pct: isFinite(Number(orYoy)) ? orYoy : null,
            assets_turn: isFinite(Number(assetsTurn)) ? assetsTurn : null,
            grossprofit_margin_pct: isFinite(Number(grossMargin)) ? grossMargin : null,
            three_expense_ratio_pct: isFinite(Number(threeExpense)) ? threeExpense : null,
            eps: isFinite(Number(eps)) ? eps : null
        };
    }
    catch {
        return null;
    }
}
async function getLatestCashDividendPerShare(ts_code, end) {
    const start = addDaysYYYYMMDD(end, -365 * 5);
    try {
        const rows = await callTushare('dividend', { ts_code, start_date: start, end_date: end }, 'ts_code,ann_date,end_date,cash_div,cash_div_tax');
        if (!rows || rows.length === 0)
            return null;
        const sorted = [...rows].sort((a, b) => String(b.end_date || b.ann_date || '').localeCompare(String(a.end_date || a.ann_date || '')));
        for (const r of sorted) {
            const cashDivPer10 = r.cash_div != null ? Number(r.cash_div) : null; // 每10股派现(元)
            if (cashDivPer10 != null && isFinite(Number(cashDivPer10)) && cashDivPer10 > 0) {
                return cashDivPer10 / 10; // 折为每股
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
async function getIndexWeights(index_code, end) {
    const norm = normalizeIndexCode(index_code);
    // 回退最多120天找到最近一次权重
    for (let i = 0; i <= 120; i++) {
        const d = addDaysYYYYMMDD(end, -i);
        const rows = await callTushare('index_weight', { index_code: norm, trade_date: d }, 'index_code,con_code,trade_date,weight');
        if (rows && rows.length > 0) {
            const arr = rows
                .map(r => ({ ts_code: String(r.con_code || r.ts_code || '').trim(), weight: Number(r.weight ?? 0) }))
                .filter(c => !!c.ts_code);
            // 按权重降序
            arr.sort((a, b) => b.weight - a.weight);
            return arr;
        }
    }
    return [];
}
export const csiIndexConstituents = {
    name: 'csi_index_constituents',
    description: '获取中证指数公司(CSI)指数（含行业/主题）的区间行情、成分权重与估值/财务摘要（PE TTM、PB、股息率、ROE、ROA、净利率、每股经营现金流、资产负债率、营收同比、资产周转率、毛利率、三费比率、现金分红率）。',
    parameters: {
        type: 'object',
        properties: {
            index_code: {
                type: 'string',
                description: "指数代码(仅限CSI，含行业/主题)。请使用 .SH/.SZ 形式且能在 Tushare index_weight 查询到权重的代码，例如中证证券公司 '399975.SZ'；也支持宽基 '000300.SH'、'000905.SH'，以及 'sh000300'、'sz399006' 形式"
            },
            start_date: {
                type: 'string',
                description: '开始日期，YYYYMMDD 或 YYYY-MM-DD'
            },
            end_date: {
                type: 'string',
                description: '结束日期，YYYYMMDD 或 YYYY-MM-DD'
            }
        },
        required: ['index_code', 'start_date', 'end_date']
    },
    async run(args) {
        try {
            const normIndex = normalizeIndexCode(args.index_code);
            const start = parseDateString(args.start_date);
            const end = parseDateString(args.end_date);
            if (!TUSHARE_CONFIG.API_TOKEN) {
                throw new Error('请配置TUSHARE_TOKEN环境变量');
            }
            // 指数行情
            const indexDaily = await getIndexDaily(normIndex, start, end);
            const indexSummary = summarizePrices(indexDaily);
            const indexRet = calcReturn(indexSummary.open_at_start, indexSummary.close_at_end);
            // 成分权重（以end为基准回退查找）
            const weights = await getIndexWeights(normIndex, end);
            if (weights.length === 0) {
                return {
                    content: [
                        { type: 'text', text: `# ${normIndex} 指数区间与成分股摘要\n\n❌ 未能获取到指数成分权重（仅支持中证指数公司CSI），请检查指数代码或日期范围。` }
                    ]
                };
            }
            // 使用全部成分股（按权重降序）
            const allConstituents = weights;
            // 并发拉取全部成分股行情
            const stockRows = await Promise.all(allConstituents.map(c => getStockDaily(normalizeIndexCode(c.ts_code), start, end).catch(() => [])));
            const stockSummaries = stockRows.map(rows => summarizePrices(rows));
            // 估值：以结束日向前回退查找最近可用 daily_basic（最多回退10日）
            const { date: basicDate, map: basicMap } = await getNearestDailyBasicMap(end, 10);
            // 财务指标：为每只股票获取最近披露的 ROE/ROA/净利率/资产周转率/毛利率/三费比率/EPS（按公告日或报告期倒序取最近）
            const finaSnapshots = await Promise.all(allConstituents.map(c => getFinaIndicatorLatest(normalizeIndexCode(c.ts_code), end).catch(() => null)));
            // 现金分红率：获取最近每股分红，结合 EPS 估算 分红率 = 每股分红 / 每股收益 * 100%
            const latestDpsList = await Promise.all(allConstituents.map(c => getLatestCashDividendPerShare(normalizeIndexCode(c.ts_code), end).catch(() => null)));
            // 组装输出
            const pct = (v) => v == null ? 'N/A' : (v * 100).toFixed(2) + '%';
            const num = (v) => v == null ? 'N/A' : String(Number(v.toFixed(4)));
            let out = `# ${normIndex} 指数区间与成分股摘要\n\n` +
                `仅支持中证指数公司(CSI)指数。查询区间: ${start} - ${end}\n\n` +
                `## 指数价格摘要\n` +
                `- 起始开盘: ${num(indexSummary.open_at_start)}\n` +
                `- 区间最低: ${num(indexSummary.low_min)} (${indexSummary.low_min_date || 'N/A'})\n` +
                `- 区间最高: ${num(indexSummary.high_max)} (${indexSummary.high_max_date || 'N/A'})\n` +
                `- 结束收盘: ${num(indexSummary.close_at_end)}\n` +
                `- 区间涨跌幅: ${pct(indexRet)}\n\n` +
                `## 成分股列表（按权重降序）\n`;
            out += `| 代码 | 权重(%) | 起始开盘 | 区间最低 | 区间最高 | 结束收盘 | 区间涨跌幅 | PE(TTM) | PB | 股息率(%) | ROE(%) | ROA(%) | 净利率(%) | 每股经营现金流 | 资产负债率(%) | 营收同比(%) | 资产周转率 | 毛利率(%) | 三费比率(%) | 现金分红率(%) |\n`;
            out += `|-----|---------|-----------|-----------|-----------|-----------|-----------|---------|----|-----------|--------|--------|-----------|--------------|--------------|-----------|------------|-----------|------------|--------------|\n`;
            allConstituents.forEach((c, i) => {
                const s = stockSummaries[i];
                const r = calcReturn(s.open_at_start, s.close_at_end);
                const code = normalizeIndexCode(c.ts_code);
                const val = basicMap[code] || basicMap[c.ts_code] || null;
                const fmt = (v, digits = 4) => v == null ? 'N/A' : String(Number(v.toFixed(digits)));
                const f = finaSnapshots[i];
                const fmtPct = (v, digits = 2) => v == null ? 'N/A' : String(Number(v.toFixed(digits)));
                const dps = latestDpsList[i];
                const payoutPct = (dps != null && f?.eps != null && f.eps !== 0) ? Number(((dps / f.eps) * 100).toFixed(2)) : null;
                out += `| ${code} | ${num(c.weight)} | ${num(s.open_at_start)} | ${num(s.low_min)} | ${num(s.high_max)} | ${num(s.close_at_end)} | ${pct(r)} | ${fmt(val?.pe_ttm)} | ${fmt(val?.pb)} | ${val?.dividend_yield_pct == null ? 'N/A' : Number(val.dividend_yield_pct.toFixed(2))} | ${fmtPct(f?.roe_pct)} | ${fmtPct(f?.roa_pct)} | ${fmtPct(f?.netprofit_margin_pct)} | ${fmt(f?.ocfps)} | ${fmtPct(f?.debt_to_assets_pct)} | ${fmtPct(f?.revenue_yoy_pct)} | ${fmt(f?.assets_turn, 3)} | ${fmtPct(f?.grossprofit_margin_pct)} | ${fmtPct(f?.three_expense_ratio_pct)} | ${payoutPct == null ? 'N/A' : payoutPct} |\n`;
            });
            return {
                content: [{ type: 'text', text: out }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `❌ CSI指数成分摘要查询失败: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true
            };
        }
    }
};
//# sourceMappingURL=csiIndexConstituents.js.map