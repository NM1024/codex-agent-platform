import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.goto('/admin/');
  await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.locator('#workspace')).toBeVisible();
});

test('fenced code copies literal text with its trailing newline and local feedback',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-view="chat"]').click();
  await page.locator('#message-input').fill('Show the synthetic report');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const block=page.locator('.message-markdown .code-block').last();
  await expect(block).toBeVisible();
  await block.getByRole('button',{name:'复制代码',exact:true}).click();
  await expect(block).toContainText('已复制');
  expect((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n')).toBe('const count = 3;\n');
  await expect(block.locator('pre code')).toHaveText('const count = 3;\n');
});

test('runtime actions prevent duplicate requests while another action can finish',async({page})=>{
  await page.getByRole('button',{name:'调整并发',exact:true}).click();
  await expect(page.locator('#concurrency')).toBeVisible();
  let release;const gate=new Promise(resolve=>{release=resolve;});let pauses=0;
  await page.route('**/admin/api/operations',async route=>{
    const body=route.request().postDataJSON();
    if(body.action==='runtime_update'&&Object.hasOwn(body.args,'paused')){pauses++;await gate;}
    await route.continue();
  });
  const pause=page.getByRole('button',{name:/恢复领取|暂停领取/});
  await pause.click();await expect(pause).toHaveClass(/ant-btn-loading/);
  await pause.dispatchEvent('click');
  const save=page.getByRole('button',{name:'保存',exact:true});
  await save.click();await expect(page.locator('#notice')).toContainText('并发设置已保存');
  await expect(pause).toHaveClass(/ant-btn-loading/);expect(pauses).toBe(1);
  release();await expect(pause).not.toHaveClass(/ant-btn-loading/);
});

test('unsupported clipboard reports a manual copy error without claiming success',async({page})=>{
  await page.locator('[data-view="chat"]').click();
  await page.locator('#message-input').fill('Clipboard unsupported fixture');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const block=page.locator('.message-markdown .code-block').last();
  await expect(block).toBeVisible();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
  await block.getByRole('button',{name:'复制代码',exact:true}).click();
  await expect(block).toContainText('复制失败，请手动选择文本复制。');
  await expect(block).not.toContainText('已复制');
});

test('initial overview error stops loading and navigation can recover',async({page})=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/overview',async route=>{await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic overview failure'}})});});
  await page.reload();
  await expect(page.locator('.page-loading')).toContainText('正在加载数据…');
  release();await expect(page.locator('#notice')).toContainText('Synthetic overview failure');
  await expect(page.locator('.page-loading')).toHaveCount(0);
  await page.unroute('**/admin/api/overview');
  await page.locator('[data-view="plugins"]').click();
  await page.locator('[data-view="overview"]').click();
  await page.getByRole('button',{name:'调整并发',exact:true}).click();
  await expect(page.locator('#concurrency')).toBeVisible();
});

test('task row details are independent and a late earlier selection cannot replace the latest',async({page})=>{
  await page.locator('[data-view="tasks"]').click();
  const rows=page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(rows.nth(1)).toBeVisible();
  const firstId=await rows.nth(0).locator('.table-identifier-cell code').first().textContent();
  const secondId=await rows.nth(1).locator('.table-identifier-cell code').first().textContent();
  let release;const gate=new Promise(resolve=>{release=resolve;});let requests=0;
  await page.route('**/admin/api/tasks/'+firstId,async route=>{requests++;await gate;await route.continue();});
  const first=rows.nth(0).getByRole('button',{name:/详情/});
  await first.click();await expect(first).toHaveClass(/ant-btn-loading/);
  await first.dispatchEvent('click');expect(requests).toBe(1);
  await rows.nth(1).getByRole('button',{name:/详情/}).click();
  await expect(page.locator('#task-details')).toContainText(secondId);
  await expect(first).toHaveClass(/ant-btn-loading/);
  release();await expect(first).not.toHaveClass(/ant-btn-loading/);
  await expect(page.locator('#task-details')).toContainText(secondId);
});

