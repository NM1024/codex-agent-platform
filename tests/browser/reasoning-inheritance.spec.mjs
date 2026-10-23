import {test,expect} from '@playwright/test';

const catalog={models:[{model:'gpt-6.1-sol',displayName:'Fixture Default',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{model:'fixture-fast',displayName:'Fixture Fast',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'fixture-unknown-default',displayName:'Fixture Unknown',supportedReasoningEfforts:[]}]};
const effort=page=>page.locator('.ant-select').filter({has:page.locator('#chat-reasoningEffort')});
async function choose(page,id,label){await page.locator(id).click();await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).last().click();}
async function setup(page,{execution={},globalEffort='medium'}={}){
  await page.route('**/admin/api/operations',async route=>{
    const request=route.request().postDataJSON();
    if(request.action==='models')return route.fulfill({json:catalog});
    if(request.action==='configuration_get'&&request.args.scope==='manager')return route.fulfill({json:{scope:'manager',title:'Manager',description:'Synthetic manager settings',schema:{},values:{model:'gpt-6.1-sol',...(globalEffort===undefined?{}:{reasoningEffort:globalEffort})},configured_secrets:[],revision:1,updated_at:1}});
    return route.continue();
  });
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();
  const response=await page.request.post('/admin/api/conversations',{data:{title:'Synthetic reasoning inheritance',execution}});expect(response.ok()).toBeTruthy();const conversation=await response.json();
  await page.locator('[data-view="chat"]').click();await expect(page.locator('.chat-header')).toContainText(conversation.title);return conversation;
}
const saved=async(page,id)=>(await(await page.request.get('/admin/api/conversations/'+id)).json()).execution;

test('same-model inherited reasoning names the effective global effort in selection and dropdown',async({page})=>{
  const conversation=await setup(page);
  await expect(effort(page)).toContainText('默认：medium');await expect(effort(page)).not.toContainText('自动');
  await page.locator('#chat-reasoningEffort').click();await expect(page.locator('.ant-select-dropdown:visible').getByText('继承全局设置：medium',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  expect(await saved(page,conversation.id)).toEqual({});
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible').getByText('English',{exact:true}).click();
  await expect(effort(page)).toContainText('Default: medium');await page.locator('#chat-reasoningEffort').click();await expect(page.locator('.ant-select-dropdown:visible').getByText('Inherit global settings: medium',{exact:true})).toBeVisible();
});

test('explicit chat effort stays visible and choosing inheritance removes the override without materializing the default',async({page})=>{
  const conversation=await setup(page,{execution:{reasoningEffort:'high'}});
  await expect(effort(page)).toContainText('high');await expect(effort(page)).not.toContainText('默认：');
  await choose(page,'#chat-reasoningEffort','继承全局设置：medium');await expect(effort(page)).toContainText('默认：medium');await expect.poll(()=>saved(page,conversation.id)).toEqual({});
  await choose(page,'#chat-reasoningEffort','high');await expect(effort(page)).toContainText('high');await expect.poll(()=>saved(page,conversation.id)).toEqual({reasoningEffort:'high'});
});

test('choosing another model uses that model default and preserves an omitted reasoning override',async({page})=>{
  const conversation=await setup(page);
  await choose(page,'#chat-model','Fixture Fast');await expect(effort(page)).toContainText('默认：high');await expect(effort(page)).not.toContainText('medium');
  await page.locator('#chat-reasoningEffort').click();await expect(page.locator('.ant-select-dropdown:visible').getByText('所选模型默认：high',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await expect.poll(()=>saved(page,conversation.id)).toEqual({model:'fixture-fast'});
});

test('null global effort uses catalog default while unknown model defaults stay readable',async({page})=>{
  const conversation=await setup(page,{globalEffort:null});await expect(effort(page)).toContainText('默认：low');
  await choose(page,'#chat-model','Fixture Unknown');await expect(effort(page)).toContainText('默认：模型默认');
  await expect.poll(()=>saved(page,conversation.id)).toEqual({model:'fixture-unknown-default'});
});

test('an explicit null chat effort keeps the model-default choice separate from inherited global effort',async({page})=>{
  const conversation=await setup(page,{execution:{reasoningEffort:null}});await expect(effort(page)).toContainText('模型默认');await expect(effort(page)).not.toContainText('medium');expect(await saved(page,conversation.id)).toEqual({reasoningEffort:null});
});
