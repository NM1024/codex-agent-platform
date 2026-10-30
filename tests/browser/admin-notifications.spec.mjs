import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
const request=async(response)=>{expect(response.ok(),await response.text()).toBeTruthy();return response.json();};
test.beforeEach(async({page})=>{await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();});
test('channel editor groups connection and formatting fields in compact tabs without sending',async({page})=>{
 await navigate(page,'settings');await page.locator('[data-settings-tab="notifications"]').click();await page.getByRole('button',{name:'新增通知渠道',exact:true}).click();const modal=page.getByRole('dialog');
 await expect(modal.getByRole('tab',{name:'基本配置',exact:true})).toBeVisible();await expect(modal.getByLabel('渠道名称',{exact:true})).toBeVisible();await expect(modal.getByLabel('Webhook 地址',{exact:true})).not.toBeVisible();
 await modal.getByRole('tab',{name:'接入与认证',exact:true}).click();await expect(modal.getByLabel('Webhook 地址',{exact:true})).toBeVisible();
 await modal.getByRole('tab',{name:'消息格式',exact:true}).click();await expect(modal.getByLabel('补充格式说明',{exact:true})).toBeVisible();
 await modal.getByRole('button',{name:'保存渠道',exact:true}).click();await expect(modal.getByRole('tab',{name:'基本配置',exact:true})).toHaveAttribute('aria-selected','true');
 await page.setViewportSize({width:390,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await expect(modal.getByRole('button',{name:'保存渠道',exact:true})).toBeInViewport();
});
test('binding dropdown loads concrete configurations on open and saves a new same-provider selection',async({page})=>{
 const type='browser.overlay.notifications';await request(await page.request.post('/admin/api/operations',{data:{action:'plugin_save',args:{definition:{type,name:'Synthetic overlay notifications',instructions:'Synthetic only',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:['notification_context','send_notification']},delivery:{mode:'none'},enabled:false}}}}));
 const first=await request(await page.request.post('/admin/api/notification-channels',{data:{channel:{name:'Synthetic live channel A',provider:'custom',url:'https://example.invalid/a'}}}));
 await navigate(page,'plugins');await page.getByRole('row').filter({hasText:type}).getByRole('button',{name:'配置接入',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByRole('tab',{name:'通知渠道',exact:true}).click();
 const select=modal.getByRole('combobox',{name:'选择通知渠道',exact:true});await expect(select).toBeVisible();
 const second=await request(await page.request.post('/admin/api/notification-channels',{data:{channel:{name:'Synthetic live channel B',provider:'custom',url:'https://example.invalid/b'}}}));
 await select.click();await page.getByRole('option',{name:/Synthetic live channel A/}).click();await page.getByRole('option',{name:/Synthetic live channel B/}).click();await page.keyboard.press('Escape');await modal.getByRole('button',{name:'保存通知绑定',exact:true}).click();
 await expect.poll(async()=>(await request(await page.request.get('/admin/api/plugins/'+type+'/notifications'))).notification_channels).toEqual([first.id,second.id]);
});
