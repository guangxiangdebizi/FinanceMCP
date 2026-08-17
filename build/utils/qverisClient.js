import { randomUUID } from 'node:crypto';
import { QVERIS_CONFIG } from '../config.js';
function requireApiKey() {
    const apiKey = QVERIS_CONFIG.API_KEY.trim();
    if (!apiKey) {
        throw new Error('Qveris 未启用：请配置 QVERIS_API_KEY，或在 HTTP 请求中传入 X-Qveris-Api-Key。' +
            'Global: https://qveris.ai/account?page=api-keys；中国区: https://qveris.cn/account?page=api-keys');
    }
    return apiKey;
}
function describeApiError(status, payload) {
    if (payload && typeof payload === 'object') {
        const body = payload;
        const message = body.error_message ?? body.message ?? body.error ?? body.detail;
        if (typeof message === 'string' && message.trim())
            return message.trim();
    }
    if (status === 401)
        return 'API Key 无效或已过期';
    if (status === 402)
        return 'credits 不足';
    if (status === 429)
        return '请求过于频繁';
    return `HTTP ${status}`;
}
function unwrapEnvelope(payload) {
    if (payload && typeof payload === 'object' && 'status' in payload) {
        const envelope = payload;
        if (envelope.status !== 'success') {
            const message = typeof envelope.message === 'string' ? envelope.message : 'Qveris 返回失败状态';
            throw new Error(message);
        }
        if ('data' in envelope)
            return envelope.data;
    }
    return payload;
}
async function requestQveris(path, body, options) {
    const url = new URL(`${QVERIS_CONFIG.BASE_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${requireApiKey()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new Error(`Qveris 返回了无效 JSON (HTTP ${response.status})`);
        }
        if (!response.ok) {
            throw new Error(`Qveris 请求失败：${describeApiError(response.status, payload)}`);
        }
        return unwrapEnvelope(payload);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Qveris 请求超时（${options.timeoutMs}ms）`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
export function createQverisSessionId() {
    return `financemcp_${randomUUID()}`;
}
export async function discoverQverisCapabilities(args) {
    return requestQveris('/search', {
        query: args.query,
        limit: args.limit,
        session_id: args.sessionId,
    }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
}
export async function inspectQverisCapabilities(args) {
    return requestQveris('/tools/by-ids', {
        tool_ids: args.toolIds,
        ...(args.searchId ? { search_id: args.searchId } : {}),
        session_id: args.sessionId,
    }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
}
export async function callQverisCapability(args) {
    return requestQveris('/tools/execute', {
        search_id: args.searchId,
        session_id: args.sessionId,
        ...(args.model ? { model: args.model } : {}),
        parameters: args.parameters,
        max_response_size: args.maxResponseSize,
    }, {
        timeoutMs: QVERIS_CONFIG.EXECUTE_TIMEOUT,
        query: { tool_id: args.toolId },
    });
}
