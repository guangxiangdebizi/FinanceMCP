import {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalRole,
  CanonicalTool,
  CanonicalToolCall,
  GatewayProtocol,
  StoredMessage,
} from './types.js';
import { isRecord, nowIso, sha256, stableJson } from './utils.js';

export class UnsupportedGatewayFeatureError extends Error {
  constructor(public readonly features: string[]) {
    super(`Cross-protocol translation does not support: ${features.join(', ')}`);
    this.name = 'UnsupportedGatewayFeatureError';
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function contentBlocks(value: unknown, unsupported: Set<string>): CanonicalBlock[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return [];
    unsupported.add('non-array message content');
    return [{ type: 'opaque', sourceType: 'unknown', value }];
  }

  const blocks: CanonicalBlock[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      blocks.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) {
      unsupported.add('unknown content block');
      blocks.push({ type: 'opaque', sourceType: 'unknown', value: block });
      continue;
    }

    const type = asString(block.type) ?? 'unknown';
    if (['text', 'input_text', 'output_text'].includes(type) && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (['image', 'image_url', 'input_image'].includes(type)) {
      blocks.push({ type: 'image', source: block.source ?? block.image_url ?? block });
      unsupported.add('cross-protocol image');
      continue;
    }
    if (type === 'tool_use') {
      blocks.push({
        type: 'tool_call',
        id: asString(block.id) ?? `call_${sha256(stableJson(block)).slice(0, 16)}`,
        name: asString(block.name) ?? 'unknown_tool',
        arguments: block.input ?? {},
      });
      continue;
    }
    if (type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        toolCallId: asString(block.tool_use_id) ?? asString(block.call_id) ?? 'unknown_call',
        content: block.content ?? '',
        isError: block.is_error === true,
      });
      continue;
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      // Provider-specific hidden reasoning is never replayed across providers.
      continue;
    }

    unsupported.add(`content block ${type}`);
    blocks.push({ type: 'opaque', sourceType: type, value: block });
  }
  return blocks;
}

function parseTools(value: unknown): CanonicalTool[] {
  if (!Array.isArray(value)) return [];
  const tools: CanonicalTool[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === 'function' && isRecord(item.function)) {
      const name = asString(item.function.name);
      if (!name) continue;
      tools.push({
        name,
        description: asString(item.function.description),
        inputSchema: isRecord(item.function.parameters) ? item.function.parameters : {},
        strict: item.function.strict === true,
      });
      continue;
    }
    if (item.type === 'function') {
      const name = asString(item.name);
      if (!name) continue;
      tools.push({
        name,
        description: asString(item.description),
        inputSchema: isRecord(item.parameters) ? item.parameters : {},
        strict: item.strict === true,
      });
      continue;
    }
    const name = asString(item.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(item.description),
      inputSchema: isRecord(item.input_schema) ? item.input_schema : {},
      strict: item.strict === true,
    });
  }
  return tools;
}

function parseChatMessages(value: unknown, unsupported: Set<string>): CanonicalMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: CanonicalMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rawRole = asString(item.role) ?? 'user';
    const role: CanonicalRole = ['system', 'developer', 'user', 'assistant', 'tool'].includes(rawRole)
      ? rawRole as CanonicalRole
      : 'user';

    const blocks = role === 'tool'
      ? [{
          type: 'tool_result' as const,
          toolCallId: asString(item.tool_call_id) ?? 'unknown_call',
          content: item.content ?? '',
        }]
      : contentBlocks(item.content, unsupported);

    if (role === 'assistant' && Array.isArray(item.tool_calls)) {
      for (const rawCall of item.tool_calls) {
        if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
        blocks.push({
          type: 'tool_call',
          id: asString(rawCall.id) ?? `call_${sha256(stableJson(rawCall)).slice(0, 16)}`,
          name: asString(rawCall.function.name) ?? 'unknown_tool',
          arguments: parseJsonArguments(rawCall.function.arguments),
        });
      }
    }
    messages.push({ role, content: blocks, name: asString(item.name) });
  }
  return messages;
}

