export type GatewayProtocol = 'openai-responses' | 'openai-chat' | 'anthropic';

export type CacheProvider = 'openai' | 'anthropic' | 'deepseek' | 'generic' | 'none';

export interface GatewayClientConfig {
  tokenHash: string;
  tenantId: string;
  workspaceId: string;
  label?: string;
}

export interface GatewayCachePolicy {
  provider: CacheProvider;
  enabled?: boolean;
  mode?: 'automatic' | 'explicit';
  ttl?: '5m' | '1h' | '30m';
}

export interface GatewayHandoffPolicy {
  enabled?: boolean;
  autoResume?: boolean;
  resumeWindowMinutes?: number;
  maxMessages?: number;
  maxCharacters?: number;
}

export interface GatewayUpstreamConfig {
  protocol: GatewayProtocol;
  baseUrl: string;
  model?: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  headersEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface GatewayModelRoute {
  id: string;
  aliases?: string[];
  displayName?: string;
  upstream: GatewayUpstreamConfig;
  cache?: GatewayCachePolicy;
  handoff?: GatewayHandoffPolicy;
  allowCrossProtocol?: boolean;
  defaultMaxOutputTokens?: number;
}

export interface GatewayFileConfig {
  version: 1;
  clients?: GatewayClientConfig[];
  models?: GatewayModelRoute[];
  allowAnonymous?: boolean;
}

export interface ResolvedGatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  configPath?: string;
  clients: GatewayClientConfig[];
  models: GatewayModelRoute[];
  allowAnonymous: boolean;
  maxRequestBytes: number;
}

export type CanonicalRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface CanonicalTextBlock {
  type: 'text';
  text: string;
}

export interface CanonicalImageBlock {
  type: 'image';
  source: unknown;
}

export interface CanonicalToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: unknown;
}

export interface CanonicalToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: unknown;
  isError?: boolean;
}

export interface CanonicalOpaqueBlock {
  type: 'opaque';
  sourceType: string;
  value: unknown;
}

export type CanonicalBlock =
  | CanonicalTextBlock
  | CanonicalImageBlock
  | CanonicalToolCallBlock
  | CanonicalToolResultBlock
  | CanonicalOpaqueBlock;

export interface CanonicalMessage {
  role: CanonicalRole;
  content: CanonicalBlock[];
  name?: string;
}

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface CanonicalRequest {
  sourceProtocol: GatewayProtocol;
  requestedModel: string;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  stream: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: unknown;
  reasoning?: unknown;
  metadata?: Record<string, unknown>;
  unsupportedFeatures: string[];
}

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  text: string;
  toolCalls: CanonicalToolCall[];
  stopReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';
  usage: CanonicalUsage;
  raw?: unknown;
}

export interface GatewayIdentity {
  tenantId: string;
  workspaceId: string;
  label?: string;
  anonymous: boolean;
}

export interface StoredMessage {
  role: CanonicalRole;
  text: string;
  digest: string;
  createdAt: string;
}

export interface StoredContext {
  id: string;
  tenantId: string;
  workspaceId: string;
  modelFingerprint: string;
  createdAt: string;
  updatedAt: string;
  parentContextId?: string;
  active: boolean;
  clientKinds: string[];
  messageDigests: string[];
  messages: StoredMessage[];
}

export interface StoredRequestEvent {
  id: string;
  contextId: string;
  createdAt: string;
  protocol: GatewayProtocol;
  clientKind: string;
  requestDigest: string;
  prefixDigest: string;
  cacheProvider: CacheProvider;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  handoffInjected: boolean;
  matchMode: ContextMatchMode;
  upstreamStatus?: number;
  durationMs?: number;
  error?: string;
}

export interface GatewayPersistentState {
  version: 1;
  contexts: StoredContext[];
  events: StoredRequestEvent[];
  sessionBindings: Record<string, string>;
  activeContexts: Record<string, string>;
}

export type ContextMatchMode =
  | 'explicit'
  | 'active'
  | 'client-session'
  | 'message-ancestry'
  | 'recent-handoff'
  | 'new';

export interface ContextResolution {
  context: StoredContext;
  matchMode: ContextMatchMode;
  handoffInjected: boolean;
  handoffText?: string;
}

export interface GatewayMetricsSnapshot {
  requests: number;
  errors: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  handoffs: number;
  contexts: number;
}
