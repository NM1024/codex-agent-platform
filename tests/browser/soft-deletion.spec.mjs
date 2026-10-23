import {test,expect} from '@playwright/test';
const definition={type:'delete.browser',name:'待删除测试业务',instructions:'Return the supplied object.',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}};
const navigate=(page,view)=>page.locator(`[data-view="${view}"]`).click();
async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});
  expect(response.ok()).toBeTruthy();return response.json();
}
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();
});

test('plugin deletion confirms first, preserves task history and disables its dependent schedule',async({page})=>{
  await operation(page,'plugin_save',{definition});
  await page.request.post('/admin/api/plugins/'+definition.type+'/connection',{data:{entryKey:'synthetic-browser-delete-key-123456789'}});
  await operation(page,'plugin_enable',{type:definition.type,enabled:true});
  const task=await operation(page,'submit_task',{type:definition.type,input:{text:'Synthetic retained task'}});
  const plan=await operation(page,'schedule_save',{schedule:{name:'删除插件关联计划',kind:'task',type:definition.type,input:{},cron:'0 9 * * *'}});
  await navigate(page,'plugins');const row=page.getByRole('row').filter({hasText:definition.type});
  await row.getByRole('button',{name:'删除业务插件：'+definition.name}).click();
  const modal=page.getByRole('dialog',{name:'逻辑删除'});
  await expect(modal).toContainText('历史任务和结果保留');
  await modal.getByRole('button',{name:'取消',exact:true}).click();await expect(row).toBeVisible();
  await row.getByRole('button',{name:'删除业务插件：'+definition.name}).click();
  await modal.getByRole('button',{name:'删除',exact:true}).click();await expect(row).toHaveCount(0);
  expect((await operation(page,'task',{task_id:task.task_id})).task_id).toBe(task.task_id);
  const paused=(await operation(page,'schedules')).find(item=>item.id===plan.id);expect(paused.enabled).toBe(false);expect(paused.blocked_reason).toBe('PLUGIN_DELETED');
  await page.reload();await navigate(page,'plugins');await expect(page.getByRole('row').filter({hasText:definition.type})).toHaveCount(0);
});

test('schedule deletion has independent pending/error state and can retry on a narrow screen',async({page})=>{
  const saved=await operation(page,'schedule_save',{schedule:{name:'删除失败重试计划',kind:'inspection',message:'Synthetic inspection',cron:'0 9 * * *',enabled:false}});
  await page.setViewportSize({width:390,height:844});await navigate(page,'schedules');
  const row=page.getByRole('row').filter({hasText:saved.name});
  await row.getByRole('button',{name:'删除定时计划：'+saved.name}).click();
  const modal=page.getByRole('dialog',{name:'逻辑删除'});let attempts=0,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/operations',async route=>{
    if(route.request().postDataJSON()?.action!=='schedule_delete')return route.continue();
    attempts++;if(attempts===1){await blocked;await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_DELETE_FAILURE',message:'Synthetic delete failure'}}});}else await route.continue();
  });
  const remove=modal.getByRole('button',{name:'删除',exact:true});await remove.click();
  await expect(remove).toHaveClass(/ant-btn-loading/);await expect(modal.getByRole('button',{name:'取消',exact:true})).toBeDisabled();
  expect(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  release();await expect(modal.getByRole('alert')).toContainText('Synthetic delete failure');await expect(row).toBeVisible();
  await remove.click();await expect(modal).toHaveCount(0);await expect(row).toHaveCount(0);expect(attempts).toBe(2);
  expect((await operation(page,'schedules')).some(item=>item.id===saved.id)).toBe(false);
});
