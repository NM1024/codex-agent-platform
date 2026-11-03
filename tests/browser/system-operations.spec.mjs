import sharp from 'sharp';
import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
const op=async(page,action,args={})=>{const r=await page.request.post('/admin/api/operations',{data:{action,args}});expect(r.ok()).toBeTruthy();return r.json();};
async function choose(page,id,text){await page.locator(id).click();await page.locator('.ant-select-dropdown:visible').getByText(text,{exact:true}).click();}
async function search(page,text){await page.locator('#system-search').fill(text);await page.locator('#system-query').click();}
const rows=page=>page.locator('#system-records .ant-table-tbody > tr.ant-table-row');
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
 await page.getByRole('tab',{name:'待处理问题',exact:true}).click();await choose(page,'#system-resolution','已恢复');await search(page,'runner:work:recovered-idle');await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('空闲');
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

test('scoped maintenance locks duplicate clicks and reports fresh verified owner evidence',async({page})=>{
 let calls=0;await page.route('**/admin/api/operations',async route=>{if(route.request().postDataJSON()?.action==='system_maintain'){calls++;await new Promise(r=>setTimeout(r,150));}await route.continue();});
 await navigate(page,'system');await openWork(page,'gateway:work:configuration');
 const button=page.locator('#system-detail').getByRole('button',{name:'重新同步配置',exact:true});await button.evaluate(el=>{el.click();el.click();});
 await expect(page.locator('#system-detail')).toContainText('已核验恢复');await expect(page.locator('#system-detail')).toContainText('配置已同步');expect(calls).toBe(1);
 const detail=await op(page,'system_issue',{id:'gateway:work:configuration'});expect(detail.work.state).toBe('completed');expect(detail.work.attempts).toBe(2);
});

test('code defect drafts stay unsubmitted and human review reopens classification without claiming recovery',async({page})=>{
 await navigate(page,'system');await openWork(page,'manager:work:defect');
 await page.locator('#system-detail').getByRole('button',{name:'生成代码问题草稿',exact:true}).click();
 await expect(page.locator('#system-draft')).toContainText('未提交');await expect(page.locator('#system-draft pre')).toContainText('manager:work:defect');await expect(page.getByRole('button',{name:'复制草稿',exact:true})).toBeVisible();
 let calls=0;await page.route('**/admin/api/system/review',async route=>{calls++;await new Promise(r=>setTimeout(r,150));await route.continue();});
 await page.locator('#system-detail').getByRole('button',{name:'重新开放维护',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'重新开放维护',exact:true});await expect(dialog).toContainText('不代表已经恢复');await expect(dialog).toContainText('开发者');
 await dialog.getByRole('button',{name:'确认重新开放',exact:true}).evaluate(el=>{el.click();el.click();});await expect(dialog).toHaveCount(0);expect(calls).toBe(1);
 await expect(page.locator('#system-detail')).toContainText('已解除代码缺陷分类');const detail=await op(page,'system_issue',{id:'manager:work:defect'});expect(detail.work.classification).toBe('unknown');expect(detail.work.resolved_at).toBeNull();expect(detail.work.state).toBe('blocked');
});

