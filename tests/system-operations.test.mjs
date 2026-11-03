import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {SystemJournal} from '../src/observability/system-journal.mjs';
import {createSystemMaintenance} from '../src/observability/system-maintenance.mjs';
import * as system from '../src/observability/system-operations.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';
import {RuntimeClient} from '../src/runtime/client.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {OperationsClient} from '../src/manager/client.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {createPrivateApi,createTaskApi} from '../src/api.mjs';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {managementTools} from '../src/contracts/management.mjs';

function journal(t,service,now=()=>1000){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return new SystemJournal({db,service,now});}
async function listen(t,server){await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;}
function owner(j){return {journal:j,maintain:createSystemMaintenance({journal:j,actions:{cleanup_retry:async({work})=>j.work({...work,state:'completed',attempted:false})}})};}
const work=j=>j.work({id:'cleanup',module:'cleanup',state:'retrying',code:'CLEANUP_FAILED',allowed_actions:['cleanup_retry']});

test('federation merges equal-time global pages and literal localized searches with explicit partial sources',async t=>{
 const journals=Object.fromEntries(['manager','gateway','runner'].map(s=>[s,journal(t,s)]));for(const j of Object.values(journals)){work(j);j.event({module:'configuration',code:'EACCES'});}
 const seen=[];const ops=system.createSystemOperations({local:()=>owner(journals.manager),remote:async(service,operation,args)=>{seen.push({service,operation,args});return system.executeSystemOwner(owner(journals[service]),operation,args);},now:()=>200000});
 let cursor,ids=[];do{const page=await ops.execute('system_work',{limit:1,...(cursor?{cursor}:{})});ids.push(...page.items.map(x=>x.id));cursor=page.next_cursor;}while(cursor);
 assert.deepEqual(ids,['runner:work:cleanup','manager:work:cleanup','gateway:work:cleanup']);assert.equal(new Set(ids).size,3);
 assert.ok(seen.filter(x=>x.args.cursor).every((x,i,a)=>i%2===0||x.args.cursor===a[i-1].args.cursor));
 assert.equal((await ops.execute('system_logs',{search:'清理'})).items.length,3);
 assert.equal((await ops.execute('system_logs',{search:'权限'})).items.length,3);
 assert.equal((await ops.execute('system_logs',{search:'同步'})).items.length,3);
 assert.equal((await ops.execute('system_logs',{search:'%'})).items.length,0);
 assert.equal((await ops.execute('system_logs',{search:"' OR 1=1 --"})).items.length,0);
 const partial=system.createSystemOperations({local:()=>owner(journals.manager),remote:async s=>s==='gateway'?{items:[{id:'runner:work:forged'}]}:Promise.reject(new Error('/secret/token')),now:()=>200000});
 const page=await partial.execute('system_work',{});assert.equal(page.items.length,1);assert.deepEqual(page.sources.map(s=>s.available),[true,false,false]);assert.ok(!JSON.stringify(page).includes('/secret'));
 const status=await partial.execute('system_status',{});assert.equal(status.summary.complete,false);assert.equal(status.work[0].state,'retrying');assert.equal(status.work[0].verification_required,true);assert.equal(journals.manager.detail(ids[1]).state,'retrying');
});

test('owner selection and revision guards reject arbitrary targets and code-defect repairs; human review preserves state',async t=>{
 const j=journal(t,'runner'),facade=owner(j),w=work(j);
 for(const args of [{id:w.id,revision:w.revision,action:'shell'},{id:w.id,revision:w.revision,action:'cleanup_retry',path:'/tmp'},{id:w.id,revision:w.revision,action:'cleanup_retry',actor:'admin'}])await assert.rejects(system.executeSystemOwner(facade,'maintain',args),{code:'SYSTEM_QUERY_INVALID'});
 await assert.rejects(system.executeSystemOwner(facade,'maintain',{id:'gateway:work:cleanup',revision:1,action:'cleanup_retry'}),{code:'SYSTEM_SOURCE_MISMATCH'});
 const defect=await system.executeSystemOwner(facade,'classify',{id:w.id,revision:w.revision},{actor:'agent'});
 await assert.rejects(system.executeSystemOwner(facade,'maintain',{id:w.id,revision:defect.revision,action:'cleanup_retry'}),{code:'SYSTEM_CODE_DEFECT'});
 await assert.rejects(system.executeSystemOwner(facade,'review',{id:w.id,revision:defect.revision},{actor:'agent'}),{code:'SYSTEM_HUMAN_REQUIRED'});
 await assert.rejects(system.executeSystemOwner(facade,'review',{id:w.id,revision:1},{actor:'admin'}),{code:'SYSTEM_REVISION_CONFLICT'});
 const reviewed=await system.executeSystemOwner(facade,'review',{id:w.id,revision:defect.revision},{actor:'admin'});assert.equal(reviewed.classification,'unknown');assert.equal(reviewed.state,'retrying');assert.equal(reviewed.resolved_at,null);
 assert.ok(j.logs({work_id:w.id}).items.some(e=>e.event==='classification_reviewed'&&e.details.actor==='admin'));
 await system.executeSystemOwner(facade,'maintain',{id:w.id,revision:reviewed.revision,action:'cleanup_retry'},{actor:'admin'});assert.equal(j.detail(w.id).state,'completed');
});

