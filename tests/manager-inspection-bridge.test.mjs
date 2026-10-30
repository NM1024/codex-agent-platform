import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
import {acceptPendingInspections} from '../src/manager/inspections.mjs';

const inspectionId='00000000-0000-4000-8000-000000000001';
test('inspection original mapping persists, blocks restart dispatch until ACK, and duplicates keep the same message',async t=>{
  const root=await mkdtemp(join(tmpdir(),'inspection-admission-')),path=join(root,'manager.sqlite');
  let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const accepted=store.acceptInspection(inspectionId,'Synthetic inspection');
  assert.equal(store.metadata(accepted.conversation.id).source_message_id,accepted.message.id);
  assert.equal(store.metadata(accepted.conversation.id).inspection_admitted,0);
  assert.equal(store.next(accepted.conversation.id),undefined);
  store.enqueue(accepted.conversation.id,'Later ordinary message');
  store.schedule(accepted.conversation.id);store.close();store=new ManagerStore(path);
  assert.equal(store.recover(),0);assert.equal(store.takeScheduled(),undefined);
  const duplicate=store.acceptInspection(inspectionId,'Changed intake text');
  assert.equal(duplicate.message.id,accepted.message.id);assert.equal(duplicate.message.text,'Synthetic inspection');
  store.admitInspection(inspectionId,accepted.conversation.id,accepted.message.id);
  assert.equal(store.next(accepted.conversation.id).id,accepted.message.id);
  assert.equal(store.metadata(accepted.conversation.id).inspection_admitted,1);
  assert.throws(()=>store.admitInspection(inspectionId,accepted.conversation.id,'other'),{code:'INSPECTION_MAPPING_MISMATCH'});
});

test('inspection intake ACKs stable exact mapping before scheduling and duplicate intake restores a lost wake',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());let ackFailure=true;const events=[];
  const client={async execute(name,args){
    if(name==='inspection_list')return [{id:inspectionId}];
    if(name==='inspection_claim')return {id:inspectionId,message:'Synthetic inspection',accepted:true};
    if(name==='inspection_ack'){
      events.push(['ack',args]);assert.equal(store.next(args.conversation_id),undefined);
      if(ackFailure)throw new Error('Synthetic ACK loss');return {accepted:true};
    }
  }};
  const agent={kick(id){events.push(['kick',id]);assert.ok(store.next(id));}};
  await assert.rejects(acceptPendingInspections({client,store,agent}),/ACK loss/);
  assert.equal(events.filter(([name])=>name==='kick').length,0);
  const original=store.metadata(store.list()[0].id).source_message_id;
  ackFailure=false;await acceptPendingInspections({client,store,agent});
  assert.equal(events.at(-1)[0],'kick');assert.equal(events.at(-2)[1].message_id,original);
  await acceptPendingInspections({client:{async execute(name,args){if(name==='inspection_ack')return {accepted:true};return client.execute(name,args);}},store,agent});
  assert.equal(events.filter(([name])=>name==='kick').length,2);
  assert.equal(store.list().length,1);
});

test('rejected inspection ACK cannot admit or schedule the original message',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());let kicks=0;
  await acceptPendingInspections({store,agent:{kick(){kicks++;}},client:{async execute(name){return name==='inspection_list'?[{id:inspectionId}]:name==='inspection_claim'?{id:inspectionId,message:'Synthetic inspection',accepted:true}:{accepted:false};}}});
  assert.equal(kicks,0);assert.equal(store.next(store.list()[0].id),undefined);
});

