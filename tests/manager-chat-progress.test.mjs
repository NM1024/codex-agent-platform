import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { ManagerStore } from '../src/manager/store.mjs';
const tempRoot=process.platform==='win32'?join(process.cwd(),'.tmp'):tmpdir();
await mkdir(tempRoot,{recursive:true});

test('chat images persist privately with image-only messages and authenticated preview metadata',async t=>{
  const root=await mkdtemp(join(tempRoot,'chat-store-'));
  const {validateChatImages}=await import('../src/manager/chat-images.mjs');
  const bytes=await sharp({create:{width:20,height:10,channels:3,background:'red'}}).png().toBuffer();
  const dataUrl='data:image/png;base64,'+bytes.toString('base64');
  let store=new ManagerStore(join(root,'manager.sqlite'));
  const conversation=store.createConversation(),other=store.createConversation();
  const message=store.enqueue(conversation.id,'',await validateChatImages([{name:'red.png',dataUrl}]));
  store.close();store=new ManagerStore(join(root,'manager.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const saved=store.getConversation(conversation.id).messages[0],image=saved.attachments[0];
  assert.equal(saved.id,message.id);assert.equal(saved.text,'');assert.equal(saved.status,'queued');
  assert.deepEqual([image.name,image.mime,image.width,image.height,image.size],['red.png','image/png',20,10,bytes.length]);
  assert.equal(image.url,`/admin/api/conversations/${conversation.id}/images/${image.id}`);
  assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes('base64'));
  assert.deepEqual(Buffer.from(store.getImage(conversation.id,image.id).bytes),bytes);
  assert.throws(()=>store.getImage(other.id,image.id),{code:'IMAGE_NOT_FOUND'});
  assert.deepEqual(store.imageInputs(message.id),[{type:'image',url:dataUrl}]);
  assert.throws(()=>store.enqueue(conversation.id,'x'.repeat(20001)),{code:'INVALID_MESSAGE'});
  assert.throws(()=>store.enqueue(conversation.id,''),{code:'INVALID_MESSAGE'});
});

test('management FIFO correlates exact turn before acknowledgement and excludes foreign and late events',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs');
  const root=await mkdtemp(join(tempRoot,'chat-agent-')),store=new ManagerStore(join(root,'manager.sqlite'));
  const conversation=store.createConversation();
  await mkdir(join(root,'codex',conversation.id),{recursive:true});await writeFile(join(root,'codex',conversation.id,'auth.json'),'{}');
  const calls=[],finishers=[],signals=[];let count=0;
  const firstStarted=new Promise(resolve=>signals.push(resolve)),secondStarted=new Promise(resolve=>signals.push(resolve));
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',timeoutMs:5000,createClient:()=>{
    const listeners=new Set(),send=event=>{for(const listener of listeners)listener(event);};
    return {notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method,params){
      if(method==='thread/start'||method==='thread/resume'||method==='thread/read')return {thread:{id:'fixture-thread',turns:[]}};
      if(method!=='turn/start')return {};
      const index=count++,turnId='fixture-turn-'+index;calls.push(params);
      send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId,itemId:'a'+index,delta:'Visible partial answer '}});
      finishers.push(()=>{
        send({method:'item/completed',params:{threadId:'foreign-thread',turnId,item:{id:'a'+index,type:'agentMessage',text:'FOREIGN_THREAD'}}});
        send({method:'item/completed',params:{threadId:'fixture-thread',turnId:'foreign-turn',item:{id:'a'+index,type:'agentMessage',text:'FOREIGN_TURN'}}});
        send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'foreign-turn',status:'failed'}}});
        send({method:'item/completed',params:{threadId:'fixture-thread',turnId,item:{id:'a'+index,type:'agentMessage',text:'Reply '+index}}});
        send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:turnId,status:'completed'}}});
        send({method:'item/completed',params:{threadId:'fixture-thread',turnId,item:{id:'late',type:'agentMessage',text:'LATE_FINAL'}}});
      });signals[index]();return {turn:{id:turnId}};
    }};
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const imageBytes=await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer();
  const dataUrl='data:image/png;base64,'+imageBytes.toString('base64');
  const {validateChatImages}=await import('../src/manager/chat-images.mjs');
  const first=agent.enqueue(conversation.id,'',await validateChatImages([{name:'blue.png',dataUrl}]));await firstStarted;
  // Allow the turn/start promise acknowledgement to settle.
  await new Promise(resolve=>setImmediate(resolve));
  const second=agent.enqueue(conversation.id,'Second request');
  assert.equal(calls.length,1);assert.equal(store.getConversation(conversation.id).messages.find(row=>row.id===second.id).status,'queued');
  assert.ok(store.getConversation(conversation.id).messages[0].activity.some(row=>row.text.includes('Visible partial')));
  assert.deepEqual(calls[0].input,[{type:'text',text:`[management_message_id:${first.id}]\n`},{type:'image',url:dataUrl}]);
  finishers[0]();await secondStarted;await new Promise(resolve=>setImmediate(resolve));finishers[1]();await agent.idle(conversation.id);
  const saved=store.getConversation(conversation.id);
  assert.deepEqual(saved.messages.filter(row=>row.role==='assistant').map(row=>[row.reply_to,row.text]),[[first.id,'Reply 0'],[second.id,'Reply 1']]);
  for(const value of ['FOREIGN_THREAD','FOREIGN_TURN','LATE_FINAL'])assert.ok(!JSON.stringify(saved).includes(value));
});

