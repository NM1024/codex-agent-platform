import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {createTaskApi} from '../src/api.mjs';
import {createMcpHandler} from '../src/mcp/server.mjs';
import {configurePlugin} from './helpers/plugin-connections.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function listen(t,server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return `http://127.0.0.1:${server.address().port}`;}
async function setup(t){
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-internal-token'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());app.configuration(store);
  assert.ok(store.notifications,'notification provider must be assembled with the platform');
  const received=[],url=await listen(t,createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end('{"ok":true}');}));
  const channel=store.notifications.saveChannel({name:'Synthetic notification',provider:'custom',url:url+'/notify',token:'synthetic-receiver-secret'});
  const {revision,updated_at,...definition}=store.plugins.get('content.review');store.plugins.save({...definition,capabilities:{...definition.capabilities,tools:['notification_context','send_notification']}});
  const key=configurePlugin(store,'content.review'),dispatcher={drain:async()=>{},blocked:new Map()},runner={ready:async()=>({ready:true})};
  const operations=new OperationsService({...app,store,dispatcher,runner,configuration:app.configuration(store)});
  const publicUrl=await listen(t,createTaskApi({...app,store,dispatcher,runner}));
  return {...app,store,operations,channel,received,key,publicUrl,headers:{authorization:'Bearer '+key,'content-type':'application/json'}};
}

test('business API binds channels and real task MCP sends native JSON once during execution',async t=>{
  const state=await setup(t),{store,channel,publicUrl,headers,registry,received}=state;
  const response=await fetch(publicUrl+'/v2/tasks',{method:'POST',headers,body:JSON.stringify({type:'content.review',request_id:'synthetic-notify',input:{content:'Synthetic input'},notification_channels:[channel.id]})});assert.equal(response.status,202);
  const accepted=await response.json();assert.deepEqual(accepted.notification_channels,[channel.id]);
  const run=store.claim(accepted.task_id),mcpUrl=await listen(t,createServer(createMcpHandler({store,registry})));
  const client=new Client({name:'synthetic-notification-task',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+run.token}}}));
  const context=await client.callTool({name:'notification_context',arguments:{}});assert.deepEqual(context.structuredContent.notification_channels,[channel.id]);assert.ok(!JSON.stringify(context).includes('synthetic-receiver-secret'));
  const args={notification_key:'synthetic-event',deliveries:[{channel_id:channel.id,body:{text:'Agent authored notification'}}]};
  for(let i=0;i<2;i++){const sent=await client.callTool({name:'send_notification',arguments:args});assert.ok(!sent.isError,JSON.stringify(sent));assert.equal(sent.structuredContent.deliveries[0].status,'accepted');}
  assert.deepEqual(received,[{text:'Agent authored notification'}]);
  const binding=store.notifications.getBinding({kind:'task',id:accepted.task_id});
  const changed=await fetch(publicUrl+`/v2/tasks/${accepted.task_id}/notifications`,{method:'POST',headers,body:JSON.stringify({notification_channels:[],revision:binding.notification_revision})});assert.equal(changed.status,200);
  const denied=await client.callTool({name:'send_notification',arguments:{...args,notification_key:'unbound-event'}});assert.equal(denied.isError,true);assert.equal(received.length,1);
});

test('ungranted plugins and foreign plugin keys cannot bind or edit notification tasks',async t=>{
  const {store,channel,key,publicUrl,headers}=await setup(t);
  const otherKey=configurePlugin(store,'novel.illustrated');
  const denied=await fetch(publicUrl+'/v2/tasks',{method:'POST',headers:{...headers,authorization:'Bearer '+otherKey},body:JSON.stringify({type:'novel.illustrated',request_id:'ungranted',input:{premise:'Synthetic premise',chapters:1},notification_channels:[channel.id]})});assert.equal(denied.status,403);
  const task=store.accept('plugin:content.review',{type:'content.review',request_id:'owned',input:{content:'Synthetic'},notification_channels:[channel.id]});
  const foreign=await fetch(publicUrl+`/v2/tasks/${task.task_id}/notifications`,{headers:{authorization:'Bearer '+otherKey}});assert.equal(foreign.status,404);
  const own=await fetch(publicUrl+`/v2/tasks/${task.task_id}/notifications`,{headers:{authorization:'Bearer '+key}});assert.equal(own.status,200);assert.equal((await own.json()).available_channels,undefined);
});

