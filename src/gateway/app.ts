import { randomUUID } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { authenticateRequest, GatewayAuthenticationError } from './auth.js';
import {
  canonicalPrefixDigest,
  canonicalRequestDigest,
  cloneRequestBody,
  injectHandoffIntoBody,
  parseCanonicalRequest,
  parseCanonicalResponse,
  renderCanonicalRequest,
  UnsupportedGatewayFeatureError,
} from './canonical.js';
import { applyNativeCachePolicy, buildModelFingerprint } from './cachePolicy.js';
import { loadGatewayConfig, resolveModelRoute } from './config.js';
import {
  parseCanonicalStream,
  renderCanonicalResponse,
  renderCanonicalStream,
} from './responseTranslation.js';
import { GatewayStateStore } from './stateStore.js';
import {
  CanonicalRequest,
  CanonicalResponse,
  GatewayHandoffPolicy,
  GatewayIdentity,
  GatewayModelRoute,
  GatewayProtocol,
  ResolvedGatewayConfig,
  StoredRequestEvent,
} from './types.js';
import { callUpstream, protocolContentType, requireUpstreamApiKey } from './upstream.js';
import { isRecord, nowIso, stableJson } from './utils.js';

interface GatewayAppOptions {
  config?: ResolvedGatewayConfig;
  store?: GatewayStateStore;
}

export interface GatewayAppRuntime {
  app: express.Express;
  config: ResolvedGatewayConfig;
  store: GatewayStateStore;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function requestProtocol(req: Request): GatewayProtocol {
  if (req.path.endsWith('/chat/completions')) return 'openai-chat';
  if (req.path.endsWith('/responses')) return 'openai-responses';
  return 'anthropic';
}

function sourceHeaders(req: Request): Record<string, string | undefined> {
  return {
    accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
    'anthropic-version': typeof req.headers['anthropic-version'] === 'string'
      ? req.headers['anthropic-version'] : undefined,
    'anthropic-beta': typeof req.headers['anthropic-beta'] === 'string'
      ? req.headers['anthropic-beta'] : undefined,
  };
}

function clientKind(req: Request, protocol: GatewayProtocol): string {
  const explicit = req.headers['x-fmc-client'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 64);
  if (typeof req.headers['x-claude-code-session-id'] === 'string') return 'claude-code';
  const agent = String(req.headers['user-agent'] ?? '').toLowerCase();
  if (agent.includes('cursor')) return 'cursor';
  if (agent.includes('trae')) return 'trae';
  if (agent.includes('codex')) return 'codex';
  if (agent.includes('claude')) return 'claude-code';
  return protocol;
}

function clientSessionId(req: Request): string | undefined {
  const names = [
    'x-claude-code-session-id',
    'x-fmc-client-session-id',
    'x-session-id',
  ];
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function explicitContextId(req: Request, body: Record<string, unknown>): string | undefined {
  const header = req.headers['x-fmc-context-id'] ?? req.headers['x-finance-context'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (isRecord(body.metadata) && typeof body.metadata.fmc_context_id === 'string') {
    return body.metadata.fmc_context_id.trim() || undefined;
  }
  return undefined;
}

function bodyWithoutGatewayMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneRequestBody(body);
  if (!isRecord(cloned.metadata) || !Object.hasOwn(cloned.metadata, 'fmc_context_id')) return cloned;
  const metadata = { ...cloned.metadata };
  delete metadata.fmc_context_id;
  if (Object.keys(metadata).length) cloned.metadata = metadata;
  else delete cloned.metadata;
  return cloned;
}

function requiredHandoffPolicy(route: GatewayModelRoute): Required<GatewayHandoffPolicy> {
  return {
    enabled: route.handoff?.enabled ?? true,
    autoResume: route.handoff?.autoResume ?? true,
    resumeWindowMinutes: route.handoff?.resumeWindowMinutes ?? 120,
    maxMessages: route.handoff?.maxMessages ?? 8,
    maxCharacters: route.handoff?.maxCharacters ?? 8_000,
  };
}

function copySafeUpstreamHeaders(upstream: globalThis.Response, res: Response): void {
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === 'retry-after'
      || lower === 'x-request-id'
      || lower === 'request-id'
      || lower.startsWith('x-ratelimit-')
      || lower.startsWith('anthropic-ratelimit-')) {
      res.setHeader(name, value);
    }
  }
}