test('manager image HTTP routes validate admission and require authentication and same conversation',async t=>{
  const {createManagerServer}=await import('../src/manager/server.mjs');
  const store=new ManagerStore(':memory:'),conversation=store.createConversation(),other=store.createConversation();
  const server=createManagerServer({store,agent:{enqueue:(id,text,images)=>store.enqueue(id,text,images)},auth:{authorize:req=>req.headers.authorization==='Bearer fixture'},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer fixture','content-type':'application/json'};
  const bytes=await sharp({create:{width:3,height:4,channels:3,background:'blue'}}).webp().toBuffer(),dataUrl='data:image/webp;base64,'+bytes.toString('base64');
  const response=await fetch(`${base}/admin/api/conversations/${conversation.id}/messages`,{method:'POST',headers,body:JSON.stringify({text:'',attachments:[{name:'fixture.webp',dataUrl}]})});
  assert.equal(response.status,202);const image=(await response.json()).attachments[0];
  assert.equal((await fetch(base+image.url)).status,401);
  assert.equal((await fetch(`${base}/admin/api/conversations/${other.id}/images/${image.id}`,{headers})).status,404);
  const preview=await fetch(base+image.url,{headers});assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/webp');
  assert.equal(preview.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),bytes);
  const rejected=await fetch(`${base}/admin/api/conversations/${conversation.id}/messages`,{method:'POST',headers,body:JSON.stringify({text:'hello',attachments:[{name:'fake.png',dataUrl:'data:image/png;base64,AA=='}]})});
  assert.equal(rejected.status,400);assert.equal(store.getConversation(conversation.id).messages.length,1);
});

test('queued image-only message survives store reopen and sends one initial turn without terminal replay',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs'),{validateChatImages}=await import('../src/manager/chat-images.mjs');
  const root=await mkdtemp(join(tempRoot,'chat-recovery-'));
  let store=new ManagerStore(join(root,'manager.sqlite'));
  const conversation=store.createConversation();
  await mkdir(join(root,'codex',conversation.id),{recursive:true});await writeFile(join(root,'codex',conversation.id,'auth.json'),'{}');
  const bytes=await sharp({create:{width:3,height:4,channels:3,background:'green'}}).jpeg().toBuffer(),dataUrl='data:image/jpeg;base64,'+bytes.toString('base64');
  const message=store.enqueue(conversation.id,'',await validateChatImages([{name:'queued.jpg',dataUrl}]));
  store.close();store=new ManagerStore(join(root,'manager.sqlite'));
  const calls=[],agents=[],create=()=>{
    const agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',timeoutMs:1000,createClient:()=>{
      const listeners=new Set();return {notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method,params){
        calls.push({method,params});
        if(['thread/start','thread/resume','thread/read'].includes(method))return {thread:{id:'recovery-thread',turns:[]}};
        if(method==='turn/start') {
          setImmediate(()=>{for(const fn of listeners)fn({method:'turn/completed',params:{threadId:'recovery-thread',turn:{id:'recovered-turn',status:'completed'}}});});
          return {turn:{id:'recovered-turn'}};
        }return {};
      }};
    }});agents.push(agent);return agent;
  };
  t.after(async()=>{for(const agent of agents)await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const agent=create();await agent.recover();await agent.idle(conversation.id);await agent.stop();
  const next=create();await next.recover();await next.idle(conversation.id);
  const starts=calls.filter(call=>call.method==='turn/start');assert.equal(starts.length,1);
  assert.deepEqual(starts[0].params.input,[{type:'text',text:`[management_message_id:${message.id}]\n`},{type:'image',url:dataUrl}]);
  assert.equal(store.getConversation(conversation.id).messages[0].status,'completed');
});