test('Runner fixed system routes authenticate and validate actor envelopes before owner delegation',async t=>{
 const j=journal(t,'runner'),w=work(j),runtime={system:owner(j),journal:j,active:new Map(),launches:new Map()};
 const base=await listen(t,createRuntimeServer({runtime,registry:{},config:{runnerToken:'synthetic-runner'},probe:async()=>({ready:true})}));
 assert.equal((await fetch(base+'/internal/system/status',{method:'POST',body:'{}'})).status,401);
 const client=new RuntimeClient({url:base,token:'synthetic-runner'});
 assert.equal((await client.system('work',{})).items[0].id,w.id);
 const post=body=>fetch(base+'/internal/system/maintain',{method:'POST',headers:{authorization:'Bearer synthetic-runner','content-type':'application/json'},body:JSON.stringify(body)});
 for(const body of [{args:{id:w.id,revision:1,action:'cleanup_retry'},actor:'root'},{args:{id:w.id,revision:1,action:'cleanup_retry'},actor:'admin',path:'/tmp'}])assert.equal((await post(body)).status,400);
 const result=await client.system('maintain',{id:w.id,revision:w.revision,action:'cleanup_retry'},{actor:'agent'});assert.equal(result.work.state,'completed');assert.ok(j.logs().items.some(x=>x.event==='maintenance_requested'&&x.details.actor==='agent'));
 assert.throws(()=>client.system('shell',{}),{code:'SYSTEM_QUERY_INVALID'});
});

test('Admin system reads and mutations use owner retention audit and human-only review is absent from MCP',async t=>{
 const store=new ManagerStore(':memory:');t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'}),w=work(j);
 const operations=createManagerOperations({client:{system:async()=>{throw Error('offline');}},store,configuration:{},metrics:{},models:async()=>[]});operations.system=owner(j);
 const base=await listen(t,createManagerServer({store,agent:{},operations,auth:{authorize:req=>req.headers.cookie==='human'},metrics:{}}));
 const post=(path,body,cookie='human')=>fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 for(let n=0;n<3;n++)assert.equal((await post('/admin/api/operations',{action:'system_status',args:{}})).status,200);
 const draft=await post('/admin/api/operations',{action:'system_issue_draft',args:{id:w.id,revision:w.revision}});assert.equal(draft.status,200);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM manager_actions WHERE conversation_id IS NULL').get().n,0);
 const current=j.detail(w.id),route='/admin/api/system/review';
 assert.equal((await post(route,{id:w.id,revision:current.revision},'')).status,401);
 assert.equal((await post(route,{id:w.id,revision:current.revision,classification:'unknown'})).status,400);
 assert.equal((await post(route,{id:w.id,revision:1})).status,409);
 const review=await post(route,{id:w.id,revision:current.revision});assert.equal(review.status,200);assert.equal((await review.json()).work.state,'retrying');
 assert.ok(!managementTools.some(x=>/review|classify/.test(x.name)));
 const mcp=await listen(t,createServer(createManagementMcpHandler({store,operations,authorize:()=>null})));
 assert.equal((await fetch(mcp+'/mcp',{method:'POST',headers:{authorization:'Bearer human'},body:'{}'})).status,401);
});