function setGatewayHeaders(
  res: Response,
  contextId: string,
  matchMode: string,
  handoffInjected: boolean,
  cacheProvider: string,
  cacheMode: string
): void {
  res.setHeader('X-FMC-Context-Id', contextId);
  res.setHeader('X-FMC-Context-Match', matchMode);
  res.setHeader('X-FMC-Handoff', handoffInjected ? 'injected' : 'none');
  res.setHeader('X-FMC-Cache-Provider', cacheProvider);
  res.setHeader('X-FMC-Cache-Mode', cacheMode);
}

function bodyRecord(req: Request): Record<string, unknown> {
  if (!isRecord(req.body)) throw new Error('Request body must be a JSON object');
  return req.body;
}

function upstreamBody(
  inboundProtocol: GatewayProtocol,
  route: GatewayModelRoute,
  bodyWithHandoff: Record<string, unknown>,
  canonicalWithHandoff: CanonicalRequest
): { body: Record<string, unknown>; translated: boolean } {
  const upstreamModel = route.upstream.model ?? canonicalWithHandoff.requestedModel;
  if (inboundProtocol === route.upstream.protocol) {
    const body = cloneRequestBody(bodyWithHandoff);
    body.model = upstreamModel;
    return { body, translated: false };
  }
  if (route.allowCrossProtocol === false) {
    throw new UnsupportedGatewayFeatureError([`${inboundProtocol} -> ${route.upstream.protocol}`]);
  }
  return {
    body: renderCanonicalRequest(
      canonicalWithHandoff,
      route.upstream.protocol,
      upstreamModel,
      route.defaultMaxOutputTokens ?? 4096
    ),
    translated: true,
  };
}

async function upstreamError(upstream: globalThis.Response): Promise<string> {
  const text = await upstream.text();
  if (!text) return `Upstream HTTP ${upstream.status}`;
  try {
    const payload = JSON.parse(text);
    if (isRecord(payload)) {
      const nested = isRecord(payload.error) ? payload.error.message : undefined;
      const message = nested ?? payload.message ?? payload.detail ?? payload.error;
      if (typeof message === 'string') return message.slice(0, 2_000);
    }
  } catch {
    // Return a bounded plain-text upstream error.
  }
  return text.slice(0, 2_000);
}

async function streamAndCapture(
  upstream: globalThis.Response,
  res: Response,
  protocol: GatewayProtocol,
  maxCaptureBytes = 8 * 1024 * 1024
): Promise<CanonicalResponse | undefined> {
  if (!upstream.body) {
    return undefined;
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let captured = '';
  let capturedBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    res.write(Buffer.from(value));
    if (capturedBytes < maxCaptureBytes) {
      const remaining = maxCaptureBytes - capturedBytes;
      const selected = value.byteLength <= remaining ? value : value.slice(0, remaining);
      captured += decoder.decode(selected, { stream: true });
      capturedBytes += selected.byteLength;
    }
  }
  captured += decoder.decode();
  return parseCanonicalStream(protocol, captured);
}

function protocolError(res: Response, protocol: GatewayProtocol, status: number, message: string): void {
  if (protocol === 'anthropic') {
    res.status(status).json({ type: 'error', error: { type: 'invalid_request_error', message } });
  } else {
    res.status(status).json({ error: { type: 'invalid_request_error', message } });
  }
}

