import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {createPrivateApi,createTaskApi} from '../src/api.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {OperationsClient} from '../src/manager/client.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {managementTools} from '../src/contracts/management.mjs';
import {buildPluginIntegration} from '../src/manager/plugin-integration.mjs';

const type='content.review',other='novel.illustrated';
const manualKey='synthetic-human-replacement-key-123456789';
function setup(t,path=':memory:') {
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-private-runner'});
  const store=new RequestStore(path,{registry:app.registry});t.after(()=>store.close());
  const dispatcher={drain:async()=>{},blocked:new Map()},runner={ready:async()=>({ready:true})};
  const operations=new OperationsService({...app,store,configuration:app.configuration(store),dispatcher,runner});
  return {...app,store,operations,dispatcher,runner,connections:store.pluginConnections};
}
async function listen(t,server) {await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}

test('Agent initialization creates a private pending key, remains gated and never returns a secret',async t=>{
  const {connections,operations,store}=setup(t);
  const result=await operations.execute('plugin_connection_initialize',{type});
  assert.equal(result.entryAddress,'/hooks/content/review');assert.equal(result.entryKeyClaimable,true);
  assert.equal(result.ready,false);assert.deepEqual(result.missingFields,['entryKeyClaim']);
  assert.throws(()=>store.plugins.setEnabled(type,true),{code:'PLUGIN_CONNECTION_NOT_READY'});
  await assert.rejects(operations.execute('submit_task',{type,input:{content:'synthetic'}}),{code:'PLUGIN_CONNECTION_NOT_READY'});
  const metadata=connections.get(type);
  assert.deepEqual(connections.initialize(type),result);
  assert.equal(connections.get(type).revision,metadata.revision);
  const {entryKey,connection}=connections.claimEntryKey(type,{revision:metadata.revision});
  assert.match(entryKey,/^[a-f0-9]{64}$/);assert.equal(connection.ready,true);assert.equal(connection.entryKeyClaimable,false);
  assert.equal(connections.authenticate(entryKey),type);
  for(const visible of [result,metadata,await operations.execute('plugin_get',{type}),await operations.execute('plugins'),await operations.execute('capabilities'),buildPluginIntegration(store.plugins.get(type),metadata)])assert.ok(!JSON.stringify(visible).includes(entryKey));
  const second=connections.initialize(other);const secondClaim=connections.claimEntryKey(other,{revision:connections.get(other).revision});
  assert.notEqual(secondClaim.entryKey,entryKey);assert.equal(connections.authenticate(secondClaim.entryKey),other);
  assert.equal(second.entryKeyClaimable,true);
});

test('generated pending credentials cannot authenticate until claimed and claims are once only',t=>{
  const {connections,store}=setup(t);connections.initialize(type);
  const pending=store.db.prepare('SELECT entry_key_pending FROM platform_plugin_connections WHERE type=?').get(type).entry_key_pending;
  assert.equal(connections.authenticate(pending),null);
  const revision=connections.get(type).revision;
  for(const value of [undefined,{},null,{revision:revision-1},{revision:'2'},{revision,extra:true}])assert.throws(()=>connections.claimEntryKey(type,value));
  const claimed=connections.claimEntryKey(type,{revision});assert.equal(claimed.entryKey,pending);
  assert.equal(claimed.connection.revision,revision+1);
  assert.equal(store.db.prepare('SELECT entry_key_pending FROM platform_plugin_connections WHERE type=?').get(type).entry_key_pending,null);
  assert.throws(()=>connections.claimEntryKey(type,{revision}),{code:'PLUGIN_CONNECTION_REVISION_CONFLICT'});
  assert.throws(()=>connections.claimEntryKey(type,{revision:revision+1}),{code:'PLUGIN_ENTRY_KEY_NOT_CLAIMABLE'});
  assert.equal(connections.initialize(type).entryKeyClaimable,false);
  assert.equal(connections.get(type).revision,revision+1);
});

