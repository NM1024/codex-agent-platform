import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
test.use({locale:'zh-CN',timezoneId:'Asia/Shanghai'});

const models=[
  {model:'gpt-6.1-sol',displayName:'Fixture Default',defaultReasoningEffort:'low',supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort}))},
  {model:'fixture-fast',displayName:'Fixture Fast',defaultReasoningEffort:'low',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort}))},
  {model:'fixture-fixed',displayName:'Fixture Fixed',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},
  {model:'fixture-unknown',displayName:'Fixture Unknown',supportedReasoningEfforts:[]},
];
async function setup(page,{execution={},catalog={models},globalEffort='medium',title='Synthetic model picker'}={}) {
  await page.route('**/admin/api/operations',route=>{
    const body=route.request().postDataJSON();
    if(body.action==='models')return route.fulfill({json:catalog});
    if(body.action==='configuration_get'&&body.args.scope==='manager')return route.fulfill({json:{scope:'manager',title:'Manager',description:'Synthetic picker defaults',schema:{},values:{model:'gpt-6.1-sol',reasoningEffort:globalEffort},configured_secrets:[],revision:1,updated_at:1}});
    return route.continue();
  });
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();
  const response=await page.request.post('/admin/api/conversations',{data:{title,execution}});expect(response.ok()).toBeTruthy();const conversation=await response.json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(conversation.title);
  return {id:conversation.id,saved:async()=>(await(await page.request.get('/admin/api/conversations/'+conversation.id)).json()).execution};
}
const panel=page=>page.locator('.chat-agent-panel:visible');
async function open(page){await page.locator('#chat-model').click();await expect(panel(page)).toBeInViewport({ratio:1});await panel(page).hover({position:{x:8,y:8}});}

test('stale browser model edits preserve concurrent settings and reload before another explicit edit',async({page})=>{
  const {id,saved}=await setup(page);await page.locator('#message-input').fill('Synthetic preserved conflict draft');
  let concurrent=false;
  await page.route('**/admin/api/conversations/'+id,async route=>{
    if(route.request().method()==='POST'&&!concurrent){
      concurrent=true;
      const response=await page.request.post('/admin/api/conversations/'+id,{data:{execution:{model:'fixture-fast'},expected_execution:{}}});expect(response.ok()).toBeTruthy();
    }
    await route.continue();
  });
  await open(page);await panel(page).getByRole('button',{name:'high',exact:true}).click();
  await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toBeVisible();
  expect(await saved()).toEqual({model:'fixture-fast'});
  await expect(page.locator('#chat-model')).toContainText('Fixture Fast');
  await expect(page.locator('#message-input')).toHaveValue('Synthetic preserved conflict draft');
  await page.screenshot({path:'.tmp/inspection-handoff/chat-model-conflict.png',animations:'disabled'});
  await panel(page).getByRole('button',{name:'high',exact:true}).click();
  await expect.poll(saved).toEqual({model:'fixture-fast',reasoningEffort:'high'});
  await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toHaveCount(0);
});

test('queued local model edits compare against the preceding successful save',async({page})=>{
  const {id,saved}=await setup(page),writes=[];let release,entered;
  const blocked=new Promise(resolve=>release=resolve),first=new Promise(resolve=>entered=resolve);
  await page.route('**/admin/api/conversations/'+id,async route=>{
    if(route.request().method()==='POST'){
      writes.push(route.request().postDataJSON());
      if(writes.length===1){entered();await blocked;}
    }
    await route.continue();
  });
  await open(page);await panel(page).getByRole('button',{name:'high',exact:true}).click();await first;
  await panel(page).getByRole('button',{name:'xhigh',exact:true}).click();release();
  await expect.poll(saved).toEqual({reasoningEffort:'xhigh'});
  expect(writes).toEqual([
    {execution:{reasoningEffort:'high'},expected_execution:{}},
    {execution:{reasoningEffort:'xhigh'},expected_execution:{reasoningEffort:'high'}},
  ]);
});