function parseResponsesInput(value: unknown, unsupported: Set<string>): CanonicalMessage[] {
  if (typeof value === 'string') return [{ role: 'user', content: [{ type: 'text', text: value }] }];
  if (!Array.isArray(value)) return [];

  const messages: CanonicalMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === 'message' || typeof item.role === 'string') {
      const rawRole = asString(item.role) ?? 'user';
      const role: CanonicalRole = ['system', 'developer', 'user', 'assistant'].includes(rawRole)
        ? rawRole as CanonicalRole
        : 'user';
      messages.push({ role, content: contentBlocks(item.content, unsupported) });
      continue;
    }
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_call',
          id: asString(item.call_id) ?? asString(item.id) ?? `call_${sha256(stableJson(item)).slice(0, 16)}`,
          name: asString(item.name) ?? 'unknown_tool',
          arguments: parseJsonArguments(item.arguments),
        }],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool_result',
          toolCallId: asString(item.call_id) ?? 'unknown_call',
          content: item.output ?? '',
        }],
      });
      continue;
    }
    unsupported.add(`Responses input item ${String(item.type ?? 'unknown')}`);
    messages.push({
      role: 'user',
      content: [{ type: 'opaque', sourceType: String(item.type ?? 'unknown'), value: item }],
    });
  }
  return messages;
}

function parseSystem(value: unknown, unsupported: Set<string>): CanonicalMessage[] {
  const blocks = contentBlocks(value, unsupported);
  return blocks.length ? [{ role: 'system', content: blocks }] : [];
}

export function parseCanonicalRequest(protocol: GatewayProtocol, body: Record<string, unknown>): CanonicalRequest {
  const unsupported = new Set<string>();
  const requestedModel = asString(body.model)?.trim();
  if (!requestedModel) throw new Error('Request body must include a non-empty model');

  let messages: CanonicalMessage[];
  if (protocol === 'openai-chat') {
    messages = parseChatMessages(body.messages, unsupported);
  } else if (protocol === 'openai-responses') {
    messages = [
      ...parseSystem(body.instructions, unsupported),
      ...parseResponsesInput(body.input, unsupported),
    ];
  } else {
    messages = [
      ...parseSystem(body.system, unsupported),
      ...parseChatMessages(body.messages, unsupported),
    ];
  }

  return {
    sourceProtocol: protocol,
    requestedModel,
    messages,
    tools: parseTools(body.tools),
    stream: body.stream === true,
    maxOutputTokens: asNumber(body.max_output_tokens)
      ?? asNumber(body.max_completion_tokens)
      ?? asNumber(body.max_tokens),
    temperature: asNumber(body.temperature),
    topP: asNumber(body.top_p),
    toolChoice: body.tool_choice,
    reasoning: body.reasoning ?? body.thinking,
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    unsupportedFeatures: [...unsupported],
  };
}

function ensureTranslatable(request: CanonicalRequest): void {
  if (request.unsupportedFeatures.length) {
    throw new UnsupportedGatewayFeatureError([...new Set(request.unsupportedFeatures)]);
  }
}

function textFromBlocks(blocks: CanonicalBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
}

function jsonArguments(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

function renderToolChoice(source: GatewayProtocol, target: GatewayProtocol, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (target === 'anthropic') {
    if (typeof value === 'string') {
      if (value === 'required') return { type: 'any' };
      if (['auto', 'none'].includes(value)) return { type: value };
    }
    if (isRecord(value) && value.type === 'function' && isRecord(value.function)
      && typeof value.function.name === 'string') {
      return { type: 'tool', name: value.function.name };
    }
    return source === 'anthropic' ? value : undefined;
  }

  if (source === 'anthropic' && isRecord(value)) {
    if (value.type === 'auto') return 'auto';
    if (value.type === 'any') return 'required';
    if (value.type === 'none') return 'none';
    if (value.type === 'tool' && typeof value.name === 'string') {
      return { type: 'function', function: { name: value.name } };
    }
  }
  return value;
}

function renderChatMessages(messages: CanonicalMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const text = textFromBlocks(message.content);
    const calls = message.content.filter(block => block.type === 'tool_call') as Extract<CanonicalBlock, { type: 'tool_call' }>[];
    const toolResults = message.content.filter(block => block.type === 'tool_result') as Extract<CanonicalBlock, { type: 'tool_result' }>[];

    if (toolResults.length) {
      for (const toolResult of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: toolResult.toolCallId,
          content: typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
        });
      }
      continue;
    }

    const rendered: Record<string, unknown> = { role: message.role, content: text || null };
    if (message.name) rendered.name = message.name;
    if (calls.length) {
      rendered.tool_calls = calls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: jsonArguments(call.arguments) },
      }));
    }
    result.push(rendered);
  }
  return result;
}

function renderResponsesInput(messages: CanonicalMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const text = textFromBlocks(message.content);
    if (text) result.push({ role: message.role === 'tool' ? 'user' : message.role, content: text });
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        result.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: jsonArguments(block.arguments),
        });
      } else if (block.type === 'tool_result') {
        result.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
  }
  return result;
}

function appendAnthropicMessage(
  result: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>,
  role: 'user' | 'assistant',
  content: Array<Record<string, unknown>>
): void {
  if (!content.length) return;
  const previous = result[result.length - 1];
  if (previous?.role === role) previous.content.push(...content);
  else result.push({ role, content });
}

