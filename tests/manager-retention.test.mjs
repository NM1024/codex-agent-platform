import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';

const cutoff=1000;
const age=(store,id,time=999)=>store.db.prepare('UPDATE manager_conversations SET created_at=1,updated_at=? WHERE id=?').run(time,id);
function finished(store){const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic request');store.markRunning(m.id);store.finish(m,null,'Synthetic reply');return {c,m};}
function memory(t){const store=new ManagerStore(':memory:');t.after(()=>store.close());return store;}
const agentFor=(store,root)=>new ManagementAgent({store,root,authFile:join(root,'shared-auth.json'),mcpUrl:'http://127.0.0.1/unused'});

test('expiry uses a strict last-activity boundary and stable ascending keyset pages',t=>{
  const store=memory(t),older=store.createConversation(),ties=[store.createConversation(),store.createConversation()].sort((a,b)=>a.id.localeCompare(b.id)),boundary=store.createConversation(),recent=store.createConversation();
  age(store,older.id,998);for(const c of ties)age(store,c.id);age(store,boundary.id,1000);age(store,recent.id,1001);
  const first=store.expiredConversations({cutoff,limit:2});
  assert.deepEqual(first.map(row=>({...row})),[{id:older.id,updated_at:998},{id:ties[0].id,updated_at:999}]);
  assert.deepEqual(store.expiredConversations({cutoff,cursor:{time:999,id:ties[0].id},limit:2}).map(row=>row.id),[ties[1].id]);
  assert.throws(()=>store.deleteConversation(boundary.id,{cutoff}),{code:'CONVERSATION_NOT_EXPIRED'});
});

test('new completed replies and management actions restart the conversation retention age',t=>{
  const store=memory(t),{c}=finished(store);age(store,c.id);
  const m=store.enqueue(c.id,'New activity');store.markRunning(m.id);store.finish(m,null,'New reply');
  assert.deepEqual(store.expiredConversations({cutoff}),[]);
  age(store,c.id);const action=store.beginAction(c.id,'synthetic_operation');age(store,c.id);store.finishAction(action,{status:'completed'});
  assert.deepEqual(store.expiredConversations({cutoff}),[]);
});

for(const status of ['queued','running','interrupted','draft','steering','steer_unknown'])test(`automatic retention preserves ${status} user work and prevents idle compaction`,t=>{
  const store=memory(t),c=store.createConversation(),m=store.enqueue(c.id,'Unfinished work');
  store.db.prepare('UPDATE manager_messages SET status=? WHERE id=?').run(status,m.id);age(store,c.id);
  assert.deepEqual(store.expiredConversations({cutoff}),[]);
  assert.throws(()=>store.deleteConversation(c.id,{cutoff}),{code:'CONVERSATION_BUSY'});
  assert.equal(store.isHistoryIdle(),false);
  assert.equal(store.metadata(c.id).id,c.id);
});

for(const activity of ['question','action','timeline','reply'])test(`pending ${activity} protects history even if its user message is terminal`,t=>{
  const store=memory(t),{c,m}=finished(store);
  if(activity==='question')store.db.prepare("INSERT INTO manager_questions VALUES('pending-question',?,'[]',NULL,'pending',1,1)").run(m.id);
  if(activity==='action')store.beginAction(c.id,'synthetic_operation');
  if(activity==='timeline')store.db.prepare("INSERT INTO manager_message_activity VALUES(?,'pending-tool','tool','Synthetic','', 'running',1,1)").run(m.id);
  if(activity==='reply')store.db.prepare("INSERT INTO manager_reply_items VALUES(?,'pending-reply','Synthetic','running',1,1)").run(m.id);
  age(store,c.id);
  assert.deepEqual(store.expiredConversations({cutoff}),[]);
  assert.throws(()=>store.deleteConversation(c.id,{cutoff}),{code:'CONVERSATION_BUSY'});
  assert.equal(store.isHistoryIdle(),false);
});

test('automatic deletion rechecks scanned age and eligibility against another database connection',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-race-')),path=join(root,'manager.sqlite'),store=new ManagerStore(path),other=new ManagerStore(path);
  t.after(async()=>{other.close();store.close();await rm(root,{recursive:true,force:true});});
  const {c,m}=finished(store);age(store,c.id);
  assert.equal(store.expiredConversations({cutoff})[0].id,c.id);
  other.db.prepare('UPDATE manager_conversations SET updated_at=1000 WHERE id=?').run(c.id);
  assert.throws(()=>store.deleteConversation(c.id,{cutoff}),{code:'CONVERSATION_NOT_EXPIRED'});
  age(store,c.id);other.db.prepare("UPDATE manager_messages SET status='draft' WHERE id=?").run(m.id);
  assert.throws(()=>store.deleteConversation(c.id,{cutoff}),{code:'CONVERSATION_BUSY'});
  assert.deepEqual(store.pendingConversationCleanup(),[]);
});

