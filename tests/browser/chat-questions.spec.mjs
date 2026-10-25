import {navigate} from './navigation.mjs';
import {test,expect} from '@playwright/test';
const stamp=Date.now(),id='33333333-3333-4333-8333-333333333333';
const question={id:'44444444-4444-4444-8444-444444444444',status:'pending',created_at:stamp,questions:[{id:'format',header:'Format',question:'请选择输出格式',isOther:true,options:[{label:'JSON',description:'结构化结果'},{label:'Text',description:'普通文本'}]}]};
const user={id:'user',role:'user',text:'Synthetic clarification',status:'running',created_at:stamp,started_at:stamp,replies:[{id:'progress',text:'我先核对配置。',status:'completed',created_at:stamp},{id:'final',text:'请选择输出格式。',status:'completed',created_at:stamp+1}],questions:[question]};
const conversation={id,title:'Synthetic questions',execution:{},messages:[user],actions:[]};
async function setup(page,current=conversation){
  await page.addInitScript(()=>{window.chatSources=[];window.EventSource=class extends EventTarget {constructor(){super();window.chatSources.push(this);}close(){}};window.updateChat=data=>window.chatSources.at(-1).dispatchEvent(new MessageEvent('conversation',{data:JSON.stringify(data)}));});
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:[current]}));
  await page.route('**/admin/api/conversations/'+id,route=>route.fulfill({json:current}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText(conversation.title);
}

test('distinct public assistant messages persist across finalization without duplicating the final reply',async({page})=>{
  await setup(page);await expect(page.locator('.assistant')).toHaveCount(2);
  await page.evaluate(data=>window.updateChat(data),{...conversation,messages:[{...user,status:'completed',questions:[]},{id:'stored-final',reply_to:'user',role:'assistant',status:'completed',text:'请选择输出格式。',created_at:stamp+2}]});
  await expect(page.locator('.assistant')).toHaveCount(2);await expect(page.locator('.assistant').first()).toContainText('我先核对配置。');
  await expect(page.locator('.assistant').last()).toContainText('请选择输出格式。');await expect(page.locator('.message-progress')).toHaveCount(1);
});

test('active question drafts survive navigation away and back',async({page})=>{
  await setup(page);const card=page.locator('.question-card');
  await card.getByRole('radio',{name:'其他',exact:true}).check();await card.getByLabel('补充回答').fill('Keep this draft');
  await navigate(page,'plugins');await navigate(page,'chat');
  await expect(card.getByLabel('补充回答')).toHaveValue('Keep this draft');
  await page.evaluate(data=>window.updateChat(data),{...conversation,messages:[{...user,replies:[...user.replies,{id:'additional',text:'Additional public progress',status:'completed',created_at:stamp+2}]}]});
  await expect(card.getByLabel('补充回答')).toHaveValue('Keep this draft');
});

test('prototype-named IDs support separate free text answers without crashing chat',async({page})=>{
  const ids=['constructor','toString','__proto__'];
  await setup(page,{...conversation,messages:[{...user,questions:[{...question,questions:ids.map((id,index)=>({id,header:'Question '+index,question:'Provide an answer '+index,isOther:false,options:[]}))}]}]});
  const card=page.locator('.question-card');
  for(const [index,id] of ids.entries())await card.getByLabel('补充回答').nth(index).fill(id+' answer');
  let saved;await page.route('**/questions/*/answer',route=>{saved=route.request().postDataJSON();return route.fulfill({json:{status:'answered'}});});
  await card.getByRole('button',{name:'提交回答',exact:true}).click();await expect(card).toContainText('已回答');
  expect(saved.answers).toEqual(Object.fromEntries(ids.map(id=>[id,{answers:[id+' answer']}])));
});

test('question card requires an explicit answer, submits once to its original turn and retains input after failure',async({page})=>{
  await setup(page);await page.setViewportSize({width:390,height:844});
  const card=page.locator('.question-card'),submit=card.getByRole('button',{name:'提交回答',exact:true});
  await expect(submit).toBeDisabled();await card.getByRole('radio',{name:'其他',exact:true}).check();await card.getByLabel('补充回答').fill('CSV please');
  await page.screenshot({path:'.tmp/chat-question-phone.png',animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.tmp/chat-question-desktop.png',animations:'disabled'});await page.setViewportSize({width:390,height:844});
  let count=0,release;const gate=new Promise(r=>release=r);
  await page.route('**/questions/*/answer',async route=>{count++;expect(route.request().postDataJSON()).toEqual({answers:{format:{answers:['CSV please']}}});await gate;await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE'}}});});
  await submit.click();await expect(submit).toHaveClass(/ant-btn-loading/);await submit.dispatchEvent('click');expect(count).toBe(1);
  await navigate(page,'plugins');await navigate(page,'chat');
  await expect(submit).toHaveClass(/ant-btn-loading/);await submit.dispatchEvent('click');expect(count).toBe(1);release();
  await expect(card.getByRole('alert')).toBeVisible();await expect(card.getByLabel('补充回答')).toHaveValue('CSV please');
  await page.unroute('**/questions/*/answer');await page.route('**/questions/*/answer',route=>route.fulfill({json:{id:question.id,status:'answered'}}));
  await submit.click();await expect(card).toContainText('已回答');await expect(submit).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
