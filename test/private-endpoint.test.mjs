import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 私有账户端点（A5）集成测试：真实启动 HTTP 服务，验证路由门控、鉴权、工具隔离与
// 并发不串味。账户库是合成的演示快照，不是用户真实账户。

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ashare-private-'));
const MARKET_DB = join(dir, 'ashare.sqlite');
const PORTFOLIO_DB = join(dir, 'portfolio.sqlite');
const TOKEN = 'test-private-token-9f3a7c1b5e6d';

const ACCOUNT_TOOLS = [
  'ashare_portfolio_summary',
  'ashare_portfolio_scenario',
  'ashare_portfolio_decision',
  // V1.0 C2/C6/D1：研究候选、固定基准与收盘日报（仍为账户侧只读工具）。
  'ashare_portfolio_daily_report',
  'ashare_etf_candidates',
  'ashare_portfolio_benchmarks',
  'ashare_investment_research_bundle',
  // 唯一的写入口：只追加的 ChatGPT 研究记录（见 test/upgrade-chatgpt-intake.test.mjs）。
  'ashare_chatgpt_research_record_append',
];

// 先准备好合成账户库（CLI 导入，幂等）。
const imported = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
  cwd: dir,
  env: { ...process.env, ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB },
  encoding: 'utf8',
});
assert.equal(imported.status, 0, imported.stderr);
// Register a synthetic account explicitly; an unconfigured demo is never the default.
{
  const { openPortfolioDb } = await import('../build/portfolio/db.js');
  const { initBaseline } = await import('../build/portfolio/ledger.js');
  const db = openPortfolioDb(PORTFOLIO_DB, { marketPath: MARKET_DB });
  try { initBaseline(db, 'synthetic-private', { asOf: '20261018', snapshotId: 'demo-2026-10-18' }); }
  finally { db.close(); }
}

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
    cwd: ROOT,
    env: {
      ...process.env,
      TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
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
    async rpc(path, method, params = {}, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { status: res.status, body, headers: res.headers, text };
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    },
  };
}

// ---------------------------------------------------------------- 1. 令牌未设置

test('1. 未设置 ASHARE_PRIVATE_PORTFOLIO_TOKEN 时 /private/mcp 返回 404（不广告自身）', async () => {
  const server = await startServer({ ASHARE_PORTFOLIO_ENABLED: '1' });
  try {
    for (const [path, method] of [['/private/mcp', 'initialize'], ['/private/mcp', 'tools/list']]) {
      const res = await server.rpc(path, method, {});
      assert.equal(res.status, 404, `${method} 应为 404`);
      assert.equal(res.headers.get('www-authenticate'), null, '未启用时不得返回 WWW-Authenticate');
      assert.equal(res.headers.get('mcp-session-id'), null);
    }
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- 2. 鉴权

test('2. 缺失/错误令牌 → 401 + WWW-Authenticate，且不创建会话、不泄露细节', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PORTFOLIO_ENABLED: '1' });
  try {
    const missing = await server.rpc('/private/mcp', 'initialize', {});
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
    assert.equal(missing.headers.get('mcp-session-id'), null, '未通过鉴权不得创建会话');
    assert.equal(missing.text, '', '401 响应体不提供任何细节');

    for (const bad of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase()]) {
      const res = await server.rpc('/private/mcp', 'initialize', {}, { Authorization: `Bearer ${bad}` });
      assert.equal(res.status, 401, `错误令牌 ${bad.slice(0, 8)}… 必须被拒绝`);
      assert.equal(res.headers.get('mcp-session-id'), null);
    }
    // 非 Bearer 形式同样拒绝
    const basic = await server.rpc('/private/mcp', 'initialize', {}, { Authorization: `Basic ${TOKEN}` });
    assert.equal(basic.status, 401);
    // 令牌没有出现在日志里
    assert.equal(server.logs().includes(TOKEN), false, '日志不得包含令牌明文');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- 3. 正确令牌

test('3. 正确令牌 → 200，且只列出账户工具', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PORTFOLIO_ENABLED: '1' });
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const init = await server.rpc('/private/mcp', 'initialize', {}, auth);
    assert.equal(init.status, 200);
    assert.ok(init.headers.get('mcp-session-id'));

    const list = await server.rpc('/private/mcp', 'tools/list', {}, auth);
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map(t => t.name);
    assert.deepEqual(names.slice().sort(), ACCOUNT_TOOLS.slice().sort());
    for (const name of ACCOUNT_TOOLS) assert.ok(names.includes(name), name);
    // 没有任何市场工具
    assert.equal(names.includes('stock_data'), false);
    assert.equal(names.includes('ashare_daily_report'), false);
    assert.equal(names.includes('current_timestamp'), false);

    const summary = await server.rpc('/private/mcp', 'tools/call', { name: 'ashare_portfolio_summary', arguments: {} }, auth);
    assert.equal(summary.status, 200, summary.text);
    const body = JSON.parse(summary.body.result.content[0].text);
    assert.equal(body.summary.totals.total_assets_cents, 7577653);
    assert.equal(body.summary.max_drawdown.available, false);

    // 决策工具同样只在私有端点提供：无市场缓存时给出结构化 DATA_INSUFFICIENT/对照，
    // 而不是 "Unknown tool"。
    const decision = await server.rpc('/private/mcp', 'tools/call', { name: 'ashare_portfolio_decision', arguments: { action: 'hold' } }, auth);
    assert.equal(decision.status, 200, decision.text);
    const d = JSON.parse(decision.body.result.content[0].text);
    assert.equal(d.schema, 'ashare-portfolio-decision/1.0');
    assert.deepEqual(d.options.map(o => o.action), ['HOLD', 'REDUCE_EQUITY', 'SELL_AND_BUY', 'NO_ACTION']);
    assert.equal(d.quotes.source, 'server_cache');
  } finally {
    await server.stop();
  }
});