test('explicit Agent analysis creates a fresh diagnostic conversation and preserves unrelated composer text and image',async({page})=>{
 await navigate(page,'chat');await page.locator('#message-input').fill('Unrelated synthetic unsent composer text');
 await page.locator('input[type=file][accept*="image"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:await sharp({create:{width:32,height:32,channels:3,background:'#a2bdad'}}).png().toBuffer()});
 await expect(page.locator('.chat-image-drafts')).toContainText('synthetic.png');
 let starts=0;await page.route('**/admin/api/conversations',async route=>{if(route.request().method()==='POST')starts++;await route.continue();});
 await navigate(page,'system');await page.locator('#system-refresh').click();expect(starts).toBe(0);
 await search(page,'manager:work:permissions');await rows(page).first().getByRole('button',{name:'Agent 分析',exact:true}).click();await expect(page.locator('#message-input')).toHaveValue('Unrelated synthetic unsent composer text');
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

test('unknown and failed maintenance outcomes are distinct from verified recovery',async({page})=>{
 await navigate(page,'system');await openWork(page,'gateway:work:configuration');let calls=0,outcome='unknown';
 await page.route('**/admin/api/operations',async route=>{if(route.request().postDataJSON()?.action==='system_maintain'){calls++;await route.fulfill({json:{action:'configuration_sync',outcome,work:null,sources:[]}});}else await route.continue();});
 await page.locator('#system-detail').getByRole('button',{name:'重新同步配置',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('结果未知，请先核验现状');await expect(page.locator('#system-detail')).not.toContainText('已核验恢复');
 outcome='failed';await page.locator('#system-detail').getByRole('button',{name:'重新同步配置',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('维护执行失败');
 outcome='unconfirmed';await page.locator('#system-detail').getByRole('button',{name:'重新同步配置',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('尚未核验恢复');expect(calls).toBe(3);
 expect((await op(page,'system_issue',{id:'gateway:work:configuration'})).work.state).toBe('retrying');
});

test('current revision conflicts reload authority and delayed closed details do not overwrite another owner',async({page})=>{
 await navigate(page,'system');await openWork(page,'manager:work:permissions');
 const current=await op(page,'system_issue',{id:'manager:work:permissions'});await op(page,'system_issue_draft',{id:current.work.id,revision:current.work.revision});
 await page.locator('#system-detail').getByRole('button',{name:'重试资源清理',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('操作未完成');await expect(page.locator('#system-detail')).toContainText('候选代码缺陷');await expect(page.locator('#system-detail').getByRole('button',{name:'重试资源清理',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.route('**/admin/api/operations',async route=>{const body=route.request().postDataJSON();if(body?.action==='system_issue'&&body.args.id==='manager:work:permissions')await new Promise(r=>setTimeout(r,300));await route.continue();});
 await search(page,'manager:work:permissions');await rows(page).first().getByRole('button',{name:'详情',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await openWork(page,'gateway:work:configuration');await expect(page.locator('#system-detail')).toContainText('Runner 不可用');await expect(page.locator('#system-detail')).not.toContainText('候选代码缺陷');
});

for(const scenario of [
 {kind:'maintain',outcome:'unknown',id:'manager:work:permissions',button:'重试资源清理'},
 {kind:'maintain',outcome:'failed',id:'manager:work:permissions',button:'重试资源清理'},
 {kind:'draft',id:'manager:work:permissions',button:'生成代码问题草稿'},
 {kind:'review',id:'manager:work:defect',button:'重新开放维护'},
])test(`post-action refresh retains page-two evidence after ${scenario.kind} ${scenario.outcome??''} and unavailable follow-ups`,async({page})=>{
 await navigate(page,'system');await expect(rows(page)).toHaveCount(20);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(rows(page)).toHaveCount(5);
 await expect(page.locator('#system-pagination')).toContainText('第 2 页');const before=await rows(page).allTextContents();
 await rows(page).filter({hasText:scenario.id}).getByRole('button',{name:'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText(scenario.id);
 let failFollowups=false,mutations=0;
 await page.route('**/admin/api/operations',async route=>{
  const body=route.request().postDataJSON(),action=scenario.kind==='maintain'?'system_maintain':scenario.kind==='draft'?'system_issue_draft':null;
  if(body?.action===action){
   mutations++;expect(body.args.id).toBe(scenario.id);expect(body.args.revision).toBe(1);
   if(scenario.kind==='maintain'){expect(body.args.action).toBe('cleanup_retry');failFollowups=true;await route.fulfill({json:{action:'cleanup_retry',outcome:scenario.outcome,work:null,sources:[]}});}
   else {const response=await route.fetch();expect(response.ok()).toBeTruthy();failFollowups=true;await route.fulfill({response});}
  }else if(failFollowups)await route.fulfill({status:503,json:{error:{code:'SYSTEM_SOURCE_UNAVAILABLE'}}});
  else await route.continue();
 });
 if(scenario.kind==='review')await page.route('**/admin/api/system/review',async route=>{mutations++;expect(route.request().postDataJSON()).toEqual({id:scenario.id,revision:1});const response=await route.fetch();expect(response.ok()).toBeTruthy();failFollowups=true;await route.fulfill({response});});
 await page.locator('#system-detail').getByRole('button',{name:scenario.button,exact:true}).click();
 if(scenario.kind==='review')await page.getByRole('dialog',{name:'重新开放维护',exact:true}).getByRole('button',{name:'确认重新开放',exact:true}).click();
 await expect(page.locator('#system-detail')).toContainText('详情暂时无法读取');
 await expect(page.locator('#system-detail').getByRole('button',{name:'生成代码问题草稿',exact:true})).toBeDisabled();
 await expect(page.locator('#system-detail').getByRole('button',{name:'Agent 分析',exact:true})).toBeDisabled();
 await expect(page.locator('#system-detail').getByRole('button',{name:scenario.button,exact:true})).toBeDisabled();
 expect(mutations).toBe(1);await page.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('#system-page')).toContainText('数据可能过期');
 await expect(rows(page)).toHaveCount(5);expect(await rows(page).allTextContents()).toEqual(before);await expect(page.locator('#system-pagination')).toContainText('第 2 页');
 await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 failFollowups=false;await page.locator('#system-refresh').click();await expect(rows(page)).toHaveCount(20);await expect(page.locator('#system-pagination')).toContainText('第 1 页');await expect(page.locator('#system-page')).not.toContainText('数据可能过期');expect(mutations).toBe(1);
});
