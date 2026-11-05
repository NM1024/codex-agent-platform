import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const sampledAt=Date.UTC(2026,0,1);
const sources=['manager','gateway','runner'].map(service=>({service,available:true,observed_at:sampledAt,error_code:null}));
const work=(id,service,module,state,code,issue_count=0)=>({id:`${service}:work:${id}`,kind:'work',service,module,state,code,issue_count,classification:'unknown',target_id:null,details:{},allowed_actions:[],revision:1,created_at:sampledAt,updated_at:sampledAt,last_progress_at:sampledAt,completed_at:state==='completed'?sampledAt:null,attempts:1,consecutive_failures:0,pending_count:0,next_retry_at:null,issue_opened_at:issue_count?sampledAt:null,resolved_at:issue_count&&state==='completed'?sampledAt:null,age_ms:0,progress_age_ms:0,stale:false,verification_required:state==='unknown'});
const works=[
 work('running-version','manager','upgrade','completed','SYSTEM_OK'),
 work('version-check','manager','upgrade','completed','SYSTEM_OK'),
 work('host-upgrade','manager','upgrade','completed','UPGRADE_COMPLETED'),
 work('host-access','manager','upgrade','idle','SYSTEM_OK'),
 work('health','runner','health','completed','SERVICE_RECOVERED'),
 work('recovery','manager','runtime','completed','RECOVERY_COMPLETED'),
 ...['running','retrying','blocked','unknown','completed','idle','disabled'].map((state,index)=>work(`generic-${state}`,sources[index%3].service,'system',state,`WORK_${state.toUpperCase()}`)),
 work('permissions','runner','cleanup','completed','EACCES',3),
 work('failed','gateway','upgrade','completed','UPGRADE_FAILED',2),
 work('mismatch','manager','system','completed','WORK_BLOCKED'),
 work('collection','gateway','system','completed','SYSTEM_JOURNAL_RECOVERED',1),
 work('history','runner','health','completed','SERVICE_RECOVERED',4),
 work('inspection-handoff','manager','inspections','completed','HANDOFF_COMPLETED'),
];
const events=[
 {id:'manager:event:check',kind:'event',service:'manager',module:'upgrade',event:'system_check',level:'info',code:'SYSTEM_OK',work_id:null,count:1},
 {id:'gateway:event:upgrade',kind:'event',service:'gateway',module:'upgrade',event:'upgrade_completed',level:'info',code:'UPGRADE_COMPLETED',work_id:null,count:2},
 {id:'runner:event:blocked',kind:'event',service:'runner',module:'system',event:'work_observed',level:'warn',code:'WORK_BLOCKED',work_id:null,count:1},
].map(item=>({...item,created_at:sampledAt,first_seen_at:sampledAt,last_seen_at:sampledAt,details:{},target_id:null,state:null}));
const rows=page=>page.locator('#system-records .ant-table-tbody > tr.ant-table-row');
const row=(page,id)=>rows(page).filter({has:page.locator(`.table-identifier code[title="${id}"]`)});
async function choose(page,id,label){await page.locator(id).click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText(label,{exact:true}).click();}
async function setup(page){
 await page.route('**/admin/api/operations',async route=>{
  const {action,args={}}=route.request().postDataJSON()??{};
  if(action==='system_status')return route.fulfill({json:{sampled_at:sampledAt,sources,summary:{complete:true,states:{running:1,retrying:1},unresolved:2,recovered_24h:2,collections:[]}}});
  if(action==='system_issue'&&args.id)return route.fulfill({json:{work:works.find(item=>item.id===args.id),events:[],sources}});
  if(['system_issue','system_work','system_logs'].includes(action)){const items=action==='system_logs'?events:works;return route.fulfill({json:{items,sources,next_cursor:null,total:items.length,total_complete:true}});}
  return route.continue();
 });
 await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'system');await expect(rows(page)).toHaveCount(works.length);
}

test('all system lists put a standalone service Tag first and ID after the name on desktop and phone in both languages',async({page})=>{
 test.setTimeout(60000);await setup(page);
 for(const locale of ['zh-CN','en']){
  if(locale==='en')await choose(page,'#app-language','English');
  const names=locale==='en'?['Issues','Background work','System logs']:['待处理问题','后台工作','系统日志'];
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:1000});
   for(const [index,name] of names.entries()){
    await page.getByRole('tab',{name,exact:true}).click();await expect(rows(page)).toHaveCount(index===2?events.length:works.length);
    const headers=page.locator('#system-records thead th');await expect(headers.nth(0)).toHaveText(locale==='en'?'Service':'服务');await expect(headers.nth(2)).toHaveText(locale==='en'?'ID':'编号');
    for(const item of index===2?events:works){
     const cells=row(page,item.id).locator(':scope > td');
     await expect(cells.nth(0).locator('.ant-tag')).toHaveText(item.service[0].toUpperCase()+item.service.slice(1));await expect(cells.nth(0).locator('.table-identifier')).toHaveCount(0);
     await expect(cells.nth(2).locator('.table-identifier')).toContainText(item.id);
     const boxes=await Promise.all([0,1,2,3].map(async column=>cells.nth(column).boundingBox()));
     if(width===320){
      for(const column of [1,2,3])expect(boxes[column].y).toBeGreaterThanOrEqual(boxes[0].y+boxes[0].height-1);
      expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].y+boxes[1].height-1);
     }
     else expect(boxes[0].x).toBeLessThan(boxes[1].x);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`.tmp/system-list-presentation/${locale}-${width}-${index}.png`,fullPage:true,animations:'disabled'});
   }
  }
 }
});

