import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { createDeliveryWorker } from '../src/delivery/worker.mjs';
import { createTaskApi } from '../src/api.mjs';
import { allowedTool } from '../src/codex/tool-policy.mjs';

async function setup(t,targets={}) {
  const {createPlatformCatalog}=await import('../src/platform.mjs');
  const root=await mkdtemp(join(tmpdir(),'capabilities-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const catalog=createPlatformCatalog({workspace:root,targets});
  const registry=new BusinessRegistry([],catalog),store=new RequestStore(':memory:',{registry});t.after(()=>store.close());
  const definition={type:'novel.illustrated',name:'小说',instructions:'完成小说与配图并提交。',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:['register_image','write_text_artifact','read_artifact']},resources:[],delivery:{mode:'none'}};
  store.plugins.save(definition);
  function run() {const task=store.accept('test',{type:definition.type,request_id:'x',input:{topic:'海'}});return store.claim(task.task_id);}
  const active=run(),state={run:active,owned:join(root,'.agent-runs',active.run_id),workDir:join(root,'work'),home:join(root,'home')};
  await mkdir(state.workDir,{recursive:true});await mkdir(join(state.home,'generated_images'),{recursive:true});
  const process=body=>catalog.processors[body.name](body,{state,workspace:root});store.context={workspace:root,process};
  const context={store,runId:active.run_id,taskId:active.task_id,operationId:randomUUID(),process};
  return {root,catalog,store,active,state,context,run,definition};
}
test('JSON-only illustrated task saves real image and text artifacts and rejects another task ownership',async t=>{
  const {store,catalog,active,state,context,run}=await setup(t);
  const source=join(state.home,'generated_images','source.png');await sharp({create:{width:400,height:300,channels:3,background:'#abcdef'}}).png().toFile(source);
  const image=await catalog.tools.register_image.execute({source_path:source,format:'jpeg',width:1280,height:720},context);
  const id=image.structuredContent.artifact_id;
  const meta=await catalog.tools.read_artifact.execute({artifact_id:id},context);
  assert.equal((await sharp(meta.path).metadata()).width,1280);
  const text=await catalog.tools.write_text_artifact.execute({filename:'chapter.md',text:'第一章：海上的灯。'},context);
  assert.equal(await readFile(text.path,'utf8'),'第一章：海上的灯。');
  const other=run();
  await assert.rejects(catalog.tools.read_artifact.execute({artifact_id:id},{...context,runId:other.run_id,taskId:other.task_id}),/ARTIFACT_NOT_OWNED/);
  await store.complete(active.run_id,{title:'海',chapters:[{text:'海上的灯',artifact_id:id}],text_artifact_id:text.artifact_id});
  assert.equal(store.get(active.task_id).status,'completed');
});
test('artifact tools cannot read outside the run or write through a supplied filename path',async t=>{
  const {root,catalog,context}=await setup(t);const outside=join(root,'outside.png');await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toFile(outside);
  await assert.rejects(catalog.tools.register_image.execute({source_path:outside},context),/UNSAFE_PATH/);
  await assert.rejects(catalog.tools.write_text_artifact.execute({filename:'../escape.txt',text:'x'},context),/UNSAFE_PATH/);
});
test('configured callback records rejection once and does not change successful execution',async t=>{
  let calls=0,payload;
  const server=createServer(async(req,res)=>{calls++;const parts=[];for await(const part of req)parts.push(part);payload=JSON.parse(Buffer.concat(parts));res.writeHead(503);res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const targets={mock:{url:`http://127.0.0.1:${server.address().port}`,token:'local-test'}};
  const {store,definition}=await setup(t,targets);store.plugins.save({...definition,delivery:{mode:'callback_once',target:'mock'}});
  const task=store.accept('test',{type:definition.type,request_id:'callback',input:{}}),run=store.claim(task.task_id);
  await store.complete(run.run_id,{text:'完成'});
  const deliver=createDeliveryWorker({store,config:{}});await deliver();await deliver();
  assert.equal(calls,1);assert.equal(payload.task_id,task.task_id);assert.equal(payload.result.text,'完成');
  assert.equal(store.get(task.task_id).status,'completed');assert.equal(store.get(task.task_id).delivery.status,'failed');
  assert.equal(store.get(task.task_id).delivery.http_status,503);
});
test('artifact download is authenticated and cannot cross the selected task',async t=>{
  const {store,catalog,context,active,run}=await setup(t);
  const artifact=await catalog.tools.write_text_artifact.execute({filename:'chapter.md',text:'真实正文'},context);
  const server=createTaskApi({store,registry:store.registry,dispatcher:{runner:{}},runner:{},config:{clientId:'test',ingressToken:'local'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`,path=`/v2/tasks/${active.task_id}/artifacts/${artifact.artifact_id}`;
  assert.equal((await fetch(base+path)).status,401);
  const response=await fetch(base+path,{headers:{authorization:'Bearer local'}});
  assert.equal(response.status,200);assert.equal(await response.text(),'真实正文');
  assert.equal((await fetch(`${base}/v2/tasks/${run().task_id}/artifacts/${artifact.artifact_id}`,{headers:{authorization:'Bearer local'}})).status,403);
});
test('an empty text artifact remains a valid file and can be included in a final result',async t=>{
  const {catalog,store,context,active}=await setup(t);
  const artifact=await catalog.tools.write_text_artifact.execute({filename:'empty.txt',text:''},context);
  await store.complete(active.run_id,{artifact_id:artifact.artifact_id});
  assert.equal((await catalog.readArtifact(store,active.task_id,artifact.artifact_id)).data.length,0);
});

test('native image review can reopen its registered final artifact without accessing another run',async t=>{
  const {root,catalog,state,context,definition}=await setup(t);
  const source=join(state.workDir,'source.png');await sharp({create:{width:40,height:30,channels:3,background:'blue'}}).png().toFile(source);
  const final=await catalog.tools.register_image.execute({source_path:source},context);
  const scope=catalog.scope({...state,definition});
  assert.equal(allowedTool('view_image',{path:final.structuredContent.path},scope),true);
  await rm(join(state.home,'generated_images'),{recursive:true});
  assert.equal(allowedTool('view_image',{path:final.structuredContent.path},scope),true,'an unused native image directory may not exist');
  const sibling=join(root,'artifacts',randomUUID());await mkdir(sibling);const other=join(sibling,'private.png');await writeFile(other,await readFile(source));
  assert.equal(allowedTool('view_image',{path:other},scope),false);
  const escape=join(root,'artifacts',state.run.run_id,'escape.png');await symlink(other,escape);
  assert.equal(allowedTool('view_image',{path:escape},scope),false);
});
