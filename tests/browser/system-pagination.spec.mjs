import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const rows=page=>page.locator('#system-records .ant-table-tbody > tr.ant-table-row');
const pager=page=>page.locator('#system-pagination');
async function pageSize(page,size){
 await pager(page).getByRole('combobox',{name:'每页条数',exact:true}).click();
 await page.locator('.ant-select-dropdown:visible').getByText(`${size} 条/页`,{exact:true}).click();
}
async function source(page,service,available){
 expect((await page.request.post('/admin/api/__fixture/system-source',{data:{service,available}})).ok()).toBeTruthy();
}
test.beforeEach(async({page})=>{
 // The lazy header records the running version. Seed after that read finishes
 // so its work/event do not race with the exact synthetic record counts.
 const version=page.waitForResponse(response=>new URL(response.url()).pathname==='/admin/api/version'&&response.ok());
 await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
 await expect(page.locator('#workspace')).toBeVisible();await version;await page.request.post('/admin/api/__fixture/system-reset',{data:{}});
});

test('system pager counts the full filtered set and resets its cursor when page size changes',async({page})=>{
 const queries=[];page.on('request',request=>{if(request.url().endsWith('/admin/api/operations')&&request.method()==='POST'){
  const body=request.postDataJSON();if(body.action==='system_issue'&&!body.args?.id)queries.push(body.args);
 }});
 await navigate(page,'system');await expect(rows(page)).toHaveCount(20);await expect(pager(page)).toContainText('共 25 条');
 await pager(page).getByRole('button',{name:'下一页',exact:true}).click();await expect(rows(page)).toHaveCount(5);await expect(pager(page)).toContainText('第 2 页');await expect(pager(page)).toContainText('共 25 条');
 await pageSize(page,10);await expect(rows(page)).toHaveCount(10);await expect(pager(page)).toContainText('第 1 页');await expect(pager(page).getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
 await pager(page).getByRole('button',{name:'下一页',exact:true}).click();await expect(pager(page)).toContainText('第 2 页');
 await pageSize(page,50);await expect(rows(page)).toHaveCount(25);await expect(pager(page)).toContainText('第 1 页');await expect(pager(page).getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 await pageSize(page,100);await expect(rows(page)).toHaveCount(25);await expect(pager(page)).toContainText('共 25 条');
 await pageSize(page,20);await expect(rows(page)).toHaveCount(20);
 await pager(page).scrollIntoViewIfNeeded();await page.screenshot({path:'.tmp/inspection-handoff/system-pagination-1440.png',animations:'disabled'});
 await page.setViewportSize({width:320,height:760});await pager(page).scrollIntoViewIfNeeded();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
 await page.screenshot({path:'.tmp/inspection-handoff/system-pagination-320.png',animations:'disabled'});
 expect(queries.length).toBeGreaterThan(4);expect(queries.every(query=>query.include_total===true&&query.limit<=100)).toBeTruthy();
 expect(queries.filter(query=>[50,100].includes(query.limit)).every(query=>!query.cursor)).toBeTruthy();
});

test('system tabs and submitted filters reset page position and show matching totals',async({page})=>{
 await navigate(page,'system');await expect(pager(page)).toContainText('共 25 条');await pageSize(page,10);await expect(rows(page)).toHaveCount(10);
 await pager(page).getByRole('button',{name:'下一页',exact:true}).click();await expect(pager(page)).toContainText('第 2 页');
 await page.getByRole('tab',{name:'后台工作',exact:true}).click();await expect(pager(page)).toContainText('第 1 页');await expect(pager(page)).toContainText('共 27 条');await expect(rows(page)).toHaveCount(10);
 await pager(page).getByRole('button',{name:'下一页',exact:true}).click();await expect(pager(page)).toContainText('第 2 页');
 await page.locator('#system-search').fill('manager:work:permissions');await page.locator('#system-query').click();
 await expect(rows(page)).toHaveCount(1);await expect(pager(page)).toContainText('共 1 条');await expect(pager(page)).toContainText('第 1 页');
 await page.getByRole('tab',{name:'系统日志',exact:true}).click();await expect(pager(page)).toContainText('第 1 页');await expect(pager(page)).toContainText('共 30 条');await expect(rows(page)).toHaveCount(10);
 await page.getByRole('tab',{name:'待处理问题',exact:true}).click();await expect(pager(page)).toContainText('共 25 条');
 await page.locator('#system-search').fill('%');await page.locator('#system-query').click();await expect(rows(page)).toHaveCount(0);await expect(pager(page)).toContainText('共 0 条');
 await expect(page.locator('#system-page')).not.toContainText('当前状态游标分页');
});

test('source outages keep evidence warnings and display an unavailable total until recovery',async({page})=>{
 await navigate(page,'system');await expect(pager(page)).toContainText('共 25 条');
 await source(page,'manager',false);await page.locator('#system-refresh').click();
 await expect(pager(page)).toContainText('总条数暂不可用');await expect(pager(page)).not.toContainText('共 0 条');
 await expect(page.locator('#system-page')).toContainText('部分来源不可用');await expect(page.locator('#system-page')).toContainText('数据可能过期');
 await expect(page.locator('#system-sources .system-source-unavailable')).toContainText('Manager');
 await expect(page.locator('#system-records')).toContainText('manager:work:page-');
 await expect(pager(page).getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 await source(page,'manager',true);await page.locator('#system-refresh').click();
 await expect(pager(page)).toContainText('共 25 条');await expect(pager(page)).not.toContainText('总条数暂不可用');
 await expect(page.locator('#system-page')).not.toContainText('数据可能过期');await expect(rows(page)).toHaveCount(20);
});
