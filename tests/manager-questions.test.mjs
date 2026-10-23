import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {normalizeQuestions,validateAnswers} from '../src/manager/questions.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {allowedTool} from '../src/codex/tool-policy.mjs';
import {runtimeConfig} from '../src/codex/config.mjs';
import {createManagerServer} from '../src/manager/server.mjs';

const questions=[{id:'format',header:'Format',question:'Which output format?',isOther:true,options:[{label:'JSON',description:'Structured output'},{label:'Text',description:'Readable prose'}]}];
test('clarifications accept bounded choices/free text and reject secret collection or unknown answers',()=>{
  const q=normalizeQuestions(questions,['synthetic-private']);
  assert.equal(q[0].options.length,2);
  assert.deepEqual(validateAnswers(q,{format:{answers:['JSON']}}),{format:{answers:['JSON']}});
  assert.deepEqual(validateAnswers(q,{format:{answers:['CSV please']}}),{format:{answers:['CSV please']}});
  assert.throws(()=>validateAnswers(q,{}),{code:'INVALID_ANSWERS'});
  assert.throws(()=>validateAnswers(q,{format:{answers:['JSON']},extra:{answers:['x']}}),{code:'INVALID_ANSWERS'});
  assert.throws(()=>validateAnswers([{...q[0],isOther:false}],{format:{answers:['CSV']}}),{code:'INVALID_ANSWERS'});
  assert.throws(()=>normalizeQuestions([{...questions[0],isSecret:true}]),{code:'SECRET_QUESTION_DENIED'});
  assert.throws(()=>normalizeQuestions(Array(4).fill(questions[0])),{code:'INVALID_QUESTIONS'});
});

test('only management permits native clarification and its answer continues the exact original turn',async t=>{
  assert.equal(allowedTool('request_user_input',{},{}),false);
  assert.equal(allowedTool('request_user_input',{},{allowUserInput:true}),true);
  assert.equal(allowedTool('exec_command',{},{allowUserInput:true}),false);
  assert.equal(runtimeConfig({native:{},tools:[]},'http://local')['features.default_mode_request_user_input'],false);
  const root=await mkdtemp(join(tmpdir(),'question-agent-')),store=new ManagerStore(':memory:'),c=store.createConversation();
  await mkdir(join(root,'codex',c.id),{recursive:true});await writeFile(join(root,'codex',c.id,'auth.json'),'{}');
  let handler,reply,send,turns=0,answer;const received=new Promise(r=>reply=r);
  const listeners=new Set();send=e=>{for(const fn of listeners)fn(e);};
  const agent=new ManagementAgent({root,store,authFile:join(root,'unused'),mcpUrl:'http://local',timeoutMs:3000,createClient:()=>({
    notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},
    handleServerRequest(method,fn){assert.equal(method,'item/tool/requestUserInput');handler=fn;return()=>{};},
    async request(method,params){
      if(method==='thread/start'){assert.equal(params.config['features.default_mode_request_user_input'],true);return {thread:{id:'thread',turns:[]}};}
      if(method==='thread/read')return {thread:{id:'thread'}};
      if(method==='turn/start'){
        turns++;
        void handler({threadId:'thread',turnId:'turn',itemId:'question',questions},91).then(value=>{answer=value;reply();});
        return {turn:{id:'turn'}};
      }
      return {};
    }
  })});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const m=agent.enqueue(c.id,'Ask me for a format');
  const question=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{unwatch();reject(new Error('NO_QUESTION'));},1000);
    const check=()=>{const q=store.message(m.id).questions[0];if(q){clearTimeout(timer);unwatch();resolve(q);}};
    const unwatch=store.watch(c.id,check);check();
  });
  assert.equal(store.message(m.id).status,'running');
  await assert.rejects(handler({threadId:'foreign',turnId:'turn',itemId:'bad',questions},92),/QUESTION_EXPIRED/);
  const resolved=handler({threadId:'thread',turnId:'turn',itemId:'resolved',questions},93);
  await new Promise(setImmediate);
  send({method:'serverRequest/resolved',params:{threadId:'thread',requestId:93}});
  await assert.rejects(resolved,/QUESTION_EXPIRED/);
  assert.equal(store.message(m.id).questions.at(-1).status,'expired');
  assert.throws(()=>agent.answerQuestion(store.createConversation().id,question.id,{format:{answers:['JSON']}}),{code:'QUESTION_NOT_FOUND'});
  agent.answerQuestion(c.id,question.id,{format:{answers:['JSON']}});await received;
  assert.deepEqual(answer,{answers:{format:{answers:['JSON']}}});assert.equal(turns,1);
  assert.throws(()=>agent.answerQuestion(c.id,question.id,{format:{answers:['Text']}}),{code:'QUESTION_EXPIRED'});
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'final',text:'JSON selected'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});await agent.idle(c.id);
  assert.equal(store.getConversation(c.id).messages.at(-1).text,'JSON selected');
});

test('questions persist on their message, answer once, expire on interruption and are removed with history',()=>{
  const store=new ManagerStore(':memory:');
  try{
    const c=store.createConversation(),other=store.createConversation(),m=store.enqueue(c.id,'Synthetic');store.markRunning(m.id);
    const q=store.addQuestion(m.id,normalizeQuestions(questions));
    assert.equal(store.message(m.id).questions[0].status,'pending');
    assert.throws(()=>store.answerQuestion(other.id,q.id,{format:{answers:['JSON']}}),{code:'QUESTION_NOT_FOUND'});
    const answered=store.answerQuestion(c.id,q.id,{format:{answers:['JSON']}});
    assert.equal(answered.status,'answered');
    assert.throws(()=>store.answerQuestion(c.id,q.id,{format:{answers:['Text']}}),{code:'QUESTION_EXPIRED'});
    const pending=store.addQuestion(m.id,normalizeQuestions(questions));store.interrupted(m.id);
    assert.equal(store.message(m.id).questions.at(-1).status,'expired');
    assert.throws(()=>store.answerQuestion(c.id,pending.id,{format:{answers:['JSON']}}),{code:'QUESTION_EXPIRED'});
    store.finish(m,null,'Done');store.deleteConversation(c.id);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM manager_questions').get().n,0);
  }finally{store.close();}
});

test('answer HTTP route requires a human session and same origin and never creates another message',async t=>{
  const store=new ManagerStore(':memory:'),c=store.createConversation(),m=store.enqueue(c.id,'Synthetic');store.markRunning(m.id);
  const q=store.addQuestion(m.id,normalizeQuestions(questions));let calls=0;
  const server=createManagerServer({store,operations:{},metrics:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human'},agent:{answerQuestion(id,questionId,answers){calls++;return store.answerQuestion(id,questionId,answers);}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,url=`${base}/admin/api/conversations/${c.id}/questions/${q.id}/answer`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const send=headers=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({answers:{format:{answers:['JSON']}}})});
  assert.equal((await send({})).status,401);
  assert.equal((await send({cookie:'synthetic-human',origin:'https://foreign.invalid'})).status,403);
  assert.equal(calls,0);assert.equal((await send({cookie:'synthetic-human',origin:base})).status,200);assert.equal(calls,1);
  assert.equal(store.getConversation(c.id).messages.length,1);
  assert.equal((await send({cookie:'synthetic-human'})).status,409);
});
