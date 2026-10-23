import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {BusinessRegistry} from '../src/core/registry.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';

const definition={type:'test.recovery',version:'1',prompt:'Process all items once.',normalizeInput:x=>x,
 inputSchema:{type:'object'},resultSchema:{type:'boolean'},tools:{},
 buildTask:()=>({prompt:'Process all items once.',native:{},tools:['complete_task']})};
const run={run_id:'00000000-0000-4000-8000-000000000011',task_id:'00000000-0000-4000-8000-000000000012',
 type:definition.type,input:{},token:'fixture-token',generation:0,package:definition.buildTask()};
class Rpc {
 calls=[];listeners=new Set();
 async request(method,params){this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'persistent-root'}};
  if(method==='thread/resume')return {thread:{id:params.threadId,turns:[{id:'initial'}]}};
  if(method==='turn/start')return {turn:{id:'turn-'+this.calls.length}};
  return {};
 }
 notify(){} subscribe(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
 async close(){}
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'task-recovery-'));
 const clients=[],events=[],runtimes=[];
 const options={workspace:join(root,'workspace'),codexHome:join(root,'codex'),taskTimeoutMs:60000,
  createClient:()=>{const rpc=new Rpc();clients.push(rpc);return rpc;},onExit:(id,code,details)=>events.push({id,code,details})};
 const create=()=>{const runtime=new AgentRuntime(options);runtimes.push(runtime);return runtime;};
 t.after(async()=>{for(const runtime of runtimes)await runtime.stop();await rm(root,{recursive:true,force:true});});
 return {root,options,clients,events,create};
}
function storage(t){const registry=new BusinessRegistry([definition]);const store=new RequestStore(':memory:',{registry});
 t.after(()=>store.close());const accept=()=>store.accept('global',{type:definition.type,request_id:'same',input:{}});
 return {store,registry,accept};}

test('task threads persist and shutdown retains conversation home and unfinished files',async t=>{
 const {create,clients,events}=await fixture(t);const runtime=create();await runtime.launch(run);
 const state=runtime.active.get(run.run_id);await writeFile(join(state.home,'session-evidence'),'saved history');
 await writeFile(join(state.workDir,'unfinished.txt'),'already generated');
 assert.equal(clients[0].calls.find(x=>x.method==='thread/start').params.ephemeral,false);
 await runtime.stop();
 assert.equal(await readFile(join(state.home,'session-evidence'),'utf8'),'saved history');
 assert.equal(await readFile(join(state.workDir,'unfinished.txt'),'utf8'),'already generated');
 const marker=JSON.parse(await readFile(state.marker,'utf8'));
 assert.equal(marker.status,'suspended');assert.equal(marker.ended_at,null);
 assert.equal(events[0].code,'SUSPENDED');
});

test('restart resumes the original root once using a continuation without resending task data',async t=>{
 const {create,clients}=await fixture(t);const first=create();await first.launch(run);
 const original=first.active.get(run.run_id);await writeFile(join(original.workDir,'prior.txt'),'keep');
 await first.stop();const next=create();await next.recover();
 const resumed={...run,resume:true,generation:1,token:'rotated-token'};
 const ack=await next.launch(resumed);await next.launch(resumed);
 assert.equal(ack.thread_id,'persistent-root');assert.equal(ack.generation,1);
 assert.equal(clients[1].calls.filter(x=>x.method==='thread/start').length,0);
 assert.equal(clients[1].calls.filter(x=>x.method==='thread/resume').length,1);
 const turns=clients[1].calls.filter(x=>x.method==='turn/start');assert.equal(turns.length,1);
 assert.ok(!JSON.stringify(turns).includes(run.package.prompt));
 assert.match(turns[0].params.input[0].text,/continu/i);
 assert.equal(await readFile(join(original.workDir,'prior.txt'),'utf8'),'keep');
});

