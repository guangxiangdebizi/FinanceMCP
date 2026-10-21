import { createHash } from 'node:crypto';
import type { LedgerEventInput } from './ledger.js';

/** RFC4180-style CSV parser, including BOM, quoted commas, escaped quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"') {
      if (field || closed) throw new Error('Invalid CSV quote');
      quoted = true;
    } else if (ch === ',') { row.push(field); field = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = []; field = ''; closed = false;
    } else {
      if (closed && ch.trim()) throw new Error('Unexpected CSV data after closing quote');
      if (!closed) field += ch;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field); if (row.some(value => value.trim() !== '')) rows.push(row); }
  return rows;
}

/** Decimal text -> fixed-point integer, without binary floating-point multiplication. */
export function decimalToInteger(raw: string, scale: number, label: string): number {
  const value = raw.trim().replace(/,/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error(`${label}: invalid decimal`);
  const negative = value.startsWith('-');
  const [whole, frac = ''] = value.replace(/^[+-]/, '').split('.');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`${label}: exceeds fixed-point precision`);
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt((frac.slice(0, scale) + '0'.repeat(scale)).slice(0, scale) || '0');
  const signed = Number(negative ? -result : result);
  if (!Number.isSafeInteger(signed)) throw new Error(`${label}: exceeds safe integer range`);
  return signed;
}

const ALIASES: Record<string, string[]> = {
  event_id: ['event_id', '成交编号', '成交序号', '流水号', '业务流水号'],
  order_id: ['order_id', '合同编号', '委托编号'],
  event_type: ['event_type', '业务名称', '业务类型', '买卖标志', '操作', '买卖方向'],
  occurred_on: ['occurred_on', '成交日期', '业务日期', '发生日期', '日期'],
  settled_on: ['settled_on', '交收日期'],
  ts_code: ['ts_code', '证券代码', '股票代码'],
  exchange: ['exchange', '市场', '交易市场'],
  quantity: ['quantity', '成交数量', '发生数量', '证券数量'],
  price: ['price', '成交价格', '成交均价'],
  gross: ['gross', '成交金额', '发生金额'],
  fee: ['fee', '佣金', '手续费'],
  transfer: ['transfer', '过户费'],
  tax: ['tax', '印花税', '税费'],
  cash_delta: ['cash_delta', '资金发生额', '资金发生数', '资金变动'],
  reverses_event_id: ['reverses_event_id', '撤销流水号'],
};
const TYPES: Record<string, string> = {
  BUY: 'TRADE_BUY', SELL: 'TRADE_SELL', CASH_IN: 'CASH_DEPOSIT', CASH_OUT: 'CASH_WITHDRAW', CORRECTION: 'REVERSE',
  TRADE_BUY: 'TRADE_BUY', TRADE_SELL: 'TRADE_SELL', CASH_DEPOSIT: 'CASH_DEPOSIT', CASH_WITHDRAW: 'CASH_WITHDRAW',
  DIVIDEND: 'DIVIDEND', FEE: 'FEE', REVERSE: 'REVERSE',
  '证券买入': 'TRADE_BUY', '买入': 'TRADE_BUY', '证券卖出': 'TRADE_SELL', '卖出': 'TRADE_SELL',
  '银行转证券': 'CASH_DEPOSIT', '银行转入': 'CASH_DEPOSIT', '证券转银行': 'CASH_WITHDRAW', '银行转出': 'CASH_WITHDRAW',
  '红利入账': 'DIVIDEND', '股息入账': 'DIVIDEND', '分红': 'DIVIDEND', '费用': 'FEE', '撤销': 'REVERSE',
};
function securityCode(raw: string, exchange: string): string {
  const value = raw.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value;
  if (!/^\d{6}$/.test(value)) throw new Error('CSV security code must have six digits');
  if (/SH|上海|沪/.test(exchange)) return `${value}.SH`;
  if (/SZ|深圳|深/.test(exchange)) return `${value}.SZ`;
  if (/BJ|北京|北/.test(exchange)) return `${value}.BJ`;
  if (/^[569]/.test(value)) return `${value}.SH`;
  if (/^[0123]/.test(value)) return `${value}.SZ`;
  if (/^[48]/.test(value)) return `${value}.BJ`;
  throw new Error('CSV exchange cannot be resolved');
}

