#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { parseSourcePriority, runWithRequestContext } from "./config.js";
import { getAvailableToolList, dispatchTool } from "./dispatch.js";
import { SERVER_VERSION } from "./version.js";


interface Session { id: string; createdAt: Date; lastActivity: Date }
const sessions = new Map<string, Session>();
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 1000);

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-tushare-token',
  'x-qveris-api-key',
  'x-twingly-api-key',
  'x-wusla-signature',
  'x-cg-api-key',
  'x-cg-demo-api-key',
  'x-cg-pro-api-key',
  'x-smithery-config',
  'x-config',
  'x-session-config',
]);

function redactHeaders(headers: Request['headers']): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) && value ? '[REDACTED]' : value,
    ])
  );
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    for (const key of ['tushare_token', 'TUSHARE_TOKEN']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl.split('?')[0];
  }
}

function parseConfigHeader(req: Request): Record<string, unknown> | undefined {
  const raw = req.headers['x-smithery-config'] || req.headers['x-config'] || req.headers['x-session-config'];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    console.log('[TOKEN] Failed to parse request config header');
    return undefined;
  }
}

// Client authentication and data-source credentials are separate concerns:
// - MCP_AUTH_TOKEN set: `Authorization: Bearer` authenticates the MCP client
//   and is never forwarded to Tushare.
// - MCP_AUTH_TOKEN unset: legacy behaviour, Bearer is read as a Tushare token
//   unless MCP_BEARER_AS_TUSHARE_TOKEN=0.
// - MCP_ACCEPT_REQUEST_CREDENTIALS=0: ignore every request-supplied data-source
//   credential and use only the server environment.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || '';
const BEARER_AS_TUSHARE_TOKEN = !MCP_AUTH_TOKEN && process.env.MCP_BEARER_AS_TUSHARE_TOKEN !== '0';
const ACCEPT_REQUEST_CREDENTIALS = process.env.MCP_ACCEPT_REQUEST_CREDENTIALS !== '0';

function bearerToken(req: Request): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

