import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { calculateFees, resolveFeeRules } from '../portfolio/fees.js';
import { evaluateWatchlist } from './evidence.js';
import { scanMarket, SCORE_RULES } from './analysis.js';
import { updateWatchlist, WATCHLIST_RULES } from './watchlist.js';
import { distribution, evaluateEvents, type EvaluationEvent } from './evaluation.js';
import { regimeSeries } from './market.js';
import { SIGNAL_DEFINITIONS } from './signals.js';
import { shanghaiToday } from './ingest.js';
import { assertSeparateFromLive } from './snapshot.js';
import { CONTROL_MODELS, auditWatchlist, blockInference, controlScan, holmAdjust, openValidationDb, registerFreeze, appendObservation, researchIdentity, simulateFunded, splitDates, walkForwardFolds, sampleValidationDates, loadValidationSummary, loadActiveValidationFreeze, VALIDATION_VERSION, type ResearchFee } from './validation.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const registryStore = (db: DatabaseSync, value: unknown) => {
  const id = `VAL-${hash(value).slice(0,24)}`;
  const prior=db.prepare('SELECT content FROM validation_result WHERE id=?').get(id) as {content:string}|undefined;
  if(prior && prior.content!==JSON.stringify(value)) throw new Error('Research result identity mismatch');
  if(!prior) db.prepare('INSERT INTO validation_result VALUES(?,?,?)').run(id, new Date().toISOString(), JSON.stringify(value));
  return id;
};

/** Lead CLI dispatch may await this helper and print its return value. No market writes.
 * audit --source PATH --as-of YYYYMMDD --output DIR
 * study --source PATH --as-of YYYYMMDD --output DIR [--stride 5] [--max-dates N]
 * freeze --source PATH --research-db PATH --start YYYYMMDD
 * observe --source PATH --research-db PATH --freeze-id ID --as-of YYYYMMDD
 */
