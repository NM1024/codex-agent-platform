import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';

async function fixture(t){
  const store=new ManagerStore(':memory:'),conversation=store.createConversation('Synthetic concurrent settings');
  const server=createManagerServer({store,auth:{authorize:()=>true},agent:{},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeEventStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const url=`http://127.0.0.1:${server.address().port}/admin/api/conversations/${conversation.id}`;
  const save=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {store,conversation,save};
}

test('browser settings compare the original execution before replacing a concurrent model change',async t=>{
  const {store,conversation,save}=await fixture(t);
  const first=await save({execution:{model:'synthetic-model'},expected_execution:{}});assert.equal(first.status,200);
  const stale=await save({execution:{serviceTier:'priority'},expected_execution:{}});
  assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'CONVERSATION_EXECUTION_CONFLICT');
  assert.deepEqual(store.metadata(conversation.id).execution,{model:'synthetic-model'});
  const next=await save({execution:{model:'synthetic-model',serviceTier:'priority'},expected_execution:{model:'synthetic-model'}});
  assert.equal(next.status,200);assert.deepEqual(store.metadata(conversation.id).execution,{model:'synthetic-model',serviceTier:'priority'});
});

test('browser settings cannot bypass conflict protection by omitting or corrupting the original execution',async t=>{
  const {store,conversation,save}=await fixture(t);
  for(const expected of [undefined,null,[],{unexpected:true},'invalid']){
    const response=await save({execution:{verbosity:'low'},...(expected===undefined?{}:{expected_execution:expected})});
    assert.equal(response.status,400);assert.deepEqual(store.metadata(conversation.id).execution,{});
  }
});
