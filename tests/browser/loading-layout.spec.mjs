import {test,expect} from '@playwright/test';

const sizes=[{width:1440,height:1000},{width:390,height:844},{width:844,height:390}];
const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function language(page,en){await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible').getByText(en?'English':'简体中文',{exact:true}).click();}
async function centered(loader,region,label){
  await expect(loader).toBeVisible();
  await expect.poll(async()=>{
    const target=await region.evaluate(el=>{const box=el.getBoundingClientRect(),css=getComputedStyle(el),left=parseFloat(css.paddingLeft),right=parseFloat(css.paddingRight),top=parseFloat(css.paddingTop),bottom=parseFloat(css.paddingBottom);return {x:box.x+parseFloat(css.borderLeftWidth)+left+(el.clientWidth-left-right)/2,y:box.y+parseFloat(css.borderTopWidth)+top+(el.clientHeight-top-bottom)/2};});
    const point=await loader.evaluate(el=>{
    const boxes=[...el.querySelectorAll('.ant-spin')].map(node=>node.getBoundingClientRect());
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim()||node.parentElement.closest('style,script'))continue;const range=document.createRange();range.selectNodeContents(node);boxes.push(...range.getClientRects());}
    return {x:(Math.min(...boxes.map(box=>box.left))+Math.max(...boxes.map(box=>box.right)))/2,y:(Math.min(...boxes.map(box=>box.top))+Math.max(...boxes.map(box=>box.bottom)))/2};
    });return Math.max(Math.abs(point.x-target.x),Math.abs(point.y-target.y));
  },{message:label+' should center its visible indicator and label'}).toBeLessThanOrEqual(3);
}
async function matrix(page,check){for(const en of [false,true]){await page.setViewportSize(sizes[0]);await expect(page.locator('.mobile-navigation')).toHaveCount(0);await language(page,en);for(const size of sizes){await page.setViewportSize(size);await expect(page.locator('.mobile-navigation')).toHaveCount(size.width<992?1:0);await check(`${en?'en':'zh'} ${size.width}x${size.height}`);}}}

for(const view of ['overview','plugins','schedules','tasks','settings'])test(`${view} initial data loading is centered in the page content`,async({page})=>{
  await login(page);await page.locator('[data-view="chat"]').click();await expect(page.locator('.chat-main')).toBeVisible();
  const gate=deferred();
  if(view==='settings')await page.route('**/admin/api/operations',async route=>{if(route.request().postDataJSON()?.action==='configuration_list')await gate.promise;await route.continue();});
  else await page.route(`**/admin/api/${view==='overview'?'overview':view==='tasks'?'tasks?*':view}`,async route=>{await gate.promise;await route.continue();});
  try{
    await page.locator(`[data-view="${view}"]`).click();
    await matrix(page,async label=>{await centered(page.locator('.page-loading'),page.locator('.console-content'),view+' '+label);if(label==='zh 1440x1000')await page.screenshot({path:`.tmp/loading-layout/${view}.png`,animations:'disabled'});});
  }finally{gate.release();}
  await expect(page.locator('.page-loading')).toHaveCount(0);
});

test('lazy page loading is centered below the header',async({page})=>{
  const gate=deferred();await page.route('**/admin/assets/SchedulesPage-*.js',async route=>{await gate.promise;await route.continue();});
  await login(page);
  try{await page.locator('[data-view="schedules"]').click();await matrix(page,label=>centered(page.locator('.page-loading'),page.locator('.console-content'),'lazy page '+label));}
  finally{gate.release();}
  await expect(page.locator('.page-loading')).toHaveCount(0);
});

test('conversation list and transcript loaders each center in their own available area',async({page})=>{
  test.setTimeout(45000);
  page.setDefaultTimeout(5000);
  const list=deferred(),detail=deferred(),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',conversation={id,title:'Synthetic loading conversation',execution:{},messages:[],actions:[]};
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{close(){}};});
  await page.route('**/admin/api/conversations',async route=>{await list.promise;await route.fulfill({json:{items:[conversation],next_cursor:null}});});
  await page.route('**/admin/api/conversations/'+id,async route=>{await detail.promise;await route.fulfill({json:conversation});});
  await login(page);
  try{
    await page.locator('[data-view="chat"]').click();
    await matrix(page,async label=>test.step('sidebar '+label,async()=>{
      const mobile=page.viewportSize().width<992;
      if(mobile)await page.locator('.conversation-toggle').click();
      const scope=page.locator(mobile?'.conversation-drawer':'.conversation-sidebar');
      await centered(scope.locator('.conversation-list-loading'),scope.locator('.conversation-list'),'conversation list '+label);
      if(label==='zh 1440x1000')await page.screenshot({path:'.tmp/loading-layout/chat.png',animations:'disabled'});
      if(mobile){await scope.getByRole('button',{name:/^(关闭|Close)$/}).click();await expect(scope).not.toBeVisible();}
    }));
    list.release();await expect(page.locator('.chat-header')).toContainText(conversation.title);
    await matrix(page,label=>centered(page.locator('.chat-loading'),page.locator('#messages'),'transcript '+label));
  }finally{list.release();detail.release();}
  await expect(page.locator('.chat-loading')).toHaveCount(0);
});

for(const kind of ['connection','integration'])test(`${kind} loading stays centered in its dialog or drawer`,async({page})=>{
  await login(page);await page.locator('[data-view="plugins"]').click();await expect(page.getByRole('row').filter({hasText:'content.review'})).toBeVisible();
  const gate=deferred();await page.route(kind==='connection'?'**/admin/api/plugins/content.review/connection':'**/admin/api/plugins/content.review/integration?*',async route=>{await gate.promise;await route.continue();});
  try{
    for(const en of [false,true]){
      await page.setViewportSize(sizes[0]);await language(page,en);
      await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:kind==='connection'?(en?'Configure connection':'配置接入'):(en?'Integration docs':'对接文档'),exact:true}).click();
      const region=page.locator(kind==='connection'?'.plugin-connection-modal .ant-modal-body':'.plugin-integration-drawer .ant-drawer-body');
      for(const size of sizes){await page.setViewportSize(size);await expect(page.locator('.mobile-navigation')).toHaveCount(size.width<992?1:0);await centered(region.locator('.integration-loading'),region,`${kind} ${en?'en':'zh'} ${size.width}x${size.height}`);}
      await page.getByRole('dialog').getByRole('button',{name:kind==='connection'?(en?'Cancel':'取消'):/^(关闭|Close)$/,exact:kind==='connection'}).click();
    }
  }finally{gate.release();}
  await expect(page.locator('.integration-loading')).toHaveCount(0);
});
