import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {createTaskApi,createPrivateApi} from '../src/api.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {OperationsClient} from '../src/manager/client.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {managementTools} from '../src/contracts/management.mjs';

const keys={review:'review-human-entry-key-1234567890',beta:'beta-human-entry-key-123456789012',rotated:'review-rotated-entry-key-123456789'};
async function setup(t){
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-private-runner',INGRESS_TOKEN:'retired-global-key'});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  assert.ok(store.pluginConnections,'production installs per-plugin connections');
  const configuration=app.configuration(store),dispatcher={drain:async()=>{},blocked:new Map()},runner={ready:async()=>({ready:true})};
  const operations=new OperationsService({...app,store,configuration,dispatcher,runner});
  store.plugins.save({type:'isolation.beta',name:'Beta',instructions:'Return a result',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});
  for(const [type,key,path] of [['content.review',keys.review,'/hooks/review-own'],['isolation.beta',keys.beta,'/hooks/beta-own']]){
    store.pluginConnections.update(type,{entryAddress:path,entryKey:key});store.plugins.setEnabled(type,true);
  }
  async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}
  const base=await listen(createTaskApi({...app,store,dispatcher,runner}));
  const post=(path,body,key=keys.review)=>fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
  return {...app,store,configuration,operations,dispatcher,runner,listen,base,post};
}

test('deleted plugin rejects both admission routes but preserves scoped historical task and artifact access',async t=>{
  const {store,operations,registry,base,post}=await setup(t);
  const accepted=await post('/hooks/review-own',{request_id:'before-delete',input:{content:'synthetic'}});
  const task=await accepted.json();assert.equal(accepted.status,202);
  await operations.execute('plugin_delete',{type:'content.review'});
  for(const [path,body] of [['/hooks/review-own',{request_id:'after',input:{content:'x'}}],['/v2/tasks',{type:'content.review',request_id:'after',input:{content:'x'}}]]) {
    const response=await post(path,body);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'PLUGIN_DELETED');
  }
  const get=(path,key)=>fetch(base+path,{headers:{authorization:'Bearer '+key}});
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.review)).status,200);
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.beta)).status,404);
  registry.catalog.readArtifact=async()=>({mime:'text/plain',filename:'synthetic.txt',data:Buffer.from('synthetic artifact')});
  const artifact='/v2/tasks/'+task.task_id+'/artifacts/'+randomUUID();
  assert.equal((await get(artifact,keys.review)).status,200);assert.equal((await get(artifact,keys.beta)).status,404);
  const run=store.claim(task.task_id);await store.complete(run.run_id,{approved:true,reasons:[]});
  assert.equal((await (await get('/v2/tasks/'+task.task_id,keys.review)).json()).status,'completed');
});

test('production keys isolate submission, task queries and artifacts; retired global keys cannot bypass',async t=>{
  const {store,registry,base,post}=await setup(t);
  assert.equal((await post('/hooks/review-own',{request_id:'old',input:{content:'synthetic'}},'retired-global-key')).status,401);
  assert.equal((await post('/hooks/review-own',{request_id:'cross',input:{content:'synthetic'}},keys.beta)).status,403);
  assert.equal((await post('/v2/tasks',{type:'isolation.beta',request_id:'cross-type',input:{}})).status,403);
  const accepted=await post('/hooks/review-own',{request_id:'one',input:{content:'synthetic'}});assert.equal(accepted.status,202);
  const task=await accepted.json(),get=(path,key)=>fetch(base+path,{headers:{authorization:`Bearer ${key}`}});
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.review)).status,200);
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.beta)).status,404);
  let reads=0;registry.catalog.readArtifact=async()=>{reads++;return {mime:'text/plain',filename:'synthetic.txt',data:Buffer.from('synthetic artifact')};};
  const artifact='/v2/tasks/'+task.task_id+'/artifacts/'+randomUUID();
  assert.equal((await get(artifact,keys.beta)).status,404);assert.equal(reads,0);
  assert.equal((await get(artifact,keys.review)).status,200);assert.equal(reads,1);
  store.pluginConnections.update('content.review',{entryAddress:'/hooks/review-renamed',entryKey:keys.rotated});
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.review)).status,401);
  assert.equal((await get('/v2/tasks/'+task.task_id,keys.rotated)).status,200);
  assert.equal((await post('/hooks/review-own',{request_id:'removed',input:{content:'x'}},keys.rotated)).status,404);
  assert.equal((await post('/hooks/review-renamed',{request_id:'new',input:{content:'x'}},keys.rotated)).status,202);
});

