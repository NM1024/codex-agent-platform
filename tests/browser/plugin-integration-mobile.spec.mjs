import {test,expect} from '@playwright/test';

test('phone schema tables preserve readable column widths with contained horizontal scrolling',async({page})=>{
  await page.setViewportSize({width:390,height:900});
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
  await page.locator('[data-view="plugins"]').click();
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'对接文档',exact:true}).click();
  const drawer=page.getByRole('dialog');await drawer.getByRole('tab',{name:'请求参数',exact:true}).click();
  const table=drawer.getByRole('tabpanel').locator('table').filter({hasText:'约束'}).first();
  for(const cell of await table.locator('th').all())expect((await cell.boundingBox()).width).toBeGreaterThanOrEqual(80);
  expect(await table.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
