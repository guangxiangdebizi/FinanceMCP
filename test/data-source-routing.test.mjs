import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import {
  DEFAULT_SOURCE_PRIORITY,
  parseSourcePriority,
  runWithRequestContext,
} from '../build/config.js';
import { toolList } from '../build/dispatch.js';
import { routeToolCall } from '../build/utils/dataSourceRouter.js';

function textOf(result) {
  return (result.content ?? []).map(item => item.text ?? '').join('\n');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
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

test('keeps the MCP tool surface unchanged', () => {
  assert.equal(toolList.length, 19);
  assert.equal(toolList.some(tool => tool.name.startsWith('qveris')), false);
  assert.equal(toolList.some(tool => 'data_source' in (tool.inputSchema?.properties ?? {})), false);
});

test('normalizes source priority and appends default fallbacks', () => {
  assert.deepEqual(DEFAULT_SOURCE_PRIORITY, ['tushare', 'qveris', 'binance']);
  assert.deepEqual(parseSourcePriority('qveris > tushare'), ['qveris', 'tushare', 'binance']);
  assert.deepEqual(parseSourcePriority('BINANCE,unknown,binance'), ['binance', 'tushare', 'qveris']);
});

test('uses Tushare first by default when both credentials exist', async () => {
  let nativeCalls = 0;
  const result = await runWithRequestContext({
    tushareToken: 'ts-test',
    qverisApiKey: 'qv-test',
  }, () => routeToolCall('company_performance_us', {
    ts_code: 'AAPL',
    data_type: 'income',
    start_date: '20230101',
    end_date: '20231231',
  }, async () => {
    nativeCalls += 1;
    return { content: [{ type: 'text', text: '# native result' }] };
  }));

  assert.equal(nativeCalls, 1);
  assert.match(textOf(result), /^数据来源: Tushare/m);
  assert.doesNotMatch(textOf(result), /数据源路由:/);
});

test('routes through Qveris and falls back to Tushare', async () => {
  const requests = [];
  let mode = 'success';
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ url: request.url, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');

    if (request.url === '/search') {
      const results = mode === 'empty' ? [] : [{
        tool_id: 'mock_finance.income.retrieve.v1',
        name: 'Mock Income Statement',
        provider_name: 'Mock Finance',
        params: [
          { name: 'symbol', type: 'string', required: true },
          { name: 'limit', type: 'integer', required: false },
          { name: 'period', type: 'string', required: false, enum: ['annual', 'quarter'] },
        ],
        expected_cost: '1',
      }, ...(mode === 'call-fail' ? [{
        tool_id: 'mock_finance.income.retrieve.v2',
        name: 'Second Mock Income Statement',
        provider_name: 'Mock Finance',
        params: [
          { name: 'symbol', type: 'string', required: true },
          { name: 'limit', type: 'integer', required: false },
          { name: 'period', type: 'string', required: false, enum: ['annual', 'quarter'] },
        ],
        expected_cost: '2',
      }] : [])];
      response.end(JSON.stringify({
        query: body.query,
        search_id: 'srch_test',
        total: results.length,
        results,
      }));
      return;
    }
    if (request.url === '/tools/by-ids') {
      response.end(JSON.stringify({
        search_id: body.search_id,
        total: body.tool_ids.length,
        results: body.tool_ids.map((toolId, index) => ({
          tool_id: toolId,
          name: index === 0 ? 'Mock Income Statement' : 'Second Mock Income Statement',
          provider_name: 'Mock Finance',
          params: [
            { name: 'symbol', type: 'string', required: true },
            { name: 'limit', type: 'integer', required: false },
            { name: 'period', type: 'string', required: false, enum: ['annual', 'quarter'] },
          ],
          expected_cost: String(index + 1),
        })),
      }));
      return;
    }
    if (request.url?.startsWith('/tools/probe?tool_id=mock_finance.income.retrieve.')) {
      response.end(JSON.stringify({ schema: { valid: true }, quote: { estimate_credits: 1 } }));
      return;
    }
    if (request.url?.startsWith('/tools/execute?tool_id=mock_finance.income.retrieve.')) {
      response.end(JSON.stringify({
        execution_id: 'exec_test',
        success: mode !== 'call-fail',
        result: { data: [{ symbol: body.parameters.symbol, revenue: 100 }] },
        cost: 1,
        remaining_credits: 99,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });

  const port = await listen(mock);
  const previousBaseUrl = process.env.QVERIS_BASE_URL;
  process.env.QVERIS_BASE_URL = `http://127.0.0.1:${port}`;

  try {
    let nativeCalls = 0;
    const args = {
      ts_code: 'AAPL',
      data_type: 'income',
      start_date: '20230101',
      end_date: '20231231',
      period: '20231231',
    };
    const qverisResult = await runWithRequestContext({
      tushareToken: 'ts-test',
      qverisApiKey: 'qv-test',
      sourcePriority: ['qveris', 'tushare', 'binance'],
    }, () => routeToolCall('company_performance_us', args, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# native result' }] };
    }));

    assert.equal(nativeCalls, 0);
    assert.match(textOf(qverisResult), /^数据来源: Qveris/m);
    assert.match(textOf(qverisResult), /"symbol": "AAPL"/);
    assert.equal(requests.length, 4);
    assert.equal(requests.every(item => item.headers.authorization === 'Bearer qv-test'), true);
    assert.deepEqual(requests[2].body, {
      parameters: { symbol: 'AAPL', limit: 20, period: 'annual' },
      checks: ['schema', 'quote'],
      live_budget: 'none',
    });

    mode = 'empty';
    const fallbackResult = await runWithRequestContext({
      tushareToken: 'ts-test',
      qverisApiKey: 'qv-test',
      sourcePriority: ['qveris', 'tushare', 'binance'],
    }, () => routeToolCall('company_performance_us', args, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# fallback result' }] };
    }));

    assert.equal(nativeCalls, 1);
    assert.match(textOf(fallbackResult), /^数据来源: Tushare/m);
    assert.match(textOf(fallbackResult), /Qveris（接口未覆盖） → Tushare（成功）/);

    mode = 'call-fail';
    const callsBeforeFailure = requests.filter(item => item.url?.startsWith('/tools/execute')).length;
    const failedCallFallback = await runWithRequestContext({
      tushareToken: 'ts-test',
      qverisApiKey: 'qv-test',
      sourcePriority: ['qveris', 'tushare', 'binance'],
    }, () => routeToolCall('company_performance_us', args, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# fallback after failed call' }] };
    }));
    const callsAfterFailure = requests.filter(item => item.url?.startsWith('/tools/execute')).length;

    assert.equal(nativeCalls, 2);
    assert.equal(callsAfterFailure - callsBeforeFailure, 1);
    assert.match(textOf(failedCallFallback), /^数据来源: Tushare/m);

    mode = 'success';
    const financePort = await reservePort();
    const requestKey = 'qv-request-header-test';
    const child = spawn(process.execPath, ['build/httpServer.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(financePort),
        TUSHARE_TOKEN: '',
        QVERIS_API_KEY: '',
        QVERIS_BASE_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childLogs = '';
    child.stdout.on('data', chunk => { childLogs += chunk.toString(); });
    child.stderr.on('data', chunk => { childLogs += chunk.toString(); });

    try {
      await waitForHealth(financePort);
      const response = await fetch(`http://127.0.0.1:${financePort}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Qveris-Api-Key': requestKey,
          'X-Finance-Source-Priority': 'qveris,tushare,binance',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'company_performance_us', arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const rpc = await response.json();
      assert.match(textOf(rpc.result), /^数据来源: Qveris/m);
      assert.equal(requests.at(-1).headers.authorization, `Bearer ${requestKey}`);
    } finally {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }

    assert.equal(childLogs.includes(requestKey), false);
    assert.match(childLogs, /\[REDACTED\]/);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.QVERIS_BASE_URL;
    else process.env.QVERIS_BASE_URL = previousBaseUrl;
    await new Promise(resolve => mock.close(resolve));
  }
});
