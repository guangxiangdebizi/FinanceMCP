import * as dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';

// 加载环境变量：
// 1. 本地开发时，从.env文件加载
// 2. 在Smithery部署时，从配置文件中加载
dotenv.config();

// 每请求上下文：用于透传用户在 Header 中提交的 Token（Tushare / CoinGecko）
type RequestContext = { tushareToken?: string; coingeckoApiKey?: string; coingeckoProApiKey?: string; coingeckoDemoApiKey?: string };
const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({
    tushareToken: ctx.tushareToken,
    coingeckoApiKey: ctx.coingeckoApiKey,
    coingeckoProApiKey: ctx.coingeckoProApiKey,
    coingeckoDemoApiKey: ctx.coingeckoDemoApiKey
  }, fn);
}

export function getRequestToken(): string | undefined {
  return requestContext.getStore()?.tushareToken;
}

export function getCoinGeckoApiKey(): string | undefined {
  return requestContext.getStore()?.coingeckoApiKey ?? process.env.COINGECKO_API_KEY ?? undefined;
}

export function getCoinGeckoProApiKey(): string | undefined {
  return requestContext.getStore()?.coingeckoProApiKey ?? process.env.COINGECKO_PRO_API_KEY ?? undefined;
}

export function getCoinGeckoDemoApiKey(): string | undefined {
  return requestContext.getStore()?.coingeckoDemoApiKey ?? process.env.COINGECKO_DEMO_API_KEY ?? undefined;
}

function resolveApiToken(): string | undefined {
  // 优先使用请求上下文中的 Token，其次回退到环境变量
  return getRequestToken() ?? process.env.TUSHARE_TOKEN ?? undefined;
}

// 统一配置对象：API_TOKEN 改为 getter，动态读取每请求 Token
export const TUSHARE_CONFIG = {
  /**
   * Tushare API Token（优先使用请求头透传的 Token）
   */
  get API_TOKEN(): string {
    return resolveApiToken() ?? "";
  },

  /** Tushare 服务器地址 */
  API_URL: "https://api.tushare.pro",

  /** 超时 ms */
  TIMEOUT: 30000,
};

export const COINGECKO_CONFIG = {
  /** 优先使用请求头透传的 Pro Key；否则回退普通 Key；都没有则为空 */
  get API_KEY(): string | undefined {
    return getCoinGeckoApiKey();
  },
  get PRO_API_KEY(): string | undefined {
    return getCoinGeckoProApiKey();
  },
  get DEMO_API_KEY(): string | undefined {
    return getCoinGeckoDemoApiKey();
  },
  /** 自动选择基础域名：有 PRO_KEY 走 pro-api，否则走公共 api */
  get BASE_URL(): string {
    return (getCoinGeckoProApiKey() ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3');
  },
  /** 根据提供的 Key 生成请求头 */
  get HEADERS(): Record<string, string> {
    const headers: Record<string, string> = {};
    const pro = getCoinGeckoProApiKey();
    const demo = getCoinGeckoDemoApiKey();
    const std = getCoinGeckoApiKey();
    if (pro) headers['x-cg-pro-api-key'] = pro;
    else if (demo) headers['x-cg-demo-api-key'] = demo;
    else if (std) headers['x-cg-api-key'] = std;
    return headers;
  },
  /** 超时 ms */
  TIMEOUT: 30000,
};

// Token 配置已自动完成（无需日志输出，避免污染 MCP 响应）
