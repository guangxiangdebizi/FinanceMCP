# FinanceMCP 部署模式说明

## 📋 概述

从 v4.5.0 开始，FinanceMCP 支持两种部署模式，满足不同的使用场景。

## 🎯 两种模式对比

| 特性 | Streamable HTTP 模式 | stdio/SSE 模式 |
|------|---------------------|---------------|
| **命令** | `finance-mcp-http` | `finance-mcp` |
| **协议** | HTTP + SSE | stdio (标准输入输出) |
| **端口** | 监听 3000/3030 | 不需要端口 |
| **适用场景** | 云端部署、多客户端 | Claude Desktop 本地 |
| **日志** | ✅ 详细的 HTTP 日志 | ✅ MCP 协议日志 |
| **推荐用途** | Smithery 部署、远程访问 | 本地开发、Claude Desktop |

## 🚀 模式 1：Streamable HTTP 模式

### 特点
- ✅ 支持远程访问
- ✅ 可部署到 Smithery 等云平台
- ✅ 支持多个客户端同时连接
- ✅ 完整的 HTTP 日志
- ✅ RESTful 健康检查端点

### 使用场景
- 部署到 Smithery.ai 平台
- 在服务器上运行供多人使用
- 需要通过 HTTP 访问的应用

### 启动方式

#### 1. 全局安装后启动
```bash
npm install -g finance-mcp
finance-mcp-http
```

#### 2. 使用 npx 启动
```bash
npx -y finance-mcp-http
```

#### 3. 本地开发
```bash
npm run start:http
# 或
npm run dev
```

### Claude Desktop 配置（HTTP 模式）

编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "finance-mcp-http": {
      "command": "npx",
      "args": ["-y", "finance-mcp-http"],
      "env": {
        "TUSHARE_TOKEN": "your_tushare_token_here"
      }
    }
  }
}
```

### 环境变量
```bash
# 设置端口（可选，默认 3000）
PORT=3030

# 设置 Tushare Token（必需）
TUSHARE_TOKEN=your_token_here
```

### 访问端点
- **MCP 端点**: `http://localhost:3000/mcp`
- **健康检查**: `http://localhost:3000/health`

## 📡 模式 2：stdio/SSE 模式（默认，推荐）

### 特点
- ✅ 零配置，开箱即用
- ✅ 完美兼容 Claude Desktop
- ✅ 不需要网络端口
- ✅ 进程间直接通信（更快）
- ✅ 轻量级

### 使用场景
- Claude Desktop 本地使用（**推荐**）
- MCP Inspector 调试
- 本地开发和测试
- 不需要网络访问的场景

### 启动方式

#### 1. 全局安装后启动
```bash
npm install -g finance-mcp
finance-mcp
```

#### 2. 使用 npx 启动
```bash
npx -y finance-mcp
```

#### 3. 本地开发
```bash
npm run start:sse
# 或
npm run dev:sse
```

### Claude Desktop 配置（stdio 模式，推荐）

编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
      "args": ["-y", "finance-mcp:sse"],
      "env": {
        "TUSHARE_TOKEN": "your_tushare_token_here"
      }
    }
  }
}
```

或者使用全局安装：

```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "finance-mcp",
      "env": {
        "TUSHARE_TOKEN": "your_tushare_token_here"
      }
    }
  }
}
```

### 环境变量
```bash
# 设置 Tushare Token（必需）
TUSHARE_TOKEN=your_token_here
```

## 🎨 配置示例

### Claude Desktop - 完整配置示例

#### Windows 配置文件位置
```
C:\Users\你的用户名\AppData\Roaming\Claude\claude_desktop_config.json
```

#### macOS 配置文件位置
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

#### 完整配置（stdio 模式，推荐）
```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
      "args": ["-y", "finance-mcp:sse"],
      "env": {
        "TUSHARE_TOKEN": "你的 Tushare Token"
      }
    }
  }
}
```

#### 完整配置（HTTP 模式）
```json
{
  "mcpServers": {
    "finance-mcp-http": {
      "command": "npx",
      "args": ["-y", "finance-mcp"],
      "env": {
        "TUSHARE_TOKEN": "你的 Tushare Token",
        "PORT": "3000"
      }
    }
  }
}
```

#### 同时使用两种模式
```json
{
  "mcpServers": {
    "finance-mcp-stdio": {
      "command": "npx",
      "args": ["-y", "finance-mcp:sse"],
      "env": {
        "TUSHARE_TOKEN": "你的 Tushare Token"
      }
    },
    "finance-mcp-http": {
      "command": "npx",
      "args": ["-y", "finance-mcp"],
      "env": {
        "TUSHARE_TOKEN": "你的 Tushare Token",
        "PORT": "3030"
      }
    }
  }
}
```

## 🌐 Smithery 部署（仅支持 HTTP 模式）

Smithery 平台只支持 HTTP 模式。配置会自动使用 `finance-mcp`（HTTP 模式）。

### smithery.yaml 配置
```yaml
startCommand:
  type: http
  commandFunction: |-
    (config) => ({
      command: "node",
      args: ["build/httpServer.js"],
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        TUSHARE_TOKEN: config.TUSHARE_TOKEN
      }
    })
