import * as dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';
// 加载环境变量：
// 1. 本地开发时，从.env文件加载
// 2. 在Smithery部署时，从配置文件中加载
dotenv.config();
export const DATA_SOURCE_IDS = ['tushare', 'qveris', 'binance'];
export const DEFAULT_SOURCE_PRIORITY = ['tushare', 'qveris', 'binance'];
const requestContext = new AsyncLocalStorage();
export function runWithRequestContext(ctx, fn) {
    return requestContext.run({
        tushareToken: ctx.tushareToken,
        coingeckoApiKey: ctx.coingeckoApiKey,
        coingeckoProApiKey: ctx.coingeckoProApiKey,
        coingeckoDemoApiKey: ctx.coingeckoDemoApiKey,
        qverisApiKey: ctx.qverisApiKey,
        sourcePriority: ctx.sourcePriority,
    }, fn);
}
export function getRequestToken() {
    return requestContext.getStore()?.tushareToken;
}
export function getCoinGeckoApiKey() {
    return requestContext.getStore()?.coingeckoApiKey ?? process.env.COINGECKO_API_KEY ?? undefined;
}
export function getCoinGeckoProApiKey() {
    return requestContext.getStore()?.coingeckoProApiKey ?? process.env.COINGECKO_PRO_API_KEY ?? undefined;
}
export function getCoinGeckoDemoApiKey() {
    return requestContext.getStore()?.coingeckoDemoApiKey ?? process.env.COINGECKO_DEMO_API_KEY ?? undefined;
}
export function getQverisApiKey() {
    return requestContext.getStore()?.qverisApiKey ?? process.env.QVERIS_API_KEY ?? undefined;
}
export function parseSourcePriority(value) {
    const raw = Array.isArray(value) ? value.join(',') : value;
    const requested = (raw ?? '')
        .slice(0, 256)
        .toLowerCase()
        .split(/[\s,>]+/)
        .filter((item) => DATA_SOURCE_IDS.includes(item));
    return [...new Set([...requested, ...DEFAULT_SOURCE_PRIORITY])];
}
export function getSourcePriority() {
    return requestContext.getStore()?.sourcePriority
        ?? parseSourcePriority(process.env.FINANCE_SOURCE_PRIORITY);
}
function resolveApiToken() {
    // 优先使用请求上下文中的 Token，其次回退到环境变量
    return getRequestToken() ?? process.env.TUSHARE_TOKEN ?? undefined;
}
// 统一配置对象：API_TOKEN 改为 getter，动态读取每请求 Token
export const TUSHARE_CONFIG = {
    /**
     * Tushare API Token（优先使用请求头透传的 Token）
     */
    get API_TOKEN() {
        return resolveApiToken() ?? "";
    },
    /** Tushare 服务器地址 */
    API_URL: "https://api.tushare.pro",
    /** 超时 ms */
    TIMEOUT: 30000,
};
export const COINGECKO_CONFIG = {
    /** 优先使用请求头透传的 Pro Key；否则回退普通 Key；都没有则为空 */
    get API_KEY() {
        return getCoinGeckoApiKey();
    },
    get PRO_API_KEY() {
        return getCoinGeckoProApiKey();
    },
    get DEMO_API_KEY() {
        return getCoinGeckoDemoApiKey();
    },
    /** 自动选择基础域名：有 PRO_KEY 走 pro-api，否则走公共 api */
    get BASE_URL() {
        return (getCoinGeckoProApiKey() ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3');
    },
    /** 根据提供的 Key 生成请求头 */
    get HEADERS() {
        const headers = {};
        const pro = getCoinGeckoProApiKey();
        const demo = getCoinGeckoDemoApiKey();
        const std = getCoinGeckoApiKey();
        if (pro)
            headers['x-cg-pro-api-key'] = pro;
        else if (demo)
            headers['x-cg-demo-api-key'] = demo;
        else if (std)
            headers['x-cg-api-key'] = std;
        return headers;
    },
    /** 超时 ms */
    TIMEOUT: 30000,
};
function resolveQverisBaseUrl() {
    const configured = process.env.QVERIS_BASE_URL?.trim() || 'https://qveris.ai/api/v1';
    const url = new URL(configured);
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) {
        throw new Error('QVERIS_BASE_URL 必须使用 HTTPS（本地回归测试地址除外）');
    }
    return url.toString().replace(/\/+$/, '');
}
export const QVERIS_CONFIG = {
    get API_KEY() {
        return getQverisApiKey()?.trim() ?? '';
    },
    get BASE_URL() {
        return resolveQverisBaseUrl();
    },
    DISCOVER_TIMEOUT: 30000,
    EXECUTE_TIMEOUT: 120000,
    MAX_RESPONSE_BYTES: 1024 * 1024,
};
// 开发态输出便于确认来源（不打印实际 Token 值）
if (process.env.NODE_ENV !== 'production') {
    const fromTs = getRequestToken() ? 'request-header' : (process.env.TUSHARE_TOKEN ? 'env' : 'none');
    const fromCg = getCoinGeckoProApiKey() ? 'request-pro-header/env' : (getCoinGeckoApiKey() ? 'request-std-header/env' : 'none');
    console.log('Tushare token source:', fromTs);
    console.log('CoinGecko key source:', fromCg);
}