import {ManagementAgent} from '../src/manager/agent.mjs';
async function agentFixture(t,{inspectionLifecycle}={}) {
  const root=await mkdtemp(join(tmpdir(),'inspection-agent-')),store=new ManagerStore(':memory:');const clients=[];
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:'http://127.0.0.1/unused',inspectionLifecycle,timeoutMs:5000,createClient(options){
    const listeners=new Set(),calls=[],client={calls,options,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},notify(){},async close(){},async request(method,params){
      calls.push({method,params});
      if(method==='thread/start'||method==='thread/resume'||method==='thread/read')return {thread:{id:'synthetic-thread',turns:[]}};
      if(method==='turn/start'){setImmediate(()=>{for(const fn of listeners)fn({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn',status:'completed'}}});});return {turn:{id:'synthetic-turn'}};}return {};
    }};clients.push(client);return client;
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});return {agent,store,clients};
}

test('manager model options snapshot honors global/conversation values, passes native config and summary',async t=>{
  const {agent,store,clients}=await agentFixture(t);
  Object.assign(agent,{verbosity:'high',reasoningSummary:'detailed',autoCompactTokenLimit:8192,toolOutputTokenLimit:4096});
  const c=store.createConversation();store.setConversationExecution(c.id,{verbosity:'low',autoCompactTokenLimit:null});
  const message=agent.enqueue(c.id,'Synthetic request');await agent.idle(c.id);
  const settings=store.message(message.id).execution;
  assert.deepEqual(Object.fromEntries(['verbosity','reasoningSummary','autoCompactTokenLimit','toolOutputTokenLimit'].map(key=>[key,settings[key]])),{verbosity:'low',reasoningSummary:'detailed',autoCompactTokenLimit:null,toolOutputTokenLimit:4096});
  const config=clients[0].calls.find(call=>call.method==='thread/start').params.config;
  assert.equal(config.model_verbosity,'low');assert.equal(config.model_reasoning_summary,'detailed');assert.equal(config.tool_output_token_limit,4096);assert.equal('model_auto_compact_token_limit' in config,false);
  assert.equal(clients[0].calls.find(call=>call.method==='turn/start').params.summary,'detailed');
});

test('legacy execution snapshots gain role defaults without replacing their saved model or current settings',async t=>{
  const {agent,store,clients}=await agentFixture(t);Object.assign(agent,{verbosity:'high',reasoningSummary:'none',toolOutputTokenLimit:4000});
  const c=store.createConversation(),message=store.enqueue(c.id,'Legacy request');
  store.recordMessageExecution(message.id,{model:'saved-model',timeoutMs:5000,toolTimeoutMs:5000});
  agent.kick(c.id);await agent.idle(c.id);
  const settings=store.message(message.id).execution;assert.equal(settings.model,'saved-model');assert.equal(settings.verbosity,'medium');assert.equal(settings.reasoningSummary,'concise');assert.equal(settings.toolOutputTokenLimit,null);
  assert.equal(clients[0].calls.find(call=>call.method==='turn/start').params.summary,'concise');
});

test('active token identifies the exact message and only original admitted inspection emits lifecycle',async t=>{
  const updates=[];let agent,store;const fixture=await agentFixture(t,{inspectionLifecycle:async event=>{
    updates.push(event);assert.equal(store.message(event.message_id).status,event.state==='running'?'running':'completed');
    if(event.state==='running'){assert.equal(fixture.clients.length,0,'Gateway running confirmation precedes model startup');}
  }});({agent,store}=fixture);
  const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);
  const contexts=[];const makeClient=agent.createClient;agent.createClient=options=>{const token=options.env.AGENT_TASK_MCP_TOKEN;contexts.push(agent.executionContext(token));assert.equal(agent.authorize(token),original.conversation.id);return makeClient(options);};
  agent.kick(original.conversation.id);await agent.idle(original.conversation.id);
  assert.deepEqual(contexts,[{conversationId:original.conversation.id,messageId:original.message.id}]);
  assert.deepEqual(updates.map(update=>update.state),['running','completed']);
  assert.equal(agent.executionContext(fixture.clients[0].options.env.AGENT_TASK_MCP_TOKEN),undefined);
  agent.createClient=makeClient;agent.enqueue(original.conversation.id,'Ordinary followup');await agent.idle(original.conversation.id);
  assert.equal(updates.length,2);
});

test('failed inspection running confirmation prevents model work',async t=>{
  const {agent,store,clients}=await agentFixture(t,{inspectionLifecycle:async event=>{if(event.state==='running')throw new Error('Synthetic unavailable Gateway');}});
  const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);
  agent.kick(original.conversation.id);await agent.idle(original.conversation.id);assert.equal(clients.length,0);assert.equal(store.message(original.message.id).status,'failed');
});

test('legacy completed inspection stays ended and permits ordinary followups after migration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'inspection-legacy-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const original=store.acceptInspection(inspectionId,'Completed old inspection');store.markRunning(original.message.id);store.finish(original.message,null,'Done');
  store.db.prepare('UPDATE manager_conversations SET source_message_id=NULL,inspection_admitted=0 WHERE id=?').run(original.conversation.id);
  store.close();store=new ManagerStore(path);
  const followup=store.enqueue(original.conversation.id,'Ordinary later question');
  assert.equal(store.next(original.conversation.id)?.id,followup.id);
  assert.equal(store.metadata(original.conversation.id).source_message_id,original.message.id);
});

