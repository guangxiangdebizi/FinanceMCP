import { createHash, createHmac, randomBytes } from 'node:crypto';
export function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function normalizeForStableJson(value) {
    if (Array.isArray(value))
        return value.map(normalizeForStableJson);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, normalizeForStableJson(value[key])]));
}
export function stableJson(value) {
    return JSON.stringify(normalizeForStableJson(value));
}
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function hmacSha256(key, value) {
    return createHmac('sha256', key).update(value).digest('hex');
}
export function randomToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}
export function parsePositiveInteger(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/, '');
}
export function sanitizeIdentifier(value, fallback) {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 128);
    return cleaned || fallback;
}
export function truncate(value, maxCharacters) {
    if (value.length <= maxCharacters)
        return value;
    return `${value.slice(0, Math.max(0, maxCharacters - 24))}\n...[truncated by gateway]`;
}
export function nowIso() {
    return new Date().toISOString();
}
export function timingSafeTokenHash(token) {
    return sha256(`finance-cache-gateway:v1:${token}`);
}
