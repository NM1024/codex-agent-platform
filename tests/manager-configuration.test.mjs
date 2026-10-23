import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';

test('manager configuration and prompt apply locally even when Gateway is unavailable',async t=>{
  const configModule=await import('../src/manager/configuration.mjs').catch(()=>({}));
  const router=await import('../src/manager/operations.mjs').catch(()=>({}));
  assert.equal(typeof configModule.createManagerConfiguration,'function');assert.equal(typeof router.createManagerOperations,'function');
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const agent={model:'bootstrap-model',timeoutMs:10000,toolTimeoutMs:2000};
  const configuration=configModule.createManagerConfiguration({store,agent});
  const operations=router.createManagerOperations({store,configuration,metrics:{sample:async()=>({})},client:{execute:async()=>{throw new Error('offline');}}});
  const saved=await operations.execute('configuration_update',{scope:'manager',patch:{model:'manager-model',instructions:'只调查当前项目',inspectionIntervalMs:2000}});
  assert.equal(saved.values.model,'manager-model');assert.equal(agent.model,'manager-model');assert.equal(agent.instructions,'只调查当前项目');
  const available=await operations.execute('configuration_list');assert.equal(available.gateway_unavailable,true);assert.ok(available.groups.some(item=>item.scope==='manager'));
  await assert.rejects(operations.execute('configuration_update',{scope:'manager',patch:{model:''}}),error=>error.code==='INVALID_CONFIGURATION');assert.equal(agent.model,'manager-model');
});
test('management MCP can configure its agent and reset Admin password without storing the password in actions',async t=>{
  const [{createManagerConfiguration},{createManagerOperations},{AdminAuth},{createManagementMcpHandler},{createServer},{Client},{StreamableHTTPClientTransport}]=await Promise.all([
    import('../src/manager/configuration.mjs'),import('../src/manager/operations.mjs'),import('../src/manager/auth.mjs'),import('../src/manager/mcp.mjs'),import('node:http'),import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const auth=new AdminAuth(store.db);await auth.initialize('initial-test-password');const session=await auth.login('initial-test-password');
  const agent={model:'gpt-6.1-sol',timeoutMs:10000,toolTimeoutMs:1000},configuration=createManagerConfiguration({store,agent,auth}),conversation=store.createConversation('配置');
  const operations=createManagerOperations({store,configuration,auth,metrics:{sample:async()=>({})},client:{execute:async()=>({groups:[],bootstrap:[]})}});
  const server=createServer(createManagementMcpHandler({store,operations,authorize:token=>token==='mcp-test'?conversation.id:null}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'configuration-test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer mcp-test'}}}));
  const updated=await client.callTool({name:'configuration_update',arguments:{scope:'manager',patch:{model:'agent-selected-model'}}});assert.ok(!updated.isError,JSON.stringify(updated));assert.equal(agent.model,'agent-selected-model');
  const reset=await client.callTool({name:'admin_password_set',arguments:{password:'new-admin-test-password'}});assert.ok(!reset.isError,JSON.stringify(reset));assert.equal(auth.authorize({headers:{cookie:'agent_admin='+session.token}}),false);
  assert.ok(await auth.login('new-admin-test-password'));assert.ok(!JSON.stringify(store.actions(conversation.id)).includes('new-admin-test-password'));
});
