import { isRecord, sha256, stableJson } from './utils.js';
function markLastTextBlock(content, blockType = 'text') {
    if (typeof content === 'string') {
        return {
            value: [{
                    type: blockType,
                    text: content,
                    prompt_cache_breakpoint: { mode: 'explicit' },
                }],
            marked: true,
        };
    }
    if (!Array.isArray(content))
        return { value: content, marked: false };
    const copy = content.map(item => isRecord(item) ? { ...item } : item);
    for (let index = copy.length - 1; index >= 0; index -= 1) {
        const block = copy[index];
        if (!isRecord(block) || !['text', 'input_text'].includes(String(block.type)))
            continue;
        copy[index] = { ...block, prompt_cache_breakpoint: { mode: 'explicit' } };
        return { value: copy, marked: true };
    }
    return { value: copy, marked: false };
}
function addOpenAiExplicitBreakpoint(body, protocol) {
    if (protocol === 'openai-chat' && Array.isArray(body.messages)) {
        for (let index = body.messages.length - 1; index >= 0; index -= 1) {
            const message = body.messages[index];
            if (!isRecord(message) || !['system', 'developer'].includes(String(message.role)))
                continue;
            const marked = markLastTextBlock(message.content, 'text');
            if (!marked.marked)
                continue;
            body.messages[index] = { ...message, content: marked.value };
            return true;
        }
    }
    if (protocol === 'openai-responses') {
        if (Array.isArray(body.input)) {
            for (let index = body.input.length - 1; index >= 0; index -= 1) {
                const item = body.input[index];
                if (!isRecord(item) || !['system', 'developer'].includes(String(item.role)))
                    continue;
                const marked = markLastTextBlock(item.content, 'input_text');
                if (!marked.marked)
                    continue;
                body.input[index] = { ...item, content: marked.value };
                return true;
            }
        }
        if (typeof body.instructions === 'string' && body.instructions) {
            const originalInput = body.input;
            const input = Array.isArray(originalInput)
                ? [...originalInput]
                : typeof originalInput === 'string'
                    ? [{ role: 'user', content: [{ type: 'input_text', text: originalInput }] }]
                    : [];
            input.unshift({
                role: 'developer',
                content: [{
                        type: 'input_text',
                        text: body.instructions,
                        prompt_cache_breakpoint: { mode: 'explicit' },
                    }],
            });
            body.input = input;
            delete body.instructions;
            return true;
        }
    }
    return false;
}
export function applyNativeCachePolicy(body, targetProtocol, route, providerRoutingKey) {
    const policy = route.cache;
    if (!policy?.enabled || policy.provider === 'none') {
        return { provider: policy?.provider ?? 'none', mode: 'disabled', routingKeyApplied: false, breakpointApplied: false };
    }
    if (policy.provider === 'openai') {
        if (!['openai-chat', 'openai-responses'].includes(targetProtocol)) {
            throw new Error('OpenAI cache policy requires an OpenAI upstream protocol');
        }
        body.prompt_cache_key = providerRoutingKey;
        let breakpointApplied = false;
        if (policy.mode === 'explicit') {
            body.prompt_cache_options = { mode: 'explicit', ttl: policy.ttl === '30m' ? '30m' : '30m' };
            breakpointApplied = addOpenAiExplicitBreakpoint(body, targetProtocol);
        }
        return {
            provider: 'openai',
            mode: policy.mode ?? 'automatic',
            routingKeyApplied: true,
            breakpointApplied,
        };
    }
    if (policy.provider === 'anthropic') {
        if (targetProtocol !== 'anthropic') {
            throw new Error('Anthropic cache policy requires an Anthropic upstream protocol');
        }
        body.cache_control = {
            type: 'ephemeral',
            ...(policy.ttl === '1h' ? { ttl: '1h' } : {}),
        };
        return {
            provider: 'anthropic',
            mode: 'automatic',
            routingKeyApplied: false,
            breakpointApplied: true,
        };
    }
    return {
        provider: policy.provider,
        mode: policy.provider === 'deepseek' ? 'provider-automatic' : 'passthrough',
        routingKeyApplied: false,
        breakpointApplied: false,
    };
}
export function buildModelFingerprint(route, upstreamApiKey) {
    return sha256(stableJson({
        protocol: route.upstream.protocol,
        baseUrl: route.upstream.baseUrl,
        model: route.upstream.model ?? route.id,
        credentialScope: sha256(upstreamApiKey),
    }));
}
