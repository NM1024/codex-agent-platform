import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {navigate} from './navigation.mjs';

async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});
  expect(response.ok()).toBeTruthy();return response.json();
}
const row=page=>page.getByRole('row').filter({hasText:'content.review'});
const editor=page=>page.getByRole('dialog').filter({has:page.locator('#plugin-definition-form')});
test.beforeAll(async()=>{await mkdir('.tmp/admin-overlays',{recursive:true});});
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await navigate(page,'plugins');
});

test('plugin definition details open in a dismissible drawer',async({page})=>{
  await row(page).getByRole('button',{name:'查看详情',exact:true}).click();
  const drawer=page.getByRole('dialog').filter({has:page.locator('#plugin-detail')});
  await expect(drawer).toBeVisible();await expect(drawer).toContainText('content.review');
  await page.screenshot({path:'.tmp/admin-overlays/plugin-record-desktop.png',animations:'disabled'});
  await drawer.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(page.locator('#plugin-detail')).toHaveCount(0);
});

test('new plugin uses tabbed JSON contract editor and saves disabled',async({page})=>{
  await page.getByRole('button',{name:'新增业务插件',exact:true}).click();
  await expect(editor(page)).toBeVisible();
  await page.locator('#plugin-definition-type').fill('synthetic.overlay');await page.locator('#plugin-definition-name').fill('Synthetic overlay');
  await editor(page).getByRole('tab',{name:'业务指令',exact:true}).click();await page.locator('#plugin-definition-instructions').fill('Submit a JSON object through complete_task.');
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page)).toHaveCount(0);
  const saved=await operation(page,'plugin_get',{type:'synthetic.overlay'});
  expect(saved.enabled).toBe(false);expect(saved.capabilities).toEqual({tools:[],image_generation:false,web_search:false});expect(saved.delivery).toEqual({mode:'none'});
  await operation(page,'plugin_delete',{type:saved.type});
});

test('editing a plugin preserves connection and execution settings and retains drafts after failed save',async({page})=>{
  const original=await operation(page,'plugin_get',{type:'content.review'});
  await operation(page,'plugin_execution_update',{type:original.type,revision:original.revision,execution:{model:'fixture-fast',reasoningEffort:'low',serviceTier:'default'}});
  const before=await operation(page,'plugin_get',{type:'content.review'});
  const connection=await (await page.request.get('/admin/api/plugins/content.review/connection')).json();
  let payload;let fail=true;
  await page.route('**/admin/api/operations',async route=>{
    const body=route.request().postDataJSON();
    if(body.action==='plugin_save'){payload=body.args.definition;if(fail){fail=false;return route.fulfill({status:503,json:{error:{message:'Synthetic failure'}}});}}
    await route.continue();
  });
  await row(page).getByRole('button',{name:'编辑业务插件',exact:true}).click();
  await editor(page).getByRole('tab',{name:'业务指令',exact:true}).click();await page.locator('#plugin-definition-instructions').fill('Synthetic overlay draft');
  await editor(page).getByRole('tab',{name:'输入结构',exact:true}).click();await editor(page).getByRole('tab',{name:'业务指令',exact:true}).click();
  await expect(page.locator('#plugin-definition-instructions')).toHaveValue('Synthetic overlay draft');
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page).getByRole('alert')).toContainText('业务插件保存失败');
  await expect(page.locator('#plugin-definition-instructions')).toHaveValue('Synthetic overlay draft');
  expect(payload).not.toHaveProperty('revision');expect(payload).not.toHaveProperty('connection');expect(payload).not.toHaveProperty('updated_at');
  expect(payload.execution).toEqual(before.execution);
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page)).toHaveCount(0);
  expect(await (await page.request.get('/admin/api/plugins/content.review/connection')).json()).toEqual(connection);
  const {revision,updated_at,connection:status,...definition}=original;await operation(page,'plugin_save',{definition});
});

test('stale plugin definition refuses overwrite and preserves draft until explicit reread',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  await row(page).getByRole('button',{name:'编辑业务插件',exact:true}).click();await expect(page.locator('#plugin-definition-name')).toHaveValue(before.name);
  await page.locator('#plugin-definition-name').fill('Local draft');
  const {revision,updated_at,connection,...definition}=before;await operation(page,'plugin_save',{definition:{...definition,name:'Concurrent synthetic name'}});
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page).getByRole('alert')).toContainText('业务插件已被修改');
  await expect(page.locator('#plugin-definition-name')).toHaveValue('Local draft');expect((await operation(page,'plugin_get',{type:before.type})).name).toBe('Concurrent synthetic name');
  await editor(page).getByRole('button',{name:'重新读取',exact:true}).click();await expect(page.locator('#plugin-definition-name')).toHaveValue('Concurrent synthetic name');
  await editor(page).getByRole('button',{name:'取消',exact:true}).click();await operation(page,'plugin_save',{definition});
});

