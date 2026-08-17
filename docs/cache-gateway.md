# Finance Cache Gateway

`finance-cache-gateway` 是与 FinanceMCP 工具服务器并列运行的模型网关。Trae、Cursor、Claude Code 和 Codex 把自定义模型的 API Base URL 指向同一个网关后，缓存与对话 lineage 不再绑定单个 Agent 进程。

## 能力边界

- **真实 KV/Prompt Cache**：仅在同一上游模型部署、同一凭证范围和精确前缀下，由 OpenAI、Anthropic、DeepSeek 或自托管推理服务复用。
- **跨 Agent Handoff**：Agent system prompt、工具定义或模型不同而无法命中 KV 时，网关恢复同一项目最近的对话 lineage。
- **不做语义 KV 复用**：语义相似度不会用于注入其他请求的 KV 张量。
- **首版流式策略**：入站与上游协议相同时原生透传 SSE；跨协议时先完成上游请求，再转换成兼容 SSE。响应头 `X-FMC-Stream-Mode: buffered-translation` 会标记这种情况。

托管模型 API 不允许客户端导出原始 KV 张量，因此本网关不会伪造“跨模型 KV”。它做两件可验证的事：为同一 context 生成稳定的 provider cache routing key/cache breakpoint，让仍满足精确前缀约束的请求命中供应商缓存；当前缀已被不同 Agent 环境改变时，改用明确标记为不可信数据的 lineage handoff 保持任务连续性。

请求链路：

```text
Trae / Cursor / Claude Code / Codex
  -> OpenAI 或 Anthropic 兼容入口
  -> Gateway Key 映射 tenant + workspace
  -> context 保守匹配 + model fingerprint 隔离
  -> provider 原生缓存策略
  -> 实际模型 API
```

## 快速开始

构建并生成配置：

```powershell
npm run build
node build/cacheCli.js init `
  --model gpt-5.6-sol `
  --upstream-model gpt-5.6-sol `
  --upstream-base-url https://api.openai.com/v1 `
  --protocol openai-responses `
  --provider openai `
  --workspace FinanceMCP
```

命令会输出一次 Gateway API Key，并把其 SHA-256 摘要写入配置。然后设置：

```powershell
$env:CACHE_GATEWAY_CONFIG="$HOME/.finance-mcp/cache-gateway.json"
$env:CACHE_UPSTREAM_API_KEY="your-upstream-key"
npm run start:cache
```

默认监听 `http://127.0.0.1:3210`。

每个项目建议使用独立 Gateway Key。多个客户端要共享同一个项目 context，就使用映射到相同 `tenantId + workspaceId` 的 Key；不同项目不要共用一个 workspace。

## 标准模型接口

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
POST /v1/messages
POST /v1/messages/count_tokens
```

## Context 管理接口

所有接口使用和模型请求相同的 Gateway API Key：

```text
GET    /cache/v1/contexts
GET    /cache/v1/contexts/:id
POST   /cache/v1/contexts/:id/activate
POST   /cache/v1/contexts/:id/fork
DELETE /cache/v1/contexts/:id
GET    /cache/v1/metrics
GET    /metrics
```

模型响应包含：

```text
X-FMC-Context-Id
X-FMC-Context-Match
X-FMC-Handoff
X-FMC-Cache-Provider
X-FMC-Cache-Mode
```

需要显式继续某个分支时，发送 `X-FMC-Context-Id`。否则网关依次按客户端 session、消息 ancestry、当前 active context 和唯一最近 context 做保守匹配。

也可把 `fmc_context_id` 放在请求 `metadata` 中；网关读取后会在转发前移除该扩展字段。存在多个候选分支且证据不足时，网关会新建 context，而不是冒险串线。

Provider 策略：

| Provider | 上游协议 | 行为 |
|---|---|---|
| `openai` | `openai-responses` / `openai-chat` | 稳定 `prompt_cache_key`；`explicit` 模式增加 cache breakpoint 与 30m TTL |
| `anthropic` | `anthropic` | 注入顶层 `cache_control`，支持默认 5m 或 `1h` |
| `deepseek` | `openai-chat` | 使用 DeepSeek 精确前缀自动缓存，并读取命中 token 指标 |
| `generic` / `none` | 任意兼容协议 | 协议转发，不声称存在原生 KV 命中 |

缓存是否实际命中以供应商 usage 和 `/cache/v1/metrics` 为准；稳定 routing key 本身不代表一定命中。供应商的最小可缓存 token 数、支持模型和计费规则仍然适用。

## 客户端配置

使用 CLI 输出对应配置：

```powershell
node build/cacheCli.js print-config --client codex --model gpt-5.6-sol --api-key YOUR_GATEWAY_KEY
node build/cacheCli.js print-config --client claude-code --model claude-opus --api-key YOUR_GATEWAY_KEY
node build/cacheCli.js print-config --client cursor --model gpt-5.6-sol --api-key YOUR_GATEWAY_KEY
node build/cacheCli.js print-config --client trae --model gpt-5.6-sol --api-key YOUR_GATEWAY_KEY
```

### Codex

Codex 使用 `/v1/responses`：

```toml
model = "gpt-5.6-sol"
model_provider = "finance_cache"