test('chat image admission decodes real bytes and rejects malformed, mismatched, large and animated rasters',async()=>{
  const {validateChatImages}=await import('../src/manager/chat-images.mjs');
  const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
  const image={name:'fixture.png',dataUrl:'data:image/png;base64,'+png.toString('base64')};
  const oversized=await sharp({create:{width:2049,height:1,channels:3,background:'red'}}).png().toBuffer();
  const animated=await sharp(Buffer.from([255,0,0,0,255,0]),{raw:{width:1,height:2,channels:3,pageHeight:1}}).webp({loop:0}).toBuffer();
  for(const attachments of [null,{},[image,image,image,image,image],[{...image,dataUrl:'data:image/png;base64,!!!!'}],[{...image,dataUrl:'data:image/jpeg;base64,'+png.toString('base64')}],[{...image,dataUrl:'data:image/png;base64,'+Buffer.alloc(160*1024+1).toString('base64')}],[{...image,dataUrl:'data:image/png;base64,'+oversized.toString('base64')}],[{...image,dataUrl:'data:image/svg+xml;base64,PHN2Zy8+'}],[{...image,dataUrl:'data:image/png;base64,'+png.subarray(0,40).toString('base64')}],[{name:'animated.webp',dataUrl:'data:image/webp;base64,'+animated.toString('base64')}]])
    await assert.rejects(validateChatImages(attachments),{code:'INVALID_IMAGES'});
  assert.equal((await validateChatImages([image])).length,1);
});

test('complete assistant reply remains whole when bounded progress has filled up',async()=>{
  const {ChatProgress}=await import('../src/manager/chat-progress.mjs');
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation(),message=store.enqueue(conversation.id,'Inspect');store.markRunning(message.id);
    const progress=new ChatProgress({store,messageId:message.id}),reply='Final report: '+('Verified result. '.repeat(3000));
    for(let n=0;n<110;n++)progress.event({method:'item/completed',params:{item:{id:'tool-'+n,type:'mcpToolCall',tool:'tasks',status:'completed'}}});
    progress.event({method:'item/completed',params:{item:{id:'final',type:'agentMessage',text:reply}}});progress.finish();
    store.finish(message,null,progress.text);
    const saved=store.getConversation(conversation.id);assert.equal(saved.messages.find(row=>row.role==='assistant').text,reply);
    assert.ok(saved.messages[0].activity.length<=100);
  }finally{store.close();}
});

