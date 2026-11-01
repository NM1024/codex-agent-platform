import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
test('human stop targets an exact round and never becomes restart recovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-stop-')),store=new ManagerStore(':memory:');
 const calls=[],listeners=new Set();let started,cancellations=0;const ready=new Promise(resolve=>started=resolve);
 const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:'http://example.invalid/mcp',sandbox:{async cancelMessage(){cancellations++;}},createClient:()=>({notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method,params){calls.push({method,params});if(method==='thread/start')return {thread:{id:'synthetic-thread'}};if(method==='turn/start'){setImmediate(()=>started());return {turn:{id:'synthetic-turn'}};}return {};}})});
 t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
 const conversation=store.createConversation('Synthetic stop'),message=agent.enqueue(conversation.id,'Synthetic task');await ready;
 await assert.rejects(()=>agent.interrupt(conversation.id,'00000000-0000-0000-0000-000000000000'),{status:409});
 for(const fn of listeners)fn({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'partial',delta:'Synthetic partial reply'}});
 await agent.interrupt(conversation.id,message.id);await agent.idle(conversation.id);
 assert.equal(cancellations,1);assert.equal(calls.filter(call=>call.method==='turn/interrupt').length,1);
 assert.deepEqual(calls.find(call=>call.method==='turn/interrupt').params,{threadId:'synthetic-thread',turnId:'synthetic-turn'});
 assert.equal(store.message(message.id).status,'failed');assert.equal(store.message(message.id).error.code,'MANAGEMENT_STOPPED');
 assert.equal(store.getConversation(conversation.id).messages.find(item=>item.role==='assistant').text,'Synthetic partial reply');
 store.recover();assert.equal(store.next(conversation.id),undefined);
});
test('stopping during initialization persists a terminal record before shutdown and never starts a native turn',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-start-stop-')),store=new ManagerStore(':memory:');let initialized,release;
 const started=new Promise(resolve=>initialized=resolve),gate=new Promise(resolve=>release=resolve),calls=[];
 const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:'http://example.invalid/mcp',createClient:()=>({notify(){},subscribe(){return()=>{};},async close(){release({});},async request(method){calls.push(method);if(method==='initialize'){initialized();return gate;}return {};}})});
 t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
 const conversation=store.createConversation('Synthetic start stop'),other=store.createConversation('Synthetic other'),message=agent.enqueue(conversation.id,'Synthetic task');await started;
 await assert.rejects(()=>agent.interrupt(other.id,message.id),{status:409});assert.equal(store.message(message.id).status,'running');
 await agent.interrupt(conversation.id,message.id);assert.equal(store.message(message.id).status,'failed');
 await agent.idle(conversation.id);assert.equal(calls.includes('turn/start'),false);store.recover();assert.equal(store.next(conversation.id),undefined);
});
test('FIFO waits for the single cancellation cleanup before starting the next queued round',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-stop-fifo-')),store=new ManagerStore(':memory:');let started,ack;
 const ready=new Promise(resolve=>started=resolve),acknowledged=new Promise(resolve=>ack=resolve),events=[];let turns=0;
 const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:'http://example.invalid/mcp',sandbox:{async cancelMessage(){events.push('cancel');}},createClient:()=>{
  const listeners=new Set();return {notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method){
   if(method==='thread/start'||method==='thread/resume')return {thread:{id:'synthetic-fifo-thread'}};
   if(method==='turn/interrupt')return acknowledged;
   if(method==='turn/start'){const turn=++turns;events.push('start '+turn);setImmediate(()=>{if(turn===1)started();else for(const fn of listeners)fn({method:'turn/completed',params:{threadId:'synthetic-fifo-thread',turn:{id:'turn-'+turn,status:'completed'}}});});return {turn:{id:'turn-'+turn}};}
   return {};
  }};
 }});
 t.after(async()=>{ack({});await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
 const conversation=store.createConversation('Synthetic FIFO'),first=agent.enqueue(conversation.id,'Synthetic first');await ready;
 const stopping=agent.interrupt(conversation.id,first.id);const next=agent.enqueue(conversation.id,'Synthetic next');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(store.message(next.id).status,'queued');assert.deepEqual(events,['start 1']);
 ack({});await stopping;await agent.idle(conversation.id);assert.deepEqual(events,['start 1','cancel','start 2']);assert.equal(store.message(next.id).status,'completed');
});
