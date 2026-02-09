import { TUSHARE_CONFIG } from '../config.js';

/**
 * 股票代码解析器 - 获取股票代码对应的公司全称
 */

export interface StockInfo {
  ts_code: string;
  name: string;
  fullname: string;
}

/**
 * 批量获取股票代码对应的公司全称信息
 * @param stockCodes 股票代码数组
 * @returns 格式化的股票代码说明文本
 */
export async function resolveStockCodes(stockCodes: string[]): Promise<string> {
  if (!stockCodes || stockCodes.length === 0) {
    return '';
  }

  // 去重并过滤有效的股票代码
  const uniqueCodes = [...new Set(stockCodes)]
    .filter(code => isValidStockCode(code))
    .sort();

  if (uniqueCodes.length === 0) {
    return '';
  }

  try {
    const stockInfos = await fetchStockBasicInfo(uniqueCodes);
    
    if (stockInfos.length === 0) {
      return '';
    }

    // 生成股票代码说明部分
    let explanation = '\n\n---\n\n## 📋 股票代码说明\n\n';
    
    stockInfos.forEach(stock => {
      explanation += `- **${stock.ts_code}**: ${stock.fullname || stock.name}\n`;
    });

    return explanation;
  } catch (error) {
    // 获取股票基本信息失败，静默返回空字符串
    return '';
  }
}

/**
 * 从文本中提取股票代码
 * @param text 文本内容
 * @returns 提取到的股票代码数组
 */
export function extractStockCodes(text: string): string[] {
  if (!text) return [];

  // 匹配常见的股票代码格式：6位数字.SH/SZ, 5位数字.SZ, 00开头港股等
  const stockCodeRegex = /\b(\d{6}\.(SH|SZ|HK)|\d{5}\.(SZ|HK)|00\d{4}\.HK)\b/g;
  const matches = text.match(stockCodeRegex) || [];
  
  return matches.map(code => code.toUpperCase());
}

/**
 * 验证是否为有效的股票代码格式
 */
function isValidStockCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false;
  
  const trimmed = code.trim().toUpperCase();
  
  // A股：6位数字.SH/.SZ
  if (/^\d{6}\.(SH|SZ)$/.test(trimmed)) return true;
  
  // 创业板等：5位数字.SZ
  if (/^\d{5}\.SZ$/.test(trimmed)) return true;
  
  // 港股：4-5位数字.HK
  if (/^\d{4,5}\.HK$/.test(trimmed)) return true;
  
  return false;
}

/**
 * 调用Tushare API获取股票基本信息
 */
async function fetchStockBasicInfo(stockCodes: string[]): Promise<StockInfo[]> {
  if (!TUSHARE_CONFIG.API_TOKEN) {
    throw new Error('Tushare API Token未配置');
  }

  const results: StockInfo[] = [];

  // 分批查询，避免一次性查询过多数据
  const batchSize = 50;
  for (let i = 0; i < stockCodes.length; i += batchSize) {
    const batch = stockCodes.slice(i, i + batchSize);
    
    try {
      const batchResults = await fetchBatchStockInfo(batch);
      results.push(...batchResults);
    } catch (error) {
      // 批次查询失败，静默跳过，继续处理其他批次
    }
  }

  return results;
}

/**
 * 批量查询股票基本信息
 */
async function fetchBatchStockInfo(stockCodes: string[]): Promise<StockInfo[]> {
  const params = {
    api_name: 'stock_basic',
    token: TUSHARE_CONFIG.API_TOKEN,
    params: {
      // 不指定ts_code以获取全部，然后在结果中筛选
    },
    fields: 'ts_code,name,fullname'
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

  try {
    const response = await fetch(TUSHARE_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Tushare API请求失败: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(`Tushare API错误: ${data.msg}`);
    }

    const fields: string[] = data.data?.fields || [];
    const items: any[] = data.data?.items || [];

    if (!fields.length || !items.length) {
      return [];
    }

    // 转换为对象数组并筛选目标股票代码
    const stockCodeSet = new Set(stockCodes.map(code => code.toUpperCase()));
    const results: StockInfo[] = [];

    for (const item of items) {
      const stockInfo: Record<string, any> = {};
      fields.forEach((field, index) => {
        stockInfo[field] = item[index];
      });

      const tsCode = String(stockInfo.ts_code || '').toUpperCase();
      if (stockCodeSet.has(tsCode)) {
        results.push({
          ts_code: tsCode,
          name: String(stockInfo.name || ''),
          fullname: String(stockInfo.fullname || '')
        });
      }
    }

    return results;
  } finally {
    clearTimeout(timeoutId);
  }
}
