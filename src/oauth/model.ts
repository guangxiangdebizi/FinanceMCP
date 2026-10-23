import { OAuthStore, opaqueToken, type StoredClient, type StoredToken } from './store.js';
import type { OAuthConfig } from './config.js';

/**
 * `@node-oauth/oauth2-server` 的 Model 适配层。
 *
 * 只实现单用户所需的回调；协议解析、PKCE 校验、错误格式、刷新令牌轮换等
 * 都由库负责，这里不重写协议逻辑。
 *
 * `resource`（ChatGPT 在授权与换令牌请求里带上的 MCP URL）通过 `user` 对象
 * 透传：授权码保存时记录，换令牌时随 `code.user` 回到 `saveToken`，最终写入
 * 访问令牌，供资源服务器做 audience 校验。
 */

type Client = any;
type User = any;

function toClient(stored: StoredClient): Client {
  return {
    id: stored.client_id,
    name: stored.client_name ?? undefined,
    redirectUris: stored.redirect_uris,
    grants: stored.grant_types,
    responseTypes: stored.response_types,
    tokenEndpointAuthMethod: stored.token_endpoint_auth_method,
  };
}

function toUser(subject: string, resource: string): User {
  return { id: subject, resource };
}

export function createModel(store: OAuthStore, config: OAuthConfig): any {
  const model = {
    // ---------------------------------------------------------------- 客户端

    async getClient(clientId: string): Promise<Client | false> {
      const stored = store.getClient(clientId);
      return stored ? toClient(stored) : false;
    },

    // ---------------------------------------------------------------- 授权码

    async saveAuthorizationCode(
      code: { authorizationCode: string; expiresAt: Date; redirectUri: string; scope?: string[];
        codeChallenge?: string; codeChallengeMethod?: string },
      client: Client, user: User,
    ): Promise<any> {
      store.saveCode({
        code: code.authorizationCode,
        clientId: client.id,
        redirectUri: code.redirectUri,
        scope: (code.scope ?? [config.scope]).join(' '),
        resource: String(user.resource ?? config.resource),
        codeChallenge: String(code.codeChallenge ?? ''),
        codeChallengeMethod: String(code.codeChallengeMethod ?? ''),
        subject: String(user.id),
        expiresAt: code.expiresAt.getTime(),
      });
      return { ...code, client, user };
    },

    async getAuthorizationCode(authorizationCode: string): Promise<any> {
      const stored = store.getCode(authorizationCode);
      if (!stored) return false;
      const client = store.getClient(stored.client_id);
      if (!client) return false;
      return {
        authorizationCode,
        expiresAt: new Date(stored.expires_at),
        redirectUri: stored.redirect_uri,
        scope: stored.scope.split(' ').filter(Boolean),
        client: toClient(client),
        user: toUser(stored.subject, stored.resource),
        codeChallenge: stored.code_challenge,
        codeChallengeMethod: stored.code_challenge_method,
      };
    },

    async revokeAuthorizationCode(code: { authorizationCode: string }): Promise<boolean> {
      // 一次性使用：消费成功即视为撤销成功。
      return store.consumeCode(code.authorizationCode);
    },

    // ---------------------------------------------------------------- 令牌

    generateAccessToken(): Promise<string> {
      return Promise.resolve(opaqueToken(32));
    },

    generateRefreshToken(): Promise<string> {
      return Promise.resolve(opaqueToken(32));
    },

    async saveToken(token: any, client: Client, user: User): Promise<any> {
      const resource = String(user.resource ?? config.resource);
      const scope = (token.scope ?? [config.scope]).join(' ');
      store.saveAccessToken({
        token: token.accessToken,
        clientId: client.id,
        subject: String(user.id),
        scope,
        resource,
        issuer: config.issuer,
        expiresAt: token.accessTokenExpiresAt.getTime(),
      });
      if (token.refreshToken) {
        store.saveRefreshToken({
          token: token.refreshToken,
          clientId: client.id,
          subject: String(user.id),
          scope,
          resource,
          issuer: config.issuer,
          expiresAt: token.refreshTokenExpiresAt.getTime(),
        });
      }
      store.prune();
      return { ...token, client, user };
    },

    async getAccessToken(accessToken: string): Promise<any> {
      return storedToToken(store.getAccessToken(accessToken), accessToken, store, config);
    },

    async getRefreshToken(refreshToken: string): Promise<any> {
      const stored = store.getRefreshToken(refreshToken);
      if (!stored) return false;
      const client = store.getClient(stored.client_id);
      if (!client) return false;
      return {
        refreshToken,
        refreshTokenExpiresAt: new Date(stored.expires_at),
        scope: stored.scope.split(' ').filter(Boolean),
        client: toClient(client),
        user: toUser(stored.subject, stored.resource),
      };
    },

    async revokeToken(token: { refreshToken: string }): Promise<boolean> {
      return store.revokeRefreshToken(token.refreshToken);
    },

    async verifyScope(token: any, scope: string[]): Promise<boolean> {
      const granted = new Set<string>(token.scope ?? []);
      return scope.every(item => granted.has(item) || granted.has('portfolio:admin'));
    },

    async validateScope(_user: User, _client: Client, scope?: string[]): Promise<string[] | false> {
      const requested = scope && scope.length > 0 ? scope : [config.scope];
      return requested.every(item => item === config.scope || item === config.writeScope) ? requested : false;
    },
  };
  return model;
}

function storedToToken(
  stored: StoredToken | undefined, raw: string, store: OAuthStore, config: OAuthConfig,
): any {
  if (!stored) return false;
  const client = store.getClient(stored.client_id);
  if (!client) return false;
  return {
    accessToken: raw,
    accessTokenExpiresAt: new Date(stored.expires_at),
    scope: stored.scope.split(' ').filter(Boolean),
    client: toClient(client),
    user: toUser(stored.subject, stored.resource),
  };
}

