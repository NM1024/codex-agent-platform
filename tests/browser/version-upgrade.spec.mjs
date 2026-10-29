import {test,expect} from '@playwright/test';

const latest={current:'1.2.3',latest:'1.3.0',update_available:true,release_url:'https://github.com/NM1024/codex-agent-platform/releases/tag/v1.3.0',checked_at:1792800000000};
const job=(state='running',phase='building')=>({id:'synthetic-upgrade',state,phase,started_at:1792800000000,updated_at:1792800001000,target_version:'1.3.0',...(state==='succeeded'?{installed_version:'1.3.0'}:{})});
const dialog=page=>page.getByRole('dialog').filter({has:page.locator('#version-dialog-content')});
async function setup(page,{available=false,current='1.2.3',locale='zh-CN'}={}){
  await page.addInitScript(value=>localStorage.setItem('agent-console-language',value),locale);
  await page.route('**/admin/api/version',route=>route.fulfill({json:{current}}));
  await page.route('**/admin/api/version/latest',route=>route.fulfill({json:latest}));
  await page.route('**/admin/api/upgrade',route=>route.fulfill({json:{available,job:null}}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.locator('#login button[type=submit]').click();await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#version-entry')).toHaveText('v'+current);
}

test('running version precedes repository and unavailable host gives honest setup and copyable stable update command',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedVersionCommand=text;}}}));
  await setup(page);expect(await page.locator('#version-entry').evaluate(node=>Boolean(node.parentElement.nextElementSibling?.querySelector('#repository-link')))).toBe(true);
  await page.locator('#version-entry').click();const panel=dialog(page);await expect(panel).toContainText('当前运行版本');await expect(panel).toContainText('1.2.3');
  await expect(panel).toContainText('enable-web-update');await expect(panel.locator('#version-upgrade')).toBeDisabled();
  await panel.locator('#version-check').click();await expect(panel).toContainText('1.3.0');
  await expect(panel.locator('#version-release')).toHaveAttribute('href',latest.release_url);await expect(panel.locator('#version-update-command')).toContainText('releases/latest/download/update.sh');
  await expect(panel.locator('#version-upgrade')).toBeDisabled();
  await panel.getByRole('button',{name:'复制更新命令',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.copiedVersionCommand)).toContain('sudo bash /tmp/codex-platform-update.sh update');
});

test('version dialog keeps header and actions reachable at 320px in both languages',async({page})=>{
  await setup(page,{locale:'en'});
  for(const locale of ['en','zh-CN']){
    await page.setViewportSize({width:1440,height:1000});await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible').getByText(locale==='en'?'English':'简体中文',{exact:true}).click();
    for(const viewport of [{width:1440,height:1000},{width:320,height:568},{width:844,height:390}]){
      await page.setViewportSize(viewport);await expect(page.locator('#version-entry')).toBeInViewport({ratio:1});await expect(page.locator('#page-title')).toBeVisible();
      await page.locator('#version-entry').click();const panel=dialog(page);await expect(panel).toContainText(locale==='en'?'Version & updates':'版本与更新');
      await expect(panel.locator('#version-check')).toBeInViewport({ratio:1});await expect(panel.locator('#version-upgrade')).toBeInViewport({ratio:1});
      expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);await page.screenshot({path:`.tmp/version-upgrade/${locale}-${viewport.width}.png`,animations:'disabled'});
      await panel.getByRole('button',{name:locale==='en'?'Close':'关闭',exact:true}).last().click();
    }
  }
});

test('real upgrade requires checking and maintenance confirmation then reconnects to durable status through 503 and network failure',async({page})=>{
  await setup(page,{available:true});let polls=0,started=false;
  await page.route('**/admin/api/upgrade',async route=>{
    if(route.request().method()==='POST'){expect(route.request().postDataJSON()).toEqual({});started=true;return route.fulfill({status:202,json:{available:true,job:job('queued','queued')}});}
    if(!started)return route.fulfill({json:{available:true,job:null}});
    polls++;if(polls===1)return route.fulfill({status:503,json:{error:{message:'Manager restarting'}}});if(polls===2)return route.abort('connectionrefused');
    return route.fulfill({json:{available:true,job:job('succeeded','completed')}});
  });
  await page.locator('#version-entry').click();const panel=dialog(page);await expect(panel.locator('#version-upgrade')).toBeDisabled();
  await panel.locator('#version-check').click();await expect(panel.locator('#version-upgrade')).toBeEnabled();await panel.locator('#version-upgrade').click();
  await expect(panel).toContainText('维护期间服务会短暂中断');expect(started).toBe(false);await panel.locator('#version-confirm-upgrade').click();
  await expect.poll(()=>started).toBe(true);await expect(panel).toContainText('正在重新连接');await expect(panel).toContainText('升级完成',{timeout:15000});await expect(panel.getByRole('button',{name:'刷新界面',exact:true})).toBeVisible();
  await expect(panel).toContainText('1.3.0');expect(polls).toBeGreaterThanOrEqual(3);
  const refreshed=page.waitForEvent('framenavigated',frame=>frame===page.mainFrame());
  await panel.getByRole('button',{name:'刷新界面',exact:true}).click();await refreshed;await expect(page.locator('#workspace')).toBeVisible();
});

