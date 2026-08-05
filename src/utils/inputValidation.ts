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
] as const;

export const INDEX_DATA_TYPES = [
  'daily',
  'weekly',
  'monthly',
  'global',
  'basic',
  'valuation',
] as const;

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
] as const;

export class InvalidToolInputError extends Error {
  constructor(field: string) {
    super(`Invalid ${field}`);
    this.name = 'InvalidToolInputError';
  }
}

export function normalizeEnumInput<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== 'string') throw new InvalidToolInputError(field);

  const normalized = value.trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new InvalidToolInputError(field);
  }
  return normalized as T[number];
}

export function normalizeOptionalEnumInput<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeEnumInput(value, allowed, field);
}

export function normalizeFinancialCode(
  value: unknown,
  options: { allowSlash?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== 'string') throw new InvalidToolInputError('code');

  const maxLength = options.maxLength ?? 40;
  const normalized = value.trim().toUpperCase();
  const pattern = options.allowSlash
    ? /^[A-Z0-9][A-Z0-9._/-]*$/
    : /^[A-Z0-9][A-Z0-9._-]*$/;

  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    normalized.includes('..') ||
    !pattern.test(normalized)
  ) {
    throw new InvalidToolInputError('code');
  }
  return normalized;
}

export function normalizeOptionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) {
    throw new InvalidToolInputError(field);
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidToolInputError(field);
  }
  return value;
}

export function normalizeOptionalIndicatorList(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new InvalidToolInputError('indicators');

  const normalized = value.trim();
  if (normalized.length > 256 || !/^[A-Za-z0-9(),.+\-\s]+$/.test(normalized)) {
    throw new InvalidToolInputError('indicators');
  }
  return normalized;
}
