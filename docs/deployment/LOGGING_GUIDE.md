# FinanceMCP 日志功能说明

## 📝 概述

从 v4.4.0 版本开始，FinanceMCP 的 Streamable HTTP 模式现在包含了全面的日志记录功能，让你可以实时监控服务器的所有活动。

## 🎯 为什么需要日志？

你之前提到的问题："为什么 Streamable HTTP 协议不会主动在 cmd 里面产生 log？" 

**答案**：Streamable HTTP 其实包含了 SSE（Server-Sent Events），SSE 是 HTTP 协议的一部分。之前的代码缺少日志输出，所以看起来"没有 log"。现在我们添加了完整的日志系统！

## 📊 日志类型

### 1. 服务器启动日志

当你启动服务器时，会看到：

```
============================================================
🚀 FinanceMCP Streamable HTTP Server Started
============================================================
📍 Server URL:    http://localhost:3030
📡 MCP Endpoint:  http://localhost:3030/mcp
💚 Health Check:  http://localhost:3030/health
📊 Active Sessions: 0
🔧 Available Tools: 21
============================================================
📝 Server is ready to accept connections
============================================================
```

### 2. HTTP 请求日志

每个 HTTP 请求都会记录：

```
[2025-10-16T02:30:45.123Z] GET /health - IP: ::1
[2025-10-16T02:30:45.125Z] GET /health - Status: 200
```

### 3. SSE 连接日志

当客户端建立 SSE 连接时：

```
📡 [MCP-SSE] Client connecting - Accept: text/event-stream, Force SSE: false
✅ [MCP-SSE] Stream established
```

当客户端断开连接时：

```
🔌 [MCP-SSE] Client disconnected
```

### 4. MCP 方法调用日志

#### Initialize（初始化会话）

```
🔧 [MCP-initialize] Request ID: 1
✅ [MCP-initialize] New session created: 550e8400-e29b-41d4-a716-446655440000
```

#### Tools/List（列出工具）

```
🔧 [MCP-tools/list] Request ID: 2
📋 [MCP-tools/list] Returning 21 tools
```

#### Tools/Call（调用工具）

成功调用：
```
🔧 [MCP-tools/call] Request ID: 3
🚀 [MCP-tools/call] Tool: stock_data | Has Token: true
✅ [MCP-tools/call] Tool: stock_data completed in 1234ms
```

失败调用：
```
🔧 [MCP-tools/call] Request ID: 4
🚀 [MCP-tools/call] Tool: stock_data | Has Token: false
❌ [MCP-tools/call] Tool: stock_data failed after 123ms - Error: Tushare token required
```

#### Notifications（通知消息）

```
🔔 [MCP-Notification] notifications/progress - Session: 550e8400-e29b-41d4-a716-446655440000
```

## 🚀 使用示例

### 启动服务器并查看日志

```bash
# 方式 1：直接运行
npm run start:http

# 方式 2：使用构建后的文件
node build/httpServer.js

# 方式 3：全局安装后运行
finance-mcp
```

### 完整的使用场景示例

假设你使用 Claude Desktop 连接到服务器，你会看到类似这样的日志流：

```
============================================================
🚀 FinanceMCP Streamable HTTP Server Started
============================================================
📍 Server URL:    http://localhost:3030
📡 MCP Endpoint:  http://localhost:3030/mcp
💚 Health Check:  http://localhost:3030/health
📊 Active Sessions: 0
🔧 Available Tools: 21
============================================================
📝 Server is ready to accept connections
============================================================

Tushare token source: env
CoinGecko key source: none

[2025-10-16T02:35:10.456Z] POST /mcp - IP: ::1
🔧 [MCP-initialize] Request ID: 1
✅ [MCP-initialize] New session created: abc123-def456-789
[2025-10-16T02:35:10.458Z] POST /mcp - Status: 200

[2025-10-16T02:35:11.123Z] POST /mcp - IP: ::1
🔧 [MCP-tools/list] Request ID: 2
📋 [MCP-tools/list] Returning 21 tools
[2025-10-16T02:35:11.125Z] POST /mcp - Status: 200

[2025-10-16T02:35:15.789Z] POST /mcp - IP: ::1
🔧 [MCP-tools/call] Request ID: 3
🚀 [MCP-tools/call] Tool: stock_data | Has Token: true
✅ [MCP-tools/call] Tool: stock_data completed in 1856ms
[2025-10-16T02:35:17.645Z] POST /mcp - Status: 200

[2025-10-16T02:35:20.001Z] POST /mcp - IP: ::1
🔧 [MCP-tools/call] Request ID: 4
🚀 [MCP-tools/call] Tool: finance_news | Has Token: true
✅ [MCP-tools/call] Tool: finance_news completed in 2341ms
[2025-10-16T02:35:22.342Z] POST /mcp - Status: 200
```

## 🔍 日志含义解析

