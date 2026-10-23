import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// ChatGPT 按工具增量申请 scope 的真实协议测试（合成数据，隔离的临时库，不写生产账户）。
//
// 每条断言都从真实 HTTP 入口出发：DCR → 授权页 → Authorization Code + PKCE → 令牌 →
// 刷新 → tools/list 声明 → tools/call 门控 → 工具级挑战 → 重新授权。
// 只读令牌与双权限令牌并存时，各自的边界都要成立。

const ROOT = process.cwd();
const RESOURCE_PATH = '/private/mcp';
const PASSWORD = 'correct-horse-battery-staple';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';
const APPEND = 'ashare_chatgpt_research_record_append';
const READ_TOOL = 'ashare_portfolio_summary';
const READ_SCHEMES = [{ type: 'oauth2', scopes: ['portfolio:read'] }];
const APPEND_SCHEMES = [{ type: 'oauth2', scopes: ['portfolio:read', 'research:append'] }];

// 合成账户库：读工具需要一份可读快照，才能证明只读令牌真的拿到了数据。
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'ashare-scope-fixture-'));
const MARKET_DB = join(FIXTURE_DIR, 'market.sqlite');
const PORTFOLIO_DB = join(FIXTURE_DIR, 'portfolio.sqlite');
{
  const imported = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, ASHARE_DATA_DIR: FIXTURE_DIR, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB },
    encoding: 'utf8',
  });
  assert.equal(imported.status, 0, imported.stderr);
  const { openPortfolioDb } = await import('../build/portfolio/db.js');
  const { initBaseline } = await import('../build/portfolio/ledger.js');
  const db = openPortfolioDb(PORTFOLIO_DB, { marketPath: MARKET_DB });
  initBaseline(db, 'synthetic-oauth-account', { asOf: '20261018', snapshotId: 'demo-2026-10-18' });
  db.close();
}

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-scope-'));
  const port = await reservePort();
  const issuer = `http://127.0.0.1:${port}`;
  const oauthDb = join(dir, 'oauth.sqlite');
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      FINANCE_TOOL_PROFILE: 'ashare_daily',
      ASHARE_DATA_DIR: FIXTURE_DIR, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB,
      ASHARE_OAUTH_ENABLED: '1',
      ASHARE_OAUTH_ISSUER: issuer,
      ASHARE_OAUTH_RESOURCE: `${issuer}${RESOURCE_PATH}`,
      ASHARE_OAUTH_LOGIN_PASSWORD: PASSWORD,
      ASHARE_OAUTH_DB_PATH: oauthDb,
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
  const parse = async res => {
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body, text };
  };
  return {
    issuer, oauthDb, logs: () => logs,
    async json(path, options = {}) { return parse(await fetch(`${issuer}${path}`, options)); },
    async form(path, fields) {
      return parse(await fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }));
    },
    async rpc(method, params = {}, token, path = RESOURCE_PATH) {
      return parse(await fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }));
    },
    // 把一条令牌直接写入隔离的 OAuth 库，用于构造过期、错误 audience、只写等难以经协议得到的令牌。
    mintRaw({ clientId, scope, resource = `${issuer}${RESOURCE_PATH}`, expiresAt = Date.now() + 600_000, issuer: tokenIssuer = issuer }) {
      const raw = randomBytes(32).toString('base64url');
      const db = new DatabaseSync(oauthDb);
      try {
        db.prepare(`INSERT INTO oauth_access_token (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, created_at)
          VALUES (?,?,?,?,?,?,?,NULL,?)`).run(createHash('sha256').update(raw, 'utf8').digest('hex'), clientId, 'owner', scope,
          resource, tokenIssuer, expiresAt, Date.now());
      } finally { db.close(); }
      return raw;
    },
    revokeRaw(raw) {
      const db = new DatabaseSync(oauthDb);
      try {
        db.prepare('UPDATE oauth_access_token SET revoked_at = ? WHERE token_hash = ?')
          .run(Date.now(), createHash('sha256').update(raw, 'utf8').digest('hex'));
      } finally { db.close(); }
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

async function registerClient(server) {
  const res = await server.json('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT (scope upgrade test)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(res.status, 201, res.text);
  return res.body;
}

function authorizeParams({ clientId, challenge, scope, resource }) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: 'st-scope',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    resource,
  });
}

