import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
import {readFile} from 'node:fs/promises';

const tasks=[
  {task_id:'synthetic-record-old',type:'content.review',request_id:'synthetic-old',status:'completed',created_at:1,updated_at:2,result:{approved:true},notification_channels:[],artifacts:[{artifact_id:'synthetic-artifact',filename:'synthetic-record.txt',mime:'text/plain'}]},
  {task_id:'synthetic-record-new',type:'content.review',request_id:'synthetic-new',status:'queued',created_at:3,updated_at:3,input:{text:'Synthetic queued record'},notification_channels:[]},
];
const binding={notification_channels:[],notification_revision:0,channels:[],available_channels:[],history:{items:[],next_cursor:null}};
const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function records(page){
  await page.addInitScript(()=>{window.revokedArtifactUrls=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revokedArtifactUrls.push(url);revoke(url);};});
  await page.route('**/admin/api/tasks?*',route=>route.fulfill({json:tasks}));
  await page.route(/\/admin\/api\/tasks\/synthetic-record-(?:old|new)$/,route=>route.fulfill({json:tasks.find(task=>route.request().url().endsWith(task.task_id))}));
  await page.route('**/admin/api/tasks/*/notifications',route=>route.fulfill({json:binding}));
  await page.route('**/admin/api/artifacts/synthetic-record-old/synthetic-artifact',route=>route.fulfill({contentType:'text/plain',body:'Synthetic authenticated artifact'}));
  await login(page);await navigate(page,'tasks');
}
async function inspect(page,id){await page.getByRole('row').filter({hasText:id}).getByRole('button',{name:'详情',exact:true}).click();}

test('old and new task records open compact tabbed drawers with authenticated artifacts',async({page})=>{
  test.setTimeout(45000);
  const artifactRequests=[];page.on('request',request=>{if(request.url().includes('/admin/api/artifacts/'))artifactRequests.push(request);});
  await records(page);await inspect(page,tasks[0].task_id);
  const drawer=page.getByRole('dialog',{name:'任务详情'});await expect(drawer).toBeVisible();await expect(drawer.locator('#task-details')).toBeVisible();
  await expect(page.locator('.console-content #task-details')).toHaveCount(0);await page.screenshot({path:'.tmp/admin-overlays/task-record-desktop.png',animations:'disabled'});
  await drawer.getByRole('tab',{name:'结果',exact:true}).click();await expect(drawer.getByRole('tabpanel')).toContainText('approved');
  await drawer.getByRole('tab',{name:'通知记录',exact:true}).click();await expect(drawer.getByRole('button',{name:'保存通知绑定',exact:true})).toHaveCount(0);await expect(drawer.getByRole('combobox')).toHaveCount(0);
  await drawer.getByRole('tab',{name:'产物',exact:true}).click();const artifact=drawer.getByRole('link',{name:'synthetic-record.txt',exact:true});await expect(artifact).toHaveAttribute('href',/^blob:/);expect(artifactRequests).toHaveLength(1);expect((await artifactRequests[0].allHeaders()).cookie).toBeTruthy();const artifactUrl=await artifact.getAttribute('href');const downloadReady=page.waitForEvent('download');await artifact.click();const download=await downloadReady;expect(download.suggestedFilename()).toBe('synthetic-record.txt');expect(await readFile(await download.path(),'utf8')).toBe('Synthetic authenticated artifact');
  await drawer.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(drawer).not.toBeVisible();await expect.poll(()=>page.evaluate(()=>window.revokedArtifactUrls)).toContain(artifactUrl);
  await inspect(page,tasks[1].task_id);await expect(drawer).toContainText(tasks[1].task_id);await drawer.getByRole('tab',{name:'产物',exact:true}).click();await expect(drawer.getByRole('link',{name:'synthetic-record.txt',exact:true})).toHaveCount(0);
  await page.setViewportSize({width:320,height:640});await expect(drawer.getByRole('button',{name:/^(关闭|Close)$/})).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({path:'.tmp/admin-overlays/task-record-mobile.png',animations:'disabled'});
  await drawer.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(drawer).not.toBeVisible();await page.setViewportSize({width:1440,height:1000});await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();await page.getByRole('row').filter({hasText:tasks[0].task_id}).getByRole('button',{name:'Details',exact:true}).click();
  const english=page.getByRole('dialog',{name:'Task details'});await expect(english).toBeVisible();for(const name of ['Overview','Result','Notification history','Artifacts'])await expect(english.getByRole('tab',{name,exact:true})).toBeVisible();await page.screenshot({path:'.tmp/admin-overlays/task-record-en-desktop.png',animations:'disabled'});await page.setViewportSize({width:844,height:390});await expect(english.getByRole('button',{name:'Close',exact:true})).toBeInViewport();await expect(english.getByRole('button',{name:'Run a new task',exact:true})).toBeInViewport();await page.screenshot({path:'.tmp/admin-overlays/task-record-en-landscape.png',animations:'disabled'});
});

test('closing a pending task detail read prevents late response resurrection and keeps row loading',async({page})=>{
  await records(page);const gate=deferred();await page.route('**/admin/api/tasks/synthetic-record-old',async route=>{await gate.promise;await route.fulfill({json:tasks[0]});});
  try{
    await inspect(page,tasks[0].task_id);const row=page.locator('tr').filter({hasText:tasks[0].task_id});await expect(row.getByRole('button',{name:'详情',exact:true,includeHidden:true})).toHaveAttribute('aria-busy','true');
    const drawer=page.getByRole('dialog',{name:'任务详情'});await expect(drawer).toBeVisible();await expect(drawer.getByRole('status')).toBeVisible();await drawer.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(drawer).not.toBeVisible();await inspect(page,tasks[1].task_id);await expect(drawer).toContainText(tasks[1].task_id);gate.release();await expect(row.getByRole('button',{name:'详情',exact:true,includeHidden:true})).toHaveAttribute('aria-busy','false');await expect(drawer).toContainText(tasks[1].task_id);await expect(drawer).not.toContainText(tasks[0].task_id);
  }finally{gate.release();}
});

