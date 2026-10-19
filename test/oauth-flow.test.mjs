import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// ChatGPT 兼容的 OAuth 2.1 端到端验收（合成数据，不触碰生产缓存）。
//
// 覆盖：元数据发现、DCR、Authorization Code + PKCE S256、错误 PKCE/redirect/resource、
// 令牌过期/刷新/撤销、私有工具清单与调用、公网市场端点隔离、
// 以及"私有工具调用不破坏共享市场连接"。

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ashare-oauth-'));
const MARKET_DB = join(dir, 'market.sqlite');
const PORTFOLIO_DB = join(dir, 'portfolio.sqlite');
const OAUTH_DB = join(dir, 'oauth.sqlite');
const PASSWORD = 'correct-horse-battery-staple';
const RESOURCE_PATH = '/private/mcp';

const ACCOUNT_TOOLS = [
  'ashare_portfolio_summary', 'ashare_portfolio_scenario', 'ashare_portfolio_decision',
  'ashare_portfolio_daily_report', 'ashare_etf_candidates', 'ashare_portfolio_benchmarks',
];

// 合成账户库（演示快照，不是用户真实账户）。
const imported = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
  cwd: dir,
  env: { ...process.env, ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB },
  encoding: 'utf8',
});
assert.equal(imported.status, 0, imported.stderr);

// 最小市场缓存：公网工具可调用，但不含任何账户数据。
{
  const { openAshareDb } = await import('../build/ashare/db.js');
  const market = openAshareDb(MARKET_DB);
  market.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?,?)').run('20261016', 1);
  market.close();
}

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(extraEnv = {}) {
  const port = await reservePort();
  const issuer = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      FINANCE_TOOL_PROFILE: 'ashare_daily',
      ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB,
      ASHARE_OAUTH_ENABLED: '1',
      ASHARE_OAUTH_ISSUER: issuer,
      ASHARE_OAUTH_RESOURCE: `${issuer}${RESOURCE_PATH}`,
      ASHARE_OAUTH_LOGIN_PASSWORD: PASSWORD,
      ASHARE_OAUTH_DB_PATH: OAUTH_DB,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', c => { logs += c; });
  child.stderr.on('data', c => { logs += c; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${issuer}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    port, issuer, logs: () => logs,
    async json(path, options = {}) {
      const res = await fetch(`${issuer}${path}`, options);
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, body, text };
    },
    async form(path, fields, headers = {}) {
      return this.json(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      });
    },
    async rpc(path, method, params = {}, token) {
      const res = await fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, body, text };
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    },
  };
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(server, redirectUri) {
  const res = await server.json('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT (test)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(res.status, 201, res.text);
  return res.body;
}

function authorizeQuery({ clientId, redirectUri, challenge, resource, state = 'st-123', scope = 'portfolio:read' }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    resource,
  });
  return params;
}

