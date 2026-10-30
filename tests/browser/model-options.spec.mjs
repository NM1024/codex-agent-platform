import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
import {openChatPicker,chatPicker} from './agent-picker.mjs';

test.use({locale:'zh-CN',timezoneId:'Asia/Shanghai'});
const initial={verbosity:'medium',reasoningSummary:'concise',autoCompactTokenLimit:null,toolOutputTokenLimit:null};
async function operation(page,action,args={}){const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok()).toBeTruthy();return response.json();}
async function choose(page,id,label){const input=page.locator('#'+id);await input.click({timeout:5000});const listId=await input.getAttribute('aria-controls');await page.locator('.ant-select-dropdown:visible').filter({has:page.locator('[id="'+listId+'"]')}).getByText(label,{exact:typeof label==='string'}).click({timeout:5000});}
async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function expand(container){const toggle=container.getByRole('button',{name:'高级模型参数',exact:true});if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}
test.beforeEach(async({page})=>{await login(page);});

test('global advanced settings start collapsed in both scopes and save all four independent parameters',async({page})=>{
  test.setTimeout(40000);
  const snapshots={},modified=new Set();
  try{
    for(const scope of ['manager','execution'])snapshots[scope]=(await operation(page,'configuration_get',{scope})).values;
    await navigate(page,'settings');
    for(const [scope,title] of [['manager','管理 Agent'],['execution','业务执行']]){
      await page.getByRole('tab',{name:title,exact:true}).click();const form=page.locator('#configuration-'+scope),compact=scope==='manager'?1024:2147483647,tool=scope==='manager'?256:2147483647;
      await expect(form.getByRole('button',{name:'高级模型参数',exact:true})).toHaveAttribute('aria-expanded','false');
      await expand(form);await expect(form.locator('#setting-'+scope+'-verbosity')).toHaveCount(1);
      await choose(page,'setting-'+scope+'-verbosity','详细');await choose(page,'setting-'+scope+'-reasoningSummary','详细摘要');
      await choose(page,'setting-'+scope+'-autoCompactTokenLimit-mode','手动');
      await expect(page.locator('#setting-'+scope+'-autoCompactTokenLimit')).toHaveValue('65536');
      await page.locator('#setting-'+scope+'-autoCompactTokenLimit').fill(String(compact));
      await choose(page,'setting-'+scope+'-toolOutputTokenLimit-mode','手动');
      await expect(page.locator('#setting-'+scope+'-toolOutputTokenLimit')).toHaveValue('8192');
      await page.locator('#setting-'+scope+'-toolOutputTokenLimit').fill(String(tool));
      modified.add(scope);await form.locator('button[type=submit]').click();
      await expect.poll(async()=>{const {values}=await operation(page,'configuration_get',{scope});return Object.fromEntries(Object.keys(initial).map(key=>[key,values[key]]));}).toEqual({verbosity:'high',reasoningSummary:'detailed',autoCompactTokenLimit:compact,toolOutputTokenLimit:tool});
      await choose(page,'setting-'+scope+'-autoCompactTokenLimit-mode','自动');await choose(page,'setting-'+scope+'-toolOutputTokenLimit-mode','自动');
      await form.locator('button[type=submit]').click();
      await expect.poll(async()=>{const {values}=await operation(page,'configuration_get',{scope});return [values.autoCompactTokenLimit,values.toolOutputTokenLimit];}).toEqual([null,null]);
    }
  }finally{for(const [scope,values] of Object.entries(snapshots).filter(([scope])=>modified.has(scope)))await operation(page,'configuration_update',{scope,patch:Object.fromEntries(Object.keys(initial).map(key=>[key,values[key]??(scope==='execution'&&key==='reasoningSummary'?'auto':initial[key])]))});}
});

test('chat preserves four overrides across model switches and automatic budgets override global manual values',async({page})=>{
  const before=(await operation(page,'configuration_get',{scope:'manager'})).values;
  try{
    await operation(page,'configuration_update',{scope:'manager',patch:{autoCompactTokenLimit:32768,toolOutputTokenLimit:4096}});
    const response=await page.request.post('/admin/api/conversations',{data:{title:'Synthetic advanced options',execution:{verbosity:'high',reasoningSummary:'none',autoCompactTokenLimit:null,toolOutputTokenLimit:null,serviceTier:'default',reasoningEffort:'low'}}});expect(response.ok()).toBeTruthy();const created=await response.json();
    const saved=async()=>(await(await page.request.get('/admin/api/conversations/'+created.id)).json()).execution;
    await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);await openChatPicker(page);
    const panel=chatPicker(page);await expect(panel.getByRole('button',{name:'高级模型参数',exact:true})).toHaveCount(0);await expect(panel.getByRole('switch',{name:'快速模式',exact:true})).toBeVisible();
    await panel.getByRole('radio',{name:'Fixture Fast',exact:true}).click();
    await expect.poll(saved).toEqual({model:'fixture-fast',serviceTier:'default',verbosity:'high',reasoningSummary:'none',autoCompactTokenLimit:null,toolOutputTokenLimit:null});
    await page.keyboard.press('Escape');await openChatPicker(page);await expect(chatPicker(page).getByRole('button',{name:'高级模型参数',exact:true})).toHaveCount(0);
  }finally{await operation(page,'configuration_update',{scope:'manager',patch:{autoCompactTokenLimit:before.autoCompactTokenLimit??null,toolOutputTokenLimit:before.toolOutputTokenLimit??null}});}
});