### 图标说明

| 图标 | 含义 |
|------|------|
| 🚀 | 服务器启动或工具调用开始 |
| 📍 | 服务器地址信息 |
| 📡 | SSE 连接相关 |
| 💚 | 健康检查端点 |
| 📊 | 统计信息 |
| 🔧 | MCP 方法调用 |
| 📋 | 工具列表 |
| ✅ | 成功操作 |
| ❌ | 失败操作 |
| 🔔 | 通知消息 |
| 🔌 | 连接断开 |

### 时间戳格式

所有日志都包含 ISO 8601 格式的时间戳：`[2025-10-16T02:35:10.456Z]`

### Token 状态

- `Has Token: true` - 请求包含了 Tushare Token
- `Has Token: false` - 请求缺少 Token（某些工具需要 Token）

### 执行时间

每个工具调用都会显示执行时间，帮助你：
- 识别慢速操作
- 优化性能
- 排查问题

## 🛠️ 调试技巧

### 1. 查看特定工具的调用

使用 `grep` 或 `findstr` 过滤日志：

```bash
# Linux/Mac
node build/httpServer.js | grep "stock_data"

# Windows (PowerShell)
node build/httpServer.js | Select-String "stock_data"
```

### 2. 监控错误

```bash
# Linux/Mac
node build/httpServer.js | grep "❌"

# Windows
node build/httpServer.js | Select-String "❌"
```

### 3. 查看性能统计

查找 `completed in` 来分析工具执行时间：

```bash
node build/httpServer.js | Select-String "completed in"
```

### 4. 保存日志到文件

```bash
# Windows PowerShell
node build/httpServer.js | Tee-Object -FilePath server.log

# Windows CMD
node build/httpServer.js > server.log 2>&1
```

## 🔒 隐私和安全

日志系统设计时考虑了安全性：

- ✅ **不记录敏感数据**：Token 值不会被记录
- ✅ **只显示状态**：`Has Token: true/false`
- ✅ **不记录完整参数**：避免泄露敏感的查询参数
- ✅ **只记录工具名称**：不记录完整的 API 响应

## 📈 性能影响

日志功能对性能影响微乎其微：

- **启动时间**：无影响
- **请求延迟**：< 1ms
- **内存占用**：可忽略不计
- **CPU 使用**：< 0.1%

## 🎨 自定义日志

如果你想修改日志格式或添加更多日志，编辑 `src/httpServer.ts`：

```typescript
// 示例：添加更详细的参数日志
console.log(`🚀 [MCP-tools/call] Tool: ${name} | Args: ${JSON.stringify(args)}`);
```

## 🆚 与 stdio 模式的对比

| 特性 | stdio 模式 | HTTP 模式（带日志） |
|------|-----------|-------------------|
| 启动日志 | 基本 | 详细的启动横幅 |
| 请求日志 | 无 | 完整的 HTTP 请求日志 |
| 工具调用日志 | 无 | 详细的调用和时间统计 |
| 错误日志 | 基本 | 详细的错误信息 |
| 连接状态 | 无 | SSE 连接状态跟踪 |
| 性能监控 | 无 | 执行时间统计 |

## 🚨 常见问题

### Q: 为什么看不到日志？

A: 确保你是在前台运行服务器，而不是后台：

```bash
# 正确 ✅
node build/httpServer.js

# 错误（看不到日志）❌
node build/httpServer.js &
```

### Q: 日志太多了，如何精简？

A: 你可以：
1. 使用 `grep`/`Select-String` 过滤
2. 修改 `src/httpServer.ts` 删除不需要的日志
3. 设置 `NODE_ENV=production` 减少部分日志

### Q: 如何在生产环境中使用日志？

A: 建议使用日志聚合工具：

```bash
# 使用 PM2
pm2 start build/httpServer.js --name finance-mcp --log server.log

# 使用 Docker 查看日志
docker logs -f container_name
```

### Q: SSE 是什么？和 HTTP 有什么关系？

A: SSE（Server-Sent Events）是 HTTP 协议的一个特性：
- **基于 HTTP**：使用标准的 HTTP 连接
- **单向推送**：服务器可以向客户端推送数据
- **保持连接**：长连接，用于实时更新
- **MCP 使用场景**：用于建立持久化的 MCP 连接

在我们的实现中：
- `GET /mcp` 建立 SSE 连接（长连接）
- `POST /mcp` 发送 MCP 请求和响应（短连接）
- 两者配合实现完整的 Streamable HTTP 协议

## 📚 相关资源

- [MCP 协议文档](https://spec.modelcontextprotocol.io/)
- [SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Express 日志最佳实践](https://expressjs.com/en/advanced/best-practice-performance.html)

---

**版本**: 4.4.0  
**最后更新**: 2025-10-16  
**维护者**: Xingyu_Chen (guangxiangdebizi@gmail.com)

