import test from 'node:test';
import {configurePlugin} from './helpers/plugin-connections.mjs';
import assert from 'node:assert/strict';
import {resolveAgentSettings} from '../src/configuration/agent-settings.mjs';
import {readModels,validateModelEffort,createModelCatalog} from '../src/codex/models.mjs';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('model overrides inherit settings but a different model uses its own default effort',()=>{
  const base={model:'fixture-a',reasoningEffort:'high',taskTimeoutMs:1000};
  assert.deepEqual(resolveAgentSettings(base,{}),base);
  assert.deepEqual(resolveAgentSettings(base,{model:'fixture-b'}),{...base,model:'fixture-b',reasoningEffort:null});
  assert.equal(resolveAgentSettings(base,{reasoningEffort:null}).reasoningEffort,null);
  assert.equal(resolveAgentSettings(base,{model:'fixture-b',reasoningEffort:'low'}).reasoningEffort,'low');
  assert.equal(base.reasoningEffort,'high');
});

test('plugin execution updates preserve current business logic and accepted task snapshots',async t=>{
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-runner'});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  const operations=new OperationsService({...app,store});
  configurePlugin(store,'content.review');
  const before=store.plugins.get('content.review');
  const accepted=store.accept('fixture',{type:before.type,input:{content:'Synthetic article'},request_id:'before-model-change'});
  const connection=store.pluginConnections.get(before.type);
  const updated=await operations.execute('plugin_execution_update',{type:before.type,revision:before.revision,execution:{model:'fixture-b',reasoningEffort:'low'}});
  assert.deepEqual(updated.execution,{model:'fixture-b',reasoningEffort:'low'});
  for(const key of ['instructions','input_schema','result_schema','capabilities','enabled'])assert.deepEqual(updated[key],before[key]);
  assert.deepEqual(store.pluginConnections.get(before.type),connection);
  assert.notDeepEqual(store.moduleFor(store.raw(accepted.task_id)).definition.execution,updated.execution);
  await assert.rejects(operations.execute('plugin_execution_update',{type:before.type,revision:before.revision,execution:{}}),{code:'PLUGIN_REVISION_CONFLICT'});
  await assert.rejects(operations.execute('plugin_execution_update',{type:before.type,revision:updated.revision,execution:{model:''}}),{code:'INVALID_MANAGEMENT_INPUT'});
  const reset=await operations.execute('plugin_execution_update',{type:before.type,revision:updated.revision,execution:{reasoningEffort:null}});
  assert.deepEqual(reset.execution,{reasoningEffort:null});
  const inherited=await operations.execute('plugin_execution_update',{type:before.type,revision:reset.revision,execution:{}});
  assert.deepEqual(inherited.execution,{});
  store.plugins.delete(before.type);
  await assert.rejects(operations.execute('plugin_execution_update',{type:before.type,revision:inherited.revision,execution:{}}),{code:'PLUGIN_NOT_FOUND'});
});

