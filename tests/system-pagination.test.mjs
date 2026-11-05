import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SystemJournal,normalizeSystemQuery} from '../src/observability/system-journal.mjs';
import {createSystemOperations,executeSystemOwner} from '../src/observability/system-operations.mjs';

function fixture(t,service='manager',db=new DatabaseSync(':memory:')) {
 t.after(()=>{try{db.close();}catch{}});let at=1000;
 return {journal:new SystemJournal({db,service,now:()=>at}),tick:value=>{at=value;}};
}
const work=(journal,id,extra={})=>journal.work({id,module:'cleanup',state:'retrying',code:'CLEANUP_FAILED',...extra});
const owner=journal=>({journal});

test('opt-in journal totals count every matching record independently of cursor and page size',t=>{
 const {journal,tick}=fixture(t);
 for(let i=0;i<23;i++){tick(1000+i);work(journal,`match-${i}`);}
 work(journal,'unrelated',{module:'runtime'});
 const first=journal.works({module:'cleanup',limit:10,include_total:true});
 assert.equal(first.total,23);assert.equal(first.total_complete,true);assert.equal(first.items.length,10);
 const second=journal.works({module:'cleanup',limit:10,cursor:first.next_cursor,include_total:true});
 assert.equal(second.total,23);assert.equal(second.items.length,10);
 const third=journal.works({module:'cleanup',limit:10,cursor:second.next_cursor,include_total:true});
 assert.equal(third.total,23);assert.equal(third.items.length,3);assert.equal(third.next_cursor,null);
 for(const limit of [20,50,100])assert.equal(journal.works({module:'cleanup',limit,include_total:true}).total,23);
 assert.deepEqual(Object.keys(journal.works()).sort(),['items','next_cursor']);
 assert.deepEqual(Object.keys(journal.works({include_total:false})).sort(),['items','next_cursor']);
 assert.throws(()=>normalizeSystemQuery({include_total:'true'}),{code:'SYSTEM_QUERY_INVALID'});
 assert.throws(()=>journal.works({limit:101,include_total:true}),{code:'SYSTEM_QUERY_INVALID'});
});

test('counts retain service, issue recovery, time, state and literal localized search predicates',t=>{
 const {journal,tick}=fixture(t);
 work(journal,'recover-1');tick(2000);work(journal,'recover-1',{state:'completed'});
 tick(3000);work(journal,'recover-2');tick(4000);work(journal,'recover-2',{state:'completed'});
 tick(5000);work(journal,'recover-2',{state:'idle'});work(journal,'unresolved');
 // A second owner shares the test connection; service must constrain SQL counts.
 const foreign=new SystemJournal({db:journal.db,service:'runner',now:()=>5000});work(foreign,'foreign');
 assert.equal(journal.works({include_total:true}).total,3);
 assert.equal(journal.works({service:'runner',include_total:true}).total,0);
 assert.equal(journal.issues({include_total:true}).total,1);
 assert.equal(journal.issues({resolution:'all',include_total:true}).total,3);
 assert.equal(journal.issues({state:'completed',include_total:true}).total,2);
 assert.equal(journal.issues({resolution:'recovered',state:'idle',resolved_after:3000,after:4500,before:6000,search:'清理',include_total:true}).total,1);
 assert.equal(journal.issues({resolution:'recovered',resolved_after:4500,include_total:true}).total,0);
 assert.equal(journal.works({search:'%',include_total:true}).total,0);
 assert.equal(journal.works({search:'recover_1',include_total:true}).total,0);
 const events=journal.logs({work_id:'manager:work:recover-2',after:3000,before:4500,level:'info',state:'completed',include_total:true,limit:1});
 assert.equal(events.total,1);assert.equal(events.items.length,1);
});

test('concise upgrade work labels find the matching work and its related log events',t=>{
 const {journal}=fixture(t);
 for(const id of ['running-version','version-check','host-upgrade','host-access'])work(journal,id,{module:'upgrade',state:'completed',code:'SYSTEM_OK'});
 for(const [search,id] of [['运行版本','running-version'],['Running version','running-version'],['版本检查','version-check'],['Version check','version-check'],['系统升级','host-upgrade'],['SYSTEM UPGRADE','host-upgrade'],['网页升级服务','host-access'],['Web upgrade service','host-access']]){
  const page=journal.works({search,include_total:true});assert.equal(page.total,1,search);assert.deepEqual(page.items.map(item=>item.id),['manager:work:'+id]);
  const events=journal.logs({search,include_total:true});assert.ok(events.total>0,search);assert.ok(events.items.every(item=>item.work_id==='manager:work:'+id),search);
 }
});

