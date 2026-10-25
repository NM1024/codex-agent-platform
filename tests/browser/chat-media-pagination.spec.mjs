import {test,expect} from '@playwright/test';
import sharp from 'sharp';

const id='55555555-5555-4555-8555-555555555555',stamp=Date.now()-10000;
const request={id:'66666666-6666-4666-8666-666666666666',role:'user',text:'Synthetic request',status:'running',created_at:stamp,partial_text:''};
const latest={id,title:'Paged media chat',execution:{},messages:[request],actions:[],history:{has_more:true,before:request.id}};
async function setup(page) {
  await page.addInitScript(()=>{
    window.sources=[];window.EventSource=class extends EventTarget{constructor(){super();window.sources.push(this);}close(){}};
    window.emit=(type,data)=>window.sources.at(-1).dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));
  });
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[latest],next_cursor:'synthetic-cursor'}}));
  await page.route(`**/admin/api/conversations/${id}`,route=>route.fulfill({json:latest}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await page.locator('[data-view="chat"]').click();
  await expect(page.locator('.chat-header')).toContainText(latest.title);await expect.poll(()=>page.evaluate(()=>window.sources.length)).toBe(1);
}
const emit=(page,type,data)=>page.evaluate(({type,data})=>window.emit(type,data),{type,data});

test('new replies reveal gradually and completion keeps the same bubble while history renders immediately',async({page})=>{
  await setup(page);await emit(page,'conversation',latest);
  const text='这是一段逐字显示的回复。🌈👩‍💻'.repeat(18);
  await emit(page,'patch',{conversation:{id},messages:[{...request,partial_text:text}],actions:[]});
  const bubble=page.locator('.assistant .message-markdown');
  await expect(bubble).toHaveAttribute('data-typing','true');
  expect((await bubble.innerText()).length).toBeLessThan(text.length);
  await emit(page,'patch',{conversation:{id},messages:[{...request,status:'completed',partial_text:null},{id:'final',role:'assistant',status:'completed',reply_to:request.id,text,created_at:Date.now()}],actions:[]});
  await expect(bubble).toHaveText(text);await expect(bubble).toHaveAttribute('data-typing','false');await expect(page.locator('.assistant')).toHaveCount(1);
  await emit(page,'conversation',{...latest,messages:[{...request,status:'completed'},{id:'final',role:'assistant',status:'completed',reply_to:request.id,text:'Historical answer',created_at:stamp}]});
  await expect(bubble).toHaveText('Historical answer');await expect(bubble).toHaveAttribute('data-typing','false');
});

test('earlier history and sidebar pages survive live snapshots and do not duplicate messages',async({page})=>{
  await setup(page);
  const older={...latest,messages:[{...request,id:'77777777-7777-4777-8777-777777777777',status:'completed',text:'Earlier request'},{id:'old-reply',role:'assistant',reply_to:'77777777-7777-4777-8777-777777777777',status:'completed',text:'Earlier answer',created_at:stamp-100}],history:{has_more:false,before:null}};
  await page.route(`**/admin/api/conversations/${id}?before=*`,route=>route.fulfill({json:older}));
  await page.getByRole('button',{name:'加载更早消息',exact:true}).click();
  await expect(page.locator('#messages')).toContainText('Earlier answer');
  await emit(page,'conversation',latest);await expect(page.locator('#messages')).toContainText('Earlier answer');
  await page.route('**/admin/api/conversations?before=*',route=>route.fulfill({json:{items:[{...latest,id:'88888888-8888-4888-8888-888888888888',title:'Older conversation'}],next_cursor:null}}));
  await page.locator('.conversation-sidebar').getByRole('button',{name:'加载更多对话',exact:true}).click();
  await expect(page.locator('.conversation-sidebar')).toContainText('Older conversation');
  await page.waitForTimeout(5300);await expect(page.locator('.conversation-sidebar')).toContainText('Older conversation');
  await expect(page.locator('.user').filter({hasText:'Earlier request'})).toHaveCount(1);
});

test('generated images appear in the assistant reply with preview and download while external Markdown stays a link',async({page})=>{
  await setup(page);
  const imageId='99999999-9999-4999-8999-999999999999',url=`/admin/api/conversations/${id}/images/${imageId}`;
  const buffer=await sharp({create:{width:320,height:180,channels:3,background:'#769d8b'}}).png().toBuffer();
  await page.route('**'+url,route=>route.fulfill({contentType:'image/png',body:buffer}));
  await emit(page,'patch',{conversation:{id},messages:[{...request,generated_images:[{id:imageId,name:'synthetic.png',mime:'image/png',width:320,height:180,size:buffer.length,url}],partial_text:'![External](https://example.com/external.png)'}],actions:[]});
  await expect(page.locator('.assistant .message-images img')).toBeVisible();await expect(page.locator('.user .message-images')).toHaveCount(0);
  await expect(page.locator('.assistant .message-images a[download]')).toHaveAttribute('href',url);
  await expect(page.locator('.assistant .message-markdown img')).toHaveCount(0);
  await expect(page.locator('.assistant .message-markdown')).toHaveAttribute('data-typing','false');
  await page.setViewportSize({width:390,height:844});await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
  await page.screenshot({path:'.tmp/chat-media-pagination/mobile.png',animations:'disabled'});
});

test('reduced motion presents streamed text without an animation queue',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await setup(page);
  const text='Reduced motion reply '.repeat(30);await emit(page,'patch',{conversation:{id},messages:[{...request,partial_text:text}],actions:[]});
  await expect(page.locator('.assistant .message-markdown')).toHaveText(text.trim());
  await expect(page.locator('.assistant .message-markdown')).toHaveAttribute('data-typing','false');
});