test('schedule execution owner opens and closes independently in a nested drawer',async({page})=>{
  const plan={id:'synthetic-record-plan',name:'Synthetic record plan',kind:'inspection',cron:'0 9 * * *',timezone:'Etc/UTC',message:'Synthetic local history',enabled:false};
  await page.route('**/admin/api/schedules',route=>route.fulfill({json:[plan]}));
  await page.route('**/admin/api/schedules/synthetic-record-plan/notifications',route=>route.fulfill({json:{...binding,executions:[{id:'synthetic-ended-execution',kind:'inspection',status:'completed',created_at:1},{id:'synthetic-active-execution',kind:'inspection',status:'queued',created_at:2}]}}));
  await page.route('**/admin/api/inspections/*/notifications',route=>route.fulfill({json:binding}));
  await login(page);await navigate(page,'schedules');await page.getByRole('row').filter({hasText:plan.name}).getByRole('button',{name:'查看详情',exact:true}).click();
  const outer=page.getByRole('dialog',{name:'计划详情'});await expect(outer).toBeVisible();const executionTab=outer.getByRole('tab',{name:'执行记录',exact:true});if(await executionTab.count())await executionTab.click();
  await outer.getByRole('button',{name:'查看执行通知：synthetic-ended-execution',exact:true}).click();const nested=page.getByRole('dialog',{name:'执行通知记录'});await expect(nested).toBeVisible();await expect(nested).toContainText('synthetic-ended-execution');await expect(nested.getByRole('button',{name:'保存通知绑定',exact:true})).toHaveCount(0);await page.screenshot({path:'.tmp/admin-overlays/execution-owner-nested.png',animations:'disabled'});
  await nested.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(nested).not.toBeVisible();await expect(outer).toBeVisible();await outer.getByRole('button',{name:'查看执行通知：synthetic-active-execution',exact:true}).click();await expect(nested).toContainText('synthetic-active-execution');await expect(nested.getByRole('button',{name:'保存通知绑定',exact:true})).toBeVisible();
  await nested.getByRole('button',{name:/^(关闭|Close)$/}).click();const ownerRead=deferred();await page.route('**/admin/api/inspections/synthetic-active-execution/notifications',async route=>{await ownerRead.promise;await route.fulfill({json:binding});});
  try{await outer.getByRole('button',{name:'查看执行通知：synthetic-active-execution',exact:true}).click();await expect(nested.getByRole('status')).toBeVisible();await nested.getByRole('button',{name:/^(关闭|Close)$/}).click();await outer.getByRole('button',{name:'查看执行通知：synthetic-ended-execution',exact:true}).click();ownerRead.release();await expect(nested).toContainText('synthetic-ended-execution');await expect(nested.getByRole('button',{name:'保存通知绑定',exact:true})).toHaveCount(0);}finally{ownerRead.release();}
});

test('task retry keeps notification confirmation and investigation keeps the Agent route',async({page})=>{
  await records(page);
  const original={...tasks[0],notification_channels:['synthetic-unavailable-channel']};
  await page.route('**/admin/api/tasks/synthetic-record-old',route=>route.fulfill({json:original}));
  await page.route('**/admin/api/notification-channels',route=>route.fulfill({json:{items:[]}}));
  const retries=[];await page.route('**/admin/api/operations',route=>{const body=route.request().postDataJSON();if(body.action==='retry'){retries.push(body.args);return route.fulfill({json:{...tasks[1],task_id:'synthetic-record-retry'}});}return route.continue();});
  await inspect(page,tasks[0].task_id);const drawer=page.getByRole('dialog',{name:'任务详情'});await drawer.getByRole('button',{name:'重新执行任务',exact:true}).click();
  const retry=page.getByRole('dialog',{name:'重试任务的通知渠道'});await expect(retry).toBeVisible();await expect(retry.getByRole('button',{name:'确认重试',exact:true})).toBeDisabled();await retry.getByRole('button',{name:'移除不可用渠道：synthetic-unavailable-channel',exact:true}).click();await retry.getByRole('button',{name:'确认重试',exact:true}).click();await expect(retry).not.toBeVisible();await expect(drawer).not.toBeVisible();expect(retries).toEqual([{task_id:tasks[0].task_id,notification_channels:[]}]);
  const investigations=[];const conversation={id:'synthetic-investigation-record',title:'Synthetic record investigation',execution:{},messages:[],actions:[]};
  await page.route('**/admin/api/conversations',route=>{if(route.request().method()==='POST'){investigations.push(route.request().postDataJSON());return route.fulfill({json:conversation});}return route.continue();});
  await page.route('**/admin/api/conversations/synthetic-investigation-record',route=>route.fulfill({json:conversation}));
  await inspect(page,tasks[1].task_id);await drawer.getByRole('button',{name:'让 Agent 查看',exact:true}).click();await expect(page.locator('.chat-main')).toBeVisible();expect(investigations).toEqual([{title:'调查 '+tasks[1].task_id.slice(0,8),task_id:tasks[1].task_id,investigate:true}]);
});
