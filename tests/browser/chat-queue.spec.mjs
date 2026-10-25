import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const id='abababab-abab-4bab-8bab-abababababab',stamp=Date.now()-10000;
const message=(id,status,text)=>({id,role:'user',status,text,created_at:stamp,updated_at:stamp});
async function setup(page) {
  const active=message('11111111-1111-4111-8111-111111111111','running','Current task');
  const queued=message('22222222-2222-4222-8222-222222222222','queued','Next queued request');
  const conversation={id,title:'Queue controls',execution:{},messages:[active,queued],queue:[queued],actions:[],queued_count:1,running_count:1};
  await page.addInitScript(()=>{
    window.sources=[];window.EventSource=class extends EventTarget{constructor(){super();window.sources.push(this);}close(){}};
    window.emit=(type,data)=>window.sources.at(-1).dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));
  });
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[conversation],next_cursor:null}}));
  await page.route(`**/admin/api/conversations/${id}`,route=>route.fulfill({json:conversation}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText('Queue controls');
  const row=page.locator(`[data-queue-message-id="${queued.id}"]`);
  return {conversation,queued,active,row};
}

test('unsent rows stay above the composer and appear in the transcript only when execution starts',async({page})=>{
  const {conversation,queued,row}=await setup(page);
  await expect(row).toContainText(queued.text);await expect(page.locator('#messages .user')).toHaveCount(1);
  await expect(page.locator('#messages')).not.toContainText(queued.text);
  await expect(row.getByRole('button',{name:'撤回编辑',exact:true})).toBeVisible();
  await expect(row.getByRole('button',{name:'删除排队消息',exact:true})).toBeVisible();
  await expect(row.getByRole('button',{name:'立即引导',exact:true})).toBeEnabled();
  await page.evaluate(({id,queued})=>window.emit('patch',{conversation:{id,queue:[],queued_count:0},messages:[{...queued,status:'running',started_at:Date.now()}],actions:[]}),{id,queued});
  await expect(row).toHaveCount(0);await expect(page.locator('#messages .user')).toHaveCount(2);
  await expect(page.locator('#messages')).toContainText(queued.text);
});

test('withdraw edits retain their text across navigation without replacing the composer draft',async({page})=>{
  const {conversation,queued,row}=await setup(page);
  await page.locator('#message-input').fill('Unrelated composer draft');
  await page.route(`**/messages/${queued.id}/withdraw`,route=>{queued.status='draft';conversation.queued_count=0;return route.fulfill({json:queued});});
  await page.route(`**/messages/${queued.id}/requeue`,async route=>{expect(route.request().postDataJSON()).toEqual({text:'Edited queued request'});queued.text='Edited queued request';queued.status='queued';conversation.queued_count=1;await route.fulfill({json:queued});});
  await row.getByRole('button',{name:'撤回编辑',exact:true}).click();
  const editor=row.getByRole('textbox',{name:'编辑排队消息',exact:true});
  await expect(editor).toHaveValue('Next queued request');await editor.fill('Edited queued request');
  await navigate(page,'overview');await navigate(page,'chat');
  await expect(editor).toHaveValue('Edited queued request');await expect(page.locator('#message-input')).toHaveValue('Unrelated composer draft');
  await row.getByRole('button',{name:'重新排队',exact:true}).click();
  await expect(editor).toHaveCount(0);await expect(row).toContainText('Edited queued request');
  await expect(page.locator('#messages')).not.toContainText('Edited queued request');
  await expect(page.locator('#message-input')).toHaveValue('Unrelated composer draft');
});

test('delete removes a queue entry and immediate guidance displays it as sent once',async({page})=>{
  const {conversation,queued,row}=await setup(page);
  let calls=0;
  await page.route(`**/messages/${queued.id}/steer`,async route=>{expect(route.request().method()).toBe('POST');calls++;queued.status='steered';queued.steer_parent_id=conversation.messages[0].id;conversation.queue=[];conversation.queued_count=0;await route.fulfill({json:queued});});
  await row.getByRole('button',{name:'立即引导',exact:true}).click();
  await expect(row).toHaveCount(0);await expect(page.locator('#messages .user')).toHaveCount(2);expect(calls).toBe(1);
  await expect(page.locator('#messages')).toContainText('已引导');
  const next=message('33333333-3333-4333-8333-333333333333','queued','Delete this request');
  conversation.queue=[next];conversation.messages.push(next);
  await page.evaluate(({id,next})=>window.emit('patch',{conversation:{id,queue:[next],queued_count:1},messages:[next],actions:[]}),{id,next});
  const nextRow=page.locator(`[data-queue-message-id="${next.id}"]`);
  await page.route(`**/messages/${next.id}`,route=>{expect(route.request().method()).toBe('DELETE');conversation.queue=[];conversation.messages=conversation.messages.filter(m=>m.id!==next.id);return route.fulfill({json:{id:next.id,deleted:true}});});
  await nextRow.getByRole('button',{name:'删除排队消息',exact:true}).click();await expect(nextRow).toHaveCount(0);
  await expect(page.locator('#messages')).not.toContainText(next.text);
});

test('queue failures remain local and uncertain native sends cannot be edited deleted or retried',async({page})=>{
  const {queued,row}=await setup(page);
  await page.route(`**/messages/${queued.id}/withdraw`,route=>route.fulfill({status:409,json:{error:{message:'消息状态已改变，请刷新后重试。'}}}));
  await row.getByRole('button',{name:'撤回编辑',exact:true}).click();await expect(row).toContainText('消息状态已改变');
  await page.evaluate(({id,queued})=>window.emit('patch',{conversation:{id,queue:[{...queued,status:'steer_unknown'}],queued_count:0},messages:[{...queued,status:'steer_unknown'}],actions:[]}),{id,queued});
  await expect(row).toContainText('引导状态待确认');
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(page.locator('#messages')).not.toContainText(queued.text);
});

test('queue actions fit phone layouts and retain readable transcript space',async({page})=>{
  const {row}=await setup(page);
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    for(const button of await row.getByRole('button').all())await expect(button).toBeInViewport({ratio:1});
    await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
    expect((await page.locator('#messages').boundingBox()).height).toBeGreaterThanOrEqual(96);
    const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width);
    if(viewport.width===390)await page.screenshot({path:'.tmp/chat-queue/phone.png'});
    if(viewport.width===1440)await page.screenshot({path:'.tmp/chat-queue/desktop.png'});
  }
});

