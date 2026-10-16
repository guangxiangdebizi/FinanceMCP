import { callTushare } from '../utils/tushareClient.js';

/**
 * Batch-oriented Tushare access for the A-share daily pipeline.
 *
 * Reuses the shared callTushare client and adds what a whole-market daily
 * download needs: offset pagination, a minimum interval between calls and
 * retry with backoff for rate limits and transient network failures.
 */

const MIN_INTERVAL_MS = Number(process.env.ASHARE_TUSHARE_MIN_INTERVAL_MS || 160);
const MAX_RETRIES = Number(process.env.ASHARE_TUSHARE_MAX_RETRIES || 4);

let lastCallAt = 0;
export const fetchStats = { calls: 0, retries: 0, rows: 0 };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRateLimit(message: string): boolean {
  return /每分钟|频次|频率|too many|rate/i.test(message);
}

function isPermanent(message: string): boolean {
  // Missing permission or an invalid parameter will not succeed on retry.
  return /权限|积分|参数|token不对|无效|不存在/.test(message) && !isRateLimit(message);
}

async function callOnce(api: string, params: Record<string, any>, fields?: string) {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  fetchStats.calls++;
  return callTushare(api, params, fields);
}

export async function callWithRetry(api: string, params: Record<string, any>, fields?: string) {
  let attempt = 0;
  for (;;) {
    try {
      return await callOnce(api, params, fields);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (/未返回数据/.test(message)) return { data: [], fields: [] };
      if (attempt >= MAX_RETRIES || isPermanent(message)) throw error;
      attempt++;
      fetchStats.retries++;
      const delay = isRateLimit(message) ? 61_000 : 1500 * 2 ** (attempt - 1);
      console.warn(`[ashare] ${api} 第${attempt}次重试，${delay}ms 后重试: ${message.slice(0, 120)}`);
      await sleep(delay);
    }
  }
}

/**
 * Fetch every page of a Tushare query. Pagination stops on a short page, so
 * the result is complete even when an interface caps rows per request.
 */
export async function fetchAll(
  api: string,
  params: Record<string, any>,
  fields?: string,
  pageSize = 5000,
): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await callWithRetry(api, { ...params, limit: pageSize, offset }, fields);
    rows.push(...page.data);
    if (page.data.length < pageSize) break;
    if (offset > 200_000) throw new Error(`${api} 分页超过安全上限，参数: ${JSON.stringify(params)}`);
  }
  fetchStats.rows += rows.length;
  return rows;
}
