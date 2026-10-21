import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blockInference, holmAdjust, splitDates, walkForwardFolds, controlScan, openValidationDb, registerFreeze, appendObservation, simulateFunded, auditWatchlist, sampleValidationDates, loadActiveValidationFreeze } from '../build/ashare/validation.js';
import { openAshareDb, upsertRows } from '../build/ashare/db.js';
import { seedMarket, weekdays } from './ashare-fixture.mjs';
import { scanMarket } from '../build/ashare/analysis.js';

test('block inference is reproducible, respects missing dates and does not invent independent evidence',()=>{
  const values=Array.from({length:80},(_,i)=>0.01+0.003*Math.sin(i/3));
  const a=blockInference(values,5,499,42);
  assert.deepEqual(a,blockInference(values,5,499,42));
  assert.ok(a.ci95[0]>0 && a.p_value<0.05);
  assert.equal(a.nominal_blocks,16);
  assert.equal(blockInference([1,2,3],5).ci95,null);
  assert.equal(blockInference([...values,null],5).status,'DATA_INSUFFICIENT');
  assert.throws(()=>blockInference(values,0));
});

test('Holm preserves the full declared family and monotone adjusted p values',()=>{
  const a=holmAdjust([{id:'a',p_value:0.01},{id:'b',p_value:0.04},{id:'c',p_value:null}]);
  assert.equal(a[0].p_holm,0.03); assert.equal(a[1].p_holm,0.08); assert.equal(a[2].p_holm,null);
  assert.throws(()=>holmAdjust([{id:'a',p_value:1.1}]));
});

test('purging includes holding horizon and delayed exits; folds never use validation labels in formation',()=>{
  const days=weekdays('20260105',80);
  const a=splitDates(days,days,days[30],5,3);
  assert.equal(a.formation.at(-1),days[22]);
  assert.equal(a.purged.length,8); assert.equal(a.pending.length,8);
  const folds=walkForwardFolds(days,days,days[30],10,5,3);
  for(const f of folds) assert.ok(f.formation.every(d=>days[days.indexOf(d)+8]<=f.split));
  assert.ok(folds.every(f=>f.validation.every(d=>d>f.split)));
  assert.throws(()=>splitDates(days,days,days[30],5,0,'TRUE_FORWARD_OBSERVATION'));
});

test('limited sampling covers early formation and late validation instead of only recent dates',()=>{
  const days=weekdays('20240101',650), dates=sampleValidationDates(days,5,12);
  assert.equal(dates.length,12);assert.equal(dates[0],days[129]);assert.ok(dates.at(-1)>days[600]);
  assert.equal(new Set(dates).size,12);assert.throws(()=>sampleValidationDates(days,5,1));
});

test('control models never mutate source scan or original scores',()=>{
  const db=openAshareDb(':memory:');
  try {const days=weekdays('20250106',180);seedMarket(db,days); const scan=scanMarket(db,days.at(-1));const before=JSON.stringify(scan);
    const original=controlScan(scan,'original'); assert.deepEqual(original.rows.map(r=>r.score),scan.rows.map(r=>r.score));
    const equal=controlScan(scan,'equal_dimensions'); assert.equal(JSON.stringify(scan),before);
    assert.ok(equal.rows.filter(r=>r.eligible).every(r=>r.score>=0 && r.score<=100));
    assert.throws(()=>controlScan(scan,'unknown'));
  } finally {db.close();}
});

test('freeze registry is immutable and after-open or changed-rule observations cannot become true forward',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T12:00:00Z')});
  const dir=mkdtempSync(join(tmpdir(),'validation-freeze-')),source=join(dir,'source.sqlite'),path=join(dir,'research.sqlite');
  new DatabaseSync(source).close();
  assert.throws(()=>openValidationDb(source,source),/同一文件/);
  const db=openValidationDb(path,source),h='a'.repeat(64);
  try {
    const p={start:'20261022',frozen_at:'2026-10-21T12:00:00Z',rule_hash:h,cost_hash:h,implementation_hash:h,horizons:[5]};
    const f=registerFreeze(db,p);assert.equal(registerFreeze(db,p).id,f.id);
    assert.equal(loadActiveValidationFreeze({dbPath:path,asOf:'20261022',implementationHash:h})?.id,f.id);
    assert.equal(loadActiveValidationFreeze({dbPath:path,asOf:'20261021'}),null);
    assert.equal(loadActiveValidationFreeze({dbPath:path,asOf:'20261022',implementationHash:'b'.repeat(64)}),null);
    assert.throws(()=>db.prepare('UPDATE validation_freeze SET protocol=?').run('{}'),/immutable/);
    assert.throws(()=>registerFreeze(db,{...p,start:'20261020'}),/precede/);
    const input={freeze_id:f.id,date:'20261022',created_at:'2026-10-22T16:00:00+08:00',next_open:'2026-10-23T09:30:00+08:00',rule_hash:h,cost_hash:h,implementation_hash:h,original:true,content:{pool:[]}};
    t.mock.timers.setTime(Date.parse(input.created_at));
    const observed=appendObservation(db,input);
    assert.equal(observed.type,'TRUE_FORWARD_OBSERVATION');
    assert.throws(()=>db.prepare('INSERT OR REPLACE INTO validation_freeze(id,created_at,protocol) SELECT id,created_at,? FROM validation_freeze WHERE id=?').run('{}',f.id),/immutable/);
    assert.throws(()=>db.prepare('INSERT OR REPLACE INTO validation_observation(id,freeze_id,date,created_at,type,content) SELECT id,freeze_id,date,created_at,type,? FROM validation_observation WHERE id=?').run('{}',observed.id),/immutable/);
    t.mock.timers.setTime(Date.parse('2026-10-23T09:30:00+08:00'));
    assert.equal(appendObservation(db,{...input,created_at:'2026-10-23T09:30:00+08:00'}).type,'RETROSPECTIVE_HOLDOUT');
    assert.equal(appendObservation(db,{...input,rule_hash:'b'.repeat(64)}).type,'RETROSPECTIVE_HOLDOUT');
    assert.throws(()=>db.prepare('DELETE FROM validation_observation').run(),/immutable/);
  } finally {db.close();}
});

