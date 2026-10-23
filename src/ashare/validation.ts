import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SCORE_RULES, SCORE_VERSION, scoreRows, type MarketScan } from './analysis.js';
import { assertSeparateFromLive } from './snapshot.js';

export const VALIDATION_VERSION = 'validation-1.0.0';
export const VALIDATION_TYPES = ['RETROSPECTIVE_HOLDOUT', 'WALK_FORWARD_VALIDATION', 'TRUE_FORWARD_OBSERVATION'] as const;
export type ValidationType = typeof VALIDATION_TYPES[number];
export const CONTROL_MODELS = ['original', 'equal_dimensions', 'without_technical', 'without_fundamental', 'without_liquidity', 'without_valuation', 'without_sector', 'trend_quality'] as const;
export type ControlModel = typeof CONTROL_MODELS[number];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (v: number[]) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Circular moving-block bootstrap of DATE means. Blocks preserve adjacent overlapping horizons.
 * p is a two-sided, null-centered bootstrap p-value. Neither the resampling nor
 * non-overlap sensitivity proves independence or resolves historical selection bias. */
export function blockInference(values: readonly (number | null)[], blockLength = 5, repetitions = 1999, seed = 1021) {
  if (!Number.isInteger(blockLength) || blockLength < 1 || !Number.isInteger(repetitions) || repetitions < 99) throw new Error('Invalid bootstrap configuration');
  // Do not join observations across missing dates: caller must supply a complete ordered date series.
  const missing = values.filter(v => !finite(v)).length;
  const v = values.filter(finite), n = v.length, avg = mean(v);
  const unavailable = { method: 'circular_moving_block_bootstrap', n, missing, block_length: blockLength, repetitions, seed,
    mean: avg, ci95: null as [number, number] | null, p_value: null as number | null, status: 'DATA_INSUFFICIENT', nominal_blocks: Math.floor(n / blockLength) };
  if (missing || n < Math.max(20, blockLength * 4)) return unavailable;
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const draws: number[] = [];
  let tail = 0;
  for (let b = 0; b < repetitions; b++) {
    let total = 0, count = 0;
    while (count < n) {
      const first = Math.floor(random() * n);
      for (let j = 0; j < blockLength && count < n; j++, count++) total += v[(first + j) % n];
    }
    const sample = total / n;
    draws.push(sample);
    if (Math.abs(sample - avg!) >= Math.abs(avg!) - 1e-15) tail++;
  }
  draws.sort((a, b) => a - b);
  const q = (p: number) => draws[Math.floor((draws.length - 1) * p)];
  return { ...unavailable, status: 'DESCRIPTIVE_RESEARCH_ONLY', ci95: [q(0.025), q(0.975)] as [number, number], p_value: (tail + 1) / (repetitions + 1) };
}

/** Missing tests stay in the predeclared family, making the adjustment conservative. */
export function holmAdjust(tests: { id: string; p_value: number | null }[]) {
  if (new Set(tests.map(t => t.id)).size !== tests.length || tests.some(t => t.p_value !== null && (!finite(t.p_value) || t.p_value < 0 || t.p_value > 1))) throw new Error('Invalid hypothesis family');
  const sorted = tests.filter(t => t.p_value !== null).sort((a, b) => a.p_value! - b.p_value! || a.id.localeCompare(b.id));
  let previous = 0;
  const adjusted = new Map(sorted.map((t, i) => { previous = Math.max(previous, Math.min(1, t.p_value! * (tests.length - i))); return [t.id, previous]; }));
  return tests.map(t => ({ ...t, p_holm: adjusted.get(t.id) ?? null, family_size: tests.length, rejected_at_005: (adjusted.get(t.id) ?? 1) <= 0.05 }));
}

/** Formation labels must finish by split; delayed exits require an additional purge buffer.
 * Walk-forward means chronologically fixed rules, never a claim of unseen data. */
export function splitDates(days: string[], selection: string[], split: string, horizon: number, maxExitDelay = 0, type: ValidationType = 'RETROSPECTIVE_HOLDOUT') {
  if (!VALIDATION_TYPES.includes(type) || type === 'TRUE_FORWARD_OBSERVATION') throw new Error('True forward requires a persisted freeze and timely observations');
  if (!Number.isInteger(horizon) || horizon < 2 || !Number.isInteger(maxExitDelay) || maxExitDelay < 0 || days.some((d, i) => i > 0 && d <= days[i - 1])) throw new Error('Invalid split calendar or horizon');
  const index = new Map(days.map((d, i) => [d, i]));
  const formation: string[] = [], validation: string[] = [], purged: string[] = [], pending: string[] = [];
  for (const date of selection) {
    const i = index.get(date);
    if (i === undefined) throw new Error(`Selection date outside calendar: ${date}`);
    const end = days[i + horizon + maxExitDelay];
    if (date <= split) { if (end && end <= split) formation.push(date); else purged.push(date); }
    else if (end) validation.push(date); else pending.push(date);
  }
  return { type, split, horizon, max_exit_delay: maxExitDelay, formation, validation, purged, pending,
    interpretation: 'Historical dates may already have been observed. No untouched out-of-sample claim; formation windows including exit delay are purged at the boundary.' };
}