test('federation sums actual filtered owner totals and preserves legacy response shapes',async t=>{
 const journals=Object.fromEntries(['manager','gateway','runner'].map(service=>[service,fixture(t,service).journal]));
 for(const journal of Object.values(journals))for(let i=0;i<12;i++)work(journal,`match-${i}`);
 const ops=createSystemOperations({local:()=>owner(journals.manager),remote:(service,operation,args)=>executeSystemOwner(owner(journals[service]),operation,args)});
 const first=await ops.execute('system_work',{limit:10,include_total:true});
 assert.equal(first.total,36);assert.equal(first.total_complete,true);assert.equal(first.items.length,10);
 const second=await ops.execute('system_work',{limit:10,cursor:first.next_cursor,include_total:true});
 assert.equal(second.total,36);assert.equal(second.total_complete,true);
 const selected=await ops.execute('system_issue',{service:'runner',limit:10,include_total:true});
 assert.equal(selected.total,12);assert.equal(selected.sources.length,1);
 assert.deepEqual(Object.keys(await ops.execute('system_work',{limit:10})).sort(),['items','next_cursor','sources']);
});

test('unavailable and old sources make totals unknown without discarding available records',async t=>{
 const manager=fixture(t).journal,gateway=fixture(t,'gateway').journal;work(manager,'local');work(gateway,'remote');
 for(const behavior of ['offline','old','partial']){
  const ops=createSystemOperations({local:()=>owner(manager),remote:async(service,operation,args)=>{
   if(service==='runner')return executeSystemOwner(owner(fixture(t,'runner').journal),operation,args);
   if(behavior==='offline')throw Error('synthetic unavailable');
   const page=await executeSystemOwner(owner(gateway),operation,args);
   if(behavior==='old'){delete page.total;delete page.total_complete;}
   else page.total_complete=false;
   return page;
  }});
  const result=await ops.execute('system_work',{include_total:true});
  assert.equal(result.total,null,behavior);assert.equal(result.total_complete,false,behavior);
  assert.equal(result.items.length,behavior==='offline'?1:2,behavior);
  assert.equal(result.sources.find(source=>source.service==='gateway').available,behavior!=='offline',behavior);
 }
});

test('malformed foreign totals retain source-unavailable protections',async t=>{
 const gateway=fixture(t,'gateway').journal;work(gateway,'remote');
 for(const count of [{total:-1,total_complete:true},{total:0,total_complete:true},{total:1.5,total_complete:true},{total:null,total_complete:true},{total:1,total_complete:'yes'},{total:1}]){
  const ops=createSystemOperations({local:()=>null,remote:async(service,operation,args)=>{
   const page=await executeSystemOwner(owner(gateway),operation,args);delete page.total;delete page.total_complete;return {...page,...count};
  }});
  const result=await ops.execute('system_work',{service:'gateway',include_total:true});
  assert.equal(result.total,null);assert.equal(result.total_complete,false);assert.equal(result.sources[0].available,false,JSON.stringify(count));
 }
});

test('an exact foreign total cannot contradict a continued source page',async t=>{
 const gateway=fixture(t,'gateway').journal;work(gateway,'remote-1');work(gateway,'remote-2');
 const ops=createSystemOperations({local:()=>null,remote:async(service,operation,args)=>({...await executeSystemOwner(owner(gateway),operation,args),total:1,total_complete:true})});
 const result=await ops.execute('system_work',{service:'gateway',limit:1,include_total:true});
 assert.equal(result.total,null);assert.equal(result.total_complete,false);assert.equal(result.sources[0].available,false);
});

test('verified empty counts remain exact and unsafe federated sums stay unknown',async t=>{
 const journals=Object.fromEntries(['manager','gateway','runner'].map(service=>[service,fixture(t,service).journal]));
 const ops=createSystemOperations({local:()=>owner(journals.manager),remote:(service,operation,args)=>executeSystemOwner(owner(journals[service]),operation,args)});
 const empty=await ops.execute('system_work',{include_total:true});assert.equal(empty.total,0);assert.equal(empty.total_complete,true);
 const overflow=createSystemOperations({local:()=>owner(journals.manager),remote:async(service,operation,args)=>({...await executeSystemOwner(owner(journals[service]),operation,args),total:Number.MAX_SAFE_INTEGER,total_complete:true})});
 const result=await overflow.execute('system_work',{include_total:true});assert.equal(result.total,null);assert.equal(result.total_complete,false);
});
