import test from 'node:test';
import assert from 'node:assert/strict';

// These fixtures model only the two pinned app-server history endpoints. Any
// accidental full-thread read, resume or replay fails at the boundary.
const marker=id=>`[management_message_id:${id}]`;
const entry=(turnId,id,text,type='userMessage')=>({turnId,item:{id,type,...(type==='userMessage'?{content:[{type:'text',text}]}:{text})}});
const turn=(id,status='completed')=>({id,status,items:[],itemsView:'notLoaded',error:null});
const load=()=>import('../src/manager/history.mjs');
function history({items=[],turns=[],pageSize=2}={}) {
  return {async request(method,params) {
    assert.equal(params.threadId,'thread');
    assert.ok(Number.isInteger(params.limit)&&params.limit>0&&params.limit<=64,'bounded page size');
    assert.ok(method==='thread/items/list'||method==='thread/turns/list','only paged history endpoints');
    if(method==='thread/turns/list') {
      assert.equal(params.sortDirection,'desc');assert.equal(params.itemsView,'notLoaded');
    }
    let data=method==='thread/turns/list'?[...turns].reverse():items.filter(row=>!params.turnId||row.turnId===params.turnId);
    if(method==='thread/items/list'&&params.sortDirection==='desc')data=[...data].reverse();
    const offset=params.cursor===undefined?0:Number(params.cursor),size=Math.min(pageSize,params.limit);
    return {data:data.slice(offset,offset+size),nextCursor:offset+size<data.length?String(offset+size):null};
  }};
}

test('recorded lookup selects the newest matching user marker over a saved turn ID',async()=>{
  const {findRecordedTurn}=await load();
  const client=history({turns:[turn('saved'),turn('newer','failed'),turn('foreign')],items:[
    entry('saved','u1',marker('message')+'\nold request'),
    entry('newer','u2',marker('message')+'\ncontinuation'),
    entry('foreign','u3','quoted '+marker('message')),
    entry('foreign','a1',marker('message'),'agentMessage'),
    entry('foreign','u4',marker('another-message')),
  ]});
  assert.deepEqual(await findRecordedTurn(client,{threadId:'thread',turnId:'saved',messageId:'message'}),{id:'newer',status:'failed',error:null});
});

test('lost acknowledgement finds marker and metadata across multiple pages',async()=>{
  const {findRecordedTurn}=await load();
  const client=history({turns:[turn('recorded'),turn('later-1'),turn('later-2'),turn('later-3')],items:[
    entry('recorded','u',marker('message')+'\nrequest'),
    ...Array.from({length:7},(_,i)=>entry('later-3','a'+i,'answer','agentMessage')),
  ]});
  assert.deepEqual(await findRecordedTurn(client,{threadId:'thread',messageId:'message'}),{id:'recorded',status:'completed',error:null});
});

test('missing marker falls back to saved turn metadata without returning item history',async()=>{
  const {findRecordedTurn}=await load();
  const client=history({turns:[{...turn('saved','interrupted'),error:{message:'interrupted',additionalDetails:'private'}}],items:[entry('saved','u','legacy request')]});
  assert.deepEqual(await findRecordedTurn(client,{threadId:'thread',turnId:'saved',messageId:'message'}),{id:'saved',status:'interrupted',error:{message:'interrupted'}});
});

test('no marker and no saved turn produces null after a complete search',async()=>{
  const {findRecordedTurn}=await load();
  const client=history({items:Array.from({length:6},(_,i)=>entry('old','u'+i,marker('another')))});
  assert.equal(await findRecordedTurn(client,{threadId:'thread',messageId:'message'}),null);
  assert.equal(await findRecordedTurn(history(),{threadId:'thread',turnId:'absent',messageId:'message'}),null);
});

test('marker with missing turn metadata fails closed instead of losing the acknowledged turn',async()=>{
  const {findRecordedTurn}=await load();
  await assert.rejects(findRecordedTurn(history({items:[entry('missing','u',marker('message'))]}),{threadId:'thread',messageId:'message'}),{code:'MANAGER_HISTORY_INVALID'});
});

test('selected turn items stream in order with backpressure and no full-turn result',async()=>{
  const {forEachTurnItem}=await load();
  const client=history({items:[entry('selected','u','request'),entry('foreign','x','wrong'),entry('selected','a','reply','agentMessage'),entry('selected','b','final','agentMessage')]});
  const ids=[];let processing=false;
  const result=await forEachTurnItem(client,{threadId:'thread',turnId:'selected'},async item=>{
    assert.equal(processing,false);processing=true;
    await new Promise(resolve=>setImmediate(resolve));ids.push(item.id);processing=false;
  });
  assert.deepEqual(ids,['u','a','b']);assert.equal(result,undefined);
});