test('reopening chat cannot rebase queued model edits onto an external change',async({page})=>{
  const {id,saved}=await setup(page),writes=[],statuses=[];let release,entered;
  const blocked=new Promise(resolve=>release=resolve),first=new Promise(resolve=>entered=resolve);
  page.on('response',response=>{if(response.url().endsWith('/admin/api/conversations/'+id)&&response.request().method()==='POST')statuses.push(response.status());});
  await page.route('**/admin/api/conversations/'+id,async route=>{
    if(route.request().method()==='POST'){writes.push(route.request().postDataJSON());if(writes.length===1){entered();await blocked;}}
    await route.continue();
  });
  try{
    await open(page);await panel(page).getByRole('button',{name:'high',exact:true}).click();await first;
    await panel(page).getByRole('button',{name:'xhigh',exact:true}).click();
    await navigate(page,'overview');
    const external=await page.request.post('/admin/api/conversations/'+id,{data:{execution:{model:'fixture-fast'},expected_execution:{}}});expect(external.ok()).toBeTruthy();
    await navigate(page,'chat');await expect(page.locator('#chat-model')).toContainText('Fixture Fast');release();
    await expect.poll(()=>statuses).toEqual([409,409]);
    expect(writes.map(write=>write.expected_execution)).toEqual([{},{}]);
    expect(await saved()).toEqual({model:'fixture-fast'});
  }finally{release();}
});

test('a send preparing attachments cannot rebase a failed model save after remount',async({page})=>{
  const {id,saved}=await setup(page),writes=[],statuses=[];let release,entered;
  const blocked=new Promise(resolve=>release=resolve),uploading=new Promise(resolve=>entered=resolve);
  page.on('response',response=>{if(response.url().endsWith('/admin/api/conversations/'+id)&&response.request().method()==='POST')statuses.push(response.status());});
  await page.route('**/admin/api/conversations/'+id,async route=>{
    if(route.request().method()==='POST'){
      writes.push(route.request().postDataJSON());
      if(writes.length===1)return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_UNAVAILABLE',message:'Synthetic unavailable'}}});
    }
    await route.continue();
  });
  await page.route('**/admin/api/conversations/'+id+'/files',async route=>{entered();await blocked;await route.fulfill({json:{file_id:'synthetic-upload',name:'synthetic.csv',mime:'text/csv',size:4}});});
  try{
    await open(page);await panel(page).getByRole('button',{name:'high',exact:true}).click();
    await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toBeVisible();await page.keyboard.press('Escape');
    await page.locator('#chat-attachment-input').setInputFiles({name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from('a,b\n')});
    await expect(page.locator('.sandbox-draft-file')).toHaveCount(1);
    await page.locator('#message-input').fill('Synthetic delayed attachment send');await page.getByRole('button',{name:'发送',exact:true}).click();await uploading;
    await navigate(page,'overview');
    const external=await page.request.post('/admin/api/conversations/'+id,{data:{execution:{model:'fixture-fast'},expected_execution:{}}});expect(external.ok()).toBeTruthy();
    await navigate(page,'chat');await expect(page.locator('#chat-model')).toContainText('Fixture Fast');release();
    await expect.poll(()=>statuses).toEqual([503,409]);
    expect(writes.map(write=>write.expected_execution)).toEqual([{},{}]);expect(await saved()).toEqual({model:'fixture-fast'});
  }finally{release();}
});

test('conversation title and connection state share the top bar on desktop and phone',async({page})=>{
  await setup(page);
  for(const [width,height] of [[1440,1000],[320,760]]){
    await page.setViewportSize({width,height});
    const header=page.locator('.console-header .chat-header');
    await expect(header).toContainText('Synthetic model picker');
    await expect(page.locator('.chat-main > .chat-header')).toHaveCount(0);
    await expect(header.locator('.chat-stream-status')).toBeVisible();
    const box=await header.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
    if(width===320){const drawer=page.getByRole('dialog').filter({hasText:'会话列表'});await header.getByRole('button',{name:'会话列表',exact:true}).click();await expect(drawer).toBeVisible();await page.keyboard.press('Escape');await expect(drawer).toBeHidden();}
    await page.screenshot({path:`.tmp/inspection-handoff/chat-topbar-${width}.png`});
  }
});

