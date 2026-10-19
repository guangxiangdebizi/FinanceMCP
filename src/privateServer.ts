import type { Express, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dispatchPrivateTool, getPrivateToolList } from './dispatch.js';
import { SERVER_VERSION } from './version.js';
import type { OAuthConfig } from './oauth/config.js';
import type { OAuthStore } from './oauth/store.js';
import { verifyOAuthAccessToken, wwwAuthenticate, type OAuthFailure } from './oauth/verify.js';

/**
 * 私有账户端点 `/private/mcp`（工作包 A5）。
 *
 * 设计约束（PRD §4/§8，验收：公网匿名路由不得泄露账户信息）：
 * - 只有设置了 `ASHARE_PRIVATE_PORTFOLIO_TOKEN` 才挂载真正的处理器；未设置时该路径
 *   一律 404，不通过 401 暴露"这里有一个需要鉴权的端点"。
 * - 鉴权只认 `Authorization: Bearer <token>`，用 `timingSafeEqual` 且先比较长度；
 *   缺失或不匹配时返回 401 + `WWW-Authenticate: Bearer`，响应体为空、不创建会话。
 * - 该端点只提供账户工具（`getPrivateToolList()`）；任何市场工具都会被明确拒绝。
 * - 令牌值从不写入日志；全局日志中间件已对 `authorization` 做脱敏。
 * - 会话与限流窗口与公网 `/mcp` 完全独立，公网会话 ID 在私有端点无效（反之亦然）。
 */

export const PRIVATE_ENDPOINT_PATH = '/private/mcp';

const MAX_PRIVATE_SESSIONS = Number(process.env.ASHARE_PRIVATE_MAX_SESSIONS || 100);
const DEFAULT_PRIVATE_RATE_LIMIT = 10;

const privateSessions = new Map<string, { id: string; createdAt: Date; lastActivity: Date }>();
const privateRateWindows = new Map<string, { start: number; count: number }>();

/** OAuth 运行时由 httpServer 在启动时注入；null 表示未启用 OAuth。 */
let oauthRuntime: { config: OAuthConfig; store: OAuthStore } | null = null;

export function configurePrivateOAuth(runtime: { config: OAuthConfig; store: OAuthStore } | null): void {
  oauthRuntime = runtime;
}

/** 令牌只在这里读取；返回空串表示静态令牌未配置。 */
export function privateEndpointToken(): string {
  return (process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN ?? '').trim();
}

/**
 * OAuth 开启时，静态令牌默认关闭（避免"静态密钥绕过 OAuth"）。
 * 本地脚本需要时显式设置 `ASHARE_PRIVATE_ALLOW_STATIC_TOKEN=1`。
 */
function staticTokenAllowed(): boolean {
  if (!oauthRuntime) return true;
  return (process.env.ASHARE_PRIVATE_ALLOW_STATIC_TOKEN ?? '').trim() === '1';
}