test('initialization preserves human credentials and callbacks; replacement invalidates pending claims',t=>{
  const {connections}=setup(t);
  connections.update(type,{entryAddress:'https://synthetic.invalid/hooks/human',entryKey:manualKey,callbackUrl:'https://synthetic.invalid/callback',callbackToken:'synthetic-callback'});
  const before=connections.get(type);connections.initialize(type);assert.deepEqual(connections.get(type),before);
  assert.equal(connections.authenticate(manualKey),type);
  connections.update(type,{entryKey:null});const initialized=connections.initialize(type),revision=connections.get(type).revision;
  assert.equal(initialized.entryAddress,before.entryAddress);assert.deepEqual(connections.callbackFor(type),{url:before.callbackUrl,token:'synthetic-callback'});
  connections.update(type,{entryKey:manualKey,revision});
  assert.throws(()=>connections.claimEntryKey(type,{revision}),{code:'PLUGIN_CONNECTION_REVISION_CONFLICT'});
  assert.throws(()=>connections.claimEntryKey(type,{revision:connections.get(type).revision}),{code:'PLUGIN_ENTRY_KEY_NOT_CLAIMABLE'});
  assert.equal(connections.authenticate(manualKey),type);
  connections.update(type,{entryAddress:null});const missing=connections.initialize(type);assert.equal(missing.entryAddress,'/hooks/content/review');assert.equal(connections.authenticate(manualKey),type);
});

test('pending keys persist privately across restart and concurrent store claims cannot disclose twice',t=>{
  const root=mkdtempSync(join(tmpdir(),'entry-key-'));
  const path=join(root,'tasks.sqlite'),first=setup(t,path);first.connections.initialize(type);
  const before=first.connections.get(type),second=setup(t,path);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(second.connections.get(type),before);second.connections.initialize(type);
  assert.equal(first.connections.get(type).revision,before.revision);
  const claimed=second.connections.claimEntryKey(type,{revision:before.revision});
  assert.throws(()=>first.connections.claimEntryKey(type,{revision:before.revision}),{code:'PLUGIN_CONNECTION_REVISION_CONFLICT'});
  first.connections.initialize(type);assert.equal(first.connections.authenticate(claimed.entryKey),type);
  assert.ok(!JSON.stringify(first.store.plugins.list()).includes(claimed.entryKey));
});

test('legacy connection storage migrates without changing existing human keys',t=>{
  const root=mkdtempSync(join(tmpdir(),'entry-key-migration-')),path=join(root,'tasks.sqlite');
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-private-runner'}),legacy=new RequestStore(path,{registry:app.registry});
  legacy.pluginConnections.update(type,{entryKey:manualKey,callbackUrl:'https://synthetic.invalid/result',callbackToken:'synthetic-token'});
  const before=legacy.pluginConnections.get(type);
  legacy.db.exec('ALTER TABLE platform_plugin_connections DROP COLUMN entry_key_pending');legacy.close();
  const migrated=setup(t,path);t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(migrated.connections.get(type),before);assert.equal(migrated.connections.authenticate(manualKey),type);
  migrated.connections.initialize(type);assert.deepEqual(migrated.connections.get(type),before);
  migrated.connections.initialize(other);const claimed=migrated.connections.claimEntryKey(other,{revision:migrated.connections.get(other).revision});
  assert.equal(migrated.connections.authenticate(claimed.entryKey),other);
});

test('pending claims block queued/recovered launches and replacing a claimed key revokes it',t=>{
  const {connections,store}=setup(t);connections.update(type,{entryKey:manualKey});store.plugins.setEnabled(type,true);
  const body={type,request_id:'synthetic',input:{content:'synthetic'}},queued=store.accept('test',body),active=store.accept('test',body),run=store.claim(active.task_id);store.suspend(run.run_id);
  connections.update(type,{entryKey:null});connections.initialize(type);
  for(const task of [queued,active])assert.throws(()=>store.claim(task.task_id),{code:'PLUGIN_CONNECTION_NOT_READY'});
  const claimed=connections.claimEntryKey(type,{revision:connections.get(type).revision});assert.equal(store.claim(active.task_id).resume,true);
  const taskSnapshot=store.raw(queued.task_id).definition;assert.ok(!taskSnapshot.includes(claimed.entryKey));
  connections.update(type,{entryKey:manualKey,revision:claimed.connection.revision});assert.equal(connections.authenticate(claimed.entryKey),null);assert.equal(connections.authenticate(manualKey),type);
  const revision=connections.get(type).revision;connections.initialize(type);assert.equal(connections.get(type).revision,revision);
});

