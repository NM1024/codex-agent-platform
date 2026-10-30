import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {CodexRpcClient} from '../src/codex/rpc.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';

test('pinned Codex routes manager fast then standard on a resumed thread without changing reasoning',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-speed-codex-')),store=new ManagerStore(':memory:'),requests=[],calls=[];
  let agent;
  const mcp=createManagementMcpHandler({store,operations:{},authorize:token=>agent?.authorize(token)});
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/responses')return mcp(req,res);
    let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));
    const events=[{type:'response.output_item.done',item:{id:'synthetic-'+requests.length,type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic speed fixture'}]}},{type:'response.completed',response:{id:'response-'+requests.length,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:`http://127.0.0.1:${server.address().port}/mcp`,timeoutMs:20000,createClient:options=>{
    // The platform creates an isolated CODEX_HOME with only an unused auth symlink;
    // this auth-free loopback provider cannot use real account authorization.
    const client=new CodexRpcClient({...options,command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),env:{...options.env,NO_PROXY:'127.0.0.1,localhost'}}),request=client.request.bind(client);
    client.request=(method,params,...rest)=>{
      calls.push(method);
      if(method==='thread/start'||method==='thread/resume')params={...params,config:{...params.config,model_provider:'synthetic_fixture',model_providers:{synthetic_fixture:{name:'Synthetic fixture',base_url:`http://127.0.0.1:${server.address().port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}};
      return request(method,params,...rest);
    };return client;
  }});
  t.after(async()=>{await agent.stop();await mcp.settle();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();await rm(root,{recursive:true,force:true});});
  const config=createManagerConfiguration({store,agent}),conversation=store.createConversation('Synthetic routing');
  config.update('manager',{reasoningEffort:'medium',serviceTier:'priority'});
  agent.enqueue(conversation.id,'Synthetic priority request');await agent.idle(conversation.id);
  assert.equal(store.getConversation(conversation.id).messages[0].status,'completed',JSON.stringify(store.getConversation(conversation.id).messages.map(({status,error})=>({status,error}))));
  store.setConversationExecution(conversation.id,{serviceTier:'default'});
  agent.enqueue(conversation.id,'Synthetic standard request');await agent.idle(conversation.id);
  assert.equal(requests.length,2);assert.equal(requests[0].service_tier,'priority');assert.ok(requests[1].service_tier==null);
  assert.deepEqual(requests.map(request=>request.reasoning.effort),['medium','medium']);
  assert.equal(calls.filter(method=>method==='thread/start').length,1);assert.equal(calls.filter(method=>method==='thread/resume').length,1);
});
