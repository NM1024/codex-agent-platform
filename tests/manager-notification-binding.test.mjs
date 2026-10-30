import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';

async function fixture(t,{ordinary=false}={}) {
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-notification-binding-token'});
  const gatewayStore=new RequestStore(':memory:',{registry:app.registry});
  const gateway=new OperationsService({...app,store:gatewayStore,dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})},configuration:app.configuration(gatewayStore)});
  const first=gatewayStore.notifications.saveChannel({name:'Synthetic channel A',provider:'custom',url:'https://example.invalid/a'});
  const second=gatewayStore.notifications.saveChannel({name:'Synthetic channel B',provider:'custom',url:'https://example.invalid/b'});
  const now=Date.parse('2026-10-30T00:00:00Z');
  gateway.schedules.save({name:'Synthetic binding inspection',kind:'inspection',message:'Synthetic inspection',cron:'* * * * *',notification_channels:[first.id]},now);
  await gateway.schedules.tick(now+60000);
  const [{id}]=await gateway.execute('inspection_list');
  const store=new ManagerStore(':memory:');
  const original=store.acceptInspection(id,'Synthetic inspection');
  const mapping={id,conversation_id:original.conversation.id,message_id:original.message.id};
  await gateway.execute('inspection_claim',{id});
  await gateway.execute('inspection_ack',{...mapping,message_status:'queued'});
  store.admitInspection(id,original.conversation.id,original.message.id);
  store.markRunning(original.message.id);
  await gateway.execute('inspection_execution_update',{...mapping,state:'running'});
  const conversation=ordinary?store.createConversation('Synthetic ordinary management'):original.conversation;
  const message=ordinary?store.enqueue(conversation.id,'Change the inspection notification binding'):original.message;
  if(ordinary)store.markRunning(message.id);
  const forwards=[];
  const operations=createManagerOperations({store,models:async()=>[],client:{async execute(...args){forwards.push(args);return gateway.execute(...args);}}});
  const context={conversationId:conversation.id,messageId:message.id};
  const handler=createManagementMcpHandler({store,operations,authorize:token=>token==='synthetic-mcp-token'?conversation.id:undefined,executionContext:token=>token==='synthetic-mcp-token'?context:undefined});
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'synthetic-notification-binding',version:'1'});
  t.after(async()=>{await client.close();await handler.settle();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();gatewayStore.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer synthetic-mcp-token'}}}));
  return {client,operations,forwards,first,second,binding:()=>gatewayStore.notifications.getBinding({kind:'inspection',id}),args:{id,notification_channels:[second.id],notification_revision:1}};
}

test('original running inspection cannot update its own binding through trusted management MCP context',async t=>{
  const {client,forwards,first,binding,args}=await fixture(t);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='send_notification'),'fixture must exercise an active original inspection');
  const result=await client.callTool({name:'inspection_notifications_update',arguments:args});
  assert.equal(result.isError,true);
  const error=JSON.parse(result.content.find(item=>item.type==='text').text).error;
  assert.equal(error.code,'INSPECTION_BINDING_SELF_UPDATE_DENIED');
  assert.deepEqual(forwards,[],'self-binding update must be rejected before Gateway forwarding');
  assert.deepEqual(binding().notification_channels,[first.id]);
  assert.equal(binding().notification_revision,1);
});

test('ordinary management MCP conversation can update an inspection binding',async t=>{
  const {client,forwards,second,binding,args}=await fixture(t,{ordinary:true});
  assert.equal((await client.listTools()).tools.some(tool=>tool.name==='send_notification'),false);
  const result=await client.callTool({name:'inspection_notifications_update',arguments:args});
  assert.ok(!result.isError,JSON.stringify(result));
  assert.deepEqual(forwards,[['inspection_notifications_update',args]]);
  assert.deepEqual(result.structuredContent.notification_channels,[second.id]);
  assert.deepEqual(binding().notification_channels,[second.id]);
  assert.equal(binding().notification_revision,2);
});

test('Admin operation without Agent execution context can update an inspection binding',async t=>{
  const {operations,forwards,second,binding,args}=await fixture(t);
  const result=await operations.execute('inspection_notifications_update',args);
  assert.deepEqual(forwards,[['inspection_notifications_update',args]]);
  assert.deepEqual(result.notification_channels,[second.id]);
  assert.deepEqual(binding().notification_channels,[second.id]);
  assert.equal(binding().notification_revision,2);
});
