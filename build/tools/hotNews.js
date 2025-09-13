import { TUSHARE_CONFIG } from '../config.js';
function normalizeText(text) {
    return (text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase();
}
function toBigrams(text) {
    const s = normalizeText(text);
    const grams = [];
    for (let i = 0; i < s.length - 1; i++) {
        grams.push(s.slice(i, i + 2));
    }
    return grams.length ? grams : s ? [s] : [];
}
function jaccard(a, b) {
    if (a.length === 0 && b.length === 0)
        return 1;
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const g of setA)
        if (setB.has(g))
            inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}
function isSimilar(a, b, threshold) {
    const sim = jaccard(toBigrams(a), toBigrams(b));
    return sim >= threshold;
}
function deduplicateByContent(items, threshold = 0.8) {
    const representatives = [];
    for (const item of items) {
        const content = `${item.title}\n${item.summary}`;
        let dup = false;
        for (const rep of representatives) {
            const repContent = `${rep.title}\n${rep.summary}`;
            if (isSimilar(content, repContent, threshold)) {
                dup = true;
                break;
            }
        }
        if (!dup)
            representatives.push(item);
    }
    return representatives;
}
async function fetchTushareNewsBatch(maxTotal, logs) {
    if (!TUSHARE_CONFIG.API_TOKEN) {
        logs?.push('[WARN] 未配置 TUSHARE_TOKEN，无法从 Tushare 获取数据');
        return [];
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        const body = {
            api_name: 'news',
            token: TUSHARE_CONFIG.API_TOKEN,
            // 不传任何筛选参数，直接获取默认的最新数据
            params: {},
            fields: 'datetime,content,title,channels'
        };
        const resp = await fetch(TUSHARE_CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            const msg = `Tushare请求失败: HTTP ${resp.status}`;
            logs?.push(`[ERROR] ${msg}`);
            return [];
        }
        const data = await resp.json();
        if (data.code !== 0) {
            const msg = `Tushare返回错误: ${data.msg || data.message || '未知错误'}`;
            logs?.push(`[ERROR] ${msg}`);
            return [];
        }
        const fields = data.data?.fields ?? [];
        const items = data.data?.items ?? [];
        const idxDatetime = fields.indexOf('datetime');
        const idxContent = fields.indexOf('content');
        const idxTitle = fields.indexOf('title');
        const results = [];
        for (const row of items) {
            if (results.length >= maxTotal)
                break;
            const title = String(row[idxTitle] ?? '').trim();
            const content = String(row[idxContent] ?? '').trim();
            const datetime = String(row[idxDatetime] ?? '').trim();
            results.push({
                title,
                summary: content,
                url: '',
                source: 'Tushare',
                publishTime: datetime,
                keywords: []
            });
        }
        logs?.push(`[INFO] 从 Tushare 获取原始条数: ${results.length}`);
        return results;
    }
    catch (err) {
        clearTimeout(timeoutId);
        const msg = `获取Tushare新闻失败: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        logs?.push(`[ERROR] ${msg}`);
        return [];
    }
}
export const hotNews = {
    name: 'hot_news_7x24',
    description: '7x24热点：从Tushare新闻接口获取最新的财经、政治、科技、体育、娱乐、军事、社会、国际等新闻',
    parameters: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: '返回条数，默认100，上限1500。接口按此数量向Tushare请求后再进行内容相似度去重',
                minimum: 1,
                maximum: 1500
            }
        }
    },
    async run(_args) {
        try {
            const logs = [];
            const rawLimit = typeof _args?.limit === 'number' && isFinite(_args.limit) ? Math.floor(_args.limit) : 100;
            const limit = Math.min(1500, Math.max(1, rawLimit));
            logs.push(`[START] hot_news_7x24 获取最新批次（limit=${limit}）`);
            const raw = await fetchTushareNewsBatch(limit, logs);
            const deduped = deduplicateByContent(raw, 0.8);
            logs.push(`[INFO] 去重后条数: ${deduped.length}`);
            if (deduped.length === 0) {
                const hint = '可能原因：1) 未配置 Tushare Token；2) 被频控限制；3) 网络/服务异常。';
                return { content: [
                        { type: 'text', text: `# 7x24 热点\n\n暂无数据\n${hint}` },
                        { type: 'text', text: `## 调用日志\n\n${logs.join('\n')}` }
                    ] };
            }
            // 逐条仅展示摘要（如有标题可作为前缀），不展示来源/时间/分隔线
            const formattedList = deduped.map(n => {
                const title = n.title ? `${n.title}\n` : '';
                return `${title}${n.summary}`.trim();
            }).join('\n---\n\n');
            // 底部统计：来源统计 + 时间范围/日期
            const sourceCounts = new Map();
            const daySet = new Set();
            for (const n of deduped) {
                sourceCounts.set(n.source, (sourceCounts.get(n.source) || 0) + 1);
                const day = (n.publishTime || '').split(' ')[0] || '';
                if (day)
                    daySet.add(day);
            }
            const sourceStats = Array.from(sourceCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => `${s}: ${c}`)
                .join('，');
            const uniqueDays = Array.from(daySet.values()).sort();
            const dayInfo = uniqueDays.length ? `日期：${uniqueDays.join('、')}` : `日期：未知`;
            const footer = `\n\n—\n统计：共 ${deduped.length} 条；来源分布：${sourceStats || '无'}\n${dayInfo}\n数据来源：Tushare 新闻快讯 (<https://tushare.pro/document/2?doc_id=143>)`;
            return {
                content: [
                    { type: 'text', text: `# 7x24 热点（按80%相似度降重）\n\n${formattedList}${footer}` }
                ]
            };
        }
        catch (error) {
            return { content: [{ type: 'text', text: `# 7x24 热点 获取失败\n\n错误: ${error instanceof Error ? error.message : '未知错误'}` }] };
        }
    }
};
//# sourceMappingURL=hotNews.js.map