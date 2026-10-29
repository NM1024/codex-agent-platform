import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {createManagerConfiguration} from '../src/manager/configuration.mjs';

test('durable scheduling deduplicates conversations and rotates each completed round to the tail',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const a=store.createConversation(),b=store.createConversation();
  const first=store.enqueue(a.id,'A1');store.enqueue(a.id,'A2');store.enqueue(b.id,'B1');
  store.schedule(a.id);store.schedule(a.id);
  assert.equal(store.takeScheduled(),a.id);store.markRunning(first.id);
  store.schedule(a.id);store.schedule(b.id);
  assert.equal(store.takeScheduled([a.id]),b.id);store.schedule(b.id);
  store.finish(first,null,'Done');store.reschedule(a.id);
  assert.equal(store.takeScheduled(),b.id);
  assert.equal(store.takeScheduled(),a.id);assert.equal(store.takeScheduled(),undefined);
});

test('interruption waits for a new trigger and preserves a trigger received during cleanup',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),message=store.enqueue(c.id,'Original');
  store.schedule(c.id);store.takeScheduled();store.markRunning(message.id);store.interrupted(message.id);
  store.reschedule(c.id,{interrupted:true});
  assert.equal(store.scheduled(c.id),false);
  store.schedule(c.id);store.takeScheduled();store.markRunning(message.id);store.interrupted(message.id);
  store.enqueue(c.id,'Explicit continuation');store.schedule(c.id);store.reschedule(c.id,{interrupted:true});
  assert.equal(store.takeScheduled(),c.id);assert.equal(store.next(c.id).id,message.id);
});

test('bulk recovery restores unfinished rounds and expires their native questions',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),message=store.enqueue(c.id,'Recover me');store.markRunning(message.id);
  store.progress(message.id,{id:'tool',kind:'tool',label:'Synthetic operation',text:'',status:'running'});
  store.replyItem(message.id,'reply','Partial reply','running');
  store.addQuestion(message.id,[{id:'choice',header:'Choice',question:'Continue?',options:[{label:'Yes',description:'Continue'}]}]);
  const action=store.beginAction(c.id,'synthetic');
  const draft=store.createConversation(),withdrawn=store.enqueue(draft.id,'Draft');store.withdrawQueued(draft.id,withdrawn.id);
  assert.equal(store.recover(),1);
  const recovered=store.message(message.id);
  assert.equal(recovered.status,'interrupted');assert.equal(recovered.activity[0].status,'unknown');
  assert.equal(recovered.replies[0].status,'unknown');assert.equal(recovered.questions[0].status,'expired');
  assert.equal(store.actions(c.id).find(row=>row.id===action).status,'unknown');
  assert.equal(store.takeScheduled(),c.id);assert.equal(store.takeScheduled(),undefined);
});

test('reopening preserves ready order and recovery appends an interrupted conversation once',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-ready-reopen-')),path=join(root,'manager.sqlite');
  let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const a=store.createConversation(),b=store.createConversation(),message=store.enqueue(a.id,'Interrupted');
  store.markRunning(message.id);store.enqueue(b.id,'Already queued');store.schedule(b.id);
  const version=store.queueVersion(b.id);store.close();store=new ManagerStore(path);
  assert.equal(store.recover(),2);assert.equal(store.queueVersion(b.id),version);
  assert.equal(store.takeScheduled(),b.id);assert.equal(store.takeScheduled(),a.id);assert.equal(store.takeScheduled(),undefined);
});

test('removing the final unstarted message and deleting its conversation clears durable scheduling',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),message=store.enqueue(c.id,'Remove me');store.schedule(c.id);
  store.removeQueued(c.id,message.id);store.reschedule(c.id);
  assert.equal(store.scheduled(c.id),false);
  store.schedule(c.id);store.deleteConversation(c.id);assert.equal(store.takeScheduled(),undefined);
});

test('saved manager settings gain bounded concurrency without replacing existing values',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  store.db.exec('CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const values={model:'saved-model',timeoutMs:1000,toolTimeoutMs:500,instructions:'Saved instructions',inspectionIntervalMs:15000};
  store.db.prepare('INSERT INTO platform_settings VALUES(?,?)').run('configuration:manager',JSON.stringify({values,revision:7,updated_at:123}));
  const applied=[],agent={model:'bootstrap',timeoutMs:1000,toolTimeoutMs:500,setConcurrency(value){this.concurrency=value;applied.push(value);}};
  const configuration=createManagerConfiguration({store,agent});
  assert.equal(configuration.get('manager').values.concurrency,2);assert.equal(agent.model,'saved-model');assert.equal(agent.instructions,'Saved instructions');
  assert.equal(configuration.get('manager').revision,7);assert.equal(configuration.get('manager').updated_at,123);
  configuration.update('manager',{concurrency:5});assert.deepEqual(applied,[2,5]);
  for(const concurrency of [0,6,1.5])assert.throws(()=>configuration.update('manager',{concurrency}),{code:'INVALID_CONFIGURATION'});
  const reopened={model:'bootstrap',timeoutMs:1000,toolTimeoutMs:500};
  createManagerConfiguration({store,agent:reopened});assert.equal(reopened.concurrency,5);
});

