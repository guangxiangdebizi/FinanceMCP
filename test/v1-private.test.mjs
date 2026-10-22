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
{
  const { openPortfolioDb } = await import('../build/portfolio/db.js');
  const { initBaseline } = await import('../build/portfolio/ledger.js');
  const { readSnapshot, importSnapshot } = await import('../build/portfolio/account.js');
  const db = openPortfolioDb(PORTFOLIO_DB, { marketPath: MARKET_DB });
  try {
    importSnapshot(db, { ...readSnapshot(db, 'demo-2026-10-18'), snapshot_id: 'synthetic-private', as_of: '2026-10-16', source: 'synthetic-fixture' });
    initBaseline(db, 'synthetic-private', { asOf: '20261016', snapshotId: 'synthetic-private' });
  } finally { db.close(); }
}

// 创建一个市场缓存文件：schema 完整但没有 fund_* 表，模拟"生产缓存尚未同步 ETF 数据"
// 的真实状态。这样公网市场工具能正常返回（V1-P7 需要），而 ETF 相关能力必须显式降级
// （V1-P4/P5 需要）。
{
  const { openAshareDb } = await import('../build/ashare/db.js');
  const market = openAshareDb(MARKET_DB);
  for (const t of ['fund_basic', 'fund_daily', 'fund_adj', 'fund_share', 'fund_sync_log']) {
    market.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  // 最小交易日历：公网 ashare_data_status 需要它才不会直接报"日历为空"。
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

async function startServer(env) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      // 公网 profile 必须暴露九个市场工具，V1-P7 才能验证它们没被私有工具破坏。
      FINANCE_TOOL_PROFILE: 'ashare_daily',
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
    // Every private tool is read-only, except exactly the one append-only ChatGPT intake tool.
    for (const tool of list.body.result.tools) {
      if (tool.name === 'ashare_chatgpt_research_record_append') {
        assert.deepEqual(tool.annotations, { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true });
        continue;
      }
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 必须是只读`);
    }
    assert.equal(list.body.result.tools.filter(t => t.annotations?.readOnlyHint !== true).length, 1, 'exactly one non-read-only private tool');
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
      arguments: { account_id: 'synthetic-private', as_of_trade_date: '20261016' },
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
      arguments: { account_id: 'synthetic-private', end_date: '20261016' },
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
    assert.equal(basket.weights_status, 'approved');
    assert.equal(cmp.definition_version, 'r2-benchmarks-1.1.0');
    assert.equal(cmp.basket_definition.approved_on, '20261022');
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

// ---------------------------------------------------------------- 7. 共享连接不得被关闭

test('V1-P7 调用私有研究工具后，公网九个市场工具必须仍然可用', async () => {
  // 生产事故复现：私有工具若关闭了进程级共享的市场连接，随后每个公网市场工具调用
  // 都会返回 "database is not open"，直到进程重启。这里在**同一个服务进程**里按
  // 顺序调用，用公网工具是否还能读到数据来判定。
  const server = await startServer({ ASHARE_PRIVATE_PORTFOLIO_TOKEN: TOKEN });
  try {
    // 先确认公网市场工具本身可用（该库没有任何 A 股行情，但工具应正常返回而不是报错）。
    const before = await server.rpc('/mcp', 'tools/call', { name: 'ashare_data_status', arguments: {} });
    assert.equal(before.status, 200, `公网工具初始不可用：${before.text}`);

    for (const name of V1_TOOLS) {
      const res = await server.rpc('/private/mcp', 'tools/call', { name, arguments: {} }, AUTH);
      assert.equal(res.status, 200, `${name}: ${res.text}`);
    }

    // 关键断言：共享连接若被私有工具关闭，这里会得到 "database is not open"。
    const after = await server.rpc('/mcp', 'tools/call', { name: 'ashare_data_status', arguments: {} });
    assert.equal(after.status, 200, `私有工具破坏了公网市场工具：${after.text}`);
    assert.equal(/database is not open/.test(after.text), false, after.text);
  } finally { await server.stop(); }
});

test('V1-P8 私有研究工具在进程内不得关闭共享市场连接（句柄身份不变）', async () => {
  // V1-P7 只能观察到"没有停机"，而 getAshareDb 的自愈会掩盖"工具关闭了共享连接"
  // 这个根因。这里在同一个进程内直接调用实现，断言共享句柄身份不变。
  const { openAshareDb, getAshareDb, closeAshareDb } = await import('../build/ashare/db.js');
  const { runPortfolioResearchTool } = await import('../build/portfolio/researchTools.js');

  const saved = { ...process.env };
  process.env.ASHARE_DATA_DIR = dir;
  process.env.ASHARE_DB_PATH = MARKET_DB;
  process.env.ASHARE_PORTFOLIO_DB_PATH = PORTFOLIO_DB;
  process.env.ASHARE_PORTFOLIO_ENABLED = '1';
  try {
    openAshareDb(MARKET_DB).close();
    const before = getAshareDb();
    for (const name of V1_TOOLS) {
      assert.doesNotThrow(() => runPortfolioResearchTool(name, {}), name);
    }
    const after = getAshareDb();
    assert.equal(after, before, '私有研究工具关闭了共享市场连接（公网九个市场工具会全部失效）');
    assert.doesNotThrow(() => after.prepare('SELECT 1').get());
    closeAshareDb();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
