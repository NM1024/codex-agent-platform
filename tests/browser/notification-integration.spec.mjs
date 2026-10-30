import {setNotificationChoice,expectNotificationChoice} from './notification-select.mjs';
import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

// All writes use the real authenticated Admin routes. The two fixture-only
// lifecycle hooks create local terminal/inspection records without a model or
// network send; the terminal hook first disables the synthetic channel.
async function json(response) {
  expect(response.ok(),await response.text()).toBeTruthy();
  return response.json();
}
async function operation(page,action,args={}) {
  return json(await page.request.post('/admin/api/operations',{data:{action,args}}));
}
async function createChannel(page,label) {
  return json(await page.request.post('/admin/api/notification-channels',{data:{channel:{
    name:`Synthetic notification ${label}`,provider:'custom',description:'Synthetic browser integration channel',instructions:'Use a JSON text field.',
    url:'http://127.0.0.1:9/synthetic-notification',token:'synthetic-notification-browser-token',timeoutMs:1000,enabled:true,
  }}}));
}
async function createPlugin(page,suffix) {
  const type=`browser.notification.${suffix}`;
  await operation(page,'plugin_save',{definition:{type,name:`Synthetic notification plugin ${suffix}`,instructions:'Return the supplied object. Use only explicitly bound notification channels.',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:['notification_context','send_notification']},delivery:{mode:'none'},enabled:false}});
  await json(await page.request.post(`/admin/api/plugins/${type}/connection`,{data:{entryKey:`synthetic-notification-entry-${suffix}-0123456789`}}));
  await operation(page,'plugin_enable',{type,enabled:true});
  return type;
}
async function createTask(page,suffix,channelId) {
  const type=await createPlugin(page,suffix),request_id=`synthetic-notification-${suffix}`;
  return {...await operation(page,'submit_task',{type,request_id,input:{text:'Synthetic notification integration task'},notification_channels:[channelId]}),request_id};
}
async function openTask(page,task) {
  await navigate(page,'tasks');
  await page.locator('#task-search').fill(task.request_id);
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.getByRole('row').filter({hasText:task.task_id}).getByRole('button',{name:'详情',exact:true}).click();
  await expect(page.locator('#task-details')).toBeVisible();
  await page.locator('#task-details').getByRole('tab',{name:'通知记录',exact:true}).click();return page.getByRole('dialog').filter({has:page.locator('#task-details')});
}
async function openSchedule(page,plan) {
  await navigate(page,'schedules');
  await page.getByRole('row').filter({hasText:plan.name}).getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(page.locator('#schedule-detail')).toBeVisible();
  return page.locator('#schedule-detail');
}
async function binding(page,owner,id) {
  return json(await page.request.get(`/admin/api/${owner}/${id}/notifications`));
}

test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
});

test('settings notification tab edits a real private channel without sending and reloads saved metadata',async({page})=>{
  const channel=await createChannel(page,'settings');const sends=[];
  page.on('request',request=>{if(/\/notification-channels\/[^/]+\/test$/.test(new URL(request.url()).pathname))sends.push(request.url());});
  await navigate(page,'settings');await page.locator('[data-settings-tab="notifications"]').click();
  const card=page.locator('.notification-channel').filter({has:page.getByText(channel.name,{exact:true})});
  await expect(card).toContainText('已启用');await expect(card).not.toContainText('synthetic-notification-browser-token');
  await card.getByRole('button',{name:`编辑通知渠道：${channel.name}`,exact:true}).click();const modal=page.getByRole('dialog');await modal.getByRole('tab',{name:'接入与认证',exact:true}).click();
  await expect(modal.getByLabel('Webhook 地址',{exact:true})).toHaveValue('');await expect(modal.getByLabel('Bearer token',{exact:true})).toHaveValue('');
  await modal.getByRole('tab',{name:'基本配置',exact:true}).click();const name=channel.name+' edited';await modal.getByLabel('渠道名称',{exact:true}).fill(name);await modal.getByLabel('用途说明',{exact:true}).fill('Synthetic revised description');
  await modal.getByRole('button',{name:'保存渠道',exact:true}).click();await expect(modal).toHaveCount(0);
  const saved=(await json(await page.request.get('/admin/api/notification-channels'))).items.find(item=>item.id===channel.id);
  expect(saved).toMatchObject({name,description:'Synthetic revised description',revision:channel.revision+1,configured:{url:true,token:true}});
  expect(JSON.stringify(saved)).not.toContain('127.0.0.1');expect(JSON.stringify(saved)).not.toContain('synthetic-notification-browser-token');expect(sends).toEqual([]);
  await page.reload();await navigate(page,'settings');await page.locator('[data-settings-tab="notifications"]').click();await expect(page.getByText(name,{exact:true})).toBeVisible();
});