async function bridgeClass(){const module=await import('../src/manager/inspection-notifications.mjs');assert.equal(typeof module.InspectionNotificationBridge,'function');return module.InspectionNotificationBridge;}
test('inspection owner cleanup survives service loss and restart, while transaction rollback does not leave a job',async t=>{
  const Bridge=await bridgeClass(),root=await mkdtemp(join(tmpdir(),'inspection-cleanup-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const events=[];let unavailable=true;const client={async execute(name,args){events.push({name,args});if(unavailable)throw new Error('Synthetic unavailable');return {deleted:true};}};
  let bridge=new Bridge({store,client});store.onDeleteOwner=owner=>bridge.queueCleanup(owner);
  const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);store.markRunning(original.message.id);store.finish(original.message,null,'Done');
  store.onDeleteOwner=owner=>{bridge.queueCleanup(owner);throw new Error('Synthetic transaction rollback');};
  assert.throws(()=>store.deleteConversation(original.conversation.id),/transaction rollback/);assert.ok(store.metadata(original.conversation.id));
  assert.deepEqual(await bridge.cleanup(),{attempted:0,completed:0,pending:0});
  store.onDeleteOwner=owner=>bridge.queueCleanup(owner);store.deleteConversation(original.conversation.id);
  assert.equal((await bridge.cleanup()).pending,1);store.close();store=new ManagerStore(path);bridge=new Bridge({store,client});unavailable=false;
  assert.deepEqual(await bridge.cleanup(),{attempted:1,completed:1,pending:0});assert.deepEqual(events.at(-1),{name:'inspection_notification_cleanup',args:{id:inspectionId,conversation_id:original.conversation.id}});
  assert.deepEqual(await bridge.cleanup(),{attempted:0,completed:0,pending:0});
  const ordinary=store.createConversation('Investigation','task:synthetic-task');store.onDeleteOwner=owner=>bridge.queueCleanup(owner);store.deleteConversation(ordinary.id);
  assert.equal((await bridge.cleanup()).attempted,0);
});

test('inspection terminal lifecycle updates retry durably and running confirmation must be accepted',async t=>{
  const Bridge=await bridgeClass(),root=await mkdtemp(join(tmpdir(),'inspection-lifecycle-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const event={id:inspectionId,conversation_id:'synthetic-conversation',message_id:'synthetic-message',state:'completed'},events=[];let unavailable=true;
  const client={async execute(name,args){events.push({name,args});if(unavailable)throw new Error('Synthetic unavailable');return {accepted:true};}};
  let bridge=new Bridge({store,client});await assert.rejects(bridge.lifecycle(event),/unavailable/);
  store.close();store=new ManagerStore(path);bridge=new Bridge({store,client});unavailable=false;
  assert.deepEqual(await bridge.retryLifecycle(),{attempted:1,completed:1,pending:0});assert.deepEqual(events.at(-1),{name:'inspection_execution_update',args:event});
  client.execute=async()=>({accepted:false});await assert.rejects(bridge.lifecycle({...event,state:'running'}),{code:'INSPECTION_EXECUTION_REJECTED'});
});

test('conversation execution compare-and-swap rejects stale content and accepts legacy null inheritance',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const c=store.createConversation();
  store.setConversationExecution(c.id,{verbosity:'low'},{expectedExecution:{}});
  assert.throws(()=>store.setConversationExecution(c.id,{verbosity:'high'},{expectedExecution:{}}),{code:'CONVERSATION_EXECUTION_CONFLICT'});
  assert.deepEqual(store.metadata(c.id).execution,{verbosity:'low'});
  store.setConversationExecution(c.id,{verbosity:'medium'},{expectedExecution:{verbosity:'low'}});
  assert.deepEqual(store.metadata(c.id).execution,{verbosity:'medium'});
});

test('manual conversation deletion attempts inspection cleanup and reports a durable pending retry',async t=>{
  const Bridge=await bridgeClass();const {agent,store}=await agentFixture(t);let unavailable=true;
  const bridge=new Bridge({store,client:{async execute(){if(unavailable)throw new Error('Synthetic unavailable');return {deleted:true};}}});
  store.onDeleteOwner=owner=>bridge.queueCleanup(owner);agent.inspectionCleanup=id=>bridge.cleanup({conversationId:id});
  const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);store.markRunning(original.message.id);store.finish(original.message,null,'Done');
  const result=await agent.deleteConversation(original.conversation.id);assert.equal(result.deleted,true);assert.equal(result.cleanup_pending,true);
  unavailable=false;assert.deepEqual(await bridge.cleanup(),{attempted:1,completed:1,pending:0});
});

import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';
async function mcpFixture(t,{store,conversationId,executionContext}) {
  const calls=[];const handler=createManagementMcpHandler({store,authorize:token=>token==='synthetic-token'?conversationId:undefined,executionContext,operations:{async execute(...args){calls.push(args);return {accepted:true};}}});
  const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const client=new Client({name:'inspection-mcp-fixture',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer synthetic-token'}}}));
  t.after(async()=>{await client.close();await handler.settle();server.closeAllConnections();await new Promise(r=>server.close(r));});return {client,calls};
}

test('MCP forwards exact message context only to three scoped tools and lists notifications only for the original active inspection',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);store.markRunning(original.message.id);
  let context={conversationId:original.conversation.id,messageId:original.message.id};
  const {client,calls}=await mcpFixture(t,{store,conversationId:original.conversation.id,executionContext:()=>context});
  const toolNames=async()=>(await client.listTools()).tools.map(tool=>tool.name);
  assert.ok((await toolNames()).includes('notification_context'));assert.ok((await toolNames()).includes('send_notification'));
  for(const name of ['overview','conversation_execution','notification_context','send_notification'])await client.callTool({name,arguments:{}});
  assert.equal(calls[0].length,2);for(const call of calls.slice(1))assert.deepEqual(call[2],context);
  const later=store.enqueue(original.conversation.id,'Ordinary followup');store.finish(original.message,null,'Done');store.markRunning(later.id);context={conversationId:original.conversation.id,messageId:later.id};
  assert.equal((await toolNames()).includes('send_notification'),false);
  const result=await client.callTool({name:'send_notification',arguments:{}});assert.equal(result.isError,true);assert.equal(calls.length,4);
  context=undefined;assert.equal((await toolNames()).includes('notification_context'),false);
});

test('MCP conversation settings retain trusted conversation identity without an optional message callback',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation();
  const {client,calls}=await mcpFixture(t,{store,conversationId:conversation.id});
  await client.callTool({name:'conversation_execution',arguments:{}});assert.deepEqual(calls[0][2],{conversationId:conversation.id});
  assert.equal((await client.listTools()).tools.some(tool=>tool.name==='send_notification'),false);
});

