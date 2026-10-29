import {managerHistoryResponse} from './helpers/manager-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';

test('withdrawal pauses execution, preserves images, requeues at the tail and deletion is scoped',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),other=store.createConversation();
  const first=store.enqueue(c.id,'First',[{name:'fixture.png',mime:'image/png',width:1,height:1,size:1,bytes:Buffer.from([1])}]);
  const second=store.enqueue(c.id,'Second');
  assert.throws(()=>store.withdrawQueued(other.id,first.id),{code:'MESSAGE_NOT_FOUND'});
  assert.equal(store.withdrawQueued(c.id,first.id).status,'draft');
  assert.equal(store.next(c.id).id,second.id);
  assert.equal(store.queue(c.id).find(m=>m.id===first.id).attachments.length,1);
  assert.equal(store.requeue(c.id,first.id,'Edited').text,'Edited');
  assert.equal(store.next(c.id).id,second.id);
  store.markRunning(second.id);
  assert.throws(()=>store.withdrawQueued(c.id,second.id),{code:'MESSAGE_NOT_QUEUED'});
  assert.throws(()=>store.removeQueued(c.id,second.id),{code:'MESSAGE_NOT_QUEUED'});
  const image=store.message(first.id).attachments[0];
  store.removeQueued(c.id,first.id);
  assert.equal(store.queue(c.id).length,0);
  assert.equal(store.next(c.id),undefined);
  assert.throws(()=>store.getImage(c.id,image.id),{code:'IMAGE_NOT_FOUND'});
  assert.ok(!store.getConversationPage(c.id).messages.some(m=>m.id===first.id));
});

test('old withdrawn requests receive their history position on dispatch and unsent rows do not page sent history',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),old=store.enqueue(c.id,'Old withdrawn');store.withdrawQueued(c.id,old.id);
  for(let n=0;n<25;n++){const m=store.enqueue(c.id,'Newer '+n);store.markRunning(m.id);store.finish(m,null,'Reply '+n);}
  store.requeue(c.id,old.id,'Old now sent');store.markRunning(old.id);store.finish(old,null,'Latest reply');
  const latest=store.getConversationPage(c.id,{limit:1});
  assert.equal(latest.messages.find(m=>m.role==='user').id,old.id);
  const prior=store.getConversationPage(c.id,{limit:1,before:latest.history.before});
  assert.equal(prior.messages.find(m=>m.role==='user').text,'Newer 24');
  for(let n=0;n<30;n++)store.enqueue(c.id,'Unsent '+n);
  const flooded=store.getConversationPage(c.id,{limit:1});
  assert.equal(flooded.messages.find(m=>m.role==='user').id,old.id);
  assert.equal(flooded.queue.length,30);
});

test('accepted guidance pages with its parent request and final reply',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),parent=store.enqueue(c.id,'Parent');store.markRunning(parent.id);
  const guidance=store.enqueue(c.id,'Guidance');store.reserveSteer(c.id,guidance.id,parent.id,'synthetic-turn');store.settleSteer(guidance.id,'steered');store.finish(parent,null,'Guided reply');
  const next=store.enqueue(c.id,'Next request');store.markRunning(next.id);store.finish(next,null,'Next reply');
  const latest=store.getConversationPage(c.id,{limit:1});
  const previous=store.getConversationPage(c.id,{limit:1,before:latest.history.before});
  assert.deepEqual(previous.messages.filter(m=>m.role==='user').map(m=>m.id),[parent.id,guidance.id]);
  assert.ok(previous.messages.some(m=>m.reply_to===parent.id&&m.text==='Guided reply'));
});

