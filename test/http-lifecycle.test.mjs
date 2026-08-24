import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';

const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('HTTP test server did not become healthy');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}

test('HTTP lifecycle preserves proxy hardening and supports session deletion', async () => {
  const port = await reservePort();
  const childEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    MCP_ALLOWED_HOSTS: '',
    TUSHARE_TOKEN: '',
    QVERIS_API_KEY: '',
  };
  delete childEnv.MCP_HTTP_HOST;
  delete childEnv.HOST;

  let stdout = '';
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });

  try {
    await waitForServer(port);

    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.has('x-powered-by'), false);

    const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'http-lifecycle-test', version: '1.0' },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get('mcp-session-id');
    assert.match(sessionId, /^[0-9a-f-]{36}$/i);
    const initialized = await initialize.json();
    assert.equal(initialized.result.serverInfo.version, packageVersion);

    const active = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(active.activeSessions, 1);

    const preflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'DELETE',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /DELETE/);

    const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
    });
    assert.equal(deleted.status, 204);

    const inactive = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(inactive.activeSessions, 0);

    const logDeadline = Date.now() + 2000;
    while (!stdout.includes('IP: 203.0.113.10') && Date.now() < logDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(stdout, /IP: 203\.0\.113\.10/);
  } finally {
    await stopServer(child);
  }
});
