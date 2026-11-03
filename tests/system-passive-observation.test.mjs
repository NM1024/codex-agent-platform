import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SystemJournal} from '../src/observability/system-journal.mjs';
import {createSystemOperations} from '../src/observability/system-operations.mjs';
import {createSystemMaintenance,systemDue} from '../src/observability/system-maintenance.mjs';
function fixture(t,service='manager'){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return new SystemJournal({db,service,now:()=>100});}
test('preparing and repeating a draft preserves work revision, classification, retry and evidence',async t=>{
 const journal=fixture(t),work=journal.work({id:'cleanup',module:'cleanup',state:'retrying',allowed_actions:['cleanup_retry']}),before=journal.logs();
 const ops=createSystemOperations({local:()=>({journal})});
 for(let n=0;n<2;n++){
  const draft=await ops.execute('system_issue_draft',{id:work.id,revision:work.revision},{actor:'agent'});
  assert.equal(draft.submitted,false);assert.ok(draft.evidence_ids.includes(work.id));assert.ok(draft.markdown.includes('classification: unknown'));assert.deepEqual(journal.detail(work.id),work);assert.deepEqual(journal.logs(),before);assert.equal(systemDue(journal,'cleanup'),true);
 }
});
test('legacy diagnostic classifications do not hide or block an owner-approved maintenance action',async t=>{
 const journal=fixture(t);let calls=0,work=journal.work({id:'cleanup',module:'cleanup',state:'retrying',allowed_actions:['cleanup_retry']});work=journal.classify(work.id,'code_defect',work.revision);
 const maintain=createSystemMaintenance({journal,actions:{cleanup_retry:async()=>{calls++;journal.work({id:'cleanup',module:'cleanup',state:'completed',allowed_actions:['cleanup_retry']});}}});
 const ops=createSystemOperations({local:()=>({journal,maintain})});
 assert.equal(systemDue(journal,'cleanup'),true);assert.equal(systemDue(journal,'cleanup',{force:true}),true);
 assert.deepEqual((await ops.execute('system_issue',{id:work.id})).allowed_actions,['cleanup_retry']);
 const result=await ops.execute('system_maintain',{id:work.id,revision:work.revision,action:'cleanup_retry'},{actor:'agent'});assert.equal(calls,1);assert.equal(result.outcome,'recovered');
});
test('unavailable observation storage does not veto normal background work eligibility',()=>{
 const db=new DatabaseSync(':memory:'),journal=new SystemJournal({db,service:'manager'});db.close();assert.equal(systemDue(journal,'cleanup'),true);assert.equal(systemDue(journal,'cleanup',{force:true}),true);
});
test('completed diagnostic records follow retention while unfinished and unresolved evidence stays protected',t=>{
 const journal=fixture(t);let done=journal.work({id:'done',module:'cleanup',state:'retrying'});done=journal.classify(done.id,'code_defect',done.revision);journal.work({...done,state:'completed'});
 const pending=journal.work({id:'pending',module:'cleanup',state:'retrying',classification:'code_defect'});journal.now=()=>1000;journal.prune({cutoff:500,limit:100});assert.equal(journal.detail(done.id),null);assert.ok(journal.detail(pending.id));assert.ok(journal.logs({work_id:pending.id}).items.length);
});

import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentRuntime} from '../src/runtime/codex.mjs';
import {HistoryRetentionWorker} from '../src/history/worker.mjs';
test('Runner cleanup discovers ended owner records when observation storage is unavailable and after recovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'passive-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));const db=new DatabaseSync(':memory:'),journal=new SystemJournal({db,service:'runner'});db.close();
 const id='00000000-0000-4000-8000-000000000001',owned=join(root,'.agent-runs',id),home=join(root,'codex');await mkdir(join(owned,'work'),{recursive:true});await mkdir(join(home,'runs',id),{recursive:true});await writeFile(join(owned,'launch.json'),JSON.stringify({run_id:id,status:'ended'}));
 const runtime=new AgentRuntime({workspace:root,codexHome:home,journal});await runtime.retryTransientCleanup();await assert.rejects(stat(join(owned,'work')),{code:'ENOENT'});await assert.rejects(stat(join(home,'runs',id)),{code:'ENOENT'});assert.ok(await stat(join(owned,'launch.json')));
 const healthy=fixture(t,'runner');runtime.journal=healthy;await mkdir(join(owned,'work'),{recursive:true});await runtime.retryTransientCleanup();await assert.rejects(stat(join(owned,'work')),{code:'ENOENT'});
});
test('journal retention failure preserves owner progress and does not prevent independent remote retention',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const observations=fixture(t);observations.db.exec('DROP TABLE system_events');let business=0,remote=0;
 const worker=new HistoryRetentionWorker({db,journal:observations,maxBatches:1,readPolicy:()=>({enabled:true,days:60,revision:1}),runBatch:async()=>{business++;return {deleted:1,hasMore:false,cursor:'done'};},pruneRemote:async()=>{remote++;return {deleted:1,hasMore:false};}});
 await worker.tick(10000000000);assert.equal(business,1);assert.equal(remote,1);assert.equal(worker.state().history_done,true);assert.equal(worker.state().remote_done,true);assert.equal(worker.state().cursor,'done');assert.equal(worker.state().journal_done,false);assert.equal(worker.state().completed_at,null);
});
test('remote observation cleanup outage preserves completed owner work and retries only pending cleanup',async t=>{
 const journal=fixture(t);let unavailable=true,business=0,remote=0;
 const worker=new HistoryRetentionWorker({db:journal.db,journal,maxBatches:1,readPolicy:()=>({enabled:true,days:60,revision:1}),runBatch:async()=>{business++;return {deleted:1,hasMore:false,cursor:'saved'};},pruneRemote:async()=>{remote++;if(unavailable)throw new Error('SYSTEM_JOURNAL_UNAVAILABLE');return {deleted:1,hasMore:false};}});
 await worker.tick(10000000000);assert.equal(worker.state().history_done,true);assert.equal(worker.state().cursor,'saved');assert.equal(worker.state().remote_done,false);assert.equal(worker.state().completed_at,null);assert.equal(worker.state().compaction_pending,true);
 unavailable=false;await worker.tick(10000000001);assert.equal(business,1);assert.equal(remote,2);assert.equal(worker.state().remote_done,true);assert.notEqual(worker.state().completed_at,null);
});