function isClientAuthorized(req: Request): boolean {
  if (!MCP_AUTH_TOKEN) return true;
  const presented = Buffer.from(bearerToken(req) ?? '');
  const expected = Buffer.from(MCP_AUTH_TOKEN);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function extractTokenFromHeaders(req: Request): string | undefined {
  if (!ACCEPT_REQUEST_CREDENTIALS) return undefined;
  const h = req.headers;
  
  // 1. 尝试从标准请求头读取
  const tokenHeader = (h['x-tushare-token'] || h['x-api-key']) as string | undefined;
  if (tokenHeader && tokenHeader.trim()) {
    console.log(`[TOKEN] Found in X-Tushare-Token/X-Api-Key header`);
    return tokenHeader.trim();
  }
  
  // 2. 尝试从 Authorization Bearer 读取（仅在未启用客户端认证时）
  const bearer = BEARER_AS_TUSHARE_TOKEN ? bearerToken(req) : undefined;
  if (bearer) {
    console.log(`[TOKEN] Found in Authorization Bearer header`);
    return bearer;
  }
  
  // 3. 🔍 尝试从 Smithery 特殊头读取（可能的头名称）
  const smitheryConfig = h['x-smithery-config'] || h['x-config'] || h['x-session-config'];
  if (smitheryConfig) {
    const config = parseConfigHeader(req);
    if (typeof config?.TUSHARE_TOKEN === 'string' && config.TUSHARE_TOKEN.trim()) {
      console.log(`[TOKEN] Extracted Tushare token from request config`);
      return config.TUSHARE_TOKEN.trim();
    }
  }
  
  // 4. 🔍 尝试从查询参数读取
  const query = req.query;
  if (query.tushare_token || query.TUSHARE_TOKEN) {
    console.log(`[TOKEN] Found in query parameters`);
    return (query.tushare_token || query.TUSHARE_TOKEN) as string;
  }
  
  console.log(`[TOKEN] Not found in request, falling back to environment variable`);
  return undefined;
}

function extractQverisApiKeyFromHeaders(req: Request): string | undefined {
  if (!ACCEPT_REQUEST_CREDENTIALS) return undefined;
  const header = req.headers['x-qveris-api-key'];
  if (typeof header === 'string' && header.trim()) {
    console.log('[TOKEN] Found Qveris key in X-Qveris-Api-Key header');
    return header.trim();
  }

  const config = parseConfigHeader(req);
  if (typeof config?.QVERIS_API_KEY === 'string' && config.QVERIS_API_KEY.trim()) {
    console.log('[TOKEN] Extracted Qveris key from request config');
    return config.QVERIS_API_KEY.trim();
  }
  return undefined;
}

function extractTwinglyApiKeyFromHeaders(req: Request): string | undefined {
  if (!ACCEPT_REQUEST_CREDENTIALS) return undefined;
  const header = req.headers['x-twingly-api-key'];
  if (typeof header === 'string' && header.trim()) {
    console.log('[TOKEN] Found Twingly key in X-Twingly-Api-Key header');
    return header.trim();
  }

  const config = parseConfigHeader(req);
  if (typeof config?.TWINGLY_API_KEY === 'string' && config.TWINGLY_API_KEY.trim()) {
    console.log('[TOKEN] Extracted Twingly key from request config');
    return config.TWINGLY_API_KEY.trim();
  }
  return undefined;
}

function extractSourcePriorityFromHeaders(req: Request) {
  if (!ACCEPT_REQUEST_CREDENTIALS) return undefined;
  const header = req.headers['x-finance-source-priority'];
  const config = parseConfigHeader(req);
  const configured = config?.FINANCE_SOURCE_PRIORITY ?? config?.SOURCE_PRIORITY;
  const raw = typeof header === 'string'
    ? header
    : typeof configured === 'string'
      ? configured
      : undefined;
  return raw ? parseSourcePriority(raw) : undefined;
}

const app = express();
// Behind a containerised reverse proxy set MCP_TRUST_PROXY (e.g. "loopback,uniquelocal") so req.ip is the client.
app.set('trust proxy', process.env.MCP_TRUST_PROXY?.trim() || 'loopback');
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.MCP_HTTP_HOST?.trim() || process.env.HOST?.trim() || '127.0.0.1';
const LOCALHOST_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const configuredAllowedHosts = Array.from(new Set(
  (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
));
const isLoopbackBinding = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(HOST.toLowerCase());

if (configuredAllowedHosts.length > 0 || isLoopbackBinding) {
  app.use(hostHeaderValidation(
    configuredAllowedHosts.length > 0 ? configuredAllowedHosts : LOCALHOST_ALLOWED_HOSTS
  ));
} else {
  console.warn(
    `[SECURITY] HTTP server is binding to ${HOST} without Host validation. ` +
    'Set MCP_ALLOWED_HOSTS to a comma-separated hostname allowlist.'
  );
}

// 日志中间件：记录所有请求
app.use((req: Request, res: Response, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = redactUrl(req.url);
  const ip = req.ip || req.socket.remoteAddress;
  
  console.log(`[${timestamp}] ${method} ${url} - IP: ${ip}`);
  
  console.log(`[DEBUG] Request Headers:`, JSON.stringify(redactHeaders(req.headers), null, 2));
  
  // 记录请求完成时的状态码
  const originalSend = res.send;
  res.send = function(data): any {
    console.log(`[${timestamp}] ${method} ${url} - Status: ${res.statusCode}`);
    return originalSend.call(this, data);
  };
  
  next();
});

app.use(cors({
  origin: '*',
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type','Accept','Authorization','Mcp-Session-Id','Last-Event-ID',
    'X-Tenant-Id','X-Api-Key','X-Tushare-Token','X-Qveris-Api-Key','X-Twingly-Api-Key','X-Finance-Source-Priority',
    'X-Smithery-Config','X-Config','X-Session-Config'  // Smithery 可能的配置头
  ],
  exposedHeaders: ['Content-Type','Mcp-Session-Id']
}));
// Tool calls are small JSON-RPC messages; deployments can lower the cap (e.g. MCP_BODY_LIMIT=64kb).
app.use(express.json({ limit: process.env.MCP_BODY_LIMIT?.trim() || '10mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', transport: 'streamable-http', activeSessions: sessions.size });
});