```

### 部署步骤
1. 访问 [Smithery.ai](https://smithery.ai/server/@guangxiangdebizi/FinanceMCP)
2. 点击 "Deploy Server"
3. 配置 `TUSHARE_TOKEN` 环境变量
4. 完成部署

详细说明请参考 [SMITHERY_DEPLOYMENT.md](./SMITHERY_DEPLOYMENT.md)

## 🔄 模式切换

### 从 HTTP 模式切换到 stdio 模式

如果你已经在 Claude Desktop 中配置了 HTTP 模式，想切换到 stdio 模式：

1. 打开 `claude_desktop_config.json`
2. 将 `args` 中的 `"finance-mcp"` 改为 `"finance-mcp:sse"`
3. 重启 Claude Desktop

```diff
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
-     "args": ["-y", "finance-mcp"],
+     "args": ["-y", "finance-mcp:sse"],
      "env": {
        "TUSHARE_TOKEN": "your_token"
      }
    }
  }
}
```

### 从 stdio 模式切换到 HTTP 模式

反过来操作即可：

```diff
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
-     "args": ["-y", "finance-mcp:sse"],
+     "args": ["-y", "finance-mcp"],
      "env": {
        "TUSHARE_TOKEN": "your_token"
      }
    }
  }
}
```

## 🐛 故障排查

### stdio 模式

**问题**: Claude Desktop 连接不上

**解决方案**:
1. 检查命令是否正确：`finance-mcp:sse`（注意冒号）
2. 确认 TUSHARE_TOKEN 已设置
3. 查看 Claude Desktop 日志
4. 尝试手动运行：`npx -y finance-mcp`

### HTTP 模式

**问题**: 端口已被占用

**解决方案**:
1. 修改 PORT 环境变量
2. 或停止占用端口的进程：
```bash
# Windows
netstat -ano | findstr :3000
taskkill /F /PID <进程ID>

# Linux/Mac
lsof -ti:3000 | xargs kill -9
```

**问题**: 连接超时

**解决方案**:
1. 检查防火墙设置
2. 确认服务器已启动
3. 访问健康检查端点：`http://localhost:3000/health`

## 📊 性能对比

| 指标 | HTTP 模式 | stdio 模式 |
|------|----------|-----------|
| 启动时间 | ~500ms | ~300ms |
| 请求延迟 | 5-10ms | 1-2ms |
| 内存占用 | ~50MB | ~30MB |
| CPU 使用 | 低 | 极低 |
| 网络依赖 | 需要端口 | 无 |

## 💡 最佳实践

### Claude Desktop 本地使用
✅ **推荐使用 stdio 模式**
- 更快的响应速度
- 更低的资源占用
- 零配置，开箱即用

```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
      "args": ["-y", "finance-mcp:sse"]
    }
  }
}
```

### 云端部署/多用户访问
✅ **推荐使用 HTTP 模式**
- 支持远程访问
- 支持多客户端
- 便于监控和日志

### 开发和调试
✅ **两种模式都可以**
- stdio 模式：使用 MCP Inspector 调试
- HTTP 模式：使用 curl/Postman 测试 API

## 📚 相关文档

- [日志功能说明](./LOGGING_GUIDE.md) - HTTP 模式的详细日志
- [Smithery 部署指南](./SMITHERY_DEPLOYMENT.md) - 云端部署教程
- [README](../../README.md) - 完整的项目文档

## 🆕 版本历史

### v4.6.0（当前版本）
- ✅ **重大更改**：`finance-mcp` 现为 stdio 模式（默认，推荐本地使用）
- ✅ HTTP 模式改为 `finance-mcp-http`（云端部署专用）
- ✅ 更符合用户使用习惯：本地优先，云端可选

### v4.5.1
- ✅ 修复 bin 命令名称（npm 不支持冒号）

### v4.5.0
- ✅ 添加双模式支持
- ✅ 两种模式并存，满足不同使用场景

### v4.4.0
- ✅ 添加完整的日志系统
- ✅ 改为 HTTP 模式作为默认

### v4.3.0 及更早
- 仅支持 stdio 模式

---

**版本**: 4.6.0  
**最后更新**: 2025-10-16  
**维护者**: Xingyu_Chen (guangxiangdebizi@gmail.com)