test('unadmitted interrupted inspection remains blocked during restart while ordinary investigations recover',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const original=store.acceptInspection(inspectionId,'Unadmitted original');store.markRunning(original.message.id);
  const investigation=store.createConversation('Investigation','task:synthetic-task'),ordinary=store.enqueue(investigation.id,'Recover ordinary work');store.markRunning(ordinary.id);
  assert.equal(store.recover(),1);assert.equal(store.message(original.message.id).status,'interrupted');assert.equal(store.next(original.conversation.id),undefined);
  assert.equal(store.takeScheduled(),investigation.id);assert.equal(store.next(investigation.id).id,ordinary.id);
});

test('inspection lifecycle outage after completion keeps the local message final and durably reconciles Gateway',async t=>{
  const {agent,store,clients}=await agentFixture(t);const Bridge=await bridgeClass();let unavailable=true;const updates=[];
  const bridge=new Bridge({store,client:{async execute(name,event){updates.push(event);if(event.state==='completed'&&unavailable)throw new Error('Synthetic terminal ACK loss');return {accepted:true};}}});
  agent.inspectionLifecycle=event=>bridge.lifecycle(event);
  const original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);agent.kick(original.conversation.id);await agent.idle(original.conversation.id);
  assert.equal(store.message(original.message.id).status,'completed');assert.equal(clients.length,1);assert.equal(agent.active.size,0);assert.equal(agent.tokens.size,0);
  unavailable=false;assert.deepEqual(await bridge.retryLifecycle(),{attempted:1,completed:1,pending:0});assert.deepEqual(updates.map(event=>event.state),['running','completed','completed']);
});

