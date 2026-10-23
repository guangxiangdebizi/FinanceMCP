#!/usr/bin/env node
/** Verify that a merged Experiment A result file's code identity actually resolves.
 *
 * `code_sha` is a claim about provenance. A claim is not evidence until something
 * checks it, and the check is cheap: resolve the commit, read the blob for the
 * named module and runner, hash them, compare. This script does exactly that and
 * exits non-zero on any mismatch.
 *
 * It exists because the claim was once false. An earlier
 * `research/experimentA_results.json` recorded `code_sha: 75438fd9`, a commit
 * that predates the module entirely — `git show 75438fd9:src/ashare/experimentA.ts`
 * yields the empty-file blob `e3b0c44298fc...`. Every other field in that file
 * was correct and the numbers reproduced bit-for-bit, so nothing looked wrong.
 * An auditor following `code_sha` would simply have found no code to audit.
 *
 * Usage: node research/verify_results.mjs [results.json ...]
 * With no arguments it verifies every research/*_results.json in the repo.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const files = args.length > 0
  ? args
  : readdirSync(join(root, 'research'))
    .filter(f => f.endsWith('_results.json'))
    .map(f => join(root, 'research', f));

if (files.length === 0) {
  console.error('no result files to verify');
  process.exit(2);
}

let bad = 0;
for (const file of files) {
  const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✖ ${rel}: not valid JSON — ${err.message}`);
    bad++;
    continue;
  }
  const code = doc.code ?? {};
  const missing = ['code_sha', 'source_sha256', 'module'].filter(k => !code[k]);
  if (missing.length > 0) {
    console.error(`✖ ${rel}: code block is missing ${missing.join(', ')}`);
    bad++;
    continue;
  }

  const problems = [];
  for (const [path, field] of [[code.module, 'source_sha256'], [code.runner, 'runner_sha256']]) {
    if (!path || !code[field]) continue; // runner_sha256 is optional, as it postdates some files
    let blob;
    try {
      blob = execFileSync('git', ['show', `${code.code_sha}:${path}`], { cwd: root });
    } catch {
      problems.push(`${code.code_sha.slice(0, 12)}:${path} does not resolve in this repository`);
      continue;
    }
    const actual = createHash('sha256').update(blob).digest('hex');
    if (actual !== code[field]) {
      problems.push(`${path} hashes to ${actual.slice(0, 12)}, but ${field} claims ${code[field].slice(0, 12)}`);
    }
  }
  // A commit that resolves but contains an EMPTY file is the specific failure this
  // guards against: the hashes would match a real file only by coincidence, but an
  // empty blob is the signature of "this commit never had the module".
  for (const [path, field] of [[code.module, 'source_sha256']]) {
    if (!problems.some(p => p.includes(path))) {
      const blob = execFileSync('git', ['show', `${code.code_sha}:${path}`], { cwd: root });
      if (blob.length === 0) problems.push(`${path} is EMPTY at ${code.code_sha.slice(0, 12)}`);
    }
  }

  if (problems.length > 0) {
    console.error(`✖ ${rel}`);
    for (const p of problems) console.error(`    ${p}`);
    bad++;
  } else {
    console.log(`✔ ${rel} — code_sha ${code.code_sha.slice(0, 12)} resolves and both hashes match`);
  }
}

process.exit(bad === 0 ? 0 : 1);
