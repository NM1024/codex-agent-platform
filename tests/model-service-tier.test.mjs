import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as models from '../src/codex/models.mjs';
import {runtimeSettings} from '../src/configuration/execution.mjs';
import {resolveAgentSettings} from '../src/configuration/agent-settings.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';
import {configurePlugin} from './helpers/plugin-connections.mjs';

const entry={model:'fixture-model',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],serviceTiers:[{id:'priority',name:'Fast',description:'Increased usage'}]};
function catalog(data=[entry]) {
  const calls=[];
  return {calls,notify(){},async request(method){calls.push(method);return method==='initialize'?{}:{data};}};
}

test('runtime settings explicitly default to standard independently of reasoning',()=>{
  assert.equal(runtimeSettings({}).serviceTier,'default');
  assert.equal(runtimeSettings({serviceTier:'priority',reasoningEffort:'high'}).serviceTier,'priority');
  assert.equal(resolveAgentSettings({serviceTier:'priority'},{serviceTier:'default'}).serviceTier,'default');
  assert.equal(resolveAgentSettings({serviceTier:'priority'},{}).serviceTier,'priority');
});

test('manager speed persists separately and old global configuration remains standard',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const agent={model:'fixture-model',timeoutMs:1000,toolTimeoutMs:1000};
  const settings=createManagerConfiguration({store,agent});
  assert.equal(agent.serviceTier,'default');
  settings.update('manager',{serviceTier:'priority',reasoningEffort:'high'});
  settings.update('manager',{serviceTier:'default'});
  assert.equal(agent.reasoningEffort,'high');assert.equal(agent.serviceTier,'default');
  assert.throws(()=>settings.update('manager',{serviceTier:'flex'}),{code:'INVALID_CONFIGURATION'});
  store.db.exec("UPDATE platform_settings SET value=json_remove(value,'$.values.serviceTier') WHERE key='configuration:manager'");
  const reopened={model:'fixture-model',timeoutMs:1000,toolTimeoutMs:1000};createManagerConfiguration({store,agent:reopened});
  assert.equal(reopened.serviceTier,'default');
});

test('business defaults and conversation overrides accept only standard or fast',t=>{
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-internal'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  const settings=app.configuration(store);
  assert.equal(app.config.serviceTier,'default');
  settings.update('execution',{serviceTier:'priority'});assert.equal(app.config.serviceTier,'priority');
  assert.throws(()=>settings.update('execution',{serviceTier:null}),{code:'INVALID_CONFIGURATION'});
  store.db.exec("UPDATE platform_settings SET value=json_remove(value,'$.values.serviceTier') WHERE key='configuration:execution'");
  app.configuration(store);assert.equal(app.config.serviceTier,'default');
  const manager=new ManagerStore(':memory:');t.after(()=>manager.close());
  const conversation=manager.createConversation('Synthetic');
  manager.setConversationExecution(conversation.id,{serviceTier:'priority'});
  assert.equal(manager.getConversation(conversation.id).execution.serviceTier,'priority');
  manager.setConversationExecution(conversation.id,{serviceTier:'default'});
  assert.throws(()=>manager.setConversationExecution(conversation.id,{serviceTier:'fast'}),{code:'INVALID_CONFIGURATION'});
});

test('model discovery retains supported speed tiers without opting into catalog defaults',async()=>{
  const result=await models.readModels(catalog([{...entry,defaultServiceTier:'priority'}]));
  assert.deepEqual(result[0].serviceTiers,entry.serviceTiers);
  assert.equal(runtimeSettings({}).serviceTier,'default');
});

test('speed and reasoning validate against one catalog read and unsupported fast is rejected',async()=>{
  assert.equal(typeof models.validateModelExecution,'function');
  const client=catalog();
  assert.deepEqual(await models.validateModelExecution(client,{model:entry.model,reasoningEffort:'high',serviceTier:'priority'}),{effort:'high',serviceTier:'priority'});
  assert.equal(client.calls.filter(method=>method==='model/list').length,1);
  await assert.rejects(models.validateModelExecution(catalog([{...entry,serviceTiers:[]}]),{model:entry.model,serviceTier:'priority'}),{code:'UNSUPPORTED_SERVICE_TIER'});
  await assert.rejects(models.validateModelExecution(catalog([]),{model:entry.model,serviceTier:'priority'}),{code:'UNSUPPORTED_SERVICE_TIER'});
});

test('standard and legacy execution do not require model discovery',async()=>{
  assert.equal(typeof models.validateModelExecution,'function');
  const client={request(){throw new Error('No catalog should be queried');}};
  for(const settings of [{model:entry.model},{model:entry.model,serviceTier:'default'}])assert.deepEqual(await models.validateModelExecution(client,settings),{effort:null,serviceTier:'default'});
});

test('accepted plugin speed overrides survive edits and enter execution records',async t=>{
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-internal'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());app.configuration(store);
  const {revision,updated_at,...definition}=store.plugins.get('content.review');
  store.plugins.save({...definition,execution:{serviceTier:'priority'}});configurePlugin(store,definition.type);
  const task=store.accept('synthetic',{type:definition.type,input:{content:'Synthetic input'},request_id:'speed-snapshot'});
  store.plugins.save({...definition,execution:{serviceTier:'default'}});
  const launches=[],dispatcher=new Dispatcher({store,registry:app.registry,config:{...app.config,concurrency:1},runner:{ready:async()=>({ready:true}),launch:async run=>{launches.push(run);return {status:'running'};}}});t.after(()=>dispatcher.stop());
  await dispatcher.drain();assert.equal(launches[0].execution.serviceTier,'priority');
  assert.equal(store.executionSettings(store.raw(task.task_id).run_id).serviceTier,'priority');
});

test('manager forwards fast and then explicitly clears it on a resumed conversation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-speed-')),store=new ManagerStore(':memory:'),calls=[];
  let index=0;
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),model:entry.model,timeoutMs:1000,createClient:()=>{
    let listener;
    return {notify(){},close:async()=>{},subscribe(fn){listener=fn;return()=>{};},async request(method,params){
      calls.push({method,params});
      if(method==='model/list')return {data:[entry]};
      if(method==='thread/start'||method==='thread/resume'||method==='thread/read')return {thread:{id:'synthetic-thread'}};
      if(method==='turn/start'){
        const id='turn-'+(++index);setImmediate(()=>listener({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id,status:'completed'}}}));return {turn:{id}};
      }
      return {};
    }};
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const configuration=createManagerConfiguration({store,agent}),conversation=store.createConversation('Synthetic speed');
  configuration.update('manager',{serviceTier:'priority',reasoningEffort:'high'});
  agent.enqueue(conversation.id,'Synthetic fast');await agent.idle(conversation.id);
  store.setConversationExecution(conversation.id,{serviceTier:'default'});
  agent.enqueue(conversation.id,'Synthetic standard');await agent.idle(conversation.id);
  assert.deepEqual(calls.filter(call=>['thread/start','thread/resume'].includes(call.method)).map(call=>call.params.serviceTier),['priority','default']);
  assert.deepEqual(calls.filter(call=>call.method==='turn/start').map(call=>call.params.serviceTier),['priority','default']);
  assert.deepEqual(calls.filter(call=>call.method==='turn/start').map(call=>call.params.effort),['high','high']);
  const legacy=store.enqueue(conversation.id,'Legacy snapshot');store.recordMessageExecution(legacy.id,{model:entry.model,timeoutMs:1000,toolTimeoutMs:1000});agent.kick(conversation.id);await agent.idle(conversation.id);
  assert.equal(calls.filter(call=>call.method==='turn/start').at(-1).params.serviceTier,'default');
});