test('invalid schema remains in editor and phone overlay contains save actions',async({page})=>{
  await page.setViewportSize({width:320,height:640});await page.getByRole('button',{name:'新增业务插件',exact:true}).click();
  await page.locator('#plugin-definition-type').fill('synthetic.invalid');await page.locator('#plugin-definition-name').fill('Invalid schema');
  await editor(page).getByRole('tab',{name:'业务指令',exact:true}).click();await page.locator('#plugin-definition-instructions').fill('Synthetic instructions');
  await editor(page).getByRole('tab',{name:'输入结构',exact:true}).click();await page.locator('#plugin-definition-input').fill('{');
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page).getByRole('alert')).toContainText('输入结构须为 JSON 对象');
  await expect(page.locator('#plugin-definition-input')).toHaveValue('{');
  const dimensions=await editor(page).locator('.ant-modal-body').evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const bounds=await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({path:'.tmp/admin-overlays/plugin-editor-320.png',animations:'disabled'});
});

test('closing a loading definition cannot reopen it after the response arrives',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/admin/api/operations',async route=>{if(route.request().postDataJSON().action==='plugin_get')await gate;await route.continue();});
  await row(page).getByRole('button',{name:'查看详情',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/^(关闭|Close)$/}).click();release();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('#plugin-detail')).toHaveCount(0);
});

test('invalid-plugin records open in their own drawer',async({page})=>{
  await page.route('**/admin/api/plugins',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,invalid:[{type:'synthetic.invalid',error:'INVALID_PLUGIN_CONFIGURATION'}]}});});
  await navigate(page,'overview');await navigate(page,'plugins');await page.getByRole('button',{name:'查看无效插件记录',exact:true}).click();
  const drawer=page.getByRole('dialog');await expect(drawer).toContainText('synthetic.invalid');await expect(drawer).toContainText('INVALID_PLUGIN_CONFIGURATION');
});

test('a revision conflict during save keeps the edit draft and requires reread',async({page})=>{
  await row(page).getByRole('button',{name:'编辑业务插件',exact:true}).click();await page.locator('#plugin-definition-name').fill('Draft during conflict');
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON().action==='plugin_save')return route.fulfill({status:409,json:{error:{code:'PLUGIN_REVISION_CONFLICT',message:'业务插件已被修改，请重新读取后再保存。'}}});
    await route.continue();
  });
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page).getByRole('alert')).toContainText('业务插件已被修改');
  await expect(page.locator('#plugin-definition-name')).toHaveValue('Draft during conflict');await expect(editor(page).getByRole('button',{name:'保存业务插件',exact:true})).toBeDisabled();await expect(editor(page).getByRole('button',{name:'保存业务插件',exact:true})).toHaveAttribute('aria-busy','false');
  await expect(editor(page).getByRole('button',{name:'重新读取',exact:true})).toBeVisible();
});

test('creation cannot replace an existing plugin type',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  await page.getByRole('button',{name:'新增业务插件',exact:true}).click();await page.locator('#plugin-definition-type').fill(before.type);await page.locator('#plugin-definition-name').fill('Duplicate creation draft');
  await editor(page).getByRole('tab',{name:'业务指令',exact:true}).click();await page.locator('#plugin-definition-instructions').fill('Duplicate synthetic instructions');
  await editor(page).getByRole('button',{name:'保存业务插件',exact:true}).click();await expect(editor(page).getByRole('alert')).toContainText('业务插件已被修改');
  expect(await operation(page,'plugin_get',{type:before.type})).toEqual(before);
  await editor(page).getByRole('tab',{name:'基本信息',exact:true}).click();await expect(page.locator('#plugin-definition-name')).toHaveValue('Duplicate creation draft');
});

test('English plugin editor shows translated tabs and preserves drafts across them',async({page})=>{
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
  await page.getByRole('button',{name:'New business plugin',exact:true}).click();const modal=editor(page);
  await expect(modal.getByRole('tab')).toHaveText(['Basic information','Instructions','Input schema','Result schema','Capabilities']);
  await page.locator('#plugin-definition-name').fill('English synthetic draft');await modal.getByRole('tab',{name:'Capabilities',exact:true}).click();await expect(modal).toContainText('Available tools');
  await modal.getByRole('tab',{name:'Basic information',exact:true}).click();await expect(page.locator('#plugin-definition-name')).toHaveValue('English synthetic draft');await modal.getByRole('button',{name:'Cancel',exact:true}).click();
});
