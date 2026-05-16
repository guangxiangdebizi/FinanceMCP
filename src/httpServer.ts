#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { runWithRequestContext } from "./config.js";
import { toolList, dispatchTool } from "./dispatch.js";


interface Session { id: string; createdAt: Date; lastActivity: Date }
const sessions = new Map<string, Session>();

function extractTokenFromHeaders(req: Request): string | undefined {
  const h = req.headers;
  
  // 1. 尝试从标准请求头读取
  const tokenHeader = (h['x-tushare-token'] || h['x-api-key']) as string | undefined;
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
    console.log(`[TOKEN] Found Smithery config header:`, smitheryConfig);
    try {
      const config = JSON.parse(smitheryConfig as string);
      if (config.TUSHARE_TOKEN) {
        console.log(`[TOKEN] Extracted from Smithery config`);
        return config.TUSHARE_TOKEN;
      }
    } catch (e) {
      console.log(`[TOKEN] Failed to parse Smithery config:`, e);
    }
  }
  
  // 4. 🔍 尝试从查询参数读取
  const query = req.query;
  if (query.tushare_token || query.TUSHARE_TOKEN) {
    console.log(`[TOKEN] Found in query parameters`);
    return (query.tushare_token || query.TUSHARE_TOKEN) as string;
  }
  
  console.log(`[TOKEN] Not found in request, falling back to environment variable`);
  return undefined;
}

// 移除 CoinGecko 头的解析（已改为 Binance 公共行情，无需 Key）

const app = express();
const PORT = Number(process.env.PORT || 3000);

// 日志中间件：记录所有请求
app.use((req: Request, res: Response, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const ip = req.ip || req.socket.remoteAddress;
  
  console.log(`[${timestamp}] ${method} ${url} - IP: ${ip}`);
  
  // 🔍 详细记录所有请求头，用于调试 Smithery 配置传递
  console.log(`[DEBUG] Request Headers:`, JSON.stringify(req.headers, null, 2));
  
  // 记录请求完成时的状态码
  const originalSend = res.send;
  res.send = function(data): any {
    console.log(`[${timestamp}] ${method} ${url} - Status: ${res.statusCode}`);
    return originalSend.call(this, data);
  };
  
  next();
});

app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: [
    'Content-Type','Accept','Authorization','Mcp-Session-Id','Last-Event-ID',
    'X-Tenant-Id','X-Api-Key','X-Tushare-Token',
    'X-Smithery-Config','X-Config','X-Session-Config'  // Smithery 可能的配置头
  ],
  exposedHeaders: ['Content-Type','Mcp-Session-Id']
}));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', transport: 'streamable-http', activeSessions: sessions.size });
});

app.get('/mcp', (req: Request, res: Response) => {
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

app.post('/mcp', async (req: Request, res: Response) => {
  const body = req.body;
  if (!body) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty body' }, id: null });

  const isNotification = (body.id === undefined || body.id === null) && typeof body.method === 'string' && body.method.startsWith('notifications/');
  if (isNotification) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    console.log(`🔔 [MCP-Notification] ${body.method} - Session: ${sid || 'none'}`);
    if (sid && sessions.has(sid)) sessions.get(sid)!.lastActivity = new Date();
    return res.status(204).end();
  }

  const method = body.method as string;
  console.log(`🔧 [MCP-${method}] Request ID: ${body.id}`);
  
  if (method === 'initialize') {
    const newId = randomUUID();
    sessions.set(newId, { id: newId, createdAt: new Date(), lastActivity: new Date() });
    res.setHeader('Mcp-Session-Id', newId);
    console.log(`✅ [MCP-initialize] New session created: ${newId}`);
    return res.json({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'FinanceMCP', version: '1.0.0' } }, id: body.id });
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
    const startTime = Date.now();
    console.log(`🚀 [MCP-tools/call] Tool: ${name} | Has Token: ${!!token}`);
    
    try {
      const result = await runWithRequestContext({ tushareToken: token }, async () => {
        return await dispatchTool(name, args || {});
      });
      const duration = Date.now() - startTime;
      console.log(`✅ [MCP-tools/call] Tool: ${name} completed in ${duration}ms`);
      return res.json({ jsonrpc: '2.0', result, id: body.id });
    } catch (error: any) {
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
app.post('/mcp/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

// 备用别名
app.post('/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

// 兼容 GET 终止
app.get('/mcp/terminate', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

app.get('/terminate', (_req: Request, res: Response) => {
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
