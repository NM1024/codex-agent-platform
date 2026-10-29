import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { createPlatformCatalog } from '../src/platform.mjs';
import { configuredDelivery } from '../src/delivery/configured.mjs';
import { createDeliveryWorker } from '../src/delivery/worker.mjs';
import { ScheduleStore } from '../src/operations/schedules.mjs';

const module = {type:'test.retention',version:'1',inputSchema:{type:'object'},resultSchema:{type:'object'},tools:{}};
function setup(t, overrides={}, path=':memory:', catalog=createPlatformCatalog({workspace:'/unused'})) {
  const registry=new BusinessRegistry([{...module,...overrides}],catalog);
  const store=new RequestStore(path,{registry});t.after(()=>store.close());
  const accept=()=>store.accept('synthetic',{type:module.type,request_id:'history',input:{}});
  return {store,registry,accept};
}
async function finished(store,accept,status='completed',time=10) {
  const task=accept(),run=store.claim(task.task_id);
  if(status==='completed')await store.complete(run.run_id,{});else store.fail(run.run_id,'SYNTHETIC_FAILURE');
  store.db.prepare('UPDATE agent_requests SET created_at=1,finished_at=?,updated_at=? WHERE task_id=?').run(time,time,task.task_id);
  store.db.prepare('UPDATE agent_runs SET receipt_until=0 WHERE run_id=?').run(run.run_id);
  return {...task,run_id:run.run_id};
}
const ids=rows=>rows.map(row=>row.task_id);

test('retention uses final completion timestamps and strict stable cursor ordering',async t=>{
  const {store,accept}=setup(t);
  const old=await finished(store,accept),failed=await finished(store,accept,'failed');
  const boundary=await finished(store,accept,'completed',100),recent=await finished(store,accept,'completed',101);
  const expected=[old.task_id,failed.task_id].sort();
  assert.deepEqual(ids(store.expiredTasks({cutoff:100,now:1000})),expected);
  const first=store.expiredTasks({cutoff:100,now:1000,limit:1})[0];
  assert.deepEqual(Object.keys(first).sort(),['finished_at','run_id','task_id']);
  assert.deepEqual(ids(store.expiredTasks({cutoff:100,now:1000,cursor:{time:first.finished_at,id:first.task_id}})),expected.slice(1));
  assert.equal(store.canPurgeTaskHistory(boundary.task_id,{cutoff:100,now:1000}),false);
  assert.equal(store.canPurgeTaskHistory(recent.task_id,{cutoff:100,now:1000}),false);
});

test('retention excludes unfinished tasks, open receipts, executing operations and pending callbacks',async t=>{
  const {store,accept}=setup(t);
  for(const status of ['queued','dispatching','running','completing','suspended']) {
    const task=accept();store.db.prepare('UPDATE agent_requests SET status=?,finished_at=1 WHERE task_id=?').run(status,task.task_id);
  }
  const receipt=await finished(store,accept);store.db.prepare('UPDATE agent_runs SET receipt_until=1001 WHERE run_id=?').run(receipt.run_id);
  const operation=await finished(store,accept);store.db.prepare("INSERT INTO agent_operations VALUES('executing',?,'tool','executing')").run(operation.run_id);
  for(const status of ['pending','blocked_configuration','attempted']) {
    const task=await finished(store,accept);store.db.prepare('UPDATE agent_deliveries SET status=? WHERE task_id=?').run(status,task.task_id);
    assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),false);
  }
  assert.deepEqual(store.expiredTasks({cutoff:100,now:1000}),[]);
  assert.equal(store.isHistoryIdle(),false);
  assert.equal(store.canPurgeTaskHistory(receipt.task_id,{cutoff:100,now:1000}),false);
  assert.equal(store.canPurgeTaskHistory(operation.task_id,{cutoff:100,now:1000}),false);
});

