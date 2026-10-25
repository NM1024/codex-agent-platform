import {test,expect} from '@playwright/test';

const secret='synthetic-claimed-entry-key-0123456789';
const plugins=[{type:'content.review',name:'文本审核',enabled:false,connection:{ready:false,entryKeyClaimable:true},instructions:'',input_schema:{},result_schema:{},capabilities:{},delivery:{}},{type:'novel.illustrated',name:'图文小说',enabled:false,connection:{ready:false},instructions:'',input_schema:{},result_schema:{},capabilities:{},delivery:{}}];
const pending=type=>({type,entryAddress:'/hooks/'+type.replace('.','/'),entryPath:'/hooks/'+type.replace('.','/'),entryKeyConfigured:false,entryKeyClaimable:type==='content.review',callbackUrl:null,callbackTokenConfigured:false,ready:false,missingFields:['entryKey'],revision:7});
const claimed={...pending('content.review'),entryKeyConfigured:true,entryKeyClaimable:false,ready:true,missingFields:[],revision:8};
const modal=page=>page.getByRole('dialog');
const open=async(page,type='content.review')=>{await page.getByRole('row').filter({hasText:type}).getByRole('button',{name:/^(配置接入|Configure connection)$/}).click();await expect(page.locator('#plugin-entry-address')).toBeVisible();};
const claim=page=>modal(page).getByRole('button',{name:/^(领取入口密钥|Claim entry key)$/});

test.beforeEach(async({page})=>{
  await page.route('**/admin/api/plugins',route=>route.fulfill({json:{configured:plugins}}));
  await page.route('**/admin/api/plugins/*/connection',route=>route.fulfill({json:pending(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)))}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await page.locator('[data-view="plugins"]').click();
});

test('real initialization and browser claim never disclose the key through Agent metadata',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.unroute('**/admin/api/plugins');await page.unroute('**/admin/api/plugins/*/connection');
  const type='browser.real.claim';
  const operation=async(action,args)=>{const response=await page.request.post('/admin/api/operations',{data:{action,args}});expect(response.ok()).toBeTruthy();return response.json();};
  await operation('plugin_save',{definition:{type,name:'真实协议合成业务',instructions:'Use synthetic data only',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}}});
  const initialized=await operation('plugin_connection_initialize',{type});expect(initialized.entryKeyClaimable).toBe(true);expect(initialized.ready).toBe(false);
  await page.locator('[data-view="overview"]').click();await page.locator('[data-view="plugins"]').click();
  const row=page.getByRole('row').filter({hasText:type});await expect(row.getByRole('switch')).toBeDisabled();
  await open(page,type);await claim(page).click();
  const key=await page.locator('#plugin-claimed-entry-key').inputValue();expect(key).toMatch(/^[a-f0-9]{64}$/);
  await modal(page).getByRole('button',{name:'复制领取的入口密钥',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(key);
  const metadata=await operation('plugin_get',{type});expect(metadata.connection.entryKeyClaimable).toBe(false);expect(metadata.connection.ready).toBe(true);expect(JSON.stringify(metadata)).not.toContain(key);
  const repeated=await operation('plugin_connection_initialize',{type});expect(repeated.entryKeyClaimable).toBe(false);expect(JSON.stringify(repeated)).not.toContain(key);
  await modal(page).getByRole('button',{name:'取消',exact:true}).click();await open(page,type);
  await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(claim(page)).toHaveCount(0);await expect(page.locator('#plugin-entry-key')).toHaveValue('');
});

test('human claim displays once, copies privately, and saving uses its new revision without resending the secret',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  let current=pending('content.review'),saved;
  await page.route('**/admin/api/plugins/content.review/connection',async route=>{if(route.request().method()==='POST'){saved=route.request().postDataJSON();await route.fulfill({json:claimed});}else await route.fulfill({json:current});});
  await page.route('**/entry-key/claim',async route=>{expect(route.request().postDataJSON()).toEqual({revision:7});current=claimed;await route.fulfill({json:{entryKey:secret,connection:claimed}});});
  await open(page);await modal(page).locator('.connection-help summary').first().click();await expect(modal(page)).toContainText('领取前不能用于调用');await claim(page).click();
  await expect(page.locator('#plugin-claimed-entry-key')).toHaveValue(secret);await expect(claim(page)).toHaveCount(0);
  await expect(page.locator('#plugin-entry-key')).toHaveCount(0);await expect(modal(page).locator('.connection-example')).toHaveCount(0);
  await modal(page).getByRole('button',{name:'复制领取的入口密钥',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(secret);
  await modal(page).getByRole('button',{name:'保存接入配置',exact:true}).click();await expect(modal(page)).toHaveCount(0);
  expect(saved.revision).toBe(8);expect(saved).not.toHaveProperty('entryKey');
  await open(page);await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(page.locator('#plugin-entry-key')).toHaveValue('');await expect(claim(page)).toHaveCount(0);
});

test('claim and copy each lock duplicate requests with local loading and honest clipboard failure',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let claims=0;
  await page.route('**/entry-key/claim',async route=>{claims++;await gate;await route.fulfill({json:{entryKey:secret,connection:claimed}});});
  await open(page);await claim(page).click();await expect(claim(page)).toHaveClass(/ant-btn-loading/);await claim(page).dispatchEvent('click');expect(claims).toBe(1);
  await expect(modal(page).getByRole('button',{name:'保存接入配置',exact:true})).toBeDisabled();await expect(modal(page).getByRole('button',{name:'生成入口密钥',exact:true})).toBeDisabled();
  release();await expect(page.locator('#plugin-claimed-entry-key')).toHaveValue(secret);
  await page.evaluate(()=>{window.syntheticClaimCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(value){window.syntheticClaimCopies.push(value);return new Promise((resolve,reject)=>window.rejectClaimCopy=()=>reject(new Error('Denied')));}}});});
  const copy=modal(page).getByRole('button',{name:'复制领取的入口密钥',exact:true});await copy.click();await expect(copy).toHaveClass(/ant-btn-loading/);await copy.dispatchEvent('click');expect(await page.evaluate(()=>window.syntheticClaimCopies)).toEqual([secret]);
  await page.evaluate(()=>window.rejectClaimCopy());await expect(copy).not.toHaveClass(/ant-btn-loading/);await expect(modal(page)).toContainText('复制失败，请在字段中选择并复制。');await expect(page.locator('#plugin-claimed-entry-key')).toHaveValue(secret);
});