test('guidance stays between the parent output before it and the output that follows it',async({page})=>{
  const {conversation,active,queued}=await setup(page);
  active.replies=[{id:'before',text:'Before guidance',status:'completed',created_at:stamp+1,updated_at:stamp+2},{id:'after',text:'After guidance',status:'running',created_at:stamp+4,updated_at:stamp+5}];
  queued.status='steered';queued.steer_parent_id=active.id;queued.started_at=stamp+3;queued.created_at=stamp+3;conversation.queue=[];
  await page.evaluate(conversation=>window.emit('conversation',conversation),conversation);
  await expect(page.locator('#messages .message-bubble')).toHaveText(['Current task','Before guidance','Next queued request','After guidance']);
});

test('a successful edit retires its draft so later edits use the latest authoritative text',async({page})=>{
  const {conversation,queued,row}=await setup(page);
  await page.route(`**/messages/${queued.id}/withdraw`,route=>{queued.status='draft';return route.fulfill({json:queued});});
  await page.route(`**/messages/${queued.id}/requeue`,route=>{queued.text=route.request().postDataJSON().text;queued.status='queued';return route.fulfill({json:queued});});
  await row.getByRole('button',{name:'撤回编辑',exact:true}).click();
  await row.getByRole('textbox',{name:'编辑排队消息',exact:true}).fill('First tab edit');
  await row.getByRole('button',{name:'重新排队',exact:true}).click();await expect(row).toContainText('First tab edit');
  queued.text='Newer edit from another tab';
  await page.evaluate(conversation=>window.emit('conversation',conversation),conversation);
  await expect(row).toContainText('Newer edit from another tab');
  await row.getByRole('button',{name:'撤回编辑',exact:true}).click();
  await expect(row.getByRole('textbox',{name:'编辑排队消息',exact:true})).toHaveValue('Newer edit from another tab');
});

test('reconnect restores guidance with its older parent when both are outside the latest history page',async({page})=>{
  const {active,queued}=await setup(page);
  const guidance={...message('44444444-4444-4444-8444-444444444444','steered','Guidance accepted while offline'),steer_parent_id:active.id,started_at:stamp+2};
  await page.route(`**/conversations/${id}/messages?ids=*`,route=>route.fulfill({json:{messages:[{...active,status:'completed'},guidance,{...queued,status:'removed'},{id:'old-final',role:'assistant',reply_to:active.id,status:'completed',text:'Older guided result',created_at:stamp+3}],actions:[]}}));
  await page.evaluate(({id,stamp})=>window.emit('conversation',{id,title:'Queue controls',execution:{},queue:[],messages:[{id:'55555555-5555-4555-8555-555555555555',role:'user',status:'running',text:'Newest active request',created_at:stamp+20}],actions:[],history:{has_more:true,before:'55555555-5555-4555-8555-555555555555'}}),{id,stamp});
  await expect(page.locator('#messages')).toContainText('Guidance accepted while offline');
  await expect(page.locator('#messages')).toContainText('Older guided result');
});
