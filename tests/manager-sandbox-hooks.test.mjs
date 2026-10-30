import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';

const fileId='00000000-0000-4000-8000-000000000001';
test('conversation deletion immediately attempts scoped sandbox cleanup and reports remaining work',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs');
  for(const failed of [0,1]){
    const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic sandbox cleanup'),calls=[];
    const agent=new ManagementAgent({store,root:'/tmp/synthetic-sandbox-not-used',sandbox:{async cleanup(options){calls.push(options);return {cleaned:failed?0:1,failed};}}});
    agent.cleanupConversationFiles=async()=>true;
    const result=await agent.deleteConversation(conversation.id);
    assert.deepEqual(calls,[{conversationId:conversation.id}]);assert.equal(!!result.cleanup_pending,!!failed);
  }
});
test('file-only messages require a configured owning attachment hook and expose accepted files',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic file message');
  assert.throws(()=>store.enqueue(conversation.id,'',[],[fileId]));
  const attached=new Map();store.attachMessageFiles=(id,messageId,ids)=>{assert.equal(id,conversation.id);assert.deepEqual(ids,[fileId]);attached.set(messageId,[{file_id:fileId,name:'input.csv',size:8,mime:'text/csv'}]);};
  store.messageFiles=messageId=>attached.get(messageId)??[];
  const message=store.enqueue(conversation.id,'',[],[fileId]);assert.equal(message.text,'');assert.equal(store.message(message.id).files[0].file_id,fileId);
});

test('attachment failure rolls back message and queue admission rather than accepting work without inputs',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic invalid attachment');
  store.attachMessageFiles=()=>{throw Object.assign(new Error('Foreign file'),{code:'FILE_NOT_FOUND'});};
  assert.throws(()=>store.enqueue(conversation.id,'Process the supplied file',[],[fileId]),{code:'FILE_NOT_FOUND'});
  assert.equal(store.getConversation(conversation.id).messages.length,0);assert.equal(store.queue(conversation.id).length,0);
});

test('file-only steering carries safe attachment IDs into the existing Codex turn',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs');
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic file steer');
  const attachments=new Map();store.attachMessageFiles=(_,messageId)=>attachments.set(messageId,[{file_id:fileId,name:'sample.csv',mime:'text/csv',size:8}]);store.messageFiles=messageId=>attachments.get(messageId)??[];
  const parent=store.enqueue(conversation.id,'Synthetic active turn');store.markRunning(parent.id);
  const child=store.enqueue(conversation.id,'',[],[fileId]),calls=[];
  const agent=new ManagementAgent({store,root:'/tmp/synthetic-sandbox-not-used',authFile:'/tmp/synthetic-auth-not-read',mcpUrl:'http://127.0.0.1:9/mcp'});
  agent.active.set(parent.id,{conversationId:conversation.id,turnId:'synthetic-turn',threadId:'synthetic-thread',finalized:false,steers:new Set(),client:{async request(method,params){calls.push({method,params});return {turnId:'synthetic-turn'};}}});
  await agent.steerQueued(conversation.id,child.id);
  assert.equal(calls.length,1);assert.ok(calls[0].params.input[0].text.includes(fileId));assert.ok(calls[0].params.input[0].text.includes('sample.csv'));
});

test('approval continuation remains independently queued and cannot be steered into a different message authority',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs');const store=new ManagerStore(':memory:');t.after(()=>store.close());const conversation=store.createConversation('Synthetic permission steer');
  const parent=store.enqueue(conversation.id,'Synthetic active turn');store.markRunning(parent.id);const continuation=store.enqueue(conversation.id,'Human approved exact sandbox operation');
  store.canSteerMessage=messageId=>messageId!==continuation.id;
  const agent=new ManagementAgent({store,root:'/tmp/synthetic-sandbox-not-used',authFile:'/tmp/synthetic-auth-not-read',mcpUrl:'http://127.0.0.1:9/mcp'});let calls=0;
  agent.active.set(parent.id,{conversationId:conversation.id,turnId:'synthetic-turn',threadId:'synthetic-thread',finalized:false,steers:new Set(),client:{async request(){calls++;return {turnId:'synthetic-turn'};}}});
  assert.equal(store.message(continuation.id).steerable,false);
  await assert.rejects(agent.steerQueued(conversation.id,continuation.id),{code:'MESSAGE_STEER_DISABLED'});
  assert.equal(calls,0);assert.equal(store.message(continuation.id).status,'queued');
});