/** Controls reuse the full original normalization, eligibility and watchlist policy.
 * Only RESEARCH clones change; the production scorer and its weights remain frozen. */
export function controlScan(scan: MarketScan, model: ControlModel): MarketScan {
  if (!CONTROL_MODELS.includes(model)) throw new Error(`Unknown model ${model}`);
  const result = structuredClone(scan);
  const details = scoreRows(result.rows, result.sectors, SCORE_VERSION);
  if (model === 'original') return result;
  for (const row of result.rows.filter(r => r.eligible)) {
    const components = details.get(row.ts_code)!.components;
    const active = Object.keys(SCORE_RULES.weights).filter(k => model === 'trend_quality' ? ['technical', 'fundamental'].includes(k) : model !== `without_${k}`);
    const weights = model === 'equal_dimensions' || model === 'trend_quality' ? Object.fromEntries(active.map(k => [k, 1])) : SCORE_RULES.weights;
    const total = active.reduce((s, k) => s + weights[k as keyof typeof weights], 0);
    row.score = Math.round(10000 * active.reduce((s, k) => s + components[k as keyof typeof components] * weights[k as keyof typeof weights], 0) / total) / 100;
  }
  result.rows.filter(r => r.eligible).sort((a, b) => b.score! - a.score! || a.ts_code.localeCompare(b.ts_code)).forEach((r, i) => { r.rank = i + 1; });
  return result;
}

/** Preserves the legacy observation unchanged while exposing actual coverage and an independent corrected calculation. */
export function auditWatchlist(db: DatabaseSync, asOf: string, observationDates = 60, horizon = 5) {
  const days = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date<=? ORDER BY cal_date DESC LIMIT ?').all(asOf, observationDates + horizon) as { cal_date: string }[]).map(r => r.cal_date).reverse();
  const selected = db.prepare('SELECT ts_code FROM watchlist WHERE trade_date=? ORDER BY ts_code');
  const prices = db.prepare(`SELECT a.ts_code, a.open, b.close, aa.adj_factor entry_factor, ab.adj_factor exit_factor,
    CASE WHEN a.open>0 AND b.close>0 AND aa.adj_factor>0 AND ab.adj_factor>0 THEN b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 END r
    FROM daily a JOIN daily b ON b.ts_code=a.ts_code AND b.trade_date=?
    LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
    LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=b.trade_date WHERE a.trade_date=?`);
  const cohorts: { date: string; entry_date: string; exit_date: string; selected: number; priced: number; unresolved: number; benchmark_priced: number; benchmark_endpoint_rows: number; excess: number | null }[] = [];
  const skipped: { date: string; reason: string }[] = [];
  for (let i = 0; i < days.length; i++) {
    const members = selected.all(days[i]) as { ts_code: string }[];
    if (!members.length) { skipped.push({ date: days[i], reason: 'no_stored_pool' }); continue; }
    if (i + horizon >= days.length) { skipped.push({ date: days[i], reason: 'immature_horizon' }); continue; }
    const rows = prices.all(days[i + horizon], days[i + 1]) as { ts_code: string; r: number | null }[];
    const priced = rows.filter(r => finite(r.r));
    const byCode = new Map(priced.map(r => [r.ts_code, r.r!]));
    const returns = members.map(m => byCode.get(m.ts_code)).filter(finite);
    cohorts.push({ date: days[i], entry_date: days[i + 1], exit_date: days[i + horizon], selected: members.length,
      priced: returns.length, unresolved: members.length - returns.length, benchmark_priced: priced.length, benchmark_endpoint_rows: rows.length,
      excess: returns.length && priced.length >= 1000 ? mean(returns)! - mean(priced.map(r => r.r!))! : null });
  }
  return { version: VALIDATION_VERSION, as_of: asOf, start: days[0] ?? null, horizon, requested_completed_dates: observationDates,
    calendar_dates: days.length, cohorts, skipped, mean_excess_pct: mean(cohorts.map(c => c.excess).filter(finite)) === null ? null : mean(cohorts.map(c => c.excess).filter(finite))! * 100,
    win_rate: cohorts.some(c => finite(c.excess)) ? cohorts.filter(c => finite(c.excess) && c.excess > 0).length / cohorts.filter(c => finite(c.excess)).length : null,
    inference: blockInference(cohorts.map(c => c.excess), horizon),
    non_overlapping: Array.from({ length: horizon }, (_, offset) => ({ offset, ...blockInference(cohorts.filter((_, i) => i % horizon === offset).map(c => c.excess), 1) })),
    scope: 'Gross endpoint observations on priced subsets, with explicit missing counts; not executable portfolio returns. No original reports or market data are changed.' };
}

