import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';

async function validatingRound(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const root=await mkdtemp(join(tmpdir(),'synthetic-validation-')),store=new ManagerStore(':memory:');
  const catalog={data:[{model:'synthetic-model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null};
  const entered=Promise.withResolvers(),validation=Promise.withResolvers(),listeners=new Set(),calls=[];
  const emit=event=>{for(const listener of listeners)listener(event);};
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused-auth.json'),mcpUrl:'http://example.invalid/mcp',model:'synthetic-model',timeoutMs:1000,createClient:()=>({
    notify(){},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},async close(){},
    async request(method,params){
      calls.push({method,params});
      if(method==='model/list'){entered.resolve();return validation.promise;}
      if(method==='thread/start')return {thread:{id:'synthetic-thread'}};
      if(method==='turn/start'){
        setImmediate(()=>emit({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn',status:'completed'}}}));
        return {turn:{id:'synthetic-turn'}};
      }
      return {};
    },
  })});
  agent.reasoningEffort='low';
  t.after(async()=>{validation.resolve(catalog);await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const conversation=store.createConversation('Synthetic validation'),message=agent.enqueue(conversation.id,'Synthetic task');
  await entered.promise;
  return {agent,store,conversation,message,calls,emit,validation,catalog,finished:agent.running.get(conversation.id)};
}

for(const rejects of [false,true])test(`timeout during model validation prevents native start when validation ${rejects?'rejects':'returns'}`,async t=>{
  const {store,conversation,message,calls,validation,catalog,finished}=await validatingRound(t);
  t.mock.timers.tick(1000);
  if(rejects)validation.reject(new Error('Synthetic catalog failure'));else validation.resolve(catalog);
  await finished;
  assert.equal(calls.some(call=>call.method==='turn/start'),false);
  assert.equal(store.message(message.id).status,'failed');
  assert.equal(store.message(message.id).error.code,'MANAGEMENT_TIMEOUT');
  store.recover();assert.equal(store.next(conversation.id),undefined);
});

test('transport close during model validation prevents native start and retains recovery',async t=>{
  const {store,message,calls,emit,validation,catalog,finished}=await validatingRound(t);
  emit({method:'transport/closed'});validation.resolve(catalog);await finished;
  assert.equal(calls.some(call=>call.method==='turn/start'),false);
  assert.equal(store.message(message.id).status,'interrupted');
});

test('shutdown during model validation prevents native start and retains recovery',async t=>{
  const {agent,store,message,calls,validation,catalog}=await validatingRound(t);
  const stopped=agent.stop();validation.resolve(catalog);await stopped;
  assert.equal(calls.some(call=>call.method==='turn/start'),false);
  assert.equal(store.message(message.id).status,'interrupted');
});

test('human stop during model validation prevents native start and stays terminal',async t=>{
  const {agent,store,conversation,message,calls,validation,catalog,finished}=await validatingRound(t);
  await agent.interrupt(conversation.id,message.id);validation.resolve(catalog);await finished;
  assert.equal(calls.some(call=>call.method==='turn/start'),false);
  assert.equal(store.message(message.id).status,'failed');
  assert.equal(store.message(message.id).error.code,'MANAGEMENT_STOPPED');
  store.recover();assert.equal(store.next(conversation.id),undefined);
});

test('successful model validation still starts and completes a native turn',async t=>{
  const {store,message,calls,validation,catalog,finished}=await validatingRound(t);
  validation.resolve(catalog);await finished;
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(store.message(message.id).status,'completed');
});
