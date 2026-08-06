import { getSourcePriority, QVERIS_CONFIG, TUSHARE_CONFIG, } from '../config.js';
import { getQverisToolPlan, QverisUnsupportedError, runQverisForExistingTool, } from './qverisAdapter.js';
import { QverisClientError } from './qverisClient.js';
const SOURCE_LABELS = {
    tushare: 'Tushare',
    qveris: 'Qveris',
    binance: 'Binance',
    web: '公开新闻源',
    local: 'FinanceMCP 本地计算',
};
function nativeSourceForTool(name, args) {
    if (name === 'current_timestamp')
        return 'local';
    if (name === 'finance_news')
        return 'web';
    if ((name === 'stock_data' || name === 'stock_data_minutes')
        && String(args.market_type ?? '').trim().toLowerCase() === 'crypto') {
        return 'binance';
    }
    return 'tushare';
}
function orderedSources(nativeSource, supportsQveris) {
    const supported = new Set([nativeSource]);
    if (supportsQveris)
        supported.add('qveris');
    const requested = getSourcePriority().filter(source => supported.has(source));
    return [...new Set([...requested, nativeSource])];
}
function hasCredential(source) {
    if (source === 'tushare')
        return Boolean(TUSHARE_CONFIG.API_TOKEN);
    if (source === 'qveris')
        return Boolean(QVERIS_CONFIG.API_KEY);
    return true;
}
function resultText(result) {
    return (result.content ?? [])
        .map(item => typeof item.text === 'string' ? item.text : '')
        .join('\n')
        .trim();
}
function isFailureResult(result) {
    const text = resultText(result);
    if (!text)
        return false;
    if (/暂无数据|未找到相关数据|未获取到任何/.test(text))
        return false;
    return /(^|\n)\s*❌(?!\s*未找到)|获取[^\n]{0,30}失败|查询[^\n]{0,30}(?:失败|发生错误)|搜索失败|错误信息\s*[:：]/m.test(text);
}
function attemptLabel(attempt) {
    const source = SOURCE_LABELS[attempt.source];
    if (attempt.outcome === 'success')
        return `${source}（成功）`;
    return `${source}（${attempt.reason ?? (attempt.outcome === 'unsupported' ? '不支持' : '失败')}）`;
}
function annotateResult(result, source, attempts) {
    const route = attempts.length > 1 || attempts.some(attempt => attempt.outcome !== 'success')
        ? `\n数据源路由: ${attempts.map(attemptLabel).join(' → ')}`
        : '';
    const header = `数据来源: ${SOURCE_LABELS[source]}${route}\n\n`;
    const content = [...(result.content ?? [])];
    const firstTextIndex = content.findIndex(item => typeof item.text === 'string');
    if (firstTextIndex >= 0) {
        content[firstTextIndex] = {
            ...content[firstTextIndex],
            text: `${header}${content[firstTextIndex].text}`,
        };
    }
    else {
        content.unshift({ type: 'text', text: `${header}${JSON.stringify(result)}` });
    }
    return { ...result, content };
}
function qverisFailureReason(error) {
    if (error instanceof QverisUnsupportedError) {
        return { outcome: 'unsupported', reason: '接口未覆盖' };
    }
    if (error instanceof QverisClientError) {
        const reasons = {
            not_configured: '未配置凭证',
            auth: '凭证不可用',
            quota: 'credits 不足',
            rate_limit: '限流',
            timeout: '超时',
            unavailable: '服务不可用',
            invalid_response: '响应无效',
            request: '候选接口不可用',
        };
        return { outcome: error.kind === 'request' ? 'unsupported' : 'failed', reason: reasons[error.kind] };
    }
    return { outcome: 'failed', reason: '调用失败' };
}
export async function routeToolCall(name, args, runNative) {
    const nativeSource = nativeSourceForTool(name, args);
    const supportsQveris = Boolean(getQverisToolPlan(name, args));
    const sources = orderedSources(nativeSource, supportsQveris || Boolean(QVERIS_CONFIG.API_KEY));
    const attempts = [];
    for (const source of sources) {
        if (!hasCredential(source))
            continue;
        if (source === 'qveris') {
            try {
                const result = await runQverisForExistingTool(name, args);
                attempts.push({ source, outcome: 'success' });
                return annotateResult(result, source, attempts);
            }
            catch (error) {
                attempts.push({ source, ...qverisFailureReason(error) });
                continue;
            }
        }
        if (source !== nativeSource)
            continue;
        try {
            const result = await runNative();
            if (isFailureResult(result)) {
                attempts.push({ source, outcome: 'failed', reason: '调用失败' });
                continue;
            }
            attempts.push({ source, outcome: 'success' });
            return annotateResult(result, source, attempts);
        }
        catch {
            attempts.push({ source, outcome: 'failed', reason: '调用失败' });
        }
    }
    const route = attempts.length
        ? attempts.map(attemptLabel).join(' → ')
        : '没有已配置且支持该请求的数据源';
    return {
        content: [{
                type: 'text',
                text: `数据来源: 无\n数据源路由: ${route}\n\n# 数据查询失败\n\n没有可用的数据源完成本次请求。`,
            }],
    };
}
