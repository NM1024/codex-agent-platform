import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

async function operation(page,action,args={}){const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok()).toBeTruthy();return response.json();}
async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function category(page,scope){await page.getByRole('combobox',{name:'配置分类',exact:true}).click();await page.locator('.ant-select-dropdown:visible [data-settings-choice="'+scope+'"]').click();}

test('mobile category selection reaches every settings section and preserves drafts across resizing',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page);await navigate(page,'settings');
 await expect(page.getByRole('combobox',{name:'配置分类',exact:true})).toBeVisible();await page.locator('#setting-manager-timeoutMs').fill('900001');
 const writes=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/operations')&&request.postDataJSON().action==='configuration_update')writes.push(request);});
 for(const [scope,title] of [['execution','业务执行'],['retention','历史数据清理'],['http_targets','HTTP 目标'],['notifications','通知渠道'],['security','Admin 密码'],['deployment','部署配置']]){
  await category(page,scope);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 }
 await category(page,'manager');await expect(page.locator('#setting-manager-timeoutMs')).toHaveValue('900001');
 await page.setViewportSize({width:1440,height:1000});await expect(page.getByRole('combobox',{name:'配置分类',exact:true})).toHaveCount(0);await expect(page.locator('[data-settings-tab="manager"]').locator('..')).toHaveAttribute('aria-selected','true');await expect(page.locator('#setting-manager-timeoutMs')).toHaveValue('900001');expect(writes).toEqual([]);
});

test('complex configuration opens in a read-only drawer without losing an unsaved form',async({page})=>{
 await login(page);const instructions='Synthetic configuration <script>literal text</script>';await operation(page,'configuration_update',{scope:'manager',patch:{instructions}});await navigate(page,'settings');await page.locator('#setting-manager-timeoutMs').fill('900002');
 await page.getByRole('button',{name:'查看复杂配置：管理提示词',exact:true}).click();const drawer=page.getByRole('dialog',{name:'管理提示词',exact:false});await expect(drawer).toBeVisible();await expect(drawer).toContainText(instructions);await expect(drawer.getByRole('textbox')).toHaveCount(0);await expect(drawer.locator('script')).toHaveCount(0);await drawer.getByRole('button',{name:'关闭',exact:true}).click();await expect(drawer).toHaveCount(0);await expect(page.locator('#setting-manager-timeoutMs')).toHaveValue('900002');
});

test('mobile settings panels retain their category names for assistive technology',async({page})=>{
 await page.setViewportSize({width:320,height:740});await login(page);await navigate(page,'settings');await expect(page.getByRole('tabpanel',{name:'管理 Agent',exact:true})).toBeVisible();await category(page,'retention');await expect(page.getByRole('tabpanel',{name:'历史数据清理',exact:true})).toBeVisible();
});

test('schedule guidance opens in a drawer and never mutates or starts a plan',async({page})=>{
 await login(page);await navigate(page,'schedules');const text='定时任务按 Cron 周期自动执行：业务任务调用指定插件处理固定输入；管理巡检把巡检要求交给管理 Agent，并在管理对话中保存结果。';await expect(page.getByText(text,{exact:true})).toHaveCount(0);
 const writes=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/operations'))writes.push(request.postDataJSON().action);});await page.getByRole('button',{name:'运行说明',exact:true}).click();const drawer=page.getByRole('dialog',{name:'运行说明',exact:true});await expect(drawer.getByText(text,{exact:true})).toBeVisible();await drawer.getByRole('button',{name:'关闭',exact:true}).click();await expect(drawer).toHaveCount(0);expect(writes.filter(action=>/^schedule_|submit|inspection/.test(action))).toEqual([]);
});

test('the schedule heading and both header actions remain readable on a narrow phone in both languages',async({page})=>{
 await page.setViewportSize({width:320,height:740});await login(page);await navigate(page,'schedules');
 for(const language of ['简体中文','English']){
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText(language,{exact:true}).click();
  const panel=page.locator('.console-panel').filter({has:page.locator('.schedule-header-actions')}),heading=panel.getByRole('heading',{level:2});
  await expect.poll(async()=>{const box=await heading.boundingBox();return !!box&&box.width>40&&box.height<60;}).toBe(true);
  for(const button of await panel.locator('.schedule-header-actions button').all())await expect(button).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
 }
});
