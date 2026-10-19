#!/usr/bin/env node
// Pre-commit / CI guard: refuse to stage (or ship) real credentials.
//
// Incident 2026-10-19: `deploy/ashare/.env.bak.*` was committed with a live
// Tushare token and the private-endpoint bearer token. Removing that file is not
// enough — the same mistake must fail loudly next time.
//
// Checks, in order:
//   1. tracked/staged paths that are environment backups (never legitimate);
//   2. staged content that looks like a real credential assignment.
// The secret values are never printed; only the path and the key name are.
//
// Usage: node scripts/check-secrets.mjs            # check the index (pre-commit)
//        node scripts/check-secrets.mjs --tracked  # check all tracked files (CI)
import { execFileSync } from 'node:child_process';

const tracked = process.argv.includes('--tracked');

const CREDENTIAL_KEYS = [
  'TUSHARE_TOKEN', 'MCP_AUTH_TOKEN', 'ASHARE_PRIVATE_PORTFOLIO_TOKEN',
  'ASHARE_OAUTH_LOGIN_PASSWORD', 'QVERIS_API_KEY', 'TWINGLY_API_KEY', 'OPENAI_API_KEY',
];
const PLACEHOLDER = /^(changeme|change-me|replace-me|placeholder|example|xxx+|dummy|test|todo|your[-_]?token)/i;
const ENV_ALLOWED = /(^|\/)\.env\.example$|\.env\.[\w.-]*\.example$/;
/** Documentation and fixtures legitimately contain placeholder assignments. */
const DOC_OR_FIXTURE = /(^|\/)(README(_EN)?\.md|smithery\.yaml|docs\/.*|test\/.*)$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** A path that must never be tracked: environment files and backups. */
function isForbiddenPath(path) {
  if (ENV_ALLOWED.test(path)) return false;
  const base = path.split('/').pop() ?? path;
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env.bak')
    || base.includes('.env.bak.') || base.endsWith('.bak');
}

/** True when a value is a real secret rather than a placeholder/expansion. */
function looksLikeSecret(value) {
  const v = value.trim().replace(/^["']|["']$/g, '').trim();
  // Strip a trailing YAML/JS structure so `"a": "b"` does not hide the value.
  if (v === '' || v.startsWith('${') || v.startsWith('$')) return false;
  if (/^config\.|^process\.env|^env\./i.test(v)) return false;
  if (PLACEHOLDER.test(v) || /your[-_]?/i.test(v)) return false;
  if (v.length < 12) return false;
  // A value with no entropy at all (all same character) is filler.
  return new Set(v).size > 2;
}

function scanContent(path, content) {
  const findings = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    for (const key of CREDENTIAL_KEYS) {
      const match = new RegExp(`^\\s*["']?${key}["']?\\s*[=:]\\s*(.+)$`).exec(line);
      if (!match) continue;
      // Skip documentation lines such as `TUSHARE_TOKEN=<redacted>`.
      if (looksLikeSecret(match[1])) findings.push(`${path}:${index + 1} key=${key}`);
    }
  }
  return findings;
}

let failed = false;
const files = tracked
  ? git(['ls-files']).split('\n').filter(Boolean)
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);

for (const path of files) {
  if (isForbiddenPath(path)) {
    console.error(`check-secrets: refusing to track environment file: ${path}`);
    failed = true;
    continue;
  }
  let content;
  try {
    content = tracked
      ? execFileSync('cat', ['--', path], { encoding: 'utf8' })
      : git(['show', `:${path}`]);
  } catch {
    continue;
  }
  for (const finding of scanContent(path, content)) {
    if (DOC_OR_FIXTURE.test(path)) continue;
    console.error(`check-secrets: credential-shaped value: ${finding}`);
    failed = true;
  }
}

if (failed) {
  console.error('check-secrets: blocked. Remove the file from the index and rotate any leaked token.');
  process.exit(1);
}
console.log(`check-secrets: ok (${tracked ? 'tracked' : 'staged'}, ${files.length} files)`);