// Optional fixed-window rate limit per client IP for /mcp (MCP_RATE_LIMIT requests per minute).
const RATE_LIMIT = Number(process.env.MCP_RATE_LIMIT || 0);
const rateWindows = new Map<string, { start: number; count: number }>();
function rateLimited(req: Request): boolean {
  if (!(RATE_LIMIT > 0)) return false;
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateWindows.get(key);
  if (!entry || now - entry.start >= 60_000) {
    rateWindows.set(key, { start: now, count: 1 });
    if (rateWindows.size > 10_000) {
      for (const [k, v] of rateWindows) if (now - v.start >= 60_000) rateWindows.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

app.use('/mcp', (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') return next();
  if (!isClientAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  }
  if (rateLimited(req)) {
    return res.status(429).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Too many requests' }, id: null });
  }
  next();
});

app.get('/mcp', (req: Request, res: Response) => {
  const accept = req.headers.accept || '';
  const forceSse = req.query.sse === '1' || req.query.sse === 'true';
  console.log(`📡 [MCP-SSE] Client connecting - Accept: ${accept}, Force SSE: ${forceSse}`);
  
  if (forceSse || (typeof accept === 'string' && accept.includes('text/event-stream'))) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // 仅发送注释型心跳，避免发送非 JSON-RPC 的 data 事件
    res.write(': stream established\n\n');
    console.log(`✅ [MCP-SSE] Stream established`);
    
    const keep = setInterval(() => res.write(': keepalive\n\n'), 30000);
    req.on('close', () => {
      clearInterval(keep);
      console.log(`🔌 [MCP-SSE] Client disconnected`);
    });
    return;
  }
  console.log(`❌ [MCP-SSE] Invalid Accept header`);
  return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Accept must include text/event-stream' }, id: null });
});

app.post('/mcp', async (req: Request, res: Response) => {
  const body = req.body;
  if (!body) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty body' }, id: null });

  const isNotification = (body.id === undefined || body.id === null) && typeof body.method === 'string' && body.method.startsWith('notifications/');
  if (isNotification) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    console.log(`🔔 [MCP-Notification] ${body.method} - Session: ${sid || 'none'}`);
    if (sid && sessions.has(sid)) sessions.get(sid)!.lastActivity = new Date();
    return res.status(204).end();
  }

  const method = body.method as string;
  console.log(`🔧 [MCP-${method}] Request ID: ${body.id}`);
  
  if (method === 'initialize') {
    // Sessions are only bookkeeping, but anonymous clients can create them freely: keep the map bounded.
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());
      for (const old of oldest.slice(0, sessions.size - MAX_SESSIONS + 1)) sessions.delete(old.id);
    }
    const newId = randomUUID();
    sessions.set(newId, { id: newId, createdAt: new Date(), lastActivity: new Date() });
    res.setHeader('Mcp-Session-Id', newId);
    console.log(`✅ [MCP-initialize] New session created: ${newId}`);
    return res.json({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'FinanceMCP', version: SERVER_VERSION } }, id: body.id });
  }

  if (method === 'tools/list') {
    const token = extractTokenFromHeaders(req);
    const qverisApiKey = extractQverisApiKeyFromHeaders(req);
    const twinglyApiKey = extractTwinglyApiKeyFromHeaders(req);
    const sourcePriority = extractSourcePriorityFromHeaders(req);
    const availableTools = await runWithRequestContext({
      tushareToken: token,
      qverisApiKey,
      twinglyApiKey,
      sourcePriority,
    }, async () => getAvailableToolList());
    console.log(`📋 [MCP-tools/list] Returning ${availableTools.length} tools`);
    return res.json({ jsonrpc: '2.0', result: { tools: availableTools }, id: body.id });
  }

  if (method === 'ping') {
    return res.json({ jsonrpc: '2.0', result: {}, id: body.id });
  }

  // 明确表示不支持 resources 和 prompts（返回空列表而不是错误）
  if (method === 'resources/list') {
    console.log(`📋 [MCP-resources/list] Not supported, returning empty list`);
    return res.json({ jsonrpc: '2.0', result: { resources: [] }, id: body.id });
  }

  if (method === 'resources/templates/list') {
    console.log(`📋 [MCP-resources/templates/list] Not supported, returning empty list`);
    return res.json({ jsonrpc: '2.0', result: { resourceTemplates: [] }, id: body.id });
  }

  if (method === 'prompts/list') {
    console.log(`📋 [MCP-prompts/list] Not supported, returning empty list`);
    return res.json({ jsonrpc: '2.0', result: { prompts: [] }, id: body.id });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = body.params || {};
    const token = extractTokenFromHeaders(req);
    const qverisApiKey = extractQverisApiKeyFromHeaders(req);
    const twinglyApiKey = extractTwinglyApiKeyFromHeaders(req);
    const sourcePriority = extractSourcePriorityFromHeaders(req);
    const startTime = Date.now();
    console.log(
      `🚀 [MCP-tools/call] Tool: ${name}`
      + ` | Has Tushare Token: ${!!token}`
      + ` | Has Qveris Key: ${!!qverisApiKey}`
      + ` | Has Twingly Key: ${!!twinglyApiKey}`
    );
    
    try {
      const result = await runWithRequestContext({
        tushareToken: token,
        qverisApiKey,
        twinglyApiKey,
        sourcePriority,
      }, async () => {
        return await dispatchTool(name, args || {});
      });
      const duration = Date.now() - startTime;
      console.log(`✅ [MCP-tools/call] Tool: ${name} completed in ${duration}ms`);
      return res.json({ jsonrpc: '2.0', result, id: body.id });
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const message = error?.message || String(error);
      console.error(`❌ [MCP-tools/call] Tool: ${name} failed after ${duration}ms - Error: ${message}`);
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: body.id });
    }
  }

  console.error(`❌ [MCP] Unknown method: ${method}`);
  return res.status(400).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id: body.id });
});

app.delete('/mcp', (req: Request, res: Response) => {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  if (sid) sessions.delete(sid);
  return res.status(204).end();
});

// 兼容性终止路由：部分客户端在结束会话时会调用此端点
app.post('/mcp/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

// 备用别名
app.post('/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

// 兼容 GET 终止
app.get('/mcp/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

app.get('/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 FinanceMCP Streamable HTTP Server Started');
  console.log('='.repeat(60));
  console.log(`📍 Server URL:    http://${HOST}:${PORT}`);
  console.log(`📡 MCP Endpoint:  http://${HOST}:${PORT}/mcp`);
  console.log(`💚 Health Check:  http://${HOST}:${PORT}/health`);
  console.log(`📊 Active Sessions: ${sessions.size}`);
  console.log(`🔧 Available Tools: ${getAvailableToolList().length}`);
  console.log('='.repeat(60));
  console.log('📝 Server is ready to accept connections');
  console.log('='.repeat(60) + '\n');
});