/** Expanding chronological folds. Rules are fixed controls, not trained on validation labels.
 * Each fold forms only on labels ending before its split, including exit delay. */
export function walkForwardFolds(days: string[], selection: string[], formationEnd: string, validationDates = 20, horizon = 5, maxExitDelay = 5) {
  if (!Number.isInteger(validationDates) || validationDates < 1) throw new Error('Invalid fold width');
  const later = selection.filter(d => d > formationEnd);
  return Array.from({ length: Math.ceil(later.length / validationDates) }, (_, i) => {
    const window = later.slice(i * validationDates, (i + 1) * validationDates);
    const first = days.indexOf(window[0]);
    const split = i === 0 ? formationEnd : days[first - 1];
    const fold = splitDates(days, selection.filter(d => d <= window.at(-1)!), split, horizon, maxExitDelay, 'WALK_FORWARD_VALIDATION');
    return { ...fold, validation: fold.validation.filter(d => window.includes(d)), fold: i + 1,
      policy: 'Expanding formation set; fixed predeclared control models; no validation-dependent refitting or winning-model selection.' };
  });
}

/** Deterministic coverage across the entire history when a run limits scans.
 * This changes the sampled rebalance scenario and is always recorded explicitly. */
export function sampleValidationDates(days: string[], stride: number, maxDates: number) {
  if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(maxDates) || maxDates < 2) throw new Error('Sampling requires stride>=1 and max-dates>=2');
  const grid = days.filter((_,i)=>i>=129 && (i-129)%stride===0);
  if (grid.length<=maxDates) return grid;
  return Array.from({length:maxDates},(_,i)=>grid[Math.round(i*(grid.length-1)/(maxDates-1))]);
}

