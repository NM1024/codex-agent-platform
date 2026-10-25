import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';

test('message history pages preserve request/reply groups even when replies finish after newer requests',()=>{
  const store=new ManagerStore(':memory:');try {
    const c=store.createConversation(),requests=[];
    for(let n=0;n<6;n++)requests.push(store.enqueue(c.id,'request '+n));
    for(const m of requests){store.markRunning(m.id);store.finish(m,null,'reply '+m.text);}
    const latest=store.getConversationPage(c.id,{limit:2});
    assert.deepEqual(latest.messages.filter(m=>m.role==='user').map(m=>m.text),['request 4','request 5']);
    assert.equal(latest.messages.length,4);assert.equal(latest.history.has_more,true);
    const older=store.getConversationPage(c.id,{limit:2,before:latest.history.before});
    assert.deepEqual(older.messages.filter(m=>m.role==='user').map(m=>m.text),['request 2','request 3']);
    assert.equal(older.messages.filter(m=>m.role==='assistant').length,2);
    const first=store.getConversationPage(c.id,{limit:2,before:older.history.before});assert.equal(first.history.has_more,false);
    assert.deepEqual(first.messages.filter(m=>m.role==='user').map(m=>m.text),['request 0','request 1']);
    const other=store.createConversation(),foreign=store.enqueue(other.id,'foreign');
    assert.throws(()=>store.getConversationPage(c.id,{before:foreign.id}),{code:'INVALID_CURSOR'});
  }finally{store.close();}
});

test('conversation list cursors survive new insertions and reject invalid page sizes',()=>{
  const store=new ManagerStore(':memory:');try {
    const all=Array.from({length:7},(_,n)=>store.createConversation('chat '+n));
    all.forEach((row,n)=>store.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(1000+n,row.id));
    const first=store.listPage({limit:3});assert.equal(first.items.length,3);assert.ok(first.next_cursor);
    store.createConversation('New arrival');
    const second=store.listPage({limit:3,before:first.next_cursor});
    assert.equal(second.items.length,3);assert.equal(second.items.filter(row=>first.items.some(prior=>prior.id===row.id)).length,0);
    const third=store.listPage({limit:3,before:second.next_cursor});assert.equal(third.items.length,1);assert.equal(third.next_cursor,null);
    assert.equal(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size,all.length);
    for(const limit of [0,-1,101,1.5,NaN])assert.throws(()=>store.listPage({limit}),{code:'INVALID_PAGINATION'});
    assert.throws(()=>store.listPage({before:'not-a-cursor'}),{code:'INVALID_CURSOR'});
  }finally{store.close();}
});

test('HTTP history and SSE snapshots are bounded while older pages remain accessible',async t=>{
  const store=new ManagerStore(':memory:'),c=store.createConversation('Long synthetic chat');
  for(let n=0;n<45;n++){const m=store.enqueue(c.id,'request '+n);store.markRunning(m.id);store.finish(m,null,'reply '+n);}
  for(let n=0;n<35;n++)store.createConversation('Other '+n);
  const server=createManagerServer({store,auth:{authorize:()=>true},agent:{},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeEventStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}/admin/api/conversations`;
  const list=await(await fetch(base)).json();assert.equal(list.items.length,30);assert.ok(list.next_cursor);
  const latest=await(await fetch(`${base}/${c.id}`)).json();assert.equal(latest.messages.length,40);assert.equal(latest.history.has_more,true);
  const older=await(await fetch(`${base}/${c.id}?before=${latest.history.before}`)).json();assert.equal(older.messages.length,40);
  const firstRequest=store.getConversation(c.id).messages.find(message=>message.role==='user');
  const groupResponse=await fetch(`${base}/${c.id}/messages?ids=${firstRequest.id}`);assert.equal(groupResponse.status,200);
  const group=await groupResponse.json();assert.equal(group.messages.length,2);assert.equal(group.messages[1].reply_to,firstRequest.id);
  const foreign=store.enqueue(store.createConversation('Foreign').id,'Private');
  assert.equal((await fetch(`${base}/${c.id}/messages?ids=${foreign.id}`)).status,404);
  assert.equal((await fetch(`${base}/${c.id}/messages?ids=invalid`)).status,400);
  assert.equal((await fetch(`${base}/${c.id}?limit=1000`)).status,400);
  const controller=new AbortController(),stream=await fetch(`${base}/${c.id}/events`,{signal:controller.signal});
  const reader=stream.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);controller.abort();
  const snapshot=JSON.parse(first.match(/^data: (.+)$/m)[1]);assert.equal(snapshot.messages.length,40);
});

test('latest history keeps an older active clarification visible when many later requests are queued',()=>{
  const store=new ManagerStore(':memory:');try {
    const c=store.createConversation(),active=store.enqueue(c.id,'Active question');store.markRunning(active.id);
    store.addQuestion(active.id,[{id:'decision',header:'Choice',question:'Continue?',isOther:true,options:[]}]);
    for(let n=0;n<35;n++)store.enqueue(c.id,'Queued '+n);
    const latest=store.getConversationPage(c.id);
    assert.ok(latest.messages.some(message=>message.id===active.id&&message.questions[0].status==='pending'));
    assert.equal(latest.history.has_more,false);assert.equal(latest.history.before,active.id);
    assert.equal(latest.messages.length,1);assert.equal(latest.queue.length,35);
  }finally{store.close();}
});