test('retention deletes all owned history/media rows and durably queues cleanup in the deletion transaction',t=>{
  const store=memory(t),c=store.createConversation(),other=finished(store),image={name:'synthetic.png',mime:'image/png',width:1,height:1,size:1,bytes:Buffer.from([1])};
  const m=store.enqueue(c.id,'With media',[image]);store.markRunning(m.id);
  store.saveGeneratedImage(m.id,'generated-image',image);store.replyItem(m.id,'public-reply','Synthetic output','running');store.progress(m.id,{id:'tool',kind:'tool',label:'Synthetic',text:'',status:'running'});
  store.addQuestion(m.id,[]);const action=store.beginAction(c.id,'synthetic_operation');store.finishAction(action,{status:'completed'});store.finish(m,null,'Done');age(store,c.id);
  assert.equal(store.isHistoryIdle(),true);
  assert.deepEqual(store.deleteConversation(c.id,{cutoff}),{id:c.id,deleted:true});
  for(const table of ['manager_conversations','manager_messages','manager_actions','manager_chat_images','manager_generated_images'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table==='manager_conversations'?'id':'conversation_id'}=?`).get(c.id).n,0,table);
  for(const table of ['manager_questions','manager_reply_items','manager_message_activity'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE message_id=?`).get(m.id).n,0,table);
  assert.equal(store.metadata(other.c.id).id,other.c.id);
  assert.deepEqual(store.pendingConversationCleanup().map(row=>row.id),[c.id]);
  store.finishConversationCleanup(c.id);assert.deepEqual(store.pendingConversationCleanup(),[]);
});

test('manual deletion still allows withdrawn drafts but the live agent guard prevents deletion',async t=>{
  const store=memory(t),c=store.createConversation(),m=store.enqueue(c.id,'Withdrawn');store.withdrawQueued(c.id,m.id);
  const agent=agentFor(store,'/unused');agent.running.set(c.id,Promise.resolve());
  await assert.rejects(agent.deleteConversation(c.id),{code:'CONVERSATION_BUSY'});agent.running.clear();
  assert.equal(store.deleteConversation(c.id).deleted,true);
});

test('a deletion database failure rolls back both history removal and queued filesystem cleanup',t=>{
  const store=memory(t),{c,m}=finished(store);age(store,c.id);
  store.db.exec("CREATE TRIGGER retain_synthetic_history BEFORE DELETE ON manager_conversations BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DELETE_FAILURE'); END;");
  assert.throws(()=>store.deleteConversation(c.id,{cutoff}),/SYNTHETIC_DELETE_FAILURE/);
  assert.equal(store.metadata(c.id).id,c.id);assert.equal(store.message(m.id).text,'Synthetic request');
  assert.deepEqual(store.pendingConversationCleanup(),[]);
});

test('conversation cleanup removes only owned directories and never follows shared auth or nested symlinks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-clean-')),store=new ManagerStore(join(root,'manager.sqlite')),agent=agentFor(store,root),{c}=finished(store),other=store.createConversation();
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  await writeFile(join(root,'shared-auth.json'),'synthetic shared authorization');
  await mkdir(join(root,'codex',c.id),{recursive:true});await symlink(join(root,'shared-auth.json'),join(root,'codex',c.id,'auth.json'));
  await mkdir(join(root,'work',c.id),{recursive:true});await writeFile(join(root,'work',c.id,'image.png'),'synthetic image');
  await mkdir(join(root,'work',other.id),{recursive:true});await writeFile(join(root,'work',other.id,'retained.txt'),'keep');
  await symlink(join(root,'work',other.id),join(root,'work',c.id,'linked-work'));
  age(store,c.id);assert.deepEqual(await agent.deleteConversation(c.id,{cutoff}),{id:c.id,deleted:true});
  for(const directory of ['codex','work'])await assert.rejects(lstat(join(root,directory,c.id)),{code:'ENOENT'});
  assert.equal(await readFile(join(root,'shared-auth.json'),'utf8'),'synthetic shared authorization');
  assert.equal(await readFile(join(root,'work',other.id,'retained.txt'),'utf8'),'keep');
  assert.deepEqual(store.pendingConversationCleanup(),[]);
});

