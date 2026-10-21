import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openAshareDb } from '../build/ashare/db.js';
import { runValidationCommand } from '../build/ashare/validationCli.js';
import { loadValidationSummary } from '../build/ashare/validation.js';

const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
test('audit CLI persists an independent reproducible result, preserves market bytes and refuses source alias',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'validation-cli-')),source=join(dir,'market.sqlite'),output=join(dir,'output');
  const db=openAshareDb(source);db.close();const before=hash(source);
  const args=['audit','--source',source,'--as-of','20261020','--output',output];
  const a=await runValidationCommand(args),b=await runValidationCommand(args);
  assert.equal(a.status,'DATA_INSUFFICIENT');assert.equal(a.id,b.id);assert.equal(hash(source),before);
  const evidence=JSON.parse(readFileSync(a.evidence_path,'utf8'));
  assert.equal(evidence.type,'RETROSPECTIVE_HOLDOUT');assert.equal(evidence.evidence_level,'UNVERIFIED');assert.equal(evidence.audit.mean_excess_pct,null);
  const summary=loadValidationSummary({dbPath:join(output,'validation.sqlite'),id:a.id,asOf:'20261020'});
  assert.equal(summary.id,a.id);assert.equal(summary.evidence_level,'UNVERIFIED');
  const registryBefore=hash(join(output,'validation.sqlite'));
  loadValidationSummary({dbPath:join(output,'validation.sqlite'),id:a.id,asOf:'20261020'});
  assert.equal(hash(join(output,'validation.sqlite')),registryBefore,'loading a summary cannot change registry bytes');
  assert.equal(JSON.parse(readFileSync(join(output,'run.json'),'utf8')).id,a.id);
  assert.equal(loadValidationSummary({dbPath:join(output,'validation.sqlite'),asOf:'20261019'}).status,'UNAVAILABLE');
  await assert.rejects(()=>runValidationCommand(['audit','--source',source,'--output',output]),/as-of required/);
  await assert.rejects(()=>runValidationCommand([...args,'--research-db',source]),/同一文件/);
  assert.equal(hash(source),before);
});

test('freeze CLI cannot backdate an already observed day into a new forward protocol',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'validation-cli-freeze-')),source=join(dir,'market.sqlite');
  const db=openAshareDb(source);db.close();
  await assert.rejects(()=>runValidationCommand(['freeze','--source',source,'--research-db',join(dir,'research.sqlite'),'--start','20200101']),/backdated/);
});