test('terminal stamps reflect completion, failure and immediate admission without reopening stamps',async t=>{
  const {store,accept}=setup(t);
  const task=accept();assert.equal(store.raw(task.task_id).finished_at,null);
  const run=store.claim(task.task_id);store.suspend(run.run_id);assert.equal(store.raw(task.task_id).finished_at,null);
  const resumed=store.claim(task.task_id);await store.complete(resumed.run_id,{});
  const stamp=store.raw(task.task_id).finished_at;assert.ok(stamp>=task.created_at);
  await store.complete(run.run_id,{});assert.equal(store.raw(task.task_id).finished_at,stamp);
  const failed=accept(),failure=store.claim(failed.task_id);store.fail(failure.run_id,'FAILED');
  assert.ok(store.raw(failed.task_id).finished_at>=failed.created_at);
  const immediate=store.accept('synthetic',{type:module.type,request_id:'immediate',input:{}},{prepared:{input:{},result:{}}});
  assert.equal(store.raw(immediate.task_id).finished_at,immediate.created_at);
  assert.equal(store.isHistoryIdle(),true);store.validations.add('active-validation');assert.equal(store.isHistoryIdle(),false);
});

test('purge composes provider and module ownership transactionally and preserves a newer retry',async t=>{
  let reject=true;
  const {store,accept}=setup(t,{
    initializeStorage:({db})=>db.exec('CREATE TABLE custom_history(task_id TEXT PRIMARY KEY)'),
    deleteTaskHistory:({store,taskId,runId})=>{assert.equal(typeof runId,'string');store.db.prepare('DELETE FROM custom_history WHERE task_id=?').run(taskId);if(reject)throw new Error('provider rejected');},
  });
  const task=await finished(store,accept);
  const retry=store.retry(task.task_id);
  store.db.prepare('INSERT INTO custom_history VALUES(?)').run(task.task_id);
  store.db.prepare('INSERT INTO platform_artifacts VALUES(?,?,?,?)').run('artifact',task.task_id,task.run_id,'{}');
  store.db.prepare('INSERT INTO platform_delivery_details VALUES(?,?,?,?)').run(task.task_id,200,null,10);
  store.db.prepare('INSERT INTO agent_operations VALUES(?,?,?,?)').run('op',task.run_id,'tool','completed');
  store.db.prepare('INSERT INTO platform_errors VALUES(?,?,?,?,?,?,?,?,?)').run('error',task.task_id,task.run_id,0,'runtime',null,'FAIL',null,10);
  assert.throws(()=>store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),/provider rejected/);
  assert.ok(store.raw(task.task_id));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM custom_history').get().n,1);
  reject=false;assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),true);
  assert.equal(store.get(task.task_id),null);
  for(const table of ['custom_history','platform_artifacts','platform_delivery_details','agent_operations','platform_errors','agent_runs','agent_results','agent_deliveries'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);
  assert.equal(store.get(retry.task_id).retry_of,task.task_id);
});

test('purge rechecks eligibility and rolls back with the caller schedule transaction',async t=>{
  const {store,accept}=setup(t),schedules=new ScheduleStore(store),task=await finished(store,accept);
  store.db.prepare('INSERT INTO platform_schedule_runs VALUES(?,?,?,?,?)').run('event','plan',1,1,task.task_id);
  store.db.prepare("UPDATE agent_deliveries SET status='pending' WHERE task_id=?").run(task.task_id);
  assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),false);
  store.db.prepare("UPDATE agent_deliveries SET status='accepted' WHERE task_id=?").run(task.task_id);
  assert.throws(()=>store.transaction(()=>{assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),true);schedules.deleteTaskHistory(task.task_id);throw new Error('abort');}),/abort/);
  assert.ok(store.raw(task.task_id));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_schedule_runs').get().n,1);
  store.transaction(()=>{store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000});schedules.deleteTaskHistory(task.task_id);});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_schedule_runs').get().n,0);
});