async function obtainCode(server, { clientId, redirectUri, challenge, resource }) {
  const query = authorizeQuery({ clientId, redirectUri, challenge, resource });
  const res = await fetch(`${server.issuer}/oauth/authorize?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(query), password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  return res;
}

// ---------------------------------------------------------------- 1. 发现

test('O1 未认证请求被拒绝，并给出 RFC 9728 发现信息', async () => {
  const server = await startServer();
  try {
    const prm = await server.json('/.well-known/oauth-protected-resource');
    assert.equal(prm.status, 200);
    assert.equal(prm.body.resource, `${server.issuer}${RESOURCE_PATH}`);
    assert.deepEqual(prm.body.authorization_servers, [server.issuer]);
    assert.deepEqual(prm.body.scopes_supported, ['portfolio:read']);
    assert.deepEqual(prm.body.bearer_methods_supported, ['header']);
    // 路径化变体同样可用。
    const scoped = await server.json(`/.well-known/oauth-protected-resource${RESOURCE_PATH}`);
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.resource, `${server.issuer}${RESOURCE_PATH}`);

    const as = await server.json('/.well-known/oauth-authorization-server');
    assert.equal(as.status, 200);
    assert.equal(as.body.issuer, server.issuer);
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.body.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(as.body.token_endpoint_auth_methods_supported, ['none']);
    assert.ok(as.body.registration_endpoint, '必须公布 DCR registration_endpoint');
    assert.equal(as.body.authorization_response_iss_parameter_supported, true);

    const noAuth = await server.rpc(RESOURCE_PATH, 'tools/list');
    assert.equal(noAuth.status, 401);
    const challenge = noAuth.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /Bearer/);
    assert.match(challenge, /resource_metadata="[^"]+\.well-known\/oauth-protected-resource"/);
    assert.match(challenge, /scope="portfolio:read"/);
    assert.equal(noAuth.body?._meta?.['mcp/www_authenticate'] ? true : false, true,
      '401 应携带 mcp/www_authenticate 元数据');
  } finally { await server.stop(); }
});

// ---------------------------------------------------------------- 2. 正常授权

test('O2 正确用户通过 Authorization Code + PKCE 获得令牌并读取账户工具', async () => {
  const server = await startServer();
  try {
    const redirectUri = 'http://127.0.0.1:9/callback';
    const client = await registerClient(server, redirectUri);
    const { verifier, challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;

    // 授权页：先看到登录表单。
    const page = await server.json(`/oauth/authorize?${authorizeQuery({ clientId: client.client_id, redirectUri, challenge, resource })}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form[^>]+action="\/oauth\/authorize"/i);
    assert.match(page.text, /type="password"/);
    assert.match(page.text, /portfolio:read/);

    const redirect = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge, resource });
    assert.equal(redirect.status, 302, await redirect.text());
    const location = new URL(redirect.headers.get('location'));
    assert.equal(location.origin + location.pathname, redirectUri);
    assert.equal(location.searchParams.get('state'), 'st-123');
    assert.equal(location.searchParams.get('iss'), server.issuer, '每个授权响应都必须带 iss');
    const code = location.searchParams.get('code');
    assert.ok(code);

    const token = await server.form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource,
    });
    assert.equal(token.status, 200, token.text);
    assert.ok(token.body.access_token);
    assert.ok(token.body.refresh_token);
    assert.equal(token.body.token_type, 'Bearer');
    assert.equal(token.body.scope, 'portfolio:read');
    assert.ok(token.body.expires_in > 0);

    const access = token.body.access_token;
    const init = await server.rpc(RESOURCE_PATH, 'initialize', {}, access);
    assert.equal(init.status, 200, init.text);
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid);

    const list = await fetch(`${server.issuer}${RESOURCE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}`, 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listBody = await list.json();
    const names = listBody.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ACCOUNT_TOOLS.slice().sort(), 'OAuth 成功后应恰好看到六个账户工具');

    const call = await fetch(`${server.issuer}${RESOURCE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}`, 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ashare_portfolio_summary', arguments: {} } }),
    });
    const callBody = await call.json();
    assert.equal(callBody.result.content[0].type, 'text');
    const summary = JSON.parse(callBody.result.content[0].text);
    assert.equal(summary.summary.totals.total_assets_cents, 7577653);
  } finally { await server.stop(); }
});

// ---------------------------------------------------------------- 3. 拒绝路径

