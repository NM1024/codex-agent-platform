import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
test.use({locale:'zh-CN',timezoneId:'Asia/Shanghai'});
const start=Date.now()-22000;
const request={id:'status-request',role:'user',text:'请整理这份资料，并生成一张配图。',status:'running',created_at:start,started_at:start,updated_at:start+16000,partial_text:'我正在整理资料，并准备生成配图。',activity:[{id:'image-tool',kind:'tool',label:'imageGeneration',text:'',status:'running',created_at:start+16000,updated_at:start+16000}]};
const snapshot=()=>({id:'status-chat',title:'资料整理与配图',execution:{},messages:[structuredClone(request)],actions:[],queued_count:0,running_count:1});
const bar=page=>page.locator('.chat-run-status');
const progress=page=>page.locator('.assistant .message-progress');
const finalReply=message=>({id:'final:'+message.id,role:'assistant',reply_to:message.id,text:'Synthetic final reply',status:'completed',created_at:message.completed_at??message.updated_at});
async function setup(page,conversation=snapshot()){
  await page.addInitScript(()=>{window.sources=[];window.EventSource=class extends EventTarget{constructor(){super();window.sources.push(this);}close(){}};window.emit=(type,data)=>window.sources.at(-1).dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));});
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[conversation],next_cursor:null}}));
  await page.route('**/admin/api/conversations/'+conversation.id,route=>route.fulfill({json:conversation}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect.poll(()=>page.evaluate(()=>window.sources.length)).toBe(1);await emit(page,'conversation',conversation);
  return conversation;
}
const emit=(page,type,data)=>page.evaluate(({type,data})=>window.emit(type,data),{type,data});
async function patch(page,message,counts={running_count:1,queued_count:0}){await emit(page,'patch',{conversation:{id:'status-chat',...counts},messages:[message,...(['completed','failed'].includes(message.status)?[finalReply(message)]:[])],actions:[]});}

test('tool status appears only with its message and the composer has no duplicate strip',async({page})=>{
  await setup(page);await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('.assistant .message-progress')).toContainText('正在生成图片');
  const header=page.locator('.user .message-label');await expect(header.locator('time')).toHaveCount(1);await expect(header).not.toContainText('运行中');await expect(header).not.toContainText('你');
  await expect(page.locator('.assistant .run-indicator')).toHaveAttribute('data-spinning','true');
  await page.locator('#message-input').fill('保留待发草稿');await page.locator('#messages').evaluate(node=>node.scrollTop=0);
  await expect(page.locator('#message-input')).toHaveValue('保留待发草稿');
});

test('completed tools do not mask new output and terminal messages ignore old running activity',async({page})=>{
  await setup(page);const writing={...request,activity:[{...request.activity[0],status:'completed'},{id:'reply',kind:'assistant_message',label:'Assistant',text:'正在整理结论',status:'running',created_at:Date.now(),updated_at:Date.now()}]};
  await patch(page,writing);await expect(progress(page)).toContainText('正在输出回复');
  await patch(page,{...writing,status:'completed',completed_at:Date.now()},{running_count:0,queued_count:0});
  await expect(progress(page)).toContainText('执行完成');await expect(progress(page).locator('.run-indicator')).toHaveAttribute('data-spinning','false');
  await patch(page,{...request,status:'failed',completed_at:Date.now()},{running_count:0,queued_count:0});await expect(progress(page)).toContainText('执行失败');await expect(bar(page)).toHaveCount(0);
});

test('waiting questions and interrupted messages do not animate as active work',async({page})=>{
  await setup(page);await patch(page,{...request,questions:[{id:'question',status:'pending',created_at:Date.now(),questions:[{id:'choice',header:'格式',question:'请选择输出格式',options:[],isOther:true}]}]});
  await expect(progress(page)).toContainText('等待你回答');await expect(progress(page).locator('.run-indicator')).toHaveAttribute('data-spinning','false');
  await patch(page,{...request,status:'interrupted'});await expect(progress(page)).toContainText('等待继续');
  await patch(page,{...request,status:'recovering'});await expect(progress(page)).toContainText('正在恢复');await expect(bar(page)).toHaveCount(0);
});

