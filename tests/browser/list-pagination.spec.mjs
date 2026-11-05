import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
test.use({locale:'zh-CN'});
async function setup(page){
  await page.route('**/admin/api/tasks?*',route=>{
    const query=new URL(route.request().url()).searchParams,total=query.get('search')?5:127,limit=Number(query.get('limit')??50),offset=Number(query.get('offset')??0);
    const items=Array.from({length:Math.max(0,Math.min(limit,total-offset))},(_,n)=>({task_id:`11111111-1111-4111-8111-${String(offset+n+1).padStart(12,'0')}`,type:'synthetic.pagination',request_id:'synthetic-'+(offset+n),status:'completed',error:null,created_at:1700000000000,updated_at:1700000000000}));
    return route.fulfill({json:query.get('include_total')==='1'?{items,total}:items});
  });
  await page.route('**/admin/api/schedule-runs?*',route=>{
    const query=new URL(route.request().url()).searchParams,total=127,limit=Number(query.get('limit')??50),offset=Number(query.get('offset')??0);
    const items=Array.from({length:Math.max(0,Math.min(limit,total-offset))},(_,n)=>({id:`22222222-2222-4222-8222-${String(offset+n+1).padStart(12,'0')}`,schedule_id:'33333333-3333-4333-8333-333333333333',schedule_name:'Synthetic schedule',kind:'inspection',status:'completed',error:null,created_at:1700000000000}));
    return route.fulfill({json:query.get('include_total')==='1'?{items,total}:items});
  });
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();
}
async function size(page,pager,count){
  await pager.getByRole('combobox',{name:'每页条数',exact:true}).click();
  await page.locator('.ant-select-dropdown:visible').getByText(`${count} 条/页`,{exact:true}).click();
}
test('record pages share totals, adjustable sizes, last-page controls and phone layout',async({page})=>{
  await setup(page);await navigate(page,'tasks');
  for(const [index,id] of ['task-pagination','schedule-run-pagination'].entries()){
    if(index)await page.getByRole('tab',{name:'定时任务',exact:true}).click();
    const pager=page.locator('#'+id);await expect(pager).toHaveClass(/list-pagination/);await expect(pager).toContainText('共 127 条');
    await expect(pager.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
    await size(page,pager,100);await expect(page.locator('.ant-table-tbody > tr.ant-table-row')).toHaveCount(100);
    await pager.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.ant-table-tbody > tr.ant-table-row')).toHaveCount(27);
    await expect(pager).toContainText('第 2 页');await expect(pager).toContainText('共 127 条');await expect(pager.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
    await size(page,pager,10);await expect(pager).toContainText('第 1 页');await expect(page.locator('.ant-table-tbody > tr.ant-table-row')).toHaveCount(10);
    await pager.scrollIntoViewIfNeeded();
    await page.screenshot({path:`.tmp/inspection-handoff/${id}-1440.png`,animations:'disabled'});
    await page.setViewportSize({width:320,height:760});
    await pager.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({path:`.tmp/inspection-handoff/${id}-320.png`,animations:'disabled'});
    await page.setViewportSize({width:1440,height:1000});
  }
});