test('3b. 私有端点拒绝市场工具，并给出明确原因', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PORTFOLIO_ENABLED: '1' });
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const name of ['stock_data', 'ashare_daily_report', 'current_timestamp']) {
      const res = await server.rpc('/private/mcp', 'tools/call', { name, arguments: {} }, auth);
      assert.equal(res.status, 400, name);
      assert.match(res.body.error.message, /market_tool_not_available_on_private_endpoint/);
    }
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- 4. 公网硬拒绝

test('4. 公网 /mcp 即使 ASHARE_PORTFOLIO_ENABLED=1 也不广告、不执行账户工具', async () => {
  const server = await startServer({ ASHARE_PORTFOLIO_ENABLED: '1' });
  try {
    const list = await server.rpc('/mcp', 'tools/list', {});
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map(t => t.name);
    for (const name of ACCOUNT_TOOLS) assert.equal(names.includes(name), false, `${name} 不得出现在公网 tools/list`);
    assert.ok(names.includes('current_timestamp'), '市场工具仍然可用');

    for (const name of ACCOUNT_TOOLS) {
      const res = await server.rpc('/mcp', 'tools/call', { name, arguments: {} });
      assert.equal(res.status, 400, name);
      assert.match(res.body.error.message, /private_endpoint_required/);
    }
  } finally {
    await server.stop();
  }
});

test('4b. 公网 /mcp 未开启账户开关时同样不泄露', async () => {
  const server = await startServer({});
  try {
    const list = await server.rpc('/mcp', 'tools/list', {});
    const names = list.body.result.tools.map(t => t.name);
    for (const name of ACCOUNT_TOOLS) assert.equal(names.includes(name), false, name);
    const res = await server.rpc('/mcp', 'tools/call', { name: 'ashare_portfolio_summary', arguments: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /private_endpoint_required/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- 5. 并发不串味

test('5. 公网与私有端点并发请求不会互相泄露工具集', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PORTFOLIO_ENABLED: '1', ASHARE_PRIVATE_RATE_LIMIT: '500' });
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const rounds = Array.from({ length: 12 }, (_, i) => i);
    const results = await Promise.all(rounds.flatMap(() => [
      server.rpc('/mcp', 'tools/list', {}),
      server.rpc('/private/mcp', 'tools/list', {}, auth),
    ]));
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.equal(res.status, 200);
      const names = res.body.result.tools.map(t => t.name);
      if (i % 2 === 0) {
        // 公网：绝无账户工具
        for (const name of ACCOUNT_TOOLS) assert.equal(names.includes(name), false, `公网并发请求泄露了 ${name}`);
      } else {
        // 私有：只有账户工具
        assert.deepEqual(names.slice().sort(), ACCOUNT_TOOLS.slice().sort());
      }
    }
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- 6. 限流

test('6. 私有端点按 IP 限流（默认 10/分钟，可覆盖）', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN, ASHARE_PORTFOLIO_ENABLED: '1', ASHARE_PRIVATE_RATE_LIMIT: '2' });
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const first = await server.rpc('/private/mcp', 'tools/list', {}, auth);
    const second = await server.rpc('/private/mcp', 'tools/list', {}, auth);
    const third = await server.rpc('/private/mcp', 'tools/list', {}, auth);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.match(third.body.error.message, /Too many requests/);
    // 公网端点不受私有端点限流影响（各自独立窗口）
    const publicList = await server.rpc('/mcp', 'tools/list', {});
    assert.equal(publicList.status, 200);
  } finally {
    await server.stop();
  }
});