test('Gateway authenticates fixed per-owner routes and private human review without exposing a management bypass',async t=>{
 const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-system-token'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
 const j=new SystemJournal({db:store.db,service:'gateway'}),w=work(j),runnerJournal=journal(t,'runner');work(runnerJournal);
 const runnerBase=await listen(t,createRuntimeServer({runtime:{system:owner(runnerJournal),journal:runnerJournal},registry:{},config:{runnerToken:app.config.runnerToken},probe:async()=>({ready:true})}));
 const runner=new RuntimeClient({url:runnerBase,token:app.config.runnerToken}),operations=new OperationsService({...app,store,journal:j,runner,dispatcher:{}});
 const base=await listen(t,createPrivateApi({...app,store,runner,operations,dispatcher:{}})),client=new OperationsClient({url:base,token:app.config.runnerToken});
 assert.equal((await fetch(base+'/internal/system/work',{method:'POST',body:'{}'})).status,401);
 assert.equal((await client.system('runner','work',{})).items[0].service,'runner');
 await client.system('gateway','classify',{id:w.id,revision:w.revision},{actor:'agent'});
 await assert.rejects(client.system('gateway','review',{id:w.id,revision:j.detail(w.id).revision},{actor:'agent'}),{code:'SYSTEM_HUMAN_REQUIRED'});
 const reviewed=await client.system('gateway','review',{id:w.id,revision:j.detail(w.id).revision},{actor:'admin'});assert.equal(reviewed.classification,'unknown');
 for(const action of ['system_review','system_classify'])await assert.rejects(operations.execute(action,{id:w.id,revision:1}));
 const publicBase=await listen(t,createTaskApi({...app,store,runner,dispatcher:{}}));await fetch(publicBase+'/private/path?token=secret');
 const logged=j.logs({module:'api'}).items;assert.ok(logged.length);assert.ok(!JSON.stringify(logged).includes('/private/path'));assert.ok(!JSON.stringify(logged).includes('secret'));
});

test('MCP derives the agent actor and retains scoped conversation evidence without a review bypass',async t=>{
 const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic system diagnostic'),j=new SystemJournal({db:store.db,service:'manager'}),w=work(j);
 const operations=createManagerOperations({client:{},store,configuration:{},metrics:{},models:async()=>[]});operations.system=owner(j);
 const base=await listen(t,createServer(createManagementMcpHandler({store,operations,authorize:token=>token==='scope'?conversation.id:null})));
 const rpc=async(method,params)=>{const response=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer scope','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(response.status,200);return response.json();};
 const listed=await rpc('tools/list',{});assert.ok(listed.result.tools.some(x=>x.name==='system_issue_draft'));assert.ok(!listed.result.tools.some(x=>/system_(review|classify)/.test(x.name)));
 const response=await rpc('tools/call',{name:'system_issue_draft',arguments:{id:w.id,revision:w.revision}});assert.equal(response.result.isError,undefined);
 assert.ok(j.logs({work_id:w.id}).items.some(e=>e.event==='classification_changed'&&e.details.actor==='agent'));
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM manager_actions WHERE conversation_id=?').get(conversation.id).n,1);
 const denied=await rpc('tools/call',{name:'system_review',arguments:{id:w.id,revision:2}});assert.equal(denied.result.isError,true);assert.equal(j.detail(w.id).classification,'code_defect');
});

test('code-defect evidence survives retention after verified health until a human reviews classification',async t=>{
 let at=1000;const j=journal(t,'manager',()=>at),facade=owner(j),w=work(j);
 const defect=await system.executeSystemOwner(facade,'classify',{id:w.id,revision:w.revision},{actor:'agent'});
 const completed=j.work({...defect,state:'completed',attempted:false});at=10000;
 j.prune({cutoff:5000,limit:100});assert.ok(j.detail(w.id));assert.ok(j.logs({work_id:w.id}).items.length);
 await system.executeSystemOwner(facade,'review',{id:w.id,revision:completed.revision},{actor:'admin'});at=20000;
 j.prune({cutoff:15000,limit:100});assert.equal(j.detail(w.id),null);
});

test('a lost mutation response reports unknown and fresh evidence never repeats the owner action',async t=>{
 const j=journal(t,'gateway'),w=work(j);let calls=0;
 const ops=system.createSystemOperations({local:()=>null,remote:async(service,operation,args)=>{if(operation==='maintain'){calls++;throw new Error('private transport');}return system.executeSystemOwner(owner(j),operation,args);}});
 const result=await ops.execute('system_maintain',{id:w.id,revision:w.revision,action:'cleanup_retry'},{actor:'admin'});assert.equal(result.outcome,'unknown');assert.equal(result.work.state,'retrying');assert.equal(calls,1);
});

