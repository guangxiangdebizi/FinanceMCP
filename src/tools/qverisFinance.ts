import {
  callQverisCapability,
  createQverisSessionId,
  discoverQverisCapabilities,
  inspectQverisCapabilities,
  QverisCapability,
  QverisExecuteResponse,
  QverisSearchResponse,
} from '../utils/qverisClient.js';

type QverisFinanceArgs = {
  action: 'discover' | 'inspect' | 'call';
  query?: string;
  tool_ids?: string[];
  tool_id?: string;
  search_id?: string;
  parameters?: Record<string, unknown>;
  session_id?: string;
  limit?: number;
  max_response_size?: number;
  model?: string;
};

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function compactCapability(capability: QverisCapability): Record<string, unknown> {
  return {
    tool_id: capability.tool_id,
    name: capability.name,
    description: capability.description,
    provider_name: capability.provider_name,
    params: capability.params,
    one_of_required: capability.one_of_required,
    examples: capability.examples,
    expected_cost: capability.expected_cost,
    billing_rule: capability.billing_rule,
    stats: capability.stats,
  };
}

function compactSearch(response: QverisSearchResponse): Record<string, unknown> {
  return {
    source: 'Qveris',
    query: response.query,
    search_id: response.search_id,
    total: response.total,
    results: response.results.map(compactCapability),
    elapsed_time_ms: response.elapsed_time_ms,
    remaining_credits: response.remaining_credits,
    error_message: response.error_message,
  };
}

function compactExecution(response: QverisExecuteResponse): Record<string, unknown> {
  return {
    source: 'Qveris',
    ...response,
  };
}

function asToolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export const qverisFinance = {
  name: 'qveris_finance',
  description:
    '可选 Qveris 金融能力入口。先 discover 搜索行情、基本面、财务、宏观固收、新闻舆情、加密和另类数据；' +
    '再 inspect 获取当前参数 schema；最后 call 执行所选能力（可能消耗 Qveris credits）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['discover', 'inspect', 'call'],
        description: 'discover=免费搜索能力；inspect=免费读取当前 schema；call=执行能力，可能扣 credits',
      },
      query: {
        type: 'string',
        description: 'discover 使用的能力级自然语言查询，例如 "A股实时行情 API"、"美国公司利润表"、"中国 CPI 宏观数据"',
      },
      tool_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'inspect 使用；必须来自 discover 返回结果，最多 20 个',
      },
      tool_id: {
        type: 'string',
        description: 'call 使用；必须使用同一搜索链路中 discover/inspect 返回的完整 tool_id',
      },
      search_id: {
        type: 'string',
        description: 'discover 返回的 search_id；inspect 建议传入，call 必须传入',
      },
      parameters: {
        type: 'object',
        description: 'call 使用；严格按所选 tool_id 的最新 params schema 构造',
        additionalProperties: true,
      },
      session_id: {
        type: 'string',
        description: '可选追踪 ID；同一用户任务建议复用，不传则自动生成',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 20,
        description: 'discover 返回数量，默认 5，上限 20',
      },
      max_response_size: {
        type: 'number',
        minimum: 1024,
        maximum: 51200,
        description: 'call 最大响应字节数，默认 20480，上限 51200',
      },
      model: {
        type: 'string',
        description: 'call 可选；实际选择该工具或生成参数的模型名，用于 Qveris 追踪调用质量',
      },
    },
    required: ['action'],
  },
  async run(args: QverisFinanceArgs) {
    const sessionId = args.session_id?.trim() || createQverisSessionId();

    if (args.action === 'discover') {
      const query = args.query?.trim();
      if (!query) throw new Error('discover 必须提供非空 query');
      const response = await discoverQverisCapabilities({
        query,
        limit: clampInteger(args.limit, 5, 1, 20),
        sessionId,
      });
      return asToolResult({ ...compactSearch(response), session_id: sessionId });
    }

    if (args.action === 'inspect') {
      const toolIds = (args.tool_ids ?? []).map(value => value.trim()).filter(Boolean);
      if (toolIds.length === 0) throw new Error('inspect 必须提供 tool_ids');
      if (toolIds.length > 20) throw new Error('inspect 单次最多检查 20 个 tool_id');
      const response = await inspectQverisCapabilities({
        toolIds,
        searchId: args.search_id?.trim(),
        sessionId,
      });
      return asToolResult({ ...compactSearch(response), session_id: sessionId });
    }

    if (args.action === 'call') {
      const toolId = args.tool_id?.trim();
      const searchId = args.search_id?.trim();
      if (!toolId) throw new Error('call 必须提供 discover/inspect 返回的完整 tool_id');
      if (!searchId) throw new Error('call 必须提供返回该 tool_id 的 search_id');
      if (!args.parameters || typeof args.parameters !== 'object' || Array.isArray(args.parameters)) {
        throw new Error('call 必须提供符合当前工具 schema 的 parameters 对象');
      }
      const response = await callQverisCapability({
        toolId,
        searchId,
        parameters: args.parameters,
        sessionId,
        maxResponseSize: clampInteger(args.max_response_size, 20480, 1024, 51200),
        model: args.model?.trim() || undefined,
      });
      return asToolResult({ ...compactExecution(response), tool_id: toolId, search_id: searchId, session_id: sessionId });
    }

    throw new Error(`不支持的 Qveris action: ${String(args.action)}`);
  },
};
