import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const dir=mkdtempSync(join(tmpdir(),'research-bundle-'));
process.env.ASHARE_DATA_DIR=dir;
process.env.ASHARE_DB_PATH=join(dir,'market.sqlite');
const {openAshareDb,upsertRows}=await import('../build/ashare/db.js');
const {seedMarket,weekdays}=await import('./ashare-fixture.mjs');
const {openPortfolioDb}=await import('../build/portfolio/db.js');
const {DEMO_SNAPSHOT,importSnapshot,markSnapshotCurrent}=await import('../build/portfolio/account.js');
const {initBaseline,confirmRealAccount}=await import('../build/portfolio/ledger.js');
const {buildInvestmentResearchBundle}=await import('../build/portfolio/researchBundle.js');
const {getPrivateToolList,getAvailableToolList}=await import('../build/dispatch.js');

function fixture() {
  const market=openAshareDb(':memory:');
  const dates=weekdays('20260701',80).filter(d=>d<='20261020');
  seedMarket(market,dates);
  // Include all target-calendar states without fabricating a current-session bar.
  for(const [d,o] of [['20261020',1],['20261021',1],['20261024',0],['20261025',0]]) market.prepare('INSERT OR REPLACE INTO trade_cal(cal_date,is_open) VALUES(?,?)').run(d,o);
  // Ensure last day is populated by the synthetic data generator.
  if(!dates.includes('20261020')) throw new Error('fixture needs 20261020');
  for(const position of DEMO_SNAPSHOT.positions){
    upsertRows(market,'fund_basic',['ts_code','name','market','status','fund_type','invest_type'],[
      {ts_code:position.ts_code,name:'Synthetic ETF',market:'E',status:'L',fund_type:'股票型',invest_type:'被动指数型'}]);
    for(const date of dates){
      const code=position.ts_code;
      upsertRows(market,'fund_daily',['ts_code','trade_date','open','high','low','close','pre_close','pct_chg','vol','amount'],[
        {ts_code:code,trade_date:date,open:1,high:1,low:1,close:1,pre_close:1,pct_chg:0,vol:1000,amount:10000}]);
      upsertRows(market,'fund_adj',['ts_code','trade_date','adj_factor'],[{ts_code:code,trade_date:date,adj_factor:1}]);
      upsertRows(market,'fund_share',['ts_code','trade_date','fd_share'],[{ts_code:code,trade_date:date,fd_share:100000}]);
    }
  }
  const privateDir=mkdtempSync(join(dir,'account-'));
  const p=openPortfolioDb(join(privateDir,'portfolio.sqlite'),{marketPath:join(dir,'unrelated.sqlite')});
  const id='synthetic-bundle-baseline';
  importSnapshot(p,{...DEMO_SNAPSHOT,snapshot_id:id,as_of:'2026-10-16',source:'synthetic-test'});
  initBaseline(p,'synthetic-account',{asOf:'20261016',snapshotId:id});
  markSnapshotCurrent(p,id,{confirmedBy:'fixture'});
  confirmRealAccount(p,'synthetic-account',{confirm:true});
  const path=join(dir,'synthetic-report.json');
  writeFileSync(path,JSON.stringify({report_id:'synthetic-market-report',as_of_trade_date:'20261020',status:'READY',versions:{score:'frozen-test'},
    market:{regime:'range',regime_label:'synthetic',breadth:{},indices:[],judgement:[]},sectors:{top:[],bottom:[],all:[]},
    watchlist:{count:40,members:[],added:[],removed:[],track_record:{mean_excess_pct:-1.68,hit_rate:0.217}},signals:{market_summary:[]}}));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run('synthetic-market-report','20261020','READY','2026-10-20T13:10:00Z',path,'live');
  return {market,p};
}

function build(f,extra={}){return buildInvestmentResearchBundle({portfolioDb:f.p,marketDb:f.market,now:new Date('2026-10-21T01:00:00Z'),...extra});}

