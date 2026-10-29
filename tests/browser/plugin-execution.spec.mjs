import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
let original;

async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});
  expect(response.ok()).toBeTruthy();return response.json();
}
async function choose(page,id,label) {
  await page.locator(id).click();
  await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click();
}
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await navigate(page,'plugins');
  const {revision,updated_at,connection,...definition}=await operation(page,'plugin_get',{type:'content.review'});original=definition;
});
test.afterEach(async({page})=>{if(original)await operation(page,'plugin_save',{definition:original});});

async function openModels(page) {
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
  await page.getByRole('dialog').getByRole('tab',{name:'模型设置',exact:true}).click();
}
async function saveModels(page) {
  const modal=page.locator('.plugin-connection-modal');
  await modal.getByRole('button',{name:'保存模型设置'}).click();
  await expect(modal.getByRole('status')).toContainText('模型设置已保存。');
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  await expect(modal).toHaveCount(0);
}

test('plugin model settings persist overrides and distinguish model default from inheritance',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  await openModels(page);
  const modal=page.locator('.plugin-connection-modal');
  await choose(page,'#plugin-execution-model','Fixture Fast');
  await choose(page,'#plugin-execution-reasoningEffort','low');
  await saveModels(page);
  const saved=await operation(page,'plugin_get',{type:before.type});
  expect(saved.execution).toEqual({model:'fixture-fast',reasoningEffort:'low'});
  expect(saved.instructions).toBe(before.instructions);expect(saved.enabled).toBe(before.enabled);
  await openModels(page);
  await choose(page,'#plugin-execution-reasoningEffort','模型默认');
  await saveModels(page);
  expect((await operation(page,'plugin_get',{type:before.type})).execution).toEqual({model:'fixture-fast',reasoningEffort:null});
  await openModels(page);
  await choose(page,'#plugin-execution-model','继承全局设置');
  await saveModels(page);
  expect((await operation(page,'plugin_get',{type:before.type})).execution).toEqual({});
});

test('concurrent plugin edits keep the model draft and require rereading before retry',async({page})=>{
  await openModels(page);
  await choose(page,'#plugin-execution-model','Fixture Fast');
  const {revision,updated_at,connection,...definition}=await operation(page,'plugin_get',{type:'content.review'});
  await operation(page,'plugin_save',{definition:{...definition,instructions:'Synthetic concurrent business edit'}});
  const modal=page.locator('.plugin-connection-modal');
  await modal.getByRole('button',{name:'保存模型设置'}).click();
  await expect(modal).toContainText('业务插件已被修改，请重新读取后再保存。');
  await expect(modal.locator('.ant-select').filter({has:page.locator('#plugin-execution-model')})).toContainText('Fixture Fast');
  expect((await operation(page,'plugin_get',{type:'content.review'})).instructions).toBe('Synthetic concurrent business edit');
  await modal.getByRole('button',{name:'重新读取'}).click();
  await choose(page,'#plugin-execution-model','Fixture Fast');
  await saveModels(page);
});

test('unavailable saved choices remain readable and cancelling on a phone makes no change',async({page})=>{
  await operation(page,'plugin_save',{definition:{...original,execution:{model:'unavailable-synthetic-model',reasoningEffort:'ultra'}}});
  await navigate(page,'overview');await navigate(page,'plugins');
  await page.setViewportSize({width:390,height:844});
  await openModels(page);
  const modal=page.locator('.plugin-connection-modal');
  await expect(modal).toContainText('当前保存值：unavailable-synthetic-model');
  await expect(modal).toContainText('当前保存值：ultra');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  expect((await operation(page,'plugin_get',{type:original.type})).execution).toEqual({model:'unavailable-synthetic-model',reasoningEffort:'ultra'});
});


test('tabs preserve connection and model drafts and save only model overrides',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
  const modal=page.locator('.plugin-connection-modal');
  await expect(modal.getByRole('tab')).toHaveText(['入口配置','结果回调 可选','模型设置']);
  await page.locator('#plugin-entry-address').fill('unsaved invalid connection draft');
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await modal.getByRole('switch',{name:'启用结果回调'}).check();
  await page.locator('#plugin-callback-url').fill('https://example.invalid/unsaved-callback');
  await modal.getByRole('tab',{name:'模型设置',exact:true}).click();
  await choose(page,'#plugin-execution-model','Fixture Fast');
  await modal.getByRole('tab',{name:'入口配置',exact:true}).click();
  await expect(page.locator('#plugin-entry-address')).toHaveValue('unsaved invalid connection draft');
  await modal.getByRole('tab',{name:'模型设置',exact:true}).click();
  await expect(modal.locator('.ant-select').filter({has:page.locator('#plugin-execution-model')})).toContainText('Fixture Fast');
  let connectionWrites=0;
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/plugins/content.review/connection'))connectionWrites++;});
  await modal.getByRole('button',{name:'保存模型设置'}).click();
  await expect(modal.getByRole('status')).toContainText('模型设置已保存。');
  expect(connectionWrites).toBe(0);
  expect((await operation(page,'plugin_get',{type:before.type})).execution.model).toBe('fixture-fast');
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await expect(page.locator('#plugin-callback-url')).toHaveValue('https://example.invalid/unsaved-callback');
  await modal.getByRole('button',{name:'取消',exact:true}).click();
});

test('model tab remains usable when connection loading fails and model save can be retried',async({page})=>{
  await page.route('**/admin/api/plugins/content.review/connection',route=>route.fulfill({status:503,json:{error:{message:'Synthetic connection read failure'}}}));
  await openModels(page);
  const modal=page.locator('.plugin-connection-modal');
  await choose(page,'#plugin-execution-model','Fixture Fast');
  let saves=0;
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON()?.action==='plugin_execution_update'&&++saves===1)await route.fulfill({status:503,json:{error:{message:'Synthetic retryable failure'}}});
    else await route.continue();
  });
  await modal.getByRole('button',{name:'保存模型设置'}).click();
  await expect(modal.getByRole('alert')).toContainText('模型设置保存失败，请重试。');
  await saveModels(page);
  expect(saves).toBe(2);
});

test('row actions are compact named icons with focus tooltips in both languages and phone layouts',async({page})=>{
  for(const locale of ['zh-CN','en']){
    if(locale==='en'){
      await page.locator('#app-language').click();
      await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
    }
    const labels=locale==='en'?['Configure connection','Integration docs','View details','Delete plugin: 内容审核']:['配置接入','对接文档','查看详情','删除业务插件：内容审核'];
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:900});
      const row=page.getByRole('row').filter({hasText:'content.review'}),actions=row.locator('.plugin-row-actions');
      await expect(actions.getByRole('button')).toHaveCount(4);
      const centers=[];
      for(const label of labels){
        const button=actions.getByRole('button',{name:label,exact:true});
        await expect(button).toBeVisible();await expect(button).toHaveText('');await expect(button.locator('svg')).toHaveCount(1);
        const box=await button.boundingBox();centers.push(box.y+box.height/2);
      }
      expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(1);
      await actions.getByRole('button',{name:labels[0],exact:true}).focus();
      await expect(page.getByRole('tooltip')).toContainText(labels[0]);
      await actions.getByRole('button',{name:labels[0],exact:true}).evaluate(button=>button.blur());
      await page.mouse.move(0,0);
      if(locale==='zh-CN')await page.screenshot({path:`.tmp/plugin-config-${width}.png`,animations:'disabled'});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
});