/**
 * 走一遍真实的授权：先看授权页，再以密码提交。成功返回 { token }，失败返回 { status, location }。
 * 授权页的 scope 与提交的 scope 完全一致，模拟 ChatGPT 按工具申请的那一次授权。
 */
async function consent(server, client, scope, { password = PASSWORD } = {}) {
  const { verifier, challenge } = pkce();
  const resource = `${server.issuer}${RESOURCE_PATH}`;
  const params = authorizeParams({ clientId: client.client_id, challenge, scope, resource });
  const page = await server.json(`/oauth/authorize?${params}`);
  assert.equal(page.status, 200, page.text);
  const submit = await fetch(`${server.issuer}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(params), password }).toString(),
    redirect: 'manual',
  });
  if (submit.status !== 302) return { status: submit.status, location: submit.headers.get('location'), verifier, page };
  const location = new URL(submit.headers.get('location'));
  assert.equal(location.searchParams.get('iss'), server.issuer);
  const code = location.searchParams.get('code');
  assert.ok(code, 'a successful consent must return a code');
  const token = await server.form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  return { status: 302, token, page };
}

async function grantedToken(server, client, scope) {
  const { token } = await consent(server, client, scope);
  assert.equal(token?.status, 200, token?.text);
  return token.body;
}

async function refresh(server, client, refreshToken, scope) {
  const fields = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
    resource: `${server.issuer}${RESOURCE_PATH}`,
  };
  if (scope !== undefined) fields.scope = scope;
  return server.form('/oauth/token', fields);
}

const appendChallenge = res => res.headers.get('www-authenticate') ?? '';

// ---------------------------------------------------------------- 声明与门控一致

test('S1 tools/list 按工具声明 securitySchemes；公网市场工具不声明', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const token = await grantedToken(server, client, 'portfolio:read');
    const list = await server.rpc('tools/list', {}, token.access_token);
    assert.equal(list.status, 200, list.text);
    const tools = Object.fromEntries(list.body.result.tools.map(t => [t.name, t]));
    assert.deepEqual(tools[APPEND].securitySchemes, APPEND_SCHEMES, 'append 必须声明 portfolio:read research:append');
    for (const [name, tool] of Object.entries(tools)) {
      if (name === APPEND) continue;
      assert.deepEqual(tool.securitySchemes, READ_SCHEMES, `${name} 应只声明 portfolio:read`);
    }

    // 公网 tools/list 不经过私有映射，不得出现任何 securitySchemes 或账户工具。
    const pub = await server.rpc('tools/list', {}, undefined, '/mcp');
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.text.includes('securitySchemes'), false, '公网市场工具不得声明 securitySchemes');
    assert.equal(pub.text.includes(APPEND), false);
  } finally { await server.stop(); }
});

test('S10 工具声明与服务端门控一致：声明追加 scope 的工具，正是门控的那一个工具', async () => {
  const { portfolioToolDefinitions } = await import('../build/ashare/definitions.js');
  const { CHATGPT_INTAKE_TOOL } = await import('../build/portfolio/chatgptIntake.js');
  const { OAUTH_SCOPE, OAUTH_WRITE_SCOPE } = await import('../build/oauth/config.js');
  const appendDeclared = portfolioToolDefinitions
    .filter(t => t.securitySchemes.some(s => s.scopes.includes(OAUTH_WRITE_SCOPE)))
    .map(t => t.name);
  assert.deepEqual(appendDeclared, [CHATGPT_INTAKE_TOOL]);
  for (const tool of portfolioToolDefinitions) {
    assert.ok(tool.securitySchemes.every(s => s.scopes.includes(OAUTH_SCOPE)),
      `${tool.name} 的每个 scheme 都必须包含读 scope（服务端先校验读 scope）`);
  }
});

// ---------------------------------------------------------------- 授权页与令牌边界

test('S2 授权页准确显示所申请的 scope：只读申请不出现追加，读写申请两项都出现', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const { challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;
    const readOnly = await server.json(`/oauth/authorize?${authorizeParams({ clientId: client.client_id, challenge, scope: 'portfolio:read', resource })}`);
    assert.equal(readOnly.status, 200, readOnly.text);
    assert.match(readOnly.text, /<code>portfolio:read<\/code>/);
    assert.doesNotMatch(readOnly.text, /research:append/, '只读授权页不得出现追加 scope');

    const both = await consent(server, client, 'portfolio:read research:append');
    assert.match(both.page.text, /<code>portfolio:read research:append<\/code>/);
    assert.match(both.page.text, /追加研究记录/);
  } finally { await server.stop(); }
});

test('S3 只读授权签发只读令牌；追加工具得到完整 scope 的工具级挑战；日志不泄露令牌', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const token = await grantedToken(server, client, 'portfolio:read');
    assert.equal(token.scope, 'portfolio:read', '只读申请不得获得 research:append');

    const read = await server.rpc('tools/call', { name: READ_TOOL, arguments: {} }, token.access_token);
    assert.equal(read.status, 200, read.text);
    assert.ok(read.body.result.content, '只读令牌必须能调用只读工具');

    const denied = await server.rpc('tools/call', { name: APPEND, arguments: {} }, token.access_token);
    assert.equal(denied.status, 403, denied.text);
    const header = appendChallenge(denied);
    assert.match(header, /^Bearer /);
    assert.match(header, /error="insufficient_scope"/);
    assert.match(header, /scope="portfolio:read research:append"/, '挑战必须要求完整的双 scope，而不是只有写 scope');
    assert.match(header, /error_description="token lacks portfolio:read research:append"/);
    assert.match(header, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
    // 工具级挑战：结果为 isError，并携带 _meta["mcp/www_authenticate"]，且与 HTTP 头一致。
    assert.equal(denied.body.result.isError, true);
    assert.deepEqual(denied.body.result._meta['mcp/www_authenticate'], [header]);
    assert.equal(denied.body.error, undefined, '门控不得以协议级 JSON-RPC error 代替工具结果');

    const logs = server.logs();
    assert.equal(logs.includes(token.access_token), false, '日志不得出现访问令牌');
    assert.equal(logs.includes(token.refresh_token), false, '日志不得出现刷新令牌');
    assert.equal(logs.includes(PASSWORD), false, '日志不得出现登录密码');
  } finally { await server.stop(); }
});

test('S4 双权限申请签发双权限令牌；追加工具越过 scope 门，业务校验拒绝无效入参', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const token = await grantedToken(server, client, 'portfolio:read research:append');
    assert.equal(token.scope, 'portfolio:read research:append');

    const passed = await server.rpc('tools/call', { name: APPEND, arguments: {} }, token.access_token);
    assert.notEqual(passed.status, 401, passed.text);
    assert.notEqual(passed.status, 403, passed.text);
    assert.notEqual(passed.body?.error?.message, 'insufficient_scope');
    // 空入参应由业务校验拒绝（as_of_trade_date 必填），而不是被误判为 scope 缺失。
    assert.equal(passed.status, 400, passed.text);
    assert.match(passed.body.error.message, /as_of_trade_date/);

    // 白名单仍然生效：不属于研究记录的字段被业务层拒绝。
    const extra = await server.rpc('tools/call', { name: APPEND, arguments: { as_of_trade_date: '20261022', surprise: 1 } }, token.access_token);
    assert.equal(extra.status, 400, extra.text);
    assert.match(extra.body.error.message, /not accepted/);

    const read = await server.rpc('tools/call', { name: READ_TOOL, arguments: {} }, token.access_token);
    assert.equal(read.status, 200, read.text);
  } finally { await server.stop(); }
});

test('S5 刷新令牌不自动扩大权限：只读刷新不会获得追加，请求追加的刷新被拒绝', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const readToken = await grantedToken(server, client, 'portfolio:read');

    const widened = await refresh(server, client, readToken.refresh_token, 'portfolio:read research:append');
    assert.equal(widened.status, 400, `刷新请求追加 scope 必须被拒绝：${widened.text}`);
    assert.equal(widened.body.error, 'invalid_scope', widened.text);

    // 上一步失败不应消费旧的刷新令牌（库在校验失败前不撤销）。
    const plain = await refresh(server, client, readToken.refresh_token);
    assert.equal(plain.status, 200, plain.text);
    assert.equal(plain.body.scope, 'portfolio:read', '刷新后仍是只读');
    const stillDenied = await server.rpc('tools/call', { name: APPEND, arguments: {} }, plain.body.access_token);
    assert.equal(stillDenied.status, 403, stillDenied.text);

    const dual = await grantedToken(server, client, 'portfolio:read research:append');
    const kept = await refresh(server, client, dual.refresh_token);
    assert.equal(kept.status, 200, kept.text);
    assert.equal(kept.body.scope, 'portfolio:read research:append', '刷新保留原有的授权边界');
  } finally { await server.stop(); }
});

test('S6 重新授权升级：旧只读令牌与新双权限令牌并存，各自边界不变', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const oldToken = await grantedToken(server, client, 'portfolio:read');
    const challenged = await server.rpc('tools/call', { name: APPEND, arguments: {} }, oldToken.access_token);
    assert.equal(challenged.status, 403);

    // 用户在 ChatGPT 中重新连接：这是一次新的授权，申请完整双权限。
    const newToken = await grantedToken(server, client, 'portfolio:read research:append');
    assert.notEqual(newToken.access_token, oldToken.access_token);

    const oldRead = await server.rpc('tools/call', { name: READ_TOOL, arguments: {} }, oldToken.access_token);
    assert.equal(oldRead.status, 200, '旧只读令牌仍可读');
    const oldAppend = await server.rpc('tools/call', { name: APPEND, arguments: {} }, oldToken.access_token);
    assert.equal(oldAppend.status, 403, '旧只读令牌不因新授权而获得追加');

    const newAppend = await server.rpc('tools/call', { name: APPEND, arguments: {} }, newToken.access_token);
    assert.equal(newAppend.status, 400, `新令牌越过 scope 门，进入业务校验：${newAppend.text}`);
  } finally { await server.stop(); }
});

test('S7 拒绝路径：不支持的 scope、只申请写入、错误密码都不签发令牌', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const { challenge } = pkce();
    const resource = `${server.issuer}${RESOURCE_PATH}`;

    // portfolio:admin 不可申请：同意页不展示它，签发出的令牌却可以追加（见 router.ts）。
    for (const scope of ['portfolio:read bogus:write', 'portfolio:read payments:send', 'portfolio:admin', 'portfolio:read portfolio:admin']) {
      const q = authorizeParams({ clientId: client.client_id, challenge, scope, resource });
      const res = await server.json(`/oauth/authorize?${q}`);
      assert.equal(res.status, 400, `${scope}: ${res.text}`);
      assert.match(res.text, /scope 不受支持/);
    }

    // 只申请追加、不申请读：服务端的私有端点永远要求读，这样的令牌没有用处，应在授权时拒绝。
    const writeOnly = authorizeParams({ clientId: client.client_id, challenge, scope: 'research:append', resource });
    const writeOnlyPage = await server.json(`/oauth/authorize?${writeOnly}`);
    assert.equal(writeOnlyPage.status, 400, writeOnlyPage.text);
    assert.match(writeOnlyPage.text, /必须与 portfolio:read 一起申请/);

    // 同意页 GET 已拒绝（上面的循环）；直接提交 POST 也不得发出授权码，不能只靠页面拦截。
    const adminParams = authorizeParams({ clientId: client.client_id, challenge, scope: 'portfolio:admin', resource });
    const adminPost = await fetch(`${server.issuer}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(adminParams), password: PASSWORD }).toString(),
      redirect: 'manual',
    });
    const adminLocation = adminPost.status === 302 ? new URL(adminPost.headers.get('location')) : null;
    assert.equal(adminLocation?.searchParams.get('code') ?? null, null, 'portfolio:admin 的 POST 不得发出授权码');

    const wrong = await consent(server, client, 'portfolio:read research:append', { password: 'wrong-password-value' });
    assert.equal(wrong.status, 401, '错误密码不得重定向');
    assert.equal(wrong.location, null, '错误密码不得发出授权码');
    assert.match(wrong.page.text, /<code>portfolio:read research:append<\/code>/);
  } finally { await server.stop(); }
});

