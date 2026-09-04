import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import { runWithRequestContext } from '../build/config.js';
import { dispatchTool, getAvailableToolList } from '../build/dispatch.js';

function names(tools) {
  return tools.map(tool => tool.name);
}

function namedTool(tools, name) {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool, `Expected tools/list to include ${name}`);
  return tool;
}

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
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

test('Qveris-only requests advertise the adapter-covered tools', async () => {
  const tools = await runWithRequestContext({ qverisApiKey: 'qveris-test-key' }, async () => {
    return getAvailableToolList();
  });
  assert.deepEqual(names(tools), [
    'finance_news',
    'stock_data',
    'stock_data_minutes',
    'index_data',
    'macro_econ',
    'company_performance',
    'company_performance_hk',
    'company_performance_us',
    'csi_index_constituents',
    'hot_news_7x24',
  ]);
});

test('Twingly-only requests advertise the existing news tools', async () => {
  const tools = await runWithRequestContext({ twinglyApiKey: 'twingly-test-key' }, async () => {
    return getAvailableToolList();
  });
  assert.deepEqual(names(tools), ['finance_news', 'hot_news_7x24']);
  const hotNews = namedTool(tools, 'hot_news_7x24');
  assert.equal(hotNews.inputSchema.properties.limit.maximum, 250);
  assert.match(hotNews.description, /当前请求将优先使用 Twingly/);
});

test('Tushare-only requests exclude Qveris-only and public-only tools', async () => {
  const tools = await runWithRequestContext({ tushareToken: 'tushare-test-token' }, async () => {
    return getAvailableToolList();
  });
  const available = names(tools);
  assert.equal(available.length, 17);
  assert.ok(available.includes('stock_data'));
  assert.ok(available.includes('fund_data'));
  assert.equal(available.includes('finance_news'), false);
  assert.equal(available.includes('current_timestamp'), false);
  assert.equal(namedTool(tools, 'hot_news_7x24').inputSchema.properties.limit.maximum, 1500);
});

test('hot-news schema follows the first configured source in request priority', async () => {
  const tools = await runWithRequestContext({
    tushareToken: 'tushare-test-token',
    twinglyApiKey: 'twingly-test-key',
    sourcePriority: ['twingly', 'tushare', 'qveris', 'binance'],
  }, async () => getAvailableToolList());
  assert.equal(namedTool(tools, 'hot_news_7x24').inputSchema.properties.limit.maximum, 250);
});

test('both credentials expose the union while keeping local-only tools scoped', async () => {
  const tools = await runWithRequestContext({
    tushareToken: 'tushare-test-token',
    qverisApiKey: 'qveris-test-key',
  }, async () => getAvailableToolList());
  const available = names(tools);
  assert.equal(available.length, 18);
  assert.ok(available.includes('finance_news'));
  assert.ok(available.includes('fund_data'));
  assert.equal(available.includes('current_timestamp'), false);
});

test('direct calls cannot bypass the filtered tool list', async () => {
  await assert.rejects(
    () => runWithRequestContext({ qverisApiKey: 'qveris-test-key' }, async () => {
      return dispatchTool('fund_data', { data_type: 'basic' });
    }),
    /not available for the configured API credentials/,
  );
});

test('HTTP tools/list applies the request credential scope', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      TUSHARE_TOKEN: '',
      QVERIS_API_KEY: '',
      TWINGLY_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(port);
    const list = async headers => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const qveris = await list({ 'X-Qveris-Api-Key': 'qveris-http-test-key' });
    const twingly = await list({ 'X-Twingly-Api-Key': 'twingly-http-test-key' });
    const tushare = await list({ 'X-Tushare-Token': 'tushare-http-test-token' });
    assert.equal(qveris.result.tools.length, 10);
    assert.equal(twingly.result.tools.length, 2);
    assert.deepEqual(names(twingly.result.tools), ['finance_news', 'hot_news_7x24']);
    assert.equal(
      namedTool(twingly.result.tools, 'hot_news_7x24').inputSchema.properties.limit.maximum,
      250,
    );
    assert.equal(tushare.result.tools.length, 17);
    assert.equal(tushare.result.tools.some(tool => tool.name === 'finance_news'), false);
    assert.equal(
      namedTool(tushare.result.tools, 'hot_news_7x24').inputSchema.properties.limit.maximum,
      1500,
    );
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
});
