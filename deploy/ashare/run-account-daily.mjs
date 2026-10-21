#!/usr/bin/env node
// Compatibility entry point. The shared CLI owns date resolution and private recording.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../../build/ashare/cli.js', import.meta.url));
const args = process.argv.slice(2).filter(arg => arg !== '--record');
const child = spawnSync(process.execPath, [cli, 'investment-research-record', ...args], { stdio: 'inherit' });
process.exit(child.status ?? 1);