test('one compact entry opens model and stepped reasoning controls and keyboard changes save once',async({page})=>{
  const {saved}=await setup(page);await page.locator('#message-input').fill('Preserved composer draft');
  await page.screenshot({path:'.tmp/model-picker/before-or-current-desktop.png'});
  await expect(page.locator('.composer-toolbar .ant-select')).toHaveCount(0);
  await expect(page.locator('#chat-model')).toHaveText('Fixture Default - medium');await open(page);
  await expect(panel(page).locator('.chat-effort-heading > svg')).toHaveCount(0);
  const slider=panel(page).getByRole('slider',{name:'思考程度',exact:true});
  await expect(slider).toHaveAttribute('min','0');await expect(slider).toHaveAttribute('max','3');await expect(slider).toHaveAttribute('aria-valuetext','medium');
  expect(await saved()).toEqual({});
  await slider.focus();await page.keyboard.press('ArrowRight');await expect(slider).toHaveAttribute('aria-valuetext','high');
  await expect.poll(saved).toEqual({reasoningEffort:'high'});await expect(page.locator('#chat-model')).toHaveText('Fixture Default - high');
  await page.keyboard.press('End');await expect.poll(saved).toEqual({reasoningEffort:'xhigh'});
  await page.keyboard.press('Escape');await expect(panel(page)).toHaveCount(0);await expect(page.locator('#chat-model')).toBeFocused();
  await expect(page.locator('#message-input')).toHaveValue('Preserved composer draft');
  await expect(page.locator('#chat-model')).toHaveAttribute('title',/xhigh/);
});

test('drag previews the level locally and persists only the released step',async({page})=>{
  const {id,saved}=await setup(page),writes=[];
  await page.route('**/admin/api/conversations/'+id,route=>{if(route.request().method()==='POST')writes.push(route.request().postDataJSON().execution);return route.continue();});
  await open(page);const slider=panel(page).getByRole('slider',{name:'思考程度',exact:true}),box=await slider.boundingBox();
  const x=box.x+10+(box.width-20)/3,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(box.x+box.width-11,y,{steps:5});
  await expect(slider).toHaveAttribute('aria-valuetext','xhigh');expect(writes).toHaveLength(0);expect(await saved()).toEqual({});
  await page.mouse.up();await expect.poll(saved).toEqual({reasoningEffort:'xhigh'});await page.keyboard.press('Tab');expect(writes).toHaveLength(1);
});

test('model changes reset the previous effort and use only the new model supported steps',async({page})=>{
  const {saved}=await setup(page,{execution:{reasoningEffort:'xhigh'}});await open(page);
  await panel(page).getByRole('radio',{name:'Fixture Fast',exact:true}).click();
  await expect.poll(saved).toEqual({model:'fixture-fast'});
  const slider=panel(page).getByRole('slider',{name:'思考程度',exact:true});await expect(slider).toHaveAttribute('max','1');await expect(slider).toHaveAttribute('aria-valuetext','low');
  await panel(page).getByRole('button',{name:'high',exact:true}).click();await expect.poll(saved).toEqual({model:'fixture-fast',reasoningEffort:'high'});
  await panel(page).getByRole('radio',{name:'Fixture Fixed',exact:true}).click();await expect.poll(saved).toEqual({model:'fixture-fixed'});
  await expect(panel(page).getByRole('slider')).toHaveCount(0);await expect(panel(page)).toContainText('仅支持此档位');
});

test('reset preserves inherited values and legacy model defaults stay readable',async({page})=>{
  const {saved}=await setup(page,{execution:{reasoningEffort:null}});await open(page);
  const slider=panel(page).getByRole('slider');await expect(slider).toHaveAttribute('aria-valuetext','low');await expect(page.locator('#chat-model')).toHaveText('Fixture Default - low');expect(await saved()).toEqual({reasoningEffort:null});
  await panel(page).getByRole('button',{name:'恢复默认思考程度',exact:true}).click();
  await expect.poll(saved).toEqual({});await expect(slider).toHaveAttribute('aria-valuetext','medium');await expect(panel(page)).toContainText('继承全局设置');
  await expect(panel(page).getByRole('button',{name:'使用模型默认',exact:true})).toHaveCount(0);
});

test('saved unsupported models and efforts stay readable when the catalog is unavailable',async({page})=>{
  const {saved}=await setup(page,{execution:{model:'retired-fixture',reasoningEffort:'xhigh'},catalog:{models:[],unavailable:true}});
  await expect(page.locator('#chat-model')).toContainText('retired-fixture');await open(page);
  await expect(panel(page)).toContainText('xhigh');await expect(panel(page)).toContainText('暂时无法获取思考档位');await expect(panel(page).getByRole('slider')).toHaveCount(0);
  expect(await saved()).toEqual({model:'retired-fixture',reasoningEffort:'xhigh'});
});

