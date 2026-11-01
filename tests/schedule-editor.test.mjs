import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
function fixture(t){const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-schedule-editor'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());return new OperationsService({...app,store,dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})},configuration:app.configuration(store)});}
const definition={name:'Synthetic schedule',kind:'inspection',message:'Synthetic inspection only',cron:'0 9 * * *',timezone:'Asia/Shanghai',enabled:true};
test('stale schedule editor cannot re-enable a plan stopped after the editor opened',async t=>{
 const operations=fixture(t),loaded=await operations.execute('schedule_save',{schedule:definition,revision:0});const stopped=operations.schedules.setEnabled(loaded.id,false);
 await assert.rejects(operations.execute('schedule_save',{schedule:{...definition,id:loaded.id,name:'Stale rename'},revision:loaded.revision}),{status:409,code:'SCHEDULE_REVISION_CONFLICT'});
 const current=operations.schedules.get(loaded.id);assert.equal(current.enabled,false);assert.equal(current.name,definition.name);assert.equal(current.next_run_at,stopped.next_run_at);
 const saved=await operations.execute('schedule_save',{schedule:{...definition,id:current.id,enabled:false,name:'Fresh rename'},revision:current.revision});assert.equal(saved.name,'Fresh rename');assert.equal(saved.enabled,false);assert.ok(saved.revision>current.revision);
});
test('schedule revisions advance even for writes at identical simulated timestamps and create-only protects IDs',async t=>{
 const operations=fixture(t),plan=operations.schedules.save(definition,100000);const changed=operations.schedules.save({...definition,id:plan.id,name:'Changed'},100000,{revision:plan.revision});assert.ok(changed.revision>plan.revision);
 assert.throws(()=>operations.schedules.save({...definition,id:plan.id},100000,{revision:plan.revision}),{code:'SCHEDULE_REVISION_CONFLICT'});
 await assert.rejects(operations.execute('schedule_save',{schedule:{...definition,id:plan.id},revision:0}),{code:'SCHEDULE_REVISION_CONFLICT'});
});
test('saving schedule bindings preserves timing and atomically rejects stale binding revisions',async t=>{
 const operations=fixture(t),plan=await operations.execute('schedule_save',{schedule:definition,revision:0});
 const binding=operations.notifications.notifications.getBinding({kind:'schedule',id:plan.id});
 const saved=await operations.execute('schedule_save',{schedule:{...definition,id:plan.id,notification_channels:[]},revision:plan.revision,notification_revision:binding.notification_revision});
 assert.equal(saved.next_run_at,plan.next_run_at);
 await assert.rejects(operations.execute('schedule_save',{schedule:{...definition,id:plan.id,name:'Must roll back',notification_channels:[]},revision:saved.revision,notification_revision:binding.notification_revision}),{status:409,code:'NOTIFICATION_BINDING_REVISION_CONFLICT'});
 assert.equal(operations.schedules.get(plan.id).name,definition.name);
 assert.equal(operations.schedules.get(plan.id).revision,saved.revision);
});
test('global schedule history retains inspection runs after plan deletion with filters and stable pages',async t=>{
 const operations=fixture(t),first=operations.schedules.save({...definition,name:'Synthetic first',cron:'* * * * *'},100000),second=operations.schedules.save({...definition,name:'Synthetic second',cron:'* * * * *'},100000);
 await operations.schedules.tick(120000);operations.schedules.delete(first.id);
 const rows=await operations.execute('schedule_runs',{});assert.equal(rows.length,2);assert.ok(rows.every(row=>row.kind==='inspection'&&['queued','cancelled'].includes(row.status)));
 assert.equal((await operations.execute('schedule_runs',{search:'Synthetic first'}))[0].schedule_id,first.id);
 assert.equal((await operations.execute('schedule_runs',{status:'completed'})).length,0);
 assert.notEqual((await operations.execute('schedule_runs',{limit:1}))[0].id,(await operations.execute('schedule_runs',{limit:1,offset:1}))[0].id);
 assert.equal((await operations.execute('schedule_execution',{id:rows[0].id})).id,rows[0].id);
 assert.ok(second.id);
});
test('saving plan fields without a channel draft preserves the independent binding revision',async t=>{
 const operations=fixture(t),channel=await operations.execute('notification_channel_save',{channel:{name:'Synthetic retained binding',provider:'custom',url:'https://example.invalid/retained'}});
 const plan=await operations.execute('schedule_save',{schedule:{...definition,notification_channels:[channel.id]},revision:0});
 const before=operations.notifications.notifications.getBinding({kind:'schedule',id:plan.id});
 await operations.execute('schedule_save',{schedule:{...definition,id:plan.id,name:'Synthetic renamed'},revision:plan.revision});
 assert.deepEqual(operations.notifications.notifications.getBinding({kind:'schedule',id:plan.id}),before);
});
