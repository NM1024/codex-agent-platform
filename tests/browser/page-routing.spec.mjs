import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
const views=['overview','chat','tasks','plugins','schedules','system','settings'];
async function login(page,path='/admin/'){
 await page.goto(path);await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
}
function selected(page,view){return page.locator(`.console-sidebar [data-view="${view}"]`);}
test('seven pages have shareable addresses that survive refresh and direct opening',async({page})=>{
 await login(page);
 for(const view of views){
  await navigate(page,view);await expect(page).toHaveURL('/admin/'+view);await expect(selected(page,view)).toHaveAttribute('aria-current','page');
  await page.reload();await expect(selected(page,view)).toHaveAttribute('aria-current','page');await expect(page.locator('#workspace')).toBeVisible();
 }
 await page.goto('/admin/tasks');await expect(selected(page,'tasks')).toHaveAttribute('aria-current','page');
 await expect(page.getByText('执行完成不等于所有业务项都成功。查看详情可区分最终结果、具体错误与交付状态。',{exact:true})).toHaveCount(0);
});
test('a page link survives signing in and browser history follows navigation',async({page})=>{
 await login(page,'/admin/tasks');await expect(selected(page,'tasks')).toHaveAttribute('aria-current','page');
 await navigate(page,'plugins');await navigate(page,'settings');
 await page.goBack();await expect(page).toHaveURL('/admin/plugins');await expect(selected(page,'plugins')).toHaveAttribute('aria-current','page');
 await page.goBack();await expect(page).toHaveURL('/admin/tasks');await expect(selected(page,'tasks')).toHaveAttribute('aria-current','page');
 await page.goForward();await expect(selected(page,'plugins')).toHaveAttribute('aria-current','page');
 await navigate(page,'plugins');await page.goBack();await expect(page).toHaveURL('/admin/tasks');
});
test('mobile navigation updates the address and keeps the existing layout',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page);await navigate(page,'tasks');await expect(page).toHaveURL('/admin/tasks');
 await page.reload();await expect(page.locator('#workspace')).toBeVisible();await expect(page.locator('#view')).toContainText('执行记录');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