test('S8 无效、过期、错误 audience、只写的令牌都被拒绝', async () => {
  const server = await startServer({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const client = await registerClient(server);
    const revoked = server.mintRaw({ clientId: client.client_id, scope: 'portfolio:read research:append' });
    const cases = [
      ['无令牌', undefined, 401, /error_description="missing_token"/],
      ['伪造令牌', 'not-a-real-token', 401, /error_description="invalid_token"/],
      ['过期双权限令牌', server.mintRaw({ clientId: client.client_id, scope: 'portfolio:read research:append', expiresAt: Date.now() - 1000 }), 401, /error_description="token_expired"/],
      ['错误 resource 的双权限令牌', server.mintRaw({ clientId: client.client_id, scope: 'portfolio:read research:append', resource: 'https://evil.example.com/private/mcp' }), 401, /error_description="wrong_audience"/],
      ['错误 issuer 的双权限令牌', server.mintRaw({ clientId: client.client_id, scope: 'portfolio:read research:append', issuer: 'https://evil.example.com' }), 401, /error_description="wrong_issuer"/],
      ['已撤销的双权限令牌', revoked, 401, /error_description="token_revoked"/],
      // 只写：HTTP 入口要求读，所以连追加也进不去。挑战是 insufficient_scope（缺读），下面单独断言只点名读。
      ['只有 research:append 的令牌', server.mintRaw({ clientId: client.client_id, scope: 'research:append' }), 403, /error="insufficient_scope"/],
    ];
    server.revokeRaw(revoked);
    for (const [label, token, status, expected] of cases) {
      for (const name of [READ_TOOL, APPEND]) {
        const res = await server.rpc('tools/call', { name, arguments: {} }, token);
        assert.equal(res.status, status, `${label} / ${name}: ${res.text}`);
        assert.match(appendChallenge(res), expected, `${label} / ${name}`);
      }
    }
    const writeOnly = await server.rpc('tools/call', { name: APPEND, arguments: {} }, cases[6][1]);
    assert.match(appendChallenge(writeOnly), /scope="portfolio:read"/, '只写令牌的挑战只要求读，由客户端按缺失项重新授权');
  } finally { await server.stop(); }
});

test('S9 未开启强制时保持兼容：只读令牌仍能到达追加工具（过渡期，待用户重新授权后再开启）', async () => {
  const server = await startServer({});
  try {
    const client = await registerClient(server);
    const token = await grantedToken(server, client, 'portfolio:read');
    const res = await server.rpc('tools/call', { name: APPEND, arguments: {} }, token.access_token);
    assert.notEqual(res.status, 403, res.text);
    assert.equal(res.status, 400, `只读令牌在未强制时进入业务校验：${res.text}`);
  } finally { await server.stop(); }
});
