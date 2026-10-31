import {selectSettingsCategory} from './settings-navigation.mjs';
import {test,expect} from '@playwright/test';

const viewports=[{width:2267,height:1273},{width:1366,height:768},{width:390,height:844},{width:320,height:568},{width:844,height:390}];
const kinds=['connection','plugin-delete','schedule-delete','http-editor','http-delete','chat-delete'];
async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});
  expect(response.ok()).toBeTruthy();return response.json();
}
async function centered(page,dialog,label) {
  const viewport=page.viewportSize();
  await expect.poll(async()=>{
    const box=await dialog.boundingBox();
    return box?Math.max(Math.abs(box.x+box.width/2-viewport.width/2),Math.abs(box.y+box.height/2-viewport.height/2)):Infinity;
  },{message:label+' must be centered in the viewport'}).toBeLessThanOrEqual(2);
  const box=await dialog.boundingBox();
  expect(box.x,label).toBeGreaterThanOrEqual(7);expect(box.y,label).toBeGreaterThanOrEqual(7);
  expect(box.x+box.width,label).toBeLessThanOrEqual(viewport.width-7);
  expect(box.y+box.height,label).toBeLessThanOrEqual(viewport.height-7);
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),label+' horizontal overflow').toBe(true);
  await expect(dialog.locator('.ant-modal-footer button').last()).toBeInViewport({ratio:1});
  await dialog.locator('.ant-modal-footer button').first().click({trial:true});
}

for(const kind of kinds)test(`${kind} modal stays centered with reachable actions across locales and viewport sizes`,async({page})=>{
  test.setTimeout(60000);await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();
  const chatTitle='Synthetic modal layout conversation';
  if(kind==='chat-delete')expect((await page.request.post('/admin/api/conversations',{data:{title:chatTitle}})).ok()).toBeTruthy();
  if(kind==='http-delete'){
    const group=await operation(page,'configuration_get',{scope:'http_targets'});
    await operation(page,'configuration_update',{scope:'http_targets',revision:group.revision,patch:{targets:{...group.values.targets,modal_layout:{url:'https://example.invalid/health'}}}});
  }
  for(const locale of ['zh-CN','en']){
    await page.setViewportSize(viewports[0]);
    await page.locator('#app-language').click();
    await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText(locale==='en'?'English':'简体中文',{exact:true}).click();
    const en=locale==='en',view=kind.startsWith('http')?'settings':kind==='chat-delete'?'chat':kind==='schedule-delete'?'schedules':'plugins';
    await page.locator(`[data-view="${view}"]`).click();
    if(view==='settings')await selectSettingsCategory(page,'http_targets');
    if(kind==='connection')await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:en?'Configure connection':'配置接入',exact:true}).click();
    else if(kind==='plugin-delete')await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:/^(删除业务插件：|Delete plugin:)/}).click();
    else if(kind==='schedule-delete')await page.getByRole('row').filter({hasText:'每日运行巡检'}).getByRole('button',{name:/^(删除定时计划：|Delete schedule:)/}).click();
    else if(kind==='http-editor')await page.getByRole('button',{name:en?'Add HTTP target':'新增 HTTP 目标',exact:true}).click();
    else if(kind==='http-delete')await page.getByRole('row').filter({hasText:'modal_layout'}).getByRole('button',{name:/^(删除 HTTP 目标：|Delete HTTP target:)/}).click();
    else await page.locator('.conversation-sidebar').getByRole('button',{name:(en?'Delete conversation: ':'删除对话：')+chatTitle,exact:true}).click();
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    if(kind==='connection')await expect(page.locator('#plugin-entry-address')).toBeEnabled();
    for(const viewport of viewports){
      await page.setViewportSize(viewport);
      await centered(page,dialog,`${kind} ${locale} ${viewport.width}x${viewport.height}`);
      if(viewport.width===2267)await page.screenshot({path:`.tmp/modal-layout/${process.env.MODAL_CAPTURE_STAGE??'verified'}-${kind}-${locale}.png`,animations:'disabled'});
      if(kind==='connection'){
        await dialog.getByRole('tab',{name:en?'Result callback':'结果回调',exact:false}).click();
        await dialog.getByText(en?'How callbacks work':'回调如何工作',{exact:true}).click();
        await centered(page,dialog,`expanded callback ${locale} ${viewport.width}x${viewport.height}`);
        await dialog.getByText(en?'How callbacks work':'回调如何工作',{exact:true}).click();
        await dialog.getByRole('tab',{name:en?'Entry settings':'入口配置',exact:true}).click();
      }
    }
    await dialog.getByRole('button',{name:en?'Cancel':'取消',exact:true}).click();await expect(dialog).toHaveCount(0);
  }
});
