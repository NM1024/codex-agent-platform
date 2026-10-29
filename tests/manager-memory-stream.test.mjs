import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {streamConversation} from '../src/manager/events.mjs';

const settle=()=>new Promise(resolve=>setTimeout(resolve,70));
async function nativeStream(t,store,id) {
  const auth={authorize:()=>true},server=createManagerServer({store,auth,agent:{},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const controller=new AbortController();
  t.after(async()=>{controller.abort();server.closeEventStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/admin/api/conversations/${id}/events`,{signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  return async()=>{
    while(true){
      const end=buffer.indexOf('\n\n');
      if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith(':'))continue;return {event:frame.match(/^event: (.+)$/m)[1],data:JSON.parse(frame.match(/^data: (.+)$/m)[1])};}
      const {value,done}=await reader.read();assert.equal(done,false,'stream must remain open after a valid large frame');buffer+=decoder.decode(value,{stream:true});
    }
  };
}

test('native SSE omits unchanged queue projections and sends every row after a queue revision',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const {id}=store.createConversation('Large synthetic queue'),active=store.enqueue(id,'Running request');store.markRunning(active.id);store.reply(active.id,'r'.repeat(128*1024));
  for(let n=0;n<199;n++)store.enqueue(id,`Queued ${n}:`+'q'.repeat(1024));
  await new Promise(resolve=>setImmediate(resolve));
  const next=await nativeStream(t,store,id),initial=await next();
  assert.equal(initial.event,'conversation');assert.equal(initial.data.queue.length,199);assert.equal(initial.data.messages[0].partial_text.length,128*1024);
  let queueReads=0;const queue=store.queue.bind(store);store.queue=(...args)=>{queueReads++;return queue(...args);};
  store.progress(active.id,{id:'status',kind:'status',label:'Working',text:'',status:'running'});
  const status=await next();assert.equal(status.event,'patch');assert.equal(Object.hasOwn(status.data.conversation,'queue'),false);assert.equal(queueReads,0);assert.ok(JSON.stringify(status).length<200*1024);
  const added=store.enqueue(id,'Last queued request'),changed=await next();assert.equal(changed.event,'patch');assert.equal(changed.data.conversation.queue.length,200);assert.equal(changed.data.conversation.queue.at(-1).id,added.id);assert.equal(queueReads,1);
});

class Response extends EventEmitter {
  writableLength=0;frames=[];blocked=false;writableEnded=false;
  writeHead(){}flushHeaders(){}
  write(frame){this.frames.push(frame);return !this.blocked;}
  end(){this.writableEnded=true;}
  destroy(){this.destroyed=true;this.emit('close');}
}

test('backpressured streams finish a valid frame and defer new projections until drain',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const {id}=store.createConversation('Backpressure'),message=store.enqueue(id,'Running request');store.markRunning(message.id);store.reply(message.id,'r'.repeat(128*1024));
  await new Promise(resolve=>setImmediate(resolve));
  const res=new Response();res.blocked=true;
  const close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  assert.equal(res.frames.length,1);assert.equal(JSON.parse(res.frames[0].match(/^data: (.+)$/m)[1]).messages[0].partial_text.length,128*1024);assert.equal(res.writableEnded,false);
  let reads=0;for(const method of ['metadata','message','queue','actionsPage','getConversationPage']){const original=store[method].bind(store);store[method]=(...args)=>{reads++;return original(...args);};}
  store.events.emit('change',{conversationId:id,messageId:message.id});await settle();
  assert.equal(reads,0,'blocked clients must not materialize another patch');assert.equal(res.frames.length,1);
  res.blocked=false;res.emit('drain');await settle();assert.equal(res.frames.length,2);assert.equal(JSON.parse(res.frames[1].match(/^data: (.+)$/m)[1]).messages[0].id,message.id);assert.equal(res.writableEnded,false);
});

test('large preexisting socket buffers close before reading a new projection',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const {id}=store.createConversation('Buffer guard');
  const res=new Response(),close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  let reads=0;const metadata=store.metadata.bind(store);store.metadata=(...args)=>{reads++;return metadata(...args);};
  res.writableLength=1048577;store.events.emit('change',{conversationId:id});await settle();
  assert.equal(reads,0);assert.equal(res.writableEnded,true);assert.equal(store.events.listenerCount('change'),0);
});

test('blocked streams bound pending message IDs by refreshing a durable snapshot after drain',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const {id}=store.createConversation('Bounded pending IDs');
  const res=new Response();res.blocked=true;const close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  for(let n=0;n<200;n++)store.events.emit('change',{conversationId:id,messageId:'synthetic-'+n});
  await settle();assert.equal(res.frames.length,1);res.blocked=false;res.emit('drain');await settle();
  assert.equal(res.frames.length,2);assert.match(res.frames[1],/^event: conversation\n/);
});

test('a stalled stream destroys the socket after allowing its accepted frame time to drain',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const {id}=store.createConversation('Stalled reader');
  const res=new Response();res.blocked=true;const close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  assert.equal(res.destroyed,undefined);assert.equal(res.frames.length,1);
  t.mock.timers.tick(15000);assert.equal(res.destroyed,true);assert.equal(res.writableEnded,false);assert.equal(store.events.listenerCount('change'),0);
});

for(const reason of ['deleted','shutdown'])test(`${reason} destroys a backpressured response instead of leaving its unfinished frame buffered`,t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const {id}=store.createConversation('Close blocked reader');
  const res=new Response();res.blocked=true;res.writableFinished=false;
  const close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  assert.equal(res.frames.length,1);assert.equal(res.destroyed,undefined);
  if(reason==='deleted')store.events.emit('change',{conversationId:id,deleted:true});else close();
  assert.equal(res.destroyed,true,'closing must release the blocked socket rather than merely ending queued output');
  assert.equal(res.writableEnded,false);assert.equal(store.events.listenerCount('change'),0);assert.equal(res.listenerCount('drain'),0);
});

test('legacy stores without queue revisions continue including the current queue',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const {id}=store.createConversation('Legacy store');store.queueVersion=undefined;
  const res=new Response(),close=streamConversation({req:{},res,store,auth:{authorize:()=>true},id});t.after(close);
  store.events.emit('change',{conversationId:id});await settle();assert.deepEqual(JSON.parse(res.frames[1].match(/^data: (.+)$/m)[1]).conversation.queue,[]);
});
