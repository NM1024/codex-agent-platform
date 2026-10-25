import {test,expect} from '@playwright/test';

import {navigate} from './navigation.mjs';
const stamp=Date.now()-10000;
const user=(id,status,text)=>({id,role:'user',status,text,created_at:stamp,started_at:status==='queued'?null:stamp+1000,updated_at:stamp+5000});
async function raster(page,width=32,height=16) {
  return Buffer.from(await page.evaluate(async({width,height})=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').fillRect(0,0,width,height);return Array.from(new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer()));},{width,height}));
}
async function synthetic(page,conversation) {
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[conversation]}));
  await page.route(`**/admin/api/conversations/${conversation.id}`,route=>route.fulfill({json:conversation}));
  await navigate(page,'chat');
}
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();
});

test('composer keeps one continuous focus frame while typing or choosing a model',async({page})=>{
  await navigate(page,'chat');await page.locator('#message-input').fill('Synthetic focus check');
  const frame=page.locator('.composer-input-shell');await expect(frame).toBeVisible();
  for(const target of ['#message-input','#chat-model','.chat-image-picker','.composer-send']){
    await page.locator(target).focus();
    const borders=await frame.evaluate(element=>{const style=getComputedStyle(element);return ['Top','Right','Bottom','Left'].map(edge=>({width:style['border'+edge+'Width'],color:style['border'+edge+'Color']}));});
    expect(new Set(borders.map(border=>border.color)).size).toBe(1);expect(borders.every(border=>border.width==='1px')).toBe(true);
    await expect(frame.locator('#message-input')).toHaveCSS('border-top-width','0px');
    await expect(frame.locator('#message-input')).toHaveCSS('outline-style','none');
    await expect(frame.locator('.composer-toolbar')).toHaveCSS('border-bottom-width','0px');
  }
});

test('running turns show partial replies, collapsed activity and FIFO pending messages',async({page})=>{
  const conversation={id:'progress-chat',title:'Synthetic progress',execution:{},messages:[
    {...user('first','running','First request'),activity:[{id:'summary',kind:'reasoning_summary',label:'Progress summary',text:'Inspecting synthetic queue',status:'running',created_at:stamp,updated_at:stamp+5000},{id:'partial',kind:'assistant_message',label:'Assistant',text:'Partial answer while working',status:'running',created_at:stamp,updated_at:stamp+5000}]},
    user('second','queued','Second request'),user('third','queued','Third request')],actions:[{id:'tool-action',message_id:'first',name:'configuration_get',status:'completed'}]};
  await synthetic(page,conversation);
  await expect(page.locator('.chat-run-status')).toContainText('排队 2 条');
  await expect(page.locator('.message-progress').first()).toContainText('运行中');
  await expect(page.locator('.message-partial')).toContainText('Partial answer while working');
  await expect(page.getByText('Inspecting synthetic queue',{exact:true})).not.toBeVisible();
  await page.locator('.message-activity summary').first().click();
  await expect(page.locator('.user .message-activity')).toHaveCount(0);
  await expect(page.locator('.assistant .message-activity')).toBeVisible();
  await expect(page.locator('.assistant .message-activity')).toContainText('configuration_get');
  await expect(page.locator('.message-activity summary')).toHaveText('执行过程 (2)');
  await expect(page.getByText('Inspecting synthetic queue',{exact:true})).toBeVisible();
  await expect(page.locator('.message-activity')).not.toContainText('Partial answer while working');
  await expect(page.locator('.message-progress').first()).toContainText('最近活动');
  await page.locator('#message-input').fill('Queue another request');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();
  conversation.messages[0].status='completed';conversation.messages[0].completed_at=Date.now();
  conversation.messages.push({id:'reply',role:'assistant',text:'Final answer',status:'completed',reply_to:'first',created_at:Date.now()});
  await expect(page.locator('.message-progress').first()).toContainText('执行完成');
  await expect(page.locator('.message-partial')).toHaveCount(0);
  await expect(page.locator('.assistant')).toContainText('Final answer');
  await expect(page.locator('.assistant .message-activity')).not.toContainText('Final answer');
});

