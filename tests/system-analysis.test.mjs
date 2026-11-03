import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerServer} from '../src/manager/server.mjs';

test('explicit system analysis validates exact references and enqueues one bounded new management conversation',async t=>{
 const store=new ManagerStore(':memory:');t.after(()=>store.close());let available=true,found=true;const reads=[],enqueues=[];
 const id='manager:work:cleanup';
 const operations={async execute(action,args){reads.push({action,args});return {work:found?{id}:null,sources:[{service:'manager',available,observed_at:1,error_code:available?null:'SYSTEM_SOURCE_UNAVAILABLE'}]};}};
 const agent={enqueue(conversationId,text){enqueues.push({conversationId,text});return store.enqueue(conversationId,text);}};
 const server=createManagerServer({store,agent,operations,metrics:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human'}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`,post=(body,headers={cookie:'synthetic-human'})=>fetch(base+'/admin/api/conversations',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post({system_reference:{id}},{})).status,401);
 assert.equal((await post({system_reference:{id}},{cookie:'synthetic-human',origin:'https://other.example'})).status,403);
 for(const body of [{system_reference:{id:'manager:event:1'}},{system_reference:{id:'../private'}},{system_reference:{id,command:'shell'}},{system_reference:{id,intent:'retry'}},{system_reference:{id,intent:'diagnose'}},{system_reference:{id,intent:'issue_draft'}},{system_reference:{id,intent:null}},{system_reference:{id,intent:4}},{system_reference:{id},attachments:[]},{system_reference:{id},text:'Untrusted prompt'},{system_reference:null},{system_reference:[id]}])assert.equal((await post(body)).status,400,JSON.stringify(body));
 assert.equal(enqueues.length,0);
 for(let click=0;click<2;click++){
  const response=await post({system_reference:{id}});assert.equal(response.status,201);const conversation=await response.json();
  assert.equal(conversation.queue.length,1);assert.equal(conversation.queue[0].text,enqueues.at(-1).text);assert.ok(enqueues.at(-1).text.includes(id));assert.ok(enqueues.at(-1).text.includes('system_issue'));assert.ok(enqueues.at(-1).text.length<1500);
 }
 assert.notEqual(enqueues[0].conversationId,enqueues[1].conversationId);assert.deepEqual(reads.at(-1),{action:'system_issue',args:{id}});
 found=false;assert.equal((await post({system_reference:{id}})).status,404);
 found=true;available=false;assert.equal((await post({system_reference:{id}})).status,503);assert.equal(enqueues.length,2);
});
