import {test,expect} from '@playwright/test';
const navigate=(page,view)=>page.locator(`[data-view="${view}"]`).click();
async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok()).toBeTruthy();return response.json();
}
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
  await navigate(page,'settings');await page.locator('[data-settings-tab="http_targets"]').click();
});
test('HTTP targets can be configured without JSON editing and tokens stay private across edits and reloads',async({page})=>{
  await page.getByRole('button',{name:'新增 HTTP 目标',exact:true}).click();const modal=page.getByRole('dialog');
  await modal.getByLabel('目标名称',{exact:true}).fill('browser_health');await modal.getByLabel('目标地址',{exact:true}).fill('https://example.invalid/health');
  await modal.getByLabel('访问凭证',{exact:true}).fill('synthetic-browser-http-secret');await modal.getByLabel('超时（毫秒）',{exact:true}).fill('10000');
  await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal).toHaveCount(0);
  const row=page.getByRole('row').filter({hasText:'browser_health'});await expect(row).toContainText('已配置');await expect(row).not.toContainText('synthetic-browser-http-secret');
  const saved=await operation(page,'configuration_get',{scope:'http_targets'});expect(saved.configured_secrets).toContain('/targets/browser_health/token');expect(JSON.stringify(saved)).not.toContain('synthetic-browser-http-secret');
  await row.getByRole('button',{name:'编辑 HTTP 目标：browser_health'}).click();await expect(modal.getByLabel('访问凭证',{exact:true})).toHaveValue('');
  await modal.getByLabel('目标地址',{exact:true}).fill('https://example.invalid/updated');await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal).toHaveCount(0);
  expect((await operation(page,'configuration_get',{scope:'http_targets'})).configured_secrets).toContain('/targets/browser_health/token');
  await page.reload();await navigate(page,'settings');await page.locator('[data-settings-tab="http_targets"]').click();
  await row.getByRole('button',{name:'编辑 HTTP 目标：browser_health'}).click();await modal.getByRole('checkbox',{name:'清除已保存凭证',exact:true}).check();
  await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal).toHaveCount(0);
  expect((await operation(page,'configuration_get',{scope:'http_targets'})).configured_secrets).not.toContain('/targets/browser_health/token');
  await row.getByRole('button',{name:'删除 HTTP 目标：browser_health'}).click();await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(row).toHaveCount(0);
});

test('HTTP target drafts survive a conflict and stale writes cannot overwrite an Agent edit',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'新增 HTTP 目标',exact:true}).click();
  let modal=page.getByRole('dialog');await modal.getByLabel('目标名称',{exact:true}).fill('browser_conflict');await modal.getByLabel('目标地址',{exact:true}).fill('https://example.invalid/original');
  await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal).toHaveCount(0);
  const row=page.getByRole('row').filter({hasText:'browser_conflict'});await row.getByRole('button',{name:'编辑 HTTP 目标：browser_conflict'}).click();
  modal=page.getByRole('dialog');await modal.getByLabel('目标地址',{exact:true}).fill('https://example.invalid/human-draft');
  const current=await operation(page,'configuration_get',{scope:'http_targets'});
  await operation(page,'configuration_update',{scope:'http_targets',revision:current.revision,patch:{targets:{...current.values.targets,browser_conflict:{url:'https://example.invalid/agent-edit'}}}});
  await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal.getByRole('alert')).toContainText('配置已被其他操作更新');
  await expect(modal.getByLabel('目标地址',{exact:true})).toHaveValue('https://example.invalid/human-draft');
  expect((await operation(page,'configuration_get',{scope:'http_targets'})).values.targets.browser_conflict.url).toBe('https://example.invalid/agent-edit');
  await modal.getByRole('button',{name:'取消',exact:true}).click();await row.getByRole('button',{name:'编辑 HTTP 目标：browser_conflict'}).click();
  await expect(modal.getByLabel('目标地址',{exact:true})).toHaveValue('https://example.invalid/agent-edit');await modal.getByRole('button',{name:'取消',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('HTTP target saves validate locally, lock duplicate requests, retain failed drafts and fit English phone layouts',async({page})=>{
  await page.getByRole('button',{name:'新增 HTTP 目标',exact:true}).click();const modal=page.getByRole('dialog');
  await modal.getByLabel('目标名称',{exact:true}).fill('browser_busy');await modal.getByLabel('目标地址',{exact:true}).fill('javascript:invalid');
  await modal.getByRole('button',{name:'保存目标',exact:true}).click();await expect(modal).toContainText('请填写完整的 HTTPS 地址');
  await modal.getByLabel('目标地址',{exact:true}).fill('https://example.invalid/'+('long-path-'.repeat(15)));await modal.getByLabel('访问凭证',{exact:true}).fill('synthetic-failed-draft');
  let count=0,release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/operations',async route=>{
    const request=route.request().postDataJSON();if(request?.action!=='configuration_update'||request?.args?.scope!=='http_targets')return route.continue();
    count++;if(count===1){await gate;return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_HTTP_SAVE_FAILURE',message:'Synthetic HTTP save failure'}}});}return route.continue();
  });
  const save=modal.getByRole('button',{name:'保存目标',exact:true});await save.evaluate(button=>{button.click();button.click();});
  await expect(save).toHaveClass(/ant-btn-loading/);await expect(modal.getByRole('button',{name:'取消',exact:true})).toBeDisabled();expect(count).toBe(1);
  release();await expect(modal.getByRole('alert')).toContainText('Synthetic HTTP save failure');await expect(modal.getByLabel('访问凭证',{exact:true})).toHaveValue('synthetic-failed-draft');
  await save.click();await expect(modal).toHaveCount(0);expect(count).toBe(2);
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible').getByText('English',{exact:true}).click();
  const row=page.getByRole('row').filter({hasText:'browser_busy'});await expect(row).toContainText('Configured');
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await row.getByRole('button',{name:'Edit HTTP target: browser_busy'}).click();await expect(modal.getByLabel('Access credential',{exact:true})).toHaveValue('');
  await expect(modal).toBeVisible();await expect(modal.getByLabel('Target URL',{exact:true})).toBeVisible();
  await expect.poll(async()=>{const box=await modal.boundingBox();return !!box&&box.x>=0&&box.x+box.width<=391&&box.y>=0&&box.y<500;}).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:'.tmp/http-target-phone.png',animations:'disabled'});
  await modal.getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/http-target-desktop.png',animations:'disabled'});
});
