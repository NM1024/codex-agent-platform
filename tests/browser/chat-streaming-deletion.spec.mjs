import {navigate} from './navigation.mjs';
import {test,expect} from '@playwright/test';

const stamp=Date.now()-5000;
const turn={id:'turn-one',role:'user',text:'Synthetic request',status:'running',created_at:stamp,started_at:stamp,updated_at:stamp,partial_text:''};
const first={id:'11111111-1111-4111-8111-111111111111',title:'Live conversation',execution:{},messages:[turn],actions:[],running_count:1,queued_count:0};
const second={id:'22222222-2222-4222-8222-222222222222',title:'Other conversation',execution:{},messages:[],actions:[],running_count:0,queued_count:0};
async function setup(page,items=[first,second]) {
  // A controlled transport lets tests deliver events between REST reads without a real model turn.
  await page.addInitScript(()=>{
    window.chatStreams=[];
    window.EventSource=class extends EventTarget {
      constructor(url){super();this.url=url;this.readyState=0;window.chatStreams.push(this);}
      close(){this.readyState=2;}
    };
    window.emitChat=(index,type,data)=>{
      const source=window.chatStreams[index];
      if(type==='open'){source.readyState=1;source.dispatchEvent(new Event('open'));}
      else if(type==='error'){source.readyState=0;source.dispatchEvent(new Event('error'));}
      else source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));
    };
  });
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:items}));
  for(const item of items)await page.route(`**/admin/api/conversations/${item.id}`,route=>route.fulfill({json:item}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText(items[0].title);
}
const emit=(page,type,data,index=0)=>page.evaluate(({index,type,data})=>window.emitChat(index,type,data),{index,type,data});

test('stream patches render one live assistant bubble and finalize it without losing other messages',async({page})=>{
  await setup(page);
  await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(1);
  await emit(page,'open');await emit(page,'conversation',{...first,messages:[{...turn,attachments:[{id:'synthetic-image',name:'image.png',mime:'image/png',width:1,height:1,size:1,url:'/synthetic-image.png'}]}]});
  await expect(page.locator('.assistant .message-images')).toHaveCount(0);
  await emit(page,'patch',{conversation:{id:first.id,title:'Streaming title'},messages:[{...turn,partial_text:'Public answer arriving now'}],actions:[]});
  await expect(page.locator('.assistant .message-partial')).toContainText('Public answer arriving now');
  await expect(page.locator('.user .message-partial')).toHaveCount(0);
  await expect(page.locator('.chat-header')).toContainText('Streaming title');
  await page.screenshot({path:'.tmp/chat-streaming/chat-live-desktop.png',animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'.tmp/chat-streaming/chat-live-mobile.png',animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});
  await emit(page,'patch',{conversation:{id:first.id,queued_count:0,running_count:0},messages:[{...turn,status:'completed',completed_at:Date.now(),partial_text:null},{id:'final',role:'assistant',text:'Public answer arriving now',status:'completed',created_at:Date.now(),reply_to:turn.id}],actions:[]});
  await expect(page.locator('.assistant')).toHaveCount(1);await expect(page.locator('.message-partial')).toHaveCount(0);
  await expect(page.locator('.user')).toContainText('Synthetic request');
  await expect(page.getByRole('button',{name:'删除对话：Streaming title',exact:true})).toBeEnabled();
  await page.waitForTimeout(1200);await expect(page.locator('.assistant')).toContainText('Public answer arriving now');
});

test('reconnect snapshots replace old text and navigation closes stale event sources',async({page})=>{
  await setup(page);await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(1);
  await emit(page,'conversation',first);await emit(page,'error');
  await expect(page.locator('.chat-stream-status')).toContainText('重新连接');
  await emit(page,'open');await emit(page,'conversation',{...first,messages:[{...turn,partial_text:'Resumed public answer'}]});
  await expect(page.locator('.assistant')).toContainText('Resumed public answer');
  await page.locator('.conversation-list').getByRole('button',{name:second.title,exact:true}).click();
  await expect(page.locator('.chat-header')).toContainText(second.title);
  await expect.poll(()=>page.evaluate(()=>window.chatStreams[0].readyState)).toBe(2);
  await emit(page,'conversation',{...first,title:'Stale title',messages:[{...turn,partial_text:'Stale response'}]});
  await expect(page.locator('#messages')).not.toContainText('Stale response');await expect(page.locator('.chat-header')).toContainText(second.title);
  await navigate(page,'overview');
  await expect.poll(()=>page.evaluate(()=>window.chatStreams.every(source=>source.readyState===2))).toBe(true);
});

test('history deletion confirms once, waits for completion and preserves the composer draft',async({page})=>{
  const done={...first,messages:[],running_count:0};await setup(page,[done,second]);
  let release,calls=0;const held=new Promise(resolve=>release=resolve);
  await page.route(`**/admin/api/conversations/${first.id}`,async route=>{if(route.request().method()==='DELETE'){calls++;await held;return route.fulfill({json:{deleted:true}});}return route.fulfill({json:done});});
  await page.locator('#message-input').fill('Keep my unrelated draft');
  await page.getByRole('button',{name:`删除对话：${first.title}`,exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('删除后无法恢复');
  await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'删除',exact:true})).toHaveClass(/ant-btn-loading/);
  release();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.conversation-list')).not.toContainText(first.title);
  await expect(page.locator('.chat-header')).toContainText('新对话');
  await expect(page.locator('#message-input')).toHaveValue('Keep my unrelated draft');expect(calls).toBe(1);
  // A delayed stale list response must not resurrect a deleted history row.
  await page.waitForTimeout(5200);await expect(page.locator('.conversation-list')).not.toContainText(first.title);
});