async function handleInference(
  req: Request,
  res: Response,
  config: ResolvedGatewayConfig,
  store: GatewayStateStore
): Promise<void> {
  const startedAt = Date.now();
  const inboundProtocol = requestProtocol(req);
  const identity = authenticateRequest(req, config);
  const originalBody = bodyRecord(req);
  const canonicalOriginal = parseCanonicalRequest(inboundProtocol, originalBody);
  const route = resolveModelRoute(config, canonicalOriginal.requestedModel);
  if (!route) {
    protocolError(res, inboundProtocol, 404, `No gateway route for model: ${canonicalOriginal.requestedModel}`);
    return;
  }

  const apiKey = requireUpstreamApiKey(route);
  const modelFingerprint = buildModelFingerprint(route, apiKey);
  const kind = clientKind(req, inboundProtocol);
  const sessionId = clientSessionId(req);
  const resolution = await store.resolveContext(identity, modelFingerprint, canonicalOriginal, {
    explicitContextId: explicitContextId(req, originalBody),
    clientKind: kind,
    clientSessionId: sessionId,
    handoff: requiredHandoffPolicy(route),
  });

  const forwardableBody = bodyWithoutGatewayMetadata(originalBody);
  const bodyWithHandoff = resolution.handoffText
    ? injectHandoffIntoBody(forwardableBody, inboundProtocol, resolution.handoffText)
    : forwardableBody;
  const canonicalWithHandoff = parseCanonicalRequest(inboundProtocol, bodyWithHandoff);
  const prepared = upstreamBody(inboundProtocol, route, bodyWithHandoff, canonicalWithHandoff);
  const requestedStream = canonicalOriginal.stream;
  if (prepared.translated) prepared.body.stream = false;

  const providerCacheKey = store.deriveProviderCacheKey(identity, resolution.context.id, modelFingerprint);
  const appliedPolicy = applyNativeCachePolicy(
    prepared.body,
    route.upstream.protocol,
    route,
    providerCacheKey
  );
  const prefixDigest = canonicalPrefixDigest(canonicalWithHandoff, modelFingerprint);
  const requestDigest = canonicalRequestDigest(canonicalWithHandoff, modelFingerprint);

  setGatewayHeaders(
    res,
    resolution.context.id,
    resolution.matchMode,
    resolution.handoffInjected,
    appliedPolicy.provider,
    appliedPolicy.mode
  );
  if (prepared.translated && requestedStream) res.setHeader('X-FMC-Stream-Mode', 'buffered-translation');

  await store.recordRequestMessages(resolution.context.id, canonicalOriginal);
  const eventId = `evt_${randomUUID()}`;
  const event: StoredRequestEvent = {
    id: eventId,
    contextId: resolution.context.id,
    createdAt: nowIso(),
    protocol: inboundProtocol,
    clientKind: kind,
    requestDigest,
    prefixDigest,
    cacheProvider: route.cache?.provider ?? 'none',
    handoffInjected: resolution.handoffInjected,
    matchMode: resolution.matchMode,
  };
  await store.recordEvent(event);

  const disconnectController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) disconnectController.abort();
  });

  try {
    const upstream = await callUpstream(route, apiKey, {
      body: prepared.body,
      sourceHeaders: sourceHeaders(req),
      signal: disconnectController.signal,
    });
    copySafeUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const message = await upstreamError(upstream);
      await store.updateEvent(eventId, {
        upstreamStatus: upstream.status,
        durationMs: Date.now() - startedAt,
        error: `Upstream HTTP ${upstream.status}`,
      });
      protocolError(res, inboundProtocol, upstream.status, message);
      return;
    }

    let canonicalResponse: CanonicalResponse | undefined;
    if (!prepared.translated && requestedStream) {
      res.status(upstream.status);
      res.setHeader('Content-Type', protocolContentType(inboundProtocol, true));
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      canonicalResponse = await streamAndCapture(upstream, res, route.upstream.protocol);
    } else {
      const payload = await upstream.json();
      canonicalResponse = parseCanonicalResponse(route.upstream.protocol, payload);
      if (canonicalResponse.usage.cachedInputTokens !== undefined) {
        res.setHeader('X-FMC-Cache-Read-Tokens', canonicalResponse.usage.cachedInputTokens);
      }
      if (prepared.translated) {
        if (requestedStream) {
          res.status(200);
          res.setHeader('Content-Type', protocolContentType(inboundProtocol, true));
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.end(renderCanonicalStream(inboundProtocol, canonicalResponse, canonicalOriginal.requestedModel));
        } else {
          res.status(200).json(renderCanonicalResponse(
            inboundProtocol,
            canonicalResponse,
            canonicalOriginal.requestedModel
          ));
        }
      } else {
        res.status(upstream.status).json(payload);
      }
    }

    if (canonicalResponse) {
      await store.recordResponse(resolution.context.id, canonicalResponse);
      await store.updateEvent(eventId, {
        upstreamStatus: upstream.status,
        durationMs: Date.now() - startedAt,
        cacheReadTokens: canonicalResponse.usage.cachedInputTokens,
        cacheWriteTokens: canonicalResponse.usage.cacheWriteTokens,
        inputTokens: canonicalResponse.usage.inputTokens,
        outputTokens: canonicalResponse.usage.outputTokens,
      });
    } else {
      await store.updateEvent(eventId, {
        upstreamStatus: upstream.status,
        durationMs: Date.now() - startedAt,
      });
    }
    if (!prepared.translated && requestedStream && !res.writableEnded) res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateEvent(eventId, {
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 500),
    });
    if (!res.headersSent) throw error;
    if (!res.writableEnded) res.end();
  }
}

