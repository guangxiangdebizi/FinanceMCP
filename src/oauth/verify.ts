import type { OAuthConfig } from './config.js';
import type { OAuthStore } from './store.js';

/**
 * 资源服务器端（`/private/mcp`）的访问令牌校验。
 *
 * 令牌是不透明随机串：这里按哈希查库，校验
 * 1. 存在；2. 未撤销；3. 未过期；4. issuer 匹配；5. audience/resource 匹配；
 * 6. scope 覆盖 `portfolio:read`。
 *
 * 任何一项失败都返回结构化原因，由调用方映射为 401/403。
 * 认证发生在**工具执行之前**（HTTP 中间件层），不依赖工具内部判断。
 */

export type OAuthFailure =
  | 'missing_token'
  | 'invalid_token'
  | 'token_expired'
  | 'token_revoked'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'insufficient_scope'
  | 'oauth_unavailable';

export interface OAuthVerification {
  ok: boolean;
  failure?: OAuthFailure;
  subject?: string;
  scope?: string;
  resource?: string;
  /** 401（令牌本身无效）还是 403（令牌有效但权限不足）。 */
  status?: 401 | 403;
}

export function verifyOAuthAccessToken(
  store: OAuthStore, config: OAuthConfig, token: string,
): OAuthVerification {
  const stored = store.getAccessToken(token);
  if (!stored) return { ok: false, failure: 'invalid_token', status: 401 };
  if (stored.revoked_at !== null) return { ok: false, failure: 'token_revoked', status: 401 };
  if (stored.expires_at <= Date.now()) return { ok: false, failure: 'token_expired', status: 401 };
  if (stored.issuer !== config.issuer) return { ok: false, failure: 'wrong_issuer', status: 401 };
  if (stored.resource !== config.resource) return { ok: false, failure: 'wrong_audience', status: 401 };
  const scopes = new Set(stored.scope.split(' ').filter(Boolean));
  if (!scopes.has(config.scope) && !scopes.has('portfolio:admin')) {
    return { ok: false, failure: 'insufficient_scope', status: 403, subject: stored.subject, scope: stored.scope };
  }
  return { ok: true, subject: stored.subject, scope: stored.scope, resource: stored.resource };
}

/** 令牌是否被授予追加研究记录的权限。`portfolio:read` 不算。 */
export function hasWriteScope(scope: string | undefined, config: OAuthConfig): boolean {
  const scopes = new Set((scope ?? '').split(' ').filter(Boolean));
  return scopes.has(config.writeScope) || scopes.has('portfolio:admin');
}

/** 构造 RFC 6750 / RFC 9728 的 `WWW-Authenticate` 提示。 */
export function wwwAuthenticate(
  config: OAuthConfig | null, failure?: OAuthFailure, scopeFail = false,
): string {
  // 未启用 OAuth 时保持既有契约：只发 `Bearer`，不泄露失败细节。
  if (!config) return 'Bearer';
  const metadata = `${config.issuer}/.well-known/oauth-protected-resource`;
  const parts: string[] = [];
  if (failure === 'insufficient_scope' || scopeFail) {
    parts.push(`error="insufficient_scope"`, `error_description="token lacks ${config.scope}"`);
  } else if (failure) {
    parts.push(`error="invalid_token"`, `error_description="${failure}"`);
  }
  parts.push(`resource_metadata="${metadata}"`, `scope="${scopeFail && failure === undefined ? config.writeScope : config.scope}"`);
  return `Bearer ${parts.join(', ')}`;
}