function renderAnthropicMessages(messages: CanonicalMessage[]): {
  system: Array<Record<string, unknown>>;
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>;
} {
  const system: Array<Record<string, unknown>> = [];
  const result: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    const content: Array<Record<string, unknown>> = [];
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_call') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments ?? {} });
      } else if (block.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }

    if (message.role === 'system' || message.role === 'developer') {
      system.push(...content.filter(block => block.type === 'text'));
    } else if (message.role === 'assistant') {
      appendAnthropicMessage(result, 'assistant', content);
    } else {
      appendAnthropicMessage(result, 'user', content);
    }
  }
  return { system, messages: result };
}

export function renderCanonicalRequest(
  request: CanonicalRequest,
  targetProtocol: GatewayProtocol,
  upstreamModel: string,
  defaultMaxOutputTokens: number
): Record<string, unknown> {
  ensureTranslatable(request);
  const renderedToolChoice = renderToolChoice(request.sourceProtocol, targetProtocol, request.toolChoice);
  const common: Record<string, unknown> = {
    model: upstreamModel,
    stream: false,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
  };

  if (targetProtocol === 'openai-chat') {
    return {
      ...common,
      messages: renderChatMessages(request.messages),
      ...(request.tools.length ? {
        tools: request.tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchema,
            ...(tool.strict ? { strict: true } : {}),
          },
        })),
      } : {}),
      ...(renderedToolChoice !== undefined ? { tool_choice: renderedToolChoice } : {}),
      max_completion_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    };
  }

  if (targetProtocol === 'openai-responses') {
    return {
      ...common,
      input: renderResponsesInput(request.messages),
      ...(request.tools.length ? {
        tools: request.tools.map(tool => ({
          type: 'function',
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.inputSchema,
          ...(tool.strict ? { strict: true } : {}),
        })),
      } : {}),
      ...(renderedToolChoice !== undefined ? { tool_choice: renderedToolChoice } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      max_output_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    };
  }

  const anthropic = renderAnthropicMessages(request.messages);
  return {
    ...common,
    system: anthropic.system,
    messages: anthropic.messages,
    ...(request.tools.length ? {
      tools: request.tools.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
      })),
    } : {}),
    ...(renderedToolChoice !== undefined ? { tool_choice: renderedToolChoice } : {}),
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
  };
}

export function cloneRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

export function injectHandoffIntoBody(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  handoffText: string
): Record<string, unknown> {
  const cloned = cloneRequestBody(body);
  if (protocol === 'openai-chat') {
    const messages = Array.isArray(cloned.messages) ? [...cloned.messages] : [];
    const index = messages.findIndex(item => isRecord(item) && !['system', 'developer'].includes(String(item.role)));
    const insertAt = index < 0 ? messages.length : index;
    messages.splice(insertAt, 0, { role: 'developer', content: handoffText });
    cloned.messages = messages;
    return cloned;
  }

  if (protocol === 'openai-responses') {
    const input = typeof cloned.input === 'string'
      ? [{ role: 'user', content: cloned.input }]
      : Array.isArray(cloned.input) ? [...cloned.input] : [];
    input.unshift({ role: 'developer', content: handoffText });
    cloned.input = input;
    return cloned;
  }

  const system = typeof cloned.system === 'string'
    ? [{ type: 'text', text: cloned.system }]
    : Array.isArray(cloned.system) ? [...cloned.system] : [];
  system.push({ type: 'text', text: handoffText });
  cloned.system = system;
  return cloned;
}

export function canonicalPrefixDigest(request: CanonicalRequest, modelFingerprint: string): string {
  return sha256(stableJson({
    modelFingerprint,
    messages: request.messages,
    tools: request.tools,
    temperature: request.temperature,
    topP: request.topP,
    toolChoice: request.toolChoice,
    reasoning: request.reasoning,
  }));
}

export function canonicalRequestDigest(request: CanonicalRequest, modelFingerprint: string): string {
  return sha256(stableJson({ modelFingerprint, request }));
}

export function canonicalMessageDigests(messages: CanonicalMessage[]): string[] {
  return messages.map(message => sha256(stableJson(message)));
}

export function visibleStoredMessages(messages: CanonicalMessage[]): StoredMessage[] {
  const createdAt = nowIso();
  return messages.flatMap(message => {
    const parts: string[] = [];
    const plainText = textFromBlocks(message.content).trim();
    if (plainText) parts.push(plainText);
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        parts.push(`[tool_call ${block.name} id=${block.id}] ${jsonArguments(block.arguments)}`);
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        parts.push(`[tool_result id=${block.toolCallId}${block.isError ? ' error=true' : ''}] ${content}`);
      }
    }
    const text = parts.join('\n').trim().slice(0, 50_000);
    if (!text || message.role === 'system' || message.role === 'developer') return [];
    return [{
      role: message.role,
      text,
      digest: sha256(stableJson({ role: message.role, text })),
      createdAt,
    }];
  });
}

