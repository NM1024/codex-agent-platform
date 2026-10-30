import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configurePlugin} from './helpers/plugin-connections.mjs';

async function storage() {
  const loaded=await import('../src/configuration/store.mjs').catch(()=>({}));
  assert.equal(typeof loaded.ConfigurationStore,'function','persistent module configuration is available');return loaded.ConfigurationStore;
}
const schema={type:'object',additionalProperties:false,required:['model','targets'],properties:{model:{type:'string',minLength:1},targets:{type:'object',additionalProperties:{type:'object',additionalProperties:false,required:['url'],properties:{url:{type:'string'},token:{type:'string',writeOnly:true}}}}}};
const descriptor=(apply=()=>{})=>({name:'sample',title:'测试模块',schema,defaults:{model:'old',targets:{one:{url:'https://one.invalid',token:'private-one'}}},apply});
test('saved module configuration survives reopen and takes priority over bootstrap values',async t=>{
  const ConfigurationStore=await storage(),root=await mkdtemp(join(tmpdir(),'settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'db.sqlite');let db=new DatabaseSync(path),applied;
  let settings=new ConfigurationStore(db,[descriptor(value=>{applied=value;})]);
  settings.update('sample',{model:'saved'});assert.equal(applied.model,'saved');db.close();
  db=new DatabaseSync(path);t.after(()=>db.close());
  settings=new ConfigurationStore(db,[{...descriptor(value=>{applied=value;}),defaults:{model:'new-env',targets:{}}}]);
  assert.equal(applied.model,'saved');assert.equal(settings.read('sample').model,'saved');
});
test('nested secrets stay write-only, omitted secrets survive edits and explicit empty clears',async t=>{
  const ConfigurationStore=await storage(),db=new DatabaseSync(':memory:');t.after(()=>db.close());const settings=new ConfigurationStore(db,[descriptor()]);
  const visible=settings.get('sample');assert.ok(!JSON.stringify(visible).includes('private-one'));assert.ok(visible.configured_secrets.includes('/targets/one/token'));
  settings.update('sample',{targets:{one:{url:'https://changed.invalid'}}});assert.equal(settings.read('sample').targets.one.token,'private-one');
  settings.update('sample',{targets:{one:{url:'https://changed.invalid',token:''}}});assert.equal(settings.read('sample').targets.one.token,'');
  assert.deepEqual(settings.get('sample').configured_secrets,[]);
  assert.throws(()=>settings.update('sample',{model:''}),error=>error.code==='INVALID_CONFIGURATION');
  assert.equal(settings.read('sample').model,'old');
});
test('configuration validates a whole update before persisting or applying any part',async t=>{
  const ConfigurationStore=await storage(),db=new DatabaseSync(':memory:');t.after(()=>db.close());let applied;
  const settings=new ConfigurationStore(db,[descriptor(value=>{applied=value;})]);
  assert.throws(()=>settings.update('sample',{model:'changed',unknown:true}),error=>error.code==='INVALID_CONFIGURATION');
  assert.equal(applied.model,'old');assert.equal(settings.read('sample').model,'old');
  assert.throws(()=>settings.update('sample',{model:'changed',targets:{one:{url:1,token:'sensitive-rejected'}}}),error=>error.code==='INVALID_CONFIGURATION'&&!error.message.includes('sensitive-rejected'));
});
async function application(t,extra={}) {
  const root=await mkdtemp(join(tmpdir(),'settings-app-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const [{createApplication},{RequestStore}]=await Promise.all([import('../src/application.mjs'),import('../src/core/store.mjs')]);
  const app=createApplication('gateway',{INGRESS_TOKEN:'initial-ingress',RUNNER_TOKEN:'internal-secret',WORKSPACE_DIR:root,...extra});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  for(const plugin of store.plugins.list())configurePlugin(store,plugin.type);
  assert.equal(typeof app.configuration,'function','application installs module-owned live configuration');return {...app,store};
}
test('execution config imports legacy runtime settings and applies queue and admission changes',async t=>{
  const app=await application(t);app.store.db.exec(`CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO platform_settings VALUES('runtime','{"paused":true,"concurrency":4}')`);
  const settings=app.configuration(app.store);assert.equal(app.config.paused,true);assert.equal(app.config.concurrency,4);
  settings.update('execution',{model:'gpt-6.1-sol',queueLimit:1,taskTimeoutMs:10000,toolTimeoutMs:2000});
  app.store.accept('default',{type:'content.review',request_id:'one',input:{content:'one'}});
  assert.throws(()=>app.store.accept('default',{type:'content.review',request_id:'two',input:{content:'two'}}),error=>error.code==='QUEUE_FULL');
  app.store.pluginConnections.update('content.review',{entryKey:'new-human-plugin-entry-key-123456'});
  assert.equal(app.store.pluginConnections.authenticate('new-human-plugin-entry-key-123456'),'content.review');
  assert.throws(()=>settings.update('access',{ingressToken:'forbidden-global-key'}));
  assert.ok(!JSON.stringify(settings.list()).includes('new-human-plugin-entry-key-123456'));
});

test('a saved HTTP target edit is used by an already accepted but unsent callback',async t=>{
  const {createServer}=await import('node:http');const requests=[];
  const server=createServer((req,res)=>{requests.push({url:req.url,authorization:req.headers.authorization});req.resume();res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const app=await application(t),settings=app.configuration(app.store),base=`http://127.0.0.1:${server.address().port}`;
  app.store.plugins.save({type:'test.deliver',name:'交付',instructions:'完成',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'callback_once',target:'test'}});
  configurePlugin(app.store,'test.deliver',{callbackUrl:base+'/old',callbackToken:'old-target'});
  const task=app.store.accept('default',{type:'test.deliver',request_id:'once',input:{}});await app.store.complete(app.store.claim(task.task_id).run_id,{});
  app.store.pluginConnections.update('test.deliver',{callbackUrl:base+'/new',callbackToken:'new-target'});
  const {createDeliveryWorker}=await import('../src/delivery/worker.mjs');await createDeliveryWorker({store:app.store,config:app.config})(task.task_id);
  assert.deepEqual(requests,[{url:'/new',authorization:'Bearer new-target'}]);
});
test('management saves live execution settings while a disconnected Runner reports pending synchronization',async t=>{
  const app=await application(t),configuration=app.configuration(app.store);
  const {OperationsService}=await import('../src/operations/service.mjs');
  const runner={ready:async()=>({ready:true}),configure:async()=>{throw new Error('offline');}};
  const service=new OperationsService({...app,configuration,runner,dispatcher:{drain:async()=>{}}});
  const changed=await service.execute('configuration_update',{scope:'execution',patch:{concurrency:3,model:'next-model',taskTimeoutMs:9000,toolTimeoutMs:3000}});
  assert.equal(changed.values.model,'next-model');assert.equal(changed.synchronization.runner,'pending');
  assert.equal(app.config.model,'next-model');assert.equal(configuration.read('execution').concurrency,3);
  assert.ok(!(await service.execute('configuration_list')).groups.some(item=>['http','access'].includes(item.scope)));
});
test('new dispatches carry the current execution configuration without resubmitting old tasks',async t=>{
  const app=await application(t),settings=app.configuration(app.store),{Dispatcher}=await import('../src/core/dispatcher.mjs');
  const launched=[],runner={ready:async()=>({ready:true}),launch:async run=>{launched.push(run);return {status:'running'};}};
  const dispatcher=new Dispatcher({...app,runner});t.after(()=>dispatcher.stop());
  settings.update('execution',{model:'configured-model',taskTimeoutMs:8000,toolTimeoutMs:1234});
  app.store.accept('default',{type:'content.review',request_id:'hot',input:{content:'text'}});await dispatcher.drain();
  assert.equal(launched.length,1);assert.deepEqual(launched[0].execution,{model:'configured-model',serviceTier:'default',taskTimeoutMs:8000,toolTimeoutMs:1234});
  settings.update('execution',{model:'future-model'});assert.equal(launched[0].execution.model,'configured-model');
});
test('a Runner uses the launch execution snapshot for its model and MCP timeout',async t=>{
  const {AgentRuntime}=await import('../src/runtime/codex.mjs'),{randomUUID}=await import('node:crypto');
  const root=await mkdtemp(join(tmpdir(),'live-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];
  const runtime=new AgentRuntime({workspace:root,codexHome:join(root,'codex'),model:'bootstrap-model',createClient:()=>({notify(){},subscribe:()=>()=>{},close:async()=>{},request:async(method,params)=>{calls.push({method,params});if(method==='thread/start')return {thread:{id:'live-thread'}};if(method==='turn/start')return {turn:{id:'live-turn'}};return {};}})});t.after(()=>runtime.stop());
  await runtime.launch({run_id:randomUUID(),task_id:randomUUID(),type:'text.test',input:{},token:'task-token',package:{prompt:'one task',native:{},tools:['complete_task']},execution:{model:'live-model',taskTimeoutMs:10000,toolTimeoutMs:3100}});
  const thread=calls.find(call=>call.method==='thread/start');assert.equal(thread.params.model,'live-model');assert.equal(thread.params.config.mcp_servers.agent_task.tool_timeout_sec,4);
});
test('rotating external credentials does not break the manager artifact channel',async t=>{
  const app=await application(t),settings=app.configuration(app.store);
  const [{createPrivateApi},{OperationsClient}]=await Promise.all([import('../src/api.mjs'),import('../src/manager/client.mjs')]);
  const task=app.store.accept('default',{type:'content.review',request_id:'artifact',input:{content:'text'}});
  app.registry.catalog.readArtifact=async()=>({data:Buffer.from('managed artifact'),mime:'text/plain',filename:'test.txt'});
  const server=createPrivateApi({...app,dispatcher:{completed:async()=>{}},runner:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const client=new OperationsClient({url:`http://127.0.0.1:${server.address().port}`,token:app.config.runnerToken,publicUrl:`http://127.0.0.1:${server.address().port}`,ingressToken:'initial-ingress'});
  app.store.pluginConnections.update('content.review',{entryKey:'rotated-human-entry-key-123456789'});
  const response=await client.artifact(task.task_id,'00000000-0000-4000-8000-000000000001');assert.equal(response.status,200);assert.equal(await response.text(),'managed artifact');
});
test('HTTP target names remain ordinary owned entries and removal revokes their use',async t=>{
  const app=await application(t),{ConfigurationStore}=await import('../src/configuration/store.mjs'),{httpConfiguration}=await import('../src/capabilities/config.mjs');
  // Exercise the generic capability descriptor privately; it is not installed in production management scopes.
  const settings=new ConfigurationStore(app.store.db,[httpConfiguration(app.registry.catalog.targets)]);
  settings.update('http',{targets:{['__proto__']:{url:'https://example.invalid/callback',token:'target-secret'}}});
  assert.ok(Object.hasOwn(app.registry.catalog.targets,'__proto__'),'a configured target is an owned entry');
  settings.update('http',{targets:{}});
  await assert.rejects(app.registry.catalog.tools.http_request.execute({target:'__proto__',method:'GET'}),error=>error.code==='TARGET_UNAVAILABLE');
});
