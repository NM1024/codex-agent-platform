import {test,expect} from '@playwright/test';
import sharp from 'sharp';

test('initial conversation list has its own loading feedback',async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/admin/api/conversations',async route=>{await gate;await route.continue();});
  try {
    await page.locator('[data-view="chat"]').click();
    await expect(page.locator('.conversation-list-loading')).toBeVisible();
    release();await expect(page.locator('.conversation-list-loading')).toHaveCount(0);
  }finally{release();}
});

test('pending image send keeps ownership across page navigation and clears the accepted draft once',async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.locator('[data-view="chat"]').click();
  const image=await sharp({create:{width:20,height:10,channels:3,background:'blue'}}).png().toBuffer();
  await page.locator('#chat-image-input').setInputFiles({name:'pending.png',mimeType:'image/png',buffer:image});
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{started=resolve;});
  let posts=0;
  await page.route('**/admin/api/conversations/*/messages',async route=>{posts++;started();await gate;await route.continue();});
  try {
    await page.locator('.composer-send').click();await requested;
    await page.locator('[data-view="overview"]').click();
    await page.locator('[data-view="chat"]').click();
    await expect(page.locator('.composer-send')).toHaveClass(/ant-btn-loading/);
    await page.locator('#message-input').press('Enter');expect(posts).toBe(1);
    const accepted=page.waitForResponse(response=>response.url().endsWith('/messages')&&response.request().method()==='POST');
    release();await accepted;
    await expect(page.locator('.chat-image-drafts img')).toHaveCount(0);
    await expect(page.locator('.message.user .message-images img')).toHaveCount(1);
    await expect(page.locator('.composer-send')).not.toHaveClass(/ant-btn-loading/);
    expect(posts).toBe(1);
  }finally{release();}
});
