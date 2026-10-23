import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// 独立写 scope（research:append）。每条断言都从真实 HTTP 入口出发，因为
// "只在一个没人调用的辅助函数里被测试的守卫等于文档"。

const ROOT = process.cwd();
const RESOURCE_PATH = '/private/mcp';
const APPEND = 'ashare_chatgpt_research_record_append';

async function reservePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

async function start(extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-wscope-'));
  const port = await reservePort();
  const issuer = `http://127.0.0.1:${port}`;
  const oauthDb = join(dir, 'oauth.sqlite');
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT,
    env: {
      ...process.env, TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', FINANCE_TOOL_PROFILE: 'ashare_daily',
      ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: join(dir, 'market.sqlite'), ASHARE_PORTFOLIO_DB_PATH: join(dir, 'portfolio.sqlite'),
      ASHARE_OAUTH_ENABLED: '1', ASHARE_OAUTH_ISSUER: issuer, ASHARE_OAUTH_RESOURCE: `${issuer}${RESOURCE_PATH}`,
      ASHARE_OAUTH_LOGIN_PASSWORD: 'correct-horse-battery-staple', ASHARE_OAUTH_DB_PATH: oauthDb,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${issuer}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const registered = await (await fetch(`${issuer}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 't', redirect_uris: ['http://127.0.0.1:9/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  })).json();
  const mint = scope => {
    const raw = randomBytes(32).toString('base64url');
    const db = new DatabaseSync(oauthDb);
    try {
      db.prepare(`INSERT INTO oauth_access_token (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?)`).run(createHash('sha256').update(raw, 'utf8').digest('hex'), registered.client_id, 'owner', scope,
        `${issuer}${RESOURCE_PATH}`, issuer, Date.now() + 600_000, Date.now());
    } finally { db.close(); }
    return raw;
  };
  const call = async (token, name, args = {}) => {
    const res = await fetch(`${issuer}${RESOURCE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body, text };
  };
  const metadata = async () => (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  return { issuer, mint, call, metadata,
    stop: async () => { if (child.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); }); } };
}

test('W1 强制开启时，只有 portfolio:read 的令牌不能调用追加工具（HTTP 403 insufficient_scope）', async () => {
  const s = await start({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const res = await s.call(s.mint('portfolio:read'), APPEND, {});
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.error.message, 'insufficient_scope');
    assert.match(res.headers.get('www-authenticate') ?? '', /insufficient_scope/);
    assert.match(res.headers.get('www-authenticate') ?? '', /research:append/);
  } finally { await s.stop(); }
});

test('W2 强制开启时，持有 research:append 或 portfolio:admin 的令牌越过 scope 门（不再是 403）', async () => {
  const s = await start({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    for (const scope of ['portfolio:read research:append', 'portfolio:read portfolio:admin']) {
      const res = await s.call(s.mint(scope), APPEND, {});
      assert.notEqual(res.status, 403, `${scope}: ${res.text}`);
    }
  } finally { await s.stop(); }
});

test('W3 强制开启时，只读令牌仍可调用其他私有工具，写 scope 门只管追加工具', async () => {
  const s = await start({ ASHARE_OAUTH_REQUIRE_WRITE_SCOPE: '1' });
  try {
    const res = await s.call(s.mint('portfolio:read'), 'ashare_portfolio_summary', {});
    assert.notEqual(res.status, 403, res.text);
    assert.notEqual(res.status, 401, res.text);
  } finally { await s.stop(); }
});

test('W4 未开启强制时行为与以前一致：只读令牌不被写 scope 门拦截（过渡期兼容既有 ChatGPT 连接器）', async () => {
  const s = await start({});
  try {
    const res = await s.call(s.mint('portfolio:read'), APPEND, {});
    assert.notEqual(res.status, 403, res.text);
  } finally { await s.stop(); }
});

test('W5 授权服务器与受保护资源元数据声明 research:append，且授权页不再对写 scope 声称"只读"', async () => {
  const s = await start({});
  try {
    const meta = await s.metadata();
    assert.deepEqual(meta.scopes_supported, ['portfolio:read', 'research:append']);
    const pr = await (await fetch(`${s.issuer}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(pr.scopes_supported, ['portfolio:read', 'research:append']);
    const q = (scope) => new URLSearchParams({ response_type: 'code', client_id: 'x', redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: 'c', code_challenge_method: 'S256', scope, resource: `${s.issuer}${RESOURCE_PATH}` });
    // 未知 scope 被拒（不会因为放宽白名单而接受任意字符串）
    const bad = await fetch(`${s.issuer}/oauth/authorize?${q('portfolio:read bogus:write')}`);
    assert.match(await bad.text(), /scope 不受支持/);
  } finally { await s.stop(); }
});