test('delivery exposes active task ownership while an unknown callback is still executing',async t=>{
  let release,arrived;const received=new Promise(resolve=>arrived=resolve);
  const server=createServer((req,res)=>{req.resume();release=()=>{res.writeHead(200);res.end();};arrived();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {store,accept}=setup(t,{delivery:configuredDelivery({url:`http://127.0.0.1:${server.address().port}`})});
  const task=await finished(store,accept),deliver=createDeliveryWorker({store,config:{}}),pending=deliver();
  try {await received;assert.equal(store.get(task.task_id).delivery.status,'unknown');assert.equal(deliver.active.has(task.task_id),true);}
  finally {release();await pending;}
  assert.equal(deliver.active.size,0);assert.equal(store.get(task.task_id).delivery.status,'accepted');
});

test('inspection retention removes bounded terminal history while preserving plans and unfinished inspections',async t=>{
  const {store}=setup(t),schedules=new ScheduleStore(store);
  const plan=schedules.save({kind:'inspection',name:'Synthetic inspection',message:'Inspect synthetic state',cron:'* * * * *',timezone:'UTC'},0);
  for(const [id,status,time] of [['a','accepted',10],['b','cancelled',10],['c','accepted',100],['d','queued',null],['e','claimed',null]]) {
    store.db.prepare('INSERT INTO platform_inspections(id,schedule_id,message,status,created_at,finished_at) VALUES(?,?,?,?,?,?)').run(id,plan.id,'synthetic',status,1,time);
    store.db.prepare('INSERT INTO platform_schedule_runs VALUES(?,?,?,?,?)').run(id,plan.id,id.charCodeAt(0),1,id);
  }
  assert.equal(schedules.pruneInspectionHistory({cutoff:100,limit:1}),1);
  assert.equal(schedules.pruneInspectionHistory({cutoff:100,limit:1}),1);
  assert.equal(schedules.pruneInspectionHistory({cutoff:100,limit:1}),0);
  assert.deepEqual(store.db.prepare('SELECT id FROM platform_inspections ORDER BY id').all().map(x=>x.id),['c','d','e']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_schedule_runs').get().n,3);assert.equal(schedules.list().length,1);
  assert.equal(schedules.acknowledgeInspection('e','conversation').accepted,true);assert.ok(store.db.prepare("SELECT finished_at FROM platform_inspections WHERE id='e'").get().finished_at>100);
  schedules.delete(plan.id);assert.ok(store.db.prepare("SELECT finished_at FROM platform_inspections WHERE id='d'").get().finished_at>100);
});

test('legacy terminal history migrates completion timestamps conservatively after interrupted schema upgrades',t=>{
  for(const interrupted of [false,true]) {
  const root=mkdtempSync(join(tmpdir(),'task-retention-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'legacy.sqlite'),db=new DatabaseSync(path);
  db.exec("CREATE TABLE agent_requests(task_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,request_id TEXT NOT NULL,type TEXT NOT NULL,module_version TEXT NOT NULL,input TEXT NOT NULL,execution_input TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO agent_requests VALUES('old','client','request','test.retention','1','{}','{}','completed',NULL,'{}',NULL,1,70); CREATE TABLE platform_inspections(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,conversation_id TEXT,created_at INTEGER NOT NULL); INSERT INTO platform_inspections VALUES('legacy','schedule','synthetic','accepted','conversation',1)");
  if(interrupted)db.exec('ALTER TABLE agent_requests ADD COLUMN finished_at INTEGER; ALTER TABLE platform_inspections ADD COLUMN finished_at INTEGER');
  db.close();
  const before=Date.now(),{store}=setup(t,{},path);new ScheduleStore(store);
  assert.equal(store.raw('old').finished_at,70);assert.ok(store.db.prepare("SELECT finished_at FROM platform_inspections WHERE id='legacy'").get().finished_at>=before);
  assert.deepEqual(ids(store.expiredTasks({cutoff:100,now:1000})),['old']);
  }
});

test('accepted plugin snapshots and current plugin settings survive removal of unrelated expired history',async t=>{
  const {store,accept}=setup(t),old=await finished(store,accept);
  const definition={type:'snapshot.retention',name:'Synthetic snapshot',instructions:'Original accepted instructions',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
  store.plugins.save(definition);
  const accepted=store.accept('synthetic',{type:definition.type,request_id:'accepted-snapshot',input:{}});
  store.plugins.save({...definition,instructions:'New instructions for later requests'});
  const snapshot=store.raw(accepted.task_id).definition;
  assert.equal(store.purgeTaskHistory(old.task_id,{cutoff:100,now:1000}),true);
  assert.equal(store.raw(accepted.task_id).definition,snapshot);
  assert.equal(store.moduleFor(store.raw(accepted.task_id)).definition.instructions,'Original accepted instructions');
  assert.equal(store.plugins.get(definition.type).instructions,'New instructions for later requests');
});

test('pending final validators keep a terminal failure ineligible until they finish',async t=>{
  let entered,release;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const {store,accept}=setup(t,{validateResult:async result=>{entered();await blocked;return result;}});
  const task=accept(),run=store.claim(task.task_id),completion=store.complete(run.run_id,{});
  await started;store.fail(run.run_id,'SYNTHETIC_TIMEOUT');
  const cutoff=Date.now()+1000,now=cutoff;
  assert.equal(store.isHistoryIdle(),false);
  assert.equal(store.canPurgeTaskHistory(task.task_id,{cutoff,now}),false);
  assert.deepEqual(store.expiredTasks({cutoff,now}),[]);
  release();await assert.rejects(completion,{code:'TASK_CLOSED'});
  assert.equal(store.isHistoryIdle(),true);assert.equal(store.canPurgeTaskHistory(task.task_id,{cutoff,now}),true);
});

test('a catalog cleanup failure rolls provider changes back with the task history',async t=>{
  const catalog=createPlatformCatalog({workspace:'/unused'}),cleanup=catalog.deleteTaskHistory;
  catalog.deleteTaskHistory=context=>{cleanup(context);throw new Error('catalog cleanup failed');};
  const {store,accept}=setup(t,{},':memory:',catalog),task=await finished(store,accept);
  store.db.prepare('INSERT INTO platform_artifacts VALUES(?,?,?,?)').run('artifact',task.task_id,task.run_id,'{}');
  store.db.prepare('INSERT INTO platform_delivery_details VALUES(?,?,?,?)').run(task.task_id,200,null,10);
  assert.throws(()=>store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),/catalog cleanup failed/);
  assert.ok(store.get(task.task_id));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_artifacts').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_delivery_details').get().n,1);
});

for(const retired of ['tool','resource'])test(`retention purges expired JSON tasks after their ${retired} is retired`,async t=>{
  const catalog=createPlatformCatalog({workspace:'/unused'});
  catalog.tools.retired_tool={inputSchema:{type:'object'},execute:async()=>({})};
  catalog.resources.retired_resource={kind:'text',path:'/synthetic/reference.txt'};
  const {store,registry}=setup(t,{},':memory:',catalog);
  const definition={type:`retired.${retired}`,name:'Retired dependency',instructions:'Synthetic task',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:retired==='tool'?['retired_tool']:[]},resources:retired==='resource'?['retired_resource']:[],delivery:{mode:'none'}};
  store.plugins.save(definition);
  const task=store.accept('synthetic',{type:definition.type,request_id:'retired-dependency',input:{}}),run=store.claim(task.task_id);
  await store.complete(run.run_id,{});
  store.db.prepare('UPDATE agent_requests SET finished_at=10 WHERE task_id=?').run(task.task_id);
  store.db.prepare('UPDATE agent_runs SET receipt_until=0 WHERE run_id=?').run(run.run_id);
  store.db.prepare('INSERT INTO platform_artifacts VALUES(?,?,?,?)').run('retired-artifact',task.task_id,run.run_id,'{}');
  delete catalog.tools.retired_tool;delete catalog.resources.retired_resource;registry.compiledDefinitions.clear();
  assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),true);
  assert.equal(store.raw(task.task_id),undefined);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_artifacts').get().n,0);
  assert.equal(store.plugins.get(definition.type).instructions,'Synthetic task');
});