test('scheduled business and inspection executions copy bindings and unavailable channels do not block work',async t=>{
  const {store,operations,channel}=await setup(t),now=Date.parse('2026-10-30T00:00:00Z');
  const taskPlan=operations.schedules.save({name:'Synthetic business',kind:'task',type:'content.review',input:{content:'Synthetic'},cron:'* * * * *',notification_channels:[channel.id]},now);
  const inspectionPlan=operations.schedules.save({name:'Synthetic inspection',kind:'inspection',message:'Notify only if the synthetic condition holds',cron:'* * * * *',notification_channels:[channel.id]},now);
  store.notifications.setChannelEnabled(channel.id,false,{revision:channel.revision});
  await operations.schedules.tick(now+60000);
  assert.equal(operations.schedules.get(taskPlan.id).blocked_reason,null);
  const task=store.db.prepare("SELECT task_id FROM agent_requests WHERE request_id LIKE 'schedule:%'").get();assert.deepEqual(store.get(task.task_id).notification_channels,[channel.id]);
  const inspection=(await operations.execute('inspection_list'))[0];assert.deepEqual(store.notifications.getBinding({kind:'inspection',id:inspection.id}).notification_channels,[channel.id]);
  const before=operations.schedules.get(inspectionPlan.id),binding=store.notifications.getBinding({kind:'schedule',id:inspectionPlan.id});
  await operations.execute('schedule_notifications_update',{id:inspectionPlan.id,notification_channels:[],notification_revision:binding.notification_revision});
  assert.equal(operations.schedules.get(inspectionPlan.id).next_run_at,before.next_run_at);
  assert.deepEqual(store.notifications.getBinding({kind:'inspection',id:inspection.id}).notification_channels,[channel.id]);
});

test('inspection sends require exact acknowledged original message and active lifecycle',async t=>{
  const {store,operations,channel,received}=await setup(t),now=Date.parse('2026-10-30T00:00:00Z');
  operations.schedules.save({name:'Synthetic inspection',kind:'inspection',message:'Synthetic task',cron:'* * * * *',notification_channels:[channel.id]},now);await operations.schedules.tick(now+60000);
  const {id}=(await operations.execute('inspection_list'))[0],conversation_id=randomUUID(),message_id=randomUUID();
  await operations.execute('inspection_claim',{id});await operations.execute('inspection_ack',{id,conversation_id,message_id,message_status:'queued'});
  const args={notification_key:'inspection-event',deliveries:[{channel_id:channel.id,body:{text:'Synthetic inspection notice'}}]},scope={id,conversation_id,message_id};
  await assert.rejects(operations.execute('inspection_notification',{...scope,action:'send',args}),{code:'INSPECTION_NOT_RUNNING'});
  await operations.execute('inspection_execution_update',{...scope,state:'running'});
  await assert.rejects(operations.execute('inspection_notification',{...scope,message_id:randomUUID(),action:'send',args}),{code:'INSPECTION_SCOPE_DENIED'});
  const sent=await operations.execute('inspection_notification',{...scope,action:'send',args});assert.equal(sent.status,'accepted');assert.equal(received.length,1);
  await operations.execute('inspection_execution_update',{...scope,state:'completed'});
  await assert.rejects(operations.execute('inspection_notification',{...scope,action:'send',args:{...args,notification_key:'late-event'}}),{code:'INSPECTION_NOT_RUNNING'});
  await operations.execute('inspection_notification_cleanup',{id,conversation_id});assert.deepEqual(store.notifications.history({kind:'inspection',id}).items,[]);
});

test('explicit retry can inherit, replace or clear invalid historical notification channels',async t=>{
  const {store,channel}=await setup(t),task=store.accept('synthetic',{type:'content.review',request_id:'retry-notify',input:{content:'Synthetic'},notification_channels:[channel.id]});store.fail(store.claim(task.task_id).run_id,'SYNTHETIC_FAILURE');
  store.notifications.deleteChannel(channel.id,{revision:channel.revision});
  assert.throws(()=>store.retry(task.task_id),{code:'NOTIFICATION_CHANNEL_UNAVAILABLE'});
  const retried=store.retry(task.task_id,{notification_channels:[]});assert.deepEqual(retried.notification_channels,[]);assert.equal(retried.retry_of,task.task_id);
});