test('queue revisions change for queued edits and departures while live progress preserves the revision',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation();assert.equal(store.queueVersion(c.id),0);
  const message=store.enqueue(c.id,'Queued');let version=store.queueVersion(c.id);assert.ok(version>0);
  store.withdrawQueued(c.id,message.id);assert.ok(store.queueVersion(c.id)>version);version=store.queueVersion(c.id);
  store.requeue(c.id,message.id,'Edited');assert.ok(store.queueVersion(c.id)>version);version=store.queueVersion(c.id);
  store.markRunning(message.id);assert.ok(store.queueVersion(c.id)>version);version=store.queueVersion(c.id);
  store.reply(message.id,'Streaming text');store.progress(message.id,{id:'status',kind:'status',label:'Working',text:'Active',status:'running'});
  store.finish(message,null,'Complete');assert.equal(store.queueVersion(c.id),version);
  const removed=store.enqueue(c.id,'Remove');version=store.queueVersion(c.id);store.removeQueued(c.id,removed.id);assert.ok(store.queueVersion(c.id)>version);
  const deleted=store.enqueue(c.id,'Delete directly');version=store.queueVersion(c.id);store.db.prepare('DELETE FROM manager_messages WHERE id=?').run(deleted.id);assert.ok(store.queueVersion(c.id)>version);
  store.deleteConversation(c.id);assert.equal(store.queueVersion(c.id),0);
});

async function until(condition) {
  const deadline=Date.now()+5000;
  while(!condition()){assert.ok(Date.now()<deadline,'scheduler did not reach the expected state');await new Promise(resolve=>setImmediate(resolve));}
}
async function fixture(t,{concurrency}={}) {
  const root=await mkdtemp(join(tmpdir(),'manager-scheduling-'));
  const store=new ManagerStore(join(root,'manager.sqlite')),started=[],clients=[];
  const agent=new ManagementAgent({store,root,authFile:join(root,'synthetic-auth.json'),mcpUrl:'http://127.0.0.1/unused',timeoutMs:10000,...(concurrency===undefined?{}:{concurrency}),createClient:options=>{
    const listeners=new Set(),threadId=basename(options.cwd),client={threadId,turnId:null,text:null,closed:false,
      notify(){},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},async close(){client.closed=true;},
      async request(method,params){
        if(method.startsWith('thread/'))return {thread:{id:threadId,turns:[]}};
        if(method==='turn/start'){client.turnId='turn-'+clients.length;client.text=params.input[0].text.split('\n').slice(1).join('\n');started.push(client.text);return {turn:{id:client.turnId}};}
        return {};
      },
      finish(){for(const listener of listeners)listener({method:'turn/completed',params:{threadId,turn:{id:client.turnId,status:'completed'}}});},
    };clients.push(client);return client;
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const finish=async text=>{await until(()=>clients.some(client=>client.text===text));await new Promise(resolve=>setImmediate(resolve));clients.find(client=>client.text===text).finish();};
  return {store,agent,started,clients,finish};
}

test('default manager concurrency admits two clients while a large backlog stays on disk',async t=>{
  const {store,agent,started,clients,finish}=await fixture(t);
  const messages=[];
  for(let n=0;n<300;n++){const conversation=store.createConversation();messages.push(agent.enqueue(conversation.id,'Request '+n));}
  await until(()=>started.length>=2);
  assert.equal(started.length,2);assert.equal(clients.length,2);assert.equal(agent.running.size,2);assert.equal(agent.active.size,2);
  assert.equal(store.message(messages[299].id).status,'queued');
  let idle=false;const waiting=agent.idle(messages[2].conversation_id).then(()=>{idle=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(idle,false);
  await finish('Request 0');await until(()=>started.length===3);await finish('Request 2');await waiting;
  assert.equal(store.message(messages[2].id).status,'completed');
});

test('single-slot dispatch gives another conversation its turn before a same-conversation backlog',async t=>{
  const {store,agent,started,finish}=await fixture(t,{concurrency:1});
  const a=store.createConversation(),b=store.createConversation();
  agent.enqueue(a.id,'A1');agent.enqueue(a.id,'A2');agent.enqueue(b.id,'B1');
  assert.equal(agent.running.size,1);
  await until(()=>started.length===1);await finish('A1');await until(()=>started.length===2);
  assert.deepEqual(started,['A1','B1']);await finish('B1');await until(()=>started.length===3);
  await finish('A2');await agent.idle(a.id);assert.deepEqual(started,['A1','B1','A2']);
});

test('lowering concurrency preserves active rounds and raising it fills available slots',async t=>{
  const {store,agent,started,clients,finish}=await fixture(t);
  for(let n=0;n<4;n++){const c=store.createConversation();agent.enqueue(c.id,'Round '+n);}
  await until(()=>started.length===2);agent.setConcurrency(1);
  assert.equal(clients.filter(client=>!client.closed).length,2);
  await finish('Round 0');await until(()=>agent.running.size===1);assert.equal(started.length,2);
  agent.setConcurrency(2);await until(()=>started.length===3);assert.equal(started[2],'Round 2');
});
