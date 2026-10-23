import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {ConfigurationStore} from '../src/configuration/store.mjs';
import {httpConfiguration} from '../src/capabilities/config.mjs';

function setup(t,env={}) {
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-http-internal',...env});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  const configuration=app.configuration(store),operations=new OperationsService({...app,store,configuration,dispatcher:{drain:async()=>{}},runner:{}});
  return {...app,store,configuration,operations};
}
test('production management discovers a distinct writable HTTP target scope without reviving retired settings',async t=>{
  const {operations,store}=setup(t);
  const group=(await operations.execute('configuration_list')).groups.find(item=>item.scope==='http_targets');assert.ok(group);
  assert.equal(group.title,'HTTP 目标');assert.deepEqual(group.values.targets,{});
  assert.throws(()=>operations.configuration.get('http'),{code:'CONFIGURATION_NOT_FOUND'});
  await assert.rejects(operations.execute('configuration_update',{scope:'http_targets',patch:{targets:{health:{url:'https://example.invalid'}}}}),{code:'CONFIGURATION_REVISION_CONFLICT'});
  const saved=await operations.execute('configuration_update',{scope:'http_targets',revision:group.revision,patch:{targets:{health:{url:'https://example.invalid',token:'synthetic-http-private'}}}});
  assert.equal(saved.revision,group.revision+1);assert.ok(saved.configured_secrets.includes('/targets/health/token'));
  assert.equal(JSON.stringify(saved).includes('synthetic-http-private'),false);
  assert.ok((await operations.execute('capabilities')).targets.includes('health'));
  await assert.rejects(operations.execute('configuration_update',{scope:'http_targets',revision:group.revision,patch:{targets:{}}}),{code:'CONFIGURATION_REVISION_CONFLICT'});
  assert.ok(Object.hasOwn(store.registry.catalog.targets,'health'));
});

