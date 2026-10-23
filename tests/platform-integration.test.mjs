import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { Dispatcher } from '../src/core/dispatcher.mjs';
import { capabilityCatalog } from '../src/capabilities/catalog.mjs';
import { AgentRuntime } from '../src/runtime/codex.mjs';
import { RuntimeClient } from '../src/runtime/client.mjs';
import { createRuntimeServer } from '../src/runtime/server.mjs';
import { createTaskApi,createPrivateApi } from '../src/api.mjs';

test('HTTP JSON plugin snapshot crosses a separate Runner, saves real artifacts through MCP and corrects final output in one initial turn',{timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'plugin-integration-')),servers=[],rpcCalls=[];
  const gatewayRegistry=new BusinessRegistry([],capabilityCatalog({workspace:root})),runnerRegistry=new BusinessRegistry([],capabilityCatalog({workspace:root}));
  const store=new RequestStore(':memory:',{registry:gatewayRegistry});let dispatcher,runtime,release,finish,reject;
  const gate=new Promise(r=>release=r),done=new Promise((r,j)=>{finish=r;reject=j;});
  const definition=JSON.parse(await readFile(new URL('../src/plugins/examples/novel.illustrated.json',import.meta.url),'utf8'));
  definition.instructions='ORIGINAL_CONFIGURATION_FIXTURE '+definition.instructions;
  store.plugins.save(definition);
  runtime=new AgentRuntime({workspace:root,codexHome:join(root,'codex'),taskTimeoutMs:5000,closingTimeoutMs:1000,
    onExit:(id,code,details)=>dispatcher.event(id,code,details),createClient:({env})=>{
      const listeners=new Set();return {notify(){},async close(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(method,params){
        rpcCalls.push({method,params});if(method==='thread/start')return {thread:{id:'story-root'}};
        if(method==='turn/start') {
          setImmediate(async()=>{
            const client=new Client({name:'story-fixture',version:'1'});
            try {
              const state=[...runtime.active.values()][0],source=join(state.workDir,'native-fixture.png');
              await sharp({create:{width:160,height:90,channels:3,background:'#9eafbd'}}).png().toFile(source);
              await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcpUrl),{requestInit:{headers:{authorization:`Bearer ${env.AGENT_TASK_MCP_TOKEN}`}}}));
              const tools=(await client.listTools()).tools.map(tool=>tool.name);assert.deepEqual(tools,['register_image','write_text_artifact','read_artifact','complete_task']);
              const image=await client.callTool({name:'register_image',arguments:{source_path:source,format:'jpeg',width:640,height:360}});assert.ok(!image.isError,JSON.stringify(image));
              const text=await client.callTool({name:'write_text_artifact',arguments:{filename:'story.md',text:'这是一篇配置业务创作的故事。'}});assert.ok(!text.isError,JSON.stringify(text));
              const invalid=await client.callTool({name:'complete_task',arguments:{result:{wrong:'不符合契约'}}});assert.equal(invalid.isError,true);
              const result={title:'故事',chapters:[{title:'第一章',text:'这是一篇配置业务创作的故事。',artifact_id:image.structuredContent.artifact_id}],text_artifact_id:text.structuredContent.artifact_id};
              const receipt=await client.callTool({name:'complete_task',arguments:{result}});assert.ok(!receipt.isError,JSON.stringify(receipt));
              for(const listener of listeners)listener({method:'turn/completed',params:{threadId:'story-root',turn:{id:'story-turn',status:'completed'}}});finish(result);
            }catch(error){reject(error);}finally{await client.close();}
          });return {turn:{id:'story-turn'}};
        }return {};
      }};
    }});
  const config={ingressToken:'local-public',runnerToken:'local-private',clientId:'default',workspace:root,concurrency:1,taskTimeoutMs:5000};
  async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
  const runner=new RuntimeClient({url:await listen(createRuntimeServer({runtime,registry:runnerRegistry,config,probe:async()=>{await gate;return {ready:true,imageGeneration:true};}})),token:config.runnerToken});
  store.context={workspace:root,process:body=>runner.process(body)};dispatcher=new Dispatcher({store,registry:gatewayRegistry,runner,config});
  runtime.mcpUrl=await listen(createPrivateApi({store,registry:gatewayRegistry,runner,dispatcher,config}))+'/mcp';
  const url=await listen(createTaskApi({store,registry:gatewayRegistry,dispatcher,runner,config}));
  t.after(async()=>{release();await dispatcher.stop();await runtime.stop();for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}store.close();await rm(root,{recursive:true,force:true});});
  const accepted=await(await fetch(url+'/v2/tasks',{method:'POST',headers:{authorization:'Bearer local-public','content-type':'application/json'},body:JSON.stringify({type:definition.type,request_id:'same',input:{premise:'海'}})})).json();
  store.plugins.save({...definition,instructions:'NEW_CONFIGURATION',result_schema:{type:'string'},enabled:false});release();
  const result=await done;assert.deepEqual(store.get(accepted.task_id).result,result);
  assert.ok(store.get(accepted.task_id).errors.some(error=>error.code==='INVALID_RESULT'));
  assert.equal(rpcCalls.filter(call=>call.method==='turn/start').length,1);assert.equal(rpcCalls.filter(call=>call.method==='thread/start').length,1);
  assert.match(rpcCalls.find(call=>call.method==='turn/start').params.input[0].text,/ORIGINAL_CONFIGURATION_FIXTURE/);
  const image=await fetch(`${url}/v2/tasks/${accepted.task_id}/artifacts/${result.chapters[0].artifact_id}`,{headers:{authorization:'Bearer local-public'}});
  assert.equal(image.status,200);assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width,640);
});
