import {selectSettingsCategory} from './settings-navigation.mjs';
import {test,expect} from '@playwright/test';
import {overviewFixture,loginOverview} from './overview-fixture.mjs';
import {navigate} from './navigation.mjs';

test('overview service status opens a drawer and concurrency edits open a locked modal',async({page})=>{
  const data=overviewFixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));
  await page.route('**/admin/api/operations',async route=>{
    const body=route.request().postDataJSON();if(body.action!=='runtime_update')return route.continue();
    await gate;Object.assign(data.platform.runtime,body.args);await route.fulfill({json:data.platform.runtime});
  });
  await loginOverview(page);
  await page.getByRole('button',{name:'Codex Runner：查看状态',exact:true}).click();
  const drawer=page.getByRole('dialog');await expect(drawer).toBeVisible();await expect(drawer).toContainText('执行服务已就绪');
  await drawer.getByRole('button',{name:/关闭|Close/}).click();await expect(drawer).not.toBeVisible();
  await page.getByRole('button',{name:'调整并发',exact:true}).click();
  const modal=page.getByRole('dialog');await expect(modal).toBeVisible();await modal.locator('#concurrency').fill('3');
  await modal.getByRole('button',{name:'保存',exact:true}).click();await expect(modal.locator('#concurrency')).toBeDisabled();
  await page.keyboard.press('Escape');await expect(modal).toBeVisible();
  release();await expect(modal).not.toBeVisible();await expect(page.locator('.ops-capacity')).toContainText('3');
});

test('overview rejected concurrency save keeps the draft in its modal',async({page})=>{
  await page.route('**/admin/api/overview',route=>route.fulfill({json:overviewFixture()}));
  await page.route('**/admin/api/operations',route=>route.request().postDataJSON().action==='runtime_update'?route.fulfill({status:409,json:{error:{message:'Synthetic update conflict'}}}):route.continue());
  await loginOverview(page);await page.getByRole('button',{name:'调整并发',exact:true}).click();
  const modal=page.getByRole('dialog');await expect(modal).toBeVisible();await modal.locator('#concurrency').fill('5');await modal.getByRole('button',{name:'保存',exact:true}).click();
  await expect(modal).toContainText('Synthetic update conflict');await expect(modal.locator('#concurrency')).toHaveValue('5');await expect(modal.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
  await page.screenshot({path:'.tmp/admin-overlays/overview-concurrency-modal.png',fullPage:true});
});

test('configuration sections pair short inputs and preserve drafts across category switches',async({page})=>{
  await loginOverview(page);await navigate(page,'settings');
  const form=page.locator('#configuration-manager');
  await expect(form.getByRole('group',{name:'模型设置',exact:true})).toBeVisible();
  const controls=form.getByRole('group',{name:'运行控制',exact:true});await expect(controls).toBeVisible();
  const timeout=page.locator('#setting-manager-timeoutMs'),tool=page.locator('#setting-manager-toolTimeoutMs');
  const [a,b]=await Promise.all([timeout.boundingBox(),tool.boundingBox()]);expect(Math.abs(a.y-b.y)).toBeLessThan(2);expect(b.x).toBeGreaterThan(a.x+a.width);
  await timeout.fill('900001');await selectSettingsCategory(page,'execution');await selectSettingsCategory(page,'manager');await expect(timeout).toHaveValue('900001');
  const label=form.locator('label[for="setting-manager-timeoutMs"]');const labelBox=await label.boundingBox();const inputBox=await timeout.boundingBox();expect(labelBox.x+labelBox.width).toBeLessThanOrEqual(inputBox.x);
  await page.screenshot({path:'.tmp/admin-overlays/settings-desktop.png',fullPage:true});
});

test('configuration groups fit a narrow phone with horizontal labels and full inputs',async({page})=>{
  await page.setViewportSize({width:320,height:740});await loginOverview(page);await navigate(page,'settings');
  const form=page.locator('#configuration-manager');await expect(form.getByRole('group',{name:'运行控制',exact:true})).toBeVisible();
  const positions=await form.evaluate(element=>{const input=element.querySelector('#setting-manager-timeoutMs').getBoundingClientRect(),label=element.querySelector('label[for="setting-manager-timeoutMs"]').getBoundingClientRect();return {input:{x:input.x,right:input.right,width:input.width},label:{right:label.right},overflow:document.documentElement.scrollWidth>window.innerWidth};});
  expect(positions.input.width).toBeGreaterThan(60);expect(positions.label.right).toBeLessThanOrEqual(positions.input.x);expect(positions.input.right).toBeLessThanOrEqual(320);expect(positions.overflow).toBe(false);
  await page.screenshot({path:'.tmp/admin-overlays/settings-mobile.png',fullPage:true});
});
