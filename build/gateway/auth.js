import { timingSafeEqual } from 'node:crypto';
import { timingSafeTokenHash } from './utils.js';
export class GatewayAuthenticationError extends Error {
    statusCode = 401;
    constructor(message = 'Invalid or missing cache gateway API key') {
        super(message);
        this.name = 'GatewayAuthenticationError';
    }
}
function extractToken(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim() || undefined;
    }
    const apiKey = req.headers['x-api-key'];
    return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
}
function hashesEqual(left, right) {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
export function authenticateRequest(req, config) {
    const token = extractToken(req);
    if (token) {
        const tokenHash = timingSafeTokenHash(token);
        const client = config.clients.find(candidate => hashesEqual(candidate.tokenHash, tokenHash));
        if (client) {
            return {
                tenantId: client.tenantId,
                workspaceId: client.workspaceId,
                label: client.label,
                anonymous: false,
            };
        }
    }
    if (config.allowAnonymous) {
        return { tenantId: 'anonymous', workspaceId: 'local', label: 'anonymous', anonymous: true };
    }
    throw new GatewayAuthenticationError();
}