async function fixture(t,{steerError,holdSteer=false,recovered=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),'manager-queue-')),store=new ManagerStore(join(root,'manager.sqlite'));
  const conversation=store.createConversation();
  await mkdir(join(root,'codex',conversation.id),{recursive:true});await writeFile(join(root,'codex',conversation.id,'auth.json'),'{}');
  const calls=[],listeners=new Set();let complete,release;
  const started=new Promise(resolve=>{complete=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const emit=(method,params)=>{for(const listener of listeners)listener({method,params});};
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',timeoutMs:10000,createClient:()=>({
    notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},
    async request(method,params){
      calls.push({method,params});
      const history=managerHistoryResponse(method,params,recovered);if(history)return history;
      if(method.startsWith('thread/'))return {thread:{id:'queue-thread',turns:recovered}};
      if(method==='turn/start'){complete();return {turn:{id:'queue-turn'}};}
      if(method==='turn/steer'){if(holdSteer)await held;if(steerError)throw new Error(steerError);return {turnId:'queue-turn'};}
      return {};
    },
  })});
  t.after(async()=>{release();await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const active=agent.enqueue(conversation.id,'Current task');await started;await new Promise(resolve=>setImmediate(resolve));
  return {store,agent,conversation,active,calls,release,finish:()=>emit('turn/completed',{threadId:'queue-thread',turn:{id:'queue-turn',status:'completed'}})};
}

test('native guidance uses the exact active turn once and never launches a second turn',async t=>{
  const f=await fixture(t),message=f.agent.enqueue(f.conversation.id,'Adjust the task',[{name:'fixture.png',mime:'image/png',width:1,height:1,size:1,bytes:Buffer.from([1])}]);
  const accepted=await f.agent.steerQueued(f.conversation.id,message.id);
  assert.equal(accepted.status,'steered');assert.equal(accepted.steer_parent_id,f.active.id);
  assert.deepEqual(f.calls.find(call=>call.method==='turn/steer').params,{
    threadId:'queue-thread',expectedTurnId:'queue-turn',clientUserMessageId:message.id,
    input:[{type:'text',text:`[management_message_id:${message.id}]\nAdjust the task`},{type:'image',url:'data:image/png;base64,AQ=='}],
  });
  await f.agent.steerQueued(f.conversation.id,message.id);
  assert.equal(f.calls.filter(call=>call.method==='turn/steer').length,1);
  f.finish();await f.agent.idle(f.conversation.id);
  assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(f.store.getConversation(f.conversation.id).messages.filter(m=>m.role==='assistant').length,1);
});

test('guidance reserves its row across completion and rejects competing withdrawal or duplicate sends',async t=>{
  const f=await fixture(t,{holdSteer:true}),message=f.agent.enqueue(f.conversation.id,'Guide while completing');
  const sending=f.agent.steerQueued(f.conversation.id,message.id);
  assert.equal(f.store.message(message.id).status,'steering');
  assert.throws(()=>f.store.withdrawQueued(f.conversation.id,message.id),{code:'MESSAGE_NOT_QUEUED'});
  await assert.rejects(f.agent.steerQueued(f.conversation.id,message.id),{code:'MESSAGE_NOT_QUEUED'});
  f.finish();f.release();await sending;await f.agent.idle(f.conversation.id);
  assert.equal(f.store.message(message.id).status,'steered');
  assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1);
});

test('uncertain guidance is visibly unconfirmed and never silently executed again',async t=>{
  const f=await fixture(t,{steerError:'CODEX_TIMEOUT'}),message=f.agent.enqueue(f.conversation.id,'Uncertain guidance');
  await assert.rejects(f.agent.steerQueued(f.conversation.id,message.id),{code:'STEER_UNCONFIRMED'});
  assert.equal(f.store.message(message.id).status,'steer_unknown');
  f.finish();await f.agent.idle(f.conversation.id);
  assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(f.store.queue(f.conversation.id)[0].status,'steer_unknown');
});

test('explicit guidance rejection leaves the request queued and cannot target another conversation',async t=>{
  const f=await fixture(t,{steerError:'CODEX_RPC_ERROR'}),message=f.agent.enqueue(f.conversation.id,'Still queued');
  await assert.rejects(f.agent.steerQueued(f.store.createConversation().id,message.id),{code:'MESSAGE_NOT_FOUND'});
  await assert.rejects(f.agent.steerQueued(f.conversation.id,message.id));
  assert.equal(f.store.message(message.id).status,'queued');
  f.store.removeQueued(f.conversation.id,message.id);f.finish();await f.agent.idle(f.conversation.id);
});

test('recorded native input reconciles ambiguous guidance at completion',async t=>{
  const turns=[],f=await fixture(t,{steerError:'CODEX_TIMEOUT',recovered:turns}),message=f.agent.enqueue(f.conversation.id,'Recorded guidance');
  await assert.rejects(f.agent.steerQueued(f.conversation.id,message.id));
  turns.push({id:'queue-turn',items:[{type:'userMessage',content:[{type:'text',text:`[management_message_id:${message.id}]\nRecorded guidance`}]}]});
  f.finish();await f.agent.idle(f.conversation.id);
  assert.equal(f.store.message(message.id).status,'steered');
  assert.equal(f.store.queue(f.conversation.id).length,0);
});

