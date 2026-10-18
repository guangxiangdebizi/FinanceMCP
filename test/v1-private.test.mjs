import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// V1.0 private endpoint integration: the three new account-side research tools
// (daily report, ETF candidates, benchmarks) must be reachable only through the
// authenticated private endpoint, must never appear on the public endpoint, and
// must degrade explicitly when the market cache lacks fund_* tables.
//
// All data here is synthetic. The account is the demo snapshot, not the user.

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ashare-v1-private-'));
const MARKET_DB = join(dir, 'ashare.sqlite');
const PORTFOLIO_DB = join(dir, 'portfolio.sqlite');
const TOKEN = 'v1-private-test-token-0123456789abcdef';

const V1_TOOLS = ['ashare_portfolio_daily_report', 'ashare_etf_candidates', 'ashare_portfolio_benchmarks'];

const imported = spawnSync(process.execPath, [join(ROOT, 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
  cwd: dir,
  env: { ...process.env, ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: PORTFOLIO_DB },
  encoding: 'utf8',
});
assert.equal(imported.status, 0, imported.stderr);

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
  child.stdout.on('data', c => { logs += c; });
  child.stderr.on('data', c => { logs += c; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
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

const AUTH = { Authorization: `Bearer ${TOKEN}` };

test('V1-P1 the private endpoint advertises the three V1.0 research tools', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    const list = await server.rpc('/private/mcp', 'tools/list', {}, AUTH);
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map(t => t.name);
    for (const name of V1_TOOLS) assert.ok(names.includes(name), `缺少 ${name}`);
    // Every private tool is read-only and account-side.
    for (const tool of list.body.result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 必须是只读`);
    }
  } finally { await server.stop(); }
});

test('V1-P2 the public endpoint never exposes any of them', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    const list = await server.rpc('/mcp', 'tools/list', {});
    const names = list.body.result.tools.map(t => t.name);
    for (const name of V1_TOOLS) assert.equal(names.includes(name), false, `公网泄露 ${name}`);
    for (const name of V1_TOOLS) {
      const call = await server.rpc('/mcp', 'tools/call', { name, arguments: {} });
      assert.notEqual(call.status, 200, `公网不得执行 ${name}`);
    }
  } finally { await server.stop(); }
});

test('V1-P3 daily report degrades explicitly when the market cache has no fund_* tables', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    const res = await server.rpc('/private/mcp', 'tools/call', {
      name: 'ashare_portfolio_daily_report',
      arguments: { account_id: 'demo', as_of_trade_date: '20261016' },
    }, AUTH);
    assert.equal(res.status, 200, res.text);
    const report = JSON.parse(res.body.result.content[0].text);
    assert.equal(report.schema, 'ashare-daily-action-report/1.0');
    // The first section is always the action list.
    assert.equal(report.first_section.heading, '下一交易日最值得做的 0-3 个动作及理由');
    assert.ok(report.first_section.count <= 3);
    // The demo account is never current → never actionable.
    assert.equal(report.actionable, false);
    assert.notEqual(report.status, 'ACTIONABLE');
    // Degradation must be visible, not silent.
    assert.ok(['DEGRADED', 'INSUFFICIENT'].includes(report.data_quality.status), JSON.stringify(report.data_quality));
    // All five holdings are still listed with an explicit stance.
    assert.equal(report.holdings.length, 5);
    for (const h of report.holdings) assert.ok(typeof h.stance === 'string' && h.stance.length > 0);
  } finally { await server.stop(); }
});

test('V1-P4 ETF candidate screen keeps the five held ETFs and marks missing data DEGRADED', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    const res = await server.rpc('/private/mcp', 'tools/call', {
      name: 'ashare_etf_candidates',
      arguments: { as_of_trade_date: '20261016' },
    }, AUTH);
    assert.equal(res.status, 200, res.text);
    const screen = JSON.parse(res.body.result.content[0].text);
    assert.equal(screen.schema, 'ashare-etf-candidate-screen/1.0');
    for (const code of ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH']) {
      assert.ok(screen.held.includes(code), `持仓 ${code} 必须始终在列`);
    }
    // Without fund_* tables nothing may be silently dropped as "clean".
    assert.notEqual(screen.data_coverage.status, 'READY');
    assert.ok(screen.data_coverage.missing_tables.length > 0);
    assert.ok(screen.candidates.every(c => c.status === 'DEGRADED'), '全部候选应显式 DEGRADED');
    // The screen must say out loud that it is research, not a buy signal.
    assert.equal(typeof screen.disclaimer, 'string');
    assert.match(screen.disclaimer, /不是|研究|候选/);
  } finally { await server.stop(); }
});

test('V1-P5 benchmarks are UNAVAILABLE rather than fabricated when data is missing', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    const res = await server.rpc('/private/mcp', 'tools/call', {
      name: 'ashare_portfolio_benchmarks',
      arguments: {},
    }, AUTH);
    assert.equal(res.status, 200, res.text);
    const cmp = JSON.parse(res.body.result.content[0].text);
    assert.equal(cmp.schema, 'ashare-benchmark-comparison/1.0');
    assert.ok(Array.isArray(cmp.benchmarks) && cmp.benchmarks.length === 3);
    for (const b of cmp.benchmarks) {
      assert.equal(b.status, 'UNAVAILABLE', `${b.id} 无数据时必须 unavailable`);
      assert.equal(b.total_return_pct ?? null, null, '不得编造收益');
    }
    // The multi-asset weights are declared provisional, never silently "final".
    const basket = cmp.benchmarks.find(b => b.id === 'frozen_multi_asset_basket');
    assert.ok(basket, JSON.stringify(cmp.benchmarks.map(b => b.id)));
    assert.equal(basket.weights_status, 'provisional_pending_user_approval');
    // The definitions are frozen in advance, not chosen after seeing results.
    assert.equal(cmp.definition_frozen, true);
  } finally { await server.stop(); }
});

test('V1-P6 an unauthenticated caller cannot reach any V1.0 tool', async () => {
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    for (const name of V1_TOOLS) {
      const res = await server.rpc('/private/mcp', 'tools/call', { name, arguments: {} });
      assert.equal(res.status, 401, `${name} 未鉴权必须 401`);
      assert.equal(res.text, '', '401 不得泄露任何内容');
    }
  } finally { await server.stop(); }
});
