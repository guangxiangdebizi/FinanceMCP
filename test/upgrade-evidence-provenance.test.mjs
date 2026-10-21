import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { recordResearchEvidence, verifyResearchEvidence } from '../build/portfolio/evidence.js';

const fixture = {
  evidence_id:'synthetic-evidence', kind:'ROTATION', buy_code:'510300.SH', sell_code:'510500.SH',
  strategy_id:'frozen-test-rule', as_of:'20261020', valid_until:'20261023', status:'VERIFIED', recorded_by:'offline-test',
  provenance:{ source:'synthetic-validation', rule_version:'rule-1', claim:'lower-risk-at-comparable-return',
    validation_run_id:'synthetic-validation-run', observation_type:'WALK_FORWARD_VALIDATION' },
};

test('strict evidence binds kind, source, version and advantage claim to stored metadata',()=>{
  const db = new DatabaseSync(':memory:');
  try {
    recordResearchEvidence(db,fixture,{confirm:true});
    const options={buyCode:'510300.SH',sellCode:'510500.SH',asOf:'20261021',requireProvenance:true,
      expectedKind:'ROTATION',expectedStrategyId:'frozen-test-rule',expectedSource:'synthetic-validation',
      expectedRuleVersion:'rule-1',expectedClaim:'lower-risk-at-comparable-return'};
    assert.equal(verifyResearchEvidence(db,{evidence_id:fixture.evidence_id},options).verified,true);
    for (const [field,bad] of [['expectedKind','ENTRY'],['expectedSource','caller-fabricated'],['expectedRuleVersion','rule-2'],['expectedClaim','promises-profit']]) {
      const result=verifyResearchEvidence(db,{evidence_id:fixture.evidence_id},{...options,[field]:bad});
      assert.equal(result.verified,false);
      assert.equal(result.reason,'evidence_provenance_mismatch');
    }
    assert.equal(verifyResearchEvidence(db,{evidence_id:'invented-id',status:'RESEARCH_VERIFIED'},options).verified,false);
  }finally{db.close();}
});

test('legacy rows remain readable but cannot satisfy strict provenance; IDs immutable',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    recordResearchEvidence(db,{...fixture,provenance:undefined},{confirm:true});
    assert.equal(verifyResearchEvidence(db,{evidence_id:fixture.evidence_id},{buyCode:'510300.SH',asOf:'20261021'}).verified,false); // sell leg is required
    const legacy=verifyResearchEvidence(db,{evidence_id:fixture.evidence_id},{buyCode:'510300.SH',sellCode:'510500.SH',asOf:'20261021'});
    assert.equal(legacy.verified,true);
    assert.equal(verifyResearchEvidence(db,{evidence_id:fixture.evidence_id},{buyCode:'510300.SH',sellCode:'510500.SH',asOf:'20261021',requireProvenance:true}).verified,false);
    assert.throws(()=>recordResearchEvidence(db,fixture,{confirm:true}),/拒绝覆盖/);
  } finally {db.close();}
});
