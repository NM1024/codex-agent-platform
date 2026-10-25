import {test,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';

const plugins=[{type:'content.review',name:'文本审核',enabled:true,connection:{ready:true},revision:3},{type:'novel.illustrated',name:'图文小说',enabled:false,connection:{ready:false},revision:4}];
const headings={'zh-CN':['概览','请求参数','响应与查询','回调协议','错误与排查'],en:['Overview','Request','Response & polling','Callback','Errors']};
function document(type,locale='zh-CN'){
  const sections=['overview','request','response','callback','errors'].map((key,index)=>({key,title:headings[locale][index],markdown:`## ${headings[locale][index]}\n\n${type} ${locale} ${key}\n\n`+(key==='request'?'| field | description |\n| --- | --- |\n| input.nested.value | A business field |\n\n```json\n{"type":"'+type+'","input":{"value":"synthetic"}}\n```\n\n<img src=x onerror="window.integrationInjected=true">':'')}));
  return {type,name:plugins.find(plugin=>plugin.type===type).name,revision:type==='content.review'?3:4,connectionRevision:2,locale,ready:type==='content.review',generated_at:1792800000000,sections,markdown:sections.map(section=>section.markdown).join('\n')};
}
const row=(page,type)=>page.getByRole('row').filter({hasText:type});
const drawer=page=>page.getByRole('dialog');
async function open(page,type){await row(page,type).getByRole('button',{name:/^(对接文档|Integration docs)$/}).click();}
async function chooseEnglish(page){await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();await expect(page.locator('#view-title')).toHaveText('Business plugins');}
test.beforeEach(async({page})=>{
  await page.route('**/admin/api/plugins',route=>route.fulfill({json:{configured:plugins}}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();
  await page.locator('[data-view="plugins"]').click();
});

test('integration docs are separate from connection setup and render readonly current plugin sections',async({page})=>{
  await page.route('**/integration?*',route=>route.fulfill({json:document('content.review')}));
  await expect(row(page,'content.review').getByRole('button',{name:'配置接入',exact:true})).toBeVisible();
  await open(page,'content.review');
  await expect(drawer(page)).toContainText('文本审核');await expect(drawer(page)).toContainText('content.review');
  await expect(drawer(page)).toContainText('业务定义版本3');await expect(drawer(page)).toContainText('接入配置版本2');
  for(const label of headings['zh-CN'])await expect(drawer(page).getByRole('tab',{name:label,exact:true})).toBeVisible();
  await drawer(page).getByRole('tab',{name:'请求参数',exact:true}).click();
  await expect(drawer(page).getByRole('tabpanel')).toContainText('input.nested.value');
  await expect(drawer(page).locator('pre')).toContainText('synthetic');
  await expect(drawer(page).locator('img')).toHaveCount(0);expect(await page.evaluate(()=>window.integrationInjected)).toBeUndefined();
  await expect(drawer(page).getByRole('button',{name:/试运行|执行|保存/})).toHaveCount(0);
});

test('loading and failures stay inside the drawer and retry loads documentation',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let attempt=0;
  await page.route('**/integration?*',async route=>{attempt++;if(attempt===1){await gate;await route.fulfill({status:503,json:{error:{message:'synthetic failure'}}});}else await route.fulfill({json:document('content.review')});});
  await open(page,'content.review');await expect(drawer(page).getByRole('status')).toContainText('正在加载对接文档');
  await expect(drawer(page).getByRole('button',{name:'复制 Markdown',exact:true})).toHaveCount(0);
  release();await expect(drawer(page).getByRole('alert')).toContainText('对接文档暂时无法读取');
  await drawer(page).getByRole('button',{name:'重试',exact:true}).click();await expect(drawer(page).getByRole('tab',{name:'请求参数',exact:true})).toBeVisible();
});

test('closing and selecting another plugin ignores late documents and resets visible content',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/integration?*',async route=>{const type=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));if(type==='content.review')await gate;await route.fulfill({json:document(type)});});
  await open(page,'content.review');await drawer(page).getByRole('button',{name:/^(关闭|Close)$/}).click();
  await open(page,'novel.illustrated');await expect(drawer(page)).toContainText('novel.illustrated zh-CN overview');
  release();await page.waitForTimeout(150);await expect(drawer(page)).not.toContainText('content.review');
  await expect(drawer(page)).toContainText('请先通过「配置接入」');
  await drawer(page).getByRole('button',{name:'配置接入',exact:true}).click();
  await expect(page.locator('#plugin-entry-address')).toBeVisible();
});

test('locale changes reload translated documentation and ignore a late previous language',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/integration?*',async route=>{const locale=new URL(route.request().url()).searchParams.get('locale');if(locale==='zh-CN')await gate;await route.fulfill({json:document('content.review',locale)});});
  await open(page,'content.review');await drawer(page).getByRole('button',{name:/^(关闭|Close)$/}).click();await chooseEnglish(page);await open(page,'content.review');await expect(drawer(page).getByRole('tab',{name:'Request',exact:true})).toBeVisible();
  release();await page.waitForTimeout(150);await expect(drawer(page)).toContainText('content.review en overview');await expect(drawer(page).getByRole('tab',{name:'概览',exact:true})).toHaveCount(0);
});

