import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Ajv from 'ajv';
import {SystemJournal,encodeSystemCursor,decodeSystemCursor,mergeSystemPages} from '../src/observability/system-journal.mjs';
import {systemManagementTools} from '../src/observability/system-contracts.mjs';

function fixture(t,{service='manager',path=':memory:'}={}) {
  const db=new DatabaseSync(path);let time=1000;
  t.after(()=>{try{db.close();}catch{}});
  return {db,journal:new SystemJournal({db,service,now:()=>time}),tick:(value)=>{time=value;}};
}
const event=(journal,extra={})=>journal.event({module:'cleanup',event:'attempt',level:'error',code:'CLEANUP_FAILED',message:'never copy raw text',...extra});
const work=(journal,extra={})=>journal.work({id:'cleanup-1',module:'cleanup',title:'unsafe raw title',state:'retrying',code:'CLEANUP_FAILED',...extra});

test('records only safe fixed messages, identifiers and allowlisted primitive details',t=>{
  const {journal}=fixture(t);
  const saved=event(journal,{message:'Bearer synthetic-secret https://example.com/?token=secret',target_id:'/private/secret',details:{pending_count:3,attempt:2,phase:'cleanup',token:'synthetic-secret',url:'https://example.com/?token=secret',error:new Error('private'),status:'Authorization: secret',nested:{prompt:'private'}}});
  assert.match(saved.id,/^manager:event:/);
  assert.equal(saved.message,'Cleanup failed.');
  assert.equal(saved.target_id,null);
  assert.deepEqual(saved.details,{pending_count:3,attempt:2,phase:'cleanup'});
  const unknown=event(journal,{module:'https://example.com',event:'Bearer secret',code:'SECRET_private',message:'private'});
  assert.equal(unknown.code,'SYSTEM_ERROR');assert.equal(unknown.module,'system');
  assert.equal(JSON.stringify(journal.logs({})).includes('synthetic-secret'),false);
});

test('literal search escapes SQL wildcards and paginates equal timestamps without gaps',t=>{
  const {journal}=fixture(t);
  for(let i=0;i<7;i++)event(journal,{event:`attempt-${i}`,target_id:`target-${i}`});
  let cursor;const ids=[];
  do {const page=journal.logs({limit:2,cursor});ids.push(...page.items.map(x=>x.id));cursor=page.next_cursor;}while(cursor);
  assert.equal(ids.length,7);assert.equal(new Set(ids).size,7);
  assert.deepEqual(journal.logs({search:'%'}).items,[]);
  assert.deepEqual(journal.logs({search:'target_3'}).items,[]);
  assert.equal(journal.logs({search:'target-3'}).items.length,1);
  assert.equal(journal.logs({after:1000,before:1001}).items.length,7);
  assert.throws(()=>journal.logs({limit:101}),/SYSTEM_QUERY_INVALID/);
  assert.throws(()=>journal.logs({cursor:'invalid'}),/SYSTEM_QUERY_INVALID/);
  assert.equal(journal.logs({service:'runner'}).items.length,0);
});

test('repeated unchanged events consolidate but recovery remains independent',t=>{
  const {journal,tick}=fixture(t);const first=event(journal);
  tick(1100);event(journal);tick(1200);event(journal);
  const failed=journal.detail(first.id);
  assert.equal(failed.count,3);assert.equal(failed.first_seen_at,1000);assert.equal(failed.last_seen_at,1200);
  event(journal,{event:'recovered',level:'info',code:'WORK_COMPLETED'});
  assert.equal(journal.logs({}).items.length,2);
});

