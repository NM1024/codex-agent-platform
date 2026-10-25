import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {ManagerStore} from '../src/manager/store.mjs';
import {ManagementAgent} from '../src/manager/agent.mjs';
const tempRoot=process.platform==='win32'?join(process.cwd(),'.tmp'):tmpdir();

async function setup(t) {
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(join(tempRoot,'generated-chat-'));
  const workDir=join(root,'work'),home=join(root,'home');
  await mkdir(workDir);await mkdir(join(home,'generated_images'),{recursive:true});
  const store=new ManagerStore(join(root,'manager.sqlite')),conversation=store.createConversation('Synthetic images');
  const message=store.enqueue(conversation.id,'Draw a synthetic square');store.markRunning(message.id);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const bytes=await sharp({create:{width:20,height:10,channels:4,background:'#12345678'}}).png().toBuffer();
  const path=join(home,'generated_images','synthetic.png');await writeFile(path,bytes);
  const {GeneratedChatImages}=await import('../src/manager/generated-images.mjs');
  return {root,workDir,home,store,conversation,message,bytes,path,collector:new GeneratedChatImages({store,messageId:message.id,workDir,home})};
}

test('completed native images are durable private attachments and duplicate recovery items are idempotent',async t=>{
  const {collector,path,store,message,conversation,bytes,root}=await setup(t);
  const item={id:'native-image-one',type:'imageGeneration',status:'completed',result:'',savedPath:path};
  collector.accept(item);collector.accept(item);await collector.drain();
  const images=store.message(message.id).generated_images;
  assert.equal(images.length,1);assert.equal(images[0].width,20);assert.equal(images[0].height,10);
  assert.deepEqual(Buffer.from(store.getImage(conversation.id,images[0].id).bytes),bytes);
  assert.ok(!JSON.stringify(store.getConversation(conversation.id)).includes(path));
  assert.ok(!JSON.stringify(images).includes('base64'));
  const reopened=new ManagerStore(join(root,'manager.sqlite'));try{assert.equal(reopened.message(message.id).generated_images[0].id,images[0].id);}finally{reopened.close();}
  const other=store.createConversation('Other');assert.throws(()=>store.getImage(other.id,images[0].id),{code:'IMAGE_NOT_FOUND'});
  store.finish(message,null,'Generated');store.deleteConversation(conversation.id);
  assert.throws(()=>store.getImage(conversation.id,images[0].id),{code:'IMAGE_NOT_FOUND'});
});

test('unowned paths, malformed images and failed events never become generated attachments',async t=>{
  const {collector,root,workDir,path,store,message,bytes}=await setup(t);
  await writeFile(join(root,'private.png'),bytes);await writeFile(join(workDir,'invalid.png'),'not an image');
  collector.accept({id:'failed',type:'imageGeneration',status:'failed',savedPath:path});
  collector.accept({id:'foreign',type:'imageGeneration',status:'completed',savedPath:join(root,'private.png')});
  collector.accept({id:'invalid',type:'imageGeneration',status:'completed',savedPath:join(workDir,'invalid.png')});
  await collector.drain();
  assert.equal(store.message(message.id).generated_images.length,0);
  assert.ok(store.message(message.id).activity.some(item=>item.status==='failed'));
  assert.ok(!JSON.stringify(store.message(message.id)).includes(root));
});

test('generated image ingestion refuses symlinks',{skip:process.platform==='win32'},async t=>{
  const {collector,root,workDir,store,message,bytes}=await setup(t);
  await writeFile(join(root,'private.png'),bytes);await symlink(join(root,'private.png'),join(workDir,'link.png'));
  collector.accept({id:'link',type:'imageGeneration',status:'completed',savedPath:join(workDir,'link.png')});await collector.drain();
  assert.equal(store.message(message.id).generated_images.length,0);
});

test('management image events drain before completion, exclude foreign turns, and recover without a new model turn',async t=>{
  await mkdir(tempRoot,{recursive:true});const root=await mkdtemp(join(tempRoot,'image-agent-'));
  const store=new ManagerStore(':memory:'),c=store.createConversation('Image Agent');
  const home=join(root,'codex',c.id);await mkdir(join(home,'generated_images'),{recursive:true});await writeFile(join(home,'auth.json'),'{}');
  const bytes=await sharp({create:{width:16,height:12,channels:3,background:'#123456'}}).png().toBuffer(),path=join(home,'generated_images','owned.png');await writeFile(path,bytes);
  let recovering=false,recordedStatus='completed',continuingMessage;const calls=[];
  const image={id:'image-item',type:'imageGeneration',status:'completed',result:'',savedPath:path};
  const agent=new ManagementAgent({store,root,authFile:join(root,'unused.json'),mcpUrl:'http://127.0.0.1/unused',createClient:()=>{
    const listeners=new Set(),emit=(method,params)=>{for(const listener of listeners)listener({method,params});};
    return {notify(){},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async close(){},async request(method,params){
      calls.push({method,params});
      if(method==='thread/start'||method==='thread/read')return {thread:{id:'image-thread'}};
      if(method==='thread/resume')return {thread:{id:'image-thread',turns:recovering?[{id:'recorded-turn',status:recordedStatus,items:[image,{id:'final',type:'agentMessage',text:'Recovered image'}]}]:[]}};
      if(method==='turn/start'){
        if(continuingMessage)assert.equal(store.message(continuingMessage.id).generated_images.length,1,'pre-restart image must be saved before continuation');
        emit('item/completed',{threadId:'foreign-thread',turnId:'image-turn',item:{...image,id:'foreign-thread-image'}});
        emit('item/completed',{threadId:'image-thread',turnId:'foreign-turn',item:{...image,id:'foreign-turn-image'}});
        emit('item/completed',{threadId:'image-thread',turnId:'image-turn',item:image});
        emit('item/completed',{threadId:'image-thread',turnId:'image-turn',item:{id:'reply',type:'agentMessage',text:'Here is the image'}});
        emit('turn/completed',{threadId:'image-thread',turn:{id:'image-turn',status:'completed'}});return {turn:{id:'image-turn'}};
      }
      return {};
    }};
  }});
  t.after(async()=>{await agent.stop();store.close();await rm(root,{recursive:true,force:true});});
  const first=agent.enqueue(c.id,'Draw a square');await agent.idle(c.id);
  assert.equal(store.message(first.id).status,'completed');assert.equal(store.message(first.id).generated_images.length,1);
  const config=calls.find(call=>call.method==='thread/start').params.config;assert.equal(config['features.image_generation'],true);assert.equal(config['features.shell_tool'],false);
  const recovered=store.enqueue(c.id,'Recover the image');store.markRunning(recovered.id);store.turn(recovered.id,'recorded-turn');store.interrupted(recovered.id);recovering=true;
  await agent.recover();await agent.idle(c.id);
  assert.equal(store.message(recovered.id).status,'completed');assert.equal(store.message(recovered.id).generated_images.length,1);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  continuingMessage=store.enqueue(c.id,'Continue interrupted generation');store.markRunning(continuingMessage.id);store.turn(continuingMessage.id,'recorded-turn');store.interrupted(continuingMessage.id);recordedStatus='inProgress';
  await agent.recover();await agent.idle(c.id);
  assert.equal(store.message(continuingMessage.id).status,'completed');assert.equal(store.message(continuingMessage.id).generated_images.length,1);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,2);
});
