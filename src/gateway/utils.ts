import { createHash, createHmac, randomBytes } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, normalizeForStableJson(value[key])])
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 128);
  return cleaned || fallback;
}

export function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 24))}\n...[truncated by gateway]`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timingSafeTokenHash(token: string): string {
  return sha256(`finance-cache-gateway:v1:${token}`);
}
