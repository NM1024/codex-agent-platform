import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const service=fileURLToPath(new URL('../',import.meta.url)),source=join(service,'src');
async function dependencies(entries) {
  const seen=new Set();
  async function visit(path) {
    if(seen.has(path))return;seen.add(path);
    const text=await readFile(path,'utf8');
    for(const [,specifier] of text.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g))await visit(resolve(dirname(path),specifier));
  }
  for(const entry of entries)await visit(join(source,entry));
  return [...seen].map(path=>relative(source,path));
}
test('management code depends only on its own modules and shared contracts/adapters',async()=>{
  const graph=await dependencies(['manager/agent.mjs','manager/server.mjs','manager/mcp.mjs','main-manager.mjs']);
  const forbidden=graph.filter(path=>/^(core|runtime|plugins|business|capabilities|operations)\//.test(path));
  assert.deepEqual(forbidden,[],'manager loads execution or Gateway implementation');
});
test('management can load without task runtime, concrete business, plugin compiler or Gateway operations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-only-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(source,join(root,'src'),{recursive:true,filter:path=>! /^(core|runtime|plugins|business|capabilities|operations)(\/|$)/.test(relative(source,path))});
  await symlink(join(service,'node_modules'),join(root,'node_modules'),'dir');
  for(const file of ['manager/agent.mjs','manager/server.mjs','manager/mcp.mjs']) {
    const loaded=await import(pathToFileURL(join(root,'src',file)).href);assert.ok(Object.keys(loaded).length);
  }
});
test('the capability module has no plugin/delivery implementation dependency or delivery-owned tables',async t=>{
  const graph=await dependencies(['capabilities/catalog.mjs']);
  assert.deepEqual(graph.filter(path=>/^(plugins|delivery|business)\//.test(path)),[]);
  const [{capabilityCatalog},{BusinessRegistry},{RequestStore}]=await Promise.all([import('../src/capabilities/catalog.mjs'),import('../src/core/registry.mjs'),import('../src/core/store.mjs')]);
  const store=new RequestStore(':memory:',{registry:new BusinessRegistry([],capabilityCatalog({workspace:'/tmp'}))});t.after(()=>store.close());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='platform_delivery_details'").get().n,0);
});
test('a plugin cannot silently accept delivery when only tools and artifacts are installed',async()=>{
  const [{capabilityCatalog},{BusinessRegistry}]=await Promise.all([import('../src/capabilities/catalog.mjs'),import('../src/core/registry.mjs')]);
  const registry=new BusinessRegistry([],capabilityCatalog({workspace:'/tmp',targets:{local:{url:'https://example.invalid/callback'}}}));
  assert.throws(()=>registry.compileDefinition({type:'test.review',name:'审核',instructions:'完成任务',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'callback_once',target:'local'}}),/DELIVERY_UNAVAILABLE/);
});
test('management operates task, schedule and settings modules through their interfaces',async t=>{
  const [{BusinessRegistry},{RequestStore},{OperationsService}]=await Promise.all([import('../src/core/registry.mjs'),import('../src/core/store.mjs'),import('../src/operations/service.mjs')]);
  const store=new RequestStore(':memory:',{registry:new BusinessRegistry()});t.after(()=>store.close());
  const definition={type:'test.review',name:'审核',instructions:'审核后提交',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
  store.plugins.save(definition);
  const task=store.accept('default',{type:definition.type,request_id:'source',input:{content:'原任务'}});store.fail(store.claim(task.task_id).run_id,'CODEX_TURN_FAILED');
  const service=new OperationsService({store,config:{concurrency:1,paused:true},dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true}),configure:async()=>{}}});
  Object.defineProperty(service,'db',{get(){throw new Error('Management service must call owning module, not shared SQL');}});
  assert.equal((await service.execute('overview')).tasks.failed,1);
  assert.equal((await service.execute('tasks',{status:'failed'}))[0].task_id,task.task_id);
  assert.equal((await service.execute('task',{task_id:task.task_id})).input.content,'原任务');
  const next=await service.execute('retry',{task_id:task.task_id});assert.equal(next.retry_of,task.task_id);assert.equal(store.get(task.task_id).status,'failed');
  const plan=await service.execute('schedule_save',{schedule:{name:'巡检',kind:'inspection',cron:'* * * * *',message:'检查状态'}});
  await service.schedules.tick(plan.next_run_at);
  const inspections=await service.execute('inspection_list');assert.equal(inspections.length,1);
  assert.equal((await service.execute('inspection_claim',{id:inspections[0].id})).accepted,true);
  await service.execute('inspection_ack',{id:inspections[0].id,conversation_id:'inspection-conversation'});assert.equal((await service.execute('inspection_list')).length,0);
  assert.equal((await service.execute('runtime_update',{concurrency:3})).concurrency,3);
});