test('completed replies appear once and assistant-only activity does not leave an empty timeline',async({page})=>{
  const text='Synthetic final reply appears once';
  const conversation={id:'unique-reply',title:'Unique reply',execution:{},messages:[
    {...user('request','completed','Show one reply'),activity:[{id:'final',kind:'assistant_message',label:'Assistant',text,status:'completed',created_at:stamp,updated_at:stamp}]},
    {id:'reply',role:'assistant',text,status:'completed',reply_to:'request',created_at:stamp}],actions:[]};
  await synthetic(page,conversation);
  await expect(page.locator('.assistant .message-bubble')).toHaveText(text);
  await expect(page.locator('.message-activity')).toHaveCount(0);
  const copy=page.getByRole('button',{name:'复制回复',exact:true});
  await expect(copy.locator('svg')).toBeVisible();
  await expect(copy).toHaveText('');
});

test.describe('localized live message header',()=>{
test.use({locale:'zh-CN'});
test('short live replies keep author time and reply status on one line without overflowing',async({page})=>{
  await synthetic(page,{id:'short-header',title:'Short live reply',execution:{},messages:[{...user('request','running','Short reply please'),partial_text:'好'}],actions:[]});
  for(const language of ['zh-CN','en']){
  if(language==='en'){await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();}
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568}]){
    await page.setViewportSize(viewport);
    const header=page.locator('.assistant .message-label');
    await expect(header.locator('.partial-label')).toHaveText(language==='en'?'Status unconfirmed':'状态待确认');
    const boxes=await header.locator(':scope > *').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().toJSON()));
    const centers=boxes.map(box=>box.y+box.height/2);
    expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(2);
    for(const box of boxes){expect(box.x).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(viewport.width);}
    await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
  }
  }
});
});

test('image drafts and a pending queue leave readable transcript space on short phones',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  const conversation={id:'short-images',title:'Synthetic short image chat',execution:{},messages:[
    {...user('active','running','Read the attached images'),activity:[{id:'summary',kind:'reasoning_summary',label:'Reasoning summary',text:'Reviewing the supplied images.',status:'running',created_at:stamp,updated_at:stamp}]},
    user('next','queued','Then summarize the findings')],actions:[]};
  await synthetic(page,conversation);
  const buffer=await raster(page);
  await page.locator('#chat-image-input').setInputFiles(Array.from({length:4},(_,index)=>({name:`layout-${index}.png`,mimeType:'image/png',buffer})));
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(4);
  await page.locator('#message-input').fill('Line one\nLine two\nLine three\nLine four\nLine five\nLine six');
  await page.locator('.message-activity summary').click();
  await expect.poll(async()=> (await page.locator('#messages').boundingBox()).height).toBeGreaterThanOrEqual(96);
  await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(async()=>{
    const rows=await page.locator('.chat-image-drafts figure').evaluateAll(items=>items.map(item=>Math.round(item.getBoundingClientRect().top)));
    return new Set(rows).size;
  }).toBe(1);
  await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
  await page.locator('#app-language').click();await page.getByText('English',{exact:true}).last().click();
  await page.setViewportSize({width:320,height:844});
  const drafts=await page.locator('.chat-image-drafts figure').evaluateAll(items=>items.map(item=>{const style=getComputedStyle(item);return {available:item.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),button:item.querySelector('button').getBoundingClientRect().width};}));
  for(const draft of drafts)expect(draft.button,'English remove control must fit its thumbnail').toBeLessThanOrEqual(draft.available+1);
  await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
});

