import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {createTaskApi} from '../src/api.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const definition={type:'synthetic.nested',name:'Synthetic nested plugin',description:'Synthetic contract',enabled:false,input_schema:{type:'object',properties:{customer:{$ref:'#/$defs/customer'},tags:{type:'array',items:{type:'string',enum:['synthetic']},minItems:1}},required:['customer'],additionalProperties:false,$defs:{customer:{type:'object',description:'Customer details',properties:{name:{type:'string',description:'Customer name',minLength:3},age:{type:'integer',minimum:18}},required:['name'],additionalProperties:false}}},result_schema:{type:'object',properties:{accepted:{type:'boolean',description:'Business conclusion'}},required:['accepted'],additionalProperties:false},instructions:'Synthetic instructions not included in public integration docs.',capabilities:{tools:[]},delivery:{mode:'none'}};
const humanConnection={entryAddress:'https://gateway.example.invalid/hooks/synthetic',entryPath:'/hooks/synthetic',ready:true,entryKeyConfigured:true,callbackUrl:'https://receiver.invalid/result?api_key=SYNTHETIC_QUERY_SECRET',callbackToken:'SYNTHETIC_TOKEN_SECRET',entryKey:'SYNTHETIC_ENTRY_SECRET',callbackTokenConfigured:true,revision:4};

test('integration docs derive nested parameters and valid examples without copying human secrets',async()=>{
  const {buildPluginIntegration}=await import('../src/manager/plugin-integration.mjs');
  const doc=buildPluginIntegration({...definition,revision:3},humanConnection,{locale:'en'});
  assert.equal(doc.type,definition.type);assert.equal(doc.revision,3);assert.equal(doc.connectionRevision,4);assert.equal(doc.locale,'en');
  assert.deepEqual(doc.sections.map(section=>section.key),['overview','request','response','callback','errors']);
  assert.match(doc.markdown,/customer\.name/);assert.match(doc.markdown,/Customer name/);assert.match(doc.markdown,/minLength/);assert.match(doc.markdown,/202/);assert.match(doc.markdown,/Authorization: Bearer/);
  assert.match(doc.markdown,/https:\/\/gateway\.example\.invalid\/hooks\/synthetic/);assert.match(doc.markdown,/GET.*\/v2\/tasks/);
  assert.match(doc.sections[0].markdown,/\| Purpose \| Method \| URL \|\n\| --- \| --- \| --- \|\n/);
  assert.match(doc.sections.at(-1).markdown,/\| HTTP \| code \| Meaning \|\n\| --- \| --- \| --- \|\n/);
  assert.equal(new Ajv({strict:true}).compile(definition.input_schema)(doc.examples.input),true);
  assert.equal(new Ajv({strict:true}).compile(definition.result_schema)(doc.examples.result),true);
  for(const privateValue of ['SYNTHETIC_QUERY_SECRET','SYNTHETIC_TOKEN_SECRET','SYNTHETIC_ENTRY_SECRET','receiver.invalid','Synthetic instructions not included'])assert.ok(!JSON.stringify(doc).includes(privateValue),privateValue);
});

test('relative entry paths never infer a Gateway domain from Admin and incomplete setup still has docs',async()=>{
  const {buildPluginIntegration}=await import('../src/manager/plugin-integration.mjs');
  const doc=buildPluginIntegration(definition,{entryAddress:'/hooks/local/plugin',entryPath:'/hooks/local/plugin',ready:false,entryKeyConfigured:false,callbackUrl:null,callbackTokenConfigured:false},{locale:'zh-CN'});
  assert.equal(doc.ready,false);assert.match(doc.markdown,/https:\/\/<gateway-host>\/hooks\/local\/plugin/);assert.match(doc.markdown,/配置接入/);assert.match(doc.markdown,/request_id/);assert.match(doc.markdown,/独立|去重/);assert.match(doc.markdown,/2xx/);assert.match(doc.markdown,/unknown/);
});

test('unsupported schemas retain authoritative source and never invent a schema-valid example',async()=>{
  const {buildPluginIntegration}=await import('../src/manager/plugin-integration.mjs');
  const impossible={...definition,input_schema:{type:'string',pattern:'^ONLY-THIS-VALUE$'},result_schema:{type:'object',properties:{child:{$ref:'#'}},required:['child'],additionalProperties:false}};
  const doc=buildPluginIntegration(impossible,humanConnection,{locale:'en'});
  assert.equal(doc.examples.input,null);assert.equal(doc.examples.result,null);assert.match(doc.markdown,/ONLY-THIS-VALUE/);assert.match(doc.markdown,/\$ref/);assert.match(doc.markdown,/unavailable|cannot generate/i);
});

test('reference sibling annotations and required fields stay visible and participate in examples',async()=>{
  const {buildPluginIntegration}=await import('../src/manager/plugin-integration.mjs');
  const schema=structuredClone(definition.input_schema);
  delete schema.$defs.customer.additionalProperties;
  schema.properties.customer={$ref:'#/$defs/customer',description:'Billing customer annotation',type:'object',properties:{enabled:{type:'boolean',description:'Billing enabled'}},required:['enabled']};
  const doc=buildPluginIntegration({...definition,input_schema:schema},humanConnection,{locale:'en'});
  assert.match(doc.markdown,/Billing customer annotation/);assert.match(doc.markdown,/customer\.enabled/);assert.match(doc.markdown,/Billing enabled/);assert.match(doc.markdown,/customer\.name/);
  assert.equal(doc.exampleAvailability.input,true);assert.equal(new Ajv({strict:true}).compile(schema)(doc.examples.input),true);
});