test('restarting schedule storage keeps original active inspections outside terminal retention',async t=>{
  const {operations,store,channel}=await setup(t),now=Date.parse('2026-10-30T00:00:00Z');
  operations.schedules.save({name:'Synthetic running inspection',kind:'inspection',message:'Synthetic task',cron:'* * * * *',notification_channels:[channel.id]},now);
  await operations.schedules.tick(now+60000);
  const {id}=(await operations.execute('inspection_list'))[0],conversation_id=randomUUID(),message_id=randomUUID();
  await operations.execute('inspection_claim',{id});await operations.execute('inspection_ack',{id,conversation_id,message_id,message_status:'queued'});
  await operations.execute('inspection_execution_update',{id,conversation_id,message_id,state:'running'});
  const restarted=new operations.schedules.constructor(store);
  assert.equal(store.db.prepare('SELECT finished_at FROM platform_inspections WHERE id=?').get(id).finished_at,null);
  assert.equal(restarted.pruneInspectionHistory({cutoff:Date.now()+1000}),0);
  assert.equal(store.db.prepare('SELECT execution_state FROM platform_inspections WHERE id=?').get(id).execution_state,'running');
  await operations.execute('inspection_execution_update',{id,conversation_id,message_id,state:'completed'});
  assert.equal(restarted.pruneInspectionHistory({cutoff:Date.now()+1000}),1);
  assert.deepEqual(store.notifications.getBinding({kind:'inspection',id}).notification_channels,[]);
});

test('schedule execution notification history preserves each execution kind after editing the plan kind',async t=>{
  const {operations,channel}=await setup(t),now=Date.parse('2026-10-30T00:00:00Z');
  const plan=operations.schedules.save({name:'Synthetic editable plan',kind:'task',type:'content.review',input:{content:'Synthetic'},cron:'* * * * *',notification_channels:[channel.id]},now);
  await operations.schedules.tick(now+60000);
  operations.schedules.save({id:plan.id,name:plan.name,kind:'inspection',message:'Synthetic inspection',cron:'* * * * *'},now+60000);
  await operations.schedules.tick(now+120000);
  assert.deepEqual(operations.notifications.schedule(plan.id).executions.map(row=>row.kind).sort(),['inspection','task']);
});

test('plugin defaults bind concrete same-provider channels only to new tasks and explicit selections override them',async t=>{
 const {store,operations,channel}=await setup(t),type='content.review';
 const a=store.notifications.saveChannel({name:'Synthetic Feishu operations',provider:'feishu',url:'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-operations'});
 const b=store.notifications.saveChannel({name:'Synthetic Feishu developers',provider:'feishu',url:'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-developers'});
 const get=()=>operations.execute('plugin_notifications_get',{type});const set=(ids,revision)=>operations.execute('plugin_notifications_update',{type,notification_channels:ids,notification_revision:revision});
 const empty=await get();assert.deepEqual(empty.notification_channels,[]);const first=await set([a.id,b.id],empty.notification_revision);assert.deepEqual(first.notification_channels,[a.id,b.id]);
 const inherited=store.accept('default',{type,request_id:'synthetic-inherited',input:{content:'Synthetic inherited'}});assert.deepEqual(inherited.notification_channels,[a.id,b.id]);
 const none=store.accept('default',{type,request_id:'synthetic-none',input:{content:'Synthetic none'},notification_channels:[]});assert.deepEqual(none.notification_channels,[]);
 const explicit=store.accept('default',{type,request_id:'synthetic-explicit',input:{content:'Synthetic explicit'},notification_channels:[channel.id]});assert.deepEqual(explicit.notification_channels,[channel.id]);
 const edited=await set([b.id],first.notification_revision);assert.deepEqual(store.get(inherited.task_id).notification_channels,[a.id,b.id]);
 assert.deepEqual(store.accept('default',{type,request_id:'synthetic-after-change',input:{content:'Synthetic after change'}}).notification_channels,[b.id]);await assert.rejects(set([a.id],first.notification_revision),{code:'NOTIFICATION_BINDING_REVISION_CONFLICT'});
 const run=store.claim(none.task_id);store.fail(run.run_id,'SYNTHETIC');assert.deepEqual(store.retry(none.task_id).notification_channels,[],'retry preserves the original empty binding');
 const now=Date.parse('2026-10-30T00:00:00Z'),plan=operations.schedules.save({name:'Synthetic empty plan',kind:'task',type,input:{content:'Synthetic scheduled'},cron:'* * * * *',notification_channels:[]},now);await operations.schedules.tick(now+60000);const [{id:taskId}]=operations.notifications.schedule(plan.id).executions;assert.deepEqual(store.get(taskId).notification_channels,[],'empty schedule binding never falls back to plugin defaults');
 assert.equal(edited.notification_revision,first.notification_revision+1);
});
test('plugin defaults require notification capabilities and reject channel types as destination IDs',async t=>{
 const {operations,channel}=await setup(t);await assert.rejects(operations.execute('plugin_notifications_update',{type:'novel.illustrated',notification_channels:[channel.id],notification_revision:0}),{code:'NOTIFICATION_CAPABILITY_REQUIRED'});
 await assert.rejects(operations.execute('plugin_notifications_update',{type:'content.review',notification_channels:['feishu'],notification_revision:0}),{code:'INVALID_MANAGEMENT_INPUT'});
});
