import { test, expect } from "@playwright/test";
const navigate = (page, view) => page.locator(`[data-view="${view}"]`).click();
const settingsTab=(page,scope)=>page.locator(`[data-settings-tab="${scope}"]`).click();
const choiceLabel=value=>({'fixture-fast':'Fixture Fast','gpt-6.1-sol':'Fixture Default',en:'English','zh-CN':'简体中文',task:'Business task'}[value]??value);
const selectRoot=(page,selector)=>page.locator('.ant-select').filter({has:page.locator(selector)});
async function choose(page,selector,value){
  await page.locator(selector).click();
  await page.locator('.ant-select-dropdown:visible').getByText(choiceLabel(value),{exact:true}).last().click();
}
async function expectChoice(page,selector,value){await expect(selectRoot(page,selector)).toContainText(choiceLabel(value));}
async function operation(page, action, args = {}) {
  const response = await page.request.post("/admin/api/operations", {
    data: { action, args },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/admin/");
  await page.locator("#password").fill("local-browser-password");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
});

test('settings show one category at a time and keep drafts across tabs',async({page})=>{
  await navigate(page,'settings');await settingsTab(page,'manager');
  await page.locator('#setting-manager-timeoutMs').fill('7654321');
  await expect(page.locator('#configuration-execution')).toBeHidden();
  await settingsTab(page,'execution');await page.locator('#setting-execution-concurrency').fill('3');
  await expect(page.locator('#configuration-manager')).toBeHidden();
  await settingsTab(page,'manager');await expect(page.locator('#setting-manager-timeoutMs')).toHaveValue('7654321');
  await choose(page,'#app-language','en');await expect(page.locator('#setting-manager-timeoutMs')).toHaveValue('7654321');
  await settingsTab(page,'security');await expect(page.locator('#current-admin-password')).toBeVisible();
  await expect(page.locator('#configuration-manager')).toBeHidden();
});

test('password update rejects an incorrect current password without signing out',async({page})=>{
  await navigate(page,'settings');await settingsTab(page,'security');
  await page.locator('#current-admin-password').fill('wrong-synthetic-password');
  await page.locator('#new-admin-password').fill('unused-synthetic-password');
  await page.locator('#confirm-admin-password').fill('unused-synthetic-password');
  await page.getByRole('button',{name:'修改 Admin 密码',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('当前密码不正确。');
  await expect(page.locator('#workspace')).toBeVisible();
  expect((await page.request.get('/admin/api/session')).status()).toBe(200);
});

test('chat uses separate bubbles and keeps its composer inside the viewport',async({page})=>{
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic layout conversation'}})).json();
  for(let i=0;i<9;i++)await page.request.post('/admin/api/conversations/'+created.id+'/messages',{data:{text:'Synthetic layout message '+i}});
  await navigate(page,'chat');await expect(page.locator('#messages .message.assistant').last()).toBeVisible();
  for(const width of [1440,2560,390,768]){
    await page.setViewportSize({width,height:900});
    await expect(page.locator('.chat-compose')).toBeInViewport({ratio:1});
    const transcript=await page.locator('#messages').boundingBox(),composer=await page.locator('.chat-compose').boundingBox();
    expect(transcript.height).toBeGreaterThan(230);expect(composer.y).toBeGreaterThanOrEqual(transcript.y+transcript.height-2);expect(composer.y+composer.height).toBeLessThanOrEqual(900);
    const alignment=await page.evaluate(()=>{const user=document.querySelector('.message.user .message-bubble').getBoundingClientRect(),assistant=document.querySelector('.message.assistant .message-bubble').getBoundingClientRect();return {user:user.right,assistant:assistant.left};});
    expect(alignment.user).toBeGreaterThan(alignment.assistant+150);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThanOrEqual(901);
  }
  await page.locator('#messages').evaluate(element=>{element.scrollTop=0;});
  await expect.poll(()=>page.locator('#messages').evaluate(element=>element.scrollTop)).toBeLessThan(5);
  await page.waitForResponse(response=>response.url().endsWith('/conversations/'+created.id)&&response.request().method()==='GET');
  expect(await page.locator('#messages').evaluate(element=>element.scrollTop)).toBeLessThan(5);
});

test('chat Enter sends once, Shift Enter adds a line and IME Enter does not submit',async({page})=>{
  await navigate(page,'chat');
  const input=page.locator('#message-input'),sent=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/messages'))sent.push(request.postDataJSON().text);});
  await input.fill('输入法候选');await input.dispatchEvent('compositionstart');await input.press('Enter');
  expect(sent).toEqual([]);await input.dispatchEvent('compositionend');
  await input.fill('first line');await input.press('Shift+Enter');await input.pressSequentially('second line');
  await expect(input).toHaveValue('first line\nsecond line');expect(sent).toEqual([]);
  await input.press('Enter');await expect.poll(()=>sent).toEqual(['first line\nsecond line']);
  await expect(input).toHaveValue('');
  await expect(page.locator('#messages .message.user').last()).toContainText('second line');
});

test('chat failed model saves retain the choice and offer a working retry',async({page})=>{
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic autosave retry'}})).json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);
  let failing=true;
  await page.route('**/admin/api/conversations/'+created.id,async route=>{
    if(route.request().method()==='POST'&&failing)await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_SAVE_FAILURE',message:'Synthetic save failure'}}});else await route.continue();
  });
  await choose(page,'#chat-model','fixture-fast');await expect(page.getByRole('button',{name:'保存失败，重试',exact:true})).toBeVisible();
  await expectChoice(page,'#chat-model','fixture-fast');failing=false;
  await page.getByRole('button',{name:'保存失败，重试',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存失败，重试',exact:true})).toHaveCount(0);
  await expect.poll(async()=> (await (await page.request.get('/admin/api/conversations/'+created.id)).json()).execution.model).toBe('fixture-fast');
});

test('phone conversation drawer switches chats while the composer stays reachable',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Phone drawer conversation'}})).json();
  await navigate(page,'chat');await page.getByRole('button',{name:'会话列表',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:created.title,exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();await expect(page.locator('.chat-header')).toContainText(created.title);
  await expect(page.locator('.chat-compose')).toBeInViewport({ratio:1});
});

test('inherited model option names the global default rather than the override',async({page})=>{
  await operation(page,'configuration_update',{scope:'manager',patch:{model:'gpt-6.1-sol'}});
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic default label',execution:{model:'fixture-fast'}}})).json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);
  await page.locator('#chat-model').click();
  await page.locator('.ant-select-dropdown:visible').getByText('默认：Fixture Default',{exact:true}).click();
  await expect.poll(async()=> (await (await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual({});
});

test('expanded long activity stays scrollable without hiding the phone send button',async({page})=>{
  await page.setViewportSize({width:390,height:667});
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic long activity'}})).json();
  await page.route('**/admin/api/conversations/'+created.id,async route=>{
    if(route.request().method()!=='GET')return route.continue();
    await route.fulfill({json:{...created,actions:Array.from({length:8},(_,index)=>({id:String(index),name:'configuration_get',status:'failed',error:{code:'SYNTHETIC',message:'Synthetic long error '.repeat(15)}}))}});
  });
  await navigate(page,'chat');await page.getByRole('button',{name:'执行记录 (8)',exact:true}).click();
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeInViewport({ratio:1});
  const panel=page.locator('#actions .ant-collapse-body');
  await expect.poll(()=>panel.evaluate(element=>element.clientHeight)).toBeLessThanOrEqual(122);
  expect(await panel.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
});

test('landscape phone keeps send visible with six input lines and expanded activity',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic landscape'}})).json();
  await page.route('**/admin/api/conversations/'+created.id,async route=>{
    if(route.request().method()!=='GET')return route.continue();
    await route.fulfill({json:{...created,actions:Array.from({length:8},(_,index)=>({id:String(index),name:'configuration_get',status:'completed'}))}});
  });
  await navigate(page,'chat');await page.locator('#message-input').fill('line1\nline2\nline3\nline4\nline5\nline6');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeInViewport({ratio:1});
  await page.getByRole('button',{name:'执行记录 (8)',exact:true}).click();
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeInViewport({ratio:1});
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('#message-input')).toHaveValue('');
});

test('short English phone layouts keep header controls and send inside the viewport',async({page})=>{
  await choose(page,'#app-language','en');await navigate(page,'chat');
  for(const viewport of [{width:390,height:568},{width:320,height:568},{width:844,height:390}]){
    await page.setViewportSize(viewport);await page.locator('#message-input').fill('one\ntwo\nthree\nfour\nfive\nsix');
    for(const locator of [page.locator('#app-language'),page.locator('#refresh'),page.locator('#logout')]){
      await expect(locator).toBeInViewport({ratio:1});
      const header=await page.locator('.console-header').boundingBox(),box=await locator.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(header.y);expect(box.y+box.height).toBeLessThanOrEqual(header.y+header.height);
    }
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeInViewport({ratio:1});
  }
});

test('phone task and overview actions fit without horizontal table scrolling',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  for(const language of ['zh-CN','en']){
    await choose(page,'#app-language',language);
    for(const view of ['tasks','overview']){
      await navigate(page,view);await expect(page.locator('#view tbody tr[data-row-key]').first()).toBeVisible();
      const table=page.locator('#view .ant-table-content').first();
      expect(await table.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
      for(const button of await page.locator('#view tbody tr[data-row-key]').first().getByRole('button').all()){
        const box=await button.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);
      }
    }
  }
});

test('model autosaves remain ordered when leaving and reopening chat',async({page})=>{
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic navigation ordering'}})).json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),held=new Promise(resolve=>{started=resolve;});let first=true;
  await page.route('**/admin/api/conversations/'+created.id,async route=>{
    if(first&&route.request().method()==='POST'){first=false;started();await gate;}
    await route.continue();
  });
  try {
    await choose(page,'#chat-model','fixture-fast');await held;
    await navigate(page,'overview');await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);
    await choose(page,'#chat-reasoningEffort','high');
    // Give the later selection a network round trip while the older save is held.
    await page.request.get('/admin/api/session');
    release();
    await expect.poll(async()=> (await (await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual({reasoningEffort:'high'});
    await expectChoice(page,'#chat-reasoningEffort','high');
  }finally{release();}
});

test('cold login defers other pages and serves compressed scripts',async({browser})=>{
  const context=await browser.newContext();const page=await context.newPage();
  try {
    const scripts=[];page.on('response',response=>{if(/\/admin\/assets\/.*\.js$/.test(response.url()))scripts.push(response);});
    await page.goto('/admin/');await expect(page.locator('#password')).toBeVisible();
    expect(scripts.some(response=>/Page-/.test(response.url()))).toBe(false);
    expect(scripts.reduce((total,response)=>total+Number(response.headers()['content-length']),0)).toBeLessThan(260_000);
    await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.locator('#view .ant-card').first()).toBeVisible();
    expect(scripts.some(response=>/OverviewPage-/.test(response.url()))).toBe(true);
    expect(scripts.some(response=>/(Chat|Settings|Tasks|Plugins|Schedules)Page-/.test(response.url()))).toBe(false);
    const initialBytes=scripts.reduce((total,response)=>total+Number(response.headers()['content-length']),0);
    expect(initialBytes).toBeLessThan(350_000);
    expect(scripts.every(response=>['gzip','br'].includes(response.headers()['content-encoding']))).toBe(true);
    await navigate(page,'chat');await expect(page.locator('#message-input')).toBeVisible();
    expect(scripts.some(response=>/ChatPage-/.test(response.url()))).toBe(true);
  }finally{await context.close();}
});

test('failed page chunks show a recoverable error instead of a blank console',async({page})=>{
  await page.route('**/SettingsPage-*.js',route=>route.abort());
  await navigate(page,'settings');
  await expect(page.locator('#view [role="alert"]')).toContainText('页面加载失败，请刷新后重试。');
  await expect(page.locator('#workspace')).toBeVisible();
  await navigate(page,'plugins');await expect(page.getByText('业务插件配置',{exact:true})).toBeVisible();
  await page.unroute('**/SettingsPage-*.js');await page.reload();
  await navigate(page,'settings');await expect(page.locator('#configuration-manager')).toBeVisible();
});

test('production React console loads local Ant Design assets without CSP errors',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to apply/i.test(message.text()))errors.push(message.text());});
  await page.reload();await expect(page.locator('#workspace .ant-layout-header')).toBeVisible();
  await expect(page.locator('.ant-card').first()).toBeVisible();
  const scripts=await page.locator('script[src]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('src')));
  expect(scripts.every(src=>src.startsWith('/admin/assets/'))).toBe(true);
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
  await page.screenshot({path:'.tmp/react-admin/screenshots/overview-desktop.png',fullPage:true,animations:'disabled'});
  await navigate(page,'settings');await expect(page.locator('#configuration-manager')).toBeVisible();
  await page.screenshot({path:'.tmp/react-admin/screenshots/settings-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await navigate(page,'plugins');await expect(page.getByText('可在此启用或停用。新增、编辑和试运行请通过管理 Agent 操作。',{exact:true})).toBeVisible();
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
  await page.screenshot({path:'.tmp/react-admin/screenshots/plugins-mobile.png',fullPage:true,animations:'disabled'});
  expect(errors,JSON.stringify(await page.locator('style').evaluateAll(nodes=>nodes.filter(node=>!node.nonce).map(node=>node.textContent?.slice(0,500))))).toEqual([]);
});

const pluginDefinition={type:'browser.summary',name:'用户自己的中文业务',instructions:'业务提示词原样保留',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'},execution:{model:'fixture-fast',reasoningEffort:'low'}};
test('business plugin configuration is read-only and displays persisted model settings',async({page})=>{
  await operation(page,'plugin_save',{definition:pluginDefinition});
  const writes=[];page.on('request',r=>{if(r.method()==='POST')writes.push(r.postDataJSON()?.action);});
  await navigate(page,'plugins');
  const row=page.getByRole('row').filter({hasText:pluginDefinition.name});
  await row.getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(page.locator('#plugin-detail')).toContainText('fixture-fast');
  await expect(page.locator('#plugin-detail')).toContainText('low');
  await expect(page.locator('#plugin-detail')).toContainText(pluginDefinition.instructions);
  await expect(page.locator('#view input, #view textarea, #view .ant-select')).toHaveCount(0);
  for(const name of ['新建插件','编辑','启用','停用','校验并保存','提交试运行'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  expect(writes.every(action=>['configuration_get','models'].includes(action))).toBe(true);
});

test('management conversations save independent model settings and defaults are selectable',async({page})=>{
  const created=await (await page.request.post('/admin/api/conversations',{data:{title:'Synthetic model selection'}})).json();
  await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText('Synthetic model selection');
  await choose(page,'#chat-model','fixture-fast');
  await choose(page,'#chat-reasoningEffort','low');
  await expect.poll(async()=> (await (await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual({model:'fixture-fast',reasoningEffort:'low'});
  await expect(page.getByRole('button',{name:'保存对话配置',exact:true})).toHaveCount(0);
  await navigate(page,'settings');
  await expect(page.locator('#setting-manager-model')).toHaveAttribute('role','combobox');
  await settingsTab(page,'execution');
  await expect(page.locator('#setting-execution-reasoningEffort')).toHaveAttribute('role','combobox');
});

test('plugin guidance opens the management conversation',async({page})=>{
  await navigate(page,'plugins');
  await page.getByRole('button',{name:'前往管理对话',exact:true}).click();
  await expect(page.locator('#message-input')).toBeVisible();
});

test('manager model and effort drafts survive language switching and saving another group',async({page})=>{
  await navigate(page,'settings');
  await choose(page,'#setting-manager-model','gpt-6.1-sol');
  await choose(page,'#setting-manager-reasoningEffort','high');
  await choose(page,'#app-language','en');
  await expectChoice(page,'#setting-manager-reasoningEffort','high');
  await settingsTab(page,'execution');
  await page.locator('#setting-execution-concurrency').fill('2');
  await page.locator('#configuration-execution').getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await settingsTab(page,'manager');
  await expectChoice(page,'#setting-manager-model','gpt-6.1-sol');
  await expectChoice(page,'#setting-manager-reasoningEffort','high');
});

test('unavailable model catalog preserves saved settings and other fields can still be saved',async({page})=>{
  await operation(page,'configuration_update',{scope:'manager',patch:{model:'saved-unlisted-model',reasoningEffort:'high'}});
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON()?.action==='models')await route.fulfill({status:503,json:{error:{code:'MODEL_CATALOG_UNAVAILABLE'}}});
    else await route.continue();
  });
  await navigate(page,'settings');
  await expectChoice(page,'#setting-manager-model','saved-unlisted-model');
  await expectChoice(page,'#setting-manager-reasoningEffort','high');
  await choose(page,'#app-language','en');
  await expectChoice(page,'#setting-manager-model','saved-unlisted-model');
  await expectChoice(page,'#setting-manager-reasoningEffort','high');
  await page.locator('#setting-manager-inspectionIntervalMs').fill('17000');
  await page.locator('#configuration-manager').getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  const config=await operation(page,'configuration_get',{scope:'manager'});
  expect(config.values.model).toBe('saved-unlisted-model');
  expect(config.values.reasoningEffort).toBe('high');
});
test('business plugin details refresh after an Agent operation',async({page})=>{
  await operation(page,'plugin_save',{definition:pluginDefinition});
  await navigate(page,'plugins');
  await page.getByRole('row').filter({hasText:pluginDefinition.name}).getByRole('button',{name:'查看详情',exact:true}).click();
  await operation(page,'plugin_save',{definition:{...pluginDefinition,instructions:'管理 Agent 更新后的说明'}});
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.locator('#plugin-detail')).toContainText('管理 Agent 更新后的说明');
});
test('schedules are read-only and inspection details preserve disabled state',async({page})=>{
  const mutations=[];page.on('request',request=>{if(request.method()==='POST'&&/^schedule_(save|enable)$/.test(request.postDataJSON()?.action))mutations.push(request.postDataJSON());});
  await navigate(page,'schedules');
  await expect(page.getByText('可在此启用或停用。新增和编辑定时任务，请通过管理 Agent 操作。',{exact:true})).toBeVisible();
  const row=page.getByRole('row').filter({hasText:'每日运行巡检'});
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked','false');
  await row.getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(page.locator('#schedule-detail')).toContainText('检查队列和失败记录');
  await expect(page.locator('#schedule-detail')).toContainText('Asia/Shanghai');
  await expect(page.locator('#view input, #view textarea, #view .ant-select')).toHaveCount(0);
  for(const name of ['编辑','启用','停用','保存计划','新建计划'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("saving one settings group retains unsaved changes in other groups", async ({
  page,
}) => {
  await navigate(page, "settings");
  await settingsTab(page,'execution');
  await choose(page,"#setting-execution-model","fixture-fast");
  await settingsTab(page,'manager');
  await page
    .locator("#setting-manager-timeoutMs")
    .fill("1234567");
  await settingsTab(page,'execution');
  await page
    .locator("#configuration-execution")
    .getByRole("button", { name: "保存配置" })
    .click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await settingsTab(page,'manager');
  await expect(page.locator("#setting-manager-timeoutMs")).toHaveValue(
    "1234567",
  );
  await page
    .locator("#configuration-manager")
    .getByRole("button", { name: "保存配置" })
    .click();
  await expect
    .poll(
      async () =>
        (await operation(page, "configuration_get", { scope: "manager" }))
          .values.timeoutMs,
    )
    .toBe(1234567);
});
test("all six navigation choices fit on a phone without horizontal page scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-navigation')).toBeVisible();
  for (const name of [
    "overview",
    "chat",
    "tasks",
    "plugins",
    "schedules",
    "settings",
  ]) {
    const button = page.locator(`[data-view="${name}"]`),
      box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(40);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("task search works with Enter and exposes the caller request identifier", async ({
  page,
}) => {
  await navigate(page, "tasks");
  const input = page.getByRole("textbox", { name: "搜索任务" });
  await input.fill("article-review-2026-002");
  await input.press("Enter");
  await expect(page.locator("tbody tr[data-row-key]")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("article-review-2026-002");
});
test("language can change before login and survives reload", async ({
  page,
}) => {
  await page.locator("#logout").click();
  await choose(page,"#login-language","en");
  await expect(
    page.getByRole("heading", { name: "Understand and manage your system." }),
  ).toBeVisible();
  await expect(page.locator("#password")).toHaveAttribute(
    "placeholder",
    "Enter Admin password",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
test("language switching preserves plugin data and settings drafts without writes", async ({
  page,
}) => {
  await operation(page,'plugin_save',{definition:pluginDefinition});
  await navigate(page, "plugins");
  await page.getByRole('row').filter({hasText:pluginDefinition.name}).getByRole('button',{name:'查看详情',exact:true}).click();
  const json = await page.locator('#plugin-detail pre').textContent();
  const mutations = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      mutations.push(request.postDataJSON()?.action ?? request.url());
  });
  await choose(page,"#app-language","en");
  await expect(
    page.getByRole("heading", { name: "Business plugins", exact: true }),
  ).toBeVisible();
  await expect(page.locator('#plugin-detail pre')).toHaveText(json);
  await navigate(page, "settings");
  await page.locator("#setting-manager-timeoutMs").fill("1234568");
  await choose(page,"#app-language","zh-CN");
  await expect(
    page.getByRole("heading", { name: "系统配置", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#setting-manager-timeoutMs")).toHaveValue(
    "1234568",
  );
  expect(mutations.every((action) => ['configuration_list','configuration_get','models'].includes(action))).toBe(
    true,
  );
  await choose(page,"#app-language","en");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectChoice(page,"#app-language","en");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-navigation [data-view]')).toHaveCount(6);
  await expect(page.locator('.mobile-navigation [data-view]').first()).toBeVisible();
  for (const button of await page.locator(".mobile-navigation [data-view]").all()) {
    const box = await button.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
test('schedule details preserve business data across language changes without writes',async({page})=>{
  const plan=await operation(page,'schedule_save',{schedule:{name:'只读业务计划',kind:'task',cron:'0 9 * * *',timezone:'Asia/Tokyo',type:'content.review',input:{content:'用户自己的中文内容'},enabled:false}});
  await navigate(page,'schedules');
  await page.getByRole('row').filter({hasText:plan.name}).getByRole('button',{name:'查看详情',exact:true}).click();
  const mutations=[];page.on('request',request=>{if(request.method()==='POST'&&/^schedule_(save|enable)$/.test(request.postDataJSON()?.action))mutations.push(request.postDataJSON());});
  await choose(page,'#app-language','en');
  await expect(page.getByRole('heading',{name:'Schedule details',exact:true})).toBeVisible();
  await expect(page.locator('#schedule-detail')).toContainText('用户自己的中文内容');
  await expect(page.locator('#schedule-detail')).toContainText('Asia/Tokyo');
  await expect(page.locator('#schedule-detail')).toContainText('Disabled');
  const saved=(await operation(page,'schedules')).find(item=>item.id===plan.id);
  expect(saved.name).toBe(plan.name);expect(saved.input).toEqual(plan.input);expect(saved.enabled).toBe(false);expect(mutations).toEqual([]);
});

test("completed task artifacts are viewable and downloadable", async ({
  page,
}) => {
  await navigate(page, "tasks");
  const task = (await operation(page, "tasks", { status: "completed" }))[0];
  await page
    .locator("tr")
    .filter({ hasText: task.task_id })
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(page.locator(".previews img")).toBeVisible();
  expect(
    await page
      .locator(".previews img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  const link = page.getByRole("link", { name: "review.txt" });
  await expect(link).toBeVisible();
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("review.txt");
});
test("management messages render safe Markdown and retain an unsent draft while polling", async ({
  page,
}) => {
  await navigate(page, "chat");
  await page.locator("#message-input").fill("检查队列");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("#messages")).toContainText("<img src=x");
  const reply=page.locator('#messages .assistant').last();
  await expect(reply.getByRole('heading',{name:'运行报告'})).toBeVisible();
  await expect(reply.locator('strong')).toHaveText('队列');
  await expect(reply.locator('pre code')).toHaveText('const count = 3;\n');
  await expect(reply.locator('table tbody td').first()).toHaveText('3');
  await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(reply.locator('img')).toHaveCount(0);
  await expect(reply.getByRole('link',{name:'文档'})).toHaveAttribute('rel','noopener noreferrer');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.screenshot({path:'.tmp/react-admin/screenshots/chat-markdown-desktop.png',fullPage:true,animations:'disabled'});
  await page.locator("#message-input").fill("下一条未发送的消息");
  await page.waitForResponse(
    (r) =>
      r.url().includes("/conversations/") && r.request().method() === "GET",
  );
  await expect(page.locator("#message-input")).toHaveValue(
    "下一条未发送的消息",
  );
});

test('chat composer draft survives leaving and returning to the page',async({page})=>{
  await navigate(page,'chat');
  await page.locator('#message-input').fill('Keep this unsent draft across navigation');
  await navigate(page,'overview');await navigate(page,'chat');
  await expect(page.locator('#message-input')).toHaveValue('Keep this unsent draft across navigation');
});

for(const timezoneId of ['America/New_York','Asia/Tokyo'])test(`chat timestamps use browser timezone ${timezoneId} and polling updates thread title`,async({browser})=>{
  const context=await browser.newContext({timezoneId,locale:'en-US'}),page=await context.newPage();
  try {
    await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.locator('#workspace')).toBeVisible();
    const stamp=Date.parse('2026-01-02T01:04:05Z');let title='首条用户消息';
    const conversation={id:'timestamp-test',title,execution:{},messages:[{id:'user-time',role:'user',status:'completed',text:'Hello',created_at:stamp},{id:'agent-time',role:'assistant',status:'completed',text:'**Reply**',created_at:stamp+60000}]};
    await page.route('**/admin/api/conversations',route=>route.fulfill({json:[conversation]}));
    await page.route('**/admin/api/conversations/timestamp-test',route=>route.fulfill({json:{...conversation,title}}));
    await navigate(page,'chat');
    const times=page.locator('#messages time');await expect(times).toHaveCount(2);
    for(let index=0;index<2;index++) {
      const date=stamp+index*60000;
      const expected=await page.evaluate(value=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'}).format(new Date(value)),date);
      await expect(times.nth(index)).toHaveText(expected);await expect(times.nth(index)).toHaveAttribute('datetime',new Date(date).toISOString());
    }
    title='Codex 提供的对话名称';
    await expect(page.locator('.conversation-list').getByRole('button',{name:title,exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  }finally{await context.close();}
});

test('a missing sibling artifact does not hide available downloads',async({page})=>{
  const task=(await operation(page,'tasks',{status:'completed'}))[0],detail=await operation(page,'task',{task_id:task.task_id});
  const image=detail.artifacts.find(item=>item.mime.startsWith('image/'));
  await page.route(`**/admin/api/artifacts/${task.task_id}/${image.artifact_id}`,route=>route.fulfill({status:404,body:'Missing fixture'}));
  await navigate(page,'tasks');
  await page.locator('tr').filter({hasText:task.task_id}).getByRole('button',{name:'详情',exact:true}).click();
  await expect(page.getByRole('link',{name:'review.txt'})).toBeVisible();
});

test('a pending retry cannot create multiple replacement tasks through repeated clicks',async({page})=>{
  const task=(await operation(page,'tasks',{status:'failed'}))[0];let retryCalls=0;
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON()?.action==='retry'){
      retryCalls++;await new Promise(resolve=>setTimeout(resolve,600));
      await route.fulfill({json:{task_id:'synthetic-retry'}});
    }else await route.continue();
  });
  await navigate(page,'tasks');
  await page.locator('tr').filter({hasText:task.task_id}).getByRole('button',{name:'详情',exact:true}).click();
  const retry=page.getByRole('button',{name:'重新执行任务',exact:true});
  await retry.evaluate(button=>{button.click();button.click();});
  await expect.poll(()=>retryCalls).toBe(1);
  await page.waitForTimeout(800);expect(retryCalls).toBe(1);
});
test('English navigation covers each view and schedules guide users to management chat',async({page})=>{
  await choose(page,'#app-language','en');
  for(const [view,title] of Object.entries({overview:'Overview',chat:'Management chat',tasks:'Task history',plugins:'Business plugins',schedules:'Schedules',settings:'Settings'})){
    await navigate(page,view);await expect(page.locator('#page-title')).toHaveText(title);
  }
  await navigate(page,'schedules');
  await expect(page.getByText('Schedule configuration',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open management chat',exact:true}).click();
  await expect(page.locator('#message-input')).toBeVisible();
});

test("English login errors, session reload and logout work without model access", async ({
  page,
}) => {
  await page.locator("#logout").click();
  await choose(page,"#login-language","en");
  await page.locator("#password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Incorrect password or expired session.",
  );
  await page.locator("#password").fill("local-browser-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.reload();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#login")).toBeVisible();
  expect((await page.request.get("/admin/api/tasks")).status()).toBe(401);
});
test("typing during a slow language change preserves the latest draft", async ({
  page,
}) => {
  await navigate(page, "chat");
  await page.locator("#message-input").fill("before");
  await choose(page,'#app-language','en');
  await page.locator('#message-input').fill('edited while language was loading');
  await expect(
    page.getByRole("heading", { name: "Management chat", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue(
    "edited while language was loading",
  );
});
test('an empty schedules page keeps its explanation and management chat shortcut',async({page})=>{
  await page.route('**/admin/api/schedules',route=>route.fulfill({json:[]}));
  await navigate(page,'schedules');await choose(page,'#app-language','en');
  await expect(page.getByText('No records yet',{exact:true})).toBeVisible();
  await expect(page.getByText('Schedule configuration',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'View details',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Open management chat',exact:true}).click();
  await expect(page.locator('#message-input')).toBeVisible();
});

test("task investigation uses the server-owned prompt and opens its existing conversation", async ({
  page,
}) => {
  const task = (await operation(page, "tasks", { status: "failed" }))[0];
  await navigate(page, "tasks");
  await page
    .locator("tr")
    .filter({ hasText: task.task_id })
    .getByRole("button", { name: "调查", exact: true })
    .click();
  await expect(page.locator("#message-input")).toBeVisible();
  await expect(page.locator("#messages .message.user")).toContainText(
    task.task_id,
  );
  await expect(page.locator("#messages .message.user")).toContainText(
    "不重新提交任务",
  );
  await navigate(page, "tasks");
  await page
    .locator("tr")
    .filter({ hasText: task.task_id })
    .getByRole("button", { name: "调查", exact: true })
    .click();
  await expect(page.locator("#message-input")).toBeVisible();
  await expect(page.locator("#messages .message.user")).toHaveCount(1);
});

test('changing Admin password signs out and the new password works',async({page})=>{
  await navigate(page,'chat');await page.locator('#message-input').fill('Sensitive unsent synthetic draft');
  await navigate(page,'settings');
  await settingsTab(page,'security');
  await page.locator('#current-admin-password').fill('local-browser-password');
  await page.locator('#new-admin-password').fill('replacement-browser-password');
  await page.locator('#confirm-admin-password').fill('replacement-browser-password');
  await page.getByRole('button',{name:'修改 Admin 密码',exact:true}).click();
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('密码已修改');
  await page.locator('#password').fill('replacement-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();
  await navigate(page,'chat');await expect(page.locator('#message-input')).toHaveValue('');
  expect((await page.request.post('/admin/api/password',{data:{currentPassword:'replacement-browser-password',password:'local-browser-password'}})).status()).toBe(200);
});


test('Admin layout keeps spacing and actions within desktop tablet and phone viewports',async({page})=>{
  test.setTimeout(90000);
  for(const language of ['zh-CN','en']){
    await choose(page,'#app-language',language);
    for(const width of [390,768,1440,2560]){
      await page.setViewportSize({width,height:1000});
      for(const view of ['overview','chat','tasks','plugins','schedules','settings']){
        await navigate(page,view);await expect(page.locator(view==='chat'?'.chat-compose':'#view .ant-card, #view .ant-alert').first()).toBeVisible();await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
        await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:language+' '+width+' '+view}).toBeLessThanOrEqual(width);
        if(view==='settings'){
          await expect(page.getByRole('tabpanel',{includeHidden:false})).toHaveCount(1);
          await expect(page.locator('.settings-tabs .ant-card:visible')).toHaveCount(1);
        }
        if(view==='plugins'||view==='schedules'){
          const action=page.getByRole('button',{name:language==='en'?'Open management chat':'前往管理对话',exact:true});await expect(action).toBeVisible();
          const box=await action.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
          const details=page.getByRole('button',{name:language==='en'?'View details':'查看详情',exact:true});
          for(const button of await details.all()){const rect=await button.boundingBox();expect(rect.x+rect.width).toBeLessThanOrEqual(width);}
        }
        if(width!==768)await page.screenshot({path:'.tmp/chat-layout/screenshots/'+view+'-'+language+'-'+width+'.png',animations:'disabled'});
      }
    }
  }
});

for(const view of ['plugins','schedules'])test(`${view} supports one-step toggles without duplicate requests`,async({page})=>{
  if(view==='plugins')await operation(page,'plugin_save',{definition:{...pluginDefinition,enabled:false}});
  const name=view==='plugins'?pluginDefinition.name:'每日运行巡检';
  const action=view==='plugins'?'plugin_enable':'schedule_enable';
  let calls=0;
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON()?.action===action){calls++;await new Promise(resolve=>setTimeout(resolve,250));}
    await route.continue();
  });
  await navigate(page,view);
  const row=page.getByRole('row').filter({hasText:name}),toggle=row.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await toggle.evaluate(element=>{element.click();element.click();});
  await expect(toggle).toHaveAttribute('aria-checked','true');expect(calls).toBe(1);
  const response=await page.request.get('/admin/api/'+view),data=await response.json();
  expect((view==='plugins'?data.configured:data).find(item=>item.name===name).enabled).toBe(true);
  await row.getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(page.locator(view==='plugins'?'#plugin-detail':'#schedule-detail')).toContainText(view==='plugins'?'true':'已启用');
});

test('complex settings are readable without JSON or prompt editors and Agent operations remain available',async({page})=>{
  const text='通过 Agent 保存的管理指令';
  await operation(page,'configuration_update',{scope:'manager',patch:{instructions:text}});
  await navigate(page,'settings');
  await expect(page.locator('#setting-manager-instructions')).toHaveCount(0);
  await expect(page.locator('#setting-http-targets')).toHaveCount(0);
  await page.locator('#configuration-manager').getByText('管理提示词',{exact:true}).click();
  await expect(page.locator('#configuration-manager')).toContainText(text);
  await expect(page.locator('#setting-manager-model')).toBeVisible();
  await settingsTab(page,'http');
  await expect(page.locator('#configuration-http')).toContainText('请通过管理 Agent 修改复杂配置。');
  await expect(page.locator('#configuration-http').getByRole('button',{name:'保存配置',exact:true})).toHaveCount(0);
  await settingsTab(page,'execution');
  await expect(page.locator('#setting-execution-concurrency')).toBeVisible();
});

test('a failed enable operation preserves state and can be tried again',async({page})=>{
  await operation(page,'plugin_save',{definition:{...pluginDefinition,enabled:false}});
  let fail=true;
  await page.route('**/admin/api/operations',async route=>{
    if(fail&&route.request().postDataJSON()?.action==='plugin_enable')await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_TOGGLE_FAILURE',message:'Synthetic toggle failure'}}});
    else await route.continue();
  });
  await navigate(page,'plugins');
  const toggle=page.getByRole('row').filter({hasText:pluginDefinition.name}).getByRole('switch');
  await toggle.click();await expect(page.getByRole('status')).toContainText('Synthetic toggle failure');
  await expect(toggle).toHaveAttribute('aria-checked','false');await expect(toggle).toBeEnabled();
  fail=false;await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true');
});
