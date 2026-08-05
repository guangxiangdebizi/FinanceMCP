export const STOCK_MARKET_TYPES = [
    'cn',
    'us',
    'hk',
    'fx',
    'futures',
    'fund',
    'repo',
    'convertible_bond',
    'options',
    'crypto',
];
export const INDEX_DATA_TYPES = [
    'daily',
    'weekly',
    'monthly',
    'global',
    'basic',
    'valuation',
];
export const MACRO_INDICATORS = [
    'shibor',
    'lpr',
    'gdp',
    'cpi',
    'ppi',
    'cn_m',
    'cn_pmi',
    'cn_sf',
    'shibor_quote',
    'libor',
    'hibor',
];
export class InvalidToolInputError extends Error {
    constructor(field) {
        super(`Invalid ${field}`);
        this.name = 'InvalidToolInputError';
    }
}
export function normalizeEnumInput(value, allowed, field) {
    if (typeof value !== 'string')
        throw new InvalidToolInputError(field);
    const normalized = value.trim().toLowerCase();
    if (!allowed.includes(normalized)) {
        throw new InvalidToolInputError(field);
    }
    return normalized;
}
export function normalizeOptionalEnumInput(value, allowed, field) {
    if (value === undefined || value === null || value === '')
        return undefined;
    return normalizeEnumInput(value, allowed, field);
}
export function normalizeFinancialCode(value, options = {}) {
    if (typeof value !== 'string')
        throw new InvalidToolInputError('code');
    const maxLength = options.maxLength ?? 40;
    const normalized = value.trim().toUpperCase();
    const pattern = options.allowSlash
        ? /^[A-Z0-9][A-Z0-9._/-]*$/
        : /^[A-Z0-9][A-Z0-9._-]*$/;
    if (normalized.length === 0 ||
        normalized.length > maxLength ||
        normalized.includes('..') ||
        !pattern.test(normalized)) {
        throw new InvalidToolInputError('code');
    }
    return normalized;
}
export function normalizeOptionalDate(value, field) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) {
        throw new InvalidToolInputError(field);
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) {
        throw new InvalidToolInputError(field);
    }
    return value;
}
export function normalizeOptionalIndicatorList(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string')
        throw new InvalidToolInputError('indicators');
    const normalized = value.trim();
    if (normalized.length > 256 || !/^[A-Za-z0-9(),.+\-\s]+$/.test(normalized)) {
        throw new InvalidToolInputError('indicators');
    }
    return normalized;
}
