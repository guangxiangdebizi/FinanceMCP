import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDividend } from '../build/tools/companyPerformanceDetail/dividendFormatters.js';
import { parseCashDividendPerShare } from '../build/tools/csiIndexConstituents.js';

test('formats Tushare dividend fields as per-share values', () => {
  const output = formatDividend([{
    end_date: '20241231',
    ann_date: '20250403',
    div_proc: '实施',
    stk_div: 0.1,
    stk_bo_rate: 0.04,
    stk_co_rate: 0.06,
    cash_div: 27.624,
    cash_div_tax: 27.624,
  }]);

  assert.match(output, /每股送转: 0\.1股/);
  assert.match(output, /每股送股: 0\.04股/);
  assert.match(output, /每股转增: 0\.06股/);
  assert.match(output, /每股分红（税后）: 27\.624元/);
  assert.match(output, /每股分红（税前）: 27\.624元/);
  assert.doesNotMatch(output, /每10股/);
});

test('keeps Tushare cash_div in per-share units', () => {
  assert.equal(parseCashDividendPerShare(27.624), 27.624);
  assert.equal(parseCashDividendPerShare('27.624'), 27.624);
  assert.equal(parseCashDividendPerShare(0), null);
  assert.equal(parseCashDividendPerShare('not-a-number'), null);
});