test('closing the dialog and signing out stop status polling and a 401 signs out instead of reconnecting',async({page})=>{
  await setup(page,{available:true});let reads=0,expired=false;
  await page.route('**/admin/api/upgrade',route=>{reads++;return route.fulfill(expired?{status:401,json:{error:{message:'expired'}}}:{json:{available:true,job:job()}});});
  await page.locator('#version-entry').click();await expect(dialog(page)).toContainText('正在构建');await dialog(page).getByRole('button',{name:'关闭',exact:true}).last().click();
  const closedReads=reads;await page.waitForTimeout(2300);expect(reads).toBe(closedReads);
  expired=true;await page.locator('#version-entry').click();await expect(page.locator('#login')).toBeVisible();const loggedOutReads=reads;await page.waitForTimeout(2300);expect(reads).toBe(loggedOutReads);
});

test('unreadable current version stays unknown and latest failure preserves the actual running version',async({page})=>{
  await setup(page);await page.route('**/admin/api/version/latest',route=>route.fulfill({status:503,json:{error:{message:'upstream unavailable'}}}));
  await page.locator('#version-entry').click();await dialog(page).locator('#version-check').click();await expect(dialog(page)).toContainText('暂时无法检查最新版本');await expect(dialog(page)).toContainText('1.2.3');
  await dialog(page).getByRole('button',{name:'关闭',exact:true}).last().click();await page.locator('#logout').click();
  await page.route('**/admin/api/version',route=>route.fulfill({status:503,json:{error:{message:'unavailable'}}}));await page.locator('#password').fill('local-browser-password');await page.locator('#login button[type=submit]').click();await expect(page.locator('#version-entry')).toHaveText('?');
});

test('a temporarily missing helper preserves a known active job and resumes polling',async({page})=>{
  await setup(page,{available:true});let reads=0;
  await page.route('**/admin/api/version',route=>route.fulfill({json:{current:'1.2.4'}}));
  await page.route('**/admin/api/upgrade',route=>{reads++;return route.fulfill({json:reads===2?{available:false,job:null,error_code:'UPDATER_UNAVAILABLE'}:{available:true,job:reads>=3?job('interrupted','interrupted'):job()}});});
  await page.locator('#version-entry').click();await expect(dialog(page)).toContainText('正在构建');
  await expect(dialog(page)).toContainText('正在重新连接',{timeout:5000});await expect(dialog(page)).toContainText('目标版本');
  await expect(dialog(page)).toContainText('升级已中断',{timeout:7000});expect(reads).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#version-entry')).toHaveText('v1.2.4');
});

test('cold sign-in defers both version chunks and the dialog stays deferred until opened',async({browser})=>{
  const context=await browser.newContext(),page=await context.newPage();const scripts=[];
  page.on('response',response=>{if(/\/admin\/assets\/.*\.js$/.test(response.url()))scripts.push(response);});
  try{
    await page.goto('/admin/');await expect(page.locator('#password')).toBeVisible();expect(scripts.some(response=>/Version(Entry|Dialog)-/.test(response.url()))).toBe(false);
    expect(scripts.reduce((sum,response)=>sum+Number(response.headers()['content-length']),0)).toBeLessThan(260000);
    await page.locator('#password').fill('local-browser-password');await page.locator('#login button[type=submit]').click();await expect(page.locator('#version-entry')).toBeVisible();
    expect(scripts.some(response=>/VersionEntry-/.test(response.url()))).toBe(true);expect(scripts.some(response=>/VersionDialog-/.test(response.url()))).toBe(false);
    await page.locator('#version-entry').click();await expect(dialog(page)).toBeVisible();expect(scripts.some(response=>/VersionDialog-/.test(response.url()))).toBe(true);
  }finally{await context.close();}
});
