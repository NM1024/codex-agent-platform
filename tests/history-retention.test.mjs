import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigurationStore} from '../src/configuration/store.mjs';
import {retentionScope} from '../src/configuration/retention.mjs';
import {HistoryRetentionWorker,compactHistoryDatabase} from '../src/history/worker.mjs';

const day=86400000;
test('retention is opt-in, persists age, validates days and rejects stale configuration writes',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const config=new ConfigurationStore(db,[retentionScope()]);
    assert.deepEqual(config.read('retention'),{enabled:false,days:60});
    const saved=config.update('retention',{enabled:true,days:30},{revision:0});
    assert.deepEqual(saved.values,{enabled:true,days:30});
    assert.throws(()=>config.update('retention',{days:60},{revision:0}),{code:'CONFIGURATION_REVISION_CONFLICT'});
    for(const days of [0,-1,1.5,3651,null])assert.throws(()=>config.update('retention',{days},{revision:1}),{code:'INVALID_CONFIGURATION'});
    assert.deepEqual(new ConfigurationStore(db,[retentionScope()]).read('retention'),{enabled:true,days:30});
  } finally {db.close();}
});

test('disabled or unavailable policy starts no deletion; daily progress resumes after restart',async()=>{
  const db=new DatabaseSync(':memory:');let policy={enabled:false,days:30,revision:0},calls=0;
  const options={db,readPolicy:async()=>policy,maxBatches:1,runBatch:async({cutoff,cursor})=>{
    assert.equal(cutoff,70*day);calls++;
    return {deleted:1,failed:0,cursor:{time:1,id:'next'},hasMore:!cursor};
  }};
  try {
    let worker=new HistoryRetentionWorker(options);
    await worker.tick(100*day);assert.equal(calls,0);
    policy={enabled:true,days:30,revision:1};await worker.tick(100*day);assert.equal(calls,1);
    worker=new HistoryRetentionWorker(options);await worker.tick(100*day);assert.equal(calls,2);
    await worker.tick(100*day+1000);assert.equal(calls,2);
    const unavailable=new HistoryRetentionWorker({...options,readPolicy:async()=>{throw new Error('Gateway offline');}});
    await assert.rejects(unavailable.tick(102*day),/Gateway offline/);assert.equal(calls,2);
    policy={enabled:false,days:30,revision:2};await worker.tick(102*day);assert.equal(calls,2);
  } finally {db.close();}
});

test('policy changes and disabling are checked between batches and duplicate wakeups coalesce',async()=>{
  const db=new DatabaseSync(':memory:');let policy={enabled:true,days:60,revision:1},calls=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const worker=new HistoryRetentionWorker({db,readPolicy:async()=>policy,runBatch:async()=>{
    calls++;await held;policy={...policy,enabled:false,revision:2};return {deleted:1,failed:0,cursor:{time:1,id:'a'},hasMore:true};
  }});
  try {
    const first=worker.tick(100*day),second=worker.tick(100*day);release();await Promise.all([first,second]);
    assert.equal(calls,1);
  } finally {db.close();}
});

test('shutdown drains a failed policy read without turning a temporary outage into an unhandled shutdown error',async()=>{
  const db=new DatabaseSync(':memory:');let reject,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),policy=new Promise((_,fail)=>{reject=fail;});
  const worker=new HistoryRetentionWorker({db,readPolicy:()=>{entered();return policy;},runBatch:()=>{throw new Error('must not delete');}});
  try {
    const running=worker.tick();await ready;const stopped=worker.stop();reject(new Error('Gateway offline'));
    const results=await Promise.allSettled([running,stopped]);
    assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  } finally {db.close();}
});

test('deferred compaction survives daily sweeps and policy revisions that delete no more rows',async()=>{
  for(const rollover of ['daily','revision']) {
    const db=new DatabaseSync(':memory:');let policy={enabled:true,days:60,revision:1},batches=0,compactions=0,idle=false;
    const worker=new HistoryRetentionWorker({db,readPolicy:()=>policy,
      runBatch:()=>({deleted:++batches===1?1:0,hasMore:false}),
      compact:()=>{compactions++;return {skipped:!idle};}});
    try {
      await worker.tick(100*day);assert.equal(worker.state().compaction_pending,true);
      if(rollover==='revision')policy={...policy,revision:2};
      await worker.tick(rollover==='daily'?101*day:100*day+1000);
      assert.equal(worker.state().compaction_pending,true,rollover);
      idle=true;await worker.tick(rollover==='daily'?101*day+1000:100*day+2000);
      assert.equal(compactions,3,rollover);assert.equal(worker.state().compaction_pending,false);
    } finally {db.close();}
  }
});

test('idle database compaction returns deleted BLOB space to the filesystem and retains configuration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'retention-space-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'history.sqlite'),db=new DatabaseSync(path);t.after(()=>db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE media(bytes BLOB); CREATE TABLE config(value TEXT); INSERT INTO config VALUES(\'keep\');');
  db.prepare('INSERT INTO media VALUES(?)').run(Buffer.alloc(2*1024*1024));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before=(await stat(path)).size;db.exec('DELETE FROM media');
  compactHistoryDatabase(db,{idle:false});assert.equal((await stat(path)).size,before);
  compactHistoryDatabase(db,{idle:true});assert.ok((await stat(path)).size<before/2);
  assert.equal(db.prepare('SELECT value FROM config').get().value,'keep');
});
