import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

test('management concurrency defaults to two and persists independently of business execution settings',async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
  const group=async scope=>{
    const response=await page.request.post('/admin/api/operations',{data:{action:'configuration_get',args:{scope}}});expect(response.ok()).toBeTruthy();return response.json();
  };
  const original=await group('manager'),execution=await group('execution');expect(original.values.concurrency).toBe(2);
  try {
    await navigate(page,'settings');await expect(page.locator('#setting-manager-concurrency')).toHaveValue('2');
    await page.locator('#setting-manager-concurrency').fill('1');await page.locator('#configuration-manager').getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>(await group('manager')).values.concurrency).toBe(1);
    expect((await group('execution')).values.concurrency).toBe(execution.values.concurrency);
    expect((await group('manager')).values.model).toBe(original.values.model);
    await page.reload();await page.setViewportSize({width:390,height:844});await navigate(page,'settings');await expect(page.locator('#setting-manager-concurrency')).toHaveValue('1');
    await page.locator('#setting-manager-concurrency').fill('2');await page.locator('#configuration-manager').getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>(await group('manager')).values.concurrency).toBe(2);
  } finally {
    const restored=await page.request.post('/admin/api/operations',{data:{action:'configuration_update',args:{scope:'manager',patch:{concurrency:original.values.concurrency}}}});expect(restored.ok()).toBeTruthy();
  }
});
