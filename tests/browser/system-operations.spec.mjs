import sharp from 'sharp';
import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
const op=async(page,action,args={})=>{const r=await page.request.post('/admin/api/operations',{data:{action,args}});expect(r.ok()).toBeTruthy();return r.json();};
async function choose(page,id,text){await page.locator(id).click();const dropdown=page.locator('.ant-select-dropdown:visible');await dropdown.getByText(text,{exact:true}).click();}
async function search(page,text){await page.locator('#system-search').fill(text);await page.locator('#system-query').click();}
const rows=page=>page.locator('#system-records .ant-table-tbody > tr.ant-table-row');
const availability=async(page,service,available)=>{expect((await page.request.post('/admin/api/__fixture/system-source',{data:{service,available}})).ok()).toBeTruthy();};
async function openWork(page,id){await search(page,id);await rows(page).first().getByRole('button',{name:'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText(id);}
test.beforeEach(async({page})=>{
 await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();
 await page.request.post('/admin/api/__fixture/system-reset',{data:{}});
});

test('real system tabs, literal search, independent resolution filters and bounded keyset pages',async({page})=>{
 await navigate(page,'system');await expect(rows(page)).toHaveCount(20);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('#system-pagination')).toContainText('2');expect(await rows(page).count()).toBeGreaterThan(0);
 await choose(page,'#system-service','Gateway');await choose(page,'#system-module','配置同步');await choose(page,'#system-range','最近 24 小时');await page.locator('#system-query').click();await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('gateway:work:configuration');
 await choose(page,'#system-service','全部服务');await choose(page,'#system-module','全部模块');await search(page,'权限');await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('EACCES');await expect(page.locator('#system-pagination')).toContainText('1');
 await openWork(page,'manager:work:permissions');await expect(page.locator('#system-detail')).toContainText('尝试次数');await expect(page.locator('#system-detail')).toContainText('最近成功');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await search(page,'%');await expect(rows(page)).toHaveCount(0);await expect(page.locator('#system-records')).toContainText('没有匹配的记录');
 await page.getByRole('tab',{name:'后台工作',exact:true}).click();await search(page,'runner:work:stale');await expect(rows(page)).toContainText('需要核验');await expect(rows(page)).toContainText('无进展');
 await page.getByRole('tab',{name:'待处理问题',exact:true}).click();await choose(page,'#system-resolution','已恢复');await search(page,'runner:work:recovered-idle');await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('空闲');await rows(page).getByRole('button',{name:'详情',exact:true}).click();await expect(page.locator('#system-detail')).not.toContainText('无进展');await page.screenshot({path:'.tmp/system-recovered-detail.png',fullPage:true});await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('tab',{name:'系统日志',exact:true}).click();await choose(page,'#system-level','错误');await search(page,'权限');expect(await rows(page).count()).toBeGreaterThan(0);await rows(page).first().getByRole('button',{name:'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('最近出现');await expect(page.locator('#system-detail')).toContainText('首次出现');
});

test('partial sources, collection timestamps and failed refresh preserve visible stale evidence',async({page})=>{
 await page.request.post('/admin/api/__fixture/system-source',{data:{available:false}});await navigate(page,'system');
 await expect(page.locator('#system-page')).toContainText('部分来源不可用');await expect(page.locator('#system-sources')).toContainText('Runner');await expect(page.locator('#system-metrics')).toContainText('仅可用来源');
 await expect(rows(page)).toHaveCount(20);let fail=true;
 await page.route('**/admin/api/operations',async route=>fail&&route.request().postDataJSON()?.action?.startsWith('system_')?route.fulfill({status:503,json:{error:{code:'SYSTEM_SOURCE_UNAVAILABLE'}}}):route.continue());
 await page.locator('#system-refresh').click();await expect(page.locator('#system-page')).toContainText('数据可能过期');await expect(rows(page)).toHaveCount(20);
 fail=false;await page.locator('#system-refresh').click();await expect(page.locator('#system-page')).not.toContainText('数据可能过期');
 await search(page,'does-not-exist');await expect(page.locator('#system-page')).toContainText('部分来源不可用');await expect(rows(page)).toHaveCount(0);
});

test('HTTP 200 owner outages retain list and drawer evidence with latest failure metadata and recover authoritatively',async({page})=>{
 await navigate(page,'system');await page.getByRole('tab',{name:'后台工作',exact:true}).click();await openWork(page,'runner:work:stale');
 await availability(page,'runner',false);
 const response=page.waitForResponse(r=>r.url().endsWith('/admin/api/operations')&&r.request().postDataJSON()?.args?.id==='runner:work:stale');
 await page.locator('#system-detail').getByRole('button',{name:'重新读取详情',exact:true}).click();const failure=await response;expect(failure.status()).toBe(200);const failureAt=(await failure.json()).sources[0].observed_at;
 await expect(page.locator('#system-detail')).toContainText('数据可能过期');await expect(page.locator('#system-detail')).toContainText('记录版本');
 await expect(page.locator('#system-detail')).not.toContainText('找不到工作');await expect(page.locator('#system-detail .system-source-unavailable')).toContainText('SYSTEM_SOURCE_UNAVAILABLE');
 await expect(page.locator('#system-detail .system-source-unavailable time')).toHaveAttribute('datetime',new Date(failureAt).toISOString());
 await expect(page.locator('#system-detail').getByRole('button',{name:'交给管理 Agent',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'关闭',exact:true}).click();const listResponse=page.waitForResponse(r=>r.url().endsWith('/admin/api/operations')&&r.request().postDataJSON()?.action==='system_work');await page.locator('#system-refresh').click();
 const listFailure=await listResponse;expect(listFailure.status()).toBe(200);const latestRunner=(await listFailure.json()).sources.find(source=>source.service==='runner');
 await expect(page.locator('#system-sources .system-source-unavailable time')).toHaveAttribute('datetime',new Date(latestRunner.observed_at).toISOString());expect(latestRunner.observed_at).toBeGreaterThanOrEqual(failureAt);
 await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('数据可能过期');await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 await availability(page,'all',false);await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(1);await expect(page.locator('#system-metrics strong')).toHaveText(['—','—','—','—']);
 await rows(page).first().getByRole('button',{name:'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('记录版本');await page.locator('#system-detail').getByRole('button',{name:'重新读取详情',exact:true}).click();
 await expect(page.locator('#system-detail')).toContainText('数据可能过期');await expect(page.locator('#system-detail')).toContainText('记录版本');await expect(page.locator('#system-detail').getByRole('button',{name:'交给管理 Agent',exact:true})).toBeDisabled();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await search(page,'gateway:work:configuration');await expect(rows(page)).toHaveCount(0);await expect(page.locator('#system-records')).not.toContainText('没有匹配的记录');
 await availability(page,'all',true);await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('gateway:work:configuration');
 await openWork(page,'runner:work:stale');await expect(page.locator('#system-detail')).not.toContainText('数据可能过期');
 await page.request.post('/admin/api/__fixture/system-remove',{data:{id:'runner:work:stale'}});await page.locator('#system-detail').getByRole('button',{name:'重新读取详情',exact:true}).click();
 await expect(page.locator('#system-detail')).toContainText('找不到工作');await expect(page.locator('#system-detail')).not.toContainText('记录版本');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(0);await expect(page.locator('#system-records')).toContainText('没有匹配的记录');
});

test('initial all-source HTTP 200 outage shows unavailable evidence and recovery rather than healthy zero counts',async({page})=>{
 await availability(page,'all',false);await navigate(page,'system');await expect(page.locator('#system-sources .system-source-unavailable')).toHaveCount(3);
 await expect(page.locator('#system-metrics strong')).toHaveText(['—','—','—','—']);await expect(rows(page)).toHaveCount(0);await expect(page.locator('#system-records')).not.toContainText('没有匹配的记录');
 await availability(page,'gateway',true);await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(1);await expect(page.locator('#system-metrics')).toContainText('仅可用来源');
 await expect(page.locator('#system-metrics strong').first()).toHaveText('1');await availability(page,'all',true);await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(20);
});

test('one management entry locks duplicate clicks and does not execute maintenance or classify on handoff',async({page})=>{
 let starts=0,mutations=0;
 await page.route('**/admin/api/operations',async route=>{if(['system_maintain','system_issue_draft'].includes(route.request().postDataJSON()?.action))mutations++;await route.continue();});
 await page.route('**/admin/api/conversations',async route=>{if(route.request().method()==='POST'){starts++;expect(route.request().postDataJSON()).toEqual({system_reference:{id:'gateway:work:configuration'}});await new Promise(r=>setTimeout(r,150));}await route.continue();});
 await navigate(page,'system');await openWork(page,'gateway:work:configuration');const before=(await op(page,'system_issue',{id:'gateway:work:configuration'})).work;
 await expect(page.locator('#system-detail .system-detail-actions button')).toHaveCount(2);
 const button=page.locator('#system-detail').getByRole('button',{name:'交给管理 Agent',exact:true});await button.evaluate(el=>{el.click();el.click();});
 await expect(page.locator('#messages .message.user')).toContainText('gateway:work:configuration');expect(starts).toBe(1);expect(mutations).toBe(0);
 const {age_ms,progress_age_ms,...storedBefore}=before;expect((await op(page,'system_issue',{id:before.id})).work).toMatchObject(storedBefore);
});

test('diagnostic work has the same two actions and related logs remain a read-only view',async({page})=>{
 await navigate(page,'system');await openWork(page,'manager:work:defect');await expect(page.locator('#system-detail .system-detail-actions button')).toHaveCount(2);
 const before=(await op(page,'system_issue',{id:'manager:work:defect'})).work;
 await page.locator('#system-detail').getByRole('button',{name:'查看关联日志',exact:true}).click();await expect(page.getByRole('tab',{name:'系统日志',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(rows(page)).not.toHaveCount(0);for(const row of await rows(page).all())await expect(row).toContainText('HANDOFF_FAILED');
 const after=(await op(page,'system_issue',{id:before.id})).work;expect(after.revision).toBe(before.revision);expect(after.state).toBe(before.state);expect(after.classification).toBe(before.classification);
});

test('explicit Agent management creates a fresh conversation and preserves unrelated composer text and image',async({page})=>{
 await navigate(page,'chat');await page.locator('#message-input').fill('Unrelated synthetic unsent composer text');
 await page.locator('input[type=file][accept*="image"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:await sharp({create:{width:32,height:32,channels:3,background:'#a2bdad'}}).png().toBuffer()});
 await expect(page.locator('.chat-image-drafts')).toContainText('synthetic.png');
 let starts=0;await page.route('**/admin/api/conversations',async route=>{if(route.request().method()==='POST')starts++;await route.continue();});
 await navigate(page,'system');await page.locator('#system-refresh').click();expect(starts).toBe(0);
 await search(page,'manager:work:permissions');await rows(page).first().getByRole('button',{name:'交给管理 Agent',exact:true}).click();await expect(page.locator('#message-input')).toHaveValue('Unrelated synthetic unsent composer text');
 await expect(page.locator('#messages .message.user')).toContainText('manager:work:permissions');await expect(page.locator('#messages .message.user')).toContainText('system_issue');await expect(page.locator('#messages .message.user')).not.toContainText('Unrelated synthetic');expect(starts).toBe(1);
 await expect(page.locator('.chat-compose')).toContainText('synthetic.png');
});

test('Chinese and English system UI fits 320px and detail scroll stays inside the drawer',async({page})=>{
 test.setTimeout(60000);
 await navigate(page,'system');await expect(rows(page)).toHaveCount(20);await page.screenshot({path:'.tmp/system-operations/desktop-zh.png',animations:'disabled'});
 for(const locale of ['zh-CN','en']){
  if(locale==='en')await choose(page,'#app-language','English');
  await page.setViewportSize({width:320,height:844});
  for(const name of locale==='en'?['Issues','Background work','System logs']:['待处理问题','后台工作','系统日志']){
   await page.getByRole('tab',{name,exact:true}).click();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);await expect(page.locator('#system-refresh')).toBeVisible();
  }
  await page.locator('.console-content').evaluate(element=>element.scrollTop=0);await page.screenshot({path:'.tmp/system-operations/mobile-'+locale+'.png',animations:'disabled'});
  await rows(page).first().getByRole('button',{name:locale==='en'?'Details':'详情',exact:true}).click();await expect(page.locator('#system-detail')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);await page.screenshot({path:'.tmp/system-operations/drawer-'+locale+'.png',animations:'disabled'});
  await page.getByRole('button',{name:locale==='en'?'Close':'关闭',exact:true}).click();
  await page.getByRole('tab',{name:locale==='en'?'Background work':'后台工作',exact:true}).click();await rows(page).first().getByRole('button',{name:locale==='en'?'Details':'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText(locale==='en'?'Attempts':'尝试次数');
  const scroll=await page.locator('.ant-drawer-body').evaluate(element=>({height:element.clientHeight,content:element.scrollHeight,overflow:getComputedStyle(element).overflowY}));expect(scroll.content).toBeGreaterThan(scroll.height);expect(scroll.overflow).toBe('auto');
  await page.screenshot({path:'.tmp/system-operations/work-drawer-'+locale+'.png',animations:'disabled'});await page.getByRole('button',{name:locale==='en'?'Close':'关闭',exact:true}).click();await page.setViewportSize({width:1440,height:1000});
 }
 await expect(page.locator('#system-page')).not.toContainText('权限');await page.locator('.console-content').evaluate(element=>element.scrollTop=0);await page.screenshot({path:'.tmp/system-operations/desktop-en.png',animations:'disabled'});
});

test('refresh failure on a later page retains its evidence and never presents an empty healthy table',async({page})=>{
 await navigate(page,'system');await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('#system-pagination')).toContainText('第 2 页');
 const ids=await rows(page).allTextContents();await page.route('**/admin/api/operations',route=>route.fulfill({status:503,json:{error:{code:'SYSTEM_SOURCE_UNAVAILABLE'}}}));
 await page.locator('#system-refresh').click();await expect(page.locator('#system-page')).toContainText('数据可能过期');expect(await rows(page).allTextContents()).toEqual(ids);
});

test('delayed closed details do not overwrite another owner',async({page})=>{
 await navigate(page,'system');await page.route('**/admin/api/operations',async route=>{const body=route.request().postDataJSON();if(body?.action==='system_issue'&&body.args.id==='manager:work:permissions')await new Promise(r=>setTimeout(r,300));await route.continue();});
 await search(page,'manager:work:permissions');await rows(page).first().getByRole('button',{name:'详情',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await openWork(page,'gateway:work:configuration');await expect(page.locator('#system-detail')).toContainText('Runner 不可用');await expect(page.locator('#system-detail')).not.toContainText('权限问题');
});

test('compact summary selects matching records and shares full page width with task lists',async({page})=>{
 await page.setViewportSize({width:2560,height:1100});await navigate(page,'tasks');
 const taskBox=await page.locator('#view').boundingBox();await navigate(page,'system');
 const systemBox=await page.locator('#view').boundingBox();expect(Math.abs(systemBox.x-taskBox.x)).toBeLessThan(2);expect(Math.abs(systemBox.width-taskBox.width)).toBeLessThan(2);
 const status=await op(page,'system_status');
 const counts=[status.summary.unresolved,status.summary.states.retrying,status.summary.states.running,status.summary.recovered_24h];
 for(let index=0;index<4;index++){
  await page.locator('#system-search').fill('unrelated search');await page.locator('#system-query').click();await expect(rows(page)).toHaveCount(0);
  const selected=page.locator('#system-metric-'+index);await selected.click();await expect(selected).toHaveAttribute('aria-pressed','true');await expect(page.locator('#system-search')).toHaveValue('');
  let count=0;const ids=new Set();
  for(;;){
   await expect(page.locator('#system-query')).not.toHaveClass(/ant-btn-loading/);
   const current=rows(page);count+=await current.count();
   for(const row of await current.all()){
    const text=await row.innerText();ids.add(await row.locator('.table-identifier').innerText());
    if(index===1)expect(text).toContain('等待重试');if(index===2)expect(text).toContain('运行中');if(index===3){expect(text).toContain('已恢复');expect(text).not.toContain('无进展');}
   }
   const next=page.getByRole('button',{name:'下一页',exact:true});if(await next.isDisabled())break;
   const before=await page.locator('#system-pagination').innerText();await next.click();await expect(page.locator('#system-pagination')).not.toHaveText(before);
  }
  expect(count).toBe(counts[index]);expect(ids.size).toBe(count);
 }
 await page.locator('#system-metric-0').click();await expect(rows(page)).toHaveCount(20);
 await page.setViewportSize({width:1912,height:1000});expect((await page.locator('#system-metrics').boundingBox()).height).toBeLessThan(65);
 await page.screenshot({path:'.tmp/system-compact-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});expect((await page.locator('#system-metrics').boundingBox()).height).toBeLessThan(100);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.tmp/system-compact-mobile.png',fullPage:true});
});
