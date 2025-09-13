#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { toolList, callTool } from "./toolRegistry.js";
const sessions = new Map();
function extractTokenFromHeaders(req) {
    const h = req.headers;
    const tokenHeader = (h['x-tushare-token'] || h['x-api-key']);
    if (tokenHeader && tokenHeader.trim())
        return tokenHeader.trim();
    const auth = h['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer '))
        return auth.slice(7).trim();
    return undefined;
}
// 移除 CoinGecko 头的解析（已改为 Binance 公共行情，无需 Key）
const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID', 'X-Tenant-Id', 'X-Api-Key', 'X-Tushare-Token'
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
    if (forceSse || (typeof accept === 'string' && accept.includes('text/event-stream'))) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        // 仅发送注释型心跳，避免发送非 JSON-RPC 的 data 事件
        res.write(': stream established\n\n');
        const keep = setInterval(() => res.write(': keepalive\n\n'), 30000);
        req.on('close', () => clearInterval(keep));
        return;
    }
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Accept must include text/event-stream' }, id: null });
});
app.post('/mcp', async (req, res) => {
    const body = req.body;
    if (!body)
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty body' }, id: null });
    const isNotification = (body.id === undefined || body.id === null) && typeof body.method === 'string' && body.method.startsWith('notifications/');
    if (isNotification) {
        const sid = req.headers['mcp-session-id'];
        if (sid && sessions.has(sid))
            sessions.get(sid).lastActivity = new Date();
        return res.status(204).end();
    }
    const method = body.method;
    if (method === 'initialize') {
        const newId = randomUUID();
        sessions.set(newId, { id: newId, createdAt: new Date(), lastActivity: new Date() });
        res.setHeader('Mcp-Session-Id', newId);
        return res.json({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'FinanceMCP', version: '1.0.0' } }, id: body.id });
    }
    if (method === 'tools/list') {
        return res.json({ jsonrpc: '2.0', result: { tools: toolList }, id: body.id });
    }
    if (method === 'tools/call') {
        const { name, arguments: args } = body.params || {};
        const token = extractTokenFromHeaders(req);
        try {
            const result = await callTool(name, args, token);
            return res.json({ jsonrpc: '2.0', result, id: body.id });
        }
        catch (error) {
            const message = error?.message || String(error);
            return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: body.id });
        }
    }
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
    console.log(`Streamable HTTP MCP Server http://localhost:${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Health: http://localhost:${PORT}/health`);
});
//# sourceMappingURL=httpServer.js.map