test('busy rows explain deletion protection and server deletion failures retain history',async({page})=>{
  await setup(page);
  await expect(page.getByRole('button',{name:`删除对话：${first.title}`,exact:true})).toBeDisabled();
  await expect(page.locator('.conversation-row').first()).toHaveAttribute('title',/待处理/);
  await page.route(`**/admin/api/conversations/${second.id}`,route=>route.request().method()==='DELETE'?route.fulfill({status:409,json:{error:{code:'CONVERSATION_BUSY',message:'对话仍有待处理消息，请等待执行结束后删除。'}}}):route.fulfill({json:second}));
  await page.getByRole('button',{name:`删除对话：${second.title}`,exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('待处理消息');
  await expect(page.locator('.conversation-list')).toContainText(second.title);
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
});

test('external deletion resets the selected chat and session expiry signs out',async({page})=>{
  await setup(page);await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(1);
  await emit(page,'deleted',{id:first.id});await expect(page.locator('.chat-header')).toContainText('新对话');
  await expect(page.locator('.conversation-list')).not.toContainText(first.title);
  await page.locator('.conversation-list').getByRole('button',{name:second.title,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(2);
  await emit(page,'session-expired',{},1);await expect(page.locator('#login')).toBeVisible();
});

test('an unavailable stream polls and a late REST read cannot overwrite a resumed snapshot',async({page})=>{
  await setup(page);await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(1);
  const fallback={...first,messages:[{...turn,partial_text:'Reply from fallback read'}]};
  await page.route(`**/admin/api/conversations/${first.id}`,route=>route.fulfill({json:fallback}));
  await emit(page,'error');await expect(page.locator('.assistant')).toContainText('Reply from fallback read');
  let release,started;const held=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);
  await page.route(`**/admin/api/conversations/${first.id}`,async route=>{started();await held;await route.fulfill({status:404,json:{error:{message:'Stale read response'}}}).catch(()=>{});});
  try {
    await requested;await emit(page,'open');await emit(page,'conversation',{...first,messages:[{...turn,partial_text:'Newest reply from live stream'}]});
    release();await expect(page.locator('.assistant')).toContainText('Newest reply from live stream');
    await page.waitForTimeout(1200);await expect(page.locator('.assistant')).not.toContainText('Reply from fallback read');
  } finally {release();}
});

test('mobile history deletion clears the selected chat and closes the drawer',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const done={...first,messages:[],running_count:0};await setup(page,[done,second]);
  await page.route(`**/admin/api/conversations/${first.id}`,route=>route.request().method()==='DELETE'?route.fulfill({json:{deleted:true}}):route.fulfill({json:done}));
  await page.locator('.conversation-toggle').click();
  const drawer=page.locator('.conversation-drawer');await expect(drawer).toBeVisible();
  await drawer.getByRole('button',{name:`删除对话：${first.title}`,exact:true}).click();
  await expect(page.getByRole('dialog',{name:'删除对话',exact:true})).toBeVisible();
  await page.getByRole('dialog',{name:'删除对话',exact:true}).getByRole('button',{name:'删除',exact:true}).click({trial:true});
  await page.screenshot({path:'.tmp/chat-streaming/chat-delete-mobile.png',animations:'disabled'});
  await page.getByRole('dialog',{name:'删除对话',exact:true}).getByRole('button',{name:'删除',exact:true}).click();
  await expect(drawer).not.toBeVisible();await expect(page.locator('.chat-header')).toContainText('新对话');
  await page.locator('.conversation-toggle').click();await expect(drawer).not.toContainText(first.title);
});

test('native SSE displays incremental synthetic replies then deletes durable history',async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await page.getByRole('button',{name:'＋ 新对话',exact:true}).click();
  await page.locator('#message-input').fill('Browser streaming fixture');
  await page.locator('.composer-send').click();
  await expect(page.locator('.assistant .message-partial')).toContainText('第一段公开回复。');
  await expect(page.locator('.assistant .message-partial')).toContainText('第二段继续到达。');
  await expect(page.locator('.assistant .message-partial')).toHaveCount(0);
  await expect(page.locator('.assistant')).toHaveCount(1);
  await expect(page.locator('.assistant')).toContainText('第一段公开回复。第二段继续到达。完整回复已结束。');
  const row=page.locator('.conversation-row').filter({has:page.locator('[aria-current="true"]')});
  const selectedId=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>entry.name).findLast(name=>/\/conversations\/[^/]+\/messages$/.test(name)).match(/conversations\/([^/]+)/)[1]);
  await row.getByRole('button',{name:/删除对话/}).click();await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
  await expect(page.locator('.chat-header')).toContainText('新对话');
  expect((await page.request.get('/admin/api/conversations/'+selectedId)).status()).toBe(404);
});

