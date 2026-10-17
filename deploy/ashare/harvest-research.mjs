#!/usr/bin/env node
// Cache deterministic full-market V1 inputs for the paired research run.
// Every output stays under the explicitly supplied independent research directory.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

console.log = () => {};
const arg = key => process.argv[process.argv.indexOf(`--${key}`) + 1];
const has = key => process.argv.includes(`--${key}`);
const required = key => { if (!has(key)) throw new Error(`--${key} required`); return arg(key); };
const source = resolve(required('source'));
const build = resolve(required('build'));
const output = resolve(required('output'));
const cutoff = has('end') ? arg('end') : '20261016';
if (source === join(output, 'research.sqlite')) throw new Error('Source and output database must differ');
mkdirSync(join(output, 'scans'), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
db.exec('PRAGMA mmap_size=2147483648; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY');
const dates = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date BETWEEN (SELECT MIN(trade_date) FROM daily) AND ? ORDER BY cal_date').all(cutoff).map(r => r.cal_date);
const stride = Number(has('stride') ? arg('stride') : 5);
if (!Number.isInteger(stride) || stride < 1) throw new Error('stride must be a positive integer');
const selected = [...new Set([...dates.filter((d, i) => i >= 129 && (i - 129) % stride === 0), ...['20260331', cutoff].filter(d => dates.indexOf(d) >= 129)])].sort();
if (has('worker')) {
  const worker = Number(arg('worker'));
  const total = Number(required('workers'));
  const { scanMarket } = await import(pathToFileURL(join(build, 'ashare/analysis.js')).href);
  for (const [i, date] of selected.entries()) {
    if (i % total !== worker) continue;
    const start = Date.now();
    const scan = scanMarket(db, date);
    const text = JSON.stringify(scan);
    writeFileSync(join(output, 'scans', `${date}.json`), text);
    console.error(`[research] scan ${date} rows=${scan.rows.length} eligible=${scan.rows.filter(r => r.eligible).length} ${Date.now() - start}ms sha256=${createHash('sha256').update(text).digest('hex')}`);
  }
} else {
  const workers = Number(has('workers') ? arg('workers') : 2);
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('workers must be 1..4');
  const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const baselineHash = createHash('sha256');
  for (const file of readdirSync(join(build, 'ashare')).filter(f => f.endsWith('.js')).sort()) baselineHash.update(file).update('\0').update(readFileSync(join(build, 'ashare', file))).update('\0');
  writeFileSync(join(output, 'inputs.json'), JSON.stringify({ source, source_sha256: sourceSha256, baseline_build_sha256: baselineHash.digest('hex'), data_cutoff: cutoff, stride, warmup_trade_days: 130, dates: selected, scan_version: 'score-1.0.0', note: 'Immutable full-market scans; same input used for both scoring versions. NaN serializes to null. No future prices are passed to the scorer.' }, null, 2));
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((res, rej) => {
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2), '--worker', String(i), ...(has('workers') ? [] : ['--workers', String(workers)])], { stdio: 'inherit' });
    child.once('error', rej);
    child.once('exit', code => code === 0 ? res() : rej(new Error(`scan worker ${i} exited ${code}`)));
  })));
  console.error(`[research] ${selected.length} deterministic scans complete`);
}
db.close();
