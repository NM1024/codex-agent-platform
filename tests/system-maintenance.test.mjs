import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,symlink,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SystemJournal} from '../src/observability/system-journal.mjs';
import {createSystemMaintenance} from '../src/observability/system-maintenance.mjs';
import {HistoryRetentionWorker} from '../src/history/worker.mjs';
import {EventOutbox} from '../src/runtime/events.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
const base=tmpdir();
function journal(t,service='manager'){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return new SystemJournal({db,service});}
test('maintenance authorizes revisions and owner actions independently of diagnostic tags, coalesces duplicates and rereads state',async t=>{
 const j=journal(t);let release,calls=0;const gate=new Promise(r=>release=r);
 const w=j.work({id:'cleanup.a',module:'cleanup',state:'retrying',allowed_actions:['cleanup_retry','health_check']});
 const maintain=createSystemMaintenance({journal:j,actions:{cleanup_retry:async({work})=>{calls++;await gate;j.work({...work,state:'completed',attempted:false});},health_check:async()=>({accepted:true})}});
 const args={id:w.id,revision:w.revision,action:'cleanup_retry'};
 const a=maintain(args),b=maintain(args);release();const [one,two]=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(one.work.state,'completed');assert.deepEqual(one,two);
 await assert.rejects(maintain(args),{code:'SYSTEM_REVISION_CONFLICT'});
 let defect=j.classify(w.id,'code_defect',one.work.revision);
 const retried=await maintain({...args,revision:defect.revision});assert.equal(calls,2);assert.equal(retried.work.state,'completed');defect=retried.work;
 const checked=await maintain({id:w.id,revision:defect.revision,action:'health_check'});assert.equal(checked.work.revision,defect.revision);
 await assert.rejects(maintain({id:w.id,revision:defect.revision,action:'health_check',path:'/tmp'}),{code:'SYSTEM_QUERY_INVALID'});
 await assert.rejects(maintain({...args,id:'runner:work:cleanup.a'}),{code:'SYSTEM_SOURCE_MISMATCH'});
});
test('journal retention continues bounded backlogs on later wakeups and protects unresolved work',async t=>{
 const j=journal(t);j.now=()=>1;for(let i=0;i<123;i++)j.event({module:'system',event:'start',target_id:'item'+i});
 const protectedWork=j.work({id:'pending',module:'cleanup',state:'retrying'});j.now=Date.now;
 let enabled=false;const worker=new HistoryRetentionWorker({db:j.db,journal:j,batchSize:20,maxBatches:1,readPolicy:()=>({enabled,days:60,revision:1}),runBatch:async()=>({deleted:0,hasMore:false})});
 await worker.tick(100*86400000);assert.ok(j.logs({limit:100}).next_cursor);enabled=true;
 for(let i=0;i<10;i++)await worker.tick(100*86400000+i*60000);
 assert.equal(j.logs({before:2,limit:100}).items.length,1);assert.equal(j.detail(protectedWork.id).state,'retrying');assert.notEqual(worker.state().completed_at,null);
});
test('event outbox persists backlog then scoped flush verifies removal without payload logging',async t=>{
 const root=await mkdtemp(join(base,'outbox-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=journal(t,'runner');let offline=true;
 const outbox=new EventOutbox({workspace:root,journal:j,send:async()=>{if(offline)throw new Error('secret url and payload');}});t.after(()=>outbox.stop());
 await outbox.publish('00000000-0000-0000-0000-000000000001','COMPLETED',{generation:0});
 let work=j.detail('runner:work:event-outbox');assert.equal(work.pending_count,1);assert.equal(work.state,'retrying');
 offline=false;await outbox.flush({force:true});work=j.detail(work.id);assert.equal(work.pending_count,0);assert.equal(work.state,'completed');assert.ok(!JSON.stringify(j.logs()).includes('secret'));
});
test('conversation cleanup keeps authorization and real symlink failures, permits scoped recovery',async t=>{
 const root=await mkdtemp(join(base,'cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ManagerStore(join(root,'manager.sqlite'));t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});
 const agent=new ManagementAgent({store,root,journal:j});const conversation=store.createConversation('synthetic');const id=conversation.id;
 await mkdir(join(root,'outside'));await writeFile(join(root,'outside','keep'),'secret');await symlink(join(root,'outside'),join(root,'work'));
 await agent.deleteConversation(id);let work=j.detail('manager:work:conversation-cleanup.'+id);assert.equal(work.state,'blocked');assert.ok(store.pendingConversationCleanup().length);
 await rm(join(root,'work'));await mkdir(join(root,'work',id),{recursive:true});await agent.retryConversationCleanup({conversationId:id,force:true});assert.equal(j.detail(work.id).state,'completed');assert.equal(store.pendingConversationCleanup().length,0);assert.ok(await stat(join(root,'outside','keep')));
 const live=store.createConversation('live');await mkdir(join(root,'work',live.id),{recursive:true});assert.equal(await agent.cleanupConversationFiles(live.id),false);assert.ok(await stat(join(root,'work',live.id)));
});
import {BusinessRegistry} from '../src/core/registry.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';
import {NotificationStore} from '../src/notifications/store.mjs';
import {ManagerSandbox} from '../src/manager/sandbox.mjs';
import {InspectionNotificationBridge} from '../src/manager/inspection-notifications.mjs';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {RuntimeClient} from '../src/runtime/client.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';
test('saved configuration pending confirmation is synchronized through owned facade and respects backoff',async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});let offline=true,calls=0;
 const config={concurrency:1,paused:false},runner={configure:async settings=>{calls++;if(offline)throw new Error('secret');return settings;},ready:async()=>({ready:true})};
 const service=new OperationsService({journal:j,store,config,runner,dispatcher:{drain:async()=>{}}});
 const saved=await service.execute('configuration_update',{scope:'execution',patch:{concurrency:2}});assert.equal(saved.synchronization.runner,'pending');let work=j.detail('gateway:work:configuration-sync');assert.equal(work.state,'retrying');assert.equal(work.details.revision,saved.revision);
 await service.syncConfiguration();assert.equal(calls,1);offline=false;
 const result=await service.system.maintain({id:work.id,revision:work.revision,action:'configuration_sync'});assert.equal(result.work.state,'completed');assert.equal(result.work.attempts,2);assert.equal(result.work.details.revision,saved.revision);
});
test('sandbox remote uncertainty stays pending and local files disappear before helper recovery',async t=>{
 const root=await mkdtemp(join(base,'sandbox-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ManagerStore(join(root,'manager.sqlite'));t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});let offline=true,calls=0;
 const sandbox=new ManagerSandbox({store,root,journal:j,client:{call:async()=>{calls++;if(offline)throw new Error('secret');return {};}}});const c=store.createConversation();sandbox.queueCleanup(c);store.deleteConversation(c.id);await sandbox.cleanup();let work=j.detail('manager:work:sandbox-cleanup.'+c.id);assert.equal(work.state,'retrying');await sandbox.cleanup();assert.equal(calls,1);offline=false;await sandbox.cleanup({conversationId:c.id,force:true});assert.equal(j.detail(work.id).state,'completed');
});
test('inspection lifecycle outbox records failure then confirms exact version without replaying business work',async t=>{
 const store=new ManagerStore(':memory:');t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});let offline=true;
 const bridge=new InspectionNotificationBridge({store,journal:j,client:{execute:async()=>{if(offline)throw new Error('secret');return {accepted:true};}}});
 const event={id:'inspection-a',conversation_id:'conversation-a',message_id:'message-a',state:'completed'};
 await assert.rejects(bridge.lifecycle(event));let work=j.detail('manager:work:inspection-lifecycle.inspection-a');assert.equal(work.state,'retrying');offline=false;await bridge.retryLifecycle({inspectionId:event.id,force:true});assert.equal(j.detail(work.id).state,'completed');
});
test('unknown notification is recorded safely and never receives maintenance replay',async t=>{
 const j=journal(t,'gateway');let calls=0;const store=new NotificationStore({db:j.db,journal:j,fetchImpl:async()=>{calls++;throw new Error('secret recipient');}});
 const channel=store.saveChannel({name:'Synthetic',provider:'custom',url:'https://example.invalid/hook',enabled:true});const owner={kind:'task',id:'task-a'};store.setBinding(owner,[channel.id]);const payload={notification_key:'synthetic',deliveries:[{channel_id:channel.id,body:{secret:'business data'}}]};
 const result=await store.send(owner,payload);assert.equal(result.status,'unknown');const work=j.issues({module:'notifications'}).items[0];assert.equal(work.state,'unknown');assert.deepEqual(work.allowed_actions,[]);await store.send(owner,payload);assert.equal(calls,1);assert.ok(!JSON.stringify(j.logs()).includes('business data'));
});
test('authenticated runner retention uses owner journal and explicit global policy cutoff',async t=>{
 const root=await mkdtemp(join(base,'runner-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=journal(t,'runner');j.now=()=>1;j.event({module:'system',event:'start'});j.now=Date.now;
 const runtime=new AgentRuntime({workspace:root,codexHome:join(root,'codex'),journal:j});const server=createRuntimeServer({runtime,registry:{},config:{runnerToken:'synthetic-token',workspace:root},probe:async()=>({ready:true})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}`;const client=new RuntimeClient({url,token:'synthetic-token'});const args={policy:{enabled:true,days:60,revision:1},cutoff:Date.now()-60*86400000,limit:10};
 const denied=await fetch(url+'/internal/history/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(denied.status,401);
 assert.equal((await client.pruneSystemHistory({...args,policy:{...args.policy,enabled:false}})).deleted,0);assert.equal(j.logs({before:2}).items.length,1);
 await client.pruneSystemHistory(args);assert.equal(j.logs({before:2}).items.length,0);await assert.rejects(client.pruneSystemHistory({...args,cutoff:Date.now()}));
});
import {configuredDelivery,deliveryCatalog} from '../src/delivery/configured.mjs';
import {createServer} from 'node:http';
import {acceptPendingInspections} from '../src/manager/inspections.mjs';
test('runtime reconciliation records unavailability then recovery without creating terminal tasks',async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});let offline=true;
 const dispatcher=new Dispatcher({store,registry,journal:j,config:{concurrency:1},runner:{active:async()=>{if(offline)throw new Error('secret');return {runs:[]};}}});t.after(()=>dispatcher.stop());
 assert.equal(await dispatcher.synchronize(),false);let work=j.detail('gateway:work:runtime-reconcile');assert.equal(work.state,'retrying');offline=false;assert.equal(await dispatcher.synchronize({force:true}),true);assert.equal(j.detail(work.id).state,'completed');assert.equal(store.unfinished().length,0);
});
test('runner transient retry validates durable ended marker and owned paths before cleanup',async t=>{
 const root=await mkdtemp(join(base,'transient-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=journal(t,'runner'),runId='00000000-0000-4000-8000-000000000009';
 const workspace=join(root,'workspace'),codexHome=join(root,'codex'),owned=join(workspace,'.agent-runs',runId);await mkdir(join(owned,'work'),{recursive:true});await mkdir(join(codexHome,'runs'),{recursive:true});await mkdir(join(root,'outside'));await writeFile(join(root,'outside','keep'),'safe');await symlink(join(root,'outside'),join(codexHome,'runs',runId));await writeFile(join(owned,'launch.json'),JSON.stringify({run_id:runId,status:'ended'}));
 const runtime=new AgentRuntime({workspace,codexHome,journal:j});assert.equal(await runtime.cleanupTransient(runId),false);const work=j.detail('runner:work:transient-cleanup.'+runId);assert.equal(work.state,'blocked');await rm(join(codexHome,'runs',runId));assert.equal(await runtime.cleanupTransient(runId,{force:true}),true);assert.equal(j.detail(work.id).state,'completed');assert.ok(await stat(join(root,'outside','keep')));
 await mkdir(join(owned,'work'),{recursive:true});await writeFile(join(owned,'launch.json'),JSON.stringify({run_id:runId,status:'suspended'}));assert.equal(await runtime.cleanupTransient(runId,{force:true}),false);assert.ok(await stat(join(owned,'work')));
});
test('manual retention retry revisits failed completed sweeps but never enables disabled policy',async t=>{
 const j=journal(t);let fail=true,enabled=true,calls=0;const worker=new HistoryRetentionWorker({db:j.db,journal:j,readPolicy:()=>({enabled,days:60,revision:1}),runBatch:async()=>{calls++;return {failed:fail?1:0,hasMore:false};}});
 await worker.tick();assert.equal(j.detail('manager:work:history-sweep').state,'unknown');fail=false;await worker.retry();assert.equal(calls,2);assert.equal(j.detail('manager:work:history-sweep').state,'completed');enabled=false;await worker.retry();assert.equal(calls,2);assert.deepEqual(j.detail('manager:work:history-sweep').allowed_actions,[]);
});
test('schedule trigger and inspection claim ACK produce evidence without copying messages',async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});const service=new OperationsService({store,journal:j,config:{concurrency:1},runner:{},dispatcher:{}});const now=Date.now();const plan=service.schedules.save({name:'private plan',kind:'inspection',message:'private message',cron:'* * * * *',timezone:'UTC'},now);await service.schedules.tick(plan.next_run_at);const item=service.schedules.pendingInspections()[0];assert.ok(j.logs({module:'schedules'}).items.length);
 service.schedules.claimInspection(item.id);service.schedules.acknowledgeInspection(item.id,'synthetic-conversation','00000000-0000-4000-8000-000000000111','queued');assert.ok(j.logs({module:'inspections'}).items.some(x=>x.details.phase==='ack'));assert.ok(!JSON.stringify(j.logs()).includes('private message'));
 const manager=new ManagerStore(':memory:');t.after(()=>manager.close());const mj=new SystemJournal({db:manager.db,service:'manager'});await assert.rejects(acceptPendingInspections({store:manager,agent:{kick(){}},journal:mj,client:{execute:async()=>{throw new Error('private remote');}}}));assert.equal(mj.detail('manager:work:inspection-intake').state,'retrying');
});
test('configured callback loopback failure records safe terminal evidence and never replays',async t=>{
 let calls=0,observed;const server=createServer((req,res)=>{calls++;observed=j.issues({module:'delivery'}).items[0]?.state;req.resume();res.writeHead(503);res.end('private');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const registry=new BusinessRegistry([],deliveryCatalog()),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});store.journal=j;store.db.exec('CREATE TABLE IF NOT EXISTS platform_delivery_details(task_id TEXT PRIMARY KEY,http_status INTEGER,error_code TEXT,updated_at INTEGER)');store.plugins.save({type:'test.callback',name:'test',instructions:'test',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});const task=store.accept('test',{type:'test.callback',request_id:'private',input:{}});store.db.prepare('INSERT OR REPLACE INTO agent_deliveries VALUES(?,?)').run(task.task_id,'pending');
 const delivery=configuredDelivery({url:`http://127.0.0.1:${server.address().port}/hook?secret=private`});await delivery.execute({store,task});assert.equal(observed,'unknown');const work=j.issues({module:'delivery'}).items[0];assert.equal(work.state,'blocked');assert.equal(work.details.status_code,503);assert.deepEqual(work.allowed_actions,[]);await delivery.execute({store,task});assert.equal(calls,1);assert.ok(!JSON.stringify(j.logs()).includes('private'));
});
import {systemDue,systemFailure,systemObserve} from '../src/observability/system-maintenance.mjs';
test('diagnostic classification preserves observations without disabling normal scheduling',t=>{
 const j=journal(t);let work=j.work({id:'cleanup.defect',module:'cleanup',state:'retrying',allowed_actions:['cleanup_retry']});j.classify(work.id,'code_defect',work.revision);assert.equal(systemDue(j,'cleanup.defect'),true);assert.equal(systemDue(j,'cleanup.defect',{force:true}),true);systemFailure(j,{id:'cleanup.defect',module:'cleanup',code:'CLEANUP_FAILED'},new Error('offline'));assert.equal(j.detail(work.id).classification,'code_defect');systemObserve(j,{id:'cleanup.defect',module:'cleanup',state:'unknown',classification:'transient'});assert.equal(j.detail(work.id).classification,'code_defect');
});
test('sandbox helper unavailability is truthful and recovery is observed without host log access',async t=>{
 const root=await mkdtemp(join(base,'helper-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ManagerStore(':memory:');t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});let offline=true;
 const sandbox=new ManagerSandbox({store,root,journal:j,client:{recover:async()=>{if(offline)throw new Error('private path');return {recovered:0};}}});await assert.rejects(sandbox.recover());assert.equal(j.detail('manager:work:sandbox-helper').state,'unknown');offline=false;await sandbox.recover();assert.equal(j.detail('manager:work:sandbox-helper').state,'completed');
});
test('outbox filesystem failure opens durable issue while preserving original error and retry wakeup',async t=>{
 const root=await mkdtemp(join(base,'outbox-fail-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=journal(t,'runner');await writeFile(join(root,'.agent-events'),'synthetic');const outbox=new EventOutbox({workspace:root,journal:j,send:async()=>{}});t.after(()=>outbox.stop());await assert.rejects(outbox.flush());assert.ok(j.issues({module:'events'}).items.length);assert.ok(outbox.timer);
});
import {createManagerSystem,createRunnerSystem} from '../src/observability/system-maintenance.mjs';
test('owner facades route exact journal work to authorized cleanup and flush callbacks',async t=>{
 const root=await mkdtemp(join(base,'facades-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ManagerStore(':memory:');t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'manager'});const agent=new ManagementAgent({store,root,journal:j});const c=store.createConversation();store.deleteConversation(c.id);await mkdir(join(root,'work',c.id),{recursive:true});const w=j.work({id:'conversation-cleanup.'+c.id,module:'cleanup',target_id:c.id,state:'retrying',allowed_actions:['cleanup_retry']});const system=createManagerSystem({journal:j,agent});assert.equal((await system.maintain({id:w.id,revision:w.revision,action:'cleanup_retry'})).work.state,'completed');
 const rj=journal(t,'runner');let offline=true;const outbox=new EventOutbox({workspace:root,journal:rj,send:async()=>{if(offline)throw new Error();}});t.after(()=>outbox.stop());await outbox.publish('00000000-0000-0000-0000-000000000001','COMPLETED');const runner=createRunnerSystem({journal:rj,runtime:{},outbox,probe:async()=>({ready:true})});offline=false;const pending=rj.detail('runner:work:event-outbox');assert.equal((await runner.maintain({id:pending.id,revision:pending.revision,action:'event_flush'})).work.state,'completed');
});
test('history sweep waits for all remote bounded journal batches before reporting completion',async t=>{
 const j=journal(t);let count=0;const worker=new HistoryRetentionWorker({db:j.db,journal:j,maxBatches:1,readPolicy:()=>({enabled:true,days:60,revision:1}),runBatch:async()=>({hasMore:false}),pruneRemote:async args=>{assert.equal(args.policy.days,60);count++;return {deleted:1,hasMore:count<3};}});
 await worker.tick();assert.equal(worker.state().completed_at,null);await worker.tick();assert.equal(worker.state().completed_at,null);await worker.tick();assert.notEqual(worker.state().completed_at,null);assert.equal(j.detail('manager:work:history-sweep').state,'completed');
});
test('healthy configuration confirmation produces no repeated journal events with normalized detail order',async t=>{
 const j=journal(t);const input={id:'configuration-sync',module:'configuration',state:'completed',code:'CONFIGURATION_SYNCED',details:{revision:2,confirmed_revision:2}};systemObserve(j,input);systemObserve(j,input);assert.equal(j.logs().items[0].count,1);
});
test('maintenance records fixed actor action and verification state without accepting context as commands',async t=>{
 const j=journal(t);const work=j.work({id:'health',module:'health',state:'unknown',allowed_actions:['health_check']});const maintain=createSystemMaintenance({journal:j,actions:{health_check:async()=>{}}});await maintain({id:work.id,revision:work.revision,action:'health_check'},{actor:'admin'});assert.equal(j.logs().items[0].details.actor,'admin');assert.equal(j.logs().items[0].details.action,'health_check');assert.equal(j.detail(work.id).state,'unknown');
});
test('runtime reconciliation does not claim completion while an orphan stop remains unconfirmed',async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});let offline=true,live=true;
 const dispatcher=new Dispatcher({journal:j,store,registry,config:{concurrency:1},runner:{active:async()=>({runs:live?['00000000-0000-4000-8000-000000000123']:[]}),cancel:async()=>{if(offline)throw new Error('private');live=false;}}});t.after(()=>dispatcher.stop());
 await dispatcher.synchronize();const w=j.detail('gateway:work:runtime-reconcile');assert.equal(w.state,'retrying');assert.equal(w.pending_count,1);offline=false;await dispatcher.synchronize({force:true});assert.equal(j.detail(w.id).state,'completed');
});
test('notification reservation exposes unresolved outcome before remote acknowledgement',async t=>{
 const j=journal(t,'gateway');let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);t.after(()=>release());const store=new NotificationStore({db:j.db,journal:j,fetchImpl:async()=>{entered();await gate;return new Response('ok');}});const channel=store.saveChannel({name:'Synthetic',provider:'custom',url:'https://example.invalid/hook',enabled:true}),owner={kind:'task',id:'task-a'};store.setBinding(owner,[channel.id]);const sending=store.send(owner,{notification_key:'one',deliveries:[{channel_id:channel.id,body:{text:'private'}}]});await started;assert.equal(j.issues({module:'notifications'}).items[0]?.state,'unknown');release();await sending;assert.equal(j.issues({module:'notifications'}).items.length,0);assert.equal(j.works({module:'notifications'}).items[0].attempts,1);
});
for(const correction of ['schedule','plugin'])test(`corrected ${correction} releases schedule configuration blocking without replaying terminal tasks or letting diagnostic tags block future schedules`,async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});
 store.plugins.save({type:'test.schedule',name:'Synthetic',instructions:'Synthetic',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});
 const service=new OperationsService({store,journal:j,config:{concurrency:1},runner:{},dispatcher:{}}),start=Date.now();
 const plan=service.schedules.save({name:'Synthetic',kind:'task',type:'test.schedule',input:{},cron:'* * * * *',timezone:'UTC'},start);
 store.plugins.setEnabled('test.schedule',false);await service.schedules.tick(plan.next_run_at);const id='gateway:work:schedule-trigger.'+plan.id;
 assert.equal(j.detail(id).state,'blocked');assert.equal(store.queued().length,0);
 const failed=j.detail(id);j.classify(id,'code_defect',failed.revision);const tagged=j.detail(id);await service.schedules.tick(plan.next_run_at+1000);assert.equal(j.detail(id).revision,tagged.revision);
 store.plugins.setEnabled('test.schedule',true);if(correction==='schedule')service.schedules.save({...plan},start);await service.schedules.tick(plan.next_run_at);
 assert.equal(store.queued().length,1);assert.equal(j.detail(id).state,'completed');
 const run=store.claim(store.queued()[0].task_id);store.fail(run.run_id,'SYNTHETIC_FAILURE');
 const work=j.detail(id);j.classify(id,'code_defect',work.revision);service.schedules.save({...plan},start);await service.schedules.tick(plan.next_run_at+60000);
 assert.equal(store.queued().length,1);assert.equal(store.unfinished().length,0);assert.equal(j.detail(id).classification,'code_defect');
});
test('human connection repair releases a blocked schedule without a schedule or plugin revision change',async t=>{
 const registry=new BusinessRegistry([],{requirePluginConnections:true}),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});
 store.plugins.save({type:'test.connection',name:'Synthetic',instructions:'Synthetic',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});
 store.pluginConnections.update('test.connection',{entryKey:'synthetic-connection-key-123456'});store.plugins.setEnabled('test.connection',true);
 const service=new OperationsService({store,journal:j,config:{concurrency:1},runner:{},dispatcher:{}}),plan=service.schedules.save({name:'Synthetic',kind:'task',type:'test.connection',input:{},cron:'* * * * *',timezone:'UTC'});
 store.pluginConnections.update('test.connection',{entryKey:null});await service.schedules.tick(plan.next_run_at);const id='gateway:work:schedule-trigger.'+plan.id;
 assert.equal(j.detail(id).state,'blocked');const pluginRevision=store.plugins.get('test.connection').revision;
 store.pluginConnections.update('test.connection',{entryKey:'synthetic-repaired-key-123456'});await service.schedules.tick(plan.next_run_at);
 assert.equal(store.plugins.get('test.connection').revision,pluginRevision);assert.equal(store.queued().length,1);assert.equal(j.detail(id).state,'completed');
});
for(const boundary of ['directory','write'])test(`outbox ${boundary} publication failure remains unresolved after an empty flush and process reconstruction`,async t=>{
 const root=await mkdtemp(join(base,'unpublished-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=journal(t,'runner'),runId='00000000-0000-4000-8000-000000000321',directory=join(root,'.agent-events');
 let sends=0;const outbox=new EventOutbox({workspace:root,journal:j,send:async()=>{sends++;}});t.after(()=>outbox.stop());
 if(boundary==='directory')await writeFile(directory,'synthetic');else await mkdir(join(directory,runId+'.0.COMPLETED.json'),{recursive:true});
 await assert.rejects(outbox.publish(runId,'COMPLETED'),error=>error.code===(boundary==='directory'?'EEXIST':'EISDIR'));
 const issue=j.issues({module:'events'}).items[0];assert.ok(issue);assert.notEqual(issue.state,'completed');assert.deepEqual(issue.allowed_actions,[]);assert.ok(outbox.timer);assert.equal(sends,0);
 await rm(directory,{recursive:true,force:true});await outbox.flush({force:true});assert.notEqual(j.detail(issue.id).state,'completed');assert.equal(sends,0);
 await outbox.stop();const restarted=new EventOutbox({workspace:root,journal:new SystemJournal({db:j.db,service:'runner'}),send:async()=>{sends++;}});t.after(()=>restarted.stop());
 await restarted.flush({force:true});assert.notEqual(j.detail(issue.id).state,'completed');
 await restarted.publish(runId,'SUSPENDED');assert.notEqual(j.detail(issue.id).state,'completed');assert.equal(sends,1);
 await restarted.publish(runId,'COMPLETED');assert.equal(j.detail(issue.id).state,'completed');assert.equal(sends,2);assert.ok(!JSON.stringify(j.logs()).includes(root));
});
test('accepted orphan cancellation remains pending until the real launch reservation disappears',async t=>{
 const root=await mkdtemp(join(base,'pending-orphan-'));t.after(()=>rm(root,{recursive:true,force:true}));const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});
 let release;const gate=new Promise(r=>release=r),runtime=new AgentRuntime({workspace:root,codexHome:join(root,'codex')});const runId='00000000-0000-4000-8000-000000000322';
 const launched=runtime.launch({run_id:runId,task_id:'00000000-0000-4000-8000-000000000323'},{beforeStart:()=>gate});const settled=launched.catch(error=>error);t.after(async()=>{runtime.closed=true;release();await settled;});
 const runner={active:async()=>({runs:[...new Set([...runtime.active.keys(),...runtime.launches.keys()])]}),cancel:async id=>{await runtime.end(id,'CANCELLED');return {accepted:true};}};
 const dispatcher=new Dispatcher({journal:j,store,registry,config:{concurrency:1},runner});t.after(()=>dispatcher.stop());
 await dispatcher.synchronize();const work=j.detail('gateway:work:runtime-reconcile');assert.ok(runtime.cancelled.has(runId));assert.equal(runtime.launches.size,1);assert.equal(work.state,'retrying');assert.equal(work.pending_count,1);
 runtime.closed=true;release();assert.equal((await settled).message,'RUNNER_STOPPING');await dispatcher.synchronize({force:true});assert.equal(j.detail(work.id).state,'completed');assert.equal(store.unfinished().length,0);
});
for(const outcome of ['unavailable','malformed'])test(`accepted orphan stop cannot complete when verification inventory is ${outcome}`,async t=>{
 const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());const j=new SystemJournal({db:store.db,service:'gateway'});let reads=0;
 const runner={active:async()=>{if(++reads===1)return {runs:['00000000-0000-4000-8000-000000000324']};if(outcome==='unavailable')throw new Error('private');return {};},cancel:async()=>({accepted:true})};
 const dispatcher=new Dispatcher({journal:j,store,registry,config:{concurrency:1},runner});t.after(()=>dispatcher.stop());await dispatcher.synchronize();const work=j.detail('gateway:work:runtime-reconcile');assert.equal(work.state,'retrying');assert.equal(work.pending_count,1);assert.ok(!JSON.stringify(j.logs()).includes('private'));
});