test('actual human version and upgrade routes produce sanitized state and phase observations',async t=>{
 const store=new ManagerStore(':memory:');t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});let phase='building';
 const base=await listen(t,createManagerServer({store,agent:{},operations:{system:{journal:j}},auth:{authorize:()=>true},metrics:{},versionService:{current:'1.0.4',latest:async()=>({current:'1.0.4',latest:'1.0.5',update_available:true})},upgradeClient:{status:async()=>({available:true,job:{id:'private-host-job',state:'running',phase,started_at:1,updated_at:phase==='building'?2:3,target_version:'1.0.5'}})}}));
 await fetch(base+'/admin/api/version/latest');assert.equal(j.detail('manager:work:version-check').details.latest_version,'1.0.5');
 await fetch(base+'/admin/api/upgrade');assert.equal(j.detail('manager:work:host-upgrade').details.phase,'building');
 phase='verifying';await fetch(base+'/admin/api/upgrade');assert.equal(j.detail('manager:work:host-upgrade').details.phase,'verifying');assert.ok(!JSON.stringify(j.logs().items).includes('private-host-job'));
});

test('well-shaped foreign records cannot substitute a different exact work or unrelated evidence',async t=>{
 const j=journal(t,'gateway'),wanted=work(j),other=j.work({id:'other',module:'runtime',state:'unknown'});
 const detail=system.createSystemOperations({local:()=>null,remote:async()=>({work:other})});
 const wrong=await detail.execute('system_issue',{id:wanted.id});assert.equal(wrong.work,null);assert.equal(wrong.sources[0].available,false);
 const events=j.logs({work_id:other.id});
 const logs=system.createSystemOperations({local:()=>null,remote:async(s,op,args)=>op==='logs'?events:system.executeSystemOwner(owner(j),op,args)});
 const result=await logs.execute('system_issue',{id:wanted.id});assert.equal(result.work.id,wanted.id);assert.deepEqual(result.events,[]);assert.equal(result.sources[0].available,false);
});

test('a confirmed owner callback failure returns failed with fresh work instead of an unknown transport effect',async t=>{
 const j=journal(t,'manager'),w=work(j),facade={journal:j,maintain:createSystemMaintenance({journal:j,actions:{cleanup_retry:async()=>{throw new Error('private failure');}}})};
 const ops=system.createSystemOperations({local:()=>facade});
 const value=await ops.execute('system_maintain',{id:w.id,revision:w.revision,action:'cleanup_retry'},{actor:'admin'});assert.equal(value.outcome,'failed');assert.equal(value.work.state,'retrying');assert.equal(value.sources[0].available,true);assert.ok(!JSON.stringify(value).includes('private failure'));
});

test('undersized continued source pages are explicitly unavailable before global cursor advancement',async t=>{
 let at=0;const manager=journal(t,'manager',()=>at),gateway=journal(t,'gateway',()=>at);
 for(const [j,times] of [[manager,[60,50]],[gateway,[100,90,80]]])for(const time of times){at=time;j.work({id:'w'+time,module:'cleanup',state:'retrying'});}
 const ops=system.createSystemOperations({local:()=>owner(manager),remote:(service,operation,args)=>{
  if(service!=='gateway')throw new Error('synthetic unavailable Runner');
  return system.executeSystemOwner(owner(gateway),operation,{...args,limit:1});
 },now:()=>200});
 const first=await ops.execute('system_work',{limit:2});
 assert.equal(first.sources.find(s=>s.service==='gateway').available,false);
 assert.equal(first.sources.find(s=>s.service==='gateway').error_code,'SYSTEM_SOURCE_UNAVAILABLE');
 assert.deepEqual(first.items.map(w=>w.id),['manager:work:w60','manager:work:w50']);assert.equal(first.next_cursor,null);
 // A final short page is legitimate: rejecting incomplete continued windows must
 // not discard the last record once a source has exhausted its matching history.
 const terminal=await ops.execute('system_work',{service:'gateway',limit:2,before:90});
 assert.equal(terminal.sources[0].available,true);assert.deepEqual(terminal.items.map(w=>w.id),['gateway:work:w80']);assert.equal(terminal.next_cursor,null);
});

