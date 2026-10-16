import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ASHARE_TOOLS = ['ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis', 'ashare_sector_rank'];

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(env) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '', NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return {
    port,
    logs: () => logs,
    async rpc(method, params, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
      });
    },
  };
}

test('default profile keeps the original 19 tools and hides the A-share tools', async () => {
  const { toolList, getAvailableToolList } = await import('../build/dispatch.js');
  assert.equal(toolList.length, 19);
  const names = getAvailableToolList().map(t => t.name);
  for (const name of ASHARE_TOOLS) assert.equal(names.includes(name), false);
});

test('ashare_daily profile exposes only the A-share tools, even with a Tushare credential', async () => {
  const server = await startServer({ FINANCE_TOOL_PROFILE: 'ashare_daily', TUSHARE_TOKEN: 'server-token' });
  try {
    const list = await server.rpc('tools/list', {});
    assert.deepEqual(list.body.result.tools.map(t => t.name), ASHARE_TOOLS);
    assert.ok(list.body.result.tools.every(t => t.annotations?.readOnlyHint === true));
    const hidden = await server.rpc('tools/call', { name: 'stock_data', arguments: { code: '600519.SH', market_type: 'cn' } });
    assert.equal(hidden.status, 400);
    assert.match(hidden.body.error.message, /not available/);
  } finally {
    await server.stop();
  }
});

test('tool config file and allowlist narrow the exposed set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'));
  const file = join(dir, 'tools.json');
  writeFileSync(file, JSON.stringify({ profile: 'full', enabled_tools: ['current_timestamp', 'ashare_daily_report'] }));
  const server = await startServer({ FINANCE_TOOL_CONFIG: file });
  try {
    const list = await server.rpc('tools/list', {});
    assert.deepEqual(list.body.result.tools.map(t => t.name), ['current_timestamp', 'ashare_daily_report']);
  } finally {
    await server.stop();
  }
});

test('MCP_AUTH_TOKEN authenticates clients and the bearer is never used as a Tushare token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-http-'));
  const server = await startServer({
    FINANCE_TOOL_PROFILE: 'full',
    ASHARE_ENABLED: '1',
    MCP_AUTH_TOKEN: 'client-secret',
    ASHARE_DATA_DIR: dir,
  });
  try {
    const anonymous = await server.rpc('tools/list', {});
    assert.equal(anonymous.status, 401);
    const wrong = await server.rpc('tools/list', {}, { Authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    const ok = await server.rpc('tools/list', {}, { Authorization: 'Bearer client-secret' });
    assert.equal(ok.status, 200);
    const names = ok.body.result.tools.map(t => t.name);
    // No Tushare credential anywhere: if the bearer leaked into the Tushare scope, fund_data would appear.
    assert.equal(names.includes('fund_data'), false);
    assert.ok(ASHARE_TOOLS.every(n => names.includes(n)));
    assert.doesNotMatch(server.logs(), /Found in Authorization Bearer header/);
  } finally {
    await server.stop();
  }
});

test('request credentials can be ignored entirely', async () => {
  const server = await startServer({ MCP_ACCEPT_REQUEST_CREDENTIALS: '0' });
  try {
    const list = await server.rpc('tools/list', {}, { 'X-Tushare-Token': 'request-token', Authorization: 'Bearer request-token' });
    assert.equal(list.body.result.tools.some(t => t.name === 'fund_data'), false);
  } finally {
    await server.stop();
  }
});

test('legacy Bearer-as-Tushare behaviour is unchanged when client auth is not configured', async () => {
  const server = await startServer({});
  try {
    const list = await server.rpc('tools/list', {}, { Authorization: 'Bearer request-token' });
    assert.equal(list.body.result.tools.some(t => t.name === 'fund_data'), true);
  } finally {
    await server.stop();
  }
});

test('A-share tools bypass the external data-source router and report a missing cache plainly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-empty-'));
  const server = await startServer({ FINANCE_TOOL_PROFILE: 'ashare_daily', ASHARE_DATA_DIR: dir, QVERIS_API_KEY: 'qv' });
  try {
    const res = await server.rpc('tools/call', { name: 'ashare_daily_report', arguments: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /A股缓存不存在/);
    // The fallback router would have wrapped the outcome as a "数据来源" result instead of surfacing the error.
    assert.doesNotMatch(JSON.stringify(res.body), /数据来源|数据源路由/);
  } finally {
    await server.stop();
  }
});

test('rate limit rejects bursts per client', async () => {
  const server = await startServer({ MCP_RATE_LIMIT: '2' });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await server.rpc('tools/list', {})).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await server.stop();
  }
});

test('ping is answered so MCP clients can keep sessions alive', async () => {
  const server = await startServer({});
  try {
    const res = await server.rpc('ping', {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  } finally {
    await server.stop();
  }
});

test('MCP_BODY_LIMIT rejects oversized requests and the session map stays bounded', async () => {
  const server = await startServer({ MCP_BODY_LIMIT: '2kb', MCP_MAX_SESSIONS: '3' });
  try {
    const big = await server.rpc('tools/list', { padding: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    for (let i = 0; i < 6; i++) assert.equal((await server.rpc('initialize', {})).status, 200);
    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
    assert.ok(health.activeSessions <= 3, `sessions ${health.activeSessions}`);
  } finally {
    await server.stop();
  }
});
