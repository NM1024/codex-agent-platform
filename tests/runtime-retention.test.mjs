import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {createRuntimeServer} from '../src/runtime/server.mjs';
import {RuntimeClient} from '../src/runtime/client.mjs';

const identity = {run_id:'00000000-0000-4000-8000-000000000001', task_id:'00000000-0000-4000-8000-000000000002'};
const otherTask = '00000000-0000-4000-8000-000000000003';
const run = {...identity, type:'test.retention', input:{}, token:'synthetic-task-token', package:{prompt:'Synthetic task.',native:{},tools:[]}};
class Rpc {
  async request(method) {
    if (method==='thread/start'||method==='thread/resume') return {thread:{id:'fixture-thread'}};
    if (method==='turn/start') return {turn:{id:'fixture-turn'}};
    return {};
  }
  notify() {}
  subscribe() { return () => {}; }
  async close() {}
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'runtime-retention-'));
  const workspace=join(root,'workspace'),codexHome=join(root,'codex');
  await Promise.all([mkdir(workspace),mkdir(codexHome)]);
  const runtime=new AgentRuntime({workspace,codexHome,createClient:()=>new Rpc()});
  const owned=join(workspace,'.agent-runs',identity.run_id),artifacts=join(workspace,'artifacts',identity.run_id),home=join(codexHome,'runs',identity.run_id);
  t.after(async()=>{await runtime.stop();await rm(root,{recursive:true,force:true});});
  return {root,workspace,codexHome,runtime,owned,artifacts,home};
}
async function seed(f, marker=identity) {
  for (const dir of [f.owned,f.artifacts,f.home]) {
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'fixture.txt'),'task file');
  }
  await writeFile(join(f.owned,'launch.json'),JSON.stringify({...marker,status:'started',completed:false}));
}
async function absent(path) {await assert.rejects(lstat(path),{code:'ENOENT'});}
async function listen(t,f) {
  const server=createRuntimeServer({runtime:f.runtime,registry:{},config:{runnerToken:'internal-fixture-token',workspace:f.workspace},probe:async()=>({ready:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,client:new RuntimeClient({url,token:'internal-fixture-token'})};
}

test('purges only run-owned trees and permits stale nonterminal markers and repeated cleanup',async t=>{
  const f=await fixture(t);await seed(f);
  await writeFile(join(f.codexHome,'auth.json'),'synthetic-shared-login');
  await symlink(join(f.codexHome,'auth.json'),join(f.home,'auth.json'));
  await mkdir(join(f.artifacts,'nested'));await symlink(f.codexHome,join(f.artifacts,'nested','external-link'));
  await writeFile(join(f.workspace,'unrelated.txt'),'keep workspace');
  await writeFile(join(f.codexHome,'unrelated.txt'),'keep codex');
  await mkdir(join(f.workspace,'artifacts',otherTask));
  const {client}=await listen(t,f);
  assert.deepEqual(await client.purgeHistory(identity),{accepted:true});
  for (const path of [f.owned,f.artifacts,f.home]) await absent(path);
  assert.equal(await readFile(join(f.codexHome,'auth.json'),'utf8'),'synthetic-shared-login');
  assert.equal(await readFile(join(f.workspace,'unrelated.txt'),'utf8'),'keep workspace');
  assert.equal(await readFile(join(f.codexHome,'unrelated.txt'),'utf8'),'keep codex');
  assert.ok((await lstat(join(f.workspace,'artifacts',otherTask))).isDirectory());
  assert.deepEqual(await client.purgeHistory(identity),{accepted:true});
});

test('internal purge requires authentication and exact canonical identity payload',async t=>{
  const f=await fixture(t);await seed(f);const {url}=await listen(t,f);
  const post=(body,token='internal-fixture-token')=>fetch(url+'/internal/history/purge',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(identity,'wrong-token')).status,401);
  for (const body of [null,[],{}, {...identity,path:f.root}, {...identity,task_id:undefined}, {...identity,run_id:'../'+identity.run_id}, {...identity,run_id:'------------------------------------'}, {...identity,run_id:'ABCDEF00-0000-4000-8000-000000000001'}, {...identity,task_id:7}, {...identity,run_id:identity.run_id+'\n'}]) {
    const response=await post(body);assert.equal(response.status,400,JSON.stringify(body));
    assert.equal((await response.json()).error.code,'INVALID_RUN');
  }
  assert.equal(await readFile(join(f.artifacts,'fixture.txt'),'utf8'),'task file');
});

test('runtime rejects malformed identities without touching files',async t=>{
  const f=await fixture(t);await seed(f);
  for (const value of [null,{},[],{...identity,path:f.root},{...identity,run_id:'------------------------------------'},{...identity,run_id:'../escape'},{...identity,task_id:otherTask.toUpperCase().replace('00000000','ABCDEF00')},{...identity,task_id:identity.task_id+'\n'}])
    await assert.rejects(Promise.resolve().then(()=>f.runtime.purgeHistory(value)),/INVALID_RUN/);
  assert.equal(await readFile(join(f.owned,'fixture.txt'),'utf8'),'task file');
});

test('active runs and pending launches cannot be purged',async t=>{
  const f=await fixture(t);await f.runtime.launch(run);
  await assert.rejects(f.runtime.purgeHistory(identity),/RUN_CONFLICT/);
  assert.ok((await lstat(f.owned)).isDirectory());
  await f.runtime.end(identity.run_id,'SUSPENDED');
  let release;const gate=new Promise(resolve=>release=resolve);
  const pending=f.runtime.launch({...run,resume:true,generation:1},{beforeStart:()=>gate});
  try {await assert.rejects(f.runtime.purgeHistory(identity),/RUN_CONFLICT/);}
  finally {release();await pending;}
});

test('recovery and stopping reject purge before filesystem work',async t=>{
  const f=await fixture(t);await seed(f);
  const recovering=f.runtime.recover();
  await assert.rejects(f.runtime.purgeHistory(identity),/RUNNER_RECOVERING/);
  await recovering;await f.runtime.stop();
  await assert.rejects(f.runtime.purgeHistory(identity),/RUNNER_STOPPING/);
  assert.equal(await readFile(join(f.artifacts,'fixture.txt'),'utf8'),'task file');
});

test('purge reserves synchronously, coalesces identical requests and excludes launch and recovery',async t=>{
  const f=await fixture(t);await seed(f);
  const purging=f.runtime.purgeHistory(identity);
  assert.equal(f.runtime.purgeHistory(identity),purging);
  await assert.rejects(f.runtime.purgeHistory({...identity,task_id:otherTask}),/RUN_CONFLICT/);
  await assert.rejects(f.runtime.launch(run),/RUN_CONFLICT/);
  await assert.rejects(f.runtime.recover(),/RUNNER_ACTIVE/);
  await purging;await absent(f.owned);
  await f.runtime.launch(run);
  assert.equal(f.runtime.active.has(identity.run_id),true);
});

test('stop waits for reserved purges to finish',async t=>{
  const f=await fixture(t);await seed(f);
  const purging=f.runtime.purgeHistory(identity);
  await f.runtime.stop();await absent(f.owned);await absent(f.artifacts);await absent(f.home);
  await purging;
});

test('marker identity conflicts fail before deleting any run files and permit corrected retry',async t=>{
  for (const marker of [{...identity,task_id:otherTask},{...identity,run_id:otherTask}]) {
    const f=await fixture(t);await seed(f,marker);
    const {client}=await listen(t,f);
    await assert.rejects(client.purgeHistory(identity),error=>error.status===409&&error.code==='RUN_CONFLICT');
    for (const dir of [f.owned,f.artifacts,f.home]) assert.equal(await readFile(join(dir,'fixture.txt'),'utf8'),'task file');
    await writeFile(join(f.owned,'launch.json'),JSON.stringify(identity));
    await client.purgeHistory(identity);await absent(f.owned);
  }
});

test('missing markers and missing configured directories are idempotent successes',async t=>{
  const f=await fixture(t);await seed(f);await rm(join(f.owned,'launch.json'));
  await f.runtime.purgeHistory(identity);await absent(f.owned);
  await rm(f.workspace,{recursive:true});await rm(f.codexHome,{recursive:true});
  await f.runtime.purgeHistory(identity);
});

test('invalid, oversized, nonregular and linked markers fail before any deletion',async t=>{
  for (const kind of ['invalid','oversized','directory','symlink']) {
    const f=await fixture(t);await seed(f);const marker=join(f.owned,'launch.json');await rm(marker);
    if (kind==='invalid') await writeFile(marker,'not json');
    if (kind==='oversized') await writeFile(marker,' '.repeat(1024*1024+1));
    if (kind==='directory') await mkdir(marker);
    if (kind==='symlink') {await writeFile(join(f.root,'external-marker.json'),JSON.stringify(identity));await symlink(join(f.root,'external-marker.json'),marker);}
    await assert.rejects(f.runtime.purgeHistory(identity));
    for (const dir of [f.owned,f.artifacts,f.home]) assert.equal(await readFile(join(dir,'fixture.txt'),'utf8'),'task file');
  }
});

test('symlink roots and parents are rejected without deleting their targets or other run trees',async t=>{
  for (const location of ['owned','artifacts','home','workspace','codexHome','parent','ancestor']) {
    const f=await fixture(t);await seed(f);
    const outside=join(f.root,'external');await mkdir(outside);await writeFile(join(outside,'sentinel.txt'),'outside');
    if (location==='ancestor') {
      await symlink(f.root,join(f.root,'parent-link'));
      f.runtime.workspace=join(f.root,'parent-link','workspace');
    } else if (location==='parent') {
      await rm(join(f.codexHome,'runs'),{recursive:true});await symlink(outside,join(f.codexHome,'runs'));
    } else {
      await rm(f[location],{recursive:true});await symlink(outside,f[location]);
    }
    await assert.rejects(f.runtime.purgeHistory(identity),/UNSAFE_PATH/);
    assert.equal(await readFile(join(outside,'sentinel.txt'),'utf8'),'outside');
    if (!['owned','workspace'].includes(location)) assert.equal(await readFile(join(f.owned,'fixture.txt'),'utf8'),'task file');
  }
});

test('a FIFO marker is rejected before opening it can block cleanup',async t=>{
  const f=await fixture(t);await seed(f);const marker=join(f.owned,'launch.json');await rm(marker);
  execFileSync('mkfifo',[marker]);
  const purging=f.runtime.purgeHistory(identity).then(()=>false,()=>true);
  let deadline;
  const rejectedBeforeWriter=await Promise.race([purging,new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),1000);})]);
  clearTimeout(deadline);
  // Release a blocked open even if the regression returns, so test teardown
  // always drains filesystem work rather than leaving the Node process hung.
  const writer=await open(marker,constants.O_RDWR|constants.O_NONBLOCK);
  try {assert.equal(await purging,true);} finally {await writer.close();}
  assert.equal(rejectedBeforeWriter,true);
  assert.equal(await readFile(join(f.artifacts,'fixture.txt'),'utf8'),'task file');
});