test('bundle uses latest closed session pre-open, preserves negative watchlist evidence and separate account risk',()=>{
 const f=fixture();try{
  const before=f.p.prepare('SELECT COUNT(*) n FROM account_event').get().n;
  const result=build(f);
  assert.equal(result.as_of_trade_date,'20261020');
  assert.equal(result.data_quality.market.status,'READY');
  // The bundle carries the approved benchmark version and status even when component prices are missing.
  assert.equal(result.rules.benchmark,'r2-benchmarks-1.1.0');
  assert.equal(result.benchmarks.basket_definition.status,'approved');
  assert.equal(result.benchmarks.basket_definition.approved_on,'20261022');
  assert.equal(result.benchmarks.basket_definition.comparison_basis,'RETROSPECTIVE_COMPARISON');
  assert.match(result.rules.benchmark_status,/^approved:20261022:RETROSPECTIVE_COMPARISON$/);
  assert.equal(result.benchmarks.benchmarks.find(b=>b.id==='frozen_multi_asset_basket').status,'UNAVAILABLE');
  assert.match(result.markdown_summary,/基准: r2-benchmarks-1\.1\.0 approved/);
  assert.equal(result.watchlist.historical_effectiveness.mean_excess_pct,-1.68);
  assert.equal(result.evidence_status,'UNVERIFIED');
  assert.equal(result.account_status,'REAL_ACCOUNT_VERIFIED');
  assert.equal(result.portfolio.gate.unreported_trade_risk,true);
  assert.equal(result.portfolio.actionable,false);
  assert.equal(result.status,'DEGRADED');
  assert.equal(f.p.prepare('SELECT COUNT(*) n FROM account_event').get().n,before);
  assert.equal(f.p.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('research_journal','plan_tracking')").get().n,0);
  assert.ok(result.markdown_summary.includes(result.report_id));
  assert.equal(result.boundaries.external_research,'NOT_ACQUIRED');
 }finally{f.market.close();f.p.close();}
});

test('explicit unclosed date has no current-session judgement or stale substitute',()=>{
 const f=fixture();try{
  const result=build(f,{asOfTradeDate:'20261021'});
  assert.equal(result.status,'DATA_INSUFFICIENT');
  assert.equal(result.session.reason,'session_not_closed');
  assert.equal(result.market.available,false);
  assert.equal(result.watchlist,null);
  assert.equal(result.portfolio,null);
 }finally{f.market.close();f.p.close();}
});

test('missing current market data refuses judgement even when prior report exists',()=>{
 const f=fixture();try{
  f.market.prepare('DELETE FROM daily WHERE trade_date=?').run('20261020');
  const result=build(f);
  assert.equal(result.status,'DATA_INSUFFICIENT');
  assert.equal(result.market.available,false);
  assert.equal(result.portfolio.actionable,false);
  assert.deepEqual(result.portfolio.first_section.actions,[]);
 }finally{f.market.close();f.p.close();}
});

test('bundle ID stable across acquisition time, price/account changes bind identity',()=>{
 const f=fixture();try{
  const first=build(f);
  const second=build(f,{now:new Date('2026-10-21T02:00:00Z')});
  assert.equal(first.report_id,second.report_id);
  assert.notEqual(first.generated_at,second.generated_at);
  assert.throws(()=>build(f,{accountId:'unrelated-account'}),/account_not_configured/);
 }finally{f.market.close();f.p.close();}
});

test('private bundle tool registered only on authenticated tool surface',()=>{
 const saved={...process.env};try{
  process.env.FINANCE_TOOL_PROFILE='ashare_daily';process.env.ASHARE_PORTFOLIO_ENABLED='1';
  delete process.env.FINANCE_ENABLED_TOOLS;
  const privateList=getPrivateToolList();
  assert.ok(privateList.some(tool=>tool.name==='ashare_investment_research_bundle'));
  assert.ok(!getAvailableToolList().some(tool=>tool.name==='ashare_investment_research_bundle'));
  const tool=privateList.find(tool=>tool.name==='ashare_investment_research_bundle');
  assert.equal(tool.annotations.readOnlyHint,true);
 }finally{for(const key of Object.keys(process.env)) if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
