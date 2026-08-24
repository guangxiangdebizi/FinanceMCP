import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function requestWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      headers: { Host: host },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await requestWithHost(port, `127.0.0.1:${port}`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('HTTP test server did not become healthy');
}

test('local HTTP server rejects DNS rebinding Host headers', async () => {
  const port = await reservePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    MCP_ALLOWED_HOSTS: '',
    TUSHARE_TOKEN: '',
    QVERIS_API_KEY: '',
  };
  delete childEnv.MCP_HTTP_HOST;
  delete childEnv.HOST;

  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port);

    const response = await requestWithHost(port, 'attacker.example');
    assert.equal(response.status, 403);
    assert.match(response.body, /Invalid Host/);
  } finally {
    if (child.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill();
      });
    }
  }
});
