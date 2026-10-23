import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
const definition={type:'review.text',name:'审核',instructions:'审核并提交',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
async function setup(t) {
  const {OperationsService}=await import('../src/operations/service.mjs');
  const registry=new BusinessRegistry(),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());store.plugins.save(definition);
  const config={concurrency:1,paused:false},dispatcher={config,drain:async()=>{}};
  const service=new OperationsService({store,registry,config,dispatcher,runner:{ready:async()=>({ready:true}),configure:async()=>{}}});
  const accept=()=>store.accept('default',{type:definition.type,request_id:'business-request',input:{content:'测试'}});
  return {service,store,config,accept};
}
test('operations query failures and retry as a related new task without reopening history',async t=>{
  const {service,store,accept}=await setup(t);const first=accept(),run=store.claim(first.task_id);
  store.recordRun(run.run_id,{error_message:'额度不足',error_source:'codex'});store.fail(run.run_id,'CODEX_TURN_FAILED');
  const rows=await service.execute('tasks',{status:'failed'});assert.equal(rows[0].error.message,'额度不足');
  const next=await service.execute('retry',{task_id:first.task_id});
  assert.notEqual(next.task_id,first.task_id);assert.equal(next.retry_of,first.task_id);assert.equal(store.get(first.task_id).status,'failed');
  assert.equal(store.get(next.task_id).status,'queued');
  await assert.rejects(service.execute('retry',{task_id:next.task_id}),/TASK_NOT_TERMINAL/);
});
test('runtime changes persist and plugin operations immediately affect new requests',async t=>{
  const {service,store,config,accept}=await setup(t);
  await service.execute('runtime_update',{paused:true,concurrency:4});assert.equal(config.paused,true);assert.equal(config.concurrency,4);
  assert.equal((await service.execute('configuration_get',{scope:'execution'})).values.concurrency,4);
  await service.execute('plugin_enable',{type:definition.type,enabled:false});assert.throws(accept,/PLUGIN_DISABLED/);
  assert.equal((await service.execute('overview',{})).tasks.queued,0);
});
test('management can submit a trial through the same independent task API contract',async t=>{
  const {service,store}=await setup(t);
  const task=await service.execute('submit_task',{type:definition.type,input:{content:'试运行'}});
  assert.equal(task.status,'queued');assert.equal(store.raw(task.task_id).type,definition.type);
});
