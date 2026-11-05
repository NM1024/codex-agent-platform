import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';
import {openChatPicker,chatPicker} from './agent-picker.mjs';
test.use({locale:'zh-CN',timezoneId:'Asia/Shanghai'});
const models=[
  {model:'gpt-6.1-sol',displayName:'Fixture Default',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],serviceTiers:[{id:'priority',name:'Fast'}]},
  {model:'fixture-supported',displayName:'Fixture Supported',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[{id:'priority',name:'Fast'}]},
  {model:'fixture-standard',displayName:'Fixture Standard',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[]},
];
let originalGlobals=[];
async function operation(page,action,args={}){const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok()).toBeTruthy();return response.json();}
async function choose(page,id,label){
  const input=page.locator(id);await input.click();
  const listId=await input.getAttribute('aria-controls');
  await page.locator('.ant-select-dropdown:visible').filter({has:page.locator('[id="'+listId+'"]')}).getByText(label,{exact:true}).click();
}
test.beforeEach(async({page})=>{
  originalGlobals=[];
  await page.route('**/admin/api/operations',route=>route.request().postDataJSON().action==='models'?route.fulfill({json:{models}}):route.continue());
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();
  // The fixture's server is shared across spec files. Earlier settings tests
  // may save an unlisted model, so speed tests must establish a supported one.
  for(const scope of ['manager','execution']){
    const {values}=await operation(page,'configuration_get',{scope});
    originalGlobals.push({scope,patch:{model:values.model,reasoningEffort:values.reasoningEffort,serviceTier:values.serviceTier??'default'}});
    await operation(page,'configuration_update',{scope,patch:{model:models[0].model,reasoningEffort:'medium',serviceTier:'default'}});
  }
});
test.afterEach(async({page})=>{
  for(const settings of originalGlobals)await operation(page,'configuration_update',settings);
});
async function conversation(page,execution={}){
  const response=await page.request.post('/admin/api/conversations',{data:{title:'Synthetic speed picker',execution}});expect(response.ok()).toBeTruthy();const created=await response.json();
  await navigate(page,'chat');await expect(page.locator('.chat-header')).toContainText(created.title);
  return async()=>(await(await page.request.get('/admin/api/conversations/'+created.id)).json()).execution;
}
async function expectFastIndicator(page,fast){
  const trigger=page.locator('#chat-model'),indicator=trigger.getByRole('img',{name:'快速模式',exact:true});
  await expect(trigger).not.toContainText(' - fast');
  if(fast){await expect(indicator).toBeVisible();await expect(indicator.locator('svg')).not.toHaveCSS('fill','none');}
  else await expect(indicator).toHaveCount(0);
}

test('chat defaults to standard, keeps model rows on one line, and saves fast independently',async({page})=>{
  const saved=await conversation(page);await openChatPicker(page);
  const control=chatPicker(page).locator('.chat-effort-heading').getByRole('switch',{name:'快速模式',exact:true});
  await expect(chatPicker(page).locator('.chat-effort-heading strong')).toHaveText('Fixture Default');
  await expect(chatPicker(page).getByText('下一轮对话生效',{exact:true})).toHaveCount(0);
  await expect(chatPicker(page).getByText('跟随默认',{exact:true})).toHaveCount(0);
  await expect(chatPicker(page).getByRole('button',{name:'使用模型默认',exact:true})).toHaveCount(0);
  await expect(control.locator('svg')).toHaveCount(1);await control.hover();
  await expect(page.locator('.ant-tooltip').getByRole('tooltip')).toContainText('用量更多');
  await page.screenshot({path:'.tmp/inspection-handoff/fast-toggle.png',animations:'disabled'});
  await expect(control).not.toBeChecked();await expect(control.locator('svg')).toHaveAttribute('fill','none');await expectFastIndicator(page,false);await expect(chatPicker(page).locator('.chat-agent-option-icon')).toHaveCount(0);
  const row=chatPicker(page).getByRole('radio',{name:'Fixture Default',exact:true});
  const positions=await row.locator('.chat-agent-option-copy').evaluate(element=>Array.from(element.children).map(child=>{const r=child.getBoundingClientRect();return r.y+r.height/2;}));
  expect(Math.abs(positions[0]-positions[1])).toBeLessThan(3);
  await control.click();await expect.poll(saved).toEqual({serviceTier:'priority'});
  await expect(control).toBeChecked();await expect(control.locator('svg')).toHaveAttribute('fill','currentColor');await expect(page.locator('#chat-model')).toContainText('Fixture Default - medium');await expectFastIndicator(page,true);await control.hover();await expect(control).toHaveCSS('color','rgb(52, 94, 79)');await page.screenshot({path:'.tmp/inspection-handoff/fast-toggle-enabled.png',animations:'disabled'});
  await chatPicker(page).getByRole('button',{name:'low',exact:true}).click();await expect.poll(saved).toEqual({reasoningEffort:'low',serviceTier:'priority'});
  await chatPicker(page).getByRole('radio',{name:'Fixture Supported',exact:true}).click();await expect.poll(saved).toEqual({model:'fixture-supported',serviceTier:'priority'});
  await control.click();await expect.poll(saved).toEqual({model:'fixture-supported',serviceTier:'default'});await expect(control.locator('svg')).toHaveAttribute('fill','none');await expectFastIndicator(page,false);
});

