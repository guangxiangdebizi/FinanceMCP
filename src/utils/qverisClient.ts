import { randomUUID } from 'node:crypto';
import { QVERIS_CONFIG } from '../config.js';

export interface QverisCapability {
  tool_id: string;
  name?: string;
  description?: string;
  provider_name?: string;
  params?: Array<Record<string, unknown>>;
  one_of_required?: unknown;
  examples?: Record<string, unknown>;
  expected_cost?: unknown;
  billing_rule?: unknown;
  stats?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QverisSearchResponse {
  query?: string;
  search_id: string;
  total: number;
  results: QverisCapability[];
  elapsed_time_ms?: number;
  remaining_credits?: number | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export interface QverisExecuteResponse {
  execution_id?: string;
  result?: unknown;
  success?: boolean;
  error_message?: string | null;
  execution_outcome?: unknown;
  billing?: unknown;
  cost?: unknown;
  remaining_credits?: number | null;
  [key: string]: unknown;
}

type RequestOptions = {
  timeoutMs: number;
  query?: Record<string, string>;
};

function requireApiKey(): string {
  const apiKey = QVERIS_CONFIG.API_KEY.trim();
  if (!apiKey) {
    throw new Error(
      'Qveris 未启用：请配置 QVERIS_API_KEY，或在 HTTP 请求中传入 X-Qveris-Api-Key。' +
      'Global: https://qveris.ai/account?page=api-keys；中国区: https://qveris.cn/account?page=api-keys'
    );
  }
  return apiKey;
}

function describeApiError(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    const message = body.error_message ?? body.message ?? body.error ?? body.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (status === 401) return 'API Key 无效或已过期';
  if (status === 402) return 'credits 不足';
  if (status === 429) return '请求过于频繁';
  return `HTTP ${status}`;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'status' in payload) {
    const envelope = payload as { status?: unknown; status_code?: unknown; message?: unknown; data?: unknown };
    if (envelope.status !== 'success') {
      const message = typeof envelope.message === 'string' ? envelope.message : 'Qveris 返回失败状态';
      throw new Error(message);
    }
    if ('data' in envelope) return envelope.data as T;
  }
  return payload as T;
}

async function requestQveris<T>(
  path: string,
  body: Record<string, unknown>,
  options: RequestOptions
): Promise<T> {
  const url = new URL(`${QVERIS_CONFIG.BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requireApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Qveris 返回了无效 JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`Qveris 请求失败：${describeApiError(response.status, payload)}`);
    }
    return unwrapEnvelope<T>(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Qveris 请求超时（${options.timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createQverisSessionId(): string {
  return `financemcp_${randomUUID()}`;
}

export async function discoverQverisCapabilities(args: {
  query: string;
  limit: number;
  sessionId: string;
}): Promise<QverisSearchResponse> {
  return requestQveris<QverisSearchResponse>('/search', {
    query: args.query,
    limit: args.limit,
    session_id: args.sessionId,
  }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
}

export async function inspectQverisCapabilities(args: {
  toolIds: string[];
  searchId?: string;
  sessionId: string;
}): Promise<QverisSearchResponse> {
  return requestQveris<QverisSearchResponse>('/tools/by-ids', {
    tool_ids: args.toolIds,
    ...(args.searchId ? { search_id: args.searchId } : {}),
    session_id: args.sessionId,
  }, { timeoutMs: QVERIS_CONFIG.DISCOVER_TIMEOUT });
}

export async function callQverisCapability(args: {
  toolId: string;
  searchId: string;
  parameters: Record<string, unknown>;
  sessionId: string;
  maxResponseSize: number;
  model?: string;
}): Promise<QverisExecuteResponse> {
  return requestQveris<QverisExecuteResponse>('/tools/execute', {
    search_id: args.searchId,
    session_id: args.sessionId,
    ...(args.model ? { model: args.model } : {}),
    parameters: args.parameters,
    max_response_size: args.maxResponseSize,
  }, {
    timeoutMs: QVERIS_CONFIG.EXECUTE_TIMEOUT,
    query: { tool_id: args.toolId },
  });
}