export function responseStoredMessages(response: CanonicalResponse): StoredMessage[] {
  const parts: string[] = [];
  if (response.text.trim()) parts.push(response.text.trim());
  if (response.toolCalls.length) {
    parts.push(response.toolCalls.map(call =>
      `[tool_call ${call.name} id=${call.id}] ${typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)}`
    ).join('\n'));
  }
  if (!parts.length) return [];
  const text = parts.join('\n');
  return [{
    role: 'assistant',
    text,
    digest: sha256(stableJson({ role: 'assistant', text })),
    createdAt: nowIso(),
  }];
}

function normalizeStopReason(value: unknown): CanonicalResponse['stopReason'] {
  if (['tool_calls', 'tool_use'].includes(String(value))) return 'tool_calls';
  if (['length', 'max_tokens'].includes(String(value))) return 'length';
  if (String(value) === 'content_filter') return 'content_filter';
  if (['stop', 'end_turn', 'completed'].includes(String(value))) return 'stop';
  return 'unknown';
}

function parseChatResponse(payload: Record<string, unknown>): CanonicalResponse {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls: CanonicalToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const item of message.tool_calls) {
      if (!isRecord(item) || !isRecord(item.function)) continue;
      toolCalls.push({
        id: asString(item.id) ?? `call_${toolCalls.length}`,
        name: asString(item.function.name) ?? 'unknown_tool',
        arguments: parseJsonArguments(item.function.arguments),
      });
    }
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    id: asString(payload.id) ?? `chatcmpl_${sha256(stableJson(payload)).slice(0, 24)}`,
    model: asString(payload.model) ?? 'unknown',
    text: asString(message.content) ?? '',
    toolCalls,
    stopReason: normalizeStopReason(choice.finish_reason),
    usage: {
      inputTokens: asNumber(usage.prompt_tokens),
      outputTokens: asNumber(usage.completion_tokens),
      cachedInputTokens: asNumber(details.cached_tokens),
      ...(asNumber(details.cached_tokens) === undefined && asNumber(usage.prompt_cache_hit_tokens) !== undefined
        ? { cachedInputTokens: asNumber(usage.prompt_cache_hit_tokens) }
        : {}),
      cacheWriteTokens: asNumber(usage.cache_write_tokens),
    },
    raw: payload,
  };
}

function parseResponsesResponse(payload: Record<string, unknown>): CanonicalResponse {
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isRecord(item)) continue;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (isRecord(block) && ['output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: asString(item.call_id) ?? asString(item.id) ?? `call_${toolCalls.length}`,
          name: asString(item.name) ?? 'unknown_tool',
          arguments: parseJsonArguments(item.arguments),
        });
      }
    }
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    id: asString(payload.id) ?? `resp_${sha256(stableJson(payload)).slice(0, 24)}`,
    model: asString(payload.model) ?? 'unknown',
    text: textParts.join(''),
    toolCalls,
    stopReason: toolCalls.length ? 'tool_calls' : normalizeStopReason(payload.status),
    usage: {
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedInputTokens: asNumber(details.cached_tokens),
      cacheWriteTokens: asNumber(usage.cache_write_tokens),
    },
    raw: payload,
  };
}

function parseAnthropicResponse(payload: Record<string, unknown>): CanonicalResponse {
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  if (Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: asString(block.id) ?? `call_${toolCalls.length}`,
          name: asString(block.name) ?? 'unknown_tool',
          arguments: block.input ?? {},
        });
      }
    }
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    id: asString(payload.id) ?? `msg_${sha256(stableJson(payload)).slice(0, 24)}`,
    model: asString(payload.model) ?? 'unknown',
    text: textParts.join(''),
    toolCalls,
    stopReason: normalizeStopReason(payload.stop_reason),
    usage: {
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedInputTokens: asNumber(usage.cache_read_input_tokens),
      cacheWriteTokens: asNumber(usage.cache_creation_input_tokens),
    },
    raw: payload,
  };
}

export function parseCanonicalResponse(protocol: GatewayProtocol, payload: unknown): CanonicalResponse {
  if (!isRecord(payload)) throw new Error('Upstream returned a non-object JSON response');
  if (protocol === 'openai-chat') return parseChatResponse(payload);
  if (protocol === 'openai-responses') return parseResponsesResponse(payload);
  return parseAnthropicResponse(payload);
}
