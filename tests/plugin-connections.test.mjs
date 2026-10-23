import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { deliveryCatalog } from '../src/delivery/configured.mjs';
import { createDeliveryWorker } from '../src/delivery/worker.mjs';

const keyA='synthetic-plugin-alpha-key-123456';
const keyB='synthetic-plugin-bravo-key-123456';
const definition=(type='story.generate')=>({type,name:type,instructions:'Return the supplied text.',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'},enabled:true});
function setup(t,{path=':memory:',catalog={}}={}) {
  const registry=new BusinessRegistry([],{...deliveryCatalog(),requirePluginConnections:true,...catalog});
  const store=new RequestStore(path,{registry});t.after(()=>store.close());
  store.plugins.save(definition());
  return {store,registry,connections:store.pluginConnections};
}
const body={type:'story.generate',request_id:'synthetic',input:{text:'hello'}};
const tempRoot=()=>{const root=process.platform==='win32'?'.tmp/plugin-connections':tmpdir();mkdirSync(root,{recursive:true});return root;};

test('unconfigured plugins cannot be enabled or admitted through any direct store caller',t=>{
  const {store,connections}=setup(t);
  assert.equal(store.plugins.get(body.type).enabled,false);
  assert.deepEqual(connections.status(body.type),{ready:false,entryPath:'/hooks/story/generate',callbackConfigured:false,missingFields:['entryKey']});
  assert.throws(()=>store.plugins.setEnabled(body.type,true),{code:'PLUGIN_CONNECTION_NOT_READY'});
  assert.throws(()=>store.accept('trial',body),{code:'PLUGIN_CONNECTION_NOT_READY'});
  assert.equal(store.plugins.save(definition()).enabled,false);
  assert.deepEqual(store.registry.get(body.type).availability({ready:true}),{ready:false,reason:'PLUGIN_CONNECTION_NOT_READY'});
  connections.update(body.type,{entryKey:keyA});
  store.plugins.setEnabled(body.type,true);
  assert.equal(store.accept('schedule',body).status,'queued');
});

test('connection creation failure cannot leave a partially saved plugin',t=>{
  const {store}=setup(t);
  assert.throws(()=>store.plugins.save({...definition('other.plugin'),routes:['/hooks/story/generate']}),{code:'PLUGIN_CONNECTION_CONFLICT'});
  assert.throws(()=>store.plugins.get('other.plugin'),{code:'PLUGIN_NOT_FOUND'});
  assert.equal(store.registry.modules.has('other.plugin'),false);
});

test('human routing changes release the former address regardless of stale Agent route suggestions',t=>{
  const {store,connections}=setup(t);
  store.plugins.save({...definition(),routes:['/hooks/original']});
  connections.update(body.type,{entryAddress:'/hooks/human-moved',entryKey:keyA});
  store.plugins.save({...definition('other.plugin'),routes:['/hooks/original']});
  assert.equal(connections.forPath('/hooks/original'),'other.plugin');
  assert.equal(connections.forPath('/hooks/human-moved'),body.type);
});

test('legacy callback JSON loads without its retired target and remains human-configuration gated',t=>{
  const root=mkdtempSync(join(tempRoot(),'migration-')),path=join(root,'tasks.sqlite');
  const legacy=new RequestStore(path,{registry:new BusinessRegistry([],{targets:{retired:{}},...deliveryCatalog()})});
  legacy.plugins.save({...definition(),delivery:{mode:'callback_once',target:'retired'}});legacy.close();
  const migrated=new RequestStore(path,{registry:new BusinessRegistry([],{...deliveryCatalog(),requirePluginConnections:true})});
  t.after(()=>{migrated.close();rmSync(root,{recursive:true,force:true});});
  assert.deepEqual(migrated.plugins.invalid,[]);assert.equal(migrated.plugins.get(body.type).enabled,false);
  assert.throws(()=>migrated.accept('test',body),{code:'PLUGIN_CONNECTION_NOT_READY'});
  migrated.pluginConnections.update(body.type,{entryKey:keyA});
  assert.equal(migrated.plugins.get(body.type).enabled,false);
  migrated.plugins.setEnabled(body.type,true);assert.equal(migrated.accept('test',body).status,'queued');
});

test('entry keys authenticate only their plugin and persist separately from business definitions',t=>{
  const root=mkdtempSync(join(tempRoot(),'persist-'));
  const path=join(root,'tasks.sqlite');const {store,connections}=setup(t,{path});
  store.plugins.save(definition('other.plugin'));
  connections.update(body.type,{entryAddress:'https://service.example/hooks/custom',entryKey:keyA,callbackUrl:'https://receiver.example/result',callbackToken:'receiver-token'});
  connections.update('other.plugin',{entryKey:keyB});
  assert.equal(connections.authenticate(keyA),body.type);assert.equal(connections.authenticate(keyB),'other.plugin');
  assert.equal(connections.authenticate('unknown'),null);assert.equal(connections.forPath('/hooks/custom'),body.type);
  store.plugins.save({...definition(),routes:['/hooks/agent-change']});
  assert.equal(connections.get(body.type).entryPath,'/hooks/custom');
  store.plugins.setEnabled(body.type,true);const task=store.accept('test',body),run=store.claim(task.task_id);
  for(const exported of [connections.get(body.type),connections.status(body.type),store.plugins.list(),run,JSON.parse(store.raw(task.task_id).definition)])
    for(const secret of [keyA,keyB,'receiver-token'])assert.equal(JSON.stringify(exported).includes(secret),false);
  const reopened=new RequestStore(path,{registry:new BusinessRegistry([],{...deliveryCatalog(),requirePluginConnections:true})});t.after(()=>reopened.close());
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(reopened.pluginConnections.authenticate(keyA),body.type);
  assert.deepEqual(reopened.pluginConnections.callbackFor(body.type),{url:'https://receiver.example/result',token:'receiver-token'});
  assert.throws(()=>connections.get('missing.plugin'),{code:'PLUGIN_NOT_FOUND'});
});

test('human addresses and keys enforce uniqueness, safe URLs, secret preservation and revisions',t=>{
  const {store,connections}=setup(t,{catalog:{reservedRoutes:['/hooks/reserved'],connectionForbiddenTokens:['reserved-platform-key-123456789']}});
  store.plugins.save(definition('other.plugin'));
  const saved=connections.update(body.type,{entryKey:keyA,callbackUrl:'http://localhost:5012/callback',callbackToken:'short'});
  connections.update(body.type,{callbackUrl:'http://localhost:5012/changed',revision:saved.revision});
  assert.equal(connections.authenticate(keyA),body.type);assert.equal(connections.callbackFor(body.type).token,'short');
  assert.throws(()=>connections.update(body.type,{entryAddress:'/hooks/stale',revision:saved.revision}),{code:'PLUGIN_CONNECTION_REVISION_CONFLICT'});
  assert.throws(()=>connections.update('other.plugin',{entryKey:keyA}),{code:'PLUGIN_CONNECTION_CONFLICT'});
  assert.throws(()=>connections.update('other.plugin',{entryAddress:'/hooks/story/generate'}),{code:'PLUGIN_CONNECTION_CONFLICT'});
  for(const entryAddress of ['/v2/tasks','/hooks/reserved','/hooks/a/../b','/hooks/a?x=1','/hooks/a#x','https://user:secret@example.com/hooks/a','https://example.com/hooks/%61','https://example.com/hooks/a?x=1','ftp://example.com/hooks/a'])
    assert.throws(()=>connections.update(body.type,{entryAddress}),{code:'INVALID_PLUGIN_CONNECTION'},entryAddress);
  for(const entryKey of ['short','spaces are forbidden key of sufficient length','x'.repeat(1025),'reserved-platform-key-123456789'])
    assert.throws(()=>connections.update(body.type,{entryKey}),{code:'INVALID_PLUGIN_CONNECTION'});
  assert.throws(()=>connections.update(body.type,{callbackToken:'bad\r\nheader'}),{code:'INVALID_PLUGIN_CONNECTION'});
  assert.throws(()=>connections.update(body.type,{callbackUrl:'https://user:secret@example.com/a'}),{code:'INVALID_PLUGIN_CONNECTION'});
  connections.update(body.type,{callbackUrl:''});assert.equal(connections.callbackFor(body.type),null);
  assert.equal(connections.get(body.type).callbackTokenConfigured,false);
  connections.update(body.type,{entryKey:null});assert.equal(connections.status(body.type).ready,false);
});

test('removing connection readiness blocks queued work and suspended continuation claims',t=>{
  const {store,registry,connections}=setup(t);connections.update(body.type,{entryKey:keyA});store.plugins.setEnabled(body.type,true);
  const queued=store.accept('test',body),active=store.accept('test',body),run=store.claim(active.task_id);store.suspend(run.run_id);
  connections.update(body.type,{entryKey:null});
  assert.deepEqual(registry.forTask(store.raw(queued.task_id)).availability({ready:true}),{ready:false,reason:'PLUGIN_CONNECTION_NOT_READY'});
  for(const task of [queued,active])assert.throws(()=>store.claim(task.task_id),{code:'PLUGIN_CONNECTION_NOT_READY'});
  connections.update(body.type,{entryKey:keyA});assert.equal(store.claim(active.task_id).resume,true);
});

test('human callbacks apply independently from Agent delivery JSON and reserve each send once',async t=>{
  let calls=0,authorization,payload;
  const server=createServer(async(req,res)=>{calls++;authorization=req.headers.authorization;const chunks=[];for await(const chunk of req)chunks.push(chunk);payload=JSON.parse(Buffer.concat(chunks));res.writeHead(202);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {store,connections}=setup(t);connections.update(body.type,{entryKey:keyA});store.plugins.setEnabled(body.type,true);
  const first=store.accept('test',body),firstRun=store.claim(first.task_id);await store.complete(firstRun.run_id,{text:'no callback'});
  assert.equal(store.get(first.task_id).delivery.status,'not_required');
  connections.update(body.type,{callbackUrl:`http://127.0.0.1:${server.address().port}/result`,callbackToken:'external-short-token'});
  store.plugins.save({...definition(),delivery:{mode:'callback_once',target:'agent-selected-unused-target'}});
  const second=store.accept('test',body),secondRun=store.claim(second.task_id);await store.complete(secondRun.run_id,{text:'callback'});
  assert.equal(store.get(second.task_id).delivery.status,'pending');
  const deliver=createDeliveryWorker({store,config:{}});await deliver();await deliver();
  assert.equal(calls,1);assert.equal(authorization,'Bearer external-short-token');assert.equal(payload.result.text,'callback');
  assert.equal(store.get(second.task_id).delivery.status,'accepted');
  const third=store.accept('test',body),thirdRun=store.claim(third.task_id);await store.complete(thirdRun.run_id,{text:'cleared before send'});
  connections.update(body.type,{callbackUrl:''});await deliver();
  assert.equal(calls,1);assert.equal(store.get(third.task_id).delivery.status,'not_required');
});
