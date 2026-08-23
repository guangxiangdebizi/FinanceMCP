import assert from 'node:assert/strict';
import test from 'node:test';

import { companyPerformance } from '../build/tools/companyPerformance.js';
import { formatAllBalance, formatBasicBalance } from '../build/tools/companyPerformanceDetail/balanceFormatters.js';
import { formatMainBusinessCombined } from '../build/tools/companyPerformanceDetail/businessFormatters.js';
import { formatCashflowAll, formatBasicCashFlow } from '../build/tools/companyPerformanceDetail/cashflowFormatters.js';
import { formatExpress } from '../build/tools/companyPerformanceDetail/forecastExpressFormatters.js';
import { formatIndicators } from '../build/tools/companyPerformanceDetail/indicatorsFormatters.js';
import { formatAllIncome, formatBasicIncome } from '../build/tools/companyPerformanceDetail/incomeFormatters.js';
import { convertibleBond } from '../build/tools/convertibleBond.js';
import { hotNews } from '../build/tools/hotNews.js';
import { marginTrade } from '../build/tools/marginTrade.js';
import { moneyFlow } from '../build/tools/moneyFlow.js';
import { stockData } from '../build/tools/stockData.js';
import { formatTushareAmountWan } from '../build/utils/tushareUnits.js';

function responseText(result) {
  return (result.content ?? []).map(item => item.text ?? '').join('\n');
}

function jsonResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return json; },
  };
}

async function withTushareMock(mock, run) {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.TUSHARE_TOKEN;
  process.env.TUSHARE_TOKEN = 'test-token';
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken == null) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = previousToken;
  }
}

test('converts statement, express, and main-business yuan fields to ten-thousand yuan', () => {
  const income = { end_date: '20251231', report_type: '1', revenue: 179895000000 };
  assert.match(formatBasicIncome([income]), /17,989,500/);
  assert.match(formatAllIncome([income]), /17,989,500/);

  const balance = { end_date: '20251231', report_type: '1', total_assets: 5321514000000 };
  assert.match(formatBasicBalance([balance]), /532,151,400/);
  assert.match(formatAllBalance([balance]), /532,151,400/);

  const cashflow = { end_date: '20251231', comp_type: '1', net_profit: 45516000000 };
  assert.match(formatBasicCashFlow([cashflow]), /4,551,600/);
  assert.match(formatCashflowAll([cashflow]), /4,551,600/);

  assert.match(formatExpress([{ end_date: '20251231', ann_date: '20260301', revenue: 179895000000 }]), /营业收入: 17,989,500 万元/);
  assert.match(formatMainBusinessCombined([{
    bz_type: '产品',
    end_date: '20251231',
    bz_item: '主营产品',
    bz_sales: 1234560000,
    bz_profit: 234560000,
    bz_cost: 1000000000,
    curr_type: 'CNY',
  }]), /\| 主营产品 \| 123,456 \| 23,456 \| 100,000 \| CNY \|/);
});

test('does not label liquidity multiples as percentages', () => {
  const output = formatIndicators([{
    end_date: '20251231',
    current_ratio: 5.5895,
    quick_ratio: 4.275,
    cash_ratio: 1.1484,
  }]);
  assert.match(output, /5\.5895/);
  assert.match(output, /4\.275/);
  assert.match(output, /1\.1484/);
  assert.doesNotMatch(output, /5\.59%|4\.28%|1\.15%/);
});

