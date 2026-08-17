import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchTool, getAvailableToolList } from '../build/dispatch.js';
import { runWithRequestContext } from '../build/config.js';

function names(tools) {
  return tools.map(tool => tool.name);
}

test('Qveris-only request advertises only Qveris tools', async () => {
  const tools = await runWithRequestContext({ qverisApiKey: 'qveris-test-key' }, async () => {
    return getAvailableToolList();
  });
  assert.deepEqual(names(tools), ['qveris_finance']);
});

test('Tushare-only request excludes Qveris and public-only tools', async () => {
  const tools = await runWithRequestContext({ tushareToken: 'tushare-test-token' }, async () => {
    return getAvailableToolList();
  });
  const available = names(tools);
  assert.ok(available.includes('stock_data'));
  assert.ok(available.includes('company_performance'));
  assert.equal(available.includes('qveris_finance'), false);
  assert.equal(available.includes('finance_news'), false);
});

test('multiple credentials expose the union of their tool sources', async () => {
  const tools = await runWithRequestContext({
    tushareToken: 'tushare-test-token',
    qverisApiKey: 'qveris-test-key',
  }, async () => getAvailableToolList());
  const available = names(tools);
  assert.ok(available.includes('stock_data'));
  assert.ok(available.includes('qveris_finance'));
  assert.equal(available.includes('finance_news'), false);
  assert.equal(available.includes('current_timestamp'), false);
});

test('direct calls cannot bypass the filtered tool list', async () => {
  await assert.rejects(
    () => runWithRequestContext({ qverisApiKey: 'qveris-test-key' }, async () => {
      return dispatchTool('index_data', { code: '000300.SH' });
    }),
    /not available for the configured API credentials/,
  );
});
