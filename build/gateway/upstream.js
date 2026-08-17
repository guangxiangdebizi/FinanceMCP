function upstreamEndpoint(route, endpoint) {
    const base = route.upstream.baseUrl.replace(/\/+$/, '');
    if (endpoint === 'count_tokens') {
        if (route.upstream.protocol !== 'anthropic')
            throw new Error('Exact count_tokens requires an Anthropic upstream');
        return `${base}/messages/count_tokens`;
    }
    if (route.upstream.protocol === 'openai-responses')
        return `${base}/responses`;
    if (route.upstream.protocol === 'openai-chat')
        return `${base}/chat/completions`;
    return `${base}/messages`;
}
export function requireUpstreamApiKey(route) {
    const apiKey = process.env[route.upstream.apiKeyEnv]?.trim();
    if (!apiKey)
        throw new Error(`Upstream API key environment variable is not set: ${route.upstream.apiKeyEnv}`);
    return apiKey;
}
function buildHeaders(route, apiKey, sourceHeaders) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: sourceHeaders.accept || 'application/json',
        ...route.upstream.headers,
    };
    if (route.upstream.protocol === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = sourceHeaders['anthropic-version'] || '2023-06-01';
        if (sourceHeaders['anthropic-beta'])
            headers['anthropic-beta'] = sourceHeaders['anthropic-beta'];
    }
    else {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    for (const [name, envName] of Object.entries(route.upstream.headersEnv ?? {})) {
        const value = process.env[envName]?.trim();
        if (value)
            headers[name] = value;
    }
    return headers;
}
export async function callUpstream(route, apiKey, options) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), route.upstream.timeoutMs ?? 600_000);
    const abort = () => timeoutController.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        return await fetch(upstreamEndpoint(route, options.endpoint ?? 'inference'), {
            method: 'POST',
            headers: buildHeaders(route, apiKey, options.sourceHeaders),
            body: JSON.stringify(options.body),
            signal: timeoutController.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Upstream request aborted or exceeded ${route.upstream.timeoutMs ?? 600_000}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
    }
}
export function protocolContentType(protocol, stream) {
    if (stream)
        return 'text/event-stream; charset=utf-8';
    return 'application/json; charset=utf-8';
}
