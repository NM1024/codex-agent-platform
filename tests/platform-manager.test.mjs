import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { OperationsService } from '../src/operations/service.mjs';

const plugin={type:'manager.created',name:'管理创建',instructions:'完成任务',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
async function setup(t,fixtureOptions={}) {
  const [{ManagerStore},{ManagementAgent},{createManagementMcpHandler}]=await Promise.all([import('../src/manager/store.mjs'),import('../src/manager/agent.mjs'),import('../src/manager/mcp.mjs')]);
  const root=await mkdtemp(join(tmpdir(),'manager-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const business=new RequestStore(':memory:',{registry:new BusinessRegistry()});t.after(()=>business.close());
  const operations=new OperationsService({store:business,config:{concurrency:1,paused:true},dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})}});
  const store=new ManagerStore(join(root,'manager.sqlite'));t.after(()=>store.close());
  let agent;const calls=[],clients=[],resumeTurns=[];
  const handler=createManagementMcpHandler({store,operations,authorize:token=>agent.authorize(token)});
  const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  const createClient=options=>{
    const listeners=new Set();const client={notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){fixtureOptions.onClose?.();if(fixtureOptions.closeGate)await fixtureOptions.closeGate;},async request(method,params,timeoutMs){
      calls.push({method,params,timeoutMs});if(method==='thread/start')return {thread:{id:'persistent-manager',name:fixtureOptions.threadName ?? null}};
      if(method==='thread/resume')return {thread:{id:params.threadId,name:fixtureOptions.threadName ?? null,turns:resumeTurns}};
      if(method==='thread/read') {
        fixtureOptions.onRead?.();
        if(fixtureOptions.readError)throw new Error(fixtureOptions.readError);
        return {thread:{id:fixtureOptions.readThreadId ?? params.threadId,name:fixtureOptions.readName ?? null}};
      }
      if(method==='turn/start') {
        if(fixtureOptions.disconnectStart){for(const fn of listeners)fn({method:'transport/closed',params:{code:'CODEX_EXIT'}});throw new Error('CODEX_EXIT');}
        setImmediate(async()=>{
          const mcp=new Client({name:'manager-fixture',version:'1'});
          try {
            await mcp.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${options.env.AGENT_TASK_MCP_TOKEN}`}}}));
            const result=await mcp.callTool({name:'plugin_save',arguments:{definition:plugin}});assert.ok(!result.isError,JSON.stringify(result));
            for(const event of fixtureOptions.events?.(options) ?? [])for(const fn of listeners)fn(event);
            for(const fn of listeners)fn({method:'item/completed',params:{threadId:'persistent-manager',turnId:'turn-'+clients.length,item:{id:'reply-'+clients.length,type:'agentMessage',text:'已保存插件，可以继续。'}}});
            for(const fn of listeners)fn({method:'turn/completed',params:{threadId:'persistent-manager',turn:{id:'turn-'+clients.length,status:'completed'}}});
          } finally {await mcp.close();}
        });return {turn:{id:'turn-'+clients.length}};
      }return {};
    }};clients.push(client);return client;
  };
  const create=()=>new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:url,createClient,timeoutMs:5000});
  agent=create();t.after(()=>agent.stop());
  return {store,business,operations,calls,agent,create,resumeTurns};
}
test('management conversation executes real MCP writes and continues the same thread across turns',async t=>{
  const {store,business,agent,calls}=await setup(t);const conversation=store.createConversation('管理');
  agent.enqueue(conversation.id,'创建插件');await agent.idle(conversation.id);
  agent.enqueue(conversation.id,'继续调整');await agent.idle(conversation.id);
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
  assert.equal(calls.filter(call=>call.method==='thread/resume').length,1);
  assert.equal(store.getConversation(conversation.id).messages.filter(row=>row.role==='assistant').length,2);
  assert.equal(business.plugins.get(plugin.type).name,plugin.name);
  assert.equal(store.actions(conversation.id).filter(row=>row.status==='completed').length,2);
  const start=calls.find(call=>call.method==='thread/start');assert.equal(start.params.config['features.shell_tool'],false);
  for(const {params} of calls.filter(call=>['thread/start','thread/resume'].includes(call.method))) {
    assert.equal(params.config.web_search,'live','Manager must offer native live search on both new and resumed threads');
    assert.equal(params.config['features.image_generation'],true);
    assert.equal(params.sandbox,'read-only');
    assert.equal(params.approvalPolicy,'never');
    for(const feature of ['shell_tool','apply_patch_freeform','js_repl','browser_use'])assert.equal(params.config['features.'+feature],false);
  }
  assert.ok(!JSON.stringify(start.params).includes('unused-auth'));
});

test('Codex thread names replace placeholder titles on start and resume without extra turns',async t=>{
  const options={threadName:'  Plugin configuration  '};
  const {store,agent,calls}=await setup(t,options),conversation=store.createConversation();
  agent.enqueue(conversation.id,'First user message is not the title');await agent.idle(conversation.id);
  assert.equal(store.getConversation(conversation.id).title,'Plugin configuration');
  options.threadName='Updated Codex title';
  agent.enqueue(conversation.id,'Follow up');await agent.idle(conversation.id);
  assert.equal(store.list().find(row=>row.id===conversation.id).title,'Updated Codex title');
  assert.equal(calls.filter(call=>call.method==='turn/start').length,2);
});

test('same-thread name notifications persist sanitized bounded titles and ignore invalid updates',async t=>{
  const {store,agent}=await setup(t,{events:options=>[
    {method:'thread/name/updated',params:{threadId:'persistent-manager',threadName:`Saved ${options.env.AGENT_TASK_MCP_TOKEN} password=synthetic-secret ${'x'.repeat(150)}`}},
    {method:'thread/name/updated',params:{threadId:'another-thread',threadName:'Wrong conversation'}},
    ...[null,'',' \n ',{name:'invalid'}].map(threadName=>({method:'thread/name/updated',params:{threadId:'persistent-manager',threadName}})),
  ]}),conversation=store.createConversation();
  agent.enqueue(conversation.id,'Configure');await agent.idle(conversation.id);
  const title=store.getConversation(conversation.id).title;
  assert.ok(title.startsWith('Saved [REDACTED] password=[REDACTED] '));
  assert.ok(title.length<=100);
  assert.ok(!title.includes('synthetic-secret'));
});

test('final thread metadata refresh discovers a Codex title after durable turn completion',async t=>{
  let store,conversation;
  const options={readName:'Final Codex title',onRead:()=>assert.equal(store.getConversation(conversation.id).messages[0].status,'completed')};
  const fixture=await setup(t,options);({store}=fixture);conversation=store.createConversation();
  fixture.agent.enqueue(conversation.id,'Inspect');await fixture.agent.idle(conversation.id);
  assert.equal(store.getConversation(conversation.id).title,'Final Codex title');
  const lookup=fixture.calls.find(call=>call.method==='thread/read');
  assert.deepEqual(lookup.params,{threadId:'persistent-manager',includeTurns:false});
  assert.ok(lookup.timeoutMs>0&&lookup.timeoutMs<=1000);
});

test('optional title lookup timeout does not interrupt or replay a completed management turn',async t=>{
  const {store,agent,calls,create}=await setup(t,{readError:'CODEX_TIMEOUT'}),conversation=store.createConversation('Fallback title');
  agent.enqueue(conversation.id,'Inspect');await agent.idle(conversation.id);
  const saved=store.getConversation(conversation.id);
  assert.equal(saved.title,'Fallback title');
  assert.equal(saved.messages[0].status,'completed');
  assert.equal(saved.messages.filter(row=>row.role==='assistant').length,1);
  assert.equal(calls.filter(call=>call.method==='thread/read').length,1);
  await agent.stop();const restarted=create();t.after(()=>restarted.stop());
  await restarted.recover();await restarted.idle(conversation.id);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
});

test('title refresh ignores metadata belonging to another thread',async t=>{
  const {store,agent}=await setup(t,{threadName:'Current thread title',readThreadId:'other-thread',readName:'Other title'}),conversation=store.createConversation();
  agent.enqueue(conversation.id,'Inspect');await agent.idle(conversation.id);
  assert.equal(store.getConversation(conversation.id).title,'Current thread title');
});

test('store preserves the last valid title across malformed or empty Codex names',async t=>{
  const {ManagerStore}=await import('../src/manager/store.mjs');
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation();
  store.syncTitle(conversation.id,'  Saved\n title  ');
  for(const name of [null,undefined,42,{},'',' \t\n '])store.syncTitle(conversation.id,name);
  assert.equal(store.getConversation(conversation.id).title,'Saved title');
  store.syncTitle(conversation.id,'x'.repeat(200));
  assert.equal(store.getConversation(conversation.id).title.length,100);
});
test('management changes model, prompt and tool timeout on its next turn in the same thread',async t=>{
  const {store,agent,calls}=await setup(t),conversation=store.createConversation('热配置');
  agent.enqueue(conversation.id,'第一轮');await agent.idle(conversation.id);
  agent.model='configured-manager';agent.instructions='更新后的管理职责';agent.toolTimeoutMs=3200;
  agent.enqueue(conversation.id,'第二轮');await agent.idle(conversation.id);
  const next=calls.find(call=>call.method==='thread/resume');assert.equal(next.params.model,'configured-manager');
  assert.ok(next.params.developerInstructions.startsWith('更新后的管理职责\n\n'));
  for(const start of calls.filter(call=>['thread/start','thread/resume'].includes(call.method))){
    assert.match(start.params.developerInstructions,/当前项目运营规范/);
    for(const rule of ['request_id','complete_task','reasoningEffort','定时计划','消息队列','默认业务并发为 5'])assert.ok(start.params.developerInstructions.includes(rule),rule);
    assert.match(start.params.developerInstructions,/平台接入规则/);
    assert.match(start.params.developerInstructions,/配置接入/);
    assert.match(start.params.developerInstructions,/plugin_connection_initialize/);
    assert.match(start.params.developerInstructions,/不允许读取、领取、指定、覆盖或重置已有密钥/);
    assert.match(start.params.developerInstructions,/不得通过管理对话索要、读取或展示入口密钥/);
    assert.match(start.params.developerInstructions,/领取前密钥不生效/);
  }
  assert.equal(next.params.config.mcp_servers.agent_task.tool_timeout_sec,4);
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
});

test('conversation model and effort override globals and model default clears a prior effort',async t=>{
  const {store,agent,calls}=await setup(t),conversation=store.createConversation('模型选择');
  const createClient=agent.createClient;
  agent.createClient=options=>{
    const client=createClient(options),request=client.request.bind(client);
    client.request=async(method,params)=>method==='model/list'?{data:[{model:'fixture-model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]}:request(method,params);
    return client;
  };
  agent.model='global-model';agent.reasoningEffort='high';
  store.setConversationExecution(conversation.id,{model:'fixture-model',reasoningEffort:'high'});
  agent.enqueue(conversation.id,'第一轮');await agent.idle(conversation.id);
  store.setConversationExecution(conversation.id,{model:'fixture-model',reasoningEffort:null});
  agent.enqueue(conversation.id,'下一轮使用模型默认');await agent.idle(conversation.id);
  agent.model='fixture-model';delete agent.reasoningEffort;
  store.setConversationExecution(conversation.id,{});
  agent.enqueue(conversation.id,'继承旧版全局默认');await agent.idle(conversation.id);
  const turns=calls.filter(call=>call.method==='turn/start');
  assert.deepEqual(turns.map(call=>[call.params.model,call.params.effort]),[['fixture-model','high'],['fixture-model','low'],['fixture-model','low']]);
  const messages=store.getConversation(conversation.id).messages.filter(message=>message.role==='user');
  assert.equal(messages[0].execution.reasoningEffort,'high');
  assert.equal(messages[1].execution.reasoningEffort,null);
});

test('recovering a completed turn does not depend on the model catalog still containing its model',async t=>{
  const {store,agent,calls,resumeTurns}=await setup(t),conversation=store.createConversation('恢复已完成轮次');
  store.thread(conversation.id,'persistent-manager');
  const message=store.enqueue(conversation.id,'已完成的原始消息');
  store.recordMessageExecution(message.id,{model:'removed-model',reasoningEffort:'high',timeoutMs:5000,toolTimeoutMs:1000});
  store.markRunning(message.id);store.turn(message.id,'completed-turn');store.interrupted(message.id);
  resumeTurns.push({id:'completed-turn',status:'completed',items:[{type:'agentMessage',text:'Saved completed result'}]});
  await agent.recover();await agent.idle(conversation.id);
  const saved=store.getConversation(conversation.id);
  assert.equal(saved.messages[0].status,'completed');
  assert.equal(saved.messages[1].text,'Saved completed result');
  assert.equal(calls.filter(call=>call.method==='model/list'||call.method==='turn/start').length,0);
});
test('manager resumes a persisted conversation without resending a completed user message',async t=>{
  const {store,agent,create,calls}=await setup(t);const conversation=store.createConversation('保留');
  agent.enqueue(conversation.id,'先创建');await agent.idle(conversation.id);await agent.stop();
  const next=create();t.after(()=>next.stop());await next.recover();
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(store.getConversation(conversation.id).messages.length,2);
});
test('interrupted management turn continues its original thread with confirmed action records',async t=>{
  const {store,agent,calls}=await setup(t);const conversation=store.createConversation('恢复');
  const message=store.enqueue(conversation.id,'原始请求：重试指定任务');store.thread(conversation.id,'persistent-manager');store.markRunning(message.id);store.turn(message.id,'known-turn');
  const action=store.beginAction(conversation.id,'retry',{task_id:'old-task'});store.finishAction(action,{task_id:'already-created-task',retry_of:'old-task'});
  await agent.recover();await agent.idle(conversation.id);
  const started=calls.find(call=>call.method==='turn/start');assert.match(started.params.input[0].text,/Continue the interrupted/);
  assert.match(started.params.input[0].text,/already-created-task/);assert.ok(!started.params.input[0].text.includes('原始请求'));
  assert.equal(store.actions(conversation.id).filter(row=>row.name==='retry').length,1);
});
test('inspection acceptance is durable and does not create a second conversation or message',async t=>{
  const {store}=await setup(t);
  const first=store.acceptInspection('fire-1','检查服务');const second=store.acceptInspection('fire-1','检查服务');
  assert.equal(first.conversation.id,second.conversation.id);assert.equal(second.created,false);
  assert.equal(store.getConversation(first.conversation.id).messages.length,1);
});

test('restart before dispatch preserves a new message on an existing management thread',async t=>{
  const {store,agent,calls}=await setup(t);const conversation=store.createConversation('未发送');
  store.thread(conversation.id,'persistent-manager');
  const message=store.enqueue(conversation.id,'NEW_UNSENT_MESSAGE 查询本次任务');store.markRunning(message.id);
  await agent.recover();await agent.idle(conversation.id);
  const started=calls.find(call=>call.method==='turn/start');
  assert.match(started.params.input[0].text,/NEW_UNSENT_MESSAGE/);
  assert.equal(store.getConversation(conversation.id).messages[0].status,'completed');
});
test('restart after a lost turn acknowledgement reconciles a completed turn without repeating its action',async t=>{
  const {store,agent,calls,resumeTurns}=await setup(t);const conversation=store.createConversation('确认丢失');
  store.thread(conversation.id,'persistent-manager');
  const message=store.enqueue(conversation.id,'重试任务');store.markRunning(message.id);
  resumeTurns.push({id:'lost-ack-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:`[management_message_id:${message.id}]\n重试任务`}]},{type:'agentMessage',text:'已重试，任务已登记。'}]});
  await agent.recover();await agent.idle(conversation.id);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,0);
  const restored=store.getConversation(conversation.id);assert.equal(restored.messages[0].status,'completed');
  assert.equal(restored.messages[1].text,'已重试，任务已登记。');
});

test('a lost turn-start acknowledgement remains interrupted and resumes the original thread on the next trigger',async t=>{
  const options={disconnectStart:true};
  const {store,agent,calls,resumeTurns}=await setup(t,options);const conversation=store.createConversation('断线');
  const message=agent.enqueue(conversation.id,'查询本轮任务');await agent.idle(conversation.id);
  const persisted=store.getConversation(conversation.id);
  assert.equal(persisted.messages.find(row=>row.id===message.id).status,'interrupted');
  assert.equal(persisted.messages.filter(row=>row.role==='assistant').length,0);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(store.next(conversation.id).id,message.id);
  options.disconnectStart=false;
  resumeTurns.push({id:'interrupted-original',status:'interrupted',items:[{type:'userMessage',content:[{type:'text',text:`[management_message_id:${message.id}]\n查询本轮任务`}]}]});
  agent.enqueue(conversation.id,'继续处理');await agent.idle(conversation.id);
  assert.equal(store.getConversation(conversation.id).messages.find(row=>row.id===message.id).status,'completed');
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,3);
  const resumed=calls.filter(call=>call.method==='turn/start')[1];
  assert.match(resumed.params.input[0].text,/Continue the interrupted/);
});

test('a new management message queued during disconnect cleanup still wakes the interrupted conversation',async t=>{
  let closeStarted,releaseClose;
  const closing=new Promise(r=>closeStarted=r),closeGate=new Promise(r=>releaseClose=r);
  const options={disconnectStart:true,closeGate,onClose:()=>closeStarted()};
  const {store,agent}=await setup(t,options);const conversation=store.createConversation('关闭时发送');
  const first=agent.enqueue(conversation.id,'先调查');await closing;
  options.disconnectStart=false;options.closeGate=null;
  const next=agent.enqueue(conversation.id,'继续处理');releaseClose();await agent.idle(conversation.id);
  const messages=store.getConversation(conversation.id).messages;
  assert.equal(messages.find(row=>row.id===first.id).status,'completed');
  assert.equal(messages.find(row=>row.id===next.id).status,'completed');
});