test('durable work transitions track attempts, revisions and evidence-based recovery',t=>{
  const dir=mkdtempSync(join(tmpdir(),'journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'journal.sqlite');const {journal,db,tick}=fixture(t,{path});
  let saved=work(journal,{allowed_actions:['cleanup_retry','arbitrary_command']});
  assert.equal(saved.revision,1);assert.equal(saved.attempts,1);assert.equal(saved.consecutive_failures,1);
  assert.equal(saved.title,'Cleanup');assert.deepEqual(saved.allowed_actions,['cleanup_retry']);
  assert.equal(journal.issues({}).items.length,1);
  tick(2000);saved=work(journal,{state:'running',code:'WORK_RUNNING',pending_count:2});
  assert.equal(saved.attempts,2);assert.equal(saved.last_progress_at,2000);
  assert.equal(journal.issues({}).items.length,1,'running does not prove recovery');
  const stale=saved.revision;
  saved=journal.classify(saved.id,'code_defect',saved.revision);
  assert.equal(saved.classification,'code_defect');assert.equal(saved.revision,stale+1);
  assert.throws(()=>journal.classify(saved.id,'transient',stale),/SYSTEM_REVISION_CONFLICT/);
  tick(3000);saved=work(journal,{state:'completed',code:'WORK_COMPLETED',pending_count:0});
  assert.equal(saved.last_success_at,3000);assert.equal(saved.completed_at,3000);assert.equal(saved.consecutive_failures,0);
  assert.equal(journal.issues({}).items.length,0);
  assert.equal(journal.issues({state:'completed'}).items[0].resolved_at,3000);
  assert.equal(journal.detail(saved.id).revision,4);
  db.close();const reopened=new DatabaseSync(path);t.after(()=>reopened.close());
  const restored=new SystemJournal({db:reopened,service:'manager',now:()=>4000});
  assert.equal(restored.detail(saved.id).last_success_at,3000);
  assert.ok(restored.logs({}).items.some(x=>x.code==='WORK_COMPLETED'));
});

test('storage failure is observable without throwing from event or work',t=>{
  const {journal,db}=fixture(t);db.close();
  assert.equal(event(journal),null);assert.equal(work(journal),null);
  assert.equal(journal.health.available,false);assert.equal(journal.health.code,'SYSTEM_JOURNAL_UNAVAILABLE');
  assert.equal(journal.summary().health.available,false);
  assert.throws(()=>journal.logs({}),/SYSTEM_JOURNAL_UNAVAILABLE/);
  const broken=new SystemJournal({db,service:'manager'});
  assert.equal(broken.health.available,false);
});

test('retention respects strict cutoff, bounded batches, unfinished work and issue evidence independently of chat deletion',t=>{
  const {journal,db,tick}=fixture(t);
  db.exec('CREATE TABLE manager_conversations(id TEXT); INSERT INTO manager_conversations VALUES (\'synthetic-chat\')');
  const ongoing=work(journal);const evidence=journal.logs({work_id:ongoing.id}).items[0];
  event(journal,{event:'old-unrelated'});
  const done=work(journal,{id:'done',state:'completed',code:'WORK_COMPLETED'});
  tick(2000);const boundary=event(journal,{event:'cutoff'});
  db.exec('DELETE FROM manager_conversations');
  assert.equal(journal.issues({}).items.length,1);
  assert.ok(journal.prune({cutoff:2000,limit:1}).deleted<=1);
  for(let i=0;i<10;i++)journal.prune({cutoff:2000,limit:1});
  assert.ok(journal.detail(ongoing.id));assert.ok(journal.detail(evidence.id));
  assert.ok(journal.detail(boundary.id));assert.equal(journal.detail(done.id),null);
  tick(3000);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  for(let i=0;i<10;i++)journal.prune({cutoff:4000,limit:2});
  assert.equal(journal.detail(ongoing.id),null);assert.equal(journal.detail(evidence.id),null);
  assert.throws(()=>journal.prune({cutoff:NaN,limit:1}),/SYSTEM_QUERY_INVALID/);
});

test('source-safe cursor helpers merge bounded pages without skipping the unconsumed source',t=>{
  const {journal:a}=fixture(t);const {journal:b}=fixture(t,{service:'runner'});
  for(let i=0;i<3;i++){event(a,{event:`manager-${i}`});event(b,{event:`runner-${i}`});}
  const pages=[a.logs({limit:2}),b.logs({limit:2})];
  const merged=mergeSystemPages(pages,{limit:2});
  assert.equal(merged.items.length,2);assert.ok(merged.next_cursor);
  const position=decodeSystemCursor(merged.next_cursor);
  assert.equal(position.id,merged.items[1].id);
  assert.equal(encodeSystemCursor(position),merged.next_cursor);
  const second=mergeSystemPages([a.logs({limit:2,cursor:merged.next_cursor}),b.logs({limit:2,cursor:merged.next_cursor})],{limit:2});
  assert.equal(new Set([...merged.items,...second.items].map(x=>x.id)).size,4);
  assert.throws(()=>decodeSystemCursor(Buffer.from(JSON.stringify({time:1,id:'evil:event:1'})).toString('base64url')),/SYSTEM_QUERY_INVALID/);
});

test('management schemas bound queries and reject arbitrary maintenance selectors',()=>{
  const ajv=new Ajv({strict:false});
  const schemas=Object.fromEntries(systemManagementTools.map(x=>[x.name,ajv.compile(x.inputSchema)]));
  assert.equal(Object.keys(schemas).length,6);
  assert.equal(schemas.system_logs({service:'manager',limit:100}),true);
  assert.equal(schemas.system_logs({limit:101}),false);
  assert.equal(schemas.system_logs({sql:'SELECT 1'}),false);
  assert.equal(schemas.system_maintain({id:'manager:work:cleanup-1',action:'cleanup_retry',revision:1}),true);
  assert.equal(schemas.system_maintain({id:'manager:work:cleanup-1',action:'shell',revision:1}),false);
  assert.equal(schemas.system_issue_draft({id:'manager:work:cleanup-1',revision:1,diagnosis:'Synthetic defect',expected:'Complete cleanup',actual:'Cleanup failed',reproduction:'Run a synthetic cleanup',source_refs:['src/observability/system-journal.mjs']}),true);
  assert.equal(schemas.system_issue_draft({id:'manager:work:cleanup-1'}),false);
});


test('unresolved evidence survives idle and disabled observations and completed history uses the new policy cutoff',t=>{
  const {journal,tick}=fixture(t);const failed=work(journal);const evidence=journal.logs({work_id:failed.id}).items[0];
  tick(2000);work(journal,{state:'idle'});tick(3000);work(journal,{state:'disabled'});
  assert.equal(journal.issues({}).items.length,1);
  journal.prune({cutoff:4000,limit:100});assert.ok(journal.detail(evidence.id));assert.ok(journal.detail(failed.id));
  tick(5000);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  journal.prune({cutoff:5000,limit:100});assert.ok(journal.detail(failed.id),'strict cutoff protects recovery at cutoff');
  journal.prune({cutoff:5001,limit:100});assert.equal(journal.detail(failed.id),null);
});

test('consolidated logs retain recent repeat evidence across retention cutoff',t=>{
  const {journal,tick}=fixture(t);const saved=event(journal);tick(5000);event(journal);
  journal.prune({cutoff:2000,limit:100});assert.equal(journal.detail(saved.id).count,2);
  journal.prune({cutoff:5001,limit:100});assert.equal(journal.detail(saved.id),null);
});

test('queries apply relevant state level and target filters to records',t=>{
  const {journal}=fixture(t);const saved=work(journal,{target_id:'target-one'});
  assert.equal(journal.logs({state:'retrying'}).items.length,1);
  assert.equal(journal.logs({state:'completed'}).items.length,0);
  assert.equal(journal.works({level:'error',target_id:'target-one'}).items[0].id,saved.id);
  assert.equal(journal.works({level:'info'}).items.length,0);
  assert.equal(journal.works({work_id:saved.id}).items.length,1);
  assert.throws(()=>work(journal,{id:'runner:work:foreign'}),/SYSTEM_WORK_INVALID/);
  assert.throws(()=>work(journal,{id:'manager:event:foreign'}),/SYSTEM_WORK_INVALID/);
});

test('interleaved steady observations consolidate per logical work and retain recovery transitions',t=>{
  const {journal}=fixture(t);
  work(journal,{id:'one',state:'idle',code:'WORK_IDLE'});work(journal,{id:'two',state:'idle',code:'WORK_IDLE'});
  work(journal,{id:'one',state:'idle',code:'WORK_IDLE'});work(journal,{id:'two',state:'idle',code:'WORK_IDLE'});
  assert.equal(journal.logs({}).items.length,2);
  work(journal,{id:'one'});work(journal,{id:'one',state:'completed',code:'WORK_COMPLETED'});work(journal,{id:'one'});
  assert.equal(journal.logs({work_id:'manager:work:one'}).items.length,4);
});

test('steady completed observations do not flood logs and every later recovery stays visible',t=>{
  const {journal,tick}=fixture(t);work(journal);
  tick(2000);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  tick(3000);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  assert.equal(journal.logs({}).items.length,2);
  work(journal);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  assert.equal(journal.logs({}).items.length,4);
});

test('progress and completion observations preserve actual attempt identity and timing',t=>{
  const {journal,tick}=fixture(t);
  let saved=work(journal,{state:'running',code:'WORK_RUNNING',attempted:true});
  tick(2000);saved=work(journal,{state:'completed',code:'WORK_COMPLETED',attempted:false});
  assert.equal(saved.attempts,1);assert.equal(saved.first_attempt_at,1000);assert.equal(saved.last_attempt_at,1000);
  assert.equal(saved.last_success_at,2000);assert.equal(saved.completed_at,2000);
  tick(3000);const idle=work(journal,{id:'not-attempted',state:'idle',attempted:false});
  assert.equal(idle.attempts,0);assert.equal(idle.first_attempt_at,null);assert.equal(idle.last_attempt_at,null);
});

test('issue first appearance and recovery timestamps remain stable through repeated observations',t=>{
  const {journal,tick}=fixture(t);tick(0);work(journal);
  tick(1000);assert.equal(work(journal).issue_opened_at,0);
  tick(2000);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  tick(3000);assert.equal(work(journal,{state:'completed',code:'WORK_COMPLETED',attempted:false}).resolved_at,2000);
});

test('summary counts only verified issue recoveries within the last day',t=>{
  const {journal,tick,db}=fixture(t);
  work(journal,{id:'ordinary-success',state:'completed',code:'WORK_COMPLETED'});
  assert.equal(journal.summary().recovered_24h,0);
  work(journal);work(journal,{state:'completed',code:'WORK_COMPLETED'});
  assert.equal(journal.summary().recovered_24h,1);
  tick(86401001);assert.equal(journal.summary().recovered_24h,0);
  db.close();assert.equal(journal.summary().recovered_24h,null);
});

test('recent repeated occurrences participate in time filters, ordering and merged keyset pages',t=>{
  const a=fixture(t),b=fixture(t,{service:'runner'});
  const old=event(a.journal,{target_id:'repeat'});
  a.tick(1500);event(a.journal,{target_id:'middle'});
  a.tick(2000);event(a.journal,{target_id:'repeat'});
  b.tick(2000);const remote=event(b.journal,{target_id:'remote'});
  const recent=a.journal.logs({after:1750,before:2001});
  assert.equal(recent.items.length,1);assert.equal(recent.items[0].id,old.id);
  assert.equal(recent.items[0].created_at,1000);assert.equal(recent.items[0].last_seen_at,2000);
  assert.equal(a.journal.logs({before:1750}).items.some(x=>x.id===old.id),false);
  const first=mergeSystemPages([a.journal.logs({limit:1}),b.journal.logs({limit:1})],{limit:1});
  assert.equal(first.items[0].id,remote.id);assert.equal(decodeSystemCursor(first.next_cursor).time,2000);
  const second=mergeSystemPages([a.journal.logs({limit:1,cursor:first.next_cursor}),b.journal.logs({limit:1,cursor:first.next_cursor})],{limit:1});
  assert.equal(second.items[0].id,old.id);assert.equal(decodeSystemCursor(second.next_cursor).time,2000);
  const third=mergeSystemPages([a.journal.logs({limit:1,cursor:second.next_cursor}),b.journal.logs({limit:1,cursor:second.next_cursor})],{limit:1});
  assert.equal(third.items[0].target_id,'middle');assert.equal(third.next_cursor,null);
});

test('recovered issue history remains listable independently of later current work states',t=>{
  const {journal,tick}=fixture(t);const id=work(journal).id;
  tick(2000);work(journal,{state:'completed',code:'WORK_COMPLETED',attempted:false});
  for(const state of ['idle','running','disabled']){
    tick(3000);work(journal,{state,code:`WORK_${state.toUpperCase()}`,attempted:false});
    assert.equal(journal.issues({}).items.length,0);
    assert.equal(journal.issues({state:'completed'}).items[0].id,id);
    assert.equal(journal.issues({resolution:'recovered',state}).items[0].state,state);
    assert.equal(journal.issues({resolution:'all'}).items[0].resolved_at,2000);
    assert.equal(journal.summary().recovered_24h,1);
  }
  work(journal);assert.equal(journal.issues({}).items[0].id,id);
  assert.equal(journal.issues({resolution:'recovered'}).items.length,0);
  assert.throws(()=>journal.issues({resolution:'invalid'}),/SYSTEM_QUERY_INVALID/);
  const schema=new Ajv({strict:false}).compile(systemManagementTools.find(x=>x.name==='system_issue').inputSchema);
  assert.equal(schema({resolution:'recovered',state:'idle'}),true);
  assert.equal(schema({resolution:'invalid'}),false);
});

test('verified journal recovery separates current availability from durable sanitized collection loss',t=>{
  const dir=mkdtempSync(join(tmpdir(),'journal-gap-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'journal.sqlite'),{journal,db,tick}=fixture(t,{path});
  db.exec("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON system_events BEGIN SELECT RAISE(ABORT,'private synthetic error'); END");
  tick(2000);assert.equal(event(journal),null);
  assert.equal(journal.health.available,false);
  assert.equal(journal.health.collection.failed_operations,1);
  assert.equal(journal.health.collection.first_failed_at,2000);
  tick(2500);assert.deepEqual(journal.logs({}).items,[]);
  assert.equal(journal.health.available,true,'successful read proves current read access');
  assert.equal(journal.health.code,'SYSTEM_OK');assert.equal(journal.health.collection.pending,true);
  tick(3000);assert.equal(event(journal),null);
  assert.equal(journal.health.collection.failed_operations,2);
  db.exec('DROP TRIGGER synthetic_event_failure');
  tick(4000);assert.ok(event(journal,{target_id:'after-recovery'}));
  const summary=journal.summary();assert.equal(summary.health.available,true);assert.equal(summary.health.collection.pending,false);
  assert.equal(summary.health.collection.gap_count,1);assert.equal(summary.health.collection.failed_operations,2);
  assert.equal(summary.health.collection.last_failed_at,3000);assert.equal(summary.health.collection.last_recovered_at,4000);
  const evidence=journal.logs({module:'system'}).items;
  assert.deepEqual(evidence.map(x=>x.event),['collection_recovered','collection_failed']);
  assert.equal(evidence[0].code,'SYSTEM_JOURNAL_RECOVERED');assert.equal(evidence[1].code,'SYSTEM_JOURNAL_UNAVAILABLE');
  assert.equal(evidence[1].details.first_failed_at,2000);assert.equal(evidence[1].details.last_failed_at,3000);
  assert.equal(JSON.stringify(evidence).includes('private synthetic error'),false);
  db.close();const reopened=new DatabaseSync(path);t.after(()=>reopened.close());
  const restored=new SystemJournal({db:reopened,service:'manager',now:()=>5000});
  assert.equal(restored.summary().health.available,true);
  assert.equal(restored.health.collection.failed_operations,2);
  assert.equal(restored.health.collection.last_recovered_at,4000);
  assert.equal(restored.logs({module:'system'}).items.length,2);
  restored.prune({cutoff:4001,limit:100});
  assert.equal(restored.logs({module:'system'}).items.length,0,'gap event history obeys the ordinary caller cutoff');
  assert.equal(restored.summary().health.collection.failed_operations,2,'compact loss metadata remains distinct from retained event history');
});
