import {test,expect} from '@playwright/test';
import {overviewFixture,loginOverview} from './overview-fixture.mjs';

test('collection distinguishes paused blocked and unknown states and never guesses missing counts',async({page})=>{
  const data=overviewFixture();await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));await loginOverview(page);
  await expect(page.locator('#dispatch-title')).toHaveText('任务领取中');
  data.platform.runtime.paused=true;data.platform.runner.ready=false;data.platform.runner.reason='CHATGPT_LOGIN_REQUIRED';
  await page.reload();await expect(page.locator('#dispatch-title')).toHaveText('领取已暂停');await expect(page.getByRole('button',{name:'恢复领取',exact:true})).toBeEnabled();
  data.platform.runtime.paused=false;await page.reload();await expect(page.locator('#dispatch-title')).toHaveText('领取受阻');
  await page.getByRole('button',{name:'查看原因',exact:true}).click();const drawer=page.getByRole('dialog');await expect(drawer).toContainText('CHATGPT_LOGIN_REQUIRED');
  const details=page.locator('[data-service="runner"] button[aria-expanded]');await expect(details).toHaveAttribute('aria-expanded','true');await drawer.getByRole('button',{name:/关闭|Close/}).click();await expect(drawer).not.toBeVisible();await expect(details).toHaveAttribute('aria-expanded','false');
  data.platform={unavailable:true,error:{message:'Synthetic gateway unavailable'}};await page.reload();await expect(page.locator('#dispatch-title')).toHaveText('状态未获取');
  await expect(page.getByRole('button',{name:'暂停领取',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'调整并发',exact:true})).toBeDisabled();
  for(const counter of await page.locator('[data-task-count] .ops-task-number').all())await expect(counter).toHaveText('—');
  await expect(page.locator('[data-service="gateway"]')).toContainText('服务不可达');
});

test('polling preserves concurrency drafts, rejects fractions and confirms Runner restart',async({page})=>{
  const data=overviewFixture(),calls=[];await page.clock.install();
  await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));
  await page.route('**/admin/api/operations',async route=>{const body=route.request().postDataJSON();if(!['runtime_update','service_restart'].includes(body.action))return route.continue();calls.push(body);if(body.action==='runtime_update')Object.assign(data.platform.runtime,body.args);await route.fulfill({json:{accepted:true}});});
  await loginOverview(page);await page.getByRole('button',{name:'调整并发',exact:true}).click();await page.locator('#concurrency').fill('3');
  data.platform.runtime.concurrency=12;await page.clock.fastForward(10001);await expect(page.locator('.ops-capacity')).toContainText('12');await expect(page.locator('#concurrency')).toHaveValue('3');
  await page.locator('#concurrency').fill('2.5');await expect(page.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  await page.locator('#concurrency').fill('3');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.ops-capacity')).toContainText('3');
  await expect(page.locator('[data-task-count="running"]')).toContainText('4');await expect(page.locator('[data-task-count="running"]')).toContainText('/ 3');
  await page.getByRole('button',{name:'重启 Runner',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(calls.filter(c=>c.action==='service_restart')).toHaveLength(0);
  await page.getByRole('button',{name:'取消',exact:true}).click();expect(calls.filter(c=>c.action==='service_restart')).toHaveLength(0);
  await page.getByRole('button',{name:'重启 Runner',exact:true}).click();await page.getByRole('button',{name:'确认重启',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(calls.filter(c=>c.action==='service_restart')).toHaveLength(1);
});

test('failed refresh marks snapshot stale, disables mutations and recovers explicitly',async({page})=>{
  const data=overviewFixture();let fail=false;await page.clock.install();
  await page.route('**/admin/api/overview',route=>fail?route.fulfill({status:503,json:{error:{message:'Synthetic refresh failure'}}}):route.fulfill({json:data}));await loginOverview(page);
  fail=true;await page.clock.fastForward(10001);await expect(page.locator('.ops-alert')).toContainText('数据更新失败');
  await expect(page.locator('#dispatch-title')).toHaveText('状态未获取');await expect(page.getByRole('button',{name:'暂停领取',exact:true})).toBeDisabled();await expect(page.locator('[data-resource="host-memory"]')).toContainText('12.4 GiB');
  fail=false;await page.locator('.ops-alert').getByRole('button',{name:'重试',exact:true}).click();await expect(page.locator('#dispatch-title')).toHaveText('任务领取中');await expect(page.locator('.ops-alert')).toHaveCount(0);
});

test('slow overview reads can settle without being replaced by every polling interval',async({page})=>{
  await page.clock.install();let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/overview',async route=>{calls++;await gate;await route.fulfill({json:overviewFixture()});});
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('.page-loading')).toBeVisible();
  await expect.poll(()=>calls).toBe(1);await page.clock.fastForward(25000);expect(calls).toBe(1);release();await expect(page.locator('#dispatch-title')).toHaveText('任务领取中');
});

test('pending concurrency save cannot be hidden and reopened to bypass its write lock',async({page})=>{
  const data=overviewFixture();let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));
  await page.route('**/admin/api/operations',async route=>{const body=route.request().postDataJSON();if(body.action!=='runtime_update')return route.continue();calls++;await gate;Object.assign(data.platform.runtime,body.args);await route.fulfill({json:data.platform.runtime});});
  await loginOverview(page);await page.getByRole('button',{name:'调整并发',exact:true}).click();await page.locator('#concurrency').fill('3');await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'收起设置',exact:true})).toBeDisabled();await expect(page.locator('#concurrency')).toBeDisabled();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'保存',exact:true}).dispatchEvent('click');expect(calls).toBe(1);release();await expect(page.locator('.ops-capacity')).toContainText('3');
});


test('a late ordinary poll cannot replace the newer post-save snapshot',async({page})=>{
  const data=overviewFixture();let reads=0,release;const gate=new Promise(resolve=>{release=resolve;});await page.clock.install();
  await page.route('**/admin/api/overview',async route=>{const snapshot=structuredClone(data);reads++;if(reads===2)await gate;await route.fulfill({json:snapshot});});
  await page.route('**/admin/api/operations',async route=>{const body=route.request().postDataJSON();if(body.action!=='runtime_update')return route.continue();Object.assign(data.platform.runtime,body.args);await route.fulfill({json:data.platform.runtime});});
  await loginOverview(page);await page.clock.fastForward(10001);await expect.poll(()=>reads).toBe(2);
  await page.getByRole('button',{name:'调整并发',exact:true}).click();await page.locator('#concurrency').fill('9');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.ops-capacity')).toContainText('9');
  const finished=page.waitForResponse(response=>response.url().endsWith('/admin/api/overview'));release();await finished;await page.clock.fastForward(100);await expect(page.locator('.ops-capacity')).toContainText('9');
});