[model_providers.finance_cache]
name = "Finance Cache Gateway"
base_url = "http://127.0.0.1:3210/v1"
env_key = "FINANCE_CACHE_API_KEY"
wire_api = "responses"
```

### Claude Code

Claude Code 使用 `/v1/messages`：

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3210"
$env:ANTHROPIC_AUTH_TOKEN="YOUR_GATEWAY_KEY"
$env:ANTHROPIC_MODEL="claude-opus"
$env:ANTHROPIC_CUSTOM_MODEL_OPTION="claude-opus"
```

### Cursor / Trae

在自定义模型中配置：

```text
API format: OpenAI compatible
Base URL: http://127.0.0.1:3210/v1
API Key: YOUR_GATEWAY_KEY
Model: 配置文件中的公开模型 ID
```

## 多模型配置

配置文件示例：

```json
{
  "version": 1,
  "allowAnonymous": false,
  "clients": [
    {
      "tokenHash": "finance-cache hash-key 生成的 64 位十六进制摘要",
      "tenantId": "local",
      "workspaceId": "FinanceMCP"
    }
  ],
  "models": [
    {
      "id": "gpt-5.6-sol",
      "upstream": {
        "protocol": "openai-responses",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-5.6-sol",
        "apiKeyEnv": "OPENAI_API_KEY"
      },
      "cache": {
        "provider": "openai",
        "enabled": true,
        "mode": "explicit",
        "ttl": "30m"
      }
    },
    {
      "id": "claude-opus",
      "upstream": {
        "protocol": "anthropic",
        "baseUrl": "https://api.anthropic.com/v1",
        "model": "claude-opus-model-id",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      },
      "cache": {
        "provider": "anthropic",
        "enabled": true,
        "mode": "automatic",
        "ttl": "1h"
      }
    }
  ]
}
```

## 数据安全与回滚

- Gateway Key 只以摘要形式进入配置。
- 上游 API Key 只从指定环境变量读取。
- 对话状态使用 AES-256-GCM 加密后写入 `state.enc.json`。
- 未配置 `CACHE_GATEWAY_MASTER_KEY` 时，本地生成 `.master-key`；生产部署应通过 Secret Manager 注入主密钥。
- 删除 context 会同时删除关联事件与 session binding。
- 停止使用时，把客户端 Base URL 改回原供应商即可；现有 `/mcp` 完全不依赖本网关。

当前加密文件存储面向单实例本地部署，不支持多个网关进程同时写同一个 `dataDir`。远程或多实例部署应把状态层替换为带事务和租户隔离的数据库，并在反向代理层增加 TLS、限流和审计。跨协议转换会拒绝无法安全映射的内容类型（例如图片）；provider-specific 隐藏 reasoning 不会跨供应商重放。

原生缓存约束参考：[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)。
