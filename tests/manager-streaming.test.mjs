import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {ChatProgress} from '../src/manager/chat-progress.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {streamConversation} from '../src/manager/events.mjs';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,symlink,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

async function setup(t) {
  const store=new ManagerStore(':memory:'),access={allowed:true};
  const auth={authorize:req=>access.allowed&&req.headers.cookie==='synthetic-human-session'};
  const agent={deleteConversation:id=>store.deleteConversation(id)};
  const server=createManagerServer({store,auth,agent,operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const controllers=[];
  t.after(async()=>{for(const controller of controllers)controller.abort();server.closeEventStreams?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}/admin/api`,headers={cookie:'synthetic-human-session'};
  const connect=async id=>{
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(`${base}/conversations/${id}/events`,{headers,signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
    assert.equal(response.headers.get('x-accel-buffering'),'no');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    const next=async()=>{
      let timer;
      try{return await Promise.race([(async()=>{while(true){const boundary=buffer.indexOf('\n\n');if(boundary>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);if(frame.startsWith(':'))continue;return {event:frame.match(/^event: (.+)$/m)?.[1],data:JSON.parse(frame.match(/^data: (.+)$/m)?.[1]??'{}')};}const chunk=await reader.read();if(chunk.done)return null;buffer+=decoder.decode(chunk.value,{stream:true});}})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSE_FRAME_TIMEOUT')),2000);})]);}finally{clearTimeout(timer);}
    };
    return {next,abort:()=>controller.abort()};
  };
  return {store,access,server,base,headers,connect};
}

test('conversation streams deliver snapshots, isolated reply patches, completion and reconnect without resubmission',async t=>{
  const {store,connect}=await setup(t),conversation=store.createConversation('Synthetic live'),other=store.createConversation('Other');
  const stream=await connect(conversation.id),initial=await stream.next();assert.equal(initial.event,'conversation');assert.equal(initial.data.id,conversation.id);
  const foreign=store.enqueue(other.id,'Other request');store.markRunning(foreign.id);store.reply(foreign.id,'Foreign private text');
  const message=store.enqueue(conversation.id,'Synthetic request');store.markRunning(message.id);store.reply(message.id,'First live words ');
  const patch=await stream.next();assert.equal(patch.event,'patch');assert.equal(patch.data.messages[0].partial_text,'First live words ');assert.ok(!JSON.stringify(patch).includes('Foreign private'));
  store.finish(message,null,'Complete final answer');
  const completed=await stream.next();assert.equal(completed.event,'patch');assert.equal(completed.data.messages.find(row=>row.id===message.id).status,'completed');assert.ok(completed.data.messages.some(row=>row.reply_to===message.id&&row.text==='Complete final answer'));
  stream.abort();const restored=await connect(conversation.id);assert.equal((await restored.next()).data.messages.length,2);
});

test('stream authentication is rechecked before exposing later updates and unknown conversations fail normally',async t=>{
  const {store,connect,access,base,headers}=await setup(t),conversation=store.createConversation('Private');
  assert.equal((await fetch(`${base}/conversations/${conversation.id}/events`)).status,401);
  assert.equal((await fetch(`${base}/conversations/00000000-0000-4000-8000-000000000000/events`,{headers})).status,404);
  const stream=await connect(conversation.id);await stream.next();access.allowed=false;store.enqueue(conversation.id,'Must never be exposed');
  const expired=await stream.next();assert.equal(expired.event,'session-expired');assert.ok(!JSON.stringify(expired).includes('Must never'));assert.equal(await stream.next(),null);
});

test('public live reply text exceeds the activity budget without leaking split credentials or raw reasoning',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation('Large reply'),message=store.enqueue(conversation.id,'Synthetic');store.markRunning(message.id);
    const progress=new ChatProgress({store,messageId:message.id,secrets:['synthetic-private-token']});
    const delta=value=>{progress.event({method:'item/agentMessage/delta',params:{itemId:'reply',delta:value}});t.mock.timers.tick(40);};
    delta('Readable '.repeat(1400));assert.ok(store.getConversation(conversation.id).messages[0].partial_text.length>8192);
    delta('synthetic-private-');assert.ok(!store.getConversation(conversation.id).messages[0].partial_text.includes('synthetic-private-'));
    delta('token ');assert.ok(!store.getConversation(conversation.id).messages[0].partial_text.includes('synthetic-private-token'));
    progress.event({method:'item/reasoning/textDelta',params:{itemId:'hidden',delta:'RAW_PRIVATE_REASONING'}});
    assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes('RAW_PRIVATE_REASONING'));
    progress.finish('unknown');
  } finally {store.close();}
});

test('Chinese replies stream before whitespace while credential-like suffixes stay private',()=>{
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation('中文流式'),message=store.enqueue(conversation.id,'测试');store.markRunning(message.id);
    const progress=new ChatProgress({store,messageId:message.id,secrets:['synthetic-private-token']});
    const delta=value=>progress.event({method:'item/agentMessage/delta',params:{itemId:'reply',delta:value}});
    delta('正在检查当前');assert.equal(store.message(message.id).partial_text,'正在检查当前');
    delta('任务状态。synthetic-');assert.equal(store.message(message.id).partial_text,'正在检查当前任务状态。');
    delta('private-token，检查完成。');assert.ok(!store.message(message.id).partial_text.includes('synthetic-private-token'));assert.match(store.message(message.id).partial_text,/检查完成/);
  }finally{store.close();}
});

test('deleting ended conversation removes owned records, emits deletion and preserves unrelated history',async t=>{
  const {store,connect,base,headers}=await setup(t),conversation=store.createConversation('Delete'),other=store.createConversation('Keep');
  const message=store.enqueue(conversation.id,'Synthetic',[{name:'pixel.png',mime:'image/png',width:1,height:1,size:1,bytes:Buffer.from([1])}]);store.markRunning(message.id);store.progress(message.id,{id:'tool',kind:'tool',label:'overview',text:'',status:'completed'});store.finishAction(store.beginAction(conversation.id,'overview'),{});store.finish(message,null,'Done');
  const image=store.getConversation(conversation.id).messages[0].attachments[0];
  const stream=await connect(conversation.id);await stream.next();
  const denied=await fetch(`${base}/conversations/${conversation.id}`,{method:'DELETE',headers:{...headers,origin:'https://foreign.invalid'}});assert.equal(denied.status,403);
  const response=await fetch(`${base}/conversations/${conversation.id}`,{method:'DELETE',headers});assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
  assert.equal((await stream.next()).event,'deleted');assert.equal(await stream.next(),null);
  assert.throws(()=>store.getConversation(conversation.id),{code:'CONVERSATION_NOT_FOUND'});assert.throws(()=>store.getImage(conversation.id,image.id),{code:'IMAGE_NOT_FOUND'});
  for(const table of ['manager_messages','manager_actions','manager_chat_images','manager_message_activity'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  assert.equal(store.getConversation(other.id).title,'Keep');
});

test('queued running and interrupted conversations cannot be deleted',async t=>{
  const {store,base,headers}=await setup(t);
  for(const state of ['queued','running','interrupted']) {
    const conversation=store.createConversation(state),message=store.enqueue(conversation.id,'Pending');
    if(state!=='queued')store.markRunning(message.id);if(state==='interrupted')store.interrupted(message.id);
    const response=await fetch(`${base}/conversations/${conversation.id}`,{method:'DELETE',headers});assert.equal(response.status,409);
    assert.equal((await response.json()).error.code,'CONVERSATION_BUSY');assert.equal(store.getConversation(conversation.id).messages.length,1);
  }
});

test('stream backpressure and shutdown close subscriptions and reject reconnects during shutdown',async t=>{
  const {store,server,base,headers,connect}=await setup(t),conversation=store.createConversation('Bounded stream');
  class Response extends EventEmitter {writableLength=1048577;frames=[];writeHead(){}flushHeaders(){}write(value){this.frames.push(value);}end(){this.writableEnded=true;}}
  const res=new Response();streamConversation({req:{},res,store,auth:{authorize:()=>true},id:conversation.id});
  assert.equal(res.writableEnded,true);assert.equal(store.events.listenerCount('change'),0);assert.equal(res.frames.length,0);
  const stream=await connect(conversation.id);await stream.next();
  server.closeEventStreams();assert.equal(await stream.next(),null);assert.equal(store.events.listenerCount('change'),0);
  assert.equal((await fetch(`${base}/conversations/${conversation.id}/events`,{headers})).status,503);
});

test('deletion also removes local thread homes without following the shared login symlink',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-deletion-')),store=new ManagerStore(':memory:');
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const conversation=store.createConversation('Local cleanup'),source=join(root,'synthetic-shared-login.json');await writeFile(source,'{"synthetic":true}');
  for(const directory of ['codex','work'])await mkdir(join(root,directory,conversation.id),{recursive:true});
  await symlink(source,join(root,'codex',conversation.id,'auth.json'));
  await writeFile(join(root,'work',conversation.id,'synthetic.txt'),'owned');
  const agent=new ManagementAgent({store,root});
  agent.running.set(conversation.id,Promise.resolve());await assert.rejects(agent.deleteConversation(conversation.id),{code:'CONVERSATION_BUSY'});agent.running.clear();
  assert.equal((await agent.deleteConversation(conversation.id)).deleted,true);
  for(const directory of ['codex','work'])await assert.rejects(lstat(join(root,directory,conversation.id)),{code:'ENOENT'});
  assert.equal(await readFile(source,'utf8'),'{"synthetic":true}');
});

test('live reply survives reopen and recovery without replaying terminal work',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-live-persistence-')),path=join(root,'manager.sqlite');let store=new ManagerStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const conversation=store.createConversation('Durable live reply'),message=store.enqueue(conversation.id,'Synthetic');store.markRunning(message.id);store.reply(message.id,'Persisted partial reply');store.close();
  store=new ManagerStore(path);store.recover();
  const interrupted=store.getConversation(conversation.id).messages[0];assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.partial_text,'Persisted partial reply');
  store.markRunning(message.id);store.finish(message,null,'Complete durable final reply');store.close();
  store=new ManagerStore(path);assert.equal(store.recover(),0);
  const saved=store.getConversation(conversation.id);assert.equal(saved.messages.length,2);assert.equal(saved.messages[0].partial_text,null);assert.equal(saved.messages[1].text,'Complete durable final reply');
});