test('reconciliation retains original task and run identities and invalidates unfinished operations',async t=>{
 const {store,accept}=storage(t);const task=accept();const first=store.claim(task.task_id);
 store.started(first.run_id,{thread_id:'saved'});store.beginOperation(first.run_id,'publish');store.reconcile();
 assert.equal(store.get(task.task_id).status,'suspended');assert.equal(store.get(task.task_id).error,null);
 assert.equal(store.db.prepare('SELECT status FROM agent_operations').get().status,'unknown');
 const resumed=store.claim(task.task_id);
 assert.equal(resumed.run_id,first.run_id);assert.equal(resumed.resume,true);assert.equal(resumed.generation,1);
 assert.notEqual(resumed.token,first.token);assert.throws(()=>store.authenticate(first.token),{code:'UNAUTHORIZED'});
 assert.equal(store.authenticate(resumed.token).run_id,first.run_id);
 await store.complete(first.run_id,true);store.reconcile();assert.equal(store.get(task.task_id).status,'completed');
 const failed=store.claim(accept().task_id);store.fail(failed.run_id,'TASK_TIMEOUT');store.reconcile();
 assert.equal(store.get(failed.task_id).status,'failed');assert.equal(store.claim(failed.task_id),null);
});

test('gateway restart adopts a live root without cancelling or relaunching it',async t=>{
 const {store,registry,accept}=storage(t);const initial=store.claim(accept().task_id);store.started(initial.run_id);
 let cancelled=0,launched=0;
 const runner={ready:async()=>({ready:true}),active:async()=>({runs:[initial.run_id],details:[{run_id:initial.run_id,generation:0,thread_id:'same-root'}]}),
  launch:async()=>{launched++;return {status:'running'};},cancel:async()=>{cancelled++;}};
 const dispatcher=new Dispatcher({store,registry,runner,config:{concurrency:1}});t.after(()=>dispatcher.stop());
 await dispatcher.start();await dispatcher.drain();
 assert.equal(store.get(initial.task_id).status,'running');assert.equal(dispatcher.active.size,1);
 assert.equal(launched,0);assert.equal(cancelled,0);
 await dispatcher.stop();assert.equal(store.get(initial.task_id).status,'running');assert.equal(cancelled,0);
});

test('restart restores unfinished roots within capacity and does not activate completed or failed tasks',async t=>{
 const {store,registry,accept}=storage(t);const first=store.claim(accept().task_id);store.started(first.run_id);
 const second=store.claim(accept().task_id);store.started(second.run_id);
 const done=store.claim(accept().task_id);await store.complete(done.run_id,true);
 const failed=store.claim(accept().task_id);store.fail(failed.run_id,'TASK_TIMEOUT');
 const launched=[];const runner={ready:async()=>({ready:true}),active:async()=>({runs:[],details:[]}),
  launch:async r=>{launched.push(r);return {status:'running',generation:r.generation,thread_id:'saved'};},cancel:async()=>{}};
 const dispatcher=new Dispatcher({store,registry,runner,config:{concurrency:1}});t.after(()=>dispatcher.stop());
 await dispatcher.start();await dispatcher.drain();assert.equal(launched.length,1);
 assert.ok([first.run_id,second.run_id].includes(launched[0].run_id));assert.equal(launched[0].resume,true);
 const selected=launched[0].run_id===first.run_id?first:second;
 const waiting=selected===first?second:first;
 assert.equal(store.get(waiting.task_id).status,'suspended');assert.equal(store.get(done.task_id).status,'completed');
 assert.equal(store.get(failed.task_id).status,'failed');
 // A delayed event from the pre-restart process must not terminate the resumed root.
 await dispatcher.event(selected.run_id,'SUSPENDED',{generation:0});
 assert.equal(store.get(selected.task_id).status,'running');
});

test('an old asynchronous result cannot commit after a suspended run has resumed',async t=>{
 let resolve,started;const waiting=new Promise(r=>started=r);
 const registry=new BusinessRegistry([{...definition,validateResult:async result=>{started();await new Promise(r=>resolve=r);return result;}}]);
 const store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
 const task=store.accept('global',{type:definition.type,request_id:'one',input:{}});const first=store.claim(task.task_id);
 const completing=store.complete(first.run_id,true);await waiting;
 store.reconcile();const resumed=store.claim(task.task_id);store.started(resumed.run_id);
 resolve();await assert.rejects(completing,{code:'TASK_CLOSED'});
 assert.equal(store.get(task.task_id).status,'running');
});