test('uses official stock quote fields and units for US, repo, and futures APIs', async () => {
  const requests = [];
  const rowsByApi = {
    us_daily: {
      fields: ['trade_date', 'open', 'close', 'high', 'low', 'vol', 'amount', 'pct_change'],
      items: [['20260821', 100, 101, 102, 99, 1000, 4008342529.97, 1]],
    },
    repo_daily: {
      fields: ['trade_date', 'repo_maturity', 'weight', 'amount', 'num'],
      items: [['20260821', 'GC001', 1.85, 42783, 321]],
    },
    fut_daily: {
      fields: ['trade_date', 'open', 'high', 'low', 'close', 'settle', 'change1', 'change2', 'vol', 'amount', 'oi'],
      items: [['20260821', 3500, 3520, 3480, 3510, 3508, 10, 8, 2000, 421721.7, 5000]],
    },
  };

  await withTushareMock(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return jsonResponse({ code: 0, data: rowsByApi[body.api_name] });
  }, async () => {
    const us = await stockData.run({ code: 'AAPL', market_type: 'us', start_date: '20260821', end_date: '20260821' });
    assert.match(responseText(us), /成交额\(万美元\)/);
    assert.match(responseText(us), /400834\.25/);

    const repo = await stockData.run({ code: '204001.SH', market_type: 'repo', start_date: '20260821', end_date: '20260821' });
    assert.match(responseText(repo), /GC001/);
    assert.match(responseText(repo), /42783\.00/);
    assert.match(responseText(repo), /321/);

    const futures = await stockData.run({ code: 'IF2609.CFX', market_type: 'futures', start_date: '20260821', end_date: '20260821' });
    assert.match(responseText(futures), /成交金额\(万元\)/);
    assert.match(responseText(futures), /421721\.70/);
  });

  const usRequest = requests.find(request => request.api_name === 'us_daily');
  assert.match(usRequest.fields, /pct_change/);
  assert.doesNotMatch(usRequest.fields, /pct_chg/);
  const repoRequest = requests.find(request => request.api_name === 'repo_daily');
  assert.equal(repoRequest.fields, 'ts_code,trade_date,repo_maturity,weight,amount,num');
  assert.equal(formatTushareAmountWan(421721.7, 'fut_daily'), '421721.70');
});

test('uses official cb_call and cb_share contracts and converts conversion units', async () => {
  const requests = [];
  await withTushareMock(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.api_name === 'cb_call') {
      return jsonResponse({
        code: 0,
        data: {
          fields: ['ts_code', 'call_type', 'is_call', 'ann_date', 'call_date', 'call_price', 'call_price_tax', 'call_vol', 'call_amount', 'payment_date', 'call_reg_date'],
          items: [['110027.SH', '强赎', '公告强赎', '20260801', '20260820', 101, 100.8, 1000, 10.1, '20260821', '20260819']],
        },
      });
    }
    return jsonResponse({
      code: 0,
      data: {
        fields: ['ts_code', 'publish_date', 'end_date', 'convert_price', 'convert_val', 'convert_vol', 'convert_ratio', 'acc_convert_val', 'acc_convert_vol', 'remain_size'],
        items: [['110027.SH', '20150217', '20150216', 12, 117572928, 9797361, 2.939323, 3996503000, 333000000, 3497000]],
      },
    });
  }, async () => {
    const call = await convertibleBond.run({ data_type: 'call', ts_code: '110027.SH' });
    assert.match(responseText(call), /赎回类型/);
    assert.match(responseText(call), /公告强赎/);
    assert.match(responseText(call), /登记日/);

    const conversion = await convertibleBond.run({ data_type: 'conversion', ts_code: '110027.SH' });
    const text = responseText(conversion);
    assert.match(text, /本次转股金额\(万元\)/);
    assert.match(text, /11,757\.2928/);
    assert.match(text, /本次转股量\(股\)/);
    assert.match(text, /0\.035/);
    assert.doesNotMatch(text, /本期转股量\(张\)/);
  });

  const callRequest = requests.find(request => request.api_name === 'cb_call');
  assert.doesNotMatch(callRequest.fields, /face_value|delist_date/);
  const shareRequest = requests.find(request => request.api_name === 'cb_share');
  assert.match(shareRequest.fields, /publish_date/);
  assert.doesNotMatch(shareRequest.fields, /ann_date/);
});

test('queries cb_basic by code without injecting a default list date', async () => {
  const requests = [];
  const result = await withTushareMock(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.api_name === 'cb_basic') {
      return jsonResponse({
        code: 0,
        data: {
          fields: ['ts_code', 'bond_short_name', 'par', 'issue_size', 'remain_size', 'call_clause'],
          items: [['110027.SH', '示例转债', 100, 350000000, 3497000, '赎回条款文本']],
        },
      });
    }
    return jsonResponse({ code: 0, data: { fields: ['ts_code'], items: [] } });
  }, () => convertibleBond.run({ data_type: 'info', ts_code: '110027.SH' }));

  const basicRequest = requests.find(request => request.api_name === 'cb_basic');
  assert.deepEqual(basicRequest.params, { ts_code: '110027.SH' });
  assert.match(basicRequest.fields, /\bpar\b/);
  assert.doesNotMatch(basicRequest.fields, /par_value|force_redeem_clause|cross_default_clause/);
  assert.match(responseText(result), /发行规模: 3\.5亿元/);
  assert.match(responseText(result), /存续规模: 0\.035亿元/);
  assert.match(responseText(result), /赎回条款文本/);
});

