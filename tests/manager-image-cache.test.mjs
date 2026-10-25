import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {ManagerStore} from '../src/manager/store.mjs';
import {AdminAuth} from '../src/manager/auth.mjs';
import {createManagerServer} from '../src/manager/server.mjs';

for(const kind of ['uploaded','generated'])test(`${kind} image cache revalidates bytes after authentication and conversation ownership checks`,async t=>{
  const store=new ManagerStore(':memory:'),auth=new AdminAuth(store.db);
  await auth.initialize('synthetic-image-cache-password');
  const conversation=store.createConversation(),other=store.createConversation();
  const bytes=await sharp({create:{width:20,height:10,channels:3,background:'#345e4f'}}).png().toBuffer();
  const image={name:'synthetic.png',mime:'image/png',width:20,height:10,size:bytes.length,bytes};
  const message=store.enqueue(conversation.id,'Synthetic image',kind==='uploaded'?[image]:[]);
  store.markRunning(message.id);
  if(kind==='generated')store.saveGeneratedImage(message.id,'synthetic-image-item',image);
  store.finish(message,null,'Synthetic completed reply');
  const saved=store.message(message.id)[kind==='uploaded'?'attachments':'generated_images'][0];
  const server=createManagerServer({store,auth,agent:{},operations:{},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`,login=await fetch(base+'/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-image-cache-password'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie},url=base+saved.url;
  const first=await fetch(url,{headers});assert.equal(first.status,200);
  assert.equal(first.headers.get('cache-control'),'private, no-cache');
  assert.equal(first.headers.get('vary'),'Cookie');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()),bytes);
  const etag=first.headers.get('etag');assert.match(etag,/^"[A-Za-z0-9_-]+"$/);
  const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);
  assert.equal(head.headers.get('etag'),etag);assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const condition of [etag,`W/${etag}`,`"unrelated", W/${etag}`,'*']){
    const hit=await fetch(url,{headers:{...headers,'if-none-match':condition}});
    assert.equal(hit.status,304);assert.equal(hit.headers.get('etag'),etag);assert.equal(hit.headers.get('cache-control'),'private, no-cache');
    assert.equal((await hit.arrayBuffer()).byteLength,0);
  }
  const miss=await fetch(url,{headers:{...headers,'if-none-match':'"unrelated"'}});
  assert.equal(miss.status,200);assert.deepEqual(Buffer.from(await miss.arrayBuffer()),bytes);
  assert.equal((await fetch(url,{headers:{'if-none-match':etag}})).status,401);
  assert.equal((await fetch(`${base}/admin/api/conversations/${other.id}/images/${saved.id}`,{headers:{...headers,'if-none-match':etag}})).status,404);
  store.deleteConversation(conversation.id);
  assert.equal((await fetch(url,{headers:{...headers,'if-none-match':etag}})).status,404);
  await fetch(base+'/admin/api/logout',{method:'POST',headers});
  assert.equal((await fetch(url,{headers:{...headers,'if-none-match':etag}})).status,401);
});