test('O3 无效 code、错误 PKCE、错误 redirect_uri、错误 resource 均被拒绝', async () => {
  const server = await startServer();
  try {
    const redirectUri = 'http://127.0.0.1:9/callback';
    const client = await registerClient(server, redirectUri);
    const resource = `${server.issuer}${RESOURCE_PATH}`;

    // 错误密码 → 401，且不发码。
    const good = pkce();
    const query = authorizeQuery({ clientId: client.client_id, redirectUri, challenge: good.challenge, resource });
    const badPassword = await fetch(`${server.issuer}/oauth/authorize?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(query), password: 'wrong-password' }).toString(),
      redirect: 'manual',
    });
    assert.equal(badPassword.status, 401);

    // 未注册的 redirect_uri → 400。
    const badRedirect = await server.json(`/oauth/authorize?${authorizeQuery({
      clientId: client.client_id, redirectUri: 'http://127.0.0.1:9/evil', challenge: good.challenge, resource,
    })}`);
    assert.equal(badRedirect.status, 400);

    // 错误 resource → 400。
    const badResource = await server.json(`/oauth/authorize?${authorizeQuery({
      clientId: client.client_id, redirectUri, challenge: good.challenge, resource: 'https://evil.example/mcp',
    })}`);
    assert.equal(badResource.status, 400);

    // 正常取码，但用错误的 verifier 换令牌 → 400。
    const redirect = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge: good.challenge, resource });
    const code = new URL(redirect.headers.get('location')).searchParams.get('code');
    const wrongVerifier = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: pkce().verifier, resource,
    });
    assert.equal(wrongVerifier.status, 400, wrongVerifier.text);

    // 授权码被失败尝试消费后不可重放；换一个新的码测试 redirect_uri 不符。
    const second = pkce();
    const redirect2 = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge: second.challenge, resource });
    const code2 = new URL(redirect2.headers.get('location')).searchParams.get('code');
    const badRedirectToken = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code: code2, redirect_uri: 'http://127.0.0.1:9/other',
      client_id: client.client_id, code_verifier: second.verifier, resource,
    });
    assert.equal(badRedirectToken.status, 400, badRedirectToken.text);

    // 正确换一次，然后重放同一个 code → 400。
    const third = pkce();
    const redirect3 = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge: third.challenge, resource });
    const code3 = new URL(redirect3.headers.get('location')).searchParams.get('code');
    const ok = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code: code3, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: third.verifier, resource,
    });
    assert.equal(ok.status, 200, ok.text);
    const replay = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code: code3, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: third.verifier, resource,
    });
    assert.equal(replay.status, 400, replay.text);

    // 换令牌时带错误的 resource → invalid_target。
    const fourth = pkce();
    const redirect4 = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge: fourth.challenge, resource });
    const code4 = new URL(redirect4.headers.get('location')).searchParams.get('code');
    const badTarget = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code: code4, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: fourth.verifier, resource: 'https://evil.example/mcp',
    });
    assert.equal(badTarget.status, 400);
    assert.equal(badTarget.body.error, 'invalid_target');
  } finally { await server.stop(); }
});

// ---------------------------------------------------------------- 4. 刷新与撤销

test('O4 刷新令牌轮换、撤销后行为正确', async () => {
  const server = await startServer();
  try {
    const redirectUri = 'http://127.0.0.1:9/callback';
    const client = await registerClient(server, redirectUri);
    const { verifier, challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;
    const redirect = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge, resource });
    const code = new URL(redirect.headers.get('location')).searchParams.get('code');
    const first = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier, resource,
    });
    assert.equal(first.status, 200, first.text);

    // 刷新 → 新 access + 新 refresh。
    const refreshed = await server.form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id, resource,
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.notEqual(refreshed.body.access_token, first.body.access_token);
    assert.notEqual(refreshed.body.refresh_token, first.body.refresh_token, '刷新令牌必须轮换');

    // 旧 refresh 不可再用。
    const reuse = await server.form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id, resource,
    });
    assert.equal(reuse.status, 400, reuse.text);

    // 新 access 可用。
    const before = await server.rpc(RESOURCE_PATH, 'tools/list', {}, refreshed.body.access_token);
    assert.equal(before.status, 200);
    assert.equal(before.body.result.tools.length, 6);

    // 撤销后立即失效。
    const revoked = await server.form('/oauth/revoke', { token: refreshed.body.access_token });
    assert.equal(revoked.status, 200);
    const after = await server.rpc(RESOURCE_PATH, 'tools/list', {}, refreshed.body.access_token);
    assert.equal(after.status, 401);
    assert.match(after.headers.get('www-authenticate') ?? '', /invalid_token/);

    // 未知令牌撤销也返回 200（RFC 7009）。
    const unknown = await server.form('/oauth/revoke', { token: 'not-a-real-token' });
    assert.equal(unknown.status, 200);
  } finally { await server.stop(); }
});

// ---------------------------------------------------------------- 5. 过期与 scope

test('O5 过期令牌返回 401；scope 不足返回 403', async () => {
  // 极短 TTL：1 秒。
  const server = await startServer({ ASHARE_OAUTH_ACCESS_TOKEN_TTL: '1' });
  try {
    const redirectUri = 'http://127.0.0.1:9/callback';
    const client = await registerClient(server, redirectUri);
    const { verifier, challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;
    const redirect = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge, resource });
    const code = new URL(redirect.headers.get('location')).searchParams.get('code');
    const token = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier, resource,
    });
    assert.equal(token.status, 200, token.text);
    await new Promise(r => setTimeout(r, 1200));
    const expired = await server.rpc(RESOURCE_PATH, 'tools/list', {}, token.body.access_token);
    assert.equal(expired.status, 401);
    assert.match(expired.headers.get('www-authenticate') ?? '', /invalid_token|expired/);
  } finally { await server.stop(); }

  // scope 不足：直接写入一条 scope 不匹配的令牌（模拟被缩权的令牌）。
  const server2 = await startServer();
  try {
    const client = await registerClient(server2, 'http://127.0.0.1:9/callback');
    const raw = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
    const db = new DatabaseSync(OAUTH_DB);
    try {
      db.prepare(`INSERT INTO oauth_access_token
        (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?)`).run(
        hash, client.client_id, 'owner', 'portfolio:other', `${server2.issuer}${RESOURCE_PATH}`,
        server2.issuer, Date.now() + 60_000, Date.now(),
      );
    } finally { db.close(); }
    const denied = await server2.rpc(RESOURCE_PATH, 'tools/list', {}, raw);
    assert.equal(denied.status, 403, denied.text);
    assert.match(denied.headers.get('www-authenticate') ?? '', /insufficient_scope/);
  } finally { await server2.stop(); }
});

// ---------------------------------------------------------------- 6. 隔离与回归

test('O6 公网市场端点不受影响，且不泄露账户工具；私有调用不破坏共享连接', async () => {
  const server = await startServer();
  try {
    const list = await server.rpc('/mcp', 'tools/list');
    assert.equal(list.status, 200, list.text);
    const names = list.body.result.tools.map(t => t.name);
    for (const original of [
      'ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis',
      'ashare_sector_rank', 'ashare_stock_history', 'ashare_financial_data', 'ashare_market_data',
      'ashare_stock_basic',
    ]) assert.ok(names.includes(original), `公网缺少 ${original}`);
    assert.deepEqual(names.filter(n => /portfolio|etf_candidates/.test(n)), [], '公网不得出现账户工具');

    // 私有端点拒绝市场工具。
    const redirectUri = 'http://127.0.0.1:9/callback';
    const client = await registerClient(server, redirectUri);
    const { verifier, challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;
    const redirect = await obtainCode(server, { clientId: client.client_id, redirectUri, challenge, resource });
    const code = new URL(redirect.headers.get('location')).searchParams.get('code');
    const token = await server.form('/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier, resource,
    });
    const denied = await server.rpc(RESOURCE_PATH, 'tools/call', { name: 'ashare_daily_report', arguments: {} }, token.body.access_token);
    assert.equal(denied.status, 400);
    assert.match(JSON.stringify(denied.body), /market_tool_not_available_on_private_endpoint/);

    // 先私有后公网：共享市场连接不能被私有路径关闭。
    const pubBefore = await server.rpc('/mcp', 'tools/call', { name: 'ashare_data_status', arguments: {} });
    assert.equal(pubBefore.status, 200, pubBefore.text);
    for (const name of ['ashare_portfolio_summary', 'ashare_etf_candidates']) {
      const call = await server.rpc(RESOURCE_PATH, 'tools/call', { name, arguments: {} }, token.body.access_token);
      assert.equal(call.status, 200, `${name}: ${call.text}`);
    }
    const pubAfter = await server.rpc('/mcp', 'tools/call', { name: 'ashare_data_status', arguments: {} });
    assert.equal(pubAfter.status, 200, pubAfter.text);
    assert.equal(/database is not open/.test(pubAfter.text), false);
  } finally { await server.stop(); }
});

// ---------------------------------------------------------------- 7. 静态令牌边界

test('O7 OAuth 开启时静态令牌默认不可用；显式允许后才可用', async () => {
  const staticToken = 'legacy-static-token-for-local-automation';
  const strict = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: staticToken });
  try {
    const denied = await strict.rpc(RESOURCE_PATH, 'tools/list', {}, staticToken);
    assert.equal(denied.status, 401, 'OAuth 开启时静态令牌必须被拒绝（除非显式允许）');
  } finally { await strict.stop(); }

  const allowed = await startServer({
    ASHARE_PRIVATE_PORTFOLIO_TOKEN: staticToken,
    ASHARE_PRIVATE_ALLOW_STATIC_TOKEN: '1',
  });
  try {
    const ok = await allowed.rpc(RESOURCE_PATH, 'tools/list', {}, staticToken);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.result.tools.length, 6);
  } finally { await allowed.stop(); }
});
