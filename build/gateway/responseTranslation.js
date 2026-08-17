import { randomUUID } from 'node:crypto';
import { isRecord } from './utils.js';
import { parseCanonicalResponse } from './canonical.js';
function createdUnix() {
    return Math.floor(Date.now() / 1000);
}
function jsonArguments(value) {
    return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}
function openAiFinishReason(response) {
    if (response.stopReason === 'tool_calls')
        return 'tool_calls';
    if (response.stopReason === 'length')
        return 'length';
    if (response.stopReason === 'content_filter')
        return 'content_filter';
    return 'stop';
}
function anthropicStopReason(response) {
    if (response.stopReason === 'tool_calls')
        return 'tool_use';
    if (response.stopReason === 'length')
        return 'max_tokens';
    return 'end_turn';
}
export function renderCanonicalResponse(protocol, response, publicModel) {
    if (protocol === 'openai-chat') {
        return {
            id: response.id.startsWith('chatcmpl_') ? response.id : `chatcmpl_${response.id}`,
            object: 'chat.completion',
            created: createdUnix(),
            model: publicModel,
            choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: response.text || null,
                        ...(response.toolCalls.length ? {
                            tool_calls: response.toolCalls.map(call => ({
                                id: call.id,
                                type: 'function',
                                function: { name: call.name, arguments: jsonArguments(call.arguments) },
                            })),
                        } : {}),
                    },
                    finish_reason: openAiFinishReason(response),
                }],
            usage: {
                prompt_tokens: response.usage.inputTokens ?? 0,
                completion_tokens: response.usage.outputTokens ?? 0,
                total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
                prompt_tokens_details: { cached_tokens: response.usage.cachedInputTokens ?? 0 },
                ...(response.usage.cacheWriteTokens !== undefined ? { cache_write_tokens: response.usage.cacheWriteTokens } : {}),
            },
        };
    }
    if (protocol === 'openai-responses') {
        const output = [];
        if (response.text) {
            output.push({
                id: `msg_${randomUUID().replace(/-/g, '')}`,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: response.text, annotations: [] }],
            });
        }
        for (const call of response.toolCalls) {
            output.push({
                id: `fc_${randomUUID().replace(/-/g, '')}`,
                type: 'function_call',
                status: 'completed',
                call_id: call.id,
                name: call.name,
                arguments: jsonArguments(call.arguments),
            });
        }
        return {
            id: response.id.startsWith('resp_') ? response.id : `resp_${response.id}`,
            object: 'response',
            created_at: createdUnix(),
            status: 'completed',
            model: publicModel,
            output,
            parallel_tool_calls: true,
            error: null,
            incomplete_details: null,
            usage: {
                input_tokens: response.usage.inputTokens ?? 0,
                output_tokens: response.usage.outputTokens ?? 0,
                total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
                input_tokens_details: { cached_tokens: response.usage.cachedInputTokens ?? 0 },
                ...(response.usage.cacheWriteTokens !== undefined ? { cache_write_tokens: response.usage.cacheWriteTokens } : {}),
            },
        };
    }
    return {
        id: response.id.startsWith('msg_') ? response.id : `msg_${response.id}`,
        type: 'message',
        role: 'assistant',
        model: publicModel,
        content: [
            ...(response.text ? [{ type: 'text', text: response.text }] : []),
            ...response.toolCalls.map(call => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments ?? {},
            })),
        ],
        stop_reason: anthropicStopReason(response),
        stop_sequence: null,
        usage: {
            input_tokens: response.usage.inputTokens ?? 0,
            output_tokens: response.usage.outputTokens ?? 0,
            cache_read_input_tokens: response.usage.cachedInputTokens ?? 0,
            cache_creation_input_tokens: response.usage.cacheWriteTokens ?? 0,
        },
    };
}
function sseData(value) {
    return `data: ${JSON.stringify(value)}\n\n`;
}
function sseEvent(name, value) {
    return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}
