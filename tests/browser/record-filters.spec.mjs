import {test,expect} from '@playwright/test';

async function openRecords(page,scheduled,requests,english=false){
 const path=scheduled?'schedule-runs':'tasks';
 await page.route(`**/admin/api/${path}?*`,route=>{
  const query=Object.fromEntries(new URL(route.request().url()).searchParams);requests.push(query);
  const total=query.search?73:135,offset=Number(query.offset),limit=Number(query.limit);
  const items=Array.from({length:Math.max(0,Math.min(limit,total-offset))},(_,index)=>{
   const id=`synthetic-filter-${offset+index}`;
   return scheduled?{id,schedule_id:'synthetic-plan',schedule_name:'Synthetic filter plan',kind:'inspection',status:'queued',timezone:'Etc/UTC',created_at:1,due_at:1}:{task_id:id,request_id:id,type:'synthetic.retired',status:'queued',created_at:1,updated_at:1};
  });
  return route.fulfill({json:{items,total}});
 });
 if(english)await page.addInitScript(()=>localStorage.setItem('agent-console-language','en'));
 await page.goto('/admin/tasks');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:english?'Sign in':'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
 if(scheduled)await page.getByRole('tab',{name:english?'Scheduled tasks':'定时任务',exact:true}).click();
 await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'20',offset:'0',include_total:'1'});
}

for(const scheduled of [false,true]){
 const name=scheduled?'schedule':'plugin task';
 test(`${name} filters live below the heading inside the table panel at desktop and 320px`,async({page})=>{
  await openRecords(page,scheduled,[]);
  const panel=page.locator('.console-panel').filter({has:page.getByRole('heading',{name:scheduled?'定时任务执行记录':'执行记录',exact:true})});
  const form=panel.locator('.ant-card-body form.record-filters');
  await expect(form).toBeVisible();
  await expect(form.getByRole('textbox',{name:scheduled?'搜索定时执行':'搜索任务',exact:true})).toBeVisible();
  await expect(form.getByRole('combobox',{name:scheduled?'计划类型':'业务类型',exact:true})).toBeVisible();
  await expect(form.getByRole('combobox',{name:'任务状态',exact:true})).toBeVisible();
  await expect(form.getByRole('combobox',{name:'时间范围',exact:true})).toBeVisible();
  await expect(panel.getByRole('button',{name:/^(?:loading\s+)?刷新$/})).toBeVisible();
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:900});
   await expect(form).toBeVisible();
   const heading=await panel.getByRole('heading').boundingBox(),filters=await form.boundingBox(),table=await panel.locator('.ant-table-wrapper').boundingBox();
   expect(filters.y).toBeGreaterThan(heading.y+heading.height);expect(filters.y+filters.height).toBeLessThanOrEqual(table.y+1);
   for(const control of await form.locator('input,.ant-select,button').all()){
    if(!await control.isVisible())continue;
    const bounds=await control.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);
   }
   await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
   await page.screenshot({path:`.tmp/admin-record-filters/${scheduled?'scheduled':'plugins'}-${width}.png`,animations:'disabled'});
  }
 });

 test(`${name} filters submit combined fields, keep the time cutoff through paging, and reset to page one`,async({page})=>{
  const requests=[];await openRecords(page,scheduled,requests);
  const pagination=page.locator(scheduled?'#schedule-run-pagination':'#task-pagination');
  await pagination.getByRole('button',{name:'下一页',exact:true}).click();await expect.poll(()=>requests.at(-1).offset).toBe('20');
  if(scheduled){await page.getByRole('combobox',{name:'计划类型',exact:true}).click();await page.getByRole('option',{name:'管理巡检',exact:true}).click();}
  else await page.getByRole('combobox',{name:'业务类型',exact:true}).fill('synthetic.deleted-history');
  await page.getByRole('combobox',{name:'任务状态',exact:true}).click();await page.getByRole('option',{name:'执行失败',exact:true}).click();
  await page.getByRole('combobox',{name:'时间范围',exact:true}).click();await page.getByRole('option',{name:'最近 30 天',exact:true}).click();
  const input=page.getByRole('textbox',{name:scheduled?'搜索定时执行':'搜索任务',exact:true});await input.fill('needle');
  const before=Date.now()-30*86400000;await input.press('Enter');
  await expect.poll(()=>requests.at(-1)).toMatchObject({search:'needle',status:'failed',offset:'0',limit:'20',include_total:'1',...(scheduled?{kind:'inspection'}:{type:'synthetic.deleted-history'})});
  const cutoff=requests.at(-1).after;expect(Number(cutoff)).toBeGreaterThanOrEqual(before);expect(Number(cutoff)).toBeLessThanOrEqual(Date.now()-30*86400000);
  await expect(pagination).toContainText('共 73 条');
  await pagination.getByRole('button',{name:'下一页',exact:true}).click();await expect.poll(()=>requests.at(-1)).toMatchObject({offset:'20',after:cutoff});
  await expect(page.getByRole('button',{name:'查询',exact:true})).toHaveAttribute('aria-busy','false');
  const refresh=page.getByRole('button',{name:/^(?:loading\s+)?刷新$/});await expect(refresh).not.toHaveClass(/\bant-btn-loading\b/);
  const filterQuery=requests.at(-1),beforeRefresh=requests.length;await refresh.click();await expect.poll(()=>requests.length).toBeGreaterThan(beforeRefresh);expect(requests.at(-1)).toEqual(filterQuery);
  await page.getByRole('button',{name:'重置筛选',exact:true}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({offset:'0',limit:'20',include_total:'1'});
  for(const key of ['search','status','type','kind','after'])expect(requests.at(-1)[key]).toBeUndefined();
  await expect(input).toHaveValue('');await expect(pagination).toContainText('共 135 条');await expect(pagination.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
 });
}

for(const scheduled of [false,true])test(`${scheduled?'schedule':'plugin task'} filter labels and ranges load in English directly without visiting System`,async({page})=>{
 await openRecords(page,scheduled,[],true);
 const form=page.locator('form.record-filters');
 await expect(form.getByRole('textbox',{name:scheduled?'Search scheduled executions':'Search tasks',exact:true})).toHaveAttribute('placeholder',scheduled?'Search plan name or execution ID':'Search request ID or input content');
 await expect(form.getByRole('combobox',{name:'Task status',exact:true})).toBeVisible();
 await expect(form).toContainText('All statuses');
 if(scheduled){await expect(form.getByRole('combobox',{name:'Schedule kind',exact:true})).toBeVisible();await expect(form).toContainText('All plan types');}
 else {await expect(form.getByRole('combobox',{name:'Business type',exact:true})).toBeVisible();await expect(form.locator('.ant-select-placeholder').filter({hasText:'All business types'})).toBeVisible();}
 await expect(form.getByRole('button',{name:'Search',exact:true})).toBeVisible();await expect(form.getByRole('button',{name:'Reset filters',exact:true})).toBeVisible();
 await expect(form).toContainText('All time');await form.getByRole('combobox',{name:'Time range',exact:true}).click();
 for(const label of ['All time','Last 24 hours','Last 7 days','Last 30 days'])await expect(page.getByRole('option',{name:label,exact:true})).toBeVisible();
});