test('progress capacity and aborted streams never expose a retained partial credential or image data',async()=>{
  const {ChatProgress}=await import('../src/manager/chat-progress.mjs');
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation(),message=store.enqueue(conversation.id,'Inspect');store.markRunning(message.id);
    const token='SyntheticCredential0123456789',progress=new ChatProgress({store,messageId:message.id,secrets:[token]});
    progress.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'x'.repeat(8180)+' '+token}});
    progress.finish('unknown');
    assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes(token.slice(0,10)));
    const another=store.enqueue(conversation.id,'Inspect images');store.markRunning(another.id);
    const images=new ChatProgress({store,messageId:another.id});
    images.event({method:'item/completed',params:{item:{id:'r',type:'reasoning',summary:['Inspect data:image/png;base64,AAABBBCCCDDD safely'],content:['RAW_PRIVATE']}}});
    assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes('AAABBBCCCDDD'));
  }finally{store.close();}
});

test('transport disconnect preserves uncertain tool activity as unknown while user message is interrupted',async t=>{
  const {ManagementAgent}=await import('../src/manager/agent.mjs');
  const root=await mkdtemp(join(tempRoot,'chat-timeout-')),store=new ManagerStore(join(root,'manager.sqlite')),conversation=store.createConversation();
  await mkdir(join(root,'codex',conversation.id),{recursive:true});await writeFile(join(root,'codex',conversation.id,'auth.json'),'{}');
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',timeoutMs:1000,createClient:()=>{
    const listeners=new Set();return {notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method){
      if(method==='thread/start')return {thread:{id:'timeout-thread'}};
      if(method==='turn/start') {
        setImmediate(()=>{
          for(const fn of listeners)fn({method:'item/started',params:{threadId:'timeout-thread',turnId:'timeout-turn',item:{id:'tool',type:'mcpToolCall',tool:'tasks',status:'inProgress'}}});
          for(const fn of listeners)fn({method:'transport/closed',params:{code:'CODEX_EXIT'}});
        });
        return {turn:{id:'timeout-turn'}};
      }return {};
    }};
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const message=agent.enqueue(conversation.id,'Inspect tasks');
  await agent.idle(conversation.id);
  const saved=store.getConversation(conversation.id).messages[0];
  assert.equal(saved.id,message.id);assert.equal(saved.status,'interrupted');
  assert.equal(saved.activity.length,1);assert.equal(saved.activity[0].label,'tasks');assert.equal(saved.activity[0].status,'unknown');
});

test('per-message activity, action ownership and recovery states survive restart and are bounded',()=>{
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation(),first=store.enqueue(conversation.id,'one'),second=store.enqueue(conversation.id,'two');
    store.markRunning(first.id);
    const action=store.beginAction(conversation.id,'tasks');
    store.progress(first.id,{id:'a',kind:'reasoning_summary',label:'Reasoning summary',text:'Checking records',status:'running'});
    store.progress(first.id,{id:'b',kind:'tool',label:'tasks',text:'',status:'running'});
    for(let n=0;n<150;n++)store.progress(first.id,{id:'entry-'+n,kind:'assistant_message',label:'Assistant',text:'x'.repeat(20000),status:'running'});
    const active=store.getConversation(conversation.id).messages[0];
    assert.ok(active.started_at);assert.ok(active.updated_at>=active.started_at);
    assert.ok(active.activity.length<=100);assert.ok(active.activity.reduce((sum,row)=>sum+row.text.length,0)<=65536);
    assert.equal(store.actions(conversation.id)[0].message_id,first.id);
    assert.equal(store.list()[0].queued_count,1);assert.equal(store.list()[0].running_count,1);
    store.recover();
    assert.equal(store.getConversation(conversation.id).messages[0].status,'interrupted');
    assert.equal(store.actions(conversation.id)[0].status,'unknown');
    assert.ok(store.getConversation(conversation.id).messages[0].activity.every(row=>row.status!=='running'));
    assert.equal(store.next(conversation.id).id,first.id);
    store.markRunning(first.id);store.finish(first,null,'Done');store.finish(first,null,'Late duplicate');
    const saved=store.getConversation(conversation.id),reply=saved.messages.find(row=>row.role==='assistant');
    assert.equal(reply.reply_to,first.id);assert.ok(saved.messages[0].completed_at);assert.equal(reply.text,'Done');
    assert.equal(saved.messages.filter(row=>row.role==='assistant').length,1);assert.equal(store.next(conversation.id).id,second.id);
    assert.equal(store.actions(conversation.id).find(row=>row.id===action).message_id,first.id);
  }finally{store.close();}
});