function contextResponse(context: ReturnType<GatewayStateStore['getContext']>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return {
    id: context.id,
    tenant_id: context.tenantId,
    workspace_id: context.workspaceId,
    model_fingerprint: context.modelFingerprint.slice(0, 16),
    parent_context_id: context.parentContextId,
    created_at: context.createdAt,
    updated_at: context.updatedAt,
    active: context.active,
    client_kinds: context.clientKinds,
    message_count: context.messages.length || context.messageDigests.length,
    ...(context.messages.length ? { messages: context.messages } : {}),
  };
}

function identityFor(req: Request, config: ResolvedGatewayConfig): GatewayIdentity {
  return authenticateRequest(req, config);
}

export async function createGatewayApp(options: GatewayAppOptions = {}): Promise<GatewayAppRuntime> {
  const config = options.config ?? loadGatewayConfig();
  const store = options.store ?? new GatewayStateStore(config.dataDir);
  if (!options.store) await store.initialize();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Accept', 'Authorization', 'X-Api-Key',
      'Anthropic-Version', 'Anthropic-Beta', 'X-Claude-Code-Session-Id',
      'X-FMC-Client', 'X-FMC-Client-Session-Id', 'X-FMC-Context-Id',
    ],
    exposedHeaders: [
      'X-FMC-Context-Id', 'X-FMC-Context-Match', 'X-FMC-Handoff',
      'X-FMC-Cache-Provider', 'X-FMC-Cache-Mode', 'X-FMC-Cache-Read-Tokens',
      'X-FMC-Stream-Mode',
    ],
  }));
  app.use(express.json({ limit: config.maxRequestBytes }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'finance-cache-gateway',
      configuredModels: config.models.length,
      configuredClients: config.clients.length,
      anonymous: config.allowAnonymous,
    });
  });

  app.get('/v1/models', asyncRoute(async (req, res) => {
    identityFor(req, config);
    const wantsAnthropic = typeof req.headers['anthropic-version'] === 'string'
      || String(req.headers['user-agent'] ?? '').toLowerCase().includes('claude');
    if (wantsAnthropic) {
      const data = config.models.map(route => ({
        type: 'model',
        id: route.id,
        display_name: route.displayName ?? route.id,
        created_at: '2026-01-01T00:00:00Z',
      }));
      res.json({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
      return;
    }
    res.json({
      object: 'list',
      data: config.models.map(route => ({
        id: route.id,
        object: 'model',
        created: 0,
        owned_by: 'finance-cache-gateway',
      })),
    });
  }));

  app.post('/v1/responses', asyncRoute(async (req, res) => {
    await handleInference(req, res, config, store);
  }));
  app.post('/v1/chat/completions', asyncRoute(async (req, res) => {
    await handleInference(req, res, config, store);
  }));
  app.post('/v1/messages', asyncRoute(async (req, res) => {
    await handleInference(req, res, config, store);
  }));

  app.post('/v1/messages/count_tokens', asyncRoute(async (req, res) => {
    identityFor(req, config);
    const body = bodyRecord(req);
    const canonical = parseCanonicalRequest('anthropic', body);
    const route = resolveModelRoute(config, canonical.requestedModel);
    if (!route) {
      protocolError(res, 'anthropic', 404, `No gateway route for model: ${canonical.requestedModel}`);
      return;
    }
    if (route.upstream.protocol === 'anthropic') {
      const forwarded = cloneRequestBody(body);
      forwarded.model = route.upstream.model ?? canonical.requestedModel;
      const upstream = await callUpstream(route, requireUpstreamApiKey(route), {
        body: forwarded,
        sourceHeaders: sourceHeaders(req),
        endpoint: 'count_tokens',
      });
      copySafeUpstreamHeaders(upstream, res);
      const payload = await upstream.text();
      res.status(upstream.status).type('application/json').send(payload);
      return;
    }
    const roughApproximation = Math.max(1, Math.ceil(Buffer.byteLength(stableJson(canonical), 'utf8') / 4));
    res.setHeader('X-FMC-Token-Count-Mode', 'rough-approximation');
    res.json({ input_tokens: roughApproximation });
  }));

  app.get('/cache/v1/contexts', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    const includeMessages = req.query.include_messages === 'true' || req.query.include_messages === '1';
    res.json({
      data: store.listContexts(identity, includeMessages).map(context => contextResponse(context)),
    });
  }));

  app.get('/cache/v1/contexts/:id', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    const context = contextResponse(store.getContext(identity, req.params.id, true));
    if (!context) {
      res.status(404).json({ error: { message: 'Context not found' } });
      return;
    }
    res.json(context);
  }));

  app.post('/cache/v1/contexts/:id/activate', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    res.json(contextResponse(await store.activateContext(identity, req.params.id)));
  }));

  app.post('/cache/v1/contexts/:id/fork', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    res.status(201).json(contextResponse(await store.forkContext(identity, req.params.id)));
  }));

  app.delete('/cache/v1/contexts/:id', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    const deleted = await store.deleteContext(identity, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: { message: 'Context not found' } });
      return;
    }
    res.status(204).end();
  }));

  app.get('/cache/v1/metrics', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    res.json(store.metrics(identity));
  }));

  app.get('/metrics', asyncRoute(async (req, res) => {
    const identity = identityFor(req, config);
    const metrics = store.metrics(identity);
    res.type('text/plain; version=0.0.4').send([
      '# TYPE finance_cache_gateway_requests_total counter',
      `finance_cache_gateway_requests_total ${metrics.requests}`,
      '# TYPE finance_cache_gateway_errors_total counter',
      `finance_cache_gateway_errors_total ${metrics.errors}`,
      '# TYPE finance_cache_gateway_cache_read_tokens_total counter',
      `finance_cache_gateway_cache_read_tokens_total ${metrics.cacheReadTokens}`,
      '# TYPE finance_cache_gateway_cache_write_tokens_total counter',
      `finance_cache_gateway_cache_write_tokens_total ${metrics.cacheWriteTokens}`,
      '# TYPE finance_cache_gateway_handoffs_total counter',
      `finance_cache_gateway_handoffs_total ${metrics.handoffs}`,
      '# TYPE finance_cache_gateway_contexts gauge',
      `finance_cache_gateway_contexts ${metrics.contexts}`,
      '',
    ].join('\n'));
  }));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const protocol = req.path.includes('/messages') ? 'anthropic' : requestProtocol(req);
    const message = error instanceof Error ? error.message : 'Unexpected gateway error';
    const status = error instanceof GatewayAuthenticationError
      ? error.statusCode
      : error instanceof UnsupportedGatewayFeatureError ? 422 : 400;
    protocolError(res, protocol, status, message);
  });

  return { app, config, store };
}