test('an unsupported saved effort is retained until an explicit supported level is chosen',async({page})=>{
  const {saved}=await setup(page,{execution:{model:'fixture-fast',reasoningEffort:'xhigh'}});await open(page);
  await expect(panel(page)).toContainText('当前保存值');await expect(panel(page).getByRole('slider')).toHaveCount(0);expect(await saved()).toEqual({model:'fixture-fast',reasoningEffort:'xhigh'});
  await panel(page).getByRole('button',{name:'high',exact:true}).click();await expect.poll(saved).toEqual({model:'fixture-fast',reasoningEffort:'high'});await expect(panel(page).getByRole('slider')).toBeVisible();
});

test('long catalogs can be searched and failed writes retain the choice with an actionable retry',async({page})=>{
  const extras=Array.from({length:10},(_,index)=>({...models[0],model:'extra-'+index,displayName:'长模型名称用于验证显示和选择 '+index}));
  const {id,saved}=await setup(page,{catalog:{models:[...models,...extras]}});let failing=true;
  await page.route('**/admin/api/conversations/'+id,route=>route.request().method()==='POST'&&failing?route.fulfill({status:503,json:{error:{message:'Synthetic save failure'}}}):route.continue());
  await open(page);await panel(page).getByRole('searchbox',{name:'搜索模型',exact:true}).fill('选择 8');
  await panel(page).getByRole('radio',{name:extras[8].displayName,exact:true}).click();
  await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toBeVisible();await expect(page.locator('#chat-model')).toHaveText(extras[8].displayName+' - low');expect(await saved()).toEqual({});
  await page.locator('.ant-message').getByRole('button',{name:'关闭提示',exact:true}).click();await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
  await page.locator('#message-input').fill('Synthetic draft stays when pre-send settings fail');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toBeVisible();
  await expect(page.locator('#notice')).toHaveCount(0);await expect(page.locator('#message-input')).toHaveValue('Synthetic draft stays when pre-send settings fail');
  expect((await(await page.request.get('/admin/api/conversations/'+id)).json()).messages.filter(item=>item.role==='user')).toHaveLength(0);
  failing=false;await page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true}).click();await expect.poll(saved).toEqual({model:'extra-8'});
  await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toHaveCount(0);
});

test('model save failure notifications remain owned by their conversation across navigation',async({page})=>{
  const {id,saved}=await setup(page,{title:'Synthetic toast ownership'});let failing=true;
  await page.route('**/admin/api/conversations/'+id,route=>route.request().method()==='POST'&&failing?route.fulfill({status:503,json:{error:{message:'Synthetic owned save failure'}}}):route.continue());
  await open(page);await panel(page).getByRole('radio',{name:'Fixture Fast',exact:true}).click();
  const retry=page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true});await expect(retry).toBeVisible();
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'＋ 新对话',exact:true}).click();
  await expect(page.locator('.chat-header')).toContainText('新对话');await expect(retry).toHaveCount(0);expect(await saved()).toEqual({});
  await page.locator('.conversation-sidebar').getByRole('button',{name:'Synthetic toast ownership',exact:true}).click();await expect(retry).toBeVisible();
  failing=false;await retry.click();await expect.poll(saved).toEqual({model:'fixture-fast'});await expect(retry).toHaveCount(0);
});

