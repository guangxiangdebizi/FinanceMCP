#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { parseSourcePriority, runWithRequestContext } from "./config.js";
import { toolList, dispatchTool } from "./dispatch.js";
const sessions = new Map();
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'x-api-key',
    'x-tushare-token',
    'x-qveris-api-key',
    'x-cg-api-key',
    'x-cg-demo-api-key',
    'x-cg-pro-api-key',
    'x-smithery-config',
    'x-config',
    'x-session-config',
]);
function redactHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name,
        SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) && value ? '[REDACTED]' : value,
    ]));
}
function redactUrl(rawUrl) {
    try {
        const url = new URL(rawUrl, 'http://localhost');
        for (const key of ['tushare_token', 'TUSHARE_TOKEN']) {
            if (url.searchParams.has(key))
                url.searchParams.set(key, '[REDACTED]');
        }
        return `${url.pathname}${url.search}`;
    }
    catch {
        return rawUrl.split('?')[0];
    }
}
function parseConfigHeader(req) {
    const raw = req.headers['x-smithery-config'] || req.headers['x-config'] || req.headers['x-session-config'];
    if (typeof raw !== 'string' || !raw.trim())
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        console.log('[TOKEN] Failed to parse request config header');
        return undefined;
    }
}
function extractTokenFromHeaders(req) {
    const h = req.headers;
    // 1. 尝试从标准请求头读取
    const tokenHeader = (h['x-tushare-token'] || h['x-api-key']);
    if (tokenHeader && tokenHeader.trim()) {
        console.log(`[TOKEN] Found in X-Tushare-Token/X-Api-Key header`);
        return tokenHeader.trim();
    }
    // 2. 尝试从 Authorization Bearer 读取
    const auth = h['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        console.log(`[TOKEN] Found in Authorization Bearer header`);
        return auth.slice(7).trim();
    }
    // 3. 🔍 尝试从 Smithery 特殊头读取（可能的头名称）
    const smitheryConfig = h['x-smithery-config'] || h['x-config'] || h['x-session-config'];
    if (smitheryConfig) {
        const config = parseConfigHeader(req);
        if (typeof config?.TUSHARE_TOKEN === 'string' && config.TUSHARE_TOKEN.trim()) {
            console.log(`[TOKEN] Extracted Tushare token from request config`);
            return config.TUSHARE_TOKEN.trim();
        }
    }
    // 4. 🔍 尝试从查询参数读取
    const query = req.query;
    if (query.tushare_token || query.TUSHARE_TOKEN) {
        console.log(`[TOKEN] Found in query parameters`);
        return (query.tushare_token || query.TUSHARE_TOKEN);
    }
    console.log(`[TOKEN] Not found in request, falling back to environment variable`);
    return undefined;
}
function extractQverisApiKeyFromHeaders(req) {
    const header = req.headers['x-qveris-api-key'];
    if (typeof header === 'string' && header.trim()) {
        console.log('[TOKEN] Found Qveris key in X-Qveris-Api-Key header');
        return header.trim();
    }
    const config = parseConfigHeader(req);
    if (typeof config?.QVERIS_API_KEY === 'string' && config.QVERIS_API_KEY.trim()) {
        console.log('[TOKEN] Extracted Qveris key from request config');
        return config.QVERIS_API_KEY.trim();
    }
    return undefined;
}
function extractSourcePriorityFromHeaders(req) {
    const header = req.headers['x-finance-source-priority'];
    const config = parseConfigHeader(req);
    const configured = config?.FINANCE_SOURCE_PRIORITY ?? config?.SOURCE_PRIORITY;
    const raw = typeof header === 'string'
        ? header
        : typeof configured === 'string'
            ? configured
            : undefined;
    return raw ? parseSourcePriority(raw) : undefined;
}
const app = express();
const PORT = Number(process.env.PORT || 3000);
// 日志中间件：记录所有请求
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = redactUrl(req.url);
    const ip = req.ip || req.socket.remoteAddress;
    console.log(`[${timestamp}] ${method} ${url} - IP: ${ip}`);
    console.log(`[DEBUG] Request Headers:`, JSON.stringify(redactHeaders(req.headers), null, 2));
    // 记录请求完成时的状态码
    const originalSend = res.send;
    res.send = function (data) {
        console.log(`[${timestamp}] ${method} ${url} - Status: ${res.statusCode}`);
        return originalSend.call(this, data);
    };
    next();
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID',
        'X-Tenant-Id', 'X-Api-Key', 'X-Tushare-Token', 'X-Qveris-Api-Key', 'X-Finance-Source-Priority',
        'X-Smithery-Config', 'X-Config', 'X-Session-Config' // Smithery 可能的配置头
    ],
    exposedHeaders: ['Content-Type', 'Mcp-Session-Id']
}));
app.use(express.json({ limit: '10mb' }));
app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', transport: 'streamable-http', activeSessions: sessions.size });
});
app.get('/mcp', (req, res) => {
    const accept = req.headers.accept || '';
    const forceSse = req.query.sse === '1' || req.query.sse === 'true';
    console.log(`📡 [MCP-SSE] Client connecting - Accept: ${accept}, Force SSE: ${forceSse}`);
    if (forceSse || (typeof accept === 'string' && accept.includes('text/event-stream'))) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        // 仅发送注释型心跳，避免发送非 JSON-RPC 的 data 事件
        res.write(': stream established\n\n');
        console.log(`✅ [MCP-SSE] Stream established`);
        const keep = setInterval(() => res.write(': keepalive\n\n'), 30000);
        req.on('close', () => {
            clearInterval(keep);
            console.log(`🔌 [MCP-SSE] Client disconnected`);
        });
        return;
    }
    console.log(`❌ [MCP-SSE] Invalid Accept header`);
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Accept must include text/event-stream' }, id: null });
});
app.post('/mcp', async (req, res) => {
    const body = req.body;
    if (!body)
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty body' }, id: null });
    const isNotification = (body.id === undefined || body.id === null) && typeof body.method === 'string' && body.method.startsWith('notifications/');
    if (isNotification) {
        const sid = req.headers['mcp-session-id'];
        console.log(`🔔 [MCP-Notification] ${body.method} - Session: ${sid || 'none'}`);
        if (sid && sessions.has(sid))
            sessions.get(sid).lastActivity = new Date();
        return res.status(204).end();
    }
    const method = body.method;
    console.log(`🔧 [MCP-${method}] Request ID: ${body.id}`);
    if (method === 'initialize') {
        const newId = randomUUID();
        sessions.set(newId, { id: newId, createdAt: new Date(), lastActivity: new Date() });
        res.setHeader('Mcp-Session-Id', newId);
        console.log(`✅ [MCP-initialize] New session created: ${newId}`);
        return res.json({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'FinanceMCP', version: '4.9.0' } }, id: body.id });
    }
    if (method === 'tools/list') {
        console.log(`📋 [MCP-tools/list] Returning ${toolList.length} tools`);
        return res.json({ jsonrpc: '2.0', result: { tools: toolList }, id: body.id });
    }
    // 明确表示不支持 resources 和 prompts（返回空列表而不是错误）
    if (method === 'resources/list') {
        console.log(`📋 [MCP-resources/list] Not supported, returning empty list`);
        return res.json({ jsonrpc: '2.0', result: { resources: [] }, id: body.id });
    }
    if (method === 'resources/templates/list') {
        console.log(`📋 [MCP-resources/templates/list] Not supported, returning empty list`);
        return res.json({ jsonrpc: '2.0', result: { resourceTemplates: [] }, id: body.id });
    }
    if (method === 'prompts/list') {
        console.log(`📋 [MCP-prompts/list] Not supported, returning empty list`);
        return res.json({ jsonrpc: '2.0', result: { prompts: [] }, id: body.id });
    }
    if (method === 'tools/call') {
        const { name, arguments: args } = body.params || {};
        const token = extractTokenFromHeaders(req);
        const qverisApiKey = extractQverisApiKeyFromHeaders(req);
        const sourcePriority = extractSourcePriorityFromHeaders(req);
        const startTime = Date.now();
        console.log(`🚀 [MCP-tools/call] Tool: ${name} | Has Tushare Token: ${!!token} | Has Qveris Key: ${!!qverisApiKey}`);
        try {
            const result = await runWithRequestContext({
                tushareToken: token,
                qverisApiKey,
                sourcePriority,
            }, async () => {
                return await dispatchTool(name, args || {});
            });
            const duration = Date.now() - startTime;
            console.log(`✅ [MCP-tools/call] Tool: ${name} completed in ${duration}ms`);
            return res.json({ jsonrpc: '2.0', result, id: body.id });
        }
        catch (error) {
            const duration = Date.now() - startTime;
            const message = error?.message || String(error);
            console.error(`❌ [MCP-tools/call] Tool: ${name} failed after ${duration}ms - Error: ${message}`);
            return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: body.id });
        }
    }
    console.error(`❌ [MCP] Unknown method: ${method}`);
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id: body.id });
});
// 兼容性终止路由：部分客户端在结束会话时会调用此端点
app.post('/mcp/terminate', (_req, res) => {
    return res.status(200).json({ ok: true });
});
// 备用别名
app.post('/terminate', (_req, res) => {
    return res.status(200).json({ ok: true });
});
// 兼容 GET 终止
app.get('/mcp/terminate', (_req, res) => {
    return res.status(200).json({ ok: true });
});
app.get('/terminate', (_req, res) => {
    return res.status(200).json({ ok: true });
});
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 FinanceMCP Streamable HTTP Server Started');
    console.log('='.repeat(60));
    console.log(`📍 Server URL:    http://localhost:${PORT}`);
    console.log(`📡 MCP Endpoint:  http://localhost:${PORT}/mcp`);
    console.log(`💚 Health Check:  http://localhost:${PORT}/health`);
    console.log(`📊 Active Sessions: ${sessions.size}`);
    console.log(`🔧 Available Tools: ${toolList.length}`);
    console.log('='.repeat(60));
    console.log('📝 Server is ready to accept connections');
    console.log('='.repeat(60) + '\n');
});
