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
