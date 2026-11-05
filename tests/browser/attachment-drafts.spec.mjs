import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

async function setup(page) {
  const conversation={id:'attachment-drafts',title:'Synthetic attachment drafts',execution:{},messages:[],queue:[],actions:[]};
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[conversation],next_cursor:null}}));
  await page.route(`**/admin/api/conversations/${conversation.id}`,route=>route.fulfill({json:conversation}));
  await page.route(`**/admin/api/conversations/${conversation.id}/sandbox`,route=>route.fulfill({json:{available:true,exists:false,files:[],permissions:[],executions:[]}}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText(conversation.title);
}

test('mixed attachment drafts share a scrolling row with independently removable thumbnails and file chips',async({page})=>{
  await setup(page);
  const buffer=Buffer.from(await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=16;
    canvas.getContext('2d').fillRect(0,0,32,16);
    return Array.from(new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer()));
  }));
  await page.locator('#chat-attachment-input').setInputFiles([
    {name:'first-thumbnail.png',mimeType:'image/png',buffer},
    {name:'first-records.csv',mimeType:'text/csv',buffer:Buffer.from('name\nexample')},
    {name:'second-thumbnail.png',mimeType:'image/png',buffer},
    {name:'second-records.csv',mimeType:'text/csv',buffer:Buffer.from('name\nexample')},
  ]);
  const row=page.locator('.chat-attachment-drafts');
  await expect(row.locator('.chat-image-drafts img')).toHaveCount(2);
  await expect(row.locator('.sandbox-draft-file')).toHaveCount(2);
  await expect(row.locator('.sandbox-draft-file').first()).toContainText('first-records.csv');
  await expect(row.locator('.sandbox-draft-file').first().locator('small')).toHaveText('12 B');
  await expect(row).not.toContainText('first-thumbnail.png',{useInnerText:true});
  await expect(row).not.toContainText('second-thumbnail.png',{useInnerText:true});
  await expect(row.getByAltText('first-thumbnail.png',{exact:true})).toBeVisible();
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:844});
    const geometry=await row.evaluate(element=>{
      const drafts=[...element.querySelectorAll('.chat-image-drafts figure,.sandbox-draft-file')];
      const centers=drafts.map(item=>{const box=item.getBoundingClientRect();return box.y+box.height/2;});
      const images=[...element.querySelectorAll('.chat-image-drafts figure')].map(figure=>{
        const box=figure.getBoundingClientRect(),button=figure.querySelector('button').getBoundingClientRect();
        return {top:button.top-box.top,right:box.right-button.right,bottom:button.bottom-box.bottom};
      });
      return {centers,images,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,overflowX:getComputedStyle(element).overflowX,bodyWidth:document.documentElement.scrollWidth};
    });
    expect(Math.max(...geometry.centers)-Math.min(...geometry.centers)).toBeLessThan(2);
    for(const image of geometry.images) {
      expect(image.top).toBeGreaterThanOrEqual(0);expect(image.top).toBeLessThanOrEqual(5);
      expect(image.right).toBeGreaterThanOrEqual(0);expect(image.right).toBeLessThanOrEqual(5);
      expect(image.bottom).toBeLessThan(0);
    }
    expect(geometry.bodyWidth).toBeLessThanOrEqual(width);
    if(width<400) {
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
      expect(['auto','scroll']).toContain(geometry.overflowX);
      const scrollLeft=await row.evaluate(element=>{element.scrollLeft=element.scrollWidth;return element.scrollLeft;});
      expect(scrollLeft).toBeGreaterThan(0);
    }
    if(width===1440||width===320)await page.screenshot({path:`.tmp/inspection-handoff/attachment-drafts-${width}.png`,animations:'disabled'});
  }
  await row.getByRole('button',{name:'移除图片 first-thumbnail.png',exact:true}).click();
  await expect(row.locator('.chat-image-drafts img')).toHaveCount(1);
  await expect(row.locator('.sandbox-draft-file')).toHaveCount(2);
  await row.getByRole('button',{name:'移除文件：first-records.csv',exact:true}).click();
  await expect(row.locator('.sandbox-draft-file')).toHaveCount(1);
  await expect(row.getByAltText('second-thumbnail.png',{exact:true})).toHaveCount(1);
  await expect(row.locator('.sandbox-draft-file')).toContainText('second-records.csv');
  await row.getByRole('button',{name:'移除图片 second-thumbnail.png',exact:true}).click();
  await row.getByRole('button',{name:'移除文件：second-records.csv',exact:true}).click();
  await expect(row).toHaveCount(0);
});
