import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {CodexRpcClient,filteredCodexEnv} from '../src/codex/rpc.mjs';
import {initialize} from '../src/codex/session.mjs';
import {runtimeConfig} from '../src/codex/config.mjs';

// These are real pinned Codex processes and MCP transport. The only Responses
// endpoint is an auth-free loopback fixture, with an empty isolated CODEX_HOME.
async function fixture(t,{toolText='Synthetic overview',callTool=false}={}) {
  const home=await mkdtemp(join(tmpdir(),'model-options-codex-'));
  const requests=[],toolCalls=[],clients=[];
  const version=JSON.parse(await readFile(new URL('../node_modules/@openai/codex/package.json',import.meta.url),'utf8')).version;
  assert.equal(version,'0.159.2','Update this protocol fixture deliberately when upgrading Codex.');
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/responses') {
      let raw='';for await(const part of req)raw+=part;
      requests.push(JSON.parse(raw));
      const events=callTool&&requests.length===1?[{type:'response.output_item.done',item:{type:'function_call',call_id:'synthetic-overview',namespace:'mcp__agent_task',name:'overview',arguments:'{}'}}]
        :[{type:'response.output_item.done',item:{id:'synthetic-message-'+requests.length,type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic model options fixture completed.'}]}}];
      events.push({type:'response.completed',response:{id:'synthetic-response-'+requests.length,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
      return;
    }
    if(req.url!=='/mcp'||req.headers.authorization!=='Bearer synthetic-local-mcp') {res.writeHead(404);res.end();return;}
    const mcp=new Server({name:'synthetic-model-options',version:'1'},{capabilities:{tools:{}}});
    mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'overview',description:'Read synthetic local overview.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]}));
    mcp.setRequestHandler(CallToolRequestSchema,async request=>{
      toolCalls.push(request.params.name);
      return {content:[{type:'text',text:toolText}]};
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('finish',()=>{void transport.close();void mcp.close();});
    await mcp.connect(transport);await transport.handleRequest(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await Promise.all(clients.map(client=>client.close()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  function client() {
    const value=new CodexRpcClient({command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),cwd:home,
      env:{...filteredCodexEnv(),HOME:home,CODEX_HOME:home,NO_PROXY:'127.0.0.1,localhost',AGENT_TASK_MCP_TOKEN:'synthetic-local-mcp'}});
    clients.push(value);return value;
  }
  function config(modelSettings) {
    return {...runtimeConfig({native:{},tools:['overview']},base+'/mcp',{modelSettings}),model_provider:'synthetic_fixture',model_providers:{synthetic_fixture:{name:'Synthetic auth-free loopback fixture',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}};
  }
  async function turn(client,threadId,summary) {
    let finish,fail;
    const ended=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
    const timer=setTimeout(()=>fail(new Error('Synthetic Codex turn did not finish.')),15000);
    const unsubscribe=client.subscribe(message=>{
      if(message.method==='turn/completed'&&message.params.threadId===threadId)finish(message.params.turn);
      if(message.method==='transport/closed')fail(new Error('Synthetic Codex transport closed.'));
    });
    try {
      await client.request('turn/start',{threadId,input:[{type:'text',text:'Read the synthetic fixture and finish.'}],summary});
      const completed=await ended;assert.equal(completed.status,'completed',JSON.stringify(completed.error));
    }finally {clearTimeout(timer);unsubscribe();}
  }
  return {home,requests,toolCalls,client,config,turn};
}

test('Codex 0.159.2 applies verbosity and summary on start and fresh-process resume with automatic budgets',{timeout:30000},async t=>{
  const f=await fixture(t);
  const cases=[{verbosity:'low',reasoningSummary:'detailed',autoCompactTokenLimit:12000,toolOutputTokenLimit:4000},
    {verbosity:'medium',reasoningSummary:'concise',autoCompactTokenLimit:null,toolOutputTokenLimit:null},
    {verbosity:'medium',reasoningSummary:'none',autoCompactTokenLimit:null,toolOutputTokenLimit:null}];
  let threadId;
  for(const settings of cases) {
    const client=f.client();await initialize(client);
    const config=f.config(settings);
    if(settings.autoCompactTokenLimit===null) {
      assert.equal(Object.hasOwn(config,'model_auto_compact_token_limit'),false);
      assert.equal(Object.hasOwn(config,'tool_output_token_limit'),false);
    }
    const result=await client.request(threadId?'thread/resume':'thread/start',{...(threadId?{threadId,excludeTurns:true}:{ephemeral:false}),model:'gpt-6.1-sol',cwd:f.home,approvalPolicy:'never',sandbox:'read-only',config});
    if(threadId)assert.equal(result.thread.id,threadId);else threadId=result.thread.id;
    await f.turn(client,threadId,settings.reasoningSummary);await client.close();
  }
  assert.equal(f.requests.length,3);
  assert.deepEqual(f.requests.map(request=>request.text?.verbosity),['low','medium','medium']);
  assert.deepEqual(f.requests.map(request=>request.reasoning?.summary),['detailed','concise',undefined]);
  t.diagnostic('Pinned wire: verbosity low → medium → medium; summary detailed → concise → omitted (none); automatic-budget fresh-process resume completed.');
});

test('Codex 0.159.2 truncates a real local MCP overview result to the configured tool output budget',{timeout:30000},async t=>{
  const toolText=Array.from({length:10000},(_,index)=>`synthetic-row-${index}: ordinary local fixture content`).join('\n');
  const f=await fixture(t,{toolText,callTool:true}),client=f.client();await initialize(client);
  const result=await client.request('thread/start',{model:'gpt-6.1-sol',cwd:f.home,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',config:f.config({toolOutputTokenLimit:256})});
  await f.turn(client,result.thread.id,'auto');
  assert.deepEqual(f.toolCalls,['overview']);
  assert.equal(f.requests.length,2);
  const content=f.requests[1].input.find(item=>item.type==='function_call_output'&&item.call_id==='synthetic-overview')?.output;
  assert.ok(Array.isArray(content),'Pinned Codex returns typed tool-output content blocks.');
  const output=content.filter(item=>item.type==='input_text').map(item=>item.text).join('\n');
  // This controlled ASCII fixture is about 1,250 characters at 256 tokens.
  // The normal 10,000-token budget would retain tens of thousands of characters,
  // so this catches losing the custom budget as well as losing truncation.
  assert.ok(output.length<2048,`Expected 256-token output, received ${output.length} of ${toolText.length} characters.`);
  assert.match(output,/truncat/i);
  assert.ok(!output.includes('synthetic-row-5000:'));
  t.diagnostic(`Pinned local MCP output truncated from ${toolText.length} to ${output.length} characters with a 256-token budget.`);
});