export interface FreezeProtocol { start: string; frozen_at: string; rule_hash: string; cost_hash: string; implementation_hash: string; horizons: number[]; }
/** Independent append-only research registry; never create this on a market cache. */
export function openValidationDb(path: string, source: string) {
  assertSeparateFromLive(path, source);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS validation_freeze(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,protocol TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS validation_observation(id TEXT PRIMARY KEY,freeze_id TEXT NOT NULL,date TEXT NOT NULL,created_at TEXT NOT NULL,type TEXT NOT NULL,content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS validation_result(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,content TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS freeze_no_update BEFORE UPDATE ON validation_freeze BEGIN SELECT RAISE(ABORT,'immutable freeze'); END;
    CREATE TRIGGER IF NOT EXISTS freeze_no_delete BEFORE DELETE ON validation_freeze BEGIN SELECT RAISE(ABORT,'immutable freeze'); END;
    CREATE TRIGGER IF NOT EXISTS observation_no_update BEFORE UPDATE ON validation_observation BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
    CREATE TRIGGER IF NOT EXISTS observation_no_delete BEFORE DELETE ON validation_observation BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
    CREATE TRIGGER IF NOT EXISTS result_no_update BEFORE UPDATE ON validation_result BEGIN SELECT RAISE(ABORT,'immutable result'); END;
    CREATE TRIGGER IF NOT EXISTS result_no_delete BEFORE DELETE ON validation_result BEGIN SELECT RAISE(ABORT,'immutable result'); END;`);
  for(const table of ['validation_freeze','validation_observation']) {
    const columns=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
    if(!columns.some(c=>c.name==='recorded_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN recorded_at TEXT`);
  }
  for(const [table,label] of [['validation_freeze','freeze'],['validation_observation','observation'],['validation_result','result']]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${label}_no_replace BEFORE INSERT ON ${table}
      WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable ${label} duplicate'); END;`);
  }
  return db;
}
const validDate = (d: string) => /^\d{8}$/.test(d) && new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00Z`).toISOString().slice(0,10).replace(/-/g,'') === d;
export function registerFreeze(db: DatabaseSync, protocol: FreezeProtocol) {
  if (!validDate(protocol.start) || !Number.isFinite(Date.parse(protocol.frozen_at)) || !protocol.horizons.length || protocol.horizons.some(h => !Number.isInteger(h) || h < 2) || ![protocol.rule_hash, protocol.cost_hash, protocol.implementation_hash].every(h => /^[a-f0-9]{64}$/.test(h))) throw new Error('Invalid freeze protocol');
  if (Date.parse(protocol.frozen_at) >= Date.parse(`${protocol.start.slice(0,4)}-${protocol.start.slice(4,6)}-${protocol.start.slice(6,8)}T09:30:00+08:00`)) throw new Error('Freeze must precede observation-day open');
  const id = `FRZ-${digest(protocol).slice(0,24)}`;
  const exact=db.prepare('SELECT protocol,recorded_at FROM validation_freeze WHERE id=?').get(id) as {protocol:string;recorded_at:string|null}|undefined;
  if(exact) {
    if(exact.protocol!==JSON.stringify(protocol)) throw new Error('Freeze identity mismatch');
    return {id,...protocol,recorded_at:exact.recorded_at,status:'FROZEN_RESEARCH_ONLY',evidence_level:'UNVERIFIED'};
  }
  const recordedAt=new Date().toISOString();
  const actualDay=new Date(Date.parse(recordedAt)+8*3600_000).toISOString().slice(0,10).replace(/-/g,'');
  if(protocol.start<=actualDay || Math.abs(Date.parse(protocol.frozen_at)-Date.parse(recordedAt))>60_000) throw new Error('Freeze requires actual recording time and a future start day; cannot backdate');
  db.prepare('INSERT INTO validation_freeze(id,created_at,protocol,recorded_at) VALUES(?,?,?,?)').run(id, protocol.frozen_at, JSON.stringify(protocol),recordedAt);
  return { id, ...protocol,recorded_at:recordedAt, status: 'FROZEN_RESEARCH_ONLY', evidence_level: 'UNVERIFIED' };
}
export function appendObservation(db: DatabaseSync, input: { freeze_id: string; date: string; created_at: string; next_open: string; rule_hash: string; cost_hash: string; implementation_hash: string; original: boolean; content: unknown }) {
  const row = db.prepare('SELECT protocol,recorded_at FROM validation_freeze WHERE id=?').get(input.freeze_id) as { protocol: string; recorded_at: string | null } | undefined;
  if (!row) throw new Error('Unknown freeze');
  const p = JSON.parse(row.protocol) as FreezeProtocol;
  if(`FRZ-${digest(p).slice(0,24)}`!==input.freeze_id) throw new Error('Freeze identity mismatch');
  const recordedAt=new Date().toISOString();
  if (!validDate(input.date) || ![input.created_at, input.next_open].every(t => Number.isFinite(Date.parse(t)))) throw new Error('Invalid observation times');
  const nextDay = new Date(Date.parse(input.next_open) + 8 * 3600_000).toISOString().slice(0,10).replace(/-/g,'');
  const closeTime=Date.parse(`${input.date.slice(0,4)}-${input.date.slice(4,6)}-${input.date.slice(6,8)}T15:00:00+08:00`);
  const actualDay=new Date(Date.parse(recordedAt)+8*3600_000).toISOString().slice(0,10).replace(/-/g,'');
  // Conservative server-clock boundary: only the same civil evening counts.
  // Overnight imports remain historical even when a caller supplies a later next_open.
  const timely = actualDay===input.date && nextDay > input.date && Date.parse(recordedAt)>=closeTime && Date.parse(recordedAt)<Date.parse(input.next_open)
    && Math.abs(Date.parse(input.created_at)-Date.parse(recordedAt))<=60_000;
  const trustedFreeze=!!row.recorded_at && Date.parse(row.recorded_at)<=Date.parse(recordedAt)
    && Date.parse(row.recorded_at)<Date.parse(`${p.start.slice(0,4)}-${p.start.slice(4,6)}-${p.start.slice(6,8)}T00:00:00+08:00`);
  const matching = input.rule_hash === p.rule_hash && input.cost_hash === p.cost_hash && input.implementation_hash === p.implementation_hash;
  const id = `OBS-${digest(input).slice(0,24)}`;
  const existing = db.prepare('SELECT id,type FROM validation_observation WHERE freeze_id=? AND date=? ORDER BY created_at,id').all(input.freeze_id,input.date) as {id:string;type:string}[];
  const exact = existing.find(r=>r.id===id);
  if (exact) return { id, type: exact.type, matching, timely, evidence_level: 'UNVERIFIED' };
  const original = input.original && !existing.some(r=>r.id!==id);
  const type = original && trustedFreeze && input.date >= p.start && Date.parse(input.created_at) >= Date.parse(p.frozen_at) && timely && matching ? 'TRUE_FORWARD_OBSERVATION' : 'RETROSPECTIVE_HOLDOUT';
  db.prepare('INSERT INTO validation_observation(id,freeze_id,date,created_at,type,content,recorded_at) VALUES(?,?,?,?,?,?,?)').run(id, input.freeze_id, input.date, input.created_at, type, JSON.stringify(input),recordedAt);
  return { id, type, matching, timely, evidence_level: 'UNVERIFIED' };
}
/** Latest matching trusted freeze, without writable migrations or private data reads. */
export function loadActiveValidationFreeze(options:{dbPath:string;asOf:string;implementationHash?:string;ruleHash?:string;costHash?:string}) {
  if(!existsSync(options.dbPath)) return null;
  const db=new DatabaseSync(options.dbPath,{readOnly:true});
  db.exec('PRAGMA query_only=ON');
  try {
    const columns=db.prepare('PRAGMA table_info(validation_freeze)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='recorded_at')) return null;
    const rows=db.prepare('SELECT id,protocol,recorded_at FROM validation_freeze WHERE recorded_at IS NOT NULL ORDER BY recorded_at DESC,id DESC').all() as {id:string;protocol:string;recorded_at:string}[];
    for(const row of rows) {
      const p=JSON.parse(row.protocol) as FreezeProtocol;
      if(`FRZ-${digest(p).slice(0,24)}`!==row.id || p.start>options.asOf) continue;
      if(Date.parse(row.recorded_at)>=Date.parse(`${p.start.slice(0,4)}-${p.start.slice(4,6)}-${p.start.slice(6,8)}T00:00:00+08:00`)) continue;
      if(options.implementationHash && p.implementation_hash!==options.implementationHash || options.ruleHash && p.rule_hash!==options.ruleHash || options.costHash && p.cost_hash!==options.costHash) continue;
      return {id:row.id,...p,recorded_at:row.recorded_at};
    }
    return null;
  } finally {db.close();}
}

/** Why `loadActiveValidationFreeze` found nothing, for the most recent trusted freeze.
 * Read-only. `[]` means a freeze matches; otherwise the names of what failed, so an
 * UNAVAILABLE result is distinguishable from success without recomputing hashes by hand. */
export function explainFreezeMismatch(options:{dbPath:string;asOf:string;implementationHash?:string;ruleHash?:string;costHash?:string}): string[] {
  if(!existsSync(options.dbPath)) return ['no_freeze_registered'];
  const db=new DatabaseSync(options.dbPath,{readOnly:true});
  db.exec('PRAGMA query_only=ON');
  try {
    const columns=db.prepare('PRAGMA table_info(validation_freeze)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='recorded_at')) return ['no_freeze_registered'];
    const rows=db.prepare('SELECT id,protocol,recorded_at FROM validation_freeze WHERE recorded_at IS NOT NULL ORDER BY recorded_at DESC,id DESC').all() as {id:string;protocol:string;recorded_at:string}[];
    if(!rows.length) return ['no_freeze_registered'];
    const row=rows[0],p=JSON.parse(row.protocol) as FreezeProtocol;
    if(`FRZ-${digest(p).slice(0,24)}`!==row.id) return ['freeze_identity_invalid'];
    if(p.start>options.asOf) return ['start_after_as_of'];
    if(Date.parse(row.recorded_at)>=Date.parse(`${p.start.slice(0,4)}-${p.start.slice(4,6)}-${p.start.slice(6,8)}T00:00:00+08:00`)) return ['recorded_too_late'];
    const failed:string[]=[];
    if(options.ruleHash && p.rule_hash!==options.ruleHash) failed.push('rule_hash');
    if(options.costHash && p.cost_hash!==options.costHash) failed.push('cost_hash');
    if(options.implementationHash && p.implementation_hash!==options.implementationHash) failed.push('implementation_hash');
    return failed;
  } finally {db.close();}
}

/**
 * The compiled modules whose bytes decide what an observation contains. Everything else in
 * build/ashare (shadow/cadence/export/diagnosis/cli ...) cannot change a recorded top-40, so it
 * must not bind a freeze: the previous definition hashed the whole directory, which meant any new
 * research module silently made every existing freeze unmatchable (2026-10-23 18:41 CST).
 *
 * `validationCli` is listed on purpose: `observe` composes and slices the top-40 there. Moving that
 * composition into one of the other modules would narrow this further.
 * test/upgrade-validation.test.mjs asserts this list covers the import closure of
 * analysis/watchlist/evaluation/validation, so a new scoring dependency cannot be forgotten.
 */
export const IMPLEMENTATION_MODULES = ['analysis','bars','data','db','evaluation','fetch','fundamentals','indicators','ingest','signals','validation','validationCli','watchlist'] as const;
export const IMPLEMENTATION_SCHEME = 'signal-modules-v1';

export function implementationHash(dirs: { ashare?: string; portfolio?: string } = {}): string {
  const ashare = dirs.ashare ?? fileURLToPath(new URL('./',import.meta.url));
  const portfolio = dirs.portfolio ?? fileURLToPath(new URL('../portfolio/',import.meta.url));
  const h = createHash('sha256').update(IMPLEMENTATION_SCHEME).update('\0');
  for (const name of [...IMPLEMENTATION_MODULES].sort()) h.update(name).update('\0').update(readFileSync(join(ashare,`${name}.js`))).update('\0');
  const feeImplementation = createHash('sha256').update(readFileSync(join(portfolio,'fees.js'))).update(readFileSync(join(portfolio,'rules.js'))).digest('hex');
  return digest({scheme:IMPLEMENTATION_SCHEME,signal_build:h.digest('hex'),fee_implementation:feeImplementation});
}

export function researchIdentity() {
  return { version: VALIDATION_VERSION, score_version: SCORE_VERSION, weights: SCORE_RULES.weights, rule_hash: digest(SCORE_RULES),
    implementation_hash: implementationHash() };
}

/** Cheap read-only bundle projection. Validates content-addressed identity and
 * cutoff; never recomputes research or opens a writable registry connection. */
export function loadValidationSummary(options: { dbPath?: string; id?: string; asOf: string }) {
  if (!options.dbPath || !existsSync(options.dbPath)) return { status:'UNAVAILABLE', evidence_level:'UNVERIFIED', reason:'validation_registry_unavailable' };
  const db=new DatabaseSync(options.dbPath,{readOnly:true});
  db.exec('PRAGMA query_only=ON');
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='validation_result'").get()) return {status:'UNAVAILABLE',evidence_level:'UNVERIFIED',reason:'validation_result_table_unavailable'};
    const candidates=options.id
      ? db.prepare('SELECT id,created_at,content FROM validation_result WHERE id=?').all(options.id)
      : db.prepare('SELECT id,created_at,content FROM validation_result ORDER BY created_at DESC,id DESC').all();
    for(const row of candidates as {id:string;created_at:string;content:string}[]) {
      let value: any;
      try { value=JSON.parse(row.content); } catch { return {status:'UNAVAILABLE',evidence_level:'UNVERIFIED',reason:'validation_content_invalid'}; }
      if(typeof value.as_of!=='string' || value.as_of>options.asOf) continue;
      if(`VAL-${digest(value).slice(0,24)}`!==row.id) return {status:'UNAVAILABLE',evidence_level:'UNVERIFIED',reason:'validation_identity_mismatch'};
      const study=value.study;
      return {status:study || value.audit?.cohorts?.length || value.observations?.length ? 'RESEARCH_ONLY':'DATA_INSUFFICIENT',id:row.id,created_at:row.created_at,
        as_of:value.as_of,requested_as_of:options.asOf,type:value.type,version:value.version ?? value.identity?.schema,
        implementation_hash:value.implementation_hash ?? null,rule_hash:value.rule_hash ?? null,score_version:value.score_version ?? null,
        weights:value.weights ?? null,evidence_level:'UNVERIFIED',proof_status:value.type==='TRUE_FORWARD_OBSERVATION'?'FORWARD_OBSERVATIONS_DO_NOT_AUTOMATICALLY_VALIDATE_ADVANTAGE':'HISTORICAL_RESEARCH_DOES_NOT_VALIDATE_ADVANTAGE',
        forward:value.type==='TRUE_FORWARD_OBSERVATION'?{freeze_id:value.freeze_id,observations:value.observations?.length ?? 0,excluded_retrospective:value.excluded_retrospective ?? 0}:null,
        legacy_track_record:value.legacy?{dates:value.legacy.dates,mean_excess_pct:value.legacy.mean_excess_pct,hit_rate:value.legacy.hit_rate}:null,
        corrected_audit:value.audit?{dates:value.audit.cohorts.length,mean_excess_pct:value.audit.mean_excess_pct,win_rate:value.audit.win_rate,inference:value.audit.inference}:null,
        study:study?{sampled_dates:study.sampled_dates.length,first:study.sampled_dates[0],last:study.sampled_dates.at(-1),
          split:{date:study.split.split,formation:study.split.formation.length,validation:study.split.validation.length,purged:study.split.purged.length,pending:study.split.pending.length},
          models:study.comparisons.map((c:any)=>({model:c.model,segment:c.segment,events:c.summary.denominators.events,completed:c.summary.denominators.completed,
            date_mean_excess:c.inference.mean,ci95:c.inference.ci95,p_value:c.inference.p_value})),
          hypothesis_count:study.multiple_testing.length,holm_rejections:study.multiple_testing.filter((h:any)=>h.rejected_at_005).length,
          funded:Object.fromEntries(Object.entries(study.funded as Record<string,any>).map(([model,r])=>[model,{status:r.status,failure:r.failure,net_return:r.net_return}]))}:null};
    }
    return {status:'UNAVAILABLE',evidence_level:'UNVERIFIED',reason:'no_compatible_result_at_cutoff'};
  } finally {db.close();}
}

export interface FeeQuote { total_cents: number; version?: string; evidence?: unknown; }
export type ResearchFee = (order: { ts_code: string; date: string; side: 'BUY' | 'SELL'; price_cents: number; quantity: number }) => FeeQuote;

/** Sequential cash-funded, long-only stock cohorts. Buys use only current open and
 * fixed allocations, never future realised returns. Corporate actions whose share
 * entitlement cannot be reconstructed stop the run rather than fabricate NAV. */
export function simulateFunded(db: DatabaseSync, selections: { date: string; codes: string[] }[], options: { asOf: string; initial_cents: number; horizon: number; max_exit_delay: number; slippage_bps: number; fee: ResearchFee }) {
  if (!Number.isSafeInteger(options.initial_cents) || options.initial_cents <= 0 || !Number.isInteger(options.horizon) || options.horizon < 2 || !Number.isInteger(options.max_exit_delay) || options.max_exit_delay < 0 || !finite(options.slippage_bps) || options.slippage_bps < 0 || options.slippage_bps >= 10000) throw new Error('Invalid funded protocol');
  if (selections.some((s,i)=>s.date>options.asOf || (i>0 && s.date<=selections[i-1].date))) throw new Error('Selection dates must be increasing and no later than asOf');
  const start = selections[0]?.date ?? options.asOf;
  const days = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date').all(start, options.asOf) as { cal_date: string }[]).map(r => r.cal_date);
  const exchangeDays = new Set(days);
  if(selections.some(s=>!exchangeDays.has(s.date))) throw new Error('Selection date outside exchange calendar');
  const bar = db.prepare(`SELECT d.open,d.close,d.vol,a.adj_factor,l.up_limit,l.down_limit,
    EXISTS(SELECT 1 FROM suspend_d s WHERE s.ts_code=d.ts_code AND s.trade_date=d.trade_date) suspended
    FROM daily d LEFT JOIN adj_factor a ON a.ts_code=d.ts_code AND a.trade_date=d.trade_date
    LEFT JOIN stk_limit l ON l.ts_code=d.ts_code AND l.trade_date=d.trade_date WHERE d.ts_code=? AND d.trade_date=?`);
  type Position = { code: string; quantity: number; entered: number; exit: number; factor: number; mark: number };
  const suspended = db.prepare('SELECT 1 FROM suspend_d WHERE ts_code=? AND trade_date=?');
  const positions: Position[] = [], nav: { date: string; cents: number; cash_cents: number; holdings: number }[] = [];
  const orders: { date: string; side: string; quantity: number; price_cents: number; fees_cents: number; amount_cents: number; slippage_cents: number; fee_version: string | null; fee_evidence: unknown }[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  let cash = options.initial_cents, fees = 0, turnover = 0, failure: string | null = null, lastSignal = -Infinity;
  const signals = new Map(selections.map(s => [s.date, [...new Set(s.codes)].sort()]));
  const slip = options.slippage_bps / 10000;
  const getFee = (code: string, date: string, side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const q = options.fee({ ts_code: code, date, side, price_cents: price, quantity });
    if (!Number.isSafeInteger(q.total_cents) || q.total_cents < 0) throw new Error('Fee quote must be nonnegative integer cents');
    return q;
  };
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    // Opening buys are processed before closing sales: same-day sale proceeds cannot fund opening buys.
    const codes = i > 0 ? signals.get(days[i - 1]) : undefined;
    if (codes) {
      if (i - 1 - lastSignal < options.horizon + options.max_exit_delay || positions.length) skip('cohort_overlap_or_unresolved');
      else {
        lastSignal = i - 1;
        const allowed = codes.filter(code => /^(60\d{4}\.SH|00\d{4}\.SZ)$/.test(code));
        skipCount('unsupported_board', codes.length - allowed.length);
        const allocation = Math.floor(cash / Math.max(1, allowed.length));
        for (const code of allowed) {
          const b = bar.get(code, date) as any;
          if (!b || !finite(b.open) || b.open <= 0 || !finite(b.up_limit) || b.up_limit <= 0 || !finite(b.adj_factor) || b.adj_factor <= 0 || !finite(b.vol)) { skip('entry_unknown'); continue; }
          if (b.suspended || b.vol <= 0 || b.open >= b.up_limit - 0.001) { skip('entry_blocked'); continue; }
          const price = Math.ceil(b.open * 100 * (1 + slip));
          if (price > Math.round(b.up_limit * 100)) { skip('slippage_exceeds_limit'); continue; }
          let quantity = Math.floor(Math.min(allocation, cash) / price / 100) * 100;
          while (quantity > 0 && quantity * price + getFee(code, date, 'BUY', price, quantity).total_cents > Math.min(allocation, cash)) quantity -= 100;
          if (!quantity) { skip('insufficient_cash_for_lot'); continue; }
          const quote = getFee(code, date, 'BUY', price, quantity), amount = quantity * price;
          cash -= amount + quote.total_cents; fees += quote.total_cents; turnover += amount;
          positions.push({ code, quantity, entered: i, exit: i - 1 + options.horizon, factor: b.adj_factor, mark: b.open });
          orders.push({ date, side: 'BUY', quantity, price_cents: price, fees_cents: quote.total_cents, amount_cents: amount,
            slippage_cents: quantity*(price-Math.round(b.open*100)), fee_version: quote.version ?? null, fee_evidence: quote.evidence ?? null });
        }
      }
    }
    for (let p = positions.length - 1; p >= 0; p--) {
      const position = positions[p], b = bar.get(position.code, date) as any;
      if (b && (!finite(b.adj_factor) || b.adj_factor<=0)) { failure = 'held_adjustment_factor_unavailable'; break; }
      if (b && finite(b.adj_factor) && Math.abs(b.adj_factor - position.factor) > 1e-10) { failure = 'corporate_action_entitlement_unavailable'; break; }
      const isSuspended = !!b?.suspended || !!suspended.get(position.code,date);
      if (b && finite(b.close) && b.close > 0) position.mark = b.close;
      else if (!isSuspended) { failure = 'held_position_mark_unavailable'; break; }
      if (i < position.exit) continue;
      if (i > position.exit + options.max_exit_delay) { failure = 'exit_delay_exhausted'; break; }
      if (isSuspended) { skip('exit_blocked'); continue; }
      if (!b || !finite(b.close) || b.close <= 0 || !finite(b.down_limit) || b.down_limit <= 0 || !finite(b.vol)) { failure = 'exit_constraint_unknown'; break; }
      if (b.suspended || b.vol <= 0 || b.close <= b.down_limit + 0.001) { skip('exit_blocked'); continue; }
      if (i <= position.entered) throw new Error('T+1 violation');
      const price = Math.floor(b.close * 100 * (1 - slip));
      if (price < Math.round(b.down_limit * 100)) { skip('slippage_exceeds_limit'); continue; }
      const quote = getFee(position.code, date, 'SELL', price, position.quantity), amount = price * position.quantity;
      cash += amount - quote.total_cents; fees += quote.total_cents; turnover += amount;
      orders.push({ date, side: 'SELL', quantity: position.quantity, price_cents: price, fees_cents: quote.total_cents, amount_cents: amount,
        slippage_cents: position.quantity*(Math.round(b.close*100)-price), fee_version: quote.version ?? null, fee_evidence: quote.evidence ?? null });
      positions.splice(p, 1);
    }
    if (failure) break;
    nav.push({ date, cents: cash + positions.reduce((s, p) => s + Math.round(p.mark * 100) * p.quantity, 0), cash_cents: cash, holdings: positions.length });
  }
  let peak = options.initial_cents, mdd = 0;
  const returns = nav.slice(1).map((d, i) => d.cents / nav[i].cents - 1), avg = mean(returns);
  for (const d of nav) { peak = Math.max(peak, d.cents); mdd = Math.min(mdd, d.cents / peak - 1); }
  const result = { status: failure ? 'DATA_INSUFFICIENT' : positions.length ? 'OPEN_POSITIONS_AT_CUTOFF' : 'COMPLETED', failure,
    initial_cents: options.initial_cents, final_nav_cents: failure ? null : nav.at(-1)?.cents ?? options.initial_cents,
    net_return: failure ? null : (nav.at(-1)?.cents ?? options.initial_cents) / options.initial_cents - 1,
    maximum_drawdown: failure ? null : mdd, daily_volatility: failure || returns.length < 2 ? null : Math.sqrt(returns.reduce((s, x) => s + (x - avg!) ** 2, 0) / (returns.length - 1)),
    fees_cents: fees, slippage_cents: orders.reduce((s,o)=>s+o.slippage_cents,0), turnover_notional_to_initial: turnover / options.initial_cents, order_count: orders.length, skipped, nav, orders,
    limitations: ['Explicit sampled long-only mainboard cohorts, 100-share lots, cash funded and T+1; not the deployed daily watchlist strategy.', 'Known suspensions retain the last observed mark; unknown marks and corporate actions stop the simulation. No corporate entitlement, queue or intraday liquidity model.', 'Unresolved final holdings are marked, not counted as successful exits. Historical data revisions and current metadata remain limitations.'] };
  return result;
  function skipCount(reason: string, count: number) { if (count) skipped[reason] = (skipped[reason] ?? 0) + count; }
}