test('item callback failure stops pagination and propagates',async()=>{
  const {forEachTurnItem}=await load();
  const failure=new Error('disk unavailable');let requests=0;
  const client={async request(){requests++;return {data:[entry('selected','a','reply','agentMessage')],nextCursor:'next'};}};
  await assert.rejects(forEachTurnItem(client,{threadId:'thread',turnId:'selected'},()=>{throw failure;}),error=>error===failure);
  assert.equal(requests,1);
});

test('steer marker reconciliation finds requested IDs only in user messages of the selected turn',async()=>{
  const {findRecordedMessageIds}=await load();
  const client=history({items:[entry('selected','u1',marker('one')),entry('other','u2',marker('two')),entry('selected','a1',marker('three'),'agentMessage'),entry('selected','u3','quote '+marker('four')),entry('selected','u4',marker('five'))]});
  assert.deepEqual(await findRecordedMessageIds(client,{threadId:'thread',turnId:'selected',messageIds:['one','two','three','four','five']}),new Set(['one','five']));
  assert.deepEqual(await findRecordedMessageIds(client,{threadId:'thread',messageIds:['one','two']}),new Set(['one','two']));
});

test('empty steer selection does not inspect old history',async()=>{
  const {findRecordedMessageIds}=await load();
  assert.deepEqual(await findRecordedMessageIds({request(){assert.fail('unneeded history read');}},{threadId:'thread',messageIds:[]}),new Set());
});

test('large old history stays paged and returns only narrow selected metadata',async()=>{
  const {findRecordedTurn}=await load();let requests=0;
  const client={async request(method,params){
    assert.equal(params.threadId,'thread');assert.ok(params.limit<=64);requests++;
    if(method==='thread/items/list') {
      const page=Number(params.cursor??0);
      return {data:[entry('old-'+page,'u'+page,page===1999?marker('message'):'unrelated')],nextCursor:page===1999?null:String(page+1)};
    }
    assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'notLoaded');
    const page=Number(params.cursor??0);
    return {data:[turn('old-'+page)],nextCursor:page===1999?null:String(page+1)};
  }};
  assert.deepEqual(await findRecordedTurn(client,{threadId:'thread',messageId:'message'}),{id:'old-1999',status:'completed',error:null});
  assert.equal(requests,4000);
});

test('unknown history methods and transport failures propagate without alternate reads',async()=>{
  const {findRecordedTurn,forEachTurnItem}=await load();
  for(const failure of [Object.assign(new Error('CODEX_RPC_ERROR'),{rpcError:{code:-32601}}),new Error('CODEX_TIMEOUT')]) {
    let requests=0;const client={async request(method){requests++;assert.equal(method,'thread/items/list');throw failure;}};
    await assert.rejects(findRecordedTurn(client,{threadId:'thread',turnId:'saved',messageId:'message'}),error=>error===failure);
    assert.equal(requests,1);
    await assert.rejects(forEachTurnItem(client,{threadId:'thread',turnId:'saved'},()=>{}),error=>error===failure);
    assert.equal(requests,2);
  }
});

for(const [name,page] of [
  ['missing data',{}],['missing terminal cursor',{data:[]}],['undefined terminal cursor',{data:[],nextCursor:undefined}],['non-array data',{data:{}}],['invalid cursor',{data:[],nextCursor:17}],
  ['empty cursor',{data:[entry('selected','a','x')],nextCursor:''}],
  ['empty continuing page',{data:[],nextCursor:'next'}],
  ['foreign turn item',{data:[entry('foreign','a','x')],nextCursor:null}],
  ['missing item turn',{data:[{item:{id:'a',type:'userMessage',content:[]}}],nextCursor:null}],
  ['missing item',{data:[{turnId:'selected'}],nextCursor:null}],
  ['missing user content',{data:[{turnId:'selected',item:{id:'u',type:'userMessage'}}],nextCursor:null}],
  ['invalid user text',{data:[{turnId:'selected',item:{id:'u',type:'userMessage',content:[{type:'text',text:42}]}}],nextCursor:null}],
])test(`malformed history fails closed: ${name}`,async()=>{
  const {forEachTurnItem}=await load();
  await assert.rejects(forEachTurnItem({async request(){return page;}},{threadId:'thread',turnId:'selected'},()=>{}),{code:'MANAGER_HISTORY_INVALID'});
});

