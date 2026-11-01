import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
async function operation(page,action,args={}){const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok(),await response.text()).toBeTruthy();return response.json();}
test.beforeEach(async({page})=>{await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();});
test('scheduled execution history shows real records and investigation starts only after confirmation',async({page})=>{
 const plan=await operation(page,'schedule_save',{schedule:{name:'Synthetic notification history plan',kind:'inspection',message:'Synthetic inspection only',cron:'0 9 * * *',timezone:'Asia/Shanghai',enabled:false}});
 const response=await page.request.post('/admin/api/__fixture/notification-inspection',{data:{schedule_id:plan.id}});expect(response.ok()).toBeTruthy();const execution=await response.json();
 await navigate(page,'tasks');await page.getByRole('tab',{name:'定时任务',exact:true}).click();const row=page.getByRole('row').filter({hasText:execution.id});await expect(row).toContainText(plan.name);
 await row.getByRole('button',{name:'详情',exact:true}).click();const drawer=page.getByRole('dialog',{name:/定时执行详情/});await expect(drawer).toContainText('Synthetic inspection only');await expect(drawer.getByRole('combobox')).toHaveCount(0);await expect(drawer.getByRole('button',{name:'保存通知绑定',exact:true})).toHaveCount(0);await expect(drawer).not.toContainText('保存绑定不会发送消息');await drawer.locator('.ant-drawer-close').click();
 const investigations=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/admin/api/conversations')investigations.push(request.postDataJSON());});
 await row.getByRole('button',{name:'调查',exact:true}).click();const confirmation=page.getByRole('dialog',{name:'确认调查',exact:true});await expect(confirmation).toBeVisible();expect(investigations).toEqual([]);await confirmation.getByRole('button',{name:'取消',exact:true}).click();expect(investigations).toEqual([]);
 await row.getByRole('button',{name:'调查',exact:true}).click();await confirmation.getByRole('button',{name:'开始调查',exact:true}).click();await expect(page.locator('.chat-main')).toBeVisible();expect(investigations).toHaveLength(1);expect(investigations[0]).toMatchObject({schedule_execution_id:execution.id,investigate:true});
});
