import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';
import {CodexRpcClient} from '../src/codex/rpc.mjs';

test('pinned Codex native question waits for a human answer and continues the same turn offline',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'native-question-')),store=new ManagerStore(':memory:');
  let agent,turns=0;const requests=[];
  const mcp=createManagementMcpHandler({store,operations:{execute(){throw new Error('NO_BUSINESS_WORK');}},authorize:token=>agent.authorize(token)});
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/responses')return mcp(req,res);
    let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    const items=requests.length===1?[{type:'function_call',call_id:'question-call',namespace:'functions',name:'request_user_input',arguments:JSON.stringify({questions:[{id:'format',header:'Format',question:'Choose a format',isOther:true,options:[{label:'JSON',description:'Structured data'},{label:'Text',description:'Plain text'}]}]})}]:[{id:'final',type:'message',role:'assistant',content:[{type:'output_text',text:'JSON selected'}]}];
    const events=items.map(item=>({type:'response.output_item.done',item}));events.push({type:'response.completed',response:{id:'response-'+requests.length,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  agent=new ManagementAgent({root,store,authFile:join(root,'unused'),mcpUrl:base+'/mcp',timeoutMs:15000,createClient:options=>{
    const client=new CodexRpcClient({...options,command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),env:{...options.env,NO_PROXY:'127.0.0.1,localhost'}}),request=client.request.bind(client);
    client.request=(method,params,...rest)=>{
      if(method==='turn/start')turns++;
      if(method==='thread/start')params={...params,config:{...params.config,model_provider:'local_fixture',model_providers:{local_fixture:{name:'Offline question fixture',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}};
      return request(method,params,...rest);
    };return client;
  }});
  t.after(async()=>{await agent.stop();await mcp.settle();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await rm(root,{recursive:true,force:true});});
  const c=store.createConversation(),m=agent.enqueue(c.id,'Ask for output format.');
  const question=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{unwatch();reject(new Error('NO_NATIVE_QUESTION: '+JSON.stringify(store.getConversation(c.id).messages.map(x=>({status:x.status,error:x.error})))));},7000);
    const check=()=>{const q=store.message(m.id).questions[0];if(q){clearTimeout(timer);unwatch();resolve(q);}};
    const unwatch=store.watch(c.id,check);check();
  });
  assert.equal(question.status,'pending');assert.equal(requests.length,1);
  agent.answerQuestion(c.id,question.id,{format:{answers:['JSON']}});await agent.idle(c.id);
  assert.equal(turns,1);assert.equal(requests.length,2);
  assert.ok(JSON.stringify(requests[1].input).includes('JSON'));
  assert.equal(store.getConversation(c.id).messages.at(-1).text,'JSON selected');
});