test('initial chat errors are local and retry while background errors preserve the transcript',async({page})=>{
  const conversation={id:'loading-chat',title:'Synthetic load',execution:{},messages:[user('persisted','completed','Keep this transcript')],actions:[]};
  let fail=true;
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[conversation]}));
  await page.route('**/admin/api/conversations/loading-chat',route=>fail?route.fulfill({status:503,json:{error:{message:'Synthetic read failure'}}}):route.fulfill({json:conversation}));
  await navigate(page,'chat');await expect(page.locator('.chat-load-error')).toContainText('Synthetic read failure');
  fail=false;await page.locator('.chat-load-error button').click();
  await expect(page.locator('#messages')).toContainText('Keep this transcript');
  fail=true;await page.waitForTimeout(1200);
  await expect(page.locator('#messages')).toContainText('Keep this transcript');
  await expect(page.locator('.chat-load-error')).toHaveCount(0);
});

test('image-only drafts compress, survive navigation and can be removed',async({page})=>{
  await navigate(page,'chat');
  const bytes=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1200;canvas.getContext('2d').fillRect(0,0,2400,1200);return Array.from(new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer()));});
  await page.locator('#chat-image-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(bytes)});
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  const info=await page.locator('.chat-image-drafts img').evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight,url:img.src}));
  expect(Math.max(info.width,info.height)).toBeLessThanOrEqual(2048);expect(info.url).toMatch(/^data:image\/jpeg;base64,/);
  expect(Buffer.from(info.url.split(',')[1],'base64').length).toBeLessThanOrEqual(160*1024);
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();
  await navigate(page,'overview');await navigate(page,'chat');await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  await page.locator('.chat-image-drafts button').click();await expect(page.locator('.chat-image-drafts img')).toHaveCount(0);
});

test('accepted sends clear their draft even when the following read fails',async({page})=>{
  const conversation={id:'enqueue-chat',title:'Synthetic accepted send',execution:{},messages:[],actions:[]};let accepted=false,calls=0;
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[conversation]}));
  await page.route('**/admin/api/conversations/enqueue-chat',route=>route.request().method()==='POST'?route.fulfill({json:conversation}):accepted?route.fulfill({status:503,json:{error:{message:'Read temporarily unavailable'}}}):route.fulfill({json:conversation}));
  await page.route('**/admin/api/conversations/enqueue-chat/messages',route=>{accepted=true;calls++;return route.fulfill({status:202,json:user('accepted-message','queued','Only enqueue once')});});
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(conversation.title);
  await page.locator('#message-input').fill('Only enqueue once');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('#message-input')).toHaveValue('');
  await expect(page.locator('.chat-queue')).toContainText('Only enqueue once');
  await expect(page.locator('#messages')).not.toContainText('Only enqueue once');
  expect(calls).toBe(1);
});

test('an accepted message releases the send button before its background read finishes',async({page})=>{
  const conversation={id:'slow-confirmation',title:'Slow confirmation',execution:{},messages:[]};let accepted=false,release;
  const held=new Promise(resolve=>release=resolve);
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[conversation]}));
  await page.route('**/admin/api/conversations/slow-confirmation',async route=>{
    if(route.request().method()==='GET'&&accepted)await held;
    await route.fulfill({json:conversation}).catch(()=>{});
  });
  await page.route('**/admin/api/conversations/slow-confirmation/messages',route=>{accepted=true;const message=user('accepted-slow','queued','Accepted before read');conversation.messages.push(message);return route.fulfill({status:202,json:message});});
  try {
    await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(conversation.title);
    await page.locator('#message-input').fill('Accepted before read');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.locator('.chat-queue')).toContainText('Accepted before read');
    await expect(page.locator('#messages')).not.toContainText('Accepted before read');
    await page.locator('#message-input').fill('Ready for another queued message');
    await expect(page.locator('.composer-send')).not.toHaveClass(/ant-btn-loading/);
  } finally {release();}
});