test('copy code, full Markdown and download use the selected plugin while clipboard failure is honest',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.route('**/integration?*',route=>route.fulfill({json:document(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)))}));
  await open(page,'content.review');await drawer(page).getByRole('tab',{name:'请求参数',exact:true}).click();
  await drawer(page).getByRole('button',{name:'复制代码',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('"type":"content.review"');
  await drawer(page).getByRole('button',{name:'复制 Markdown',exact:true}).click();expect((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n')).toBe(document('content.review').markdown);
  await drawer(page).getByRole('button',{name:/^(关闭|Close)$/}).click();await open(page,'novel.illustrated');
  const downloadPromise=page.waitForEvent('download');await drawer(page).getByRole('button',{name:'下载 Markdown',exact:true}).click();const download=await downloadPromise;
  expect(download.suggestedFilename()).toBe('novel.illustrated-integration-zh-CN.md');await mkdir('.tmp/plugin-docs',{recursive:true});await download.saveAs('.tmp/plugin-docs/'+download.suggestedFilename());expect(await readFile('.tmp/plugin-docs/'+download.suggestedFilename(),'utf8')).toBe(document('novel.illustrated').markdown);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Denied');}},configurable:true}));
  await drawer(page).getByRole('button',{name:'复制 Markdown',exact:true}).click();await expect(drawer(page).getByRole('status')).toContainText('复制失败');await expect(drawer(page).getByRole('status')).not.toContainText('已复制');
});

test('desktop and phone documentation keep actions and scrollable content inside viewport',async({page})=>{
  await page.route('**/integration?*',route=>route.fulfill({json:document('content.review')}));
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});await open(page,'content.review');await drawer(page).getByRole('tab',{name:'请求参数',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const bounds=await drawer(page).boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
    for(const label of ['复制 Markdown','下载 Markdown']){const bounds=await drawer(page).getByRole('button',{name:label,exact:true}).boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);}
    await page.screenshot({path:'.tmp/plugin-docs/integration-'+width+'.png',animations:'disabled'});await drawer(page).getByRole('button',{name:/^(关闭|Close)$/}).click();
  }
});

test('real endpoint renders each saved business contract and exports its own current Markdown',async({page})=>{
  for(const [type,inputField,resultField,otherField,description] of [['content.review','criteria','approved','premise','本次审核标准'],['novel.illustrated','premise','text_artifact_id','approved','故事梗概']]){
    const response=await page.request.get('/admin/api/plugins/'+encodeURIComponent(type)+'/integration?locale=zh-CN');
    expect(response.ok()).toBeTruthy();const actual=await response.json();
    expect(actual.markdown).toContain(type);expect(actual.markdown).not.toContain('synthetic-browser-key');
    await open(page,type);
    const overviewTable=drawer(page).getByRole('tabpanel').locator('table').first();
    await expect(overviewTable).toBeVisible();await expect(overviewTable).toContainText('POST');await expect(overviewTable).toContainText('GET');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await page.screenshot({path:'.tmp/plugin-docs/actual-overview-'+type+'-'+width+'.png',animations:'disabled'});
    }
    await drawer(page).getByRole('tab').nth(1).click();
    await expect(drawer(page).getByRole('tabpanel').locator('table').filter({hasText:inputField}).last()).toBeVisible();await expect(drawer(page).getByRole('tabpanel')).not.toContainText(otherField);
    await drawer(page).getByRole('tab').nth(2).click();await expect(drawer(page).getByRole('tabpanel').locator('table').filter({hasText:resultField}).last()).toBeVisible();
    await drawer(page).getByRole('tab').nth(4).click();
    const errorsTable=drawer(page).getByRole('tabpanel').locator('table').first();
    await expect(errorsTable).toBeVisible();await expect(errorsTable).toContainText('404');await expect(errorsTable).toContainText('NOT_FOUND');
    await drawer(page).getByRole('tab').nth(1).click();
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({path:'.tmp/plugin-docs/actual-'+type+'-'+width+'.png',animations:'disabled'});
    }
    const schemaTable=drawer(page).getByRole('tabpanel').locator('table').filter({hasText:inputField}).last();
    await expect(schemaTable).toContainText(description);await schemaTable.scrollIntoViewIfNeeded();
    await schemaTable.evaluate(element=>{element.scrollLeft=150;});
    await page.screenshot({path:'.tmp/plugin-docs/actual-request-descriptions-'+type+'-390.png',animations:'disabled'});
    const pending=page.waitForEvent('download');await drawer(page).getByRole('button',{name:'下载 Markdown',exact:true}).click();const download=await pending;
    await mkdir('.tmp/plugin-docs',{recursive:true});const path='.tmp/plugin-docs/real-'+type+'.md';await download.saveAs(path);expect(await readFile(path,'utf8')).toBe(actual.markdown);
    await drawer(page).getByRole('button',{name:/^(关闭|Close)$/}).click();
  }
});