test('lost claim response explains possible consumption and allows reload then manual replacement',async({page})=>{
  let current=pending('content.review'),saved;
  await page.route('**/admin/api/plugins/content.review/connection',async route=>{if(route.request().method()==='POST'){saved=route.request().postDataJSON();await route.fulfill({json:{...claimed,revision:9}});}else await route.fulfill({json:current});});
  await page.route('**/entry-key/claim',async route=>{current=claimed;await route.abort('failed');});
  await open(page);await claim(page).click();await expect(modal(page).getByRole('alert')).toContainText('可能已被领取');await expect(modal(page)).toContainText('生成并保存新的入口密钥');
  await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await modal(page).getByRole('button',{name:'重新读取',exact:true}).click();await expect(claim(page)).toHaveCount(0);
  await modal(page).getByRole('button',{name:'生成入口密钥',exact:true}).click();const replacement=await page.locator('#plugin-entry-key').inputValue();expect(replacement.length).toBeGreaterThanOrEqual(24);
  await modal(page).getByRole('button',{name:'保存接入配置',exact:true}).click();await expect(modal(page)).toHaveCount(0);expect(saved.revision).toBe(8);expect(saved.entryKey).toBe(replacement);
});

test('revision conflicts require reload and do not expose a secret',async({page})=>{
  await page.route('**/entry-key/claim',route=>route.fulfill({status:409,json:{error:{code:'PLUGIN_CONNECTION_REVISION_CONFLICT'}}}));
  await open(page);await claim(page).click();await expect(modal(page).getByRole('alert')).toContainText('接入配置已被修改');await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(modal(page).getByRole('button',{name:'重新读取',exact:true})).toBeVisible();
});

test('manual replacement of a pending key remains available and blocks an accidental claim of another key',async({page})=>{
  let saved,claims=0;
  await page.route('**/entry-key/claim',route=>{claims++;return route.fulfill({json:{entryKey:secret,connection:claimed}});});
  await page.route('**/admin/api/plugins/content.review/connection',async route=>{if(route.request().method()==='POST'){saved=route.request().postDataJSON();await route.fulfill({json:claimed});}else await route.fulfill({json:pending('content.review')});});
  await open(page);await modal(page).getByRole('button',{name:'生成入口密钥',exact:true}).click();const replacement=await page.locator('#plugin-entry-key').inputValue();await expect(claim(page)).toBeDisabled();
  await modal(page).getByRole('button',{name:'保存接入配置',exact:true}).click();await expect(modal(page)).toHaveCount(0);expect(saved).toMatchObject({revision:7,entryKey:replacement});expect(claims).toBe(0);
});

test('late clipboard completion cannot restore a notice or key in a newly opened plugin',async({page})=>{
  await page.route('**/entry-key/claim',route=>route.fulfill({json:{entryKey:secret,connection:claimed}}));
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(){return new Promise(resolve=>window.finishClaimCopy=resolve);}}}));
  await open(page);await claim(page).click();await modal(page).getByRole('button',{name:'复制领取的入口密钥',exact:true}).click();
  await modal(page).getByRole('button',{name:'取消',exact:true}).click();await open(page,'novel.illustrated');await page.evaluate(()=>window.finishClaimCopy());
  await expect(page.locator('#plugin-entry-key')).toHaveValue('');await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(modal(page)).not.toContainText('已复制，请妥善保管。');
});

test('closing clears displayed secrets and ignores delayed claims after another plugin is opened',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/entry-key/claim',async route=>{await gate;await route.fulfill({json:{entryKey:secret,connection:claimed}});});
  await open(page);await claim(page).click();await modal(page).getByRole('button',{name:'取消',exact:true}).click();await open(page,'novel.illustrated');release();
  await expect(page.locator('#plugin-entry-address')).toHaveValue('/hooks/novel/illustrated');await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(modal(page)).not.toContainText(secret);
  await modal(page).getByRole('button',{name:'取消',exact:true}).click();await open(page);await claim(page).click();await expect(page.locator('#plugin-claimed-entry-key')).toHaveValue(secret);
  await modal(page).getByRole('button',{name:'取消',exact:true}).click();await open(page,'novel.illustrated');await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);
});

test('expired session discards pending claim and a new session starts without the secret',async({page})=>{
  await page.route('**/entry-key/claim',route=>route.fulfill({status:401,json:{error:{code:'AUTH_REQUIRED'}}}));
  await open(page);await claim(page).click();await expect(page.locator('#login')).toBeVisible();await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);
  await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await page.locator('[data-view="plugins"]').click();await open(page);await expect(page.locator('#plugin-claimed-entry-key')).toHaveCount(0);await expect(page.locator('#plugin-entry-key')).toHaveValue('');
});

test('claim action and one-time guidance follow the selected English locale',async({page})=>{
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();await open(page);
  await expect(claim(page)).toHaveText('Claim entry key');await modal(page).locator('.connection-help summary').first().click();await expect(modal(page)).toContainText('only an administrator can claim it once');
});