test('message progress qualifies stale state after disconnect or failed background reads',async({page})=>{
  await setup(page);await emit(page,'error',{});await expect(progress(page)).toContainText('正在重新连接');await expect(progress(page).locator('.run-indicator')).toHaveAttribute('data-spinning','false');
  await page.route('**/admin/api/conversations/status-chat',route=>route.fulfill({status:503,json:{error:{message:'Synthetic read failure'}}}));
  await expect(progress(page)).toContainText('状态更新失败');
  await emit(page,'conversation',snapshot());await expect(progress(page)).toContainText('正在生成图片');await expect(progress(page).locator('.run-indicator')).toHaveAttribute('data-spinning','true');await expect(bar(page)).toHaveCount(0);
});

test('queued and steered requests keep the active message status and last activity timestamp',async({page})=>{
  const conversation=snapshot();conversation.messages.push({...request,id:'queued',status:'queued',created_at:Date.now(),started_at:null,partial_text:null,activity:[]},{...request,id:'guidance',status:'steered',steer_parent_id:request.id,created_at:Date.now(),activity:[]});conversation.queued_count=1;
  await setup(page,conversation);await expect(progress(page)).toContainText('正在生成图片');await expect(page.locator('.chat-queue-item')).toHaveCount(1);
  const timestamp=await progress(page).locator('time').innerText();await emit(page,'conversation',conversation);expect(await progress(page).locator('time').innerText()).toBe(timestamp);
  await patch(page,{...request,status:'completed',completed_at:Date.now()},{running_count:0,queued_count:1});await expect(progress(page)).toContainText('执行完成');await expect(page.locator('.chat-queue-item')).toHaveCount(1);await expect(bar(page)).toHaveCount(0);
});

test('desktop and phone keep status within messages and leave the composer clear across locales',async({page})=>{
  test.setTimeout(45000);await setup(page);await page.locator('#message-input').fill('后续消息可以继续排队');
  for(const locale of ['zh-CN','en']){
    if(locale==='en'){await page.locator('#app-language').click();await page.getByText('English',{exact:true}).last().click();}
    for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
      await page.setViewportSize(viewport);await expect(bar(page)).toHaveCount(0);await expect(page.locator('.chat-compose .message-progress')).toHaveCount(0);await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
      await expect(progress(page)).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`.tmp/chat-status/message-only-${locale}-${viewport.width}.png`,animations:'disabled'});
    }
  }
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await expect(progress(page).locator('.run-indicator')).toHaveCSS('animation-name','none');
});

test('empty replies stop every loading indicator when waiting interrupted or disconnected',async({page})=>{
  const empty={...request,partial_text:'',activity:[]};await setup(page,{...snapshot(),messages:[empty]});
  await patch(page,{...empty,status:'interrupted'});await expect(page.locator('.assistant .ant-spin')).toHaveCount(0);await expect(page.locator('.assistant .partial-label')).not.toHaveText('回复中');
  await patch(page,{...empty,questions:[{id:'input',status:'pending',created_at:Date.now(),questions:[]}]});await expect(page.locator('.assistant .ant-spin')).toHaveCount(0);await expect(page.locator('.assistant .partial-label')).toHaveText('等待回答');
  await patch(page,empty);await emit(page,'error',{});await expect(page.locator('.assistant .run-indicator[data-spinning="true"]')).toHaveCount(0);await expect(page.locator('.assistant .ant-spin')).toHaveCount(0);
});