function renderChatStream(response, publicModel) {
    const id = response.id.startsWith('chatcmpl_') ? response.id : `chatcmpl_${response.id}`;
    const base = { id, object: 'chat.completion.chunk', created: createdUnix(), model: publicModel };
    let output = sseData({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (response.text) {
        output += sseData({ ...base, choices: [{ index: 0, delta: { content: response.text }, finish_reason: null }] });
    }
    if (response.toolCalls.length) {
        output += sseData({
            ...base,
            choices: [{
                    index: 0,
                    delta: {
                        tool_calls: response.toolCalls.map((call, index) => ({
                            index,
                            id: call.id,
                            type: 'function',
                            function: { name: call.name, arguments: jsonArguments(call.arguments) },
                        })),
                    },
                    finish_reason: null,
                }],
        });
    }
    output += sseData({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: openAiFinishReason(response) }],
        usage: {
            prompt_tokens: response.usage.inputTokens ?? 0,
            completion_tokens: response.usage.outputTokens ?? 0,
            total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: response.usage.cachedInputTokens ?? 0 },
        },
    });
    output += 'data: [DONE]\n\n';
    return output;
}
function renderResponsesStream(response, publicModel) {
    const rendered = renderCanonicalResponse('openai-responses', response, publicModel);
    const responseId = String(rendered.id);
    const inProgress = { ...rendered, status: 'in_progress', output: [] };
    let sequence = 0;
    let output = sseEvent('response.created', { type: 'response.created', sequence_number: sequence++, response: inProgress });
    const items = Array.isArray(rendered.output) ? rendered.output : [];
    let outputIndex = 0;
    for (const rawItem of items) {
        if (!isRecord(rawItem))
            continue;
        const item = { ...rawItem, status: 'in_progress' };
        output += sseEvent('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: sequence++, output_index: outputIndex, item,
        });
        if (rawItem.type === 'message') {
            const content = Array.isArray(rawItem.content) ? rawItem.content : [];
            const part = isRecord(content[0]) ? content[0] : { type: 'output_text', text: '', annotations: [] };
            output += sseEvent('response.content_part.added', {
                type: 'response.content_part.added', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, content_index: 0, part: { ...part, text: '' },
            });
            output += sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, content_index: 0, delta: String(part.text ?? ''), logprobs: [],
            });
            output += sseEvent('response.output_text.done', {
                type: 'response.output_text.done', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, content_index: 0, text: String(part.text ?? ''), logprobs: [],
            });
            output += sseEvent('response.content_part.done', {
                type: 'response.content_part.done', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, content_index: 0, part,
            });
        }
        else if (rawItem.type === 'function_call') {
            output += sseEvent('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, delta: String(rawItem.arguments ?? ''),
            });
            output += sseEvent('response.function_call_arguments.done', {
                type: 'response.function_call_arguments.done', sequence_number: sequence++, item_id: rawItem.id,
                output_index: outputIndex, arguments: String(rawItem.arguments ?? ''),
            });
        }
        output += sseEvent('response.output_item.done', {
            type: 'response.output_item.done', sequence_number: sequence++, output_index: outputIndex,
            item: rawItem,
        });
        outputIndex += 1;
    }
    output += sseEvent('response.completed', {
        type: 'response.completed', sequence_number: sequence++, response: { ...rendered, id: responseId },
    });
    return output;
}
function renderAnthropicStream(response, publicModel) {
    const rendered = renderCanonicalResponse('anthropic', response, publicModel);
    const content = Array.isArray(rendered.content) ? rendered.content : [];
    let output = sseEvent('message_start', {
        type: 'message_start',
        message: { ...rendered, content: [], stop_reason: null, stop_sequence: null, usage: {
                input_tokens: response.usage.inputTokens ?? 0,
                output_tokens: 0,
                cache_read_input_tokens: response.usage.cachedInputTokens ?? 0,
                cache_creation_input_tokens: response.usage.cacheWriteTokens ?? 0,
            } },
    });
    content.forEach((rawBlock, index) => {
        if (!isRecord(rawBlock))
            return;
        if (rawBlock.type === 'text') {
            output += sseEvent('content_block_start', {
                type: 'content_block_start', index, content_block: { type: 'text', text: '' },
            });
            output += sseEvent('content_block_delta', {
                type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(rawBlock.text ?? '') },
            });
        }
        else if (rawBlock.type === 'tool_use') {
            output += sseEvent('content_block_start', {
                type: 'content_block_start', index,
                content_block: { type: 'tool_use', id: rawBlock.id, name: rawBlock.name, input: {} },
            });
            output += sseEvent('content_block_delta', {
                type: 'content_block_delta', index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(rawBlock.input ?? {}) },
            });
        }
        output += sseEvent('content_block_stop', { type: 'content_block_stop', index });
    });
    output += sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: anthropicStopReason(response), stop_sequence: null },
        usage: { output_tokens: response.usage.outputTokens ?? 0 },
    });
    output += sseEvent('message_stop', { type: 'message_stop' });
    return output;
}
export function renderCanonicalStream(protocol, response, publicModel) {
    if (protocol === 'openai-chat')
        return renderChatStream(response, publicModel);
    if (protocol === 'openai-responses')
        return renderResponsesStream(response, publicModel);
    return renderAnthropicStream(response, publicModel);
}
function parseSseEvents(value) {
    const events = [];
    for (const rawEvent of value.replace(/\r\n/g, '\n').split('\n\n')) {
        if (!rawEvent.trim())
            continue;
        let event;
        const data = [];
        for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:'))
                event = line.slice(6).trim();
            else if (line.startsWith('data:'))
                data.push(line.slice(5).trimStart());
        }
        if (data.length)
            events.push({ event, data: data.join('\n') });
    }
    return events;
}
function safeJson(value) {
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function aggregateChatStream(events) {
    let id = '';
    let model = '';
    let text = '';
    let finish;
    let usage = {};
    const calls = new Map();
    for (const event of events) {
        if (event.data === '[DONE]')
            continue;
        const payload = safeJson(event.data);
        if (!payload)
            continue;
        id ||= String(payload.id ?? '');
        model ||= String(payload.model ?? '');
        if (isRecord(payload.usage))
            usage = payload.usage;
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = isRecord(choices[0]) ? choices[0] : undefined;
        if (!choice)
            continue;
        finish = choice.finish_reason ?? finish;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === 'string')
            text += delta.content;
        if (Array.isArray(delta.tool_calls)) {
            for (const rawCall of delta.tool_calls) {
                if (!isRecord(rawCall))
                    continue;
                const index = typeof rawCall.index === 'number' ? rawCall.index : calls.size;
                const existing = calls.get(index) ?? { id: '', name: '', arguments: '' };
                if (typeof rawCall.id === 'string')
                    existing.id = rawCall.id;
                if (isRecord(rawCall.function)) {
                    if (typeof rawCall.function.name === 'string')
                        existing.name += rawCall.function.name;
                    if (typeof rawCall.function.arguments === 'string')
                        existing.arguments += rawCall.function.arguments;
                }
                calls.set(index, existing);
            }
        }
    }
    if (!id && !text && !calls.size)
        return undefined;
    return parseCanonicalResponse('openai-chat', {
        id: id || `chatcmpl_${randomUUID()}`,
        model: model || 'unknown',
        choices: [{
                message: {
                    content: text,
                    tool_calls: [...calls.values()].map((call, index) => ({
                        id: call.id || `call_${index}`,
                        type: 'function',
                        function: { name: call.name || 'unknown_tool', arguments: call.arguments || '{}' },
                    })),
                },
                finish_reason: finish,
            }],
        usage,
    });
}
function aggregateResponsesStream(events) {
    let id = '';
    let model = '';
    let text = '';
    let usage = {};
    const calls = new Map();
    for (const event of events) {
        const payload = safeJson(event.data);
        if (!payload)
            continue;
        if (payload.type === 'response.completed' && isRecord(payload.response)) {
            return parseCanonicalResponse('openai-responses', payload.response);
        }
        if (payload.type === 'response.created' && isRecord(payload.response)) {
            id = String(payload.response.id ?? id);
            model = String(payload.response.model ?? model);
        }
        else if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
            text += payload.delta;
        }
        else if (payload.type === 'response.output_item.added' && isRecord(payload.item) && payload.item.type === 'function_call') {
            const key = String(payload.item.id ?? payload.item.call_id ?? calls.size);
            calls.set(key, {
                id: String(payload.item.call_id ?? payload.item.id ?? key),
                name: String(payload.item.name ?? 'unknown_tool'),
                arguments: String(payload.item.arguments ?? ''),
            });
        }
        else if (payload.type === 'response.function_call_arguments.delta') {
            const key = String(payload.item_id ?? '');
            const existing = calls.get(key);
            if (existing && typeof payload.delta === 'string')
                existing.arguments += payload.delta;
        }
        if (isRecord(payload.usage))
            usage = payload.usage;
    }
    if (!id && !text && !calls.size)
        return undefined;
    return parseCanonicalResponse('openai-responses', {
        id: id || `resp_${randomUUID()}`,
        model: model || 'unknown',
        status: 'completed',
        output: [
            ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
            ...[...calls.values()].map(call => ({
                type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments || '{}',
            })),
        ],
        usage,
    });
}
function aggregateAnthropicStream(events) {
    let id = '';
    let model = '';
    let text = '';
    let stopReason;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let cacheWriteTokens = 0;
    const blocks = new Map();
    for (const event of events) {
        const payload = safeJson(event.data);
        if (!payload)
            continue;
        if (payload.type === 'message_start' && isRecord(payload.message)) {
            id = String(payload.message.id ?? id);
            model = String(payload.message.model ?? model);
            if (isRecord(payload.message.usage)) {
                inputTokens = Number(payload.message.usage.input_tokens ?? 0);
                cachedTokens = Number(payload.message.usage.cache_read_input_tokens ?? 0);
                cacheWriteTokens = Number(payload.message.usage.cache_creation_input_tokens ?? 0);
            }
        }
        else if (payload.type === 'content_block_start' && isRecord(payload.content_block)) {
            const index = Number(payload.index ?? 0);
            blocks.set(index, {
                type: String(payload.content_block.type ?? 'unknown'),
                id: typeof payload.content_block.id === 'string' ? payload.content_block.id : undefined,
                name: typeof payload.content_block.name === 'string' ? payload.content_block.name : undefined,
                json: '',
            });
        }
        else if (payload.type === 'content_block_delta' && isRecord(payload.delta)) {
            if (payload.delta.type === 'text_delta' && typeof payload.delta.text === 'string')
                text += payload.delta.text;
            if (payload.delta.type === 'input_json_delta' && typeof payload.delta.partial_json === 'string') {
                const block = blocks.get(Number(payload.index ?? 0));
                if (block)
                    block.json += payload.delta.partial_json;
            }
        }
        else if (payload.type === 'message_delta') {
            if (isRecord(payload.delta))
                stopReason = payload.delta.stop_reason;
            if (isRecord(payload.usage))
                outputTokens = Number(payload.usage.output_tokens ?? outputTokens);
        }
    }
    if (!id && !text && !blocks.size)
        return undefined;
    const content = [];
    if (text)
        content.push({ type: 'text', text });
    for (const block of blocks.values()) {
        if (block.type !== 'tool_use')
            continue;
        let input = {};
        try {
            input = JSON.parse(block.json || '{}');
        }
        catch {
            input = block.json;
        }
        content.push({ type: 'tool_use', id: block.id, name: block.name, input });
    }
    return parseCanonicalResponse('anthropic', {
        id: id || `msg_${randomUUID()}`,
        model: model || 'unknown',
        content,
        stop_reason: stopReason,
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: cacheWriteTokens,
        },
    });
}
export function parseCanonicalStream(protocol, value) {
    const events = parseSseEvents(value);
    if (protocol === 'openai-chat')
        return aggregateChatStream(events);
    if (protocol === 'openai-responses')
        return aggregateResponsesStream(events);
    return aggregateAnthropicStream(events);
}