test('a reconnect more than one page ahead can load the middle gap before continuing older history',async({page})=>{
  await setup(page);await emit(page,'conversation',latest);
  const oldRoot='77777777-7777-4777-8777-777777777777';
  await page.route(`**/admin/api/conversations/${id}?before=*`,route=>route.fulfill({json:{...latest,messages:[{...request,id:oldRoot,text:'Earliest loaded request',created_at:stamp-1000,status:'completed'}],history:{has_more:false,before:oldRoot}}}));
  await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.locator('#messages')).toContainText('Earliest loaded request');
  const newestRoot='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await emit(page,'conversation',{...latest,messages:[{...request,id:newestRoot,text:'Newest window after long disconnect',created_at:stamp+1000}],history:{has_more:true,before:newestRoot}});
  const gap='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await page.route(`**/admin/api/conversations/${id}?before=${newestRoot}`,route=>route.fulfill({json:{...latest,messages:[{...request,id:gap,text:'Missing middle request',created_at:stamp+500,status:'completed'},{...request,status:'completed'}],history:{has_more:true,before:request.id}}}));
  await expect(page.getByRole('button',{name:'加载更早消息',exact:true})).toBeVisible();await page.getByRole('button',{name:'加载更早消息',exact:true}).click();
  await expect(page.locator('#messages')).toContainText('Missing middle request');
  await expect(page.locator('#messages')).toContainText('Earliest loaded request');
  await expect(page.getByRole('button',{name:'加载更早消息',exact:true})).toHaveCount(0);
});

test('reconnect revalidates an older active request omitted from the new window and keeps authoritative totals',async({page})=>{
  await setup(page);await emit(page,'conversation',{...latest,queued_count:35,running_count:1});
  await expect(page.locator('.conversation-sidebar .conversation-pending')).toHaveText('待处理 36');
  await page.route(`**/admin/api/conversations/${id}/messages?ids=*`,route=>route.fulfill({json:{messages:[{...request,status:'completed',partial_text:null},{id:'old-final',role:'assistant',reply_to:request.id,text:'Finished while offline',status:'completed',created_at:stamp+100}],actions:[]}}));
  await emit(page,'conversation',{...latest,messages:[{...request,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',text:'New active request'}],queued_count:34,running_count:1});
  await expect(page.locator('#messages')).toContainText('Finished while offline');
  await expect(page.locator('.conversation-sidebar .conversation-pending')).toHaveText('待处理 35');
  await expect(page.locator('.user').filter({hasText:'Synthetic request'})).toContainText('执行完成');
});

test('a delayed older page cannot hide a new middle gap created by reconnecting',async({page})=>{
  await setup(page);await emit(page,'conversation',latest);
  const earliest='dddddddd-dddd-4ddd-8ddd-dddddddddddd',newest='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',middle='ffffffff-ffff-4fff-8fff-ffffffffffff';
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  let requested=false;
  await page.route(`**/admin/api/conversations/${id}?before=${request.id}`,async route=>{
    requested=true;await held;
    await route.fulfill({json:{...latest,messages:[{...request,id:earliest,text:'Earliest delayed request',created_at:stamp-1000,status:'completed'}],history:{has_more:false,before:earliest}}});
  });
  await page.getByRole('button',{name:'加载更早消息',exact:true}).click();
  await expect.poll(()=>requested).toBe(true);
  await emit(page,'conversation',{...latest,messages:[{...request,id:newest,text:'Newest reconnect window',created_at:stamp+1000,status:'completed'}],history:{has_more:true,before:newest}});
  await expect(page.locator('#messages')).toContainText('Newest reconnect window');
  release();await expect(page.locator('#messages')).toContainText('Earliest delayed request');
  await page.route(`**/admin/api/conversations/${id}?before=${newest}`,route=>route.fulfill({json:{...latest,messages:[{...request,id:middle,text:'Middle request preserved after delayed page',created_at:stamp+500,status:'completed'},{...request,status:'completed'}],history:{has_more:true,before:request.id}}}));
  const earlier=page.getByRole('button',{name:'加载更早消息',exact:true});
  await expect(earlier).toBeVisible();await expect(earlier).toBeEnabled();await earlier.click();
  await expect(page.locator('#messages')).toContainText('Middle request preserved after delayed page');
  await expect(page.locator('#messages')).toContainText('Earliest delayed request');
  if(await earlier.count())await earlier.click();
  await expect(earlier).toHaveCount(0);
  await expect(page.locator('.user').filter({hasText:'Earliest delayed request'})).toHaveCount(1);
});

test('late omitted-history reconciliation cannot revert a newer action status',async({page})=>{
  await setup(page);
  const other={...request,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',text:'Another older active request'};
  await emit(page,'conversation',{...latest,messages:[request,other]});
  const action={id:'synthetic-action',message_id:request.id,name:'runtime_update',status:'executing'};
  let release,requested=false;
  const held=new Promise(resolve=>{release=resolve;});
  await page.route(`**/admin/api/conversations/${id}/messages?ids=*`,async route=>{
    requested=true;await held;
    await route.fulfill({json:{messages:[request,{...other,text:'Reconciliation response applied'}],actions:[action]}});
  });
  await emit(page,'conversation',{...latest,messages:[{...request,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',text:'New active request'}],actions:[]});
  await expect.poll(()=>requested).toBe(true);
  await emit(page,'patch',{conversation:{id},messages:[],actions:[{...action,status:'completed'}]});
  const activity=page.locator('.message-activity').filter({hasText:'runtime_update'});
  await activity.locator('summary').click();await expect(activity).toContainText('runtime_update · 执行完成');
  const response=page.waitForResponse(url=>url.url().includes('/messages?ids='));
  release();await response;
  await expect(page.locator('#messages')).toContainText('Reconciliation response applied');
  await expect(activity).toContainText('runtime_update · 执行完成');
});
