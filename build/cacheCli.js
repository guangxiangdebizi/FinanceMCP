#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomToken, timingSafeTokenHash } from './gateway/utils.js';
function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}
function required(args, name) {
    const value = option(args, name)?.trim();
    if (!value)
        throw new Error(`Missing required option: ${name}`);
    return value;
}
function usage() {
    return [
        'Finance Cache Gateway CLI',
        '',
        'Commands:',
        '  finance-cache init --model <public-id> --upstream-model <id> --upstream-base-url <url>',
        '                     [--protocol openai-responses|openai-chat|anthropic]',
        '                     [--provider openai|anthropic|deepseek|generic|none]',
        '                     [--workspace <id>] [--tenant <id>] [--config <path>]',
        '  finance-cache print-config --client trae|cursor|claude-code|codex',
        '                             --model <id> --api-key <gateway-key>',
        '                             [--base-url http://127.0.0.1:3210/v1]',
        '  finance-cache hash-key <gateway-key>',
        '',
        'init prints the generated plaintext gateway key once and writes only its hash to config.',
    ].join('\n');
}
async function init(args) {
    const publicModel = required(args, '--model');
    const upstreamModel = required(args, '--upstream-model');
    const upstreamBaseUrl = required(args, '--upstream-base-url').replace(/\/+$/, '');
    const protocol = option(args, '--protocol') ?? 'openai-responses';
    if (!['openai-responses', 'openai-chat', 'anthropic'].includes(protocol)) {
        throw new Error(`Invalid protocol: ${protocol}`);
    }
    const provider = option(args, '--provider') ?? (protocol === 'anthropic' ? 'anthropic' : 'generic');
    if (!['openai', 'anthropic', 'deepseek', 'generic', 'none'].includes(provider)) {
        throw new Error(`Invalid provider: ${provider}`);
    }
    const workspace = option(args, '--workspace') ?? 'default';
    const tenant = option(args, '--tenant') ?? 'local';
    const configPath = resolve(option(args, '--config') ?? `${homedir()}/.finance-mcp/cache-gateway.json`);
    const gatewayKey = randomToken();
    const config = {
        version: 1,
        allowAnonymous: false,
        clients: [{
                tokenHash: timingSafeTokenHash(gatewayKey),
                tenantId: tenant,
                workspaceId: workspace,
                label: `${workspace}-clients`,
            }],
        models: [{
                id: publicModel,
                upstream: {
                    protocol,
                    baseUrl: upstreamBaseUrl,
                    model: upstreamModel,
                    apiKeyEnv: 'CACHE_UPSTREAM_API_KEY',
                },
                cache: {
                    provider,
                    enabled: provider !== 'none',
                    mode: provider === 'openai' ? 'explicit' : 'automatic',
                    ...(provider === 'openai' ? { ttl: '30m' } : {}),
                },
                handoff: {
                    enabled: true,
                    autoResume: true,
                    resumeWindowMinutes: 120,
                    maxMessages: 8,
                    maxCharacters: 8000,
                },
            }],
    };
    await mkdir(dirname(configPath), { recursive: true });
    try {
        await readFile(configPath, 'utf8');
        throw new Error(`Config already exists: ${configPath}`);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    process.stdout.write([
        `Config: ${configPath}`,
        `Gateway API key (save it now): ${gatewayKey}`,
        '',
        'Set before starting:',
        `  CACHE_GATEWAY_CONFIG=${configPath}`,
        '  CACHE_UPSTREAM_API_KEY=<your upstream key>',
        '',
        'Start:',
        '  finance-cache-gateway',
        '',
    ].join('\n'));
}
function printClientConfig(args) {
    const client = required(args, '--client');
    const model = required(args, '--model');
    const apiKey = required(args, '--api-key');
    const baseUrl = (option(args, '--base-url') ?? 'http://127.0.0.1:3210/v1').replace(/\/+$/, '');
    if (client === 'codex') {
        process.stdout.write([
            `model = ${JSON.stringify(model)}`,
            'model_provider = "finance_cache"',
            '',
            '[model_providers.finance_cache]',
            'name = "Finance Cache Gateway"',
            `base_url = ${JSON.stringify(baseUrl)}`,
            'env_key = "FINANCE_CACHE_API_KEY"',
            'wire_api = "responses"',
            '',
            `# PowerShell: $env:FINANCE_CACHE_API_KEY=${JSON.stringify(apiKey)}`,
            '',
        ].join('\n'));
        return;
    }
    if (client === 'claude-code') {
        process.stdout.write([
            `$env:ANTHROPIC_BASE_URL=${JSON.stringify(baseUrl.replace(/\/v1$/, ''))}`,
            `$env:ANTHROPIC_AUTH_TOKEN=${JSON.stringify(apiKey)}`,
            `$env:ANTHROPIC_MODEL=${JSON.stringify(model)}`,
            `$env:ANTHROPIC_CUSTOM_MODEL_OPTION=${JSON.stringify(model)}`,
            '$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"',
            '',
        ].join('\n'));
        return;
    }
    if (client === 'cursor' || client === 'trae') {
        process.stdout.write([
            `Client: ${client}`,
            `API Base URL: ${baseUrl}`,
            `API Key: ${apiKey}`,
            `Model: ${model}`,
            'API format: OpenAI compatible',
            '',
        ].join('\n'));
        return;
    }
    throw new Error(`Unsupported client: ${client}`);
}
async function main() {
    const args = process.argv.slice(2);
    const command = args.shift();
    if (!command || command === '--help' || command === '-h' || command === 'help') {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    if (command === 'init') {
        await init(args);
        return;
    }
    if (command === 'print-config') {
        printClientConfig(args);
        return;
    }
    if (command === 'hash-key') {
        const value = args[0]?.trim();
        if (!value)
            throw new Error('hash-key requires a gateway key');
        process.stdout.write(`${timingSafeTokenHash(value)}\n`);
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}
main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
