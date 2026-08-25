import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function runStdioRequest(request) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TUSHARE_TOKEN: '',
      QVERIS_API_KEY: '',
    };
    const child = spawn(process.execPath, ['build/index.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`STDIO server exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

test('STDIO negotiates MCP 2025-11-25 without polluting stdout', async () => {
  const { stdout } = await runStdioRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdio-protocol-test', version: '1.0' },
    },
  });

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.equal(response.result.serverInfo.version, packageVersion);
});

test('STDIO discovers MCP 2026-07-28 capabilities before a handshake', async () => {
  const { stdout } = await runStdioRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': {
          name: 'stdio-protocol-test',
          version: '1.0',
        },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.ok(response.result.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(
    response.result._meta['io.modelcontextprotocol/serverInfo'].version,
    packageVersion,
  );
});
