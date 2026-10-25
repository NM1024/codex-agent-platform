import {test,expect} from '@playwright/test';
import {openChatPicker,chatPicker,chooseChatModel,chooseChatEffort} from './agent-picker.mjs';

const catalog={models:[{model:'gpt-6.1-sol',displayName:'Fixture Default',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{model:'fixture-fast',displayName:'Fixture Fast',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'fixture-unknown-default',displayName:'Fixture Unknown',supportedReasoningEfforts:[]}]};
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

test('same-model inherited reasoning names the effective global effort in the unified picker',async({page})=>{
  const conversation=await setup(page);await openChatPicker(page);
  await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','medium');await expect(chatPicker(page).locator('#chat-reasoning-source')).toHaveText('继承全局设置');
  expect(await saved(page,conversation.id)).toEqual({});await page.keyboard.press('Escape');
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();await openChatPicker(page);
  await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','medium');await expect(chatPicker(page).locator('#chat-reasoning-source')).toHaveText('Inherit global settings');
});

test('explicit chat effort stays visible and reset removes the override without materializing the default',async({page})=>{
  const conversation=await setup(page,{execution:{reasoningEffort:'high'}});await openChatPicker(page);
  await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','high');await page.keyboard.press('Escape');
  await chooseChatEffort(page,'__inherit__');await expect.poll(()=>saved(page,conversation.id)).toEqual({});
  await openChatPicker(page);await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','medium');await page.keyboard.press('Escape');
  await chooseChatEffort(page,'high');await expect.poll(()=>saved(page,conversation.id)).toEqual({reasoningEffort:'high'});
});

test('choosing another model uses that model default and preserves an omitted reasoning override',async({page})=>{
  const conversation=await setup(page);await chooseChatModel(page,'Fixture Fast');await openChatPicker(page);
  await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','high');await expect(chatPicker(page).locator('#chat-reasoning-source')).toHaveText('所选模型默认');
  await expect.poll(()=>saved(page,conversation.id)).toEqual({model:'fixture-fast'});
});

test('null global effort uses catalog default while unknown model defaults stay readable',async({page})=>{
  const conversation=await setup(page,{globalEffort:null});await openChatPicker(page);await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','low');await page.keyboard.press('Escape');
  await chooseChatModel(page,'Fixture Unknown');await openChatPicker(page);await expect(chatPicker(page).getByRole('slider')).toHaveCount(0);await expect(chatPicker(page).locator('.chat-effort-heading strong')).toHaveText('default');
  await expect.poll(()=>saved(page,conversation.id)).toEqual({model:'fixture-unknown-default'});
});

test('an explicit null chat effort keeps the model-default choice separate from inherited global effort',async({page})=>{
  const conversation=await setup(page,{execution:{reasoningEffort:null}});await openChatPicker(page);
  await expect(chatPicker(page).getByRole('slider')).toHaveAttribute('aria-valuetext','low');await expect(chatPicker(page).locator('#chat-reasoning-source')).toHaveText('模型默认');expect(await saved(page,conversation.id)).toEqual({reasoningEffort:null});
});