test('saved targets apply to the next real local tool call with private credentials and removal takes effect immediately',async t=>{
  const requests=[],server=createServer((req,res)=>{requests.push({path:req.url,authorization:req.headers.authorization});req.resume();res.end('synthetic health');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,{operations,registry,configuration}=setup(t);
  const save=targets=>operations.execute('configuration_update',{scope:'http_targets',revision:configuration.get('http_targets').revision,patch:{targets}});
  await save({health:{url:base+'/first',token:'synthetic-bearer',timeoutMs:1000}});assert.deepEqual(requests,[]);
  assert.deepEqual(await registry.catalog.tools.http_request.execute({target:'health',method:'GET'}),{http_status:200,body:'synthetic health'});
  await save({health:{url:base+'/second',timeoutMs:1000}});
  await registry.catalog.tools.http_request.execute({target:'health',method:'GET'});
  await save({health:{url:base+'/second',token:''}});await registry.catalog.tools.http_request.execute({target:'health',method:'GET'});
  assert.deepEqual(requests,[{path:'/first',authorization:'Bearer synthetic-bearer'},{path:'/second',authorization:'Bearer synthetic-bearer'},{path:'/second',authorization:undefined}]);
  await save({});await assert.rejects(registry.catalog.tools.http_request.execute({target:'health',method:'GET'}),{code:'TARGET_UNAVAILABLE'});
  assert.deepEqual(configuration.get('http_targets').configured_secrets,[]);
});

test('live HTTP targets persist over bootstrap defaults while obsolete HTTP records stay unused',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT INTO platform_settings VALUES(?,?)').run('configuration:http',JSON.stringify({values:{targets:{retired:{url:'https://retired.invalid',token:'obsolete-secret'}}},revision:3,updated_at:1}));
  const targets={bootstrap:{url:'https://bootstrap.invalid'}},descriptor=()=>httpConfiguration(targets,{name:'http_targets'});
  let settings=new ConfigurationStore(db,[descriptor()]);assert.deepEqual(Object.keys(targets),['bootstrap']);
  settings.update('http_targets',{targets:{saved:{url:'https://saved.invalid',token:'saved-secret'}}},{revision:0});
  const replacement={changed_env:{url:'https://env.invalid'}};
  settings=new ConfigurationStore(db,[httpConfiguration(replacement,{name:'http_targets'})]);
  assert.deepEqual(Object.keys(replacement),['saved']);assert.equal(replacement.saved.token,'saved-secret');
  assert.equal(JSON.stringify(settings.get('http_targets')).includes('saved-secret'),false);
  assert.throws(()=>settings.update('http_targets',{targets:{}},{revision:0}),{code:'CONFIGURATION_REVISION_CONFLICT'});
});

test('production startup ignores invalid bootstrap HTTP JSON when live targets were already saved',t=>{
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-bootstrap',PLATFORM_HTTP_TARGETS_JSON:'not valid JSON'});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  store.db.exec('CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  store.db.prepare('INSERT INTO platform_settings VALUES(?,?)').run('configuration:http_targets',JSON.stringify({values:{targets:{saved:{url:'https://saved.invalid'}}},revision:4,updated_at:1}));
  const settings=app.configuration(store);
  assert.equal(settings.get('http_targets').revision,4);assert.deepEqual(Object.keys(app.registry.catalog.targets),['saved']);
  const fresh=createApplication('gateway',{RUNNER_TOKEN:'synthetic-bootstrap',PLATFORM_HTTP_TARGETS_JSON:'not valid JSON'});
  const empty=new RequestStore(':memory:',{registry:fresh.registry});t.after(()=>empty.close());
  assert.throws(()=>fresh.configuration(empty));
});

test('invalid target edits preserve the saved configuration and never include credential values in errors',async t=>{
  const {configuration,operations}=setup(t);
  for(const target of [{url:'javascript:invalid',token:'private-rejected'},{url:'https://example.invalid/#fragment'},{url:'https://user:private-rejected@example.invalid'},{url:'https://example.invalid',timeoutMs:0},{url:'https://example.invalid',unexpected:true,token:'private-rejected'}]) {
    await assert.rejects(operations.execute('configuration_update',{scope:'http_targets',revision:0,patch:{targets:{bad:target}}}),error=>error.code==='INVALID_CONFIGURATION'&&!error.message.includes('private-rejected'));
    assert.equal(configuration.get('http_targets').revision,0);assert.deepEqual(configuration.read('http_targets'),{targets:{}});
  }
});

test('management MCP can register an HTTP target with live revision checks and cannot read its existing token',async t=>{
  const [{ManagerStore},{createManagementMcpHandler},{Client},{StreamableHTTPClientTransport}]=await Promise.all([import('../src/manager/store.mjs'),import('../src/manager/mcp.mjs'),import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
  const {operations,configuration,registry}=setup(t),manager=new ManagerStore(':memory:');t.after(()=>manager.close());
  const conversation=manager.createConversation('Synthetic HTTP settings');
  configuration.update('http_targets',{targets:{retained:{url:'https://existing.invalid',token:'private-existing-http-token'}}},{revision:0});
  const server=createServer(createManagementMcpHandler({store:manager,operations,authorize:value=>value==='synthetic-mcp'?conversation.id:null}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=new Client({name:'synthetic-target-manager',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer synthetic-mcp'}}}));
  const result=await client.callTool({name:'configuration_get',arguments:{scope:'http_targets'}});
  assert.equal(JSON.stringify(result).includes('private-existing-http-token'),false);
  const group=result.structuredContent;
  const changed=await client.callTool({name:'configuration_update',arguments:{scope:'http_targets',revision:group.revision,patch:{targets:{...group.values.targets,health:{url:'https://example.invalid/health',timeoutMs:10000}}}}});
  assert.ok(!changed.isError,JSON.stringify(changed));assert.ok(Object.hasOwn(registry.catalog.targets,'health'));
  assert.equal(configuration.read('http_targets').targets.retained.token,'private-existing-http-token');
  const stale=await client.callTool({name:'configuration_update',arguments:{scope:'http_targets',revision:group.revision,patch:{targets:{}}}});
  assert.equal(stale.isError,true);assert.equal(JSON.stringify(manager.getConversation(conversation.id)).includes('private-existing-http-token'),false);
});
