import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {DatabaseSync} from 'node:sqlite';
import {agentOverridesSchema,resolveAgentSettings} from '../src/configuration/agent-settings.mjs';
import {runtimeSettings,executionScope} from '../src/configuration/execution.mjs';
import {ConfigurationStore} from '../src/configuration/store.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {runtimeConfig} from '../src/codex/config.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';

const defaults={verbosity:'medium',reasoningSummary:'auto',autoCompactTokenLimit:null,toolOutputTokenLimit:null};
const manual={verbosity:'high',reasoningSummary:'detailed',autoCompactTokenLimit:12000,toolOutputTokenLimit:4000};
const options=value=>Object.fromEntries(Object.keys(defaults).map(key=>[key,value[key]]));

test('business defaults include automatic model budgets without changing standard speed',()=>{
  assert.deepEqual(options(runtimeSettings({})),defaults);
  assert.equal(runtimeSettings({}).serviceTier,'default');
  assert.deepEqual(options(runtimeSettings(manual)),manual);
});

test('overrides validate enums and inclusive token bounds and preserve explicit automatic budgets',()=>{
  const check=new Ajv({strict:true}).compile(agentOverridesSchema);
  for(const value of [{},defaults,manual,{autoCompactTokenLimit:1024,toolOutputTokenLimit:256},{autoCompactTokenLimit:2147483647,toolOutputTokenLimit:2147483647}])assert.equal(check(value),true,JSON.stringify(check.errors));
  for(const value of [{verbosity:null},{verbosity:'verbose'},{reasoningSummary:'hidden'},{autoCompactTokenLimit:1023},{autoCompactTokenLimit:2147483648},{autoCompactTokenLimit:1.5},{toolOutputTokenLimit:255},{toolOutputTokenLimit:'4000'},{config:{shell_tool:true}}])assert.equal(check(value),false,JSON.stringify(value));
  assert.deepEqual(options(resolveAgentSettings(manual,{})),manual);
  assert.deepEqual(options(resolveAgentSettings({...manual,model:'fixture-a',reasoningEffort:'high'},{model:'fixture-b',autoCompactTokenLimit:null})),{...manual,autoCompactTokenLimit:null});
  assert.equal(resolveAgentSettings(manual,{toolOutputTokenLimit:null}).toolOutputTokenLimit,null);
});

test('global settings persist all options and migrate old records without losing revision or existing values',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const store={db},agent={model:'fixture-model',timeoutMs:1000,toolTimeoutMs:1000};
  let manager=createManagerConfiguration({store,agent});
  assert.deepEqual(options(manager.get('manager').values),{...defaults,reasoningSummary:'concise'});
  assert.deepEqual(options(agent),{...defaults,reasoningSummary:'concise'});
  manager.update('manager',manual,{revision:0});
  db.exec("UPDATE platform_settings SET value=json_remove(value,'$.values.verbosity','$.values.autoCompactTokenLimit','$.values.toolOutputTokenLimit') WHERE key='configuration:manager'");
  manager=createManagerConfiguration({store,agent});
  assert.equal(manager.get('manager').revision,1);
  assert.deepEqual(options(manager.get('manager').values),{...defaults,reasoningSummary:'detailed'});
  assert.throws(()=>manager.update('manager',{toolOutputTokenLimit:0}),{code:'INVALID_CONFIGURATION'});
  const config={};
  let business=new ConfigurationStore(db,[executionScope({store,config})]);
  assert.deepEqual(options(business.get('execution').values),defaults);
  business.update('execution',manual);
  assert.deepEqual(options(config),manual);
  business.update('execution',{autoCompactTokenLimit:null,toolOutputTokenLimit:null});
  assert.deepEqual(options(config),{...manual,autoCompactTokenLimit:null,toolOutputTokenLimit:null});
  db.exec("UPDATE platform_settings SET value=json_remove(value,'$.values.verbosity','$.values.reasoningSummary') WHERE key='configuration:execution'");
  business=new ConfigurationStore(db,[executionScope({store,config})]);
  assert.equal(business.get('execution').revision,2);
  assert.deepEqual(options(business.get('execution').values),defaults);
});

test('native config maps only fixed model options and omits automatic i64 budgets',()=>{
  const pkg={native:{},tools:[]};
  const config=runtimeConfig(pkg,'http://localhost/mcp',{modelSettings:{...manual,'features.shell_tool':true,config:{'features.shell_tool':true}}});
  assert.equal(config.model_verbosity,'high');
  assert.equal(config.model_reasoning_summary,'detailed');
  assert.equal(config.model_auto_compact_token_limit,12000);
  assert.equal(config.tool_output_token_limit,4000);
  assert.equal(config['features.shell_tool'],false);
  const automatic=runtimeConfig(pkg,'http://localhost/mcp',{modelSettings:defaults});
  assert.equal(automatic.model_verbosity,'medium');
  assert.equal(automatic.model_reasoning_summary,'auto');
  assert.equal(Object.hasOwn(automatic,'model_auto_compact_token_limit'),false);
  assert.equal(Object.hasOwn(automatic,'tool_output_token_limit'),false);
});

test('runner HTTP accepts fixed model options and rejects invalid or arbitrary configuration',async t=>{
  const launched=[];
  const runtime={active:new Map(),launches:new Map(),launch:async run=>{launched.push(run);return {status:'running'};}};
  const server=createRuntimeServer({runtime,registry:{forTask:()=>({buildTask:()=>({native:{},tools:[]})})},config:{runnerToken:'synthetic-internal'},probe:async()=>({ready:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const post=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:'Bearer synthetic-internal','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/internal/config',manual)).status,200);
  assert.deepEqual(options(runtime),manual);
  assert.equal((await post('/internal/runs',{execution:defaults})).status,202);
  assert.deepEqual(options(launched[0].execution),defaults);
  for(const execution of [{autoCompactTokenLimit:0},{toolOutputTokenLimit:2147483648},{reasoningSummary:null},{config:{shell_tool:true}}])assert.equal((await post('/internal/runs',{execution})).status,400);
  assert.equal((await post('/internal/config',{nativeConfig:{}})).status,400);
});