test('a delayed launch acknowledgement cannot undo final-result validation',async t=>{
 let resolve,started;const waiting=new Promise(r=>started=r);
 const registry=new BusinessRegistry([{...definition,validateResult:async result=>{started();await new Promise(r=>resolve=r);return result;}}]);
 const store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
 const task=store.accept('global',{type:definition.type,request_id:'one',input:{}});const first=store.claim(task.task_id);
 const completing=store.complete(first.run_id,true);await waiting;store.started(first.run_id);
 resolve();assert.equal((await completing).task_status,'completed');
});

test('a real terminal failure received while suspended remains terminal',async t=>{
 const {store,registry,accept}=storage(t);const first=store.claim(accept().task_id);store.suspend(first.run_id);
 const dispatcher=new Dispatcher({store,registry,runner:{cancel:async()=>{}},config:{}});t.after(()=>dispatcher.stop());
 await dispatcher.event(first.run_id,'CODEX_TURN_FAILED',{generation:0});
 assert.equal(store.get(first.task_id).status,'failed');assert.equal(store.get(first.task_id).error.code,'CODEX_TURN_FAILED');
});

test('inventory reports the generation of a resumed launch before it has a process',async t=>{
 const {create}=await fixture(t);const runtime=create();const {createRuntimeServer}=await import('../src/runtime/server.mjs');
 let release,entered;const waiting=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 const starting=runtime.launch({...run,generation:2,resume:true},{beforeStart:async()=>{entered();await gate;}});
 await waiting;
 const server=createRuntimeServer({runtime,registry:{},config:{runnerToken:'fixture'},probe:async()=>({ready:true})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const inventory=await fetch('http://127.0.0.1:'+server.address().port+'/internal/active',{headers:{authorization:'Bearer fixture'}}).then(r=>r.json());
  assert.equal(inventory.details.find(x=>x.run_id===run.run_id).generation,2);
 } finally {release();await starting;server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('a live older generation is suspended before rotating credentials again',async t=>{
 const {store,registry,accept}=storage(t);const first=store.claim(accept().task_id);store.suspend(first.run_id);
 const current=store.claim(first.task_id);let suspended=0;
 const runner={active:async()=>({runs:[first.run_id],details:[{run_id:first.run_id,generation:0}]}),suspend:async()=>{suspended++;}};
 const dispatcher=new Dispatcher({store,registry,runner,config:{}});t.after(()=>dispatcher.stop());
 await dispatcher.synchronize();assert.equal(suspended,1);assert.equal(store.get(first.task_id).status,'suspended');
 assert.equal(store.run(first.run_id).generation,current.generation);
});

test('outbox retains a resumed completion published while the suspension event is being sent',async t=>{
 const {root}=await fixture(t);const {EventOutbox}=await import('../src/runtime/events.mjs');
 let entered,release;const waiting=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);const sent=[];
 const outbox=new EventOutbox({workspace:join(root,'events'),send:async event=>{sent.push(event);if(sent.length===1){entered();await gate;}}});
 t.after(()=>outbox.stop());
 const old=outbox.publish(run.run_id,'SUSPENDED',{generation:0});await waiting;
 const next=outbox.publish(run.run_id,'COMPLETED',{generation:1});
 // Give the new event enough time to reach its durable write before release.
 const {readdir}=await import('node:fs/promises');
 for(let i=0;i<100;i++){if((await readdir(outbox.directory)).length===2)break;await new Promise(r=>setTimeout(r,1));}
 release();await Promise.all([old,next]);await outbox.flush();
 assert.deepEqual(sent.map(x=>x.code),['SUSPENDED','COMPLETED']);
});

test('a resumed runtime rejects processor calls from the previous execution generation',async t=>{
 const {create}=await fixture(t);const runtime=create();await runtime.launch({...run,generation:1});
 const {createRuntimeServer}=await import('../src/runtime/server.mjs');let writes=0;
 const server=createRuntimeServer({runtime,registry:{forTask:()=>({processors:{publish:async()=>{writes++;return {};}}})},config:{runnerToken:'fixture'},probe:async()=>({ready:true})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/internal/processor',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({run_id:run.run_id,generation:0,name:'publish'})});
  assert.equal(response.status,409);assert.equal(writes,0);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('suspension settles an in-flight module processor before exposing its saved files for resume',async t=>{
 const {create}=await fixture(t);const runtime=create();await runtime.launch(run);
 const {createRuntimeServer}=await import('../src/runtime/server.mjs');
 let release,entered;const waiting=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 const server=createRuntimeServer({runtime,registry:{forTask:()=>({processors:{publish:async()=>{entered();await gate;return {};}}})},config:{runnerToken:'fixture'},probe:async()=>({ready:true})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=fetch('http://127.0.0.1:'+server.address().port+'/internal/processor',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({run_id:run.run_id,name:'publish'})});
 await waiting;let stopped=false;const stopping=runtime.stop().then(()=>stopped=true);
 try {await new Promise(r=>setTimeout(r,10));assert.equal(stopped,false);}
 finally {release();await stopping;await request;server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('persisted task survives a full service restart and completes through the real MCP gateway once',async t=>{
 const {root,create}=await fixture(t);
 const {createRuntimeServer}=await import('../src/runtime/server.mjs');
 const {RuntimeClient}=await import('../src/runtime/client.mjs');
 const {createPrivateApi}=await import('../src/api.mjs');
 const {createDeliveryWorker}=await import('../src/delivery/worker.mjs');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const servers=[],dispatchers=[],stores=[];let deliveries=0;
 const registry=new BusinessRegistry([{...definition,delivery:{execute:async()=>{deliveries++;return {status:'accepted'};}}}]);
 const listen=async server=>{servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;};
 const start=async runtime=>{
  const url=await listen(createRuntimeServer({runtime,registry,config:{runnerToken:'local-runner'},probe:async()=>({ready:true})}));
  const runner=new RuntimeClient({url,token:'local-runner'});
  const store=new RequestStore(join(root,'tasks.sqlite'),{registry});stores.push(store);
  const deliver=createDeliveryWorker({store,config:{}});
  const dispatcher=new Dispatcher({store,registry,runner,config:{concurrency:1},deliver});dispatchers.push(dispatcher);
  const privateUrl=await listen(createPrivateApi({store,registry,runner,dispatcher,config:{runnerToken:'local-runner'}}));
  await dispatcher.start();return {store,dispatcher,privateUrl};
 };
 let firstStoreClosed=false;
 t.after(async()=>{for(const d of dispatchers)await d.stop();for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}for(let i=0;i<stores.length;i++)if(i!==0||!firstStoreClosed)stores[i].close();});
 const original=create();const first=await start(original);
 const accepted=first.store.accept('global',{type:definition.type,request_id:'one',input:{}});await first.dispatcher.drain();
 const originalRun=first.store.raw(accepted.task_id).run_id;
 const originalThread=original.active.get(originalRun).threadId;
 await original.stop();await first.dispatcher.stop();first.store.close();firstStoreClosed=true;
 const resumed=create();await resumed.recover();const next=await start(resumed);
 assert.equal(next.store.raw(accepted.task_id).run_id,originalRun);
 assert.equal(resumed.active.get(originalRun).threadId,originalThread);
 assert.equal(next.store.run(originalRun).generation,1);
 const client=new Client({name:'recovery-fixture',version:'1'});
 try {
  await client.connect(new StreamableHTTPClientTransport(new URL(next.privateUrl+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+resumed.active.get(originalRun).run.token}}}));
  const result=await client.callTool({name:'complete_task',arguments:{result:true}});
  assert.equal(result.isError,undefined);assert.equal(next.store.get(accepted.task_id).status,'completed');
  await next.dispatcher.completed(originalRun);
  assert.equal(deliveries,1);
  const again=await client.callTool({name:'complete_task',arguments:{result:true}});
  assert.equal(again.isError,undefined);assert.equal(deliveries,1);
 } finally {await client.close();}
});

test('adopting a surviving root preserves a validation already running in the new Gateway',async t=>{
 let resolve,entered;const waiting=new Promise(r=>entered=r);
 const registry=new BusinessRegistry([{...definition,validateResult:async result=>{entered();await new Promise(r=>resolve=r);return result;}}]);
 const store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
 const task=store.accept('global',{type:definition.type,request_id:'one',input:{}});const first=store.claim(task.task_id);
 const completing=store.complete(first.run_id,true);await waiting;store.adopt(first.run_id,{});
 resolve();assert.equal((await completing).task_status,'completed');
});

test('stop during thread creation does not send a new initial message afterwards',async t=>{
 const {options,root}=await fixture(t);let release,entered;const waiting=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 const rpc=new Rpc();const request=rpc.request.bind(rpc);
 rpc.request=async(method,params)=>{const response=await request(method,params);if(method==='thread/start'){entered();await gate;}return response;};
 const runtime=new AgentRuntime({...options,createClient:()=>rpc});
 const launching=runtime.launch(run);await waiting;const stopping=runtime.stop();
 await new Promise(r=>setImmediate(r));release();await Promise.all([launching,stopping]);
 assert.equal(rpc.calls.filter(x=>x.method==='turn/start').length,0);
});

test('a launch acknowledgement waits for suspension to be durably classified',async t=>{
 const {options}=await fixture(t);const rpc=new Rpc();let release,entered;
 const waiting=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 rpc.close=async()=>{entered();await gate;};
 const request=rpc.request.bind(rpc);rpc.request=async(method,params)=>{
  const result=await request(method,params);
  if(method==='turn/start')for(const fn of [...rpc.listeners])fn({method:'transport/closed',params:{}});
  return result;
 };
 const runtime=new AgentRuntime({...options,createClient:()=>rpc});let settled=false;
 const launching=runtime.launch(run).then(result=>{settled=true;return result;});
 await waiting;
 try {await new Promise(r=>setImmediate(r));assert.equal(settled,false);}
 finally {release();}
 const ack=await launching;assert.equal(ack.status,'suspended');assert.equal(ack.code,'SUSPENDED');await runtime.stop();
});

test('shutdown during filesystem setup does not leave a newly started root behind',async t=>{
 const {create,clients}=await fixture(t);const runtime=create();
 const launching=runtime.launch(run);
 await Promise.resolve();await Promise.resolve();
 assert.equal(runtime.active.size,0);
 await Promise.all([runtime.stop(),launching]);
 assert.equal(runtime.active.size,0);
 assert.equal(clients.flatMap(x=>x.calls).filter(x=>x.method==='turn/start').length,0);
});

test('a resume RPC rejection preserves the existing conversation instead of deleting it',async t=>{
 const {create,options}=await fixture(t);const original=create();await original.launch(run);
 const home=original.active.get(run.run_id).home;await writeFile(join(home,'persisted.txt'),'keep history');await original.stop();
 const rpc=new Rpc();const request=rpc.request.bind(rpc);rpc.request=(method,params)=>method==='thread/resume'?Promise.reject(Object.assign(new Error('CODEX_RPC_ERROR'),{code:'CODEX_RPC_ERROR'})):request(method,params);
 const next=new AgentRuntime({...options,createClient:()=>rpc});
 await assert.rejects(next.launch({...run,resume:true,generation:1}),{message:'CODEX_RESUME_FAILED'});
 assert.equal(await readFile(join(home,'persisted.txt'),'utf8'),'keep history');await next.stop();
});

test('a completion that wins the launch acknowledgement race keeps a successful lifecycle',async t=>{
 const {store,registry,accept}=storage(t);const task=accept();
 const runner={ready:async()=>({ready:true}),launch:async run=>{await store.complete(run.run_id,true);return {status:'completed',completed:true,generation:run.generation};},cancel:async()=>{}};
 const dispatcher=new Dispatcher({store,registry,runner,config:{concurrency:1}});t.after(()=>dispatcher.stop());
 await dispatcher.drain();const result=store.get(task.task_id);
 assert.equal(result.status,'completed');assert.equal(result.execution.code,'COMPLETED');
});