async function setup(t) {
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-internal-token'}),business=new RequestStore(':memory:',{registry:app.registry}),manager=new ManagerStore(':memory:');
  const dispatcher={drain:async()=>{},blocked:new Map()},runner={ready:async()=>({ready:true})};
  const operations=new OperationsService({...app,store:business,config:{concurrency:5},runner,dispatcher});let calls=0;
  const server=createManagerServer({store:manager,agent:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human-session'},metrics:{},operations:{execute:(...args)=>{calls++;return operations.execute(...args);},pluginConnection:type=>business.pluginConnections.get(type)}});
  const api=createTaskApi({store:business,registry:app.registry,dispatcher,runner,config:{}});
  await Promise.all([server,api].map(service=>new Promise(resolve=>service.listen(0,'127.0.0.1',resolve))));
  t.after(async()=>{for(const service of [server,api])service.closeAllConnections();await Promise.all([server,api].map(service=>new Promise(resolve=>service.close(resolve))));business.close();manager.close();});
  const base=`http://127.0.0.1:${server.address().port}/admin/api`,gateway=`http://127.0.0.1:${api.address().port}`;
  return {base,gateway,business,operations,headers:{cookie:'synthetic-human-session'},calls:()=>calls};
}

test('human-only docs endpoint stays isolated, fresh after edits and causes no task or Agent action',async t=>{
  const {base,business,headers,calls}=await setup(t),path=type=>`${base}/plugins/${type}/integration`;
  assert.equal((await fetch(path('content.review'))).status,401);
  const denied=await fetch(path('content.review'),{headers:{authorization:'Bearer synthetic-internal-token'}});assert.equal(denied.status,401);
  const first=await fetch(path('content.review')+'?locale=en',{headers});assert.equal(first.status,200);const review=await first.json();
  assert.equal(review.locale,'en');assert.match(review.markdown,/content/);assert.match(review.markdown,/approved/);assert.ok(!review.markdown.includes('text_artifact_id'));
  const novel=await(await fetch(path('novel.illustrated'),{headers})).json();assert.match(novel.markdown,/premise/);assert.match(novel.markdown,/text_artifact_id/);
  const {revision,updated_at,...original}=business.plugins.get('content.review');business.plugins.save({...original,input_schema:{type:'object',properties:{changed:{type:'integer',description:'Fresh synthetic field'}},required:['changed']}});
  const updated=await(await fetch(path('content.review')+'?locale=en',{headers})).json();assert.match(updated.markdown,/Fresh synthetic field/);assert.ok(updated.revision>review.revision);
  assert.equal((await fetch(path('missing.plugin'),{headers})).status,404);assert.equal(business.listTasks().length,0);assert.ok(calls()>0);
});

test('generated request and transport documentation match actual acceptance and query envelopes',async t=>{
  const {base,gateway,business,headers}=await setup(t),type='content.review',key='synthetic-docs-entry-key-0123456789';
  business.pluginConnections.update(type,{entryAddress:gateway+'/hooks/review-docs',entryKey:key});business.plugins.setEnabled(type,true);
  const doc=await(await fetch(`${base}/plugins/${type}/integration?locale=en`,{headers})).json();
  const accepted=await fetch(gateway+'/hooks/review-docs',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({request_id:'synthetic-docs-request',input:doc.examples.input})});
  assert.equal(accepted.status,202);const task=await accepted.json();assert.equal(task.status,'queued');assert.equal(task.result,null);assert.equal(task.duplicate,false);
  const result=await(await fetch(`${gateway}/v2/tasks/${task.task_id}`,{headers:{authorization:'Bearer '+key}})).json();
  assert.equal(result.task_id,task.task_id);assert.ok(Array.isArray(result.artifacts));assert.equal(result.request_id,undefined);
  assert.match(doc.markdown,/duplicate/);assert.match(doc.markdown,/retry_of/);assert.match(doc.markdown,/artifacts/);assert.ok(!doc.markdown.includes(key));
  assert.match(doc.markdown,/128 characters/);
  assert.equal((await fetch(gateway+'/hooks/review-docs',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({request_id:'x'.repeat(129),input:doc.examples.input})})).status,400);
});

test('copyable shell examples expand only caller variables and safely quote literal plugin data',async()=>{
  const {buildPluginIntegration}=await import('../src/manager/plugin-integration.mjs');
  const input={text:"A developer's text with $(literal) and `literal`"};
  const doc=buildPluginIntegration({...definition,input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],examples:[input]}},humanConnection,{locale:'en'});
  const query=doc.sections.find(section=>section.key==='response').markdown.match(/```bash\n([\s\S]*?)\n```/)[1];
  const post=doc.sections.find(section=>section.key==='request').markdown.match(/```bash\n([\s\S]*?)\n```/)[1];
  const run=script=>promisify(execFile)('bash',['-c','curl(){ printf "%s\\n" "$@"; }\n'+script],{env:{...process.env,TASK_ID:'synthetic-task-id',PLUGIN_ENTRY_KEY:'synthetic-key'}});
  const queryArgs=(await run(query)).stdout;assert.ok(queryArgs.includes('https://gateway.example.invalid/v2/tasks/synthetic-task-id'));assert.ok(!queryArgs.includes('${TASK_ID}'));
  const postArgs=(await run(post)).stdout;assert.ok(postArgs.includes(input.text));assert.ok(postArgs.includes('Authorization: Bearer synthetic-key'));
});
