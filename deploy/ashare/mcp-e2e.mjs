#!/usr/bin/env node
// End-to-end check of the public MCP endpoint: initialize → tools/list → every
// A-share tool. Usage: node mcp-e2e.mjs [url] [YYYYMMDD]
const url = process.argv[2] || 'https://share.shijingchang.cn/ashare/mcp';
const date = process.argv[3];
let id = 0;
let session;

async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  session = res.headers.get('mcp-session-id') || session;
  const body = await res.json();
  return { status: res.status, ms: Date.now() - started, body };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, ...detail });
  console.error(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail).slice(0, 200)}`);
};

const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ashare-e2e', version: '1' } });
check('initialize', init.status === 200 && !!init.body.result?.serverInfo, { status: init.status, server: init.body.result?.serverInfo });

const list = await rpc('tools/list', {});
const names = list.body.result?.tools?.map(t => t.name) ?? [];
const expected = ['ashare_data_status', 'ashare_daily_report', 'ashare_watchlist', 'ashare_stock_analysis', 'ashare_sector_rank'];
check('tools/list', JSON.stringify(names) === JSON.stringify(expected), { names });

const calls = [
  ['ashare_data_status', { date }],
  ['ashare_daily_report', { date }],
  ['ashare_daily_report', { date, format: 'json' }],
  ['ashare_watchlist', { date, history_days: 5 }],
  ['ashare_stock_analysis', { ts_code: '600519.SH', date }],
  ['ashare_sector_rank', { date, top: 10 }],
];
const outputs = {};
for (const [name, args] of calls) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.body.result?.content?.[0]?.text ?? '';
  const key = name + (args.format ? `:${args.format}` : '');
  outputs[key] = text;
  check(`tools/call ${key}`, r.status === 200 && text.length > 0 && !/NOT_READY|PENDING/.test(text.slice(0, 200)), {
    status: r.status, ms: r.ms, chars: text.length, head: text.slice(0, 120).replace(/\n/g, ' '),
  });
}

const report = JSON.parse(outputs['ashare_daily_report:json'] || '{}');
check('report fields', ['report_id', 'as_of_trade_date', 'generated_at', 'versions', 'data', 'market', 'watchlist', 'signals', 'risks'].every(k => k in report), {
  report_id: report.report_id, as_of: report.as_of_trade_date, status: report.status, members: report.watchlist?.count,
});

process.stdout.write(JSON.stringify({ url, date: date ?? null, checked_at: new Date().toISOString(), passed: results.every(r => r.ok), results }, null, 2) + '\n');
process.exitCode = results.every(r => r.ok) ? 0 : 1;
