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

test('plugin model settings persist overrides and distinguish model default from inheritance',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'模型设置',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'模型设置：内容审核'});
  await choose(page,'#plugin-execution-model','Fixture Fast');
  await choose(page,'#plugin-execution-reasoningEffort','low');
  await modal.getByRole('button',{name:'保存模型设置'}).click();await expect(modal).toHaveCount(0);
  const saved=await operation(page,'plugin_get',{type:before.type});
  expect(saved.execution).toEqual({model:'fixture-fast',reasoningEffort:'low'});
  expect(saved.instructions).toBe(before.instructions);expect(saved.enabled).toBe(before.enabled);
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'模型设置',exact:true}).click();
  await choose(page,'#plugin-execution-reasoningEffort','模型默认');
  await modal.getByRole('button',{name:'保存模型设置'}).click();await expect(modal).toHaveCount(0);
  expect((await operation(page,'plugin_get',{type:before.type})).execution).toEqual({model:'fixture-fast',reasoningEffort:null});
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'模型设置',exact:true}).click();
  await choose(page,'#plugin-execution-model','继承全局设置');
  await modal.getByRole('button',{name:'保存模型设置'}).click();await expect(modal).toHaveCount(0);
  expect((await operation(page,'plugin_get',{type:before.type})).execution).toEqual({});
});

test('concurrent plugin edits keep the model draft and require rereading before retry',async({page})=>{
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'模型设置',exact:true}).click();
  await choose(page,'#plugin-execution-model','Fixture Fast');
  const {revision,updated_at,connection,...definition}=await operation(page,'plugin_get',{type:'content.review'});
  await operation(page,'plugin_save',{definition:{...definition,instructions:'Synthetic concurrent business edit'}});
  const modal=page.getByRole('dialog',{name:'模型设置：内容审核'});
  await modal.getByRole('button',{name:'保存模型设置'}).click();
  await expect(modal).toContainText('业务插件已被修改，请重新读取后再保存。');
  await expect(modal.locator('.ant-select').filter({has:page.locator('#plugin-execution-model')})).toContainText('Fixture Fast');
  expect((await operation(page,'plugin_get',{type:'content.review'})).instructions).toBe('Synthetic concurrent business edit');
  await modal.getByRole('button',{name:'重新读取'}).click();
  await choose(page,'#plugin-execution-model','Fixture Fast');
  await modal.getByRole('button',{name:'保存模型设置'}).click();await expect(modal).toHaveCount(0);
});

test('unavailable saved choices remain readable and cancelling on a phone makes no change',async({page})=>{
  await operation(page,'plugin_save',{definition:{...original,execution:{model:'unavailable-synthetic-model',reasoningEffort:'ultra'}}});
  await navigate(page,'overview');await navigate(page,'plugins');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'模型设置',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'模型设置：内容审核'});
  await expect(modal).toContainText('当前保存值：unavailable-synthetic-model');
  await expect(modal).toContainText('当前保存值：ultra');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  expect((await operation(page,'plugin_get',{type:original.type})).execution).toEqual({model:'unavailable-synthetic-model',reasoningEffort:'ultra'});
});