test('pasted and dropped images share the four-image limit and reject oversized raster dimensions',async({page})=>{
  await navigate(page,'chat');const bytes=Array.from(await raster(page));
  for(const [index,type] of ['paste','drop'].entries()) {
    await page.locator(type==='paste'?'#message-input':'.chat-compose').evaluate((target,{bytes,type})=>{
      const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],`${type}.png`,{type:'image/png'}));
      target.dispatchEvent(type==='paste'?new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
    },{bytes,type});
    await expect(page.locator('.chat-image-drafts img')).toHaveCount(index+1);
  }
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(2);
  const file={name:'extra.png',mimeType:'image/png',buffer:Buffer.from(bytes)};
  await page.locator('#chat-image-input').setInputFiles([file,file,file]);
  await expect(page.locator('.chat-image-error')).toContainText('最多添加 4');
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(2);
  const huge=Buffer.from(bytes);huge.writeUInt32BE(10000,16);huge.writeUInt32BE(10000,20);
  await page.locator('#chat-image-input').setInputFiles({name:'oversized.png',mimeType:'image/png',buffer:huge});
  await expect(page.locator('.chat-image-error')).toContainText('4000 万像素');
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(2);
});

test('image-only sends persist compressed attachments behind authenticated same-origin previews',async({page})=>{
  await navigate(page,'chat');await page.getByRole('button',{name:'＋ 新对话',exact:true}).click();
  await page.locator('#chat-image-input').setInputFiles({name:'image-only.png',mimeType:'image/png',buffer:await raster(page,128,64)});
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  const sent=page.waitForRequest(request=>request.url().endsWith('/messages')&&request.method()==='POST');
  await page.getByRole('button',{name:'发送',exact:true}).click();const request=await sent;
  expect(request.postDataJSON().text).toBe('');expect(request.postDataJSON().attachments[0].name).toBe('image-only.png');
  expect(request.postDataJSON().attachments[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  await expect(page.locator('.message-images img')).toHaveCount(1);await expect(page.locator('.chat-image-drafts img')).toHaveCount(0);
  const image=page.locator('.message-images img');await expect.poll(()=>image.evaluate(element=>element.complete&&element.naturalWidth>0)).toBe(true);
  const imageUrl=await image.getAttribute('src');expect(imageUrl).toMatch(/^\/admin\/api\/conversations\/[^/]+\/images\/[^/]+$/);
  expect((await page.request.get(imageUrl)).status()).toBe(200);
  await page.reload();await expect(page.locator('#workspace')).toBeVisible();await navigate(page,'chat');await expect(page.locator('.message-images img')).toHaveCount(1);
});

test('switching conversations shows an independent loader and ignores a late previous response',async({page})=>{
  const first={id:'slow-first',title:'Slow first',execution:{},messages:[user('old','completed','Old conversation content')]};
  const second={id:'fast-second',title:'Fast second',execution:{},messages:[user('new','failed','New conversation content')]};
  let release;const held=new Promise(resolve=>release=resolve);
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[first,second]}));
  await page.route('**/admin/api/conversations/slow-first',async route=>{await held;await route.fulfill({json:first}).catch(()=>{});});
  await page.route('**/admin/api/conversations/fast-second',route=>route.fulfill({json:second}));
  await navigate(page,'chat');await expect(page.locator('.chat-loading')).toBeVisible();
  await page.locator('.conversation-list').getByRole('button',{name:'Fast second',exact:true}).click();
  await expect(page.locator('#messages')).toContainText('New conversation content');release();
  await page.waitForTimeout(250);await expect(page.locator('#messages')).not.toContainText('Old conversation content');
  await expect(page.locator('.chat-run-status')).toContainText('执行失败');
});

test('leaving chat during compression cannot repopulate the image draft after logout',async({page})=>{
  await page.evaluate(()=>{const original=window.createImageBitmap;window.createImageBitmap=(...args)=>new Promise(resolve=>{window.releaseSyntheticImage=async()=>resolve(await original(...args));});});
  await navigate(page,'chat');await page.locator('#chat-image-input').setInputFiles({name:'held.png',mimeType:'image/png',buffer:await raster(page)});
  await expect(page.locator('.chat-image-busy')).toBeVisible();await page.locator('#logout').click();await expect(page.locator('#login')).toBeVisible();
  await page.evaluate(()=>window.releaseSyntheticImage());
  await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(0);
});