test('reserved input reconciles from recorded input without starting or resending a turn',async t=>{
  const f=await fixture(t),message=f.agent.enqueue(f.conversation.id,'Before restart');
  f.store.reserveSteer(f.conversation.id,message.id,f.active.id,'queue-turn');
  f.finish();await f.agent.idle(f.conversation.id);
  const recorded=[{id:'queue-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:`[management_message_id:${message.id}]\nBefore restart`}]}]}];
  await f.agent.reconcileSteers({request:async(method,params)=>managerHistoryResponse(method,params,recorded)},f.active.id,'queue-thread','queue-turn');
  assert.equal(f.store.message(message.id).status,'steered');
  assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(f.calls.filter(call=>call.method==='turn/steer').length,0);
});

test('persisted withdrawal and guidance survive reopening and completed native recovery never replays them',async t=>{
  const root=await mkdtemp(join(tmpdir(),'queue-reopen-')),path=join(root,'manager.sqlite');
  let store=new ManagerStore(path);
  const c=store.createConversation(),parent=store.enqueue(c.id,'Current request');
  store.thread(c.id,'recovery-thread');store.markRunning(parent.id);store.turn(parent.id,'recovery-turn');
  const guidance=store.enqueue(c.id,'Recovered guidance'),draft=store.enqueue(c.id,'Withdrawn draft');
  store.reserveSteer(c.id,guidance.id,parent.id,'recovery-turn');store.withdrawQueued(c.id,draft.id);store.close();
  store=new ManagerStore(path);
  await mkdir(join(root,'codex',c.id),{recursive:true});await writeFile(join(root,'codex',c.id,'auth.json'),'{}');
  const calls=[],agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',createClient:()=>({
    notify(){},async close(){},async request(method,params){calls.push(method);const history=managerHistoryResponse(method,params,[{id:'recovery-turn',status:'completed',items:[
      {type:'userMessage',content:[{type:'text',text:`[management_message_id:${parent.id}]\nCurrent request`}]},
      {type:'userMessage',content:[{type:'text',text:`[management_message_id:${guidance.id}]\nRecovered guidance`}]},
      {id:'answer',type:'agentMessage',text:'Recovered final response'},
    ]}]);return history??(method==='thread/resume'?{thread:{id:'recovery-thread',turns:[]}}:{});},
  })});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  await agent.recover();await agent.idle(c.id);
  assert.equal(store.message(parent.id).status,'completed');assert.equal(store.message(guidance.id).status,'steered');assert.equal(store.message(draft.id).status,'draft');
  assert.deepEqual(store.queue(c.id).map(m=>m.id),[draft.id]);
  assert.ok(!calls.includes('turn/start'));assert.ok(!calls.includes('turn/steer'));
});

test('authenticated queue actions and SSE expose authoritative state and keep foreign writes out',async t=>{
  const {createManagerServer}=await import('../src/manager/server.mjs');
  const f=await fixture(t),message=f.agent.enqueue(f.conversation.id,'Editable queued');
  const server=createManagerServer({store:f.store,agent:f.agent,auth:{authorize:req=>req.headers.authorization==='Bearer fixture'},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeEventStreams();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`,path=`${base}/admin/api/conversations/${f.conversation.id}/messages/${message.id}`;
  const headers={authorization:'Bearer fixture','content-type':'application/json'};
  assert.equal((await fetch(path+'/withdraw',{method:'POST'})).status,401);
  assert.equal((await fetch(path+'/withdraw',{method:'POST',headers:{...headers,origin:'https://foreign.invalid'}})).status,403);
  const control=new AbortController(),stream=await fetch(`${base}/admin/api/conversations/${f.conversation.id}/events`,{headers,signal:control.signal}),reader=stream.body.getReader();
  t.after(()=>control.abort());
  let buffer='';
  const next=async()=>{while(!buffer.includes('\n\n'))buffer+=new TextDecoder().decode((await reader.read()).value);const end=buffer.indexOf('\n\n'),value=buffer.slice(0,end);buffer=buffer.slice(end+2);return JSON.parse(value.match(/^data: (.+)$/m)[1]);};
  assert.deepEqual((await next()).queue.map(m=>m.id),[message.id]);
  const withdrawn=await fetch(path+'/withdraw',{method:'POST',headers});assert.equal(withdrawn.status,200);assert.equal((await withdrawn.json()).status,'draft');
  assert.equal((await next()).conversation.queue[0].status,'draft');
  const requeued=await fetch(path+'/requeue',{method:'POST',headers,body:JSON.stringify({text:'Edited queued'})});assert.equal(requeued.status,200);
  assert.equal((await fetch(path,{method:'DELETE',headers})).status,200);
  assert.deepEqual((await next()).conversation.queue,[]);
  assert.equal((await fetch(`${base}/admin/api/conversations/${f.conversation.id}` ,{headers}).then(res=>res.json())).queue.length,0);
  control.abort();f.finish();await f.agent.idle(f.conversation.id);
});
