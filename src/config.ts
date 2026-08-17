import * as dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';

// 加载环境变量：
// 1. 本地开发时，从.env文件加载
// 2. 在Smithery部署时，从配置文件中加载
dotenv.config();

// 每请求上下文：用于透传用户在 Header 中提交的上游凭证。
type RequestContext = {
  tushareToken?: string;
  coingeckoApiKey?: string;
  coingeckoProApiKey?: string;
  coingeckoDemoApiKey?: string;
  qverisApiKey?: string;
};
const requestContext = new AsyncLocalStorage<RequestContext>();

export type ApiCredentialSource = 'tushare' | 'qveris';

export function runWithRequestContext<T>(ctx: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({
    tushareToken: ctx.tushareToken,
    coingeckoApiKey: ctx.coingeckoApiKey,
    coingeckoProApiKey: ctx.coingeckoProApiKey,
    coingeckoDemoApiKey: ctx.coingeckoDemoApiKey,
    qverisApiKey: ctx.qverisApiKey,
  }, fn);
}

export function getRequestToken(): string | undefined {
  return requestContext.getStore()?.tushareToken;
}

/** Resolve the credential-backed sources for the current request. */
export function getConfiguredApiSources(): ApiCredentialSource[] {
  const context = requestContext.getStore();
  const requestSources: ApiCredentialSource[] = [];
  if (context?.tushareToken?.trim()) requestSources.push('tushare');
  if (context?.qverisApiKey?.trim()) requestSources.push('qveris');
  if (requestSources.length > 0) return requestSources;

  const configuredSources: ApiCredentialSource[] = [];
  if (process.env.TUSHARE_TOKEN?.trim()) configuredSources.push('tushare');
  if (process.env.QVERIS_API_KEY?.trim()) configuredSources.push('qveris');
  return configuredSources;
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

export function getQverisApiKey(): string | undefined {
  return requestContext.getStore()?.qverisApiKey ?? process.env.QVERIS_API_KEY ?? undefined;
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

export const QVERIS_CONFIG = {
  get API_KEY(): string {
    return getQverisApiKey() ?? '';
  },
  get BASE_URL(): string {
    const configured = process.env.QVERIS_BASE_URL?.trim();
    if (configured) return configured.replace(/\/+$/, '');

    const region = process.env.QVERIS_REGION?.trim().toLowerCase();
    const apiKey = getQverisApiKey()?.trim() ?? '';
    if (region === 'cn' || apiKey.startsWith('sk-cn-')) {
      return 'https://qveris.cn/api/v1';
    }
    return 'https://qveris.ai/api/v1';
  },
  DISCOVER_TIMEOUT: 30000,
  EXECUTE_TIMEOUT: 120000,
};

// 开发态输出便于确认来源（不打印实际 Token 值）
if (process.env.NODE_ENV !== 'production') {
  const fromTs = getRequestToken() ? 'request-header' : (process.env.TUSHARE_TOKEN ? 'env' : 'none');
  const fromCg = getCoinGeckoProApiKey() ? 'request-pro-header/env' : (getCoinGeckoApiKey() ? 'request-std-header/env' : 'none');
  const fromQveris = requestContext.getStore()?.qverisApiKey ? 'request-header' : (process.env.QVERIS_API_KEY ? 'env' : 'none');
  console.log('Tushare token source:', fromTs);
  console.log('CoinGecko key source:', fromCg);
  console.log('Qveris key source:', fromQveris);
}
