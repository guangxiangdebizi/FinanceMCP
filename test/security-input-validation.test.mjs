import assert from 'node:assert/strict';
import test from 'node:test';

import { indexData } from '../build/tools/indexData.js';
import { macroEcon } from '../build/tools/macroEcon.js';
import { stockData } from '../build/tools/stockData.js';
import {
  STOCK_MARKET_TYPES,
  normalizeEnumInput,
  normalizeFinancialCode,
  normalizeOptionalDate,
} from '../build/utils/inputValidation.js';

function responseText(result) {
  return result.content.map((item) => item.text ?? '').join('\n');
}

async function assertNotReflected(run, payload) {
  const result = await run();
  const text = responseText(result);
  assert.equal(text.includes(payload), false, `response reflected payload: ${payload}`);
}

test('normalizes supported financial inputs', () => {
  assert.equal(normalizeEnumInput(' CN ', STOCK_MARKET_TYPES, 'market_type'), 'cn');
  assert.equal(normalizeFinancialCode(' brk.b '), 'BRK.B');
  assert.equal(normalizeFinancialCode('btc/usdt', { allowSlash: true }), 'BTC/USDT');
  assert.equal(normalizeOptionalDate('20260805', 'start_date'), '20260805');
});

test('rejects reflected payloads in stock_data', async () => {
  const xss = '<script>alert(1)</script>';
  const sql = "' OR '1'='1";

  await assertNotReflected(
    () => stockData.run({ code: xss, market_type: 'cn' }),
    xss,
  );
  await assertNotReflected(
    () => stockData.run({ code: '000001.SZ', market_type: sql }),
    sql,
  );
});

test('rejects reflected payloads in index_data', async () => {
  const payload = "' OR '1'='1";
  await assertNotReflected(() => indexData.run({ code: payload }), payload);
});

test('rejects reflected payloads in macro_econ', async () => {
  const payload = '../../etc/passwd';
  await assertNotReflected(
    () => macroEcon.run({ indicator: payload, start_date: '20260101', end_date: '20260805' }),
    payload,
  );
});
