import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagerStore } from '../src/manager/store.mjs';
import { ManagementAgent } from '../src/manager/agent.mjs';
import { createManagementMcpHandler } from '../src/manager/mcp.mjs';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { OperationsService } from '../src/operations/service.mjs';
import { CodexRpcClient } from '../src/codex/rpc.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';

test('pinned Codex management creates a JSON plugin through real MCP and resumes history in a second process',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'codex-manager-'));
  const store=new ManagerStore(join(root,'manager.sqlite')),business=new RequestStore(':memory:',{registry:new BusinessRegistry()});
  const operations=new OperationsService({store:business,config:{concurrency:1,paused:true},dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})}});
  let agent,failedTask;const requests=[],rpcCalls=[];
  const managerOperations=createManagerOperations({store,configuration:{scopes:new Map()},client:{execute:(...args)=>operations.execute(...args)}});
  const mcp=createManagementMcpHandler({store,operations:managerOperations,authorize:token=>agent.authorize(token)});
  const definition={type:'fixture.review',name:'离线测试',instructions:'审核后提交',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/responses')return mcp(req,res);
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));const index=requests.length-1;
    const operation=index===0?{name:'plugin_save',args:{definition}}:index===2?{name:'platform_context',args:{}}:index===3?{name:'project_source',args:{mode:'read',path:'src/manager/server.mjs',limit:5}}:index===4?{name:'tasks',args:{status:'failed'}}:index===5?{name:'retry',args:{task_id:failedTask.task_id}}:null;
    const events=operation?[{type:'response.output_item.done',item:{type:'function_call',call_id:'manager-call-'+index,namespace:'mcp__agent_task',name:operation.name,arguments:JSON.stringify(operation.args)}}]:[];
    events.push({type:'response.completed',response:{id:'manager-response-'+index,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:base+'/mcp',timeoutMs:20000,createClient:options=>{
    const client=new CodexRpcClient({...options,command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),env:{...options.env,NO_PROXY:'127.0.0.1,localhost'}}),request=client.request.bind(client);
    client.request=(method,params,...rest)=>{
      rpcCalls.push(method);
      if(method==='thread/start'||method==='thread/resume')params={...params,config:{...params.config,model_provider:'local_fixture',model_providers:{local_fixture:{name:'Local fixture',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}};
      return request(method,params,...rest);
    };return client;
  }});
  t.after(async()=>{await agent.stop();await mcp.settle();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();business.close();await rm(root,{recursive:true,force:true});});
  const conversation=store.createConversation('真实 Codex 测试');
  agent.enqueue(conversation.id,'MANAGEMENT_ORIGINAL_FIXTURE 创建业务插件');await agent.idle(conversation.id);
  assert.equal(business.plugins.get(definition.type).name,definition.name);
  failedTask=business.accept('test',{type:definition.type,request_id:'failed-for-management',input:{}});business.fail(business.claim(failedTask.task_id).run_id,'CODEX_TURN_FAILED');
  agent.enqueue(conversation.id,'查询失败任务，然后重新执行指定任务');await agent.idle(conversation.id);
  const actions=store.actions(conversation.id);assert.deepEqual(actions.map(action=>[action.name,action.status]),[['plugin_save','completed'],['platform_context','completed'],['project_source','completed'],['tasks','completed'],['retry','completed']]);
  assert.equal(rpcCalls.filter(method=>method==='thread/start').length,1);assert.equal(rpcCalls.filter(method=>method==='thread/resume').length,1);
  assert.equal(rpcCalls.filter(method=>method==='turn/start').length,2);
  assert.equal(requests.length,7);
  assert.match(JSON.stringify(requests[2]),/当前平台上下文版本/);
  assert.match(JSON.stringify(requests[4].input),/deployed-management-source/);
  const retried=business.db.prepare('SELECT task_id FROM agent_requests WHERE retry_of=?').get(failedTask.task_id);
  assert.ok(retried);assert.notEqual(retried.task_id,failedTask.task_id);assert.equal(business.get(failedTask.task_id).status,'failed');
  assert.ok(JSON.stringify(requests[2].input).includes('MANAGEMENT_ORIGINAL_FIXTURE'));
  assert.ok(JSON.stringify(requests[2].input).includes('plugin_save'));
});