test('historical timestamps supplied today cannot manufacture true forward evidence',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T12:00:00Z')});
  const dir=mkdtempSync(join(tmpdir(),'validation-backdate-')),db=openValidationDb(join(dir,'research.sqlite'),join(dir,'market.sqlite')),h='a'.repeat(64);
  try {
    assert.throws(()=>registerFreeze(db,{start:'20260105',frozen_at:'2026-01-01T00:00:00Z',rule_hash:h,cost_hash:h,implementation_hash:h,horizons:[5]}),/backdate/);
    const f=registerFreeze(db,{start:'20261022',frozen_at:new Date().toISOString(),rule_hash:h,cost_hash:h,implementation_hash:h,horizons:[5]});
    const r=appendObservation(db,{freeze_id:f.id,date:'20260105',created_at:'2026-01-05T16:00:00+08:00',next_open:'2026-01-06T09:30:00+08:00',rule_hash:h,cost_hash:h,implementation_hash:h,original:true,content:{}});
    assert.equal(r.type,'RETROSPECTIVE_HOLDOUT');assert.equal(r.timely,false);
  }finally{db.close();}
});

function fundedFixture(){
  const db=openAshareDb(':memory:'),days=weekdays('20260105',10),code='600001.SH';
  upsertRows(db,'trade_cal',['cal_date','is_open'],days.map(cal_date=>({cal_date,is_open:1})));
  for(const date of days){
    upsertRows(db,'daily',['ts_code','trade_date','open','close','vol'],[{ts_code:code,trade_date:date,open:10,close:10,vol:10000}]);
    upsertRows(db,'adj_factor',['ts_code','trade_date','adj_factor'],[{ts_code:code,trade_date:date,adj_factor:1}]);
    upsertRows(db,'stk_limit',['ts_code','trade_date','up_limit','down_limit'],[{ts_code:code,trade_date:date,up_limit:11,down_limit:9}]);
  }
  return {db,days,code};
}
const fee=()=>({total_cents:500,version:'synthetic-flat-fee'});

test('funded simulation uses cents, lots, actual fees, conservative cash and T+1',()=>{
  const {db,days,code}=fundedFixture();
  try {const a=simulateFunded(db,[{date:days[0],codes:[code]}],{asOf:days.at(-1),initial_cents:200000,horizon:5,max_exit_delay:0,slippage_bps:0,fee});
    assert.equal(a.order_count,2);assert.equal(a.orders[0].quantity,100);assert.equal(a.orders[0].date,days[1]);assert.equal(a.orders[1].date,days[5]);
    assert.equal(a.fees_cents,1000);assert.equal(a.slippage_cents,0);assert.equal(a.final_nav_cents,199000);assert.ok(a.nav.every(n=>n.cash_cents>=0));
    assert.throws(()=>simulateFunded(db,[{date:days[1],codes:[code]},{date:days[0],codes:[code]}],{asOf:days.at(-1),initial_cents:200000,horizon:5,max_exit_delay:0,slippage_bps:0,fee}),/increasing/);
    const poor=simulateFunded(db,[{date:days[0],codes:[code]}],{asOf:days.at(-1),initial_cents:100000,horizon:5,max_exit_delay:0,slippage_bps:0,fee});
    assert.equal(poor.order_count,0);assert.equal(poor.skipped.insufficient_cash_for_lot,1);
  } finally {db.close();}
});

test('corporate entitlement and unknown exit constraints stop funded claims instead of imputing profitable exits',()=>{
  const {db,days,code}=fundedFixture();
  try {db.prepare('UPDATE adj_factor SET adj_factor=2 WHERE trade_date=?').run(days[3]);
    const a=simulateFunded(db,[{date:days[0],codes:[code]}],{asOf:days.at(-1),initial_cents:200000,horizon:5,max_exit_delay:0,slippage_bps:0,fee});
    assert.equal(a.status,'DATA_INSUFFICIENT');assert.equal(a.net_return,null);assert.equal(a.failure,'corporate_action_entitlement_unavailable');
  } finally {db.close();}
});

test('a missing holding adjustment factor cannot silently produce a funded return',()=>{
  const {db,days,code}=fundedFixture();
  try { db.prepare('DELETE FROM adj_factor WHERE trade_date=?').run(days[3]);
    const a=simulateFunded(db,[{date:days[0],codes:[code]}],{asOf:days.at(-1),initial_cents:200000,horizon:5,max_exit_delay:0,slippage_bps:0,fee});
    assert.equal(a.failure,'held_adjustment_factor_unavailable');assert.equal(a.net_return,null);
  } finally {db.close();}
});

test('audit explicitly counts missing members and SQL NULL benchmark returns',()=>{
  const {db,days,code}=fundedFixture();
  try {
    const insert=db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
    insert.run(days[0],code,'new','synthetic',days[0]);
    insert.run(days[0],'600002.SH','new','synthetic',days[0]);
    const a=auditWatchlist(db,days[5],60,5);
    assert.equal(a.cohorts[0].selected,2);assert.equal(a.cohorts[0].priced,1);assert.equal(a.cohorts[0].unresolved,1);
    assert.equal(a.cohorts[0].excess,null,'the production minimum reference universe is retained');
  } finally {db.close();}
});
