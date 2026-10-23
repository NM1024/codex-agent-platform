import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {CodexRpcClient,filteredCodexEnv} from '../src/codex/rpc.mjs';

// Two actual pinned Codex processes; only model responses and business effects
// are local fixtures. No user login, external model, image or production callback.
test('pinned Codex resumes persisted history across process restart and reconnects task MCP', {timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-recovery-'));
 let runtime,phase='first',ready,finish;
 const waiting=new Promise(r=>ready=r),completed=new Promise(r=>finish=r);
 const requests=[],calls=[],rpcCalls=[],clients=[],events=[];
 const tools=['prepare_cover','complete_task'];
 const server=createServer(async(req,res)=>{
  if(req.url==='/v1/responses'){
   let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
   if(phase==='first'&&calls.includes('prepare_cover')){
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': waiting for restart\n\n');ready();return;
   }
   const tool=phase==='first'?'prepare_cover':calls.includes('complete_task')?null:'complete_task';
   const response=[];
   if(tool)response.push({type:'response.output_item.done',item:{type:'function_call',call_id:'call-'+requests.length,namespace:'mcp__agent_task',name:tool,arguments:'{}'}});
   response.push({type:'response.completed',response:{id:'response-'+requests.length,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(response.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));return;
  }
  const token=phase==='first'?'first-fixture-token':'second-fixture-token';
  if(req.url!=='/mcp'||req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  const mcp=new Server({name:'recovery-fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.map(name=>({name,description:'Local recovery fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}))}));
  mcp.setRequestHandler(CallToolRequestSchema,async request=>{
   const name=request.params.name;calls.push(name);
   if(name==='prepare_cover')await writeFile(join(runtime.active.values().next().value.workDir,'prior-work.txt'),'saved-fixture-work');
   else await runtime.completed(run.run_id);
   return {content:[{type:'text',text:name==='prepare_cover'?'saved-fixture-artifact':'fixture completion accepted'}]};
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('finish',()=>{void transport.close();void mcp.close();});
  await mcp.connect(transport);await transport.handleRequest(req,res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const create=()=>new AgentRuntime({workspace:join(root,'workspace'),codexHome:join(root,'codex'),mcpUrl:base+'/mcp',taskTimeoutMs:60000,closingTimeoutMs:10000,
  createClient:options=>{
   const client=new CodexRpcClient({...options,command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),env:{...filteredCodexEnv(),...options.env,NO_PROXY:'127.0.0.1,localhost'}});
   clients.push(client);const request=client.request.bind(client);
   client.request=(method,params,...rest)=>{
    rpcCalls.push({method,params});
    if(method==='thread/start'||method==='thread/resume')params={...params,config:{...params.config,model_provider:'local_fixture',model_providers:{local_fixture:{name:'Local offline fixture',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}};
    return request(method,params,...rest);
   };return client;
  },onExit:(id,code,details)=>{events.push({id,code,details});if(code==='COMPLETED')finish();}});
 const run={run_id:'00000000-0000-4000-8000-000000000041',task_id:'00000000-0000-4000-8000-000000000042',type:'test.recovery',input:{},token:'first-fixture-token',generation:0,
  package:{prompt:'ORIGINAL_TASK_FIXTURE: perform the local task and finish using MCP.',native:{},tools}};
 t.after(async()=>{await runtime?.stop();for(const client of clients)await client.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 runtime=create();const first=await runtime.launch(run);await waiting;
 const work=runtime.active.get(run.run_id).workDir;
 await runtime.stop();assert.equal(events[0].code,'SUSPENDED');
 assert.equal(await readFile(join(work,'prior-work.txt'),'utf8'),'saved-fixture-work');
 phase='resumed';runtime=create();await runtime.recover();
 const next=await runtime.launch({...run,generation:1,resume:true,token:'second-fixture-token'});
 assert.equal(next.thread_id,first.thread_id);await completed;
 assert.deepEqual(calls,tools);
 assert.equal(rpcCalls.filter(x=>x.method==='thread/start').length,1);
 assert.equal(rpcCalls.filter(x=>x.method==='thread/resume').length,1);
 assert.equal(rpcCalls.filter(x=>x.method==='turn/start').length,2);
 const restored=JSON.stringify(requests.at(-1).input);
 assert.match(restored,/ORIGINAL_TASK_FIXTURE/);assert.match(restored,/saved-fixture-artifact/);assert.match(restored,/service restarted/);
 assert.equal(events.at(-1).code,'COMPLETED');
});