test('model discovery reads all pages and excludes hidden models without starting a turn',async()=>{
  const calls=[];
  const client={notify(){},request:async(method,params)=>{
    calls.push([method,params]);
    if(method==='initialize')return {};
    assert.equal(method,'model/list');
    return params.cursor?{data:[{id:'b',model:'fixture-b',displayName:'Fixture B',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}
      :{data:[{id:'a',model:'fixture-a',displayName:'Fixture A',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'hidden',model:'hidden',hidden:true}],nextCursor:'page-2'};
  }};
  const models=await readModels(client);
  assert.deepEqual(models.map(m=>m.model),['fixture-a','fixture-b']);
  assert.deepEqual(models[0].supportedReasoningEfforts,[{reasoningEffort:'high'}]);
  assert.equal(calls.filter(([method])=>method==='model/list').length,2);
});

test('an unsupported explicit effort is rejected before starting a model turn',async()=>{
  const client={notify(){},request:async method=>method==='initialize'?{}:{data:[{model:'fixture-a',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}};
  await assert.rejects(validateModelEffort(client,{model:'fixture-a',reasoningEffort:'high'}),e=>e.code==='UNSUPPORTED_REASONING_EFFORT');
  await validateModelEffort(client,{model:'fixture-a',reasoningEffort:'low'});
});

test('choosing model default clears a previous explicit effort on a resumed thread',async()=>{
  const client={notify(){},request:async method=>method==='initialize'?{}:{data:[{model:'fixture-a',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]}};
  assert.equal(await validateModelEffort(client,{model:'fixture-a',reasoningEffort:null}),'medium');
});

test('catalog failures close the client and a subsequent request can recover',async()=>{
  let closed=0,attempts=0;
  const models=createModelCatalog({createClient:()=>({notify(){},close:async()=>{closed++;},request:async method=>{
    if(method==='initialize')return {};
    if(++attempts===1)throw new Error('synthetic offline');
    return {data:[{model:'fixture-recovered'}]};
  }})});
  await assert.rejects(models(),error=>error.code==='MODEL_CATALOG_UNAVAILABLE');
  assert.equal((await models()).models[0].model,'fixture-recovered');
  await models();assert.equal(closed,2);
});

test('accepted plugin model overrides survive plugin edits and are recorded in execution',async t=>{
  const app=createApplication('gateway',{INGRESS_TOKEN:'fixture-ingress',RUNNER_TOKEN:'fixture-runner'});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  const definition={type:'fixture.model',name:'Fixture',instructions:'Submit a result',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'},execution:{model:'fixture-b',reasoningEffort:'low'}};
  store.plugins.save(definition);
  configurePlugin(store,definition.type);
  const task=store.accept('fixture',{type:definition.type,input:{},request_id:'snapshot'});
  store.plugins.save({...definition,execution:{model:'fixture-c',reasoningEffort:'high'}});
  const launched=[],dispatcher=new Dispatcher({store,registry:app.registry,config:{model:'fixture-a',reasoningEffort:'high',concurrency:1},runner:{ready:async()=>({ready:true}),launch:async run=>{launched.push(run);return {status:'running'};}}});
  t.after(()=>dispatcher.stop());await dispatcher.drain();
  assert.equal(launched[0].execution.model,'fixture-b');
  assert.equal(launched[0].execution.reasoningEffort,'low');
  assert.equal(store.executionSettings(launched[0].run_id).reasoningEffort,'low');
  assert.equal(store.get(task.task_id).status,'running');
});

test('old global settings remain valid and manager reasoning is saved independently',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const agent={model:'fixture-a',timeoutMs:10000,toolTimeoutMs:1000};
  const configuration=createManagerConfiguration({store,agent});
  configuration.update('manager',{reasoningEffort:'high'});
  assert.equal(agent.reasoningEffort,'high');
  configuration.update('manager',{reasoningEffort:null});
  assert.equal(agent.reasoningEffort,null);
});

test('conversation overrides persist across restart and preserve existing conversation rows',async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-migration-')),path=join(root,'manager.sqlite');
  let store;
  t.after(async()=>{store?.close();await rm(root,{recursive:true,force:true});});
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE manager_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,thread_id TEXT,source_id TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO manager_conversations VALUES('old','Old conversation',NULL,NULL,1,1)");old.close();
  store=new ManagerStore(path);
  assert.deepEqual(store.getConversation('old').execution,{});
  store.setConversationExecution('old',{model:'fixture-b',reasoningEffort:null});
  assert.throws(()=>store.setConversationExecution('old',{reasoningEffort:'INVALID'}),e=>e.code==='INVALID_CONFIGURATION');
  const message=store.enqueue('old','Synthetic message');
  store.recordMessageExecution(message.id,{model:'fixture-b',reasoningEffort:'low'});
  store.close();store=new ManagerStore(path);
  assert.deepEqual(store.getConversation('old').execution,{model:'fixture-b',reasoningEffort:null});
  assert.deepEqual(store.next('old').execution,{model:'fixture-b',reasoningEffort:'low'});
  const fresh=store.createConversation('Fresh');
  assert.deepEqual(fresh.execution,{});
});
