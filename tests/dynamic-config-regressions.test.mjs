import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {BusinessRegistry} from '../src/core/registry.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';
import {RuntimeClient} from '../src/runtime/client.mjs';
import {createPrivateApi} from '../src/api.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {createApplication} from '../src/application.mjs';
const type='regression.text',baseModule={type,version:'1',inputSchema:{type:'object'},resultSchema:{type:'object'},buildTask:()=>({prompt:'Complete task',native:{},tools:['complete_task']})};
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'config-regression-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
test('pausing during an in-flight readiness check leaves unclaimed tasks queued',async t=>{
  const registry=new BusinessRegistry([baseModule]),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
  store.accept('default',{type,request_id:'pause',input:{}});let release;const gate=new Promise(r=>{release=r;}),launched=[];
  const config={paused:false,concurrency:1},dispatcher=new Dispatcher({store,registry,config,runner:{ready:()=>gate,launch:async run=>{launched.push(run);return {status:'running'};}}});t.after(()=>dispatcher.stop());
  const pending=dispatcher.drain();config.paused=true;release({ready:true});await pending;
  assert.equal(launched.length,0);assert.equal(store.queued().length,1);
});
test('Gateway adopts the original timeout of a Runner launch still waiting for readiness',async t=>{
  const root=await temporary(t),registry=new BusinessRegistry([baseModule]),store=new RequestStore(':memory:',{registry});
  const task=store.accept('default',{type,request_id:'pending',input:{}}),run=store.claim(task.task_id);
  let release;const gate=new Promise(r=>{release=r;}),runtime=new AgentRuntime({workspace:root,codexHome:join(root,'codex'),createClient:()=>({notify(){},subscribe:()=>()=>{},close:async()=>{},request:async method=>method==='thread/start'?{thread:{id:'pending'}}:method==='turn/start'?{turn:{id:'pending-turn'}}:{}})});
  const execution={model:'original-model',taskTimeoutMs:600000,toolTimeoutMs:1000};
  const pending=runtime.launch({...run,execution,package:baseModule.buildTask()},{beforeStart:()=>gate});
  const server=createRuntimeServer({runtime,registry,config:{runnerToken:'internal'},probe:async()=>({ready:true})}),url=await listen(server);
  const runner=new RuntimeClient({url,token:'internal'}),dispatcher=new Dispatcher({store,registry,runner,config:{taskTimeoutMs:1,concurrency:1,paused:true}});
  t.after(async()=>{release();await pending.catch(()=>{});await dispatcher.stop();await runtime.stop();await new Promise(r=>server.close(r));store.close();});
  await dispatcher.synchronize();assert.equal(dispatcher.active.get(run.run_id).timer._idleTimeout,605000);
});
test('an active task processor retains its original transport timeout after a hot update',async t=>{
  const registry=new BusinessRegistry([{...baseModule,tools:{slow:{effect:'local',description:'Local processor',inputSchema:{type:'object'},execute:(args,ctx)=>ctx.process({name:'slow',run_id:ctx.runId})}}}]);
  const store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
  const task=store.accept('default',{type,request_id:'processor',input:{}}),run=store.claim(task.task_id);
  store.recordRun(run.run_id,{execution:{model:'original',taskTimeoutMs:10000,toolTimeoutMs:1000},generation:run.generation});
  const processor=createServer((req,res)=>{req.resume();setTimeout(()=>{res.setHeader('content-type','application/json');res.end('{"ok":true}');},40);}),url=await listen(processor);t.after(()=>new Promise(r=>processor.close(r)));
  const runner=new RuntimeClient({url,token:'internal',toolTimeoutMs:1000}),config={runnerToken:'internal',concurrency:1,paused:true},dispatcher={drain:async()=>{},completed:async()=>{}};
  const service=new OperationsService({store,registry,config,dispatcher,runner});
  const server=createPrivateApi({store,registry,runner,config,dispatcher}),base=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'timeout-regression',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+run.token}}}));
  assert.ok(!(await client.callTool({name:'slow',arguments:{}})).isError);
  await service.execute('configuration_update',{scope:'execution',patch:{toolTimeoutMs:1}});
  const result=await client.callTool({name:'slow',arguments:{}});assert.ok(!result.isError,JSON.stringify(result));
});