test('retention invokes installed profile cleanup without compiling a historical JSON contract',async t=>{
  const catalog=createPlatformCatalog({workspace:'/unused'});
  catalog.profiles={'retired.profile':{deleteTaskHistory:({store,taskId})=>store.db.prepare('DELETE FROM profile_history WHERE task_id=?').run(taskId)}};
  const {store,registry}=setup(t,{},':memory:',catalog);
  store.db.exec('CREATE TABLE profile_history(task_id TEXT PRIMARY KEY)');
  const definition={type:'retired.profile',name:'Synthetic profile',instructions:'Synthetic task',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:['write_text_artifact']},delivery:{mode:'none'}};
  store.plugins.save(definition);
  const task=store.accept('synthetic',{type:definition.type,request_id:'profile',input:{}},{prepared:{result:{}}});
  store.db.prepare('UPDATE agent_requests SET finished_at=10 WHERE task_id=?').run(task.task_id);
  store.db.prepare('INSERT INTO profile_history VALUES(?)').run(task.task_id);
  delete catalog.tools.write_text_artifact;registry.compiledDefinitions.clear();registry.modules.delete(definition.type);
  assert.equal(store.purgeTaskHistory(task.task_id,{cutoff:100,now:1000}),true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM profile_history').get().n,0);
});
