import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {createPrivateApi} from '../src/api.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {AdminAuth} from '../src/manager/auth.mjs';
import {OperationsClient} from '../src/manager/client.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';
import {configurePlugin} from './helpers/plugin-connections.mjs';

const secrets={token:'synthetic-notification-bearer',header:'synthetic-private-header',signing:'synthetic-signing-secret',path:'synthetic-webhook-path-secret',query:'synthetic-query-secret'};
async function listen(t,server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return `http://127.0.0.1:${server.address().port}`;}
function safe(value,privateUrl){const serialized=JSON.stringify(value);for(const secret of [...Object.values(secrets),privateUrl].filter(Boolean))assert.ok(!serialized.includes(secret),'response leaked a notification credential');}
async function setup(t){
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-notification-internal'}),store=new RequestStore(':memory:',{registry:app.registry}),managerStore=new ManagerStore(':memory:');t.after(()=>{store.close();managerStore.close();});
  const configuration=app.configuration(store),{revision,updated_at,...definition}=store.plugins.get('content.review');
  store.plugins.save({...definition,capabilities:{...definition.capabilities,tools:['notification_context','send_notification']}});configurePlugin(store,'content.review');
  const dispatcher={drain:async()=>{},completed:async()=>{},blocked:new Map()},runner={ready:async()=>({ready:true})},gatewayOperations=new OperationsService({...app,store,dispatcher,runner,configuration});
  const gatewayUrl=await listen(t,createPrivateApi({...app,store,dispatcher,runner,operations:gatewayOperations}));
  const client=new OperationsClient({url:gatewayUrl,token:app.config.runnerToken}),auth=new AdminAuth(managerStore.db);await auth.initialize('synthetic-admin-password');
  const agent={model:'gpt-6.1-sol',timeoutMs:10000,toolTimeoutMs:1000,concurrency:2},managerConfiguration=createManagerConfiguration({store:managerStore,agent,auth}),metrics={sample:async()=>({})};
  const operations=createManagerOperations({client,store:managerStore,metrics,configuration:managerConfiguration,auth,models:async()=>[]});
  const base=await listen(t,createManagerServer({store:managerStore,agent,operations,auth,metrics})),received=[];
  const sink=await listen(t,createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push({url:req.url,headers:req.headers,body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,echo:secrets.token,private:secrets.header,target:req.url}));}));
  const privateUrl=sink+'/'+secrets.path+'?key='+secrets.query;
  const login=await fetch(base+'/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-admin-password'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=async(path,{method='GET',body,authenticated=true,origin=base}={})=>{
    const response=await fetch(base+'/admin/api'+path,{method,headers:{...(authenticated?{cookie}:{}),'content-type':'application/json',...(origin?{origin}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  };
  const createChannel=async(name='Synthetic notification')=>{
    const response=await request('/notification-channels',{method:'POST',body:{channel:{name,provider:'custom',url:privateUrl,token:secrets.token,headers:{'x-synthetic-auth':secrets.header},signingSecret:secrets.signing}}});
    assert.equal(response.status,200,JSON.stringify(response.value));safe(response.value,privateUrl);return response.value;
  };
  return {store,gatewayOperations,base,gatewayUrl,received,privateUrl,request,createChannel};
}

test('Admin notification HTTP returns safe metadata and preserves omitted private fields during revision-checked edits',async t=>{
  const {request,createChannel,received,privateUrl}=await setup(t),channel=await createChannel();
  assert.deepEqual(channel.configured,{url:true,token:true,headers:true,signingSecret:true});assert.equal(received.length,0);
  const listed=await request('/notification-channels');assert.equal(listed.status,200);assert.equal(listed.value.items[0].id,channel.id);safe(listed.value,privateUrl);
  const managementList=await request('/operations',{method:'POST',body:{action:'notification_channels',args:{}}});assert.equal(managementList.status,200);safe(managementList.value,privateUrl);
  for(const field of ['url','token','headers','signingSecret'])assert.equal(Object.hasOwn(listed.value.items[0],field),false);
  const edited=await request('/notification-channels',{method:'POST',body:{channel:{id:channel.id,name:'Renamed synthetic notification',description:'Safe purpose'},revision:channel.revision}});
  assert.equal(edited.status,200);assert.equal(edited.value.revision,channel.revision+1);assert.deepEqual(edited.value.configured,channel.configured);safe(edited.value,privateUrl);assert.equal(received.length,0);
  const stale=await request('/notification-channels',{method:'POST',body:{channel:{id:channel.id,name:'Stale write'},revision:channel.revision}});assert.equal(stale.status,409);assert.equal(stale.value.error.code,'NOTIFICATION_CHANNEL_REVISION_CONFLICT');safe(stale.value,privateUrl);
  const sent=await request(`/notification-channels/${channel.id}/test`,{method:'POST',body:{}});assert.equal(sent.status,200);assert.equal(sent.value.deliveries[0].status,'accepted');safe(sent.value,privateUrl);
  assert.equal(received.length,1);assert.equal(received[0].headers.authorization,'Bearer '+secrets.token);assert.equal(received[0].headers['x-synthetic-auth'],secrets.header);assert.equal(received[0].url,'/'+secrets.path+'?key='+secrets.query);
  const cleared=await request('/notification-channels',{method:'POST',body:{channel:{id:channel.id,token:'',headers:{},signingSecret:''},revision:edited.value.revision}});assert.equal(cleared.status,200);assert.deepEqual(cleared.value.configured,{url:true,token:false,headers:false,signingSecret:false});
});

test('Admin notification HTTP denies unauthenticated and cross-origin writes without reaching the saved receiver',async t=>{
  const {request,createChannel,received,gatewayUrl}=await setup(t),channel=await createChannel();
  const writes=[['/notification-channels',{channel:{name:'Denied channel',provider:'custom',url:'https://notify.example.test/hook'}}],['/notification-channels/'+channel.id+'/enable',{enabled:false,revision:channel.revision}],['/notification-channels/'+channel.id+'/test',{}]];
  for(const [path,body] of writes){assert.equal((await request(path,{method:'POST',body,authenticated:false})).status,401);assert.equal((await request(path,{method:'POST',body,origin:'https://foreign.example.test'})).status,403);}
  assert.equal((await request('/notification-channels',{authenticated:false})).status,401);
  assert.equal((await request('/notification-channels/'+channel.id,{method:'DELETE',body:{revision:channel.revision},authenticated:false})).status,401);
  assert.equal((await request('/notification-channels/'+channel.id,{method:'DELETE',body:{revision:channel.revision},origin:'https://foreign.example.test'})).status,403);
  assert.equal((await fetch(gatewayUrl+'/internal/notification-channels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'list'})})).status,401);
  const listed=await request('/notification-channels');assert.equal(listed.value.items.length,1);assert.equal(listed.value.items[0].enabled,true);assert.equal(received.length,0);
});

test('explicit Admin test route alone sends a fixed synthetic message under a separate test owner',async t=>{
  const {store,request,createChannel,received}=await setup(t),channel=await createChannel();
  const task=store.accept('synthetic-admin-api',{type:'content.review',request_id:'test-isolation',input:{content:'Synthetic'},notification_channels:[channel.id]});
  assert.equal((await request(`/notification-channels/${channel.id}/test`)).status,404);
  const generic=await request('/operations',{method:'POST',body:{action:'notification_channel_test',args:{id:channel.id}}});assert.equal(generic.status,400);assert.equal(received.length,0);
  assert.equal((await request(`/tasks/${task.task_id}/notifications`)).status,200);assert.equal(received.length,0);
  const testResult=await request(`/notification-channels/${channel.id}/test`,{method:'POST',body:{body:{text:'Caller must not control test text'},task_id:task.task_id}});
  assert.equal(testResult.status,200);assert.equal(testResult.value.status,'accepted');assert.deepEqual(received.map(item=>item.body),[{text:'Synthetic notification test'}]);
  const taskBinding=await request(`/tasks/${task.task_id}/notifications`);assert.deepEqual(taskBinding.value.history.items,[]);
  const owner=store.db.prepare('SELECT owner_kind,owner_id FROM notification_batches WHERE id=?').get(testResult.value.batch_id);assert.equal(owner.owner_kind,'test');assert.notEqual(owner.owner_id,task.task_id);
});

test('Admin task notification binding HTTP enforces revisions, identity and terminal immutability',async t=>{
  const {store,request,createChannel,privateUrl}=await setup(t),channel=await createChannel();
  const task=store.accept('synthetic-admin-api',{type:'content.review',request_id:'binding-revisions',input:{content:'Synthetic'},notification_channels:[channel.id]}),path=`/tasks/${task.task_id}/notifications`;
  const original=await request(path);assert.equal(original.status,200);assert.deepEqual(original.value.notification_channels,[channel.id]);assert.equal(original.value.available_channels[0].id,channel.id);safe(original.value,privateUrl);
  assert.equal((await request(path,{authenticated:false})).status,401);
  assert.equal((await request(path,{method:'POST',body:{notification_channels:[],revision:original.value.notification_revision},origin:'https://foreign.example.test'})).status,403);
  assert.equal((await request(path,{method:'POST',body:{notification_channels:[]}})).status,400);
  const changed=await request(path,{method:'POST',body:{notification_channels:[],revision:original.value.notification_revision}});assert.equal(changed.status,200);assert.deepEqual(changed.value.notification_channels,[]);
  const stale=await request(path,{method:'POST',body:{notification_channels:[channel.id],revision:original.value.notification_revision}});assert.equal(stale.status,409);assert.equal(stale.value.error.code,'NOTIFICATION_BINDING_REVISION_CONFLICT');
  assert.equal((await request(path,{method:'POST',body:{notification_channels:[],revision:changed.value.notification_revision,task_id:randomUUID()}})).status,400);
  assert.equal((await request(`/tasks/${randomUUID()}/notifications`)).status,404);
  store.fail(store.claim(task.task_id).run_id,'SYNTHETIC_ENDED');
  const terminal=await request(path);assert.equal(terminal.status,200);assert.deepEqual(terminal.value.notification_channels,[]);
  const denied=await request(path,{method:'POST',body:{notification_channels:[channel.id],revision:terminal.value.notification_revision}});assert.equal(denied.status,409);assert.equal(denied.value.error.code,'TASK_NOT_EDITABLE');
});

test('Admin schedule and inspection notification bindings are independent and ended inspections reject edits',async t=>{
  const {gatewayOperations,request,createChannel}=await setup(t),channel=await createChannel(),now=Date.parse('2026-10-30T00:00:00Z');
  const plan=gatewayOperations.schedules.save({name:'Synthetic Admin inspection',kind:'inspection',message:'Synthetic inspection',cron:'* * * * *',notification_channels:[channel.id]},now);await gatewayOperations.schedules.tick(now+60000);
  const inspection=(await gatewayOperations.execute('inspection_list'))[0],schedulePath=`/schedules/${plan.id}/notifications`,inspectionPath=`/inspections/${inspection.id}/notifications`;
  const schedule=await request(schedulePath),original=await request(inspectionPath);assert.equal(schedule.status,200);assert.equal(original.status,200);assert.deepEqual(original.value.notification_channels,[channel.id]);
  const nextRunBefore=gatewayOperations.schedules.get(plan.id).next_run_at;
  const changed=await request(schedulePath,{method:'POST',body:{notification_channels:[],revision:schedule.value.notification_revision}});assert.equal(changed.status,200);assert.equal(gatewayOperations.schedules.get(plan.id).next_run_at,nextRunBefore);
  assert.deepEqual((await request(inspectionPath)).value.notification_channels,[channel.id]);
  assert.equal((await request(schedulePath,{method:'POST',body:{notification_channels:[channel.id],revision:schedule.value.notification_revision}})).status,409);
  const changedInspection=await request(inspectionPath,{method:'POST',body:{notification_channels:[],revision:original.value.notification_revision}});assert.equal(changedInspection.status,200);
  assert.equal((await request(inspectionPath,{method:'POST',body:{notification_channels:[channel.id],revision:original.value.notification_revision}})).status,409);
  const scope={id:inspection.id,conversation_id:randomUUID(),message_id:randomUUID()};await gatewayOperations.execute('inspection_claim',{id:inspection.id});await gatewayOperations.execute('inspection_ack',{...scope,message_status:'queued'});await gatewayOperations.execute('inspection_execution_update',{...scope,state:'completed'});
  const denied=await request(inspectionPath,{method:'POST',body:{notification_channels:[channel.id],revision:changedInspection.value.notification_revision}});assert.equal(denied.status,409);assert.equal(denied.value.error.code,'INSPECTION_NOT_EDITABLE');assert.equal((await request(inspectionPath)).status,200);
});