test('uses the exchange-level margin summary contract without requiring a stock code', async () => {
  let requestBody;
  const result = await withTushareMock(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({
      code: 0,
      data: {
        fields: ['trade_date', 'exchange_id', 'rzye', 'rzmre', 'rzche', 'rqye', 'rqmcl', 'rzrqye', 'rqyl'],
        items: [['20260821', 'SSE', 100000000, 20000000, 10000000, 5000000, 3000, 105000000, 4000]],
      },
    });
  }, () => marginTrade.run({
    data_type: 'margin',
    start_date: '20260821',
    end_date: '20260821',
    exchange: 'SSE',
  }));

  assert.deepEqual(requestBody.params, {
    start_date: '20260821',
    end_date: '20260821',
    exchange_id: 'SSE',
  });
  assert.doesNotMatch(requestBody.fields, /ts_code|rqchl/);
  assert.match(requestBody.fields, /exchange_id|rqyl/);
  assert.match(responseText(result), /上交所 融资融券交易汇总/);
  assert.match(responseText(result), /融券余量/);
});

test('uses official hk_hold fields for connect holdings', async () => {
  let requestBody;
  const result = await withTushareMock(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({
      code: 0,
      data: {
        fields: ['code', 'trade_date', 'ts_code', 'name', 'vol', 'ratio', 'exchange'],
        items: [['90000', '20260821', '600000.SH', '浦发银行', 443245164, 1.57, 'SH']],
      },
    });
  }, () => moneyFlow.run({ query_type: 'northbound', ts_code: '600000.SH', trade_date: '20260821' }));

  assert.equal(requestBody.fields, 'code,trade_date,ts_code,name,vol,ratio,exchange');
  const text = responseText(result);
  assert.match(text, /沪深港股通持股数据/);
  assert.match(text, /浦发银行/);
  assert.match(text, /443245164/);
  assert.match(text, /1\.57/);
  assert.doesNotMatch(text, /买入量|卖出量/);
});

test('supplies required news parameters and surfaces API errors', async () => {
  let requestBody;
  const success = await withTushareMock(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({
      code: 0,
      data: {
        fields: ['datetime', 'content', 'title', 'channels'],
        items: [['2026-08-23 12:00:00', '快讯内容', '快讯标题', '财经']],
      },
    });
  }, () => hotNews.run({ limit: 1 }));

  assert.equal(requestBody.params.src, 'sina');
  assert.match(requestBody.params.start_date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(requestBody.params.end_date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(responseText(success), /快讯标题/);

  const failure = await withTushareMock(async () => {
    return jsonResponse({ code: 40001, msg: 'start_date is required' });
  }, () => hotNews.run({ limit: 1 }));
  assert.match(responseText(failure), /获取失败/);
  assert.match(responseText(failure), /start_date is required/);
  assert.doesNotMatch(responseText(failure), /暂无数据/);
});

test('labels new-share IPO and listing dates according to the official schema', async () => {
  const result = await withTushareMock(async () => jsonResponse({
    code: 0,
    data: {
      fields: ['ts_code', 'name', 'ipo_date', 'issue_date', 'price', 'pe', 'amount', 'funds', 'ballot'],
      items: [['001234.SZ', '示例新股', '20260801', '20260815', 10, 20, 1000, 1, 0.1]],
    },
  }), () => companyPerformance.run({
    data_type: 'ipo',
    start_date: '20260801',
    end_date: '20260831',
  }));

  const text = responseText(result);
  assert.match(text, /上网发行日期 \| 上市日期/);
  assert.match(text, /\| 20260801 \| 20260815 \|/);
});