test('logout is independent of a blocked page load and prevents duplicate submissions',async({page})=>{
  await page.getByRole('button',{name:'调整并发',exact:true}).click();
  await expect(page.locator('#concurrency')).toBeVisible();
  let releaseRefresh,releaseLogout;const refreshGate=new Promise(resolve=>{releaseRefresh=resolve;}),logoutGate=new Promise(resolve=>{releaseLogout=resolve;});let logouts=0;
  await page.route('**/admin/api/overview',async route=>{await refreshGate;await route.continue();});
  await page.route('**/admin/api/logout',async route=>{logouts++;await logoutGate;await route.continue();});
  await page.locator('[data-view="plugins"]').click();
  await page.locator('[data-view="overview"]').click();await expect(page.locator('.page-loading')).toBeVisible();
  await page.locator('#logout').click();await expect(page.locator('#logout')).toHaveClass(/ant-btn-loading/);
  await page.locator('#logout').dispatchEvent('click');expect(logouts).toBe(1);
  releaseLogout();await expect(page.locator('#login')).toBeVisible();
  releaseRefresh();await expect(page.locator('#workspace')).toHaveCount(0);
});

test('configuration categories save independently and guard duplicate form submissions',async({page})=>{
  await page.locator('[data-view="settings"]').click();
  const timeout=page.locator('#setting-manager-timeoutMs');
  await timeout.fill(String(Number(await timeout.inputValue())+1));
  let release;const gate=new Promise(resolve=>{release=resolve;});let saves=0;
  await page.route('**/admin/api/operations',async route=>{
    const body=route.request().postDataJSON();
    if(body.action==='configuration_update'&&body.args.scope==='manager'){saves++;await gate;}
    await route.continue();
  });
  const manager=page.locator('#configuration-manager'),managerSave=manager.getByRole('button',{name:/保存配置/});
  await managerSave.click();await expect(managerSave).toHaveClass(/ant-btn-loading/);
  await manager.dispatchEvent('submit');expect(saves).toBe(1);
  await page.locator('[data-settings-tab="execution"]').click();
  const concurrency=page.locator('#setting-execution-concurrency');
  await concurrency.fill(String(Number(await concurrency.inputValue())+1));
  const executionSave=page.locator('#configuration-execution').getByRole('button',{name:/保存配置/});
  await executionSave.click();await expect(page.locator('#notice')).toContainText('已保存');
  await page.locator('[data-settings-tab="manager"]').click();
  await expect(managerSave).toHaveClass(/ant-btn-loading/);
  release();await expect(managerSave).not.toHaveClass(/ant-btn-loading/);expect(saves).toBe(1);
});

test('connection clipboard actions show independent busy feedback and prevent duplicate writes',async({page})=>{
  await page.locator('[data-view="plugins"]').click();
  await page.getByRole('button',{name:'配置接入',exact:true}).first().click();
  const modal=page.getByRole('dialog');
  await modal.getByRole('button',{name:'生成入口密钥',exact:true}).click();
  await page.evaluate(()=>{
    window.syntheticCopies=[];window.releaseCopies=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(value){window.syntheticCopies.push(value);return new Promise(resolve=>window.releaseCopies.push(resolve));}}});
  });
  const keyCopy=modal.getByRole('button',{name:/复制入口密钥/});
  await keyCopy.click();await expect(keyCopy).toHaveClass(/ant-btn-loading/);
  await keyCopy.dispatchEvent('click');
  expect(await page.evaluate(()=>window.syntheticCopies.length)).toBe(1);
  const addressCopy=modal.getByRole('button',{name:/复制调用地址/});
  await addressCopy.click();await expect(addressCopy).toHaveClass(/ant-btn-loading/);
  expect(await page.evaluate(()=>window.syntheticCopies.length)).toBe(2);
  await expect(modal.getByRole('button',{name:'保存接入配置',exact:true})).toBeEnabled();
  await page.evaluate(()=>window.releaseCopies.forEach(resolve=>resolve()));
  await expect(keyCopy).not.toHaveClass(/ant-btn-loading/);
  await expect(addressCopy).not.toHaveClass(/ant-btn-loading/);
  await expect(modal).toContainText('已复制，请妥善保管。');
});
