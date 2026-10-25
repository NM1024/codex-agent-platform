import {test,expect} from '@playwright/test';
import {chooseChatModel,openChatPicker,chatPicker} from './agent-picker.mjs';

async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function openChat(page){await page.locator('#navigation-toggle').click();await page.locator('.mobile-navigation [data-view="chat"]').click();await expect(page.locator('#message-input')).toBeVisible();}

test('phone top bar keeps platform title and icon controls on one row with dismissible navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  await expect(page.locator('#page-title')).toHaveText('Codex Agent Platform');
  await expect(page.locator('#navigation-toggle')).toHaveAttribute('aria-expanded','false');
  await page.locator('#navigation-toggle').click();
  await expect(page.locator('.mobile-navigation [data-view]')).toHaveCount(6);await page.screenshot({path:'.tmp/mobile-shell/menu-phone.png',animations:'disabled'});
  await page.keyboard.press('Escape');await expect(page.locator('.mobile-navigation')).not.toBeVisible();
  await openChat(page);await page.locator('#message-input').fill('保留草稿');
  await page.locator('#navigation-toggle').click();await page.locator('#messages').click();
  await expect(page.locator('#navigation-toggle')).toHaveAttribute('aria-expanded','false');await expect(page.locator('#message-input')).toHaveValue('保留草稿');await page.screenshot({path:'.tmp/mobile-shell/chat-phone.png',animations:'disabled'});
  for(const width of [390,320,768]){
    await page.setViewportSize({width,height:844});const bar=await page.locator('.console-header').boundingBox();expect(bar.height).toBeLessThanOrEqual(57);
    for(const selector of ['#navigation-toggle','#repository-link','#app-language','#logout']){
      const control=page.locator(selector);await expect(control).toBeInViewport({ratio:1});
      expect((await control.innerText()).trim()).toBe('');await expect(control).toHaveAccessibleName(/.+/);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('phone composer fits the unified model entry upload and send on one line and retains full options',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await openChat(page);
  for(const width of [390,320,768]){
    await page.setViewportSize({width,height:844});
    const centers=await page.locator('#chat-model,.chat-image-picker,.composer-send').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return b.y+b.height/2;}));
    expect(centers).toHaveLength(3);expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(2);
    await expect(page.locator('.composer-send')).toBeInViewport({ratio:1});
  }
  await chooseChatModel(page,'Fixture Fast');await openChatPicker(page);await expect(chatPicker(page).locator('.chat-effort-labels')).toContainText('low');await page.keyboard.press('Escape');
});

test('chat follows keyboard visual viewport resize and offset then restores without losing draft',async({page})=>{
  await page.addInitScript(()=>{
    const viewport=new EventTarget();Object.assign(viewport,{height:844,width:390,offsetTop:0,scale:1});
    Object.defineProperty(window,'visualViewport',{value:viewport});
    window.setTestViewport=(height,offsetTop=0,scale=1)=>{Object.assign(viewport,{height,offsetTop,scale});viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));};
  });
  await page.setViewportSize({width:390,height:844});await login(page);await openChat(page);await page.locator('#message-input').fill('keyboard draft');
  await page.evaluate(()=>window.setTestViewport(420,45));
  await expect.poll(async()=>{const b=await page.locator('#workspace').boundingBox();return Math.round(b.height);}).toBe(420);
  const bar=await page.locator('.console-header').boundingBox(),send=await page.locator('.composer-send').boundingBox();expect(bar.y).toBeCloseTo(45,0);expect(send.y+send.height).toBeLessThanOrEqual(465);
  await page.evaluate(()=>window.setTestViewport(200,100,2));await expect.poll(async()=>Math.round((await page.locator('#workspace').boundingBox()).height)).toBe(420);
  await page.evaluate(()=>window.setTestViewport(240));
  await expect.poll(async()=>Math.ceil((await page.locator('.composer-send').boundingBox()).y+(await page.locator('.composer-send').boundingBox()).height)).toBeLessThanOrEqual(240);
  await page.evaluate(()=>window.setTestViewport(844));await expect.poll(async()=>Math.round((await page.locator('#workspace').boundingBox()).height)).toBe(844);
  await expect(page.locator('#message-input')).toHaveValue('keyboard draft');
});

test('phone language menu preserves drafts and icon actions still send and sign out',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await openChat(page);
  await page.locator('#message-input').fill('Synthetic compact mobile message');
  await expect(page.locator('#app-language')).toHaveAttribute('aria-haspopup','menu');
  await page.locator('#app-language').focus();await page.keyboard.press('Enter');await expect(page.locator('#app-language')).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Escape');await expect(page.locator('#app-language')).toHaveAttribute('aria-expanded','false');
  await page.locator('#app-language').click();await page.locator('.language-menu:visible').getByText('English',{exact:true}).click();
  await expect(page.locator('#message-input')).toHaveValue('Synthetic compact mobile message');
  await expect(page.locator('#logout')).toHaveAccessibleName('Sign out');
  await expect(page.locator('#repository-link')).toHaveAttribute('href','https://github.com/NM1024/codex-agent-platform');
  await page.locator('.composer-send').click();await expect(page.locator('#messages')).toContainText('Synthetic compact mobile message');
  await page.locator('#logout').click();await expect(page.locator('#login')).toBeVisible();
});