test('phone chat only offers model reasoning and speed without materializing inherited advanced options',async({page})=>{
  await page.setViewportSize({width:390,height:600});
  const created=await(await page.request.post('/admin/api/conversations',{data:{title:'Synthetic inherited advanced options',execution:{}}})).json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);await page.locator('#message-input').fill('Synthetic draft');await openChatPicker(page);
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/conversations/'+created.id))writes++;});
  const panel=chatPicker(page);await expect(panel.getByRole('button',{name:'高级模型参数',exact:true})).toHaveCount(0);await expect(panel.getByRole('switch',{name:'快速模式',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');expect((await(await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual({});await expect(page.locator('#message-input')).toHaveValue('Synthetic draft');expect(writes).toBe(0);
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
  await openChatPicker(page);await expect(chatPicker(page).getByRole('button',{name:'Advanced model settings',exact:true})).toHaveCount(0);await expect(chatPicker(page).getByRole('switch',{name:'Fast mode',exact:true})).toBeVisible();
});

test('plugin advanced overrides preserve automatic budgets and clear each field back to inheritance',async({page})=>{
  test.setTimeout(40000);
  const original=await operation(page,'plugin_get',{type:'content.review'});
  try{
    await navigate(page,'plugins');await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
    const modal=page.getByRole('dialog');await modal.getByRole('tab',{name:'模型设置',exact:true}).click();
    await expect(modal.getByRole('button',{name:'高级模型参数',exact:true})).toHaveAttribute('aria-expanded','false');await expand(modal);
    await choose(page,'plugin-execution-verbosity','简洁');await choose(page,'plugin-execution-reasoningSummary','不显示摘要');
    await choose(page,'plugin-execution-autoCompactTokenLimit-mode','自动');await choose(page,'plugin-execution-toolOutputTokenLimit-mode','手动');
    await choose(page,'plugin-execution-model','Fixture Fast');
    await modal.getByRole('button',{name:/保存模型设置$/}).click();await expect(modal.getByRole('status')).toContainText('模型设置已保存。');
    expect((await operation(page,'plugin_get',{type:original.type})).execution).toMatchObject({model:'fixture-fast',verbosity:'low',reasoningSummary:'none',autoCompactTokenLimit:null,toolOutputTokenLimit:8192});
    for(const key of ['verbosity','reasoningSummary','autoCompactTokenLimit-mode','toolOutputTokenLimit-mode']){await choose(page,'plugin-execution-'+key,/^继承全局设置/);}
    await modal.getByRole('button',{name:/保存模型设置$/}).click();await expect.poll(async()=>(await operation(page,'plugin_get',{type:original.type})).execution).toEqual({model:'fixture-fast'});
  }finally{const latest=await operation(page,'plugin_get',{type:original.type});await operation(page,'plugin_execution_update',{type:original.type,execution:original.execution??{},revision:latest.revision});}
});

test('server-side current-conversation configuration updates survive the next browser send',async({page})=>{
  const created=await(await page.request.post('/admin/api/conversations',{data:{title:'Synthetic Agent autonomous settings',execution:{verbosity:'low'}}})).json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);await openChatPicker(page);await expect(chatPicker(page).getByRole('button',{name:'高级模型参数',exact:true})).toHaveCount(0);
  const next={verbosity:'high',reasoningSummary:'none',toolOutputTokenLimit:1024};
  // The management tool persists through this same Store and stream; its MCP
  // identity/revision contract is independently exercised in Node integration.
  expect((await page.request.post('/admin/api/conversations/'+created.id,{data:{execution:next}})).ok()).toBeTruthy();
  await expect.poll(async()=>(await(await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual(next);
  await page.keyboard.press('Escape');await page.locator('#message-input').fill('Synthetic next turn after autonomous setting update');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(async()=>(await(await page.request.get('/admin/api/conversations/'+created.id)).json()).messages.filter(item=>item.role==='user').length).toBe(1);
  expect((await(await page.request.get('/admin/api/conversations/'+created.id)).json()).execution).toEqual(next);
});

test('saving a stale global settings draft refuses to overwrite a concurrent Agent update',async({page})=>{
  const before=await operation(page,'configuration_get',{scope:'manager'});
  try{
    await navigate(page,'settings');const form=page.locator('#configuration-manager');await expand(form);
    await operation(page,'configuration_update',{scope:'manager',patch:{verbosity:before.values.verbosity==='high'?'low':'high'}});
    await choose(page,'setting-manager-reasoningSummary','不显示摘要');await form.locator('button[type=submit]').click();
    await expect(page.getByText(/配置已被其他操作更新，请重新读取后再保存/)).toBeVisible();
    expect((await operation(page,'configuration_get',{scope:'manager'})).values.verbosity).toBe(before.values.verbosity==='high'?'low':'high');
  }finally{await operation(page,'configuration_update',{scope:'manager',patch:{verbosity:before.values.verbosity,reasoningSummary:before.values.reasoningSummary}});}
});
