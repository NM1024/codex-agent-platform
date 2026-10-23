import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { createApplication } from '../src/application.mjs';
import { createTaskApi } from '../src/api.mjs';

const definition = () => ({
  type: 'story.generate', name: '故事', description: '根据主题写作',
  input_schema: {type:'object',properties:{topic:{type:'string'}},required:['topic'],additionalProperties:false},
  result_schema: {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
  instructions:'根据输入主题完成故事，通过 complete_task 提交。',
  capabilities:{tools:[],image_generation:false,web_search:false},resources:[],delivery:{mode:'none'},enabled:true,
});
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'plugins-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const registry=new BusinessRegistry();
  const store=new RequestStore(join(root,'tasks.sqlite'),{registry});
  t.after(()=>store.close());
  return {root,registry,store};
}
test('a JSON plugin accepts independent tasks and retains its contract after edit and disable',async t=>{
  const {store}=setup(t);
  store.plugins.save(definition());
  const body={type:'story.generate',request_id:'same',input:{topic:'冬天'}};
  const first=store.accept('default',body),second=store.accept('default',body);
  assert.notEqual(first.task_id,second.task_id);
  const changed=definition();changed.result_schema={type:'object',properties:{new_text:{type:'string'}},required:['new_text'],additionalProperties:false};
  store.plugins.save(changed);store.plugins.setEnabled(changed.type,false);
  assert.throws(()=>store.accept('default',body),/PLUGIN_DISABLED/);
  const run=store.claim(first.task_id);
  assert.equal(run.definition.instructions,definition().instructions);
  assert.equal(store.moduleFor(store.raw(first.task_id)).checkResult({text:'旧契约仍然有效'}),true);
  await store.complete(run.run_id,{text:'旧契约仍然有效'});
  assert.equal(store.get(first.task_id).status,'completed');
  assert.deepEqual(store.get(first.task_id).result,{text:'旧契约仍然有效'});
});
test('plugin definitions and queued task snapshots survive SQLite reopening',async t=>{
  const {root,store}=setup(t);store.plugins.save(definition());
  const accepted=store.accept('default',{type:'story.generate',request_id:'r',input:{topic:'海'}});
  const registry=new BusinessRegistry(),reopened=new RequestStore(join(root,'tasks.sqlite'),{registry});
  t.after(()=>reopened.close());
  assert.equal(reopened.plugins.list()[0].type,'story.generate');
  reopened.plugins.setEnabled('story.generate',false);
  const run=reopened.claim(accepted.task_id);
  await reopened.complete(run.run_id,{text:'海的故事'});
  assert.equal(reopened.get(accepted.task_id).status,'completed');
});
test('plugins reject executable fields and unavailable capabilities with readable errors',t=>{
  const {store}=setup(t);
  assert.throws(()=>store.plugins.save({...definition(),script:'process.exit()'}),/INVALID_PLUGIN/);
  assert.throws(()=>store.plugins.save({...definition(),revision:5}),/revision/);
  const bad=definition();bad.capabilities.tools=['nonexistent_tool'];
  assert.throws(()=>store.plugins.save(bad),/CAPABILITY_UNAVAILABLE/);
  assert.equal(store.plugins.list().length,0);
});
test('specific Codex failure details remain available after task failure',t=>{
  const {store}=setup(t);store.plugins.save(definition());
  const task=store.accept('test',{type:'story.generate',request_id:'error',input:{topic:'雨'}}),run=store.claim(task.task_id);
  store.recordRun(run.run_id,{error_source:'codex',error_message:'The model returned a connection error.',last_agent_message:'未能完成任务。'});
  store.fail(run.run_id,'CODEX_TURN_FAILED');
  assert.equal(store.get(task.task_id).error.message,'The model returned a connection error.');
  assert.equal(store.get(task.task_id).execution.last_agent_message,'未能完成任务。');
});
test('runner can compile a callback task snapshot without receiving the gateway target credentials',t=>{
  const registry=new BusinessRegistry([], {tools:{}});
  const source={...definition(),delivery:{mode:'callback_once',target:'private-target'}};
  const module=registry.forTask({type:source.type,definition:source});
  assert.match(module.buildTask({topic:'云'}).prompt,/云/);
  assert.throws(()=>registry.registerDefinition(source),/TARGET_UNAVAILABLE/);
});

test('a configured route accepts the plugin envelope and rejects system routes and alias collisions',async t=>{
  const {store,registry}=setup(t);store.plugins.save({...definition(),routes:['/hooks/story']});
  const server=createTaskApi({store,registry,dispatcher:{drain:async()=>{},runner:{}},runner:{},config:{ingressToken:'local',clientId:'default'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/hooks/story`,{method:'POST',headers:{authorization:'Bearer local','content-type':'application/json'},body:JSON.stringify({request_id:'alias',input:{topic:'雨'}})});
  assert.equal(response.status,202);assert.equal((await response.json()).type,'story.generate');
  assert.throws(()=>store.plugins.save({...definition(),type:'other.story',routes:['/hooks/story']}),/ROUTE_CONFLICT/);
  assert.throws(()=>store.plugins.save({...definition(),routes:['/admin']}),/INVALID_PLUGIN/);
});
