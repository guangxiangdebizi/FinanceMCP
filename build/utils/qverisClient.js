import { randomUUID } from 'node:crypto';
import { QVERIS_CONFIG } from '../config.js';
export class QverisClientError extends Error {
    kind;
    status;
    constructor(kind, message, status) {
        super(message);
        this.kind = kind;
        this.status = status;
        this.name = 'QverisClientError';
    }
}
function requireApiKey() {
    const apiKey = QVERIS_CONFIG.API_KEY;
    if (!apiKey) {
        throw new QverisClientError('not_configured', 'Qveris 未配置，请通过 X-Qveris-Api-Key 请求头或 QVERIS_API_KEY 环境变量提供凭证。');
    }
    return apiKey;
}
function classifyStatus(status) {
    if (status === 401 || status === 403)
        return 'auth';
    if (status === 402)
        return 'quota';
    if (status === 429)
        return 'rate_limit';
    if (status >= 500)
        return 'unavailable';
    return 'request';
}
function statusMessage(status) {
    if (status === 401 || status === 403)
        return 'Qveris 凭证无效或无权访问';
    if (status === 402)
        return 'Qveris credits 不足';
    if (status === 429)
        return 'Qveris 请求达到频率限制';
    if (status >= 500)
        return 'Qveris 服务暂时不可用';
    return `Qveris 请求未被接受（HTTP ${status}）`;
}
function unwrapEnvelope(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new QverisClientError('invalid_response', 'Qveris 返回格式无效');
    }
    const envelope = payload;
    if ('status' in envelope) {
        if (envelope.status !== 'success') {
            const status = typeof envelope.status_code === 'number' ? envelope.status_code : undefined;
            throw new QverisClientError(status ? classifyStatus(status) : 'request', status ? statusMessage(status) : 'Qveris 返回失败状态', status);
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
                'Accept-Language': 'zh',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > QVERIS_CONFIG.MAX_RESPONSE_BYTES) {
            throw new QverisClientError('invalid_response', 'Qveris 响应超过安全大小限制');
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > QVERIS_CONFIG.MAX_RESPONSE_BYTES) {
            throw new QverisClientError('invalid_response', 'Qveris 响应超过安全大小限制');
        }
        let payload;
        try {
            payload = JSON.parse(raw);
        }
        catch {
            throw new QverisClientError('invalid_response', 'Qveris 返回了无效 JSON');
        }
        if (!response.ok) {
            throw new QverisClientError(classifyStatus(response.status), statusMessage(response.status), response.status);
        }
        return unwrapEnvelope(payload);
    }
    catch (error) {
        if (error instanceof QverisClientError)
            throw error;
        if (error instanceof Error && error.name === 'AbortError') {
            throw new QverisClientError('timeout', 'Qveris 请求超时');
        }
        throw new QverisClientError('unavailable', '无法连接 Qveris 服务');
    }
    finally {
        clearTimeout(timeoutId);
    }
}
export function createQverisSessionId() {
    return `financemcp_${randomUUID()}`;
}
export async function discoverQverisCapabilities(args) {
    const query = args.query.trim().slice(0, 400);
    const response = await requestQveris('/search', {
        query,
        limit: Math.min(10, Math.max(1, Math.floor(args.limit ?? 8))),
        session_id: args.sessionId,
        lang: 'zh',
    }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
    if (!response.search_id || !Array.isArray(response.results)) {
        throw new QverisClientError('invalid_response', 'Qveris Discover 响应缺少必要字段');
    }
    if (response.error_message) {
        const quota = response.remaining_credits === 0 || /credit/i.test(response.error_message);
        throw new QverisClientError(quota ? 'quota' : 'request', quota ? 'Qveris credits 不足' : 'Qveris Discover 失败');
    }
    return response;
}
export async function inspectQverisCapabilities(args) {
    const response = await requestQveris('/tools/by-ids', {
        tool_ids: args.toolIds.slice(0, 10),
        search_id: args.searchId,
        session_id: args.sessionId,
        view: 'full',
    }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
    if (!Array.isArray(response.results)) {
        throw new QverisClientError('invalid_response', 'Qveris Inspect 响应缺少结果列表');
    }
    return response;
}
export async function probeQverisCapability(args) {
    return requestQveris('/tools/probe', {
        parameters: args.parameters,
        checks: ['schema', 'quote'],
        live_budget: 'none',
    }, {
        timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT,
        query: { tool_id: args.toolId },
    });
}
export async function callQverisCapability(args) {
    return requestQveris('/tools/execute', {
        search_id: args.searchId,
        session_id: args.sessionId,
        model: 'FinanceMCP',
        parameters: args.parameters,
        max_response_size: 20480,
    }, {
        timeoutMs: QVERIS_CONFIG.EXECUTE_TIMEOUT,
        query: { tool_id: args.toolId },
    });
}