test('a late enqueue response cannot replace a message already running in the stream',async({page})=>{
  await setup(page);await expect.poll(()=>page.evaluate(()=>window.chatStreams.length)).toBe(1);
  let releasePost,postStarted,releaseRead,readStarted;
  const posted=new Promise(resolve=>postStarted=resolve),postGate=new Promise(resolve=>releasePost=resolve);
  const reading=new Promise(resolve=>readStarted=resolve),readGate=new Promise(resolve=>releaseRead=resolve);
  const admitted={id:'late-admission',role:'user',text:'Admission race request',status:'queued',created_at:Date.now()};
  const streamed={...first,messages:[{...turn,status:'completed'},{...admitted,status:'running',partial_text:'Live reply before admission returns'}]};
  await page.route(`**/admin/api/conversations/${first.id}/messages`,async route=>{postStarted();await postGate;await route.fulfill({status:202,json:admitted}).catch(()=>{});});
  await page.route(`**/admin/api/conversations/${first.id}`,async route=>{
    if(route.request().method()==='GET'){readStarted();await readGate;}
    await route.fulfill({json:streamed}).catch(()=>{});
  });
  try {
    await emit(page,'conversation',first);
    await page.locator('#message-input').fill(admitted.text);await page.locator('.composer-send').click();await posted;
    await emit(page,'conversation',streamed);
    await expect(page.locator('.assistant .message-partial')).toContainText('Live reply before admission returns');
    releasePost();await reading;
    await expect(page.locator('#message-input')).toHaveValue('');
    await expect(page.locator('.assistant .message-partial')).toContainText('Live reply before admission returns');
    await expect(page.locator('.message-progress').last()).toHaveAttribute('data-status','running');
    await expect(page.locator('.message.user').filter({hasText:admitted.text})).toHaveCount(1);
  } finally {releasePost();releaseRead();}
});