test('unsafe cleanup parents stay queued and cleanup resumes after reopening once the parent is repaired',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-retry-')),path=join(root,'manager.sqlite'),outside=join(root,'outside');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {c}=finished(store);await mkdir(join(outside,c.id),{recursive:true});await writeFile(join(outside,c.id,'retain.txt'),'outside');
  await symlink(outside,join(root,'codex'));await mkdir(join(root,'work',c.id),{recursive:true});age(store,c.id);
  const result=await agentFor(store,root).deleteConversation(c.id,{cutoff});assert.equal(result.cleanup_pending,true);
  assert.equal(await readFile(join(outside,c.id,'retain.txt'),'utf8'),'outside');
  assert.deepEqual(store.pendingConversationCleanup().map(row=>row.id),[c.id]);
  store.close();store=new ManagerStore(path);const agent=agentFor(store,root);
  assert.deepEqual(await agent.retryConversationCleanup(),{attempted:1,completed:0,pending:1});
  await rm(join(root,'codex'));await mkdir(join(root,'codex',c.id),{recursive:true});await writeFile(join(root,'codex',c.id,'session.json'),'synthetic session');
  assert.deepEqual(await agent.retryConversationCleanup(),{attempted:1,completed:1,pending:0});
  assert.deepEqual(store.pendingConversationCleanup(),[]);await assert.rejects(lstat(join(root,'codex',c.id)),{code:'ENOENT'});
  assert.equal(await readFile(join(outside,c.id,'retain.txt'),'utf8'),'outside');
});

test('cleanup rejects symlink roots, symlink conversation directories and non-UUID queue entries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-unsafe-')),store=new ManagerStore(join(root,'manager.sqlite')),{c}=finished(store),real=join(root,'real');
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  await mkdir(join(real,'codex',c.id),{recursive:true});await writeFile(join(real,'codex',c.id,'retain.txt'),'keep');await symlink(real,join(root,'linked-root'));store.deleteConversation(c.id);
  assert.equal((await agentFor(store,join(root,'linked-root')).retryConversationCleanup()).pending,1);
  await mkdir(join(root,'codex'));await symlink(join(real,'codex',c.id),join(root,'codex',c.id));
  assert.equal((await agentFor(store,root).retryConversationCleanup()).pending,1);
  store.db.prepare('INSERT INTO manager_conversation_cleanup(id,created_at) VALUES(?,1)').run('../real');
  assert.equal((await agentFor(store,root).retryConversationCleanup()).pending,2);
  assert.equal(await readFile(join(real,'codex',c.id,'retain.txt'),'utf8'),'keep');
});

test('cleanup rejects a symlink ancestor of its real root without deleting external conversation files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-ancestor-')),outside=await mkdtemp(join(tmpdir(),'manager-retention-external-')),store=new ManagerStore(join(root,'manager.sqlite')),{c}=finished(store);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
  for(const directory of ['codex','work']){
    await mkdir(join(outside,'manager',directory,c.id),{recursive:true});
    await writeFile(join(outside,'manager',directory,c.id,'retain.txt'),'external synthetic history');
  }
  await symlink(outside,join(root,'ancestor-link'));store.deleteConversation(c.id);
  const result=await agentFor(store,join(root,'ancestor-link','manager')).retryConversationCleanup();
  for(const directory of ['codex','work'])assert.equal(await readFile(join(outside,'manager',directory,c.id,'retain.txt'),'utf8'),'external synthetic history');
  assert.deepEqual(result,{attempted:1,completed:0,pending:1});
  assert.deepEqual(store.pendingConversationCleanup().map(row=>row.id),[c.id]);
});

test('old observation snapshots are pruned with a strict age boundary',t=>{
  const store=memory(t);store.observe('old-history',{history:'synthetic old error'});store.observe('at-cutoff',{history:'keep'});store.observe('fresh',{history:'keep'});
  store.db.prepare("UPDATE manager_observations SET observed_at=999 WHERE key='old-history'").run();store.db.prepare("UPDATE manager_observations SET observed_at=1000 WHERE key='at-cutoff'").run();
  assert.equal(store.pruneObservations(cutoff),1);
  assert.equal(store.observation('old-history'),null);assert.equal(store.observation('at-cutoff').history,'keep');assert.equal(store.observation('fresh').history,'keep');
});

test('persisted cleanup retries rotate failed jobs so a bounded batch cannot starve later deletions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-retention-fair-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  store.db.prepare('INSERT INTO manager_conversation_cleanup(id,created_at) VALUES(?,1)').run('../unsafe');const {c}=finished(store);store.deleteConversation(c.id);
  await mkdir(join(root,'codex',c.id),{recursive:true});await mkdir(join(root,'work',c.id),{recursive:true});
  assert.deepEqual(await agentFor(store,root).retryConversationCleanup({limit:1}),{attempted:1,completed:0,pending:1});
  store.close();store=new ManagerStore(path);
  assert.deepEqual(await agentFor(store,root).retryConversationCleanup({limit:1}),{attempted:1,completed:1,pending:0});
  assert.deepEqual(store.pendingConversationCleanup().map(row=>row.id),['../unsafe']);
  await assert.rejects(lstat(join(root,'codex',c.id)),{code:'ENOENT'});
});