test('unreconciled old active roots cannot override a newer authoritative outcome or task',async({page})=>{
  await setup(page);await page.route('**/admin/api/conversations/status-chat/messages?*',route=>route.fulfill({status:503,json:{error:{message:'Synthetic reconciliation failure'}}}));
  const newer={...request,id:'latest-outcome',status:'completed',created_at:Date.now(),started_at:Date.now(),completed_at:Date.now(),partial_text:'最新任务已完成。',activity:[]};
  await emit(page,'conversation',{...snapshot(),messages:[newer],running_count:0});await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('[data-message-id="reply:status-request"] .message-progress')).toContainText('正在核对运行状态');
  await emit(page,'conversation',{...snapshot(),messages:[{...newer,status:'running',completed_at:null,activity:[{...request.activity[0],label:'webSearch'}]}],running_count:1});await expect(page.locator('[data-message-id="reply:latest-outcome"] .message-progress')).toContainText('正在搜索网页');
});

test('a 240px keyboard viewport keeps the composer reachable without a duplicate status strip',async({page})=>{
  await page.addInitScript(()=>{const viewport=new EventTarget();Object.assign(viewport,{height:844,width:390,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:viewport});window.resizeStatusViewport=height=>{viewport.height=height;viewport.dispatchEvent(new Event('resize'));};});
  await page.setViewportSize({width:390,height:844});await setup(page);await page.locator('#message-input').fill('键盘展开时保留草稿');await page.evaluate(()=>window.resizeStatusViewport(240));
  await expect.poll(async()=>Math.ceil((await page.locator('.composer-send').boundingBox()).y+(await page.locator('.composer-send').boundingBox()).height)).toBeLessThanOrEqual(240);
  await expect(bar(page)).toHaveCount(0);
  const input=await page.locator('#message-input').boundingBox(),toolbar=await page.locator('.composer-toolbar').boundingBox();expect(input.y+input.height).toBeLessThanOrEqual(toolbar.y+1);
  await expect(page.locator('#message-input')).toHaveValue('键盘展开时保留草稿');await page.screenshot({path:'.tmp/chat-status/keyboard-240.png'});
});

test('repeated conversation switches preserve message status without adding composer status DOM',async({page})=>{
  const first={...snapshot(),messages:[{...request,status:'completed',completed_at:request.started_at+44000},finalReply(request)],running_count:0};
  const second={...snapshot(),id:'other-status-chat',title:'另一条对话',messages:[{...request,id:'other-request',status:'completed',completed_at:request.started_at+15000},finalReply({...request,id:'other-request'})],running_count:0};
  const keyWarnings=[];page.on('console',message=>{if(/same key|Encountered two children/.test(message.text()))keyWarnings.push(message.text());});
  await setup(page,first);
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[first,second],next_cursor:null}}));
  await page.route('**/admin/api/conversations/'+second.id,route=>route.fulfill({json:second}));
  // Reload to consume both conversations, then use the same sidebar/drawer flow as the user.
  await page.reload();await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(first.title);
  await page.locator('#message-input').fill('切换对话时保留草稿');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:844});
    for(const current of [second,first,second,first]){
      if(width<992)await page.getByRole('button',{name:'会话列表',exact:true}).click();
      await page.locator(width<992?'.conversation-drawer:visible':'.conversation-sidebar').getByRole('button',{name:current.title,exact:true}).click();
      await expect(page.locator('.chat-header')).toContainText(current.title);
      await expect(bar(page)).toHaveCount(0);await expect(progress(page)).toHaveCount(1);
      await expect(progress(page)).toContainText(current.id===first.id?'耗时 44s':'耗时 15s');
      await expect(page.locator('.composer-input-shell')).toHaveCount(1);
      await expect(page.locator('#message-input')).toHaveValue('切换对话时保留草稿');
    }
    await page.screenshot({path:`.tmp/chat-status/conversation-switch-${width}.png`,animations:'disabled'});
  }
  expect(keyWarnings).toEqual([]);
  await page.getByRole('button',{name:'会话列表',exact:true}).click();
  await page.locator('.conversation-drawer:visible').getByRole('button',{name:'＋ 新对话',exact:true}).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('#message-input')).toHaveValue('切换对话时保留草稿');
});
