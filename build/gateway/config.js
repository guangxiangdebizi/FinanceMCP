import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeBaseUrl, parsePositiveInteger, sanitizeIdentifier, timingSafeTokenHash, } from './utils.js';
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'anthropic']);
const CACHE_PROVIDERS = new Set(['openai', 'anthropic', 'deepseek', 'generic', 'none']);
function parseBoolean(value, fallback) {
    if (value === undefined)
        return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
function readConfigFile(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read CACHE_GATEWAY_CONFIG ${path}: ${message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('CACHE_GATEWAY_CONFIG must contain a JSON object');
    }
    const config = parsed;
    if (config.version !== 1)
        throw new Error('CACHE_GATEWAY_CONFIG version must be 1');
    return config;
}
function validateClient(client, index) {
    if (!/^[a-f0-9]{64}$/i.test(client.tokenHash ?? '')) {
        throw new Error(`clients[${index}].tokenHash must be a SHA-256 hex digest`);
    }
    return {
        tokenHash: client.tokenHash.toLowerCase(),
        tenantId: sanitizeIdentifier(client.tenantId, 'local'),
        workspaceId: sanitizeIdentifier(client.workspaceId, 'default'),
        label: client.label?.trim() || undefined,
    };
}
function validateRoute(route, index) {
    if (!route.id?.trim())
        throw new Error(`models[${index}].id is required`);
    if (!route.upstream?.baseUrl?.trim())
        throw new Error(`models[${index}].upstream.baseUrl is required`);
    if (!PROTOCOLS.has(route.upstream.protocol)) {
        throw new Error(`models[${index}].upstream.protocol is invalid`);
    }
    if (!route.upstream.apiKeyEnv?.trim()) {
        throw new Error(`models[${index}].upstream.apiKeyEnv is required`);
    }
    if (route.cache?.provider && !CACHE_PROVIDERS.has(route.cache.provider)) {
        throw new Error(`models[${index}].cache.provider is invalid`);
    }
    if (route.cache?.mode && !['automatic', 'explicit'].includes(route.cache.mode)) {
        throw new Error(`models[${index}].cache.mode is invalid`);
    }
    if (route.cache?.ttl && !['5m', '1h', '30m'].includes(route.cache.ttl)) {
        throw new Error(`models[${index}].cache.ttl is invalid`);
    }
    const cacheProvider = route.cache?.provider ?? 'none';
    if (cacheProvider === 'openai' && !['openai-chat', 'openai-responses'].includes(route.upstream.protocol)) {
        throw new Error(`models[${index}] OpenAI cache requires an OpenAI upstream protocol`);
    }
    if (cacheProvider === 'anthropic' && route.upstream.protocol !== 'anthropic') {
        throw new Error(`models[${index}] Anthropic cache requires an Anthropic upstream protocol`);
    }
    if (cacheProvider === 'deepseek' && route.upstream.protocol !== 'openai-chat') {
        throw new Error(`models[${index}] DeepSeek cache requires the openai-chat upstream protocol`);
    }
    if (route.cache?.mode === 'explicit' && cacheProvider !== 'openai') {
        throw new Error(`models[${index}] explicit cache mode is only supported for OpenAI`);
    }
    if (route.cache?.ttl === '30m' && cacheProvider !== 'openai') {
        throw new Error(`models[${index}] 30m cache TTL is only supported for OpenAI`);
    }
    if (['5m', '1h'].includes(route.cache?.ttl ?? '') && cacheProvider !== 'anthropic') {
        throw new Error(`models[${index}] 5m/1h cache TTL is only supported for Anthropic`);
    }
    const positiveFields = [
        ['upstream.timeoutMs', route.upstream.timeoutMs],
        ['defaultMaxOutputTokens', route.defaultMaxOutputTokens],
        ['handoff.resumeWindowMinutes', route.handoff?.resumeWindowMinutes],
        ['handoff.maxMessages', route.handoff?.maxMessages],
        ['handoff.maxCharacters', route.handoff?.maxCharacters],
    ];
    for (const [name, value] of positiveFields) {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
            throw new Error(`models[${index}].${name} must be a positive integer`);
        }
    }
    return {
        ...route,
        id: route.id.trim(),
        aliases: (route.aliases ?? []).map(value => value.trim()).filter(Boolean),
        upstream: {
            ...route.upstream,
            baseUrl: normalizeBaseUrl(route.upstream.baseUrl),
            apiKeyEnv: route.upstream.apiKeyEnv.trim(),
            timeoutMs: route.upstream.timeoutMs ?? 600_000,
        },
        allowCrossProtocol: route.allowCrossProtocol ?? true,
        defaultMaxOutputTokens: route.defaultMaxOutputTokens ?? 4096,
        cache: {
            provider: cacheProvider,
            enabled: route.cache?.enabled ?? cacheProvider !== 'none',
            mode: route.cache?.mode ?? 'automatic',
            ttl: route.cache?.ttl,
        },
        handoff: {
            enabled: route.handoff?.enabled ?? true,
            autoResume: route.handoff?.autoResume ?? true,
            resumeWindowMinutes: route.handoff?.resumeWindowMinutes ?? 120,
            maxMessages: route.handoff?.maxMessages ?? 8,
            maxCharacters: route.handoff?.maxCharacters ?? 8_000,
        },
    };
}
function envClient() {
    const token = process.env.CACHE_GATEWAY_API_KEY?.trim();
    if (!token)
        return [];
    return [{
            tokenHash: timingSafeTokenHash(token),
            tenantId: sanitizeIdentifier(process.env.CACHE_TENANT_ID ?? 'local', 'local'),
            workspaceId: sanitizeIdentifier(process.env.CACHE_WORKSPACE_ID ?? 'default', 'default'),
            label: 'environment',
        }];
}
function envRoute() {
    const baseUrl = process.env.CACHE_UPSTREAM_BASE_URL?.trim();
    const model = process.env.CACHE_UPSTREAM_MODEL?.trim();
    if (!baseUrl || !model)
        return [];
    const rawProtocol = process.env.CACHE_UPSTREAM_PROTOCOL?.trim() || 'openai-responses';
    if (!PROTOCOLS.has(rawProtocol)) {
        throw new Error(`Invalid CACHE_UPSTREAM_PROTOCOL: ${rawProtocol}`);
    }
    const rawProvider = process.env.CACHE_PROVIDER?.trim()
        || (rawProtocol === 'anthropic' ? 'anthropic' : 'generic');
    if (!CACHE_PROVIDERS.has(rawProvider)) {
        throw new Error(`Invalid CACHE_PROVIDER: ${rawProvider}`);
    }
    return [validateRoute({
            id: process.env.CACHE_MODEL_ALIAS?.trim() || model,
            aliases: model === process.env.CACHE_MODEL_ALIAS?.trim() ? [] : [model],
            upstream: {
                protocol: rawProtocol,
                baseUrl,
                model,
                apiKeyEnv: 'CACHE_UPSTREAM_API_KEY',
            },
            cache: {
                provider: rawProvider,
                enabled: parseBoolean(process.env.CACHE_NATIVE_CACHE_ENABLED, true),
                mode: process.env.CACHE_NATIVE_CACHE_MODE === 'explicit' ? 'explicit' : 'automatic',
                ttl: process.env.CACHE_NATIVE_CACHE_TTL,
            },
        }, 0)];
}
export function loadGatewayConfig() {
    const configPath = process.env.CACHE_GATEWAY_CONFIG?.trim();
    const file = configPath ? readConfigFile(resolve(configPath)) : undefined;
    const clients = [...(file?.clients ?? []), ...envClient()].map(validateClient);
    const models = [...(file?.models ?? []), ...envRoute()].map(validateRoute);
    const routeNames = new Set();
    for (const route of models) {
        for (const name of [route.id, ...(route.aliases ?? [])]) {
            const normalized = name.toLowerCase();
            if (routeNames.has(normalized))
                throw new Error(`Duplicate model route or alias: ${name}`);
            routeNames.add(normalized);
        }
    }
    const clientHashes = new Set();
    for (const client of clients) {
        if (clientHashes.has(client.tokenHash)) {
            throw new Error('The same Gateway API key hash cannot be assigned to multiple clients');
        }
        clientHashes.add(client.tokenHash);
    }
    const allowAnonymous = parseBoolean(process.env.CACHE_GATEWAY_ALLOW_ANONYMOUS, file?.allowAnonymous ?? false);
    if (allowAnonymous && !['127.0.0.1', 'localhost', '::1'].includes(process.env.CACHE_GATEWAY_HOST ?? '127.0.0.1')) {
        throw new Error('Anonymous mode is only allowed when CACHE_GATEWAY_HOST is loopback');
    }
    return {
        host: process.env.CACHE_GATEWAY_HOST?.trim() || '127.0.0.1',
        port: parsePositiveInteger(process.env.CACHE_GATEWAY_PORT, 3210),
        dataDir: resolve(process.env.CACHE_GATEWAY_DATA_DIR?.trim() || `${homedir()}/.finance-mcp/cache-gateway`),
        configPath: configPath ? resolve(configPath) : undefined,
        clients,
        models,
        allowAnonymous,
        maxRequestBytes: parsePositiveInteger(process.env.CACHE_GATEWAY_MAX_REQUEST_BYTES, 20 * 1024 * 1024),
    };
}
export function resolveModelRoute(config, requestedModel) {
    const target = requestedModel.trim().toLowerCase();
    return config.models.find(route => route.id.toLowerCase() === target || (route.aliases ?? []).some(alias => alias.toLowerCase() === target));
}