test('a long model group uses one tab stop and supports horizontal arrow navigation',async({page})=>{
  const extras=Array.from({length:9},(_,index)=>({...models[0],model:'keyboard-'+index,displayName:'Keyboard model '+index}));
  await setup(page,{catalog:{models:[...models,...extras]}});await open(page);
  const group=panel(page).getByRole('radiogroup',{name:'模型',exact:true}),slider=panel(page).getByRole('slider');
  await group.getByRole('radio',{name:'继承全局设置',exact:true}).focus();await page.keyboard.press('Tab');await expect(slider).toBeFocused();
  await group.getByRole('radio',{name:'继承全局设置',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio',{name:'Fixture Default',exact:true})).toBeFocused();await expect(group.getByRole('radio',{name:'Fixture Default',exact:true})).toHaveAttribute('aria-checked','true');
  await page.keyboard.press('ArrowLeft');await expect(group.getByRole('radio',{name:'继承全局设置',exact:true})).toBeFocused();
});

test('actual desktop and phone panels stay within view and keep labels and composer actions clear',async({page})=>{
  test.setTimeout(45000);
  await setup(page);await page.locator('#message-input').fill('Show the local synthetic report');await page.locator('.composer-send').click();await expect(page.locator('.assistant .code-block')).toBeVisible();await page.locator('#message-input').fill('Unsent layout draft');
  for(const locale of ['zh-CN','en']) {
    if(locale==='en'){await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();}
    for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568},{width:844,height:390},{width:1440,height:390}]) {
      await page.setViewportSize(viewport);await expect(page.locator('#chat-model')).toBeVisible();await open(page);
      const box=await panel(page).boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
      await expect(panel(page).getByRole('slider')).toBeVisible();
      await expect(panel(page).getByRole('button',{name:locale==='en'?'Reset reasoning to default':'恢复默认思考程度',exact:true})).toBeInViewport({ratio:1});
      await page.screenshot({path:`.tmp/model-picker/${locale}-${viewport.width}x${viewport.height}.png`,animations:'disabled'});
      await page.keyboard.press('Escape');await expect(panel(page)).toHaveCount(0);await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
      await expect(page.locator('#message-input')).toHaveValue('Unsent layout draft');
      await expect(page.locator('.chat-agent-trigger-effort')).toHaveText(' - medium');
      await expect(page.locator('.chat-agent-trigger-effort')).toBeInViewport({ratio:1});
      await page.screenshot({path:`.tmp/model-picker/${locale}-${viewport.width}x${viewport.height}-closed.png`,animations:'disabled'});
    }
  }
});

test('the open phone sheet follows a short visual viewport and retains the message draft',async({page})=>{
  await page.addInitScript(()=>{const viewport=new EventTarget();Object.assign(viewport,{height:844,width:390,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:viewport});window.resizePickerViewport=(height,offsetTop)=>{Object.assign(viewport,{height,offsetTop});viewport.dispatchEvent(new Event('resize'));};});
  await page.setViewportSize({width:390,height:844});await setup(page);await page.locator('#message-input').fill('Short keyboard draft');await open(page);
  await page.evaluate(()=>window.resizePickerViewport(240,45));
  await expect.poll(async()=>{const b=await page.getByRole('dialog').boundingBox();return Math.ceil(b.y+b.height);}).toBeLessThanOrEqual(285);
  await expect(page.getByRole('button',{name:'关闭模型设置',exact:true})).toBeInViewport({ratio:1});
  await panel(page).getByRole('slider').scrollIntoViewIfNeeded();await expect(panel(page).getByRole('slider')).toBeInViewport({ratio:.99});
  await page.keyboard.press('Escape');await expect(page.locator('#message-input')).toHaveValue('Short keyboard draft');
});

test('save feedback moving the composer keeps a short desktop popover inside the viewport',async({page})=>{
  await page.setViewportSize({width:1440,height:390});const {id}=await setup(page);
  await page.route('**/admin/api/conversations/'+id,route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:{message:'Synthetic short-window failure'}}}):route.continue());
  await open(page);await panel(page).getByRole('radio',{name:'Fixture Fast',exact:true}).click();await expect(page.locator('.ant-message').getByRole('button',{name:'重试保存',exact:true})).toBeVisible();
  const box=await panel(page).boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(390);
});

test.describe('phone touch slider',()=>{
  test.use({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  test('touch dragging commits the final supported step once',async({page,context})=>{
    const {id,saved}=await setup(page),writes=[];await page.route('**/admin/api/conversations/'+id,route=>{if(route.request().method()==='POST')writes.push(route.request().postDataJSON().execution);return route.continue();});
    await open(page);const box=await panel(page).getByRole('slider').boundingBox(),client=await context.newCDPSession(page),y=box.y+box.height/2;
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+12+(box.width-24)/3,y}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width-13,y}]});
    await expect(panel(page).getByRole('slider')).toHaveAttribute('aria-valuetext','xhigh');expect(writes).toHaveLength(0);
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect.poll(saved).toEqual({reasoningEffort:'xhigh'});expect(writes).toHaveLength(1);
  });
});