export async function runValidationCommand(args: string[], injectedFee?: ResearchFee): Promise<Record<string, unknown>> {
  const command = args[0] ?? 'audit';
  const arg = (key: string, fallback?: string) => { const i = args.indexOf(`--${key}`); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`); return args[i + 1]; };
  const required = (key: string) => { const value = arg(key); if (!value) throw new Error(`--${key} required`); return value; };
  const source = resolve(required('source'));
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=15000; BEGIN;');
  try {
    const asOf = command === 'freeze' ? required('start') : required('as-of');
    const parsed = /^\d{8}$/.test(asOf) ? new Date(`${asOf.slice(0,4)}-${asOf.slice(4,6)}-${asOf.slice(6,8)}T00:00:00Z`) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10).replace(/-/g,'')!==asOf) throw new Error('Invalid as-of/start');
    const output = resolve(arg('output', 'data/ashare/validation-20261021')!);
    const researchPath = resolve(arg('research-db', join(output, 'validation.sqlite'))!);
    assertSeparateFromLive(researchPath, source);
    const identity = researchIdentity();
    const costs = { buy_fee_bps: 3, sell_fee_bps: 8, slippage_bps: 5, max_exit_delay: 5 };
    const protocol = { ...identity, pool_rules: WATCHLIST_RULES, models: CONTROL_MODELS, costs,
      costs_note: 'Event observations use explicit research bps, not exact per-order commissions. Funded simulation uses a constant category-default fee scenario with historical-date input: current statutory references throughout the 2024+ window, not reconstructed regulatory vintages. Broker assumptions and slippage remain explicit.' };
    if (command === 'freeze') {
      mkdirSync(resolve(researchPath, '..'), { recursive: true });
      const research = openValidationDb(researchPath, source);
      try {
        if (required('start')<=shanghaiToday()) throw new Error('Forward start must be after the actual freeze day; historical observations cannot be backdated');
        return registerFreeze(research, { start: required('start'), frozen_at: new Date().toISOString(), rule_hash: hash({ rules: SCORE_RULES, pool: WATCHLIST_RULES, models: CONTROL_MODELS }), cost_hash: hash(costs), implementation_hash: identity.implementation_hash, horizons: [5,10,20] });
      } finally { research.close(); }
    }
    if (command === 'observe') {
      mkdirSync(resolve(researchPath, '..'), { recursive: true });
      const research = openValidationDb(researchPath, source);
      try {
        const cutoff = (db.prepare('SELECT MAX(trade_date) d FROM daily').get() as any)?.d;
        if (cutoff !== asOf) throw new Error('Observation requires latest cache cutoff equal to observation date');
        const latestReport = db.prepare("SELECT report_id,status,generated_at FROM report WHERE trade_date=? AND run_mode='live' ORDER BY generated_at DESC LIMIT 1").get(asOf) as any;
        if (!latestReport || latestReport.status === 'NOT_READY') throw new Error('Observation requires a usable live report');
        const next = (db.prepare('SELECT MIN(cal_date) d FROM trade_cal WHERE is_open=1 AND cal_date>?').get(asOf) as any)?.d as string | null;
        if (!next) throw new Error('Next exchange session unavailable');
        const scan = scanMarket(db, asOf);
        const models = Object.fromEntries(CONTROL_MODELS.map(model => [model, controlScan(scan, model).rows.filter(r => r.eligible).sort((a,b) => a.rank! - b.rank!).slice(0,40).map(r => ({ ts_code:r.ts_code,score:r.score,rank:r.rank }))]));
        const now = new Date().toISOString();
        const freezeId=arg('freeze-id') ?? loadActiveValidationFreeze({dbPath:researchPath,asOf,implementationHash:identity.implementation_hash,ruleHash:hash({rules:SCORE_RULES,pool:WATCHLIST_RULES,models:CONTROL_MODELS}),costHash:hash(costs)})?.id;
        if(!freezeId) return {status:'UNAVAILABLE',reason:'matching_active_freeze_unavailable',evidence_level:'UNVERIFIED',as_of:asOf};
        return appendObservation(research, { freeze_id: freezeId, date: asOf, created_at: now, next_open: `${next.slice(0,4)}-${next.slice(4,6)}-${next.slice(6,8)}T09:30:00+08:00`,
          rule_hash: hash({ rules:SCORE_RULES,pool:WATCHLIST_RULES,models:CONTROL_MODELS }), cost_hash: hash(costs), implementation_hash: identity.implementation_hash, original: true,
          content: { source_report: latestReport, models, note: 'Frozen top40 rankings; daily stateful watchlist observations remain in the existing forward snapshot chain. This record makes no performance claim.' } });
      } finally { research.close(); }
    }
    if (command === 'evaluate') {
      const research=openValidationDb(researchPath,source);
      try {
        const freezeId=required('freeze-id');
        const frozen=research.prepare('SELECT protocol FROM validation_freeze WHERE id=?').get(freezeId) as {protocol:string}|undefined;
        if(!frozen) throw new Error('Unknown freeze');
        const freeze=JSON.parse(frozen.protocol);
        if(freeze.implementation_hash!==identity.implementation_hash || freeze.cost_hash!==hash(costs)) throw new Error('Frozen evaluation implementation or costs differ; create a new protocol rather than silently changing observations');
        const rows=research.prepare('SELECT id,date,type,content,recorded_at FROM validation_observation WHERE freeze_id=? AND date<=? ORDER BY date,created_at,id').all(freezeId,asOf) as {id:string;date:string;type:string;content:string;recorded_at:string|null}[];
        const cohorts=rows.filter(r=>r.type==='TRUE_FORWARD_OBSERVATION' && r.recorded_at!==null);
        const evaluation=freeze.horizons.flatMap((horizon:number)=>CONTROL_MODELS.map(model=>{
          const selected=cohorts.flatMap(row=>{
            const observation=JSON.parse(row.content);
            return (observation.content.models[model] as {ts_code:string;score:number}[]).map(m=>({date:row.date,ts_code:m.ts_code,score:m.score}));
          });
          const evaluated=evaluateEvents(db,selected,{asOf,horizon,buyFeeBps:costs.buy_fee_bps,sellFeeBps:costs.sell_fee_bps,slippageBps:costs.slippage_bps,maxExitDelay:costs.max_exit_delay});
          return {model,horizon,summary:evaluated.summary,inference:blockInference(evaluated.summary.by_date.map(d=>d.excess.equal_market),horizon+costs.max_exit_delay)};
        }));
        const result={version:VALIDATION_VERSION,freeze_id:freezeId,type:'TRUE_FORWARD_OBSERVATION',as_of:asOf,evidence_level:'UNVERIFIED',observations:cohorts.map(r=>r.id),excluded_retrospective:rows.length-cohorts.length,evaluation,
          note:'Only original, timely observations matching the precommitted rules/costs/build are included. Immature or insufficient evidence does not establish an investment advantage.'};
        return {id:registryStore(research,result),...result};
      } finally {research.close();}
    }
    if (command !== 'audit' && command !== 'study') throw new Error(`Unsupported validation command: ${command}`);
    const audit = auditWatchlist(db, asOf);
    const legacy = audit.start ? evaluateWatchlist(db, audit.start, asOf, 5) : null;
    const result: Record<string, unknown> = { ...protocol, as_of: asOf, type: 'RETROSPECTIVE_HOLDOUT', evidence_level:'UNVERIFIED', audit, legacy,
      identity: { schema: VALIDATION_VERSION, source_cutoff: (db.prepare('SELECT MAX(trade_date) d FROM daily WHERE trade_date<=?').get(asOf) as any)?.d ?? null },
      interpretation:'No production weights changed. Negative historical results remain visible; historical validation is not untouched out-of-sample evidence.' };
    if (command === 'study') {
      const stride = Number(arg('stride','5')), maxDates = Number(arg('max-dates','100000'));
      if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(maxDates) || maxDates < 2) throw new Error('Invalid study sampling; max-dates must be >=2');
      const days = (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date BETWEEN (SELECT MIN(trade_date) FROM daily) AND ? ORDER BY cal_date').all(asOf) as {cal_date:string}[]).map(r=>r.cal_date);
      const dates = sampleValidationDates(days,stride,maxDates);
      const split = arg('split','20260331')!;
      const options = { asOf, horizon:5, buyFeeBps:costs.buy_fee_bps,sellFeeBps:costs.sell_fee_bps,slippageBps:costs.slippage_bps,maxExitDelay:costs.max_exit_delay };
      const events = new Map(CONTROL_MODELS.map(m => [m, [] as EvaluationEvent[]]));
      const signalEvents: EvaluationEvent[] = [];
      const states = CONTROL_MODELS.map(() => {
        const state = new DatabaseSync(':memory:');
        state.exec('CREATE TABLE trade_cal(cal_date TEXT,is_open INTEGER); CREATE TABLE watchlist(trade_date TEXT,ts_code TEXT,score REAL,rank INTEGER,industry TEXT,status TEXT,reason TEXT,entered_on TEXT); CREATE TABLE watchlist_change(trade_date TEXT,ts_code TEXT,action TEXT,score REAL,rank INTEGER,reason TEXT,PRIMARY KEY(trade_date,ts_code,action)); CREATE TABLE stock_score(trade_date TEXT,ts_code TEXT,score REAL,rank INTEGER,detail TEXT);');
        const ins = state.prepare('INSERT INTO trade_cal VALUES(?,1)'); for (const date of days) ins.run(date);
        return state;
      });
      const concentration: Record<string, unknown>[] = [];
      const scanDigests: Record<string,string> = {};
      try {
        for (const date of dates) {
          const scan = scanMarket(db,date);
          scanDigests[date]=hash(scan);
          signalEvents.push(...scan.rows.filter(r=>r.eligible && r.signals.length).map(r=>({ date,ts_code:r.ts_code,industry:r.industry,signals:r.signals })));
          for (const [k,model] of CONTROL_MODELS.entries()) {
            const variant = controlScan(scan,model), pool = updateWatchlist(states[k],variant);
            const byCode = new Map(variant.rows.map(r=>[r.ts_code,r]));
            events.get(model)!.push(...pool.members.map(m=>({date,ts_code:m.ts_code,industry:m.industry,score:m.score,factors:byCode.get(m.ts_code)?.components})));
            const counts=Object.values(pool.industry_distribution);
            concentration.push({date,model,members:pool.members.length,industry_hhi:pool.members.length?counts.reduce((s,n)=>s+(n/pool.members.length)**2,0):null,adds:pool.changes.filter(c=>c.action==='add').length,removes:pool.changes.filter(c=>c.action==='remove').length});
          }
        }
      } finally { for (const state of states) state.close(); }
      const splitResult = splitDates(days,dates,split,5,costs.max_exit_delay);
      const regimes=regimeSeries(db,asOf);
      const comparisons: Record<string,unknown>[]=[];
      const hypotheses: { id:string;p_value:number|null }[]=[];
      for (const model of CONTROL_MODELS) {
        const all=events.get(model)!;
        for (const [segment,selected,cutoff] of [['formation',splitResult.formation,split],['retrospective_validation',splitResult.validation,asOf]] as const) {
          const selectedSet=new Set(selected), sample=all.filter(e=>selectedSet.has(e.date));
          const evaluated=evaluateEvents(db,sample,{...options,asOf:cutoff});
          const cohorts=evaluated.summary.by_date;
          const inference=blockInference(cohorts.map(c=>c.excess.equal_market),Math.max(1,Math.ceil((5+costs.max_exit_delay)/stride)));
          const byRegime=Object.fromEntries(['uptrend','downtrend','range'].map(rg=>[rg,{dates:cohorts.filter(c=>regimes.get(c.date)===rg).length,net_return:distribution(cohorts.filter(c=>regimes.get(c.date)===rg).map(c=>c.net_return)),excess:distribution(cohorts.filter(c=>regimes.get(c.date)===rg).map(c=>c.excess.equal_market))}]));
          comparisons.push({model,segment,summary:evaluated.summary,inference,by_regime:byRegime});
          hypotheses.push({id:`model:${model}:${segment}`,p_value:inference.p_value});
        }
      }
      const signals: Record<string,unknown>[]=[];
      for (const horizon of [5,10,20]) {
        const splitResult=splitDates(days,dates,split,horizon,costs.max_exit_delay);
        for (const [segment,selected,cutoff] of [['formation',splitResult.formation,split],['retrospective_validation',splitResult.validation,asOf]] as const) {
          const selectedSet=new Set(selected);
          const evaluated=evaluateEvents(db,signalEvents.filter(e=>selectedSet.has(e.date)),{...options,horizon,asOf:cutoff});
          for (const signal of SIGNAL_DEFINITIONS) for (const rg of ['all','uptrend','downtrend','range']) {
            const rows=evaluated.outcomes.filter(o=>(o.event.signals as string[]).includes(signal.id) && (rg==='all'||regimes.get(o.event.date)===rg));
            const byDate=new Map<string,number[]>();
            for(const o of rows) if(o.status==='completed' && finite(o.excess.equal_market)) {const a=byDate.get(o.event.date)??[];a.push(o.excess.equal_market);byDate.set(o.event.date,a);}
            const eventDates=[...new Set(rows.map(o=>o.event.date))].sort();
            const dateMeans=eventDates.map(date=>{const v=byDate.get(date);return v?.length?v.reduce((s,x)=>s+x,0)/v.length:null;});
            const inference=blockInference(dateMeans,Math.max(1,Math.ceil((horizon+costs.max_exit_delay)/stride)));
            const id=`signal:${signal.id}:${horizon}:${segment}:${rg}`;
            signals.push({id,signal:signal.id,direction:signal.direction,horizon,segment,regime:rg,events:rows.length,completed:rows.filter(o=>o.status==='completed').length,dates:byDate.size,excess:distribution(dateMeans),inference});
            hypotheses.push({id,p_value:inference.p_value});
          }
        }
      }
      const fee: ResearchFee = injectedFee ?? (order => {
        const rules=resolveFeeRules({code:order.ts_code,kind:'STOCK',asOf:order.date});
        // Price already includes adverse slippage; avoid charging the estimate twice.
        const quote=calculateFees(order.price_cents*order.quantity,order.side==='BUY'?'buy':'sell',{...rules,slippage_rate_per_side:0});
        return {total_cents:quote.actual_fee_estimate_cents ?? quote.commission_cents+quote.transfer_fee_cents+quote.stamp_duty_cents,version:quote.fee_model?.version,evidence:quote.fee_model?.evidence};
      });
      const funded=Object.fromEntries(CONTROL_MODELS.map(model=>[model,simulateFunded(db,dates.map(date=>({date,codes:events.get(model)!.filter(e=>e.date===date).map(e=>e.ts_code)})),{asOf,initial_cents:Number(arg('initial-cents','7600000')),horizon:5,max_exit_delay:costs.max_exit_delay,slippage_bps:costs.slippage_bps,fee})]));
      const walkForward = walkForwardFolds(days,dates,split,20,5,costs.max_exit_delay).map(fold => ({ ...fold,
        models: Object.fromEntries(CONTROL_MODELS.map(model => {
          const selected = new Set(fold.validation);
          const evaluated = evaluateEvents(db,events.get(model)!.filter(e=>selected.has(e.date)),options);
          return [model,{summary:evaluated.summary,inference:blockInference(evaluated.summary.by_date.map(d=>d.excess.equal_market),Math.max(1,Math.ceil(10/stride)))}];
        })) }));
      Object.assign(result,{study:{stride,max_dates:maxDates,sampling:'stride grid, then deterministic coverage across full history if capped; never latest-only truncation',sampled_dates:dates,input_scan_sha256:scanDigests,split:splitResult,walk_forward:walkForward,comparisons,signals,multiple_testing:holmAdjust(hypotheses),concentration,funded,
        limitations:['Sampled rebalance histories have their own state and are not the deployed daily pool.','Block length is measured in sampled observation dates, with an exit-delay buffer. Regime and signal subsets can have irregular spacing.','No fitting or parameter optimization was performed. WALK_FORWARD_VALIDATION requires a predeclared rolling schedule; this run is RETROSPECTIVE_HOLDOUT.','Industry and ST metadata use current stock_basic; original data vintages and complete delisted history cannot be reconstructed.','Event cost scenarios are not capital-funded returns; funded results are separate and stop when required corporate entitlement data is absent.']}});
    }
    mkdirSync(output,{recursive:true});
    mkdirSync(resolve(researchPath,'..'),{recursive:true});
    const registry=openValidationDb(researchPath,source);
    let id: string;
    try { id=registryStore(registry,result); } finally {registry.close();}
    const evidence={id,...result};
    const file=join(output,`${id}.json`);
    if (resolve(file)===source) throw new Error('Output aliases source');
    writeFileSync(file,JSON.stringify(evidence,null,2));
    writeFileSync(join(output,'run.json'),JSON.stringify(loadValidationSummary({dbPath:researchPath,id,asOf}),null,2));
    return {status:result.audit && (audit.cohorts.length===0)?'DATA_INSUFFICIENT':'RESEARCH_ONLY',id,evidence_path:file,as_of:asOf,
      legacy:legacy?{dates:legacy.dates,mean_excess_pct:legacy.mean_excess_pct,hit_rate:legacy.hit_rate,pending_dates:legacy.pending_dates}:null,
      corrected:{dates:audit.cohorts.length,mean_excess_pct:audit.mean_excess_pct,win_rate:audit.win_rate},sampled_study:command==='study'};
  } finally {db.close();}
}
