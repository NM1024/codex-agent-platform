import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {ChatProgress} from '../src/manager/chat-progress.mjs';

test('public reply items survive final completion and repeated event IDs update in place',()=>{
  const store=new ManagerStore(':memory:');
  try{
    const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic request');store.markRunning(m.id);
    const p=new ChatProgress({store,messageId:m.id,secrets:['synthetic-private-token']});
    const done=(id,text)=>p.event({method:'item/completed',params:{item:{type:'agentMessage',id,text}}});
    done('commentary','I will check the queue.');
    p.event({method:'item/agentMessage/delta',params:{itemId:'final',delta:'Queue '}});
    assert.deepEqual(store.message(m.id).replies.map(r=>r.text),['I will check the queue.','Queue ']);
    done('final','Queue checked: synthetic-private-token');done('final','Queue checked: synthetic-private-token');p.finish();
    store.finish(m,null,p.text);
    const saved=store.getConversation(c.id),source=saved.messages[0];
    assert.equal(source.replies.length,2);assert.equal(source.replies[0].text,'I will check the queue.');
    assert.match(source.replies[1].text,/REDACTED/);assert.equal(source.replies[1].status,'completed');
    assert.equal(saved.messages.at(-1).text,source.replies[1].text);
    assert.ok(!JSON.stringify(saved).includes('synthetic-private-token'));
  }finally{store.close();}
});

test('an interrupted trailing stream flushes its own public item and does not duplicate earlier commentary as final output',()=>{
  const store=new ManagerStore(':memory:');
  try{
    const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic');store.markRunning(m.id);
    const p=new ChatProgress({store,messageId:m.id});
    p.event({method:'item/completed',params:{item:{type:'agentMessage',id:'commentary',text:'Checking now.'}}});
    p.event({method:'item/agentMessage/delta',params:{itemId:'partial',delta:'Partial answer'}});
    p.finish('failed');store.finish(m,{code:'SYNTHETIC_STOP',message:'Stopped'},p.text);
    assert.equal(store.message(m.id).replies.at(-1).text,'Partial answer');
    assert.equal(store.getConversation(c.id).messages.at(-1).text,'Partial answer');
  }finally{store.close();}
});
