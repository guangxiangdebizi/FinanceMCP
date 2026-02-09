# Smithery 平台部署指南

本文档说明如何将 FinanceMCP 部署到 [Smithery.ai](https://smithery.ai/docs) 平台。

## 📋 前置要求

1. GitHub 账号
2. Smithery 账号（访问 [Smithery.ai](https://smithery.ai) 注册）
3. Tushare Pro API Token（从 [Tushare](https://tushare.pro) 获取）

## 🚀 部署步骤

### 1. 准备代码仓库

确保你的代码已推送到 GitHub 仓库，并且包含以下文件：
- ✅ `Dockerfile` - Docker 配置文件
- ✅ `smithery.yaml` - Smithery 平台配置
- ✅ `package.json` - Node.js 项目配置
- ✅ `build/` 目录 - 编译后的代码

### 2. 连接 Smithery

1. 访问 [Smithery.ai](https://smithery.ai)
2. 使用 GitHub 账号登录
3. 授权 Smithery 访问你的 GitHub 仓库

### 3. 创建部署

1. 在 Smithery 控制台点击 **"Deploy Server"**
2. 选择你的 GitHub 仓库：`guangxiangdebizi/FinanceMCP`
3. Smithery 会自动检测 `smithery.yaml` 配置文件

### 4. 配置环境变量（可选）

在部署配置界面，你可以选择性地设置以下环境变量：

| 变量名 | 说明 | 是否必需 | 示例值 |
|--------|------|---------|--------|
| `TUSHARE_TOKEN` | 默认 Tushare API Token（**可选**） | ❌ 否 | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `PORT` | HTTP 服务端口 | ❌ 否（默认 3000） | `3000` |

**💡 重要说明**：
- `TUSHARE_TOKEN` 现在是**可选**的！你可以留空，让每个使用者提供自己的 token
- 如果你在部署时提供了 token，它将作为**默认回退值**
- **推荐做法**：部署时留空，让用户在客户端配置中提供自己的 token

### 5. 完成部署

1. 点击 **"Deploy"** 按钮
2. Smithery 会自动：
   - 构建 Docker 镜像
   - 启动 HTTP 服务器
   - 生成 MCP 连接端点
3. 等待部署完成（通常需要 2-5 分钟）

## 🔗 使用部署的服务

### 在 Claude Desktop 中使用

部署完成后，Smithery 会提供一个 HTTP 端点。**每个用户**在 Claude Desktop 配置文件中添加自己的 token：

```json
{
  "mcpServers": {
    "finance-mcp": {
      "type": "streamableHttp",
      "url": "https://your-deployment-url.smithery.ai/mcp",
      "headers": {
        "X-Tushare-Token": "your_personal_tushare_token_here"
      }
    }
  }
}
```

**🔑 Token 配置方式**（按优先级排序）：
1. ✅ **推荐**：通过 `X-Tushare-Token` header 传递（如上所示）
2. ✅ 通过 `Authorization: Bearer <token>` header 传递
3. ✅ 通过 `X-Api-Key` header 传递
4. ⚠️ 回退：使用部署时配置的默认 token（如果有）

**👥 多用户场景**：
- ✅ 每个用户在自己的 Claude Desktop 配置中使用自己的 Tushare token
- ✅ 无需共享 API key，每个人使用自己的配额
- ✅ 更安全，不会泄露他人的 token

### 在其他 MCP 客户端中使用

使用 Smithery 提供的端点 URL：

- **MCP 端点**: `https://your-deployment-url.smithery.ai/mcp`
- **健康检查**: `https://your-deployment-url.smithery.ai/health`

## 📊 服务器配置

### 当前配置（smithery.yaml）

```yaml
name: "@guangxiangdebizi/FinanceMCP"
version: "4.4.0"
description: "财经数据查询 & 财经新闻 & 公司财务表现分析 MCP"

startCommand:
  type: http                      # Streamable HTTP 模式
  configSchema:
    type: object
    required: ["TUSHARE_TOKEN"]
    properties:
      TUSHARE_TOKEN:
        type: string
        title: "Tushare API Token"
        description: "Your personal Tushare API token for accessing financial data"
```

### Docker 配置

- **基础镜像**: `node:lts-alpine`
- **暴露端口**: `3000`
- **启动命令**: `node build/httpServer.js`
- **环境变量**:
  - `NODE_ENV=production`
  - `PORT=3000`

## 🛠️ 本地测试

在部署到 Smithery 之前，建议先在本地测试 Docker 镜像：

```bash
# 1. 构建镜像
docker build -t finance-mcp:test .

# 2. 运行容器
docker run -p 3000:3000 \
  -e TUSHARE_TOKEN=your_token_here \
  finance-mcp:test

# 3. 测试健康检查
curl http://localhost:3000/health

# 4. 测试 MCP 端点
curl http://localhost:3000/mcp
```

## 📝 更新部署

当你更新代码后：

1. 提交并推送代码到 GitHub
2. 更新 `smithery.yaml` 中的版本号
3. 在 Smithery 控制台触发重新部署

或者使用自动部署：
- Smithery 可以配置为监听 GitHub 仓库的特定分支
- 每次推送代码会自动触发重新部署

## 🔍 故障排查

### 部署失败

1. **检查 Dockerfile**：确保 `EXPOSE 3000` 和 `CMD` 正确
2. **检查 smithery.yaml**：确保 `type: http` 和端口配置正确
3. **检查构建日志**：在 Smithery 控制台查看详细错误信息

### 服务无法访问

1. **检查健康端点**：访问 `/health` 确认服务运行
2. **检查环境变量**：确保 `TUSHARE_TOKEN` 已正确配置
3. **检查端口**：确保容器监听正确的端口（3000）

### Token 无效

1. 确保 Tushare Token 有效且未过期
2. 检查 Token 是否正确传递到容器
3. 查看服务器日志：`Tushare token source: env` 应该显示

## 📚 参考资源

- [Smithery 官方文档](https://smithery.ai/docs)
- [MCP 协议规范](https://spec.modelcontextprotocol.io/)
- [FinanceMCP GitHub 仓库](https://github.com/guangxiangdebizi/FinanceMCP)
- [Tushare Pro 文档](https://tushare.pro/document/2)

## 💡 最佳实践

1. **版本管理**：使用语义化版本号（如 4.4.0）
2. **环境隔离**：不要在代码中硬编码 Token
3. **监控日志**：定期检查 Smithery 控制台的日志
4. **资源限制**：注意 Tushare API 的调用频率限制
5. **安全性**：使用 HTTPS 端点，不要公开分享 Token

## ✅ 检查清单

部署前确认：
- [ ] 代码已推送到 GitHub
- [ ] `smithery.yaml` 配置正确（type: http）
- [ ] `Dockerfile` 暴露了 3000 端口
- [ ] 已获取 Tushare Token
- [ ] 本地 Docker 测试通过
- [ ] README.md 文档已更新

---

**版本**: 4.4.0  
**最后更新**: 2025-10-16  
**维护者**: Xingyu_Chen (guangxiangdebizi@gmail.com)