test('work names hide only redundant state outcomes and zero issue counts while keeping diagnostics, history and log outcomes',async({page})=>{
 test.setTimeout(60000);await setup(page);
 for(const locale of ['zh-CN','en']){
  if(locale==='en')await choose(page,'#app-language','English');
  for(const name of locale==='en'?['Issues','Background work']:['待处理问题','后台工作']){
   await page.getByRole('tab',{name,exact:true}).click();await expect(rows(page)).toHaveCount(works.length);
   const upgradeNames=locale==='en'?['Running version','Version check','System upgrade','Web upgrade service']:['运行版本','版本检查','系统升级','网页升级服务'];
   for(const [index,label] of upgradeNames.entries())await expect(row(page,works[index].id).locator('.table-name-cell strong')).toHaveText(label);
   for(const item of works.slice(0,13)){
    const cell=row(page,item.id).locator('.table-name-cell');await expect(cell.locator('strong')).toHaveCount(1);await expect(cell.locator('code')).toHaveCount(0);await expect(cell.locator('.table-field-value')).toHaveText(await cell.locator('strong').innerText());
   }
   for(const item of works.slice(13,17))await expect(row(page,item.id).locator('.table-name-cell')).toContainText(item.code);
   const history=row(page,'runner:work:history').locator('.table-name-cell');await expect(history.locator('code')).toHaveCount(0);await expect(history).toContainText(locale==='en'?'Issue occurrences 4':'问题次数 4');
   await expect(row(page,'runner:work:permissions').locator('.table-name-cell')).toContainText(locale==='en'?'Issue occurrences 3':'问题次数 3');
   await expect(row(page,'gateway:work:failed').locator('.table-name-cell')).toContainText(locale==='en'?'Upgrade failed.':'升级失败。');
   await expect(row(page,'manager:work:inspection-handoff').locator('.table-name-cell')).toContainText(locale==='en'?'Scheduled work handoff completed.':'定时工作交接完成。');
  }
  await row(page,'manager:work:running-version').getByRole('button',{name:locale==='en'?'Details':'详情',exact:true}).click();await expect(page.locator('#system-detail')).toContainText('SYSTEM_OK');await page.getByRole('button',{name:locale==='en'?'Close':'关闭',exact:true}).click();
  await page.getByRole('tab',{name:locale==='en'?'System logs':'系统日志',exact:true}).click();await expect(rows(page)).toHaveCount(events.length);
  for(const item of events)await expect(row(page,item.id).locator('.table-name-cell')).toContainText(item.code);
  await expect(row(page,'manager:event:check').locator('.table-name-cell')).toContainText(locale==='en'?'System check succeeded.':'系统检查成功。');
  await page.screenshot({path:`.tmp/system-list-presentation/logs-${locale}.png`,fullPage:true,animations:'disabled'});
 }
});

test('system list guidance follows its panel heading without a separate notice row in both languages and on phone',async({page})=>{
 test.setTimeout(60000);await setup(page);
 const notices={
  'zh-CN':[['待处理问题','相同问题合并计数，恢复历史按解决状态筛选；当前工作状态单独显示。'],['后台工作','没有新进展不代表完成；需要核验的工作保留原状态。'],['系统日志','仅记录脱敏系统事件，不包含业务正文、提示词或凭证。']],
  en:[['Issues','Repeated issues are consolidated. Filter recovery history independently of current work state.'],['Background work','Silence does not imply completion. Work requiring verification retains its state.'],['System logs','Sanitized system events exclude business content, prompts and credentials.']],
 };
 for(const locale of ['zh-CN','en']){
  if(locale==='en')await choose(page,'#app-language','English');
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:1000});
   for(const [name,notice] of notices[locale]){
    await page.getByRole('tab',{name,exact:true}).click();
    const heading=page.locator('#system-page .console-panel .ant-card-head'),guidance=heading.getByText(notice,{exact:true});
    await expect(guidance).toBeVisible();await expect(page.locator('#system-page .system-notice')).toHaveCount(0);
    await expect(page.locator('#system-page').getByText(notice,{exact:true})).toHaveCount(1);
    const titleBox=await heading.getByRole('heading',{name,exact:true}).boundingBox(),noticeBox=await guidance.boundingBox();
    if(width===1440)expect(noticeBox.x).toBeGreaterThanOrEqual(titleBox.x+titleBox.width);
    else expect(noticeBox.y).toBeGreaterThanOrEqual(titleBox.y-1);
    await expect(page.locator('#system-refresh')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   }
   await page.screenshot({path:`.tmp/system-list-presentation/heading-${locale}-${width}.png`,fullPage:true,animations:'disabled'});
  }
 }
});
