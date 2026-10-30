import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function setup(t){
  const store=new ManagerStore(':memory:'),agent={model:'gpt-6.1-sol',timeoutMs:1000,toolTimeoutMs:1000};
  const configuration=createManagerConfiguration({store,agent}),conversation=store.createConversation('Synthetic self configuration'),other=store.createConversation('Other');
  const operations=createManagerOperations({store,configuration,client:{execute(){throw new Error('No Gateway call expected');}}});
  const server=createServer(createManagementMcpHandler({store,operations,authorize:token=>token==='synthetic-mcp'?conversation.id:null}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'synthetic-model-options',version:'1'});
  t.after(async()=>{await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer synthetic-mcp'}}}));
  return {store,agent,configuration,conversation,other,operations,client};
}
test('management MCP reads and updates only its own future model settings with revision checks',async t=>{
  const {store,conversation,other,client}=await setup(t);
  const old=store.enqueue(conversation.id,'Synthetic active round');store.recordMessageExecution(old.id,{model:'gpt-6.1-sol',verbosity:'medium',reasoningSummary:'concise',autoCompactTokenLimit:null,toolOutputTokenLimit:null});
  const read=await client.callTool({name:'conversation_execution',arguments:{}});assert.ok(!read.isError,JSON.stringify(read));
  assert.equal(read.structuredContent.effective.reasoningSummary,'concise');
  const execution={verbosity:'low',reasoningSummary:'none',autoCompactTokenLimit:32768,toolOutputTokenLimit:4096};
  const updated=await client.callTool({name:'conversation_execution',arguments:{execution,revision:read.structuredContent.revision}});assert.ok(!updated.isError,JSON.stringify(updated));
  assert.deepEqual(store.metadata(conversation.id).execution,execution);assert.deepEqual(store.metadata(other.id).execution,{});
  assert.equal(updated.structuredContent.applies_to,'next_turn');assert.equal(store.message(old.id).execution.verbosity,'medium');
  const stale=await client.callTool({name:'conversation_execution',arguments:{execution:{},revision:read.structuredContent.revision}});assert.equal(stale.isError,true);assert.match(JSON.stringify(stale),/CONVERSATION_EXECUTION_CONFLICT/);
  const foreign=await client.callTool({name:'conversation_execution',arguments:{conversation_id:other.id,execution:{},revision:updated.structuredContent.revision}});assert.equal(foreign.isError,true);
});
test('Manager can independently tune its global defaults and respects supplied revision',async t=>{
  const {agent,client,configuration,operations}=await setup(t);
  const current=configuration.get('manager');
  const updated=await client.callTool({name:'configuration_update',arguments:{scope:'manager',revision:current.revision,patch:{verbosity:'high',reasoningSummary:'auto',autoCompactTokenLimit:65536,toolOutputTokenLimit:8192}}});assert.ok(!updated.isError,JSON.stringify(updated));
  assert.equal(agent.verbosity,'high');assert.equal(agent.toolOutputTokenLimit,8192);
  const conflict=await client.callTool({name:'configuration_update',arguments:{scope:'manager',revision:current.revision,patch:{verbosity:'low'}}});assert.equal(conflict.isError,true);assert.equal(agent.verbosity,'high');
  await assert.rejects(operations.execute('conversation_execution',{}),{code:'CONVERSATION_CONTEXT_REQUIRED'});
});