/** Broker exports are facts: missing trade fees fail closed, never replaced by estimates. */
export function parseTradeCsv(text: string, options: { accountId: string; brokerId?: string }): { events: LedgerEventInput[]; warnings: string[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV requires a header and event rows');
  const header = rows[0].map(value => value.trim());
  if (new Set(header).size !== header.length) throw new Error('Duplicate CSV header');
  const index: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const found = aliases.map(alias => header.indexOf(alias)).filter(i => i >= 0);
    if (found.length > 1) throw new Error(`Ambiguous CSV columns for ${field}`);
    if (found.length) index[field] = found[0];
  }
  if (index.occurred_on === undefined || index.event_type === undefined) throw new Error('CSV date and event type columns required');
  const events: LedgerEventInput[] = [];
  const seen = new Map<string, string>();
  for (const [offset, row] of rows.slice(1).entries()) {
    try {
      if (row.length !== header.length) throw new Error('CSV row width differs from header');
      const get = (field: string) => index[field] === undefined ? '' : row[index[field]].trim();
      const occurred = get('occurred_on').replace(/[-/]/g, '');
      const type = TYPES[get('event_type').toUpperCase()];
      if (!type) throw new Error('Unknown CSV event type');
      const date = occurred.slice(0, 8);
      if (!/^\d{8}$/.test(occurred)) throw new Error('CSV date requires YYYYMMDD');
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error('Invalid CSV calendar date');
      const event: LedgerEventInput = { account_id: options.accountId, event_id: '', event_type: type, occurred_on: date, source: 'broker_statement' };
      if (get('settled_on')) event.settled_on = get('settled_on').replace(/[-/]/g, '');
      if (get('ts_code')) event.ts_code = securityCode(get('ts_code'), get('exchange'));
      if (type === 'TRADE_BUY' || type === 'TRADE_SELL') {
        if (!get('fee') || !get('tax')) throw new Error('Actual commission/fee and tax columns must be explicit, including zero');
        event.quantity = Math.abs(decimalToInteger(get('quantity'), 0, 'quantity'));
        event.price_milli = decimalToInteger(get('price'), 3, 'price');
        if (get('gross')) event.gross_cents = Math.abs(decimalToInteger(get('gross'), 2, 'gross'));
        event.fee_cents = decimalToInteger(get('fee'), 2, 'fee') + (get('transfer') ? decimalToInteger(get('transfer'), 2, 'transfer') : 0);
        event.tax_cents = decimalToInteger(get('tax'), 2, 'tax');
      } else if (type === 'REVERSE') {
        if (!get('reverses_event_id')) throw new Error('CORRECTION/REVERSE requires original event id; import replacement as a separate row');
        event.reverses_event_id = `broker:${options.accountId}:${options.brokerId ?? 'unspecified'}:${get('reverses_event_id')}`;
      } else {
        event.cash_delta_cents = decimalToInteger(get('cash_delta'), 2, 'cash_delta');
        if (type === 'CASH_WITHDRAW' || type === 'FEE') event.cash_delta_cents = -Math.abs(event.cash_delta_cents);
        else event.cash_delta_cents = Math.abs(event.cash_delta_cents);
      }
      if (get('cash_delta') && (type === 'TRADE_BUY' || type === 'TRADE_SELL')) event.cash_delta_cents = decimalToInteger(get('cash_delta'), 2, 'cash_delta');
      const rawId = get('event_id');
      if (!rawId) throw new Error('A stable broker event/fill id is required; row numbers or content hashes can merge distinct identical fills');
      event.event_id = `broker:${options.accountId}:${options.brokerId ?? 'unspecified'}:${rawId}`;
      event.note = JSON.stringify({ format: 'broker_csv/1', broker: options.brokerId ?? null, source_id: rawId, order_id: get('order_id') || null,
        commission_cents: get('fee') ? decimalToInteger(get('fee'), 2, 'fee') : null,
        transfer_fee_cents: get('transfer') ? decimalToInteger(get('transfer'), 2, 'transfer') : null,
        source_row_hash: createHash('sha256').update(JSON.stringify(row)).digest('hex') });
      const content = JSON.stringify({ ...event, note: undefined });
      if (seen.has(event.event_id) && seen.get(event.event_id) !== content) throw new Error('Conflicting duplicate broker id within CSV');
      seen.set(event.event_id, content);
      events.push(event);
    } catch (error) { throw new Error(`CSV row ${offset + 2}: ${(error as Error).message}`); }
  }
  return { events, warnings: ['Broker fees preserved exactly; slippage is excluded from ledger cash.', 'Order minimum billing aggregation and rounding remain UNKNOWN unless separately evidenced.'] };
}
