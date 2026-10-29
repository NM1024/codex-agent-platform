import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagerStore} from '../src/manager/store.mjs';
import {ChatProgress} from '../src/manager/chat-progress.mjs';
import {GeneratedChatImages} from '../src/manager/generated-images.mjs';

test('text-only manager imports and empty attachments do not load native image libraries',()=>{
  const source=`
    import {createRequire} from 'node:module';
    import {validateChatImages} from './src/manager/chat-images.mjs';
    await import('./src/manager/agent.mjs');
    await validateChatImages([]);
    console.log(JSON.stringify(Object.keys(createRequire(import.meta.url).cache).filter(path=>/[/\\\\](?:sharp|@img)[/\\\\]/.test(path))));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),[]);
});

test('completed final text remains whole beyond the bounded live buffer and after database reopen',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-final-memory-')),path=join(root,'manager.sqlite');
  let store=new ManagerStore(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const c=store.createConversation(),message=store.enqueue(c.id,'Synthetic long response');store.markRunning(message.id);
  const progress=new ChatProgress({store,messageId:message.id}),text='中'.repeat(1048576)+' SYNTHETIC_FINAL_TAIL';
  progress.event({method:'item/agentMessage/delta',params:{itemId:'final',delta:text}});
  assert.ok(progress.replyText.length<=1048576);
  progress.event({method:'item/completed',params:{item:{id:'final',type:'agentMessage',text}}});
  progress.finish();store.finish(message,null,progress.text);store.close();store=new ManagerStore(path);
  const reply=store.getConversation(c.id).messages.find(row=>row.role==='assistant');
  assert.equal(reply.text.length,1048597);assert.ok(reply.text.endsWith(' SYNTHETIC_FINAL_TAIL'));
});

test('generated ingestion snapshots only the accepted image identity and path before asynchronous work',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manager-image-memory-')),workDir=join(root,'work'),home=join(root,'home');
  await mkdir(workDir);await mkdir(home);
  const store=new ManagerStore(':memory:');t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic image');store.markRunning(m.id);
  const sharp=(await import('sharp')).default,bytes=await sharp({create:{width:3,height:4,channels:4,background:'#11223344'}}).png().toBuffer();
  const path=join(workDir,'image.png');await writeFile(path,bytes);
  const collector=new GeneratedChatImages({store,messageId:m.id,workDir,home});
  const item={id:'accepted-image',type:'imageGeneration',status:'completed',savedPath:path,get result(){throw new Error('Unneeded result must not be read');}};
  collector.accept(item);item.id='changed';item.savedPath=join(root,'outside.png');await collector.drain();
  assert.ok(store.generatedImage(m.id,'accepted-image'));assert.equal(store.generatedImage(m.id,'changed'),undefined);
});

test('image work serializes native processing and rejects excess uploads without enqueueing them',async()=>{
  const {withImageWork}=await import('../src/manager/image-work.mjs');
  const {validateChatImages}=await import('../src/manager/chat-images.mjs');
  let release,started,active=0,peak=0;
  const running=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const first=withImageWork(async()=>{active++;peak=Math.max(peak,active);started();await gate;active--;});
  await running;
  const waiting=Array.from({length:8},()=>withImageWork(async()=>{active++;peak=Math.max(peak,active);active--;}));
  try {
    await assert.rejects(withImageWork(async()=>assert.fail('excess work started')),{code:'IMAGE_PROCESSING_BUSY',status:503});
    // A valid, tiny PNG must fail admission as retryable overload, not INVALID_IMAGES.
    await assert.rejects(validateChatImages([{name:'tiny.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNIcAAAAASUVORK5CYII='}]),{code:'IMAGE_PROCESSING_BUSY',status:503});
  }finally{release();await Promise.all([first,...waiting]);}
  assert.equal(peak,1);
  await assert.rejects(withImageWork(async()=>{throw new Error('synthetic failure');}),/synthetic failure/);
  assert.equal(await withImageWork(async()=>42),42);
});

test('waiting image admission expires and releases its slot while running work can still complete',async t=>{
  const {withImageWork}=await import('../src/manager/image-work.mjs');
  let release,started;const running=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const first=withImageWork(async()=>{started();await gate;});await running;
  t.mock.timers.enable({apis:['setTimeout']});
  const expired=assert.rejects(withImageWork(async()=>assert.fail('expired work started')),{code:'IMAGE_PROCESSING_BUSY',status:503});
  t.mock.timers.tick(30000);await expired;
  const next=withImageWork(async()=>23);release();await first;assert.equal(await next,23);
});

test('uploaded images with valid headers but incomplete pixel streams are rejected after full decoding',async()=>{
  const sharp=(await import('sharp')).default;
  const bytes=await sharp({create:{width:128,height:128,channels:3,background:'#123456'}}).png().toBuffer(),truncated=bytes.subarray(0,bytes.length-30);
  assert.equal((await sharp(truncated).metadata()).width,128);
  const {validateChatImages}=await import('../src/manager/chat-images.mjs');
  await assert.rejects(validateChatImages([{name:'truncated.png',dataUrl:'data:image/png;base64,'+truncated.toString('base64')}]),{code:'INVALID_IMAGES'});
});

test('accepted generated files survive temporary global image admission saturation',async t=>{
  const {withImageWork}=await import('../src/manager/image-work.mjs');
  const root=await mkdtemp(join(tmpdir(),'manager-image-admission-')),workDir=join(root,'work'),home=join(root,'home');
  await mkdir(workDir);await mkdir(home);
  const store=new ManagerStore(':memory:');t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic delayed image');store.markRunning(m.id);
  const sharp=(await import('sharp')).default,bytes=await sharp({create:{width:3,height:4,channels:3,background:'#123456'}}).png().toBuffer();
  const path=join(workDir,'image.png');await writeFile(path,bytes);
  let release,started;const running=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const first=withImageWork(async()=>{started();await gate;});await running;
  const waiting=Array.from({length:8},()=>withImageWork(async()=>{}));
  const collector=new GeneratedChatImages({store,messageId:m.id,workDir,home});
  collector.accept({id:'accepted-delayed-image',type:'imageGeneration',status:'completed',savedPath:path});
  await new Promise(resolve=>setImmediate(resolve));
  release();await Promise.all([first,...waiting]);await collector.drain();
  assert.ok(store.generatedImage(m.id,'accepted-delayed-image'));assert.equal(store.message(m.id).activity.length,0);
});

test('long live reply writes coalesce and completion cancels the pending timer without losing the final text',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const writes=[],progress=new ChatProgress({store:{reply:(id,text)=>writes.push(['reply',text]),replyItem:(id,item,text,status)=>writes.push([item,text,status]),progress(){}},messageId:'synthetic'});
  progress.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'中'.repeat(8192)}});
  assert.equal(writes.length,2);
  for(let n=0;n<100;n++)progress.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'文'}});
  assert.equal(writes.length,2);
  t.mock.timers.tick(40);assert.equal(writes.length,4);assert.equal(writes.at(-1)[1].length,8292);
  progress.event({method:'item/agentMessage/delta',params:{itemId:'a',delta:'待完成'}});
  const text='完整回复'.repeat(300000)+'FINAL_TAIL';
  progress.event({method:'item/completed',params:{item:{id:'a',type:'agentMessage',text}}});
  assert.equal(writes.length,6);progress.finish();assert.equal(progress.text,text);
  const count=writes.length;t.mock.timers.tick(1000);assert.equal(writes.length,count);
});

test('long live reply flushes the latest safely redacted text on interruption and before switching items',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const writes=[],secret='synthetic-private-token',progress=new ChatProgress({store:{reply(){},replyItem:(id,item,text,status)=>writes.push({item,text,status}),progress(){}},messageId:'synthetic',secrets:[secret]});
  const delta=(id,text)=>progress.event({method:'item/agentMessage/delta',params:{itemId:id,delta:text}});
  delta('a','中'.repeat(9000)+'synthetic-');t.mock.timers.tick(40);
  assert.equal(writes.length,1);assert.ok(!writes[0].text.includes('synthetic-'));
  delta('a','private-');delta('a','token 中文');delta('b','第二条');
  assert.equal(writes.length,3);assert.ok(writes[1].text.endsWith('[REDACTED] 中文'));
  delta('b','中'.repeat(9000)+'synthetic-private-');progress.finish('unknown');
  const last=writes.at(-1);assert.equal(last.item,'b');assert.equal(last.status,'running');assert.ok(!last.text.includes('synthetic-private-'));
  assert.equal(progress.text,last.text);const count=writes.length;t.mock.timers.tick(1000);assert.equal(writes.length,count);
});

test('live replies stop accepting deltas at their buffer budget while full completion still survives',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const writes=[],progress=new ChatProgress({store:{reply(){},replyItem:(id,item,text)=>writes.push(text),progress(){}},messageId:'synthetic'});
  progress.reply('a','中'.repeat(1048570),true,true);
  progress.reply('a','文'.repeat(100),true,true);t.mock.timers.tick(40);
  assert.equal(progress.replyText.length,1048576);assert.ok(progress.replyText.endsWith('文'.repeat(6)));
  const count=writes.length;for(let n=0;n<100;n++)progress.reply('a','不再追加'.repeat(1000),true,true);
  t.mock.timers.tick(40);assert.equal(writes.length,count);
});

test('saturated activity ignores unchanged deltas but still records completion status',()=>{
  const writes=[],progress=new ChatProgress({store:{progress:(id,entry)=>writes.push(entry)},messageId:'synthetic'});
  const delta=text=>progress.event({method:'item/reasoning/summaryTextDelta',params:{itemId:'summary',summaryIndex:0,delta:text}});
  delta('中'.repeat(8190));delta('文'.repeat(20));assert.equal(writes.length,2);assert.equal(writes.at(-1).text.length,8192);
  for(let n=0;n<100;n++)delta('更多公开摘要'.repeat(1000));
  assert.equal(writes.length,2);
  progress.event({method:'item/completed',params:{item:{id:'summary',type:'reasoning',summary:['中'.repeat(8190)+'文'.repeat(20)]}}});
  assert.equal(writes.length,3);assert.equal(writes.at(-1).status,'completed');assert.equal(writes.at(-1).text.length,8192);
});