test('task detail saves and reloads independent notification bindings through the real API',async({page})=>{
  const channel=await createChannel(page,'task'),task=await createTask(page,'active',channel.id);
  const before=await operation(page,'task',{task_id:task.task_id});expect(before.notification_channels).toEqual([channel.id]);
  const detail=await openTask(page,task);await expectNotificationChoice(page,detail,channel.name,true);await setNotificationChoice(page,detail,channel.name,false);await detail.getByRole('button',{name:'保存通知绑定',exact:true}).click();
  await expect.poll(async()=>(await binding(page,'tasks',task.task_id)).notification_channels).toEqual([]);
  const after=await operation(page,'task',{task_id:task.task_id});expect(after.status).toBe(before.status);expect(after.input).toEqual(before.input);
  await page.reload();const reloaded=await openTask(page,task);await expectNotificationChoice(page,reloaded,channel.name,false);
  await setNotificationChoice(page,reloaded,channel.name,true);await reloaded.getByRole('button',{name:'保存通知绑定',exact:true}).click();
  await expect.poll(async()=>(await binding(page,'tasks',task.task_id)).notification_channels).toEqual([channel.id]);
});

test('inspection schedule preserves cron and next run while schedule and execution bindings change independently',async({page})=>{
  const channel=await createChannel(page,'schedule');
  const plan=await operation(page,'schedule_save',{schedule:{name:'Synthetic notification inspection plan',kind:'inspection',message:'Synthetic inspection only; no real remote actions.',cron:'15 8 * * *',timezone:'Etc/UTC',enabled:false,notification_channels:[channel.id]}});
  await page.setViewportSize({width:390,height:844});let detail=await openSchedule(page,plan);await detail.getByRole('tab',{name:'通知渠道',exact:true}).click();
  const planPanel=detail.locator('.notification-panel').filter({has:page.getByRole('button',{name:'保存通知绑定',exact:true})}).first();
  await setNotificationChoice(page,planPanel,channel.name,false);await planPanel.getByRole('button',{name:'保存通知绑定',exact:true}).click();
  await expect.poll(async()=>(await binding(page,'schedules',plan.id)).notification_channels).toEqual([]);
  const after=(await operation(page,'schedules')).find(item=>item.id===plan.id);expect(after.cron).toBe(plan.cron);expect(after.next_run_at).toBe(plan.next_run_at);expect(after.message).toBe(plan.message);
  await setNotificationChoice(page,planPanel,channel.name,true);await planPanel.getByRole('button',{name:'保存通知绑定',exact:true}).click();
  await expect.poll(async()=>(await binding(page,'schedules',plan.id)).notification_channels).toEqual([channel.id]);
  const execution=await json(await page.request.post('/admin/api/__fixture/notification-inspection',{data:{schedule_id:plan.id}}));
  await page.reload();detail=await openSchedule(page,plan);await detail.getByRole('tab',{name:'执行记录',exact:true}).click();await detail.getByRole('button',{name:`查看执行通知：${execution.id}`,exact:true}).click();
  const executionPanel=page.locator('.notification-selected-execution');await expectNotificationChoice(page,executionPanel,channel.name,true);
  await setNotificationChoice(page,executionPanel,channel.name,false);await executionPanel.getByRole('button',{name:'保存通知绑定',exact:true}).click();
  await expect.poll(async()=>(await binding(page,'inspections',execution.id)).notification_channels).toEqual([]);
  expect((await binding(page,'schedules',plan.id)).notification_channels).toEqual([channel.id]);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:'Settled phone overlay and popup containment'}).toBeLessThanOrEqual(390);
});