test('manual connection transport requires internal auth and Admin cookies and is absent from Agent operations',async t=>{
  const state=await setup(t),{store,operations,listen}=state;
  const privateBase=await listen(createPrivateApi({...state}));
  const endpoint='/internal/plugin-connections/'+encodeURIComponent('content.review');
  assert.equal((await fetch(privateBase+endpoint)).status,401);
  const client=new OperationsClient({url:privateBase,token:state.config.runnerToken});
  const managerStore=new ManagerStore(':memory:');t.after(()=>managerStore.close());
  const managerOperations=createManagerOperations({client,store:managerStore,configuration:{scopes:new Map(),list:()=>[]},metrics:{sample:async()=>({})},models:async()=>({models:[]})});
  const managerBase=await listen(createManagerServer({store:managerStore,agent:{},operations:managerOperations,metrics:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human-session'}}));
  const browserPath='/admin/api/plugins/content.review/connection';
  assert.equal((await fetch(managerBase+browserPath,{headers:{authorization:'Bearer '+keys.review}})).status,401);
  const write=await fetch(managerBase+browserPath,{method:'POST',headers:{cookie:'synthetic-human-session','content-type':'application/json'},body:JSON.stringify({callbackUrl:'https://example.invalid/review-callback',callbackToken:'synthetic-callback-secret'})});
  assert.equal(write.status,200);const result=await write.json();assert.equal(result.callbackTokenConfigured,true);assert.ok(!JSON.stringify(result).includes('synthetic-callback-secret'));
  const visible=await operations.execute('plugin_get',{type:'content.review'});assert.equal(visible.connection.ready,true);
  assert.ok(!JSON.stringify(visible).includes('https://example.invalid/review-callback'));assert.ok(!JSON.stringify(visible).includes(keys.review));
  for(const action of ['plugin_connection_update','plugin_connection_get'])await assert.rejects(managerOperations.execute(action,{type:'content.review'}));
  assert.deepEqual(managementTools.filter(tool=>/connection/.test(tool.name)).map(tool=>tool.name),['plugin_connection_initialize']);
  for(const scope of ['access','http'])await assert.rejects(operations.execute('configuration_get',{scope}));
  await assert.rejects(operations.execute('plugin_save',{definition:{type:'isolation.inject',connection:{entryKey:'agent-secret'}}}));
  assert.equal(store.pluginConnections.get('content.review').entryKeyConfigured,true);
});

test('Agent-created plugins require human setup before enable, trial or scheduled execution',async t=>{
  const {operations,store}=await setup(t);
  const saved=await operations.execute('plugin_save',{definition:{type:'pending.human',name:'Pending',instructions:'Return the supplied object.',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'},enabled:true}});
  assert.equal(saved.enabled,false);assert.equal(saved.connection.ready,false);
  assert.match(saved.user_action_required,/配置接入/);assert.match(saved.user_action_required,/回调/);
  await assert.rejects(operations.execute('plugin_enable',{type:saved.type,enabled:true}),{code:'PLUGIN_CONNECTION_NOT_READY'});
  await assert.rejects(operations.execute('submit_task',{type:saved.type,input:{}}),{code:'PLUGIN_CONNECTION_NOT_READY'});
  const plan=await operations.execute('schedule_save',{schedule:{name:'Synthetic pending task',kind:'task',type:saved.type,input:{},cron:'* * * * *',timezone:'UTC'}});
  await operations.schedules.tick(plan.next_run_at);
  assert.equal(operations.schedules.get(plan.id).blocked_reason,'PLUGIN_CONNECTION_NOT_READY');
  assert.equal(store.listTasks({type:saved.type}).length,0);
  store.pluginConnections.update(saved.type,{entryKey:'synthetic-new-human-entry-key-123456'});
  assert.equal(store.plugins.get(saved.type).enabled,false);
  await operations.execute('plugin_enable',{type:saved.type,enabled:true});
  await operations.schedules.tick(plan.next_run_at);
  assert.equal(operations.schedules.get(plan.id).blocked_reason,null);
  assert.equal(store.listTasks({type:saved.type}).length,1);
});

test('Agent capability discovery describes the human connection policy without advertising editable callbacks',async t=>{
  const {operations}=await setup(t),capabilities=await operations.execute('capabilities');
  assert.deepEqual(capabilities.delivery_modes,['none']);
  assert.deepEqual(capabilities.connection_policy,{agent_writable:false,agent_initialize_operation:'plugin_connection_initialize',entry_address_generated:true,entry_key_human_claim_required:true,entry_key_rotation:'human_only',required_for_activation:['entryAddress','entryKey'],human_owned_fields:['entryAddress','entryKey','callbackUrl','callbackToken'],callback_optional:true});
});
