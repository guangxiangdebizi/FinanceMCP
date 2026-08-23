import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCompanyBasic } from '../build/tools/companyPerformanceDetail/companyBasicFormatters.js';
import { futuresData } from '../build/tools/futuresData.js';
import { macroEcon } from '../build/tools/macroEcon.js';
import { moneyFlow } from '../build/tools/moneyFlow.js';
import { stockDataMinutes } from '../build/tools/stockDataMinutes.js';
import { formatTushareAmountWan } from '../build/utils/tushareUnits.js';

function responseText(result) {
  return result.content.map(item => item.text ?? '').join('\n');
}

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('normalizes Tushare amount units to ten-thousands by API contract', () => {
  assert.equal(formatTushareAmountWan(990112.07, 'daily'), '99011.21');
  assert.equal(formatTushareAmountWan(722401.94, 'fund_daily'), '72240.19');
  assert.equal(formatTushareAmountWan(5853921776.47, 'weekly'), '585392.18');
  assert.equal(formatTushareAmountWan(5853921776.47, 'monthly'), '585392.18');
  assert.equal(formatTushareAmountWan(10067717614.12, 'hk_daily'), '1006771.76');
  assert.equal(formatTushareAmountWan(4008342529.97, 'us_daily'), '400834.25');
  assert.equal(formatTushareAmountWan(1660275, 'stk_mins'), '166.03');
  assert.equal(formatTushareAmountWan(42783, 'repo_daily'), '42783.00');
  assert.equal(formatTushareAmountWan(10134.7401, 'cb_daily'), '10134.74');
  assert.equal(formatTushareAmountWan(123.45, 'opt_daily'), '123.45');
  assert.equal(formatTushareAmountWan(null, 'daily'), 'N/A');
  assert.equal(formatTushareAmountWan(100, 'unknown_api'), 'N/A');
});

test('keeps stock_company registered capital in its native ten-thousand-yuan unit', () => {
  const base = {
    com_id: '',
    chairman: '',
    manager: '',
    secretary: '',
    setup_date: '20000101',
    province: '广东',
    city: '深圳',
    website: '',
    email: '',
    employees: 0,
  };
  const output = formatCompanyBasic([
    { ...base, ts_code: '000001.SZ', com_name: '公司甲', exchange: 'SZSE', reg_capital: 10000 },
    { ...base, ts_code: '000002.SZ', com_name: '公司乙', exchange: 'SZSE', reg_capital: 30000 },
  ]);

  assert.match(output, /\| 10000\.00 \|/);
  assert.match(output, /\| 30000\.00 \|/);
  assert.match(output, /平均注册资本: 20000\.00万元/);
  assert.match(output, /最高注册资本: 30000\.00万元/);
  assert.doesNotMatch(output, /平均注册资本: 2\.00万元/);
});

test('renders stk_mins amount values from yuan as ten-thousand yuan', async () => {
  const previousToken = process.env.TUSHARE_TOKEN;
  process.env.TUSHARE_TOKEN = 'test-token';

  try {
    const result = await withMockFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.api_name === 'stock_basic') {
        return {
          ok: true,
          async json() {
            return { code: 0, data: { fields: [], items: [] } };
          },
        };
      }

      assert.equal(body.api_name, 'stk_mins');
      assert.deepEqual(body.params, {
        ts_code: '600000.SH',
        start_date: '2026-08-21 09:30:00',
        end_date: '2026-08-21 09:31:00',
        freq: '1min',
      });
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              fields: ['ts_code', 'trade_time', 'open', 'high', 'low', 'close', 'vol', 'amount'],
              items: [['600000.SH', '2026-08-21 09:30:00', 7.05, 7.05, 7.05, 7.05, 235500, 1660275]],
            },
          };
        },
      };
    }, () => stockDataMinutes.run({
      code: '600000.SH',
      market_type: 'cn',
      start_datetime: '20260821093000',
      end_datetime: '20260821093100',
      freq: '1MIN',
    }));

    assert.match(responseText(result), /成交额\(万元\)/);
    assert.match(responseText(result), /\| 166\.03 \|/);
    assert.doesNotMatch(responseText(result), /1660275/);
  } finally {
    if (previousToken == null) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = previousToken;
  }
});

test('uses the shibor_lpr API and formats its date, 1Y, and 5Y fields', async () => {
  let requestBody;
  const result = await withMockFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            fields: ['date', '1y', '5y'],
            items: [['20260720', 3, 3.5]],
          },
        };
      },
    };
  }, () => macroEcon.run({
    indicator: 'lpr',
    start_date: '20260701',
    end_date: '20260821',
  }));

  assert.equal(requestBody.api_name, 'shibor_lpr');
  assert.deepEqual(requestBody.params, {
    start_date: '20260701',
    end_date: '20260821',
  });
  assert.match(responseText(result), /2026年07月20日/);
  assert.match(responseText(result), /1年: 3%/);
  assert.match(responseText(result), /5年: 3\.5%/);
});

test('keeps stock main inflow separate from Tushare total net inflow', async () => {
  const previousToken = process.env.TUSHARE_TOKEN;
  process.env.TUSHARE_TOKEN = 'test-token';

  try {
    const result = await withMockFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.api_name, 'moneyflow');
      return {
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              fields: [
                'ts_code', 'trade_date',
                'buy_sm_amount', 'sell_sm_amount',
                'buy_md_amount', 'sell_md_amount',
                'buy_lg_amount', 'sell_lg_amount',
                'buy_elg_amount', 'sell_elg_amount',
                'net_mf_amount',
              ],
              items: [[
                '000001.SZ', '20260821',
                400, 100,
                100, 50,
                50, 100,
                100, 200,
                200,
              ]],
            },
          };
        },
      };
    }, () => moneyFlow.run({
      query_type: 'stock',
      ts_code: '000001.SZ',
      start_date: '20260821',
      end_date: '20260821',
    }));

    const text = responseText(result);
    assert.match(text, /主力净流入按「超大单净额 \+ 大单净额」计算/);
    assert.match(text, /全部单种净流入\(万元\)/);
    assert.match(text, /🔴 -150\.00万/);
    assert.match(text, /\| 200\.00万 \|/);
    assert.match(text, /主力净流出 150\.00万/);
    assert.doesNotMatch(text, /主力净流入 200\.00万/);
  } finally {
    if (previousToken == null) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = previousToken;
  }
});

test('explains fut_holding silent empty results as data or permission related', async () => {
  const previousToken = process.env.TUSHARE_TOKEN;
  process.env.TUSHARE_TOKEN = 'test-token';

  try {
    const result = await withMockFetch(async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            fields: ['trade_date', 'symbol', 'broker'],
            items: [],
          },
        };
      },
    }), () => futuresData.run({ trade_date: '20260821', symbol: 'IF' }));

    const text = responseText(result);
    assert.match(text, /非交易日或数据尚未更新/);
    assert.match(text, /无 fut_holding 访问权限/);
    assert.match(text, /2000 积分/);
    assert.doesNotMatch(text, /请确认为有效交易日/);
  } finally {
    if (previousToken == null) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = previousToken;
  }
});
