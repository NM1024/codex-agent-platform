import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {ScheduleStore} from '../src/operations/schedules.mjs';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';
import {RuntimeClient} from '../src/runtime/client.mjs';
import {configurePlugin} from './helpers/plugin-connections.mjs';
import {createTaskHistoryBatch} from '../src/core/history-retention.mjs';
import {createManagerHistoryBatch} from '../src/manager/history-retention.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';

const day=86400000;
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'history-integrated-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),codexHome=join(root,'codex');
  await mkdir(workspace);await mkdir(codexHome);await writeFile(join(codexHome,'auth.json'),'synthetic-shared-auth');
  const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-retention-runner',WORKSPACE_DIR:workspace});
  const store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());configurePlugin(store,'content.review');
  const runtime=new AgentRuntime({workspace,codexHome});
  const server=createRuntimeServer({runtime,registry:app.registry,config:{runnerToken:'synthetic-retention-runner'},probe:async()=>({ready:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const runner=new RuntimeClient({url:`http://127.0.0.1:${server.address().port}`,token:'synthetic-retention-runner'});
  const task=store.accept('fixture',{type:'content.review',request_id:'expired-history',input:{content:'Synthetic article'}}),run=store.claim(task.task_id);
  store.fail(run.run_id,'SYNTHETIC_FAILURE');
  const now=Date.now(),old=now-61*day;store.db.prepare('UPDATE agent_requests SET finished_at=? WHERE task_id=?').run(old,task.task_id);
  for(const path of [join(workspace,'.agent-runs',run.run_id),join(workspace,'artifacts',run.run_id),join(codexHome,'runs',run.run_id)])await mkdir(path,{recursive:true});
  await writeFile(join(workspace,'.agent-runs',run.run_id,'launch.json'),JSON.stringify({run_id:run.run_id,task_id:task.task_id,status:'ended'}));
  await writeFile(join(workspace,'artifacts',run.run_id,'result.txt'),'expired file');
  await symlink(join(codexHome,'auth.json'),join(codexHome,'runs',run.run_id,'auth.json'));
  const schedules=new ScheduleStore(store);
  const batch=createTaskHistoryBatch({store,runner,schedules,activeDeliveries:new Set()});
  return {root,workspace,codexHome,store,runtime,runner,task,run,batch,schedules,args:{now,cutoff:now-60*day,limit:50,cursor:null}};
}

test('expired task cleanup removes actual Runner files before DB history and preserves credentials',async t=>{
  const f=await fixture(t),result=await f.batch(f.args);
  assert.equal(result.deleted,1);assert.equal(f.store.get(f.task.task_id),null);
  for(const path of [join(f.workspace,'.agent-runs',f.run.run_id),join(f.workspace,'artifacts',f.run.run_id),join(f.codexHome,'runs',f.run.run_id)])await assert.rejects(lstat(path),{code:'ENOENT'});
  assert.equal(await readFile(join(f.codexHome,'auth.json'),'utf8'),'synthetic-shared-auth');
  assert.equal(f.store.plugins.get('content.review').enabled,true);
});

test('Runner rejection and in-flight callbacks leave task history intact for a future sweep',async t=>{
  const f=await fixture(t);f.runtime.active.set(f.run.run_id,{});
  const busy=await f.batch(f.args);assert.equal(busy.deleted,0);assert.ok(f.store.get(f.task.task_id));
  f.runtime.active.delete(f.run.run_id);
  const held=createTaskHistoryBatch({...f,activeDeliveries:new Set([f.task.task_id])});
  assert.equal((await held(f.args)).deleted,0);assert.ok(f.store.get(f.task.task_id));
  assert.equal((await f.batch(f.args)).deleted,1);
});

test('a failing owner cleanup hook retains that task and does not starve later expired history',async t=>{
  const f=await fixture(t);
  const later=f.store.accept('fixture',{type:'content.review',request_id:'later-expired',input:{content:'Synthetic second article'}});
  f.store.fail(f.store.claim(later.task_id).run_id,'SYNTHETIC_FAILURE');
  f.store.db.prepare('UPDATE agent_requests SET finished_at=? WHERE task_id=?').run(f.args.cutoff-1,later.task_id);
  const original=f.store.registry.catalog.deleteTaskHistory;
  f.store.registry.catalog.deleteTaskHistory=context=>{if(context.taskId===f.task.task_id)throw new Error('Synthetic owner failure');return original(context);};
  const result=await f.batch(f.args);
  assert.equal(result.deleted,1);assert.equal(result.failed,1);
  assert.ok(f.store.get(f.task.task_id));assert.equal(f.store.get(later.task_id),null);
});

test('manager retention honors activity refreshed after selection and cleans expired files through its owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-history-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const now=Date.now(),old=now-61*day,conversation=store.createConversation('Expired');
  store.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(old,conversation.id);
  for(const dir of ['work','codex']){await mkdir(join(root,dir,conversation.id),{recursive:true});await writeFile(join(root,dir,conversation.id,'old.txt'),'expired');}
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused'),mcpUrl:'http://127.0.0.1/unused'});
  const original=store.expiredConversations.bind(store);
  store.expiredConversations=args=>{const selected=original(args);store.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(now,conversation.id);return selected;};
  const batch=createManagerHistoryBatch({store,agent});
  const args={now,cutoff:now-60*day,limit:50,cursor:null};
  assert.equal((await batch(args)).deleted,0);assert.ok(store.metadata(conversation.id));
  store.expiredConversations=original;store.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(old,conversation.id);
  assert.equal((await batch(args)).deleted,1);
  await assert.rejects(lstat(join(root,'work',conversation.id)),{code:'ENOENT'});
  assert.throws(()=>store.metadata(conversation.id),{code:'CONVERSATION_NOT_FOUND'});
});
