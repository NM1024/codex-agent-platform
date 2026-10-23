import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.goto('/admin/');
  await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.locator('[data-view="plugins"]').click();
});

test('connection tabs retain drafts, show one claimed secret and fit a normal desktop height',async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await page.route('**/admin/api/plugins/content.review/connection',route=>route.fulfill({json:{type:'content.review',revision:7,entryAddress:'/hooks/content/review',entryKeyConfigured:false,entryKeyClaimable:true,ready:false,missingFields:['entryKey']}}));
  await page.route('**/entry-key/claim',route=>route.fulfill({json:{entryKey:'synthetic-once-only-key-0123456789',connection:{type:'content.review',revision:8,entryAddress:'/hooks/content/review',entryKeyConfigured:true,entryKeyClaimable:false,ready:true,missingFields:[]}}}));
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
  const modal=page.locator('.plugin-connection-modal');
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await modal.getByRole('switch',{name:'启用结果回调'}).click();
  await page.locator('#plugin-callback-url').fill('https://example.invalid/synthetic-callback');
  await modal.getByRole('tab',{name:'入口配置',exact:true}).click();
  await modal.getByRole('button',{name:'领取入口密钥',exact:true}).click();
  await expect(page.locator('#plugin-claimed-entry-key')).toHaveValue('synthetic-once-only-key-0123456789');
  await expect(modal.locator('input[type="password"]:visible')).toHaveCount(1);
  expect(await modal.locator('.ant-modal-body').evaluate(e=>e.scrollHeight<=e.clientHeight+1)).toBe(true);
  await page.screenshot({path:'.tmp/layout-desktop.png',animations:'disabled',mask:[page.locator('#plugin-claimed-entry-key')]});
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await expect(page.locator('#plugin-callback-url')).toHaveValue('https://example.invalid/synthetic-callback');
  await modal.getByRole('button',{name:'取消',exact:true}).click();
});

test('all list tables contain long content and usable actions on phone and desktop',async({page})=>{
  await page.route('**/admin/api/plugins',async route=>{
    const response=await route.fetch(),data=await response.json();
    data.configured=data.configured.map((p,i)=>({...p,name:i?'Very long synthetic plugin name for a responsive layout':'内容审核',type:i?'synthetic.'+'long_identifier_'.repeat(12):p.type,description:'A long synthetic description '.repeat(30),connection:{...p.connection,ready:false,entryKeyClaimable:true}}));
    await route.fulfill({json:data});
  });
  for(const locale of ['en','zh-CN']){
    await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible').getByText(locale==='en'?'English':'简体中文',{exact:true}).click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    for(const width of [390,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      for(const view of ['plugins','schedules','tasks','overview']){
        await page.locator(`[data-view="${view}"]`).click();
        const table=page.locator('#view .ant-table-content').first();await expect(table).toBeVisible();
        await expect(page.locator('#view .ant-spin-spinning')).toHaveCount(0);
        expect(await table.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${locale} ${view} ${width}`).toBe(true);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth),JSON.stringify(await page.locator('body *').evaluateAll(nodes=>nodes.map(e=>({tag:e.tagName,cls:e.className,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right})).filter(e=>e.right>window.innerWidth+2).slice(0,12)))).toBeLessThanOrEqual(width);
        for(const button of await table.locator('tbody tr[data-row-key]').first().getByRole('button').all()){
          const box=await button.boundingBox();expect(box.width).toBeGreaterThan(30);expect(box.x+box.width).toBeLessThanOrEqual(width);
        }
        if(locale==='en'&&view==='plugins'&&[390,1440].includes(width))await page.screenshot({path:`.tmp/layout-plugins-${width}.png`,animations:'disabled'});
      }
    }
  }
});

test('hidden entry validation selects its tab and callback disabling clears only when saved',async({page})=>{
  let saved;
  await page.route('**/admin/api/plugins/content.review/connection',async route=>{
    if(route.request().method()==='POST'){saved=route.request().postDataJSON();await route.fulfill({json:{type:'content.review',ready:true,revision:3}});}
    else await route.fulfill({json:{type:'content.review',revision:2,entryAddress:'/hooks/content/review',entryKeyConfigured:true,ready:true,callbackUrl:'https://example.invalid/receiver',callbackTokenConfigured:true}});
  });
  await page.getByRole('row').filter({hasText:'content.review'}).getByRole('button',{name:'配置接入',exact:true}).click();
  const modal=page.locator('.plugin-connection-modal');
  await page.locator('#plugin-entry-address').fill('invalid');
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await modal.getByRole('button',{name:'保存接入配置',exact:true}).click();
  await expect(modal.getByRole('tab',{name:'入口配置',exact:true})).toHaveAttribute('aria-selected','true');
  await page.locator('#plugin-entry-address').fill('/hooks/content/review');
  await modal.getByRole('tab',{name:'结果回调',exact:false}).click();
  await page.locator('#plugin-callback-url').fill('https://example.invalid/receiver#invalid');
  await modal.getByRole('tab',{name:'入口配置',exact:true}).click();
  await modal.getByRole('button',{name:'保存接入配置',exact:true}).click();
  await expect(modal.getByRole('tab',{name:'结果回调',exact:false})).toHaveAttribute('aria-selected','true');
  await modal.getByRole('switch',{name:'启用结果回调'}).click();
  await expect(modal).toContainText('关闭回调并保存，将清除已保存的回调地址和凭证。');
  expect(saved).toBeUndefined();
  await modal.getByRole('button',{name:'保存接入配置',exact:true}).click();await expect(modal).toHaveCount(0);
  expect(saved).toEqual({entryAddress:'/hooks/content/review',callbackUrl:'',revision:2});
});
