import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {BusinessRegistry} from '../src/core/registry.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {acceptPendingInspections} from '../src/manager/inspections.mjs';

const definition={type:'delete.example',name:'Synthetic plugin',enabled:true,instructions:'Return a result.',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
const key='synthetic-deletion-plugin-key-123456789';
function setup(t,path=':memory:') {
  const registry=new BusinessRegistry([],{requirePluginConnections:true});
  registry.initialDefinitions=[definition];
  const store=new RequestStore(path,{registry});t.after(()=>store.close());
  const service=new OperationsService({store,registry,config:{},dispatcher:{drain:async()=>{}},runner:{}});
  return {store,service,connections:store.pluginConnections};
}
function ready({store,connections}) {connections.update(definition.type,{entryKey:key});store.plugins.setEnabled(definition.type,true);}
const accept=store=>store.accept('synthetic',{type:definition.type,request_id:'synthetic',input:{text:'hello'}});
const plan=(extra={})=>({name:'Synthetic schedule',kind:'task',cron:'* * * * *',type:definition.type,input:{text:'hello'},...extra});

test('logical plugin deletion hides the definition, pauses its plans and keeps accepted work and credentials scoped',async t=>{
  const state=setup(t),{store,service,connections}=state;ready(state);
  connections.update(definition.type,{callbackUrl:'https://example.invalid/synthetic-callback',callbackToken:'synthetic-retained-callback'});
  const task=accept(store),ownPlan=service.schedules.save(plan()),other=service.schedules.save(plan({kind:'inspection',message:'Synthetic inspection'}));
  const deleted=await service.execute('plugin_delete',{type:definition.type});
  assert.equal(deleted.deleted,true);assert.ok(deleted.deleted_at>0);
  assert.equal((await service.execute('plugins')).configured.length,0);
  assert.throws(()=>store.plugins.get(definition.type),{code:'PLUGIN_NOT_FOUND'});
  assert.throws(()=>accept(store),{code:'PLUGIN_DELETED'});
  assert.equal(store.db.prepare('SELECT deleted_at FROM platform_plugins WHERE type=?').get(definition.type).deleted_at,deleted.deleted_at);
  const paused=service.schedules.get(ownPlan.id);assert.equal(paused.enabled,false);assert.equal(paused.blocked_reason,'PLUGIN_DELETED');
  assert.equal(service.schedules.get(other.id).enabled,true);
  await service.schedules.tick(ownPlan.next_run_at+1000);
  assert.equal(store.listTasks({}).length,1);
  // Already accepted work uses its persisted plugin contract, including future completion/delivery.
  const run=store.claim(task.task_id);await store.complete(run.run_id,{ok:true});
  assert.equal(store.get(task.task_id).status,'completed');
  assert.throws(()=>store.retry(task.task_id),{code:'PLUGIN_DELETED'});
  assert.equal(connections.authenticate(key),definition.type);
  assert.deepEqual(connections.callbackFor(definition.type),{url:'https://example.invalid/synthetic-callback',token:'synthetic-retained-callback'});
  for(const mutate of [()=>store.plugins.save(definition),()=>connections.initialize(definition.type),()=>connections.update(definition.type,{entryKey:key}),()=>connections.claimEntryKey(definition.type,{revision:connections.get(definition.type).revision})])
    assert.throws(mutate,{code:'PLUGIN_DELETED'});
  assert.deepEqual(await service.execute('plugin_delete',{type:definition.type}),deleted);
});

test('logical schedule deletion cancels unaccepted inspections without deleting run history or reviving on save',async t=>{
  const {service,store}=setup(t);
  const saved=service.schedules.save(plan({kind:'inspection',message:'Synthetic inspection'}));
  await service.schedules.tick(saved.next_run_at);
  assert.equal(service.schedules.pendingInspections().length,1);
  const deleted=await service.execute('schedule_delete',{id:saved.id});
  assert.equal(deleted.deleted,true);assert.equal(service.schedules.list().length,0);
  assert.equal(service.schedules.pendingInspections().length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM platform_schedule_runs').get().count,1);
  assert.equal(store.db.prepare('SELECT status FROM platform_inspections').get().status,'cancelled');
  assert.throws(()=>service.schedules.save({...saved,enabled:true}),{code:'SCHEDULE_DELETED'});
  assert.throws(()=>service.schedules.setEnabled(saved.id,true),{code:'SCHEDULE_NOT_FOUND'});
  await service.schedules.tick(saved.next_run_at+120000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM platform_schedule_runs').get().count,1);
  assert.deepEqual(await service.execute('schedule_delete',{id:saved.id}),deleted);
});

test('legacy schema migrates and plugin/schedule tombstones survive restart without reseeding examples',async t=>{
  const root=process.platform==='win32'?'.tmp/soft-delete':tmpdir();mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(join(root,'database-'));
  const path=join(dir,'tasks.sqlite'),legacy=new DatabaseSync(path);
  legacy.exec('CREATE TABLE platform_plugins(type TEXT PRIMARY KEY,definition TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE platform_schedules(id TEXT PRIMARY KEY,definition TEXT NOT NULL,enabled INTEGER NOT NULL,next_run_at INTEGER NOT NULL,blocked_reason TEXT,updated_at INTEGER NOT NULL)');legacy.close();
  const first=setup(t,path),saved=first.service.schedules.save(plan({kind:'inspection',message:'Synthetic inspection'}));
  ready(first);const task=accept(first.store);
  await first.service.execute('schedule_delete',{id:saved.id});await first.service.execute('plugin_delete',{type:definition.type});
  const next=setup(t,path);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.deepEqual(next.store.plugins.list(),[]);assert.deepEqual(next.service.schedules.list(),[]);
  assert.equal(next.store.registry.modules.has(definition.type),false);
  assert.throws(()=>next.store.plugins.save(definition),{code:'PLUGIN_DELETED'});
  const run=next.store.claim(task.task_id);await next.store.complete(run.run_id,{ok:true});
  assert.equal(next.store.get(task.task_id).status,'completed');assert.equal(next.connections.authenticate(key),definition.type);
});

test('a stale inspection list cannot start work after schedule deletion wins the claim',async t=>{
  const {service}=setup(t),manager=new ManagerStore(':memory:');t.after(()=>manager.close());
  const saved=service.schedules.save(plan({kind:'inspection',message:'Synthetic inspection'}));await service.schedules.tick(saved.next_run_at);
  let kicks=0;
  const client={async execute(action,args){
    const result=await service.execute(action,args);
    if(action==='inspection_list')await service.execute('schedule_delete',{id:saved.id});
    return result;
  }};
  await acceptPendingInspections({client,store:manager,agent:{kick(){kicks++;}}});
  assert.equal(manager.list().length,0);assert.equal(kicks,0);
  const id=service.store.db.prepare('SELECT id FROM platform_inspections').get().id;
  assert.deepEqual(await service.execute('inspection_ack',{id,conversation_id:'synthetic'}),{accepted:false});
});

test('a claimed inspection survives deletion and a lost response without duplicating Manager work',async t=>{
  const {service}=setup(t),manager=new ManagerStore(':memory:');t.after(()=>manager.close());
  const saved=service.schedules.save(plan({kind:'inspection',message:'Synthetic inspection'}));await service.schedules.tick(saved.next_run_at);
  const item=service.schedules.pendingInspections()[0];assert.equal(service.schedules.claimInspection(item.id).accepted,true);
  service.schedules.delete(saved.id);
  let kicks=0,loseAck=true;
  const client={async execute(action,args){if(action==='inspection_ack'&&loseAck){loseAck=false;throw new Error('Synthetic lost acknowledgement');}return service.execute(action,args);}};
  const context={client,store:manager,agent:{kick(){kicks++;}}};
  await assert.rejects(acceptPendingInspections(context),/lost acknowledgement/);
  await acceptPendingInspections(context);await acceptPendingInspections(context);
  assert.equal(kicks,1);assert.equal(manager.list().length,1);assert.equal(service.schedules.pendingInspections().length,0);
});