test('inherited fast is visible and an explicit standard override stays standard after reload',async({page})=>{
  await operation(page,'configuration_update',{scope:'manager',patch:{serviceTier:'priority'}});
  const saved=await conversation(page);await openChatPicker(page);
  const control=chatPicker(page).getByRole('switch',{name:'快速模式',exact:true});
  await expect(control).toBeChecked();await expect(control.locator('svg')).toHaveAttribute('fill','currentColor');await expect(page.locator('#chat-model')).toContainText('Fixture Default - medium');await expectFastIndicator(page,true);
  await control.click();await expect.poll(saved).toEqual({serviceTier:'default'});
  await page.reload();await expect(page.locator('#chat-model')).toHaveText('Fixture Default - medium');await expectFastIndicator(page,false);await openChatPicker(page);
  await expect(control).not.toBeChecked();await expect(control.locator('svg')).toHaveAttribute('fill','none');
});

test('unsupported models disable enabling fast while an old fast choice can be switched off',async({page})=>{
  const saved=await conversation(page,{model:'fixture-standard',serviceTier:'priority'});await openChatPicker(page);
  const control=chatPicker(page).locator('.chat-effort-heading').getByRole('switch',{name:'快速模式',exact:true});
  await expect(control).toBeChecked();await chatPicker(page).locator('.chat-fast-control').hover();await expect(page.locator('.ant-tooltip').getByRole('tooltip')).toContainText('当前模型暂不支持快速模式');
  await control.click();await expect.poll(saved).toEqual({model:'fixture-standard',serviceTier:'default'});await expect(control).toBeDisabled();
});

test('both global model configuration panels default to standard and persist explicit fast',async({page})=>{
  await navigate(page,'settings');
  for(const [scope,label] of [['manager','管理 Agent'],['execution','业务执行']]){
    await page.getByRole('tab',{name:label,exact:true}).click();
    const field=page.locator('.ant-select').filter({has:page.locator('#setting-'+scope+'-serviceTier')});await expect(field).toContainText('普通模式');
    await choose(page,'#setting-'+scope+'-serviceTier','快速模式');
    await page.locator('#configuration-'+scope).getByRole('button',{name:'保存配置',exact:true}).click();
    await expect.poll(async()=>(await operation(page,'configuration_get',{scope})).values.serviceTier).toBe('priority');
  }
});

test('plugin standard overrides global fast and model changes retain that explicit choice',async({page})=>{
  const before=await operation(page,'plugin_get',{type:'content.review'});
  try{
    await operation(page,'configuration_update',{scope:'execution',patch:{serviceTier:'priority'}});
    await navigate(page,'plugins');await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
    const modal=page.getByRole('dialog');await modal.getByRole('tab',{name:'模型设置',exact:true}).click();
    await choose(page,'#plugin-execution-serviceTier','普通模式');await choose(page,'#plugin-execution-model','Fixture Supported');
    await modal.getByRole('button',{name:'保存模型设置',exact:true}).click();await expect(modal.getByRole('status')).toContainText('模型设置已保存。');
    expect((await operation(page,'plugin_get',{type:before.type})).execution).toEqual({model:'fixture-supported',serviceTier:'default'});
  }finally{const latest=await operation(page,'plugin_get',{type:before.type});await operation(page,'plugin_execution_update',{type:before.type,revision:latest.revision,execution:before.execution??{}});}
});

test('phone speed control remains in the reasoning card and preserves the composer draft',async({page})=>{
  await page.setViewportSize({width:390,height:844});const saved=await conversation(page);await page.locator('#message-input').fill('Synthetic unsent draft');await openChatPicker(page);
  const control=chatPicker(page).locator('.chat-effort-card').getByRole('switch',{name:'快速模式',exact:true});await expect(control).toBeInViewport({ratio:1});
  await page.setViewportSize({width:320,height:760});await expect(control).toBeInViewport({ratio:1});await page.screenshot({path:'.tmp/inspection-handoff/fast-toggle-mobile.png',animations:'disabled'});
  await control.click();await expect.poll(saved).toEqual({serviceTier:'priority'});await expect(control.locator('svg')).toHaveAttribute('fill','currentColor');await page.keyboard.press('Escape');await expect(page.locator('#chat-model')).toContainText('Fixture Default - medium');await expectFastIndicator(page,true);await expect(page.locator('#message-input')).toHaveValue('Synthetic unsent draft');
  await expect(page.locator('.chat-agent-trigger-effort')).toBeInViewport({ratio:1});await expect(page.locator('.chat-agent-trigger-fast')).toBeInViewport({ratio:1});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);await page.screenshot({path:'.tmp/inspection-handoff/fast-indicator-phone-on.png',animations:'disabled'});
});
