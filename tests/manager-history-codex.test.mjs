import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexRpcClient} from '../src/codex/rpc.mjs';
import {initialize} from '../src/codex/session.mjs';
import {findRecordedTurn,forEachTurnItem,findRecordedMessageIds} from '../src/manager/history.mjs';

test('pinned Codex paged history preserves context across metadata-only resumes without replay',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-history-codex-'));
  const requests=[],clients=[],calls=[];
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/responses'){res.writeHead(404);res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    const index=requests.length;
    const events=[{type:'response.output_item.done',item:{id:'reply-'+index,type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic reply '+index}]}},{type:'response.completed',response:{id:'response-'+index,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
  });
  t.after(async()=>{
    await Promise.all(clients.map(client=>client.close()));server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const config={model_provider:'local_fixture',model_providers:{local_fixture:{name:'Synthetic history fixture',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}},web_search:'disabled'};
  async function open(threadId) {
    // An isolated HOME/CODEX_HOME and auth-free loopback model provider ensure
    // the pinned binary cannot use actual account authorization for this test.
    const client=new CodexRpcClient({command:fileURLToPath(new URL('../node_modules/.bin/codex',import.meta.url)),cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root,NO_PROXY:'127.0.0.1,localhost'},timeoutMs:10000});
    clients.push(client);await initialize(client);
    const response=await client.request(threadId?'thread/resume':'thread/start',{...(threadId?{threadId,excludeTurns:true}:{ephemeral:false}),cwd:root,model:'gpt-6.1-sol',approvalPolicy:'never',sandbox:'read-only',config});
    if(threadId)assert.deepEqual(response.thread.turns,[],'resume excludes all history payloads');
    return {client,threadId:response.thread.id};
  }
  async function send(client,threadId,id) {
    let resolve;const completed=new Promise(done=>{resolve=done;});
    const unsubscribe=client.subscribe(event=>{if(event.method==='turn/completed'&&event.params?.threadId===threadId)resolve(event.params.turn);});
    try {
      const started=await client.request('turn/start',{threadId,input:[{type:'text',text:`[management_message_id:${id}]\nSynthetic request ${id}`} ]});
      const result=await completed;assert.equal(result.id,started.turn.id);assert.equal(result.status,'completed');return result.id;
    }finally{unsubscribe();}
  }
  let session=await open(),threadId=session.threadId;
  const firstId=await send(session.client,threadId,'first');await session.client.close();
  session=await open(threadId);const secondId=await send(session.client,threadId,'second');await session.client.close();
  session=await open(threadId);const thirdId=await send(session.client,threadId,'third');
  assert.equal(requests.length,3);
  assert.ok(JSON.stringify(requests[2].input).includes('Synthetic request first'));
  assert.ok(JSON.stringify(requests[2].input).includes('Synthetic reply 1'));
  assert.ok(JSON.stringify(requests[2].input).includes('Synthetic request second'));
  const client={request(method,params){
    assert.ok(method==='thread/items/list'||method==='thread/turns/list');calls.push(method);
    return session.client.request(method,{...params,limit:1});
  }};
  // A stale saved ID must not defeat a newer native user marker. The completed
  // record is projected directly; read-only recovery performs no model replay.
  assert.deepEqual(await findRecordedTurn(client,{threadId,turnId:firstId,messageId:'third'}),{id:thirdId,status:'completed',error:null});
  assert.deepEqual(await findRecordedTurn(client,{threadId,messageId:'second'}),{id:secondId,status:'completed',error:null});
  const selected=[];await forEachTurnItem(client,{threadId,turnId:secondId},item=>selected.push(item));
  assert.equal(selected.find(item=>item.type==='agentMessage')?.text,'Synthetic reply 2');
  assert.ok(selected.find(item=>item.type==='userMessage').content.some(part=>part.type==='text'&&part.text.includes('[management_message_id:second]')));
  assert.deepEqual(await findRecordedMessageIds(client,{threadId,turnId:secondId,messageIds:['first','second','third']}),new Set(['second']));
  assert.ok(calls.filter(method=>method==='thread/items/list').length>3,'real cursors paginate item history');
  assert.ok(calls.filter(method=>method==='thread/turns/list').length>2,'real cursors paginate turn metadata');
  assert.equal(requests.length,3,'recovery history reads never replay completed work');
});