test('terminal task shows real per-channel history and retry explicitly overrides an unavailable binding',async({page})=>{
  const channel=await createChannel(page,'terminal'),task=await createTask(page,'terminal',channel.id);
  const fixture=await json(await page.request.post('/admin/api/__fixture/notification-terminal',{data:{task_id:task.task_id,channel_id:channel.id}}));
  const original=await binding(page,'tasks',task.task_id);expect(original.notification_channels).toEqual([channel.id]);expect(original.history.items.length).toBeGreaterThan(0);
  expect(original.history.items.flatMap(batch=>batch.deliveries).every(delivery=>delivery.status==='unavailable')).toBe(true);
  const detail=await openTask(page,task);await expect(detail.getByRole('button',{name:'保存通知绑定',exact:true})).toHaveCount(0);await expect(detail.getByRole('checkbox')).toHaveCount(0);
  const batch=fixture.batch??original.history.items[0];await detail.getByText(batch.notification_key,{exact:true}).click();
  for(const delivery of batch.deliveries)await expect(detail.getByText(delivery.summary,{exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'重新执行任务',exact:true}).click();const modal=page.getByRole('dialog',{name:'重试任务的通知渠道',exact:true});await expect(modal.getByRole('button',{name:'确认重试',exact:true})).toBeDisabled();
  await modal.getByRole('button',{name:`移除不可用渠道：${channel.id}`,exact:true}).click();
  const retried=page.waitForResponse(response=>response.url().endsWith('/admin/api/operations')&&response.request().postDataJSON()?.action==='retry');
  await modal.getByRole('button',{name:'确认重试',exact:true}).click();const response=await retried;
  expect(response.request().postDataJSON().args).toEqual({task_id:task.task_id,notification_channels:[]});const replacement=await json(response);expect(replacement.task_id).not.toBe(task.task_id);
  expect((await binding(page,'tasks',replacement.task_id)).notification_channels).toEqual([]);expect((await binding(page,'tasks',task.task_id)).notification_channels).toEqual([channel.id]);
});

test('plugin notification defaults select individual Feishu configurations and preserve separate task overrides',async({page})=>{
 const type=await createPlugin(page,'defaults'),channels=[];
 for(const suffix of ['Operations','Engineering'])channels.push(await json(await page.request.post('/admin/api/notification-channels',{data:{channel:{name:`Synthetic Feishu ${suffix}`,provider:'feishu',url:`https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-${suffix.toLowerCase()}`}}})));
 await navigate(page,'plugins');await page.getByRole('row').filter({hasText:type}).getByRole('button',{name:'配置接入',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByRole('tab',{name:'通知渠道',exact:true}).click();
 for(const channel of channels)await setNotificationChoice(page,modal,channel.name,true);await modal.getByRole('button',{name:'保存通知绑定',exact:true}).click();
 await expect.poll(async()=>(await json(await page.request.get(`/admin/api/plugins/${type}/notifications`))).notification_channels).toEqual(channels.map(channel=>channel.id));
 const created=await operation(page,'submit_task',{type,input:{text:'Synthetic plugin default task'}});expect(created.notification_channels).toEqual(channels.map(channel=>channel.id));
 const empty=await operation(page,'submit_task',{type,input:{text:'Synthetic no notification task'},notification_channels:[]});expect(empty.notification_channels).toEqual([]);
 await setNotificationChoice(page,modal,channels[0].name,false);await modal.getByRole('button',{name:'保存通知绑定',exact:true}).click();await expect.poll(async()=>(await json(await page.request.get(`/admin/api/plugins/${type}/notifications`))).notification_channels).toEqual([channels[1].id]);expect((await operation(page,'task',{task_id:created.task_id})).notification_channels).toEqual(channels.map(channel=>channel.id));
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:'Settled phone overlay and popup containment'}).toBeLessThanOrEqual(390);
});
