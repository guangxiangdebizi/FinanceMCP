// Deterministic synthetic A-share market for pipeline tests (not a test file itself).
const { upsertRows } = await import('../build/ashare/db.js');
const { CORE_INDICES } = await import('../build/ashare/ingest.js');

/** `count` consecutive weekdays starting at `start` (YYYYMMDD). */
export function weekdays(start, count) {
  const out = [];
  const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8)));
  while (out.length < count) {
    if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const STOCKS = Array.from({ length: 60 }, (_, i) => ({
  ts_code: `${600000 + i}.SH`,
  symbol: String(600000 + i),
  name: `测试${i}`,
  industry: `行业${i % 15}`,
  list_date: '20180101',
  list_status: 'L',
}));

function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

const lastClose = new Map();

function barsFor(code, idx, date, k) {
  const prev = lastClose.get(code) ?? 10 + idx;
  const drift = ((idx % 7) - 3) * 0.002;
  const close = Math.round(prev * (1 + drift + noise(idx * 1000 + k) * 0.04) * 100) / 100;
  const open = Math.round(prev * (1 + noise(idx * 7777 + k) * 0.01) * 100) / 100;
  lastClose.set(code, close);
  return {
    ts_code: code, trade_date: date, open, close, pre_close: prev,
    high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99,
    pct_chg: (close / prev - 1) * 100, vol: 1e5, amount: 2e5 + idx * 1000,
  };
}

/** Append trading days (calendar, quotes, factors, limits, indices) to the cache. */
export function addMarketDays(db, dates, allDates = dates) {
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    dates.map(d => ({ cal_date: d, is_open: 1, pretrade_date: allDates[allDates.indexOf(d) - 1] ?? null })));
  for (const date of dates) {
    const k = allDates.indexOf(date);
    const daily = STOCKS.map((s, i) => barsFor(s.ts_code, i, date, k));
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], daily);
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], daily.map(r => ({ ...r, adj_factor: 1 })));
    upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], daily.map(r => ({ ...r, up_limit: r.pre_close * 1.1, down_limit: r.pre_close * 0.9 })));
    upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'],
      daily.map((r, i) => ({ ...r, turnover_rate: 1, pe_ttm: 10 + i, pb: 1.5, circ_mv: 1e6, total_mv: 2e6 })));
    upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      Object.keys(CORE_INDICES).map((code, j) => {
        const close = 3000 + j * 100 + k * 2 + noise(k + j) * 20;
        return { ts_code: code, trade_date: date, open: close, high: close * 1.01, low: close * 0.99, close, pre_close: close, pct_chg: 0, vol: 1, amount: 1e8 };
      }));
  }
}

export function seedMarket(db, dates) {
  lastClose.clear();
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], STOCKS);
  addMarketDays(db, dates);
}