test('public progress filters raw reasoning and private tools and redacts fragmented secrets before every poll',async()=>{
  const {ChatProgress}=await import('../src/manager/chat-progress.mjs');
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation(),message=store.enqueue(conversation.id,'Inspect');store.markRunning(message.id);
    const secret='syntheticTokenSecret0123456789';
    const projection=new ChatProgress({store,messageId:message.id,secrets:[secret]});
    projection.event({method:'item/reasoning/textDelta',params:{itemId:'r',delta:'RAW_REASONING_PRIVATE'}});
    projection.event({method:'item/started',params:{item:{id:'r',type:'reasoning',content:['RAW_REASONING_PRIVATE']}}});
    for(const delta of ['Public summary ',secret.slice(0,10),secret.slice(10),' password=','fixture-pass','word ','Bearer ','bearer-secret ']) {
      projection.event({method:'item/reasoning/summaryTextDelta',params:{itemId:'r',summaryIndex:0,delta}});
      const json=JSON.stringify(store.getConversation(conversation.id));
      for(const value of [secret.slice(0,10),'fixture-pass','bearer-secret','RAW_REASONING_PRIVATE'])assert.ok(!json.includes(value),json);
    }
    projection.event({method:'item/completed',params:{item:{id:'r',type:'reasoning',summary:['Public summary password=fixture-password'],content:['RAW_REASONING_PRIVATE']}}});
    projection.event({method:'item/started',params:{item:{id:'tool',type:'mcpToolCall',tool:'tasks',server:'agent_task',arguments:{password:'TOOL_ARGUMENT_PRIVATE'},result:{text:'TOOL_RESULT_PRIVATE'}}}});
    projection.event({method:'item/completed',params:{item:{id:'tool',type:'mcpToolCall',tool:'tasks',status:'completed',result:{text:'TOOL_RESULT_PRIVATE'}}}});
    projection.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'A partial answer '}});
    assert.ok(store.getConversation(conversation.id).messages[0].activity.some(row=>row.kind==='assistant_message'&&row.text.includes('partial')));
    projection.event({method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'Final answer'}}});
    projection.finish();projection.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'LATE_PRIVATE'}});
    const activity=store.getConversation(conversation.id).messages[0].activity,json=JSON.stringify(activity);
    assert.ok(activity.some(row=>row.kind==='reasoning_summary'));assert.ok(activity.some(row=>row.kind==='tool'&&row.label==='tasks'&&row.status==='completed'));
    for(const value of ['RAW_REASONING_PRIVATE','TOOL_ARGUMENT_PRIVATE','TOOL_RESULT_PRIVATE','fixture-password','LATE_PRIVATE'])assert.ok(!json.includes(value));
    assert.equal(projection.text,'Final answer');
  }finally{store.close();}
});

test('fragmented quoted credentials remain private at each public summary poll',async()=>{
  const {ChatProgress}=await import('../src/manager/chat-progress.mjs');
  const store=new ManagerStore(':memory:');try {
    const conversation=store.createConversation(),message=store.enqueue(conversation.id,'Inspect');store.markRunning(message.id);
    const progress=new ChatProgress({store,messageId:message.id});
    for(const delta of ['Checking password="firstprivate ','secondprivate ','thirdprivate" ','next operation ']) {
      progress.event({method:'item/reasoning/summaryTextDelta',params:{itemId:'r',summaryIndex:0,delta}});
      const json=JSON.stringify(store.getConversation(conversation.id));
      for(const fragment of ['firstprivate','secondprivate','thirdprivate'])assert.ok(!json.includes(fragment));
    }
    progress.finish();
    for(const fragment of ['firstprivate','secondprivate','thirdprivate'])assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes(fragment));
  }finally{store.close();}
});