test('claim is a cookie-authenticated same-origin browser transport, never an Agent operation',async t=>{
  const state=setup(t),{connections,operations,store}=state;
  await operations.execute('plugin_connection_initialize',{type});
  const privateBase=await listen(t,createPrivateApi(state)),client=new OperationsClient({url:privateBase,token:state.config.runnerToken});
  const managerStore=new ManagerStore(':memory:');t.after(()=>managerStore.close());
  const managerOperations=createManagerOperations({client,store:managerStore,configuration:{scopes:new Map(),list:()=>[]},metrics:{sample:async()=>({})}});
  const base=await listen(t,createManagerServer({store:managerStore,operations:managerOperations,agent:{},metrics:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human-session'}}));
  const path='/admin/api/plugins/content.review/connection/entry-key/claim';
  const post=(baseUrl,route,body,headers={})=>fetch(baseUrl+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const revision=connections.get(type).revision;
  assert.equal((await post(base,path,{revision})).status,401);
  assert.equal((await post(base,path,{revision},{cookie:'synthetic-human-session',origin:'https://foreign.invalid'})).status,403);
  assert.equal((await post(privateBase,'/internal/plugin-connections/content.review/entry-key/claim',{revision})).status,401);
  const internalHeaders={authorization:`Bearer ${state.config.runnerToken}`};
  assert.equal((await post(privateBase,'/internal/plugin-connections/content.review',{revision,claim:true},internalHeaders)).status,400);
  assert.equal((await post(base,path,{}, {cookie:'synthetic-human-session',origin:base})).status,409);
  for(const action of ['plugin_connection_claim','plugin_entry_key_claim']){
    assert.ok(!managementTools.some(tool=>tool.name===action));
    await assert.rejects(managerOperations.execute(action,{type,revision}));
    await assert.rejects(operations.execute(action,{type,revision}));
    assert.equal((await post(base,'/admin/api/operations',{action,args:{type,revision}},{cookie:'synthetic-human-session',origin:base})).status,400);
  }
  await assert.rejects(operations.execute('plugin_connection_initialize',{type,entryKey:manualKey}));
  const responses=await Promise.all([post(base,path,{revision},{cookie:'synthetic-human-session',origin:base}),post(base,path,{revision},{cookie:'synthetic-human-session',origin:base})]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const response=responses.find(response=>response.status===200);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const claimed=await response.json();assert.equal(claimed.connection.entryKeyClaimable,false);assert.equal(connections.authenticate(claimed.entryKey),type);
  assert.equal(managerStore.db.prepare('SELECT COUNT(*) AS count FROM manager_actions').get().count,0);
  assert.equal((await post(base,path,{revision},{cookie:'synthetic-human-session',origin:base})).status,409);
  const metadata=await (await fetch(base+'/admin/api/plugins/content.review/connection',{headers:{cookie:'synthetic-human-session'}})).json();assert.ok(!JSON.stringify(metadata).includes(claimed.entryKey));
  const taskBase=await listen(t,createTaskApi(state));store.plugins.setEnabled(type,true);
  const accepted=await post(taskBase,'/v2/tasks',{type,request_id:'synthetic',input:{content:'synthetic'}},{authorization:`Bearer ${claimed.entryKey}`});assert.equal(accepted.status,202);
  const cross=await post(taskBase,'/v2/tasks',{type:other,request_id:'synthetic',input:{}},{authorization:`Bearer ${claimed.entryKey}`});assert.equal(cross.status,403);
});