export function privateEndpointEnabled(): boolean {
  return privateEndpointToken().length > 0 || oauthRuntime !== null;
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/** 定长比较：长度不同直接拒绝，长度相同才做 timingSafeEqual。 */
function staticTokenMatches(presented: string): boolean {
  const expected = Buffer.from(privateEndpointToken(), 'utf8');
  if (expected.length === 0) return false;
  const given = Buffer.from(presented, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface AuthOutcome {
  ok: boolean;
  status?: 401 | 403;
  failure?: OAuthFailure;
}

/**
 * 认证在**工具执行之前**完成，位于 HTTP 中间件层。
 * - OAuth 开启：只接受本服务签发的访问令牌（校验 issuer/resource/scope/exp/revoked）。
 * - 静态令牌：仅当未启用 OAuth，或显式 `ASHARE_PRIVATE_ALLOW_STATIC_TOKEN=1` 时接受。
 */
function authenticatePrivate(req: Request): AuthOutcome {
  const presented = bearerToken(req);
  if (!presented) return { ok: false, status: 401, failure: 'missing_token' };

  if (oauthRuntime) {
    const verified = verifyOAuthAccessToken(oauthRuntime.store, oauthRuntime.config, presented);
    if (verified.ok) return { ok: true };
    if (staticTokenAllowed() && staticTokenMatches(presented)) return { ok: true };
    return { ok: false, status: verified.status ?? 401, failure: verified.failure };
  }

  return staticTokenMatches(presented) ? { ok: true } : { ok: false, status: 401 };
}

function privateRateLimit(): number {
  const raw = Number(process.env.ASHARE_PRIVATE_RATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRIVATE_RATE_LIMIT;
}

/** 与公网 `/mcp` 相同的固定窗口限流，但使用独立的窗口表与更小的默认值。 */
function privateRateLimited(req: Request): boolean {
  const limit = privateRateLimit();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = privateRateWindows.get(key);
  if (!entry || now - entry.start >= 60_000) {
    privateRateWindows.set(key, { start: now, count: 1 });
    if (privateRateWindows.size > 10_000) {
      for (const [k, v] of privateRateWindows) if (now - v.start >= 60_000) privateRateWindows.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

function trimPrivateSessions(): void {
  if (privateSessions.size < MAX_PRIVATE_SESSIONS) return;
  const oldest = [...privateSessions.values()].sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());
  for (const old of oldest.slice(0, privateSessions.size - MAX_PRIVATE_SESSIONS + 1)) privateSessions.delete(old.id);
}

function unauthorized(res: Response, outcome: AuthOutcome): void {
  const config = oauthRuntime?.config ?? null;
  const challenge = wwwAuthenticate(config, outcome.failure, outcome.status === 403);
  res.setHeader('WWW-Authenticate', challenge);
  res.setHeader('Cache-Control', 'no-store');
  if (config) {
    // 同时给出 RFC 9728 发现信息，便于 ChatGPT 触发 OAuth 连接流程。
    res.status(outcome.status ?? 401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: outcome.status === 403 ? 'insufficient_scope' : 'unauthorized' },
      _meta: { 'mcp/www_authenticate': challenge },
    });
    return;
  }
  res.status(outcome.status ?? 401).end();
}

async function handlePrivateRpc(req: Request, res: Response): Promise<void> {
  const body = req.body;
  if (!body) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty body' }, id: null });
    return;
  }

  const isNotification = (body.id === undefined || body.id === null) && typeof body.method === 'string' && body.method.startsWith('notifications/');
  if (isNotification) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && privateSessions.has(sid)) privateSessions.get(sid)!.lastActivity = new Date();
    res.status(204).end();
    return;
  }

  const method = body.method as string;
  if (method === 'initialize') {
    trimPrivateSessions();
    const newId = randomUUID();
    privateSessions.set(newId, { id: newId, createdAt: new Date(), lastActivity: new Date() });
    res.setHeader('Mcp-Session-Id', newId);
    res.json({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'FinanceMCP-Private', version: SERVER_VERSION } }, id: body.id });
    return;
  }

  if (method === 'tools/list') {
    const tools = getPrivateToolList();
    res.json({ jsonrpc: '2.0', result: { tools }, id: body.id });
    return;
  }

  if (method === 'ping') {
    res.json({ jsonrpc: '2.0', result: {}, id: body.id });
    return;
  }

  if (method === 'resources/list') {
    res.json({ jsonrpc: '2.0', result: { resources: [] }, id: body.id });
    return;
  }

  if (method === 'resources/templates/list') {
    res.json({ jsonrpc: '2.0', result: { resourceTemplates: [] }, id: body.id });
    return;
  }

  if (method === 'prompts/list') {
    res.json({ jsonrpc: '2.0', result: { prompts: [] }, id: body.id });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = body.params || {};
    const tool = String(name);
    try {
      const result = await dispatchPrivateTool(tool, args || {});
      // 只为审计记录工具名与结果，**不记录参数内容**（可能含账户细节）。
      console.log(`[private] tool=${tool} status=ok`);
      res.json({ jsonrpc: '2.0', result, id: body.id });
    } catch (error: any) {
      // 只回传工具名与原因；不记录令牌、不记录参数内容。
      const reason = String(error?.message ?? error).slice(0, 200);
      console.log(`[private] tool=${tool} status=error reason=${reason}`);
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: error?.message || String(error) }, id: body.id });
    }
    return;
  }

  res.status(400).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id: body.id });
}

/**
 * 把私有端点挂到已有 express 应用上。始终注册路由前缀，因此令牌未设置时
 * 该路径返回 404（与不存在的路径不可区分），不会通过 401 广告自身。
 */
export function mountPrivateEndpoint(app: Express): boolean {
  const enabled = privateEndpointEnabled();

  app.use(PRIVATE_ENDPOINT_PATH, (req: Request, res: Response, next) => {
    // 未配置任何凭据时 404，不通过 401 广告自身；配置后按 401/403 返回发现信息。
    const outcome = authenticatePrivate(req);
    if (privateEndpointToken().length === 0 && oauthRuntime === null && !outcome.ok) {
      return res.status(404).end();
    }
    if (req.method === 'OPTIONS') return next();
    if (!outcome.ok) return unauthorized(res, outcome);
    if (privateRateLimited(req)) {
      return res.status(429).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Too many requests' }, id: null });
    }
    next();
  });

  if (!enabled) return false;

  app.post(PRIVATE_ENDPOINT_PATH, (req: Request, res: Response) => { void handlePrivateRpc(req, res); });

  app.get(PRIVATE_ENDPOINT_PATH, (req: Request, res: Response) => {
    const accept = req.headers.accept || '';
    const forceSse = req.query.sse === '1' || req.query.sse === 'true';
    if (forceSse || (typeof accept === 'string' && accept.includes('text/event-stream'))) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': private stream established\n\n');
      const keep = setInterval(() => res.write(': keepalive\n\n'), 30000);
      req.on('close', () => clearInterval(keep));
      return;
    }
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Accept must include text/event-stream' }, id: null });
  });

  app.delete(PRIVATE_ENDPOINT_PATH, (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid) privateSessions.delete(sid);
    return res.status(204).end();
  });

  return true;
}