test('repeated and cyclic cursors fail closed with bounded pagination state',async()=>{
  const {forEachTurnItem}=await load();
  for(const cursors of [['same','same'],['a','b','c','a','b','c','a','b','c']]) {
    let requests=0;
    const client={async request(){assert.ok(requests<20,'cursor cycle must stop');return {data:[entry('selected','a','x')],nextCursor:cursors[requests++%cursors.length]};}};
    await assert.rejects(forEachTurnItem(client,{threadId:'thread',turnId:'selected'},()=>{}),{code:'MANAGER_HISTORY_INVALID'});
  }
});

test('malformed turn metadata fails closed',async()=>{
  const {findRecordedTurn}=await load();
  for(const metadata of [{id:'selected',status:'unknown',items:[]},{id:'selected',status:'completed',items:[{type:'agentMessage',text:'full history'}]}]) {
    const client={async request(method){return {data:method==='thread/items/list'?[entry('selected','u',marker('message'))]:[metadata],nextCursor:null};}};
    await assert.rejects(findRecordedTurn(client,{threadId:'thread',messageId:'message'}),{code:'MANAGER_HISTORY_INVALID'});
  }
});


test('a missing pagination cursor cannot turn an unconfirmed submission into an empty history',async()=>{
  const {findRecordedTurn}=await load();
  for(const data of [[],[entry('other','user','Unrelated old request')]]) {
    await assert.rejects(findRecordedTurn({request:async()=>({data})},{threadId:'thread',messageId:'lost-ack'}),{code:'MANAGER_HISTORY_INVALID'});
  }
});

for(const [name,item] of [
  ['unknown item type',{id:'u',type:'userMesage',content:[{type:'text',text:marker('message')}]}],
  ['unknown input type',{id:'u',type:'userMessage',content:[{type:'txet',text:marker('message')}]}],
  ['missing assistant text',{id:'a',type:'agentMessage'}],
  ['non-string assistant text',{id:'a',type:'agentMessage',text:42}],
  ['null assistant text',{id:'a',type:'agentMessage',text:null}],
  ['missing local image path',{id:'u',type:'userMessage',content:[{type:'localImage'}]}],
  ['non-string audio URL',{id:'u',type:'userMessage',content:[{type:'audio',url:42}]}],
  ['missing local audio path',{id:'u',type:'userMessage',content:[{type:'localAudio'}]}],
  ['missing skill name',{id:'u',type:'userMessage',content:[{type:'skill',path:'/synthetic/skill'}]}],
  ['missing skill path',{id:'u',type:'userMessage',content:[{type:'skill',name:'synthetic'}]}],
  ['missing mention name',{id:'u',type:'userMessage',content:[{type:'mention',path:'/synthetic/mention'}]}],
  ['missing mention path',{id:'u',type:'userMessage',content:[{type:'mention',name:'synthetic'}]}],
])test(`damaged persisted content cannot hide a submission or lose a recovered reply: ${name}`,async()=>{
  const {findRecordedTurn,forEachTurnItem}=await load();
  const client={async request(method){assert.equal(method,'thread/items/list');return {data:[{turnId:'selected',item}],nextCursor:null};}};
  await assert.rejects(findRecordedTurn(client,{threadId:'thread',messageId:'message'}),{code:'MANAGER_HISTORY_INVALID'});
  await assert.rejects(forEachTurnItem(client,{threadId:'thread',turnId:'selected'},()=>assert.fail('damaged content must not reach recovery projections')),{code:'MANAGER_HISTORY_INVALID'});
});

test('all seven pinned persisted user input types preserve marker lookup',async()=>{
  const {findRecordedTurn,forEachTurnItem}=await load();
  const inputs=[{type:'image'},{type:'localImage',path:'/synthetic/image.png'},{type:'audio',url:'https://example.invalid/audio'},{type:'localAudio',path:'/synthetic/audio.wav'},{type:'skill',name:'synthetic',path:'/synthetic/skill'},{type:'mention',name:'synthetic',path:'/synthetic/mention'},{type:'text',text:marker('message')}];
  const client=history({turns:[turn('selected')],items:[{turnId:'selected',item:{id:'u',type:'userMessage',content:inputs}},entry('selected','a','','agentMessage')]});
  assert.deepEqual(await findRecordedTurn(client,{threadId:'thread',messageId:'message'}),{id:'selected',status:'completed',error:null});
  const ids=[];await forEachTurnItem(client,{threadId:'thread',turnId:'selected'},item=>ids.push(item.id));
  assert.deepEqual(ids,['u','a']);
});