test('legacy mapping uses original enqueue order when dispatch assigned a newer history position',async t=>{
  const root=await mkdtemp(join(tmpdir(),'inspection-legacy-order-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const original=store.acceptInspection(inspectionId,'Original queued first'),later=store.enqueue(original.conversation.id,'Ordinary later request');
  store.markRunning(original.message.id);store.finish(original.message,null,'Done');
  store.db.prepare('UPDATE manager_messages SET created_at=?,queued_at=? WHERE id=?').run(3000,1000,original.message.id);store.db.prepare('UPDATE manager_messages SET created_at=?,queued_at=? WHERE id=?').run(2000,2000,later.id);
  store.db.prepare('UPDATE manager_conversations SET source_message_id=NULL,inspection_admitted=0 WHERE id=?').run(original.conversation.id);store.close();store=new ManagerStore(path);
  assert.equal(store.metadata(original.conversation.id).source_message_id,original.message.id);assert.equal(store.next(original.conversation.id)?.id,later.id);
});

import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
async function gatewayInspection(t){
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-admission-internal'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());
  const operations=new OperationsService({...app,store,configuration:app.configuration(store),dispatcher:{drain:async()=>{},blocked:new Map()},runner:{ready:async()=>({ready:true})}}),now=Date.parse('2026-10-30T00:00:00Z');
  operations.schedules.save({name:'Synthetic durable inspection',kind:'inspection',message:'Synthetic inspection',cron:'* * * * *'},now);await operations.schedules.tick(now+60000);
  return {operations,gatewayStore:store,id:(await operations.execute('inspection_list'))[0].id};
}

test('local unadmitted mapping reconciles a Gateway-committed ACK lost before Manager admission after restart',async t=>{
  const {operations,id}=await gatewayInspection(t),root=await mkdtemp(join(tmpdir(),'inspection-lost-admit-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  let loseAcknowledgement=true;const mappings=[],kicks=[];
  const client={async execute(name,args){const result=await operations.execute(name,args);if(name==='inspection_ack'){mappings.push({...args});if(loseAcknowledgement){loseAcknowledgement=false;throw new Error('Synthetic committed ACK response loss');}}return result;}};
  await assert.rejects(acceptPendingInspections({client,store,agent:{kick(id){kicks.push(id);}}}),/committed ACK response loss/);
  assert.deepEqual(await operations.execute('inspection_list'),[]);const original=store.list()[0];assert.equal(original.inspection_admitted,0);assert.equal(kicks.length,0);
  store.close();store=new ManagerStore(path);assert.equal(store.recover(),0);
  await acceptPendingInspections({client,store,agent:{kick(id){kicks.push(id);}}});
  assert.equal(store.metadata(original.id).inspection_admitted,1);assert.equal(store.next(original.id).id,original.source_message_id);assert.deepEqual(kicks,[original.id]);
  assert.equal(mappings.length,2);assert.deepEqual(mappings[1],mappings[0]);assert.equal(mappings[1].id,id);assert.equal(store.list().length,1);
});

test('inspection finish atomically queues terminal Gateway reconciliation before post-turn callbacks can run',async t=>{
  const {operations,id,gatewayStore}=await gatewayInspection(t),Bridge=await bridgeClass(),root=await mkdtemp(join(tmpdir(),'inspection-finish-outbox-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  let bridge=new Bridge({store,client:operations});store.onFinishInspection=event=>bridge.queueLifecycle(event);
  const original=store.acceptInspection(id,'Synthetic original'),scope={id,conversation_id:original.conversation.id,message_id:original.message.id};await operations.execute('inspection_claim',{id});await operations.execute('inspection_ack',{...scope,message_status:'queued'});store.admitInspection(id,original.conversation.id,original.message.id);store.markRunning(original.message.id);await operations.execute('inspection_execution_update',{...scope,state:'running'});
  store.finish(original.message,null,'Finished locally before process loss');assert.equal(gatewayStore.db.prepare('SELECT execution_state FROM platform_inspections WHERE id=?').get(id).execution_state,'running');
  // Simulate process loss immediately after the local finish commit: no Agent finally callback.
  store.close();store=new ManagerStore(path);bridge=new Bridge({store,client:operations});assert.equal(store.recover(),0);
  assert.deepEqual(await bridge.retryLifecycle(),{attempted:1,completed:1,pending:0});const remote=gatewayStore.db.prepare('SELECT execution_state,finished_at FROM platform_inspections WHERE id=?').get(id);assert.equal(remote.execution_state,'completed');assert.ok(remote.finished_at);
  assert.deepEqual(await bridge.retryLifecycle(),{attempted:0,completed:0,pending:0});assert.equal(store.message(original.message.id).status,'completed');
});

test('failed terminal outbox insertion rolls back inspection completion and its assistant reply',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const Bridge=await bridgeClass(),bridge=new Bridge({store,client:{}}),original=store.acceptInspection(inspectionId,'Synthetic inspection');store.admitInspection(inspectionId,original.conversation.id,original.message.id);store.markRunning(original.message.id);
  store.onFinishInspection=event=>{bridge.queueLifecycle(event);throw new Error('Synthetic outbox transaction failure');};
  assert.throws(()=>store.finish(original.message,null,'Must roll back'),/outbox transaction failure/);assert.equal(store.message(original.message.id).status,'running');assert.equal(store.getConversation(original.conversation.id).messages.length,1);assert.deepEqual(await bridge.retryLifecycle(),{attempted:0,completed:0,pending:0});
});

test('local admission reconciliation does not execute an already completed legacy original again',async t=>{
  const {operations,id}=await gatewayInspection(t),{agent,store,clients}=await agentFixture(t);await operations.execute('inspection_claim',{id});
  const original=store.acceptInspection(id,'Legacy completed original');store.markRunning(original.message.id);store.finish(original.message,null,'Already completed before durable admission existed');
  await acceptPendingInspections({client:operations,store,agent});await agent.idle(original.conversation.id);
  assert.equal(store.metadata(original.conversation.id).inspection_admitted,1);assert.equal(clients.length,0);assert.equal(store.message(original.message.id).status,'completed');
});

test('inspection finish hook only queues the admitted original and never ordinary followups or investigations',t=>{
  const events=[],store=new ManagerStore(':memory:',{onFinishInspection:event=>events.push(event)});t.after(()=>store.close());
  const original=store.acceptInspection(inspectionId,'Original');store.admitInspection(inspectionId,original.conversation.id,original.message.id);store.markRunning(original.message.id);store.finish(original.message,null,'Done');
  const later=store.enqueue(original.conversation.id,'Ordinary followup');store.markRunning(later.id);store.finish(later,{code:'SYNTHETIC_FAILURE',message:'Synthetic failure'},'Ended');
  const investigation=store.createConversation('Investigation','task:synthetic-task'),message=store.enqueue(investigation.id,'Investigate');store.markRunning(message.id);store.finish(message,null,'Done');
  assert.deepEqual(events,[{id:inspectionId,conversation_id:original.conversation.id,message_id:original.message.id,state:'completed'}]);
});

test('local inspection admission reconciliation pages past rejected mappings without starving later owners',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const calls=[],kicks=[];
  for(let n=0;n<103;n++)store.acceptInspection(`00000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,'Synthetic pending admission');
  const client={async execute(name,args){if(name==='inspection_list')return [];assert.equal(name,'inspection_ack');calls.push(args);return {accepted:calls.length===103};}};
  await acceptPendingInspections({store,client,agent:{kick(id){kicks.push(id);}}});assert.equal(calls.length,103);assert.equal(new Set(calls.map(args=>args.message_id)).size,103);assert.equal(kicks.length,1);assert.equal(store.metadata(kicks[0]).inspection_admitted,1);
});
