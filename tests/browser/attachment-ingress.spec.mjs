import {test,expect} from '@playwright/test';
import sharp from 'sharp';
import {navigate} from './navigation.mjs';
test.use({locale:'zh-CN'});
async function setup(page){
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();await navigate(page,'chat');await page.getByRole('button',{name:'＋ 新对话',exact:true}).click();
}
async function mixed(){return [
  {name:'synthetic-image.bin',mimeType:'application/octet-stream',buffer:await sharp({create:{width:24,height:16,channels:3,background:'#83b29b'}}).png().toBuffer()},
  {name:'synthetic-data.csv',mimeType:'text/csv',buffer:Buffer.from('name,value\nexample,1')},
];}
async function add(page,source,items){
  if(source==='picker'){await page.locator('input[type=file]').last().setInputFiles(items);return;}
  await page.locator(source==='paste'?'#message-input':'.chat-compose').evaluate((target,{source,items})=>{
    const data=new DataTransfer();for(const item of items)data.items.add(new File([new Uint8Array(item.bytes)],item.name,{type:item.type}));
    target.dispatchEvent(source==='paste'?new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
  },{source,items:items.map(item=>({name:item.name,type:item.mimeType,bytes:Array.from(item.buffer)}))});
}
for(const source of ['picker','drop','paste'])test(`${source} distributes each image and document from one mixed batch`,async({page})=>{
  await setup(page);await add(page,source,await mixed());
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  await expect(page.locator('.sandbox-draft-file')).toHaveCount(1);await expect(page.locator('.sandbox-draft-files')).toContainText('synthetic-data.csv');
  await expect(page.locator('.sandbox-draft-files')).not.toContainText('synthetic-image.bin');
  await expect(page.getByRole('button',{name:'添加附件',exact:true})).toHaveCount(1);await expect(page.locator('input[type=file]')).toHaveCount(1);
});

test('rapid mixed drops and pastes keep both batches without silently losing images',async({page})=>{
  await setup(page);const items=await mixed();await add(page,'drop',items);await add(page,'paste',items);
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(2);await expect(page.locator('.sandbox-draft-file')).toHaveCount(2);
});

test('mixed intake validates both capacities and rejects a failed batch without partial additions',async({page})=>{
  await setup(page);const items=await mixed();await add(page,'picker',items);
  await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  await add(page,'paste',[items[1],{name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('not a raster')}]);
  await expect(page.locator('.chat-image-error')).toContainText('图片格式无效');await expect(page.locator('.sandbox-draft-file')).toHaveCount(1);await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  await add(page,'picker',[items[0],items[0],items[0]]);await expect(page.locator('.chat-image-drafts img')).toHaveCount(4);
  await add(page,'picker',[items[1]]);await expect(page.locator('.sandbox-draft-file')).toHaveCount(2);
  await add(page,'drop',items);await expect(page.locator('.chat-image-error')).toContainText('最多添加 4');
  await expect(page.locator('.sandbox-draft-file')).toHaveCount(2);await expect(page.locator('.chat-image-drafts img')).toHaveCount(4);
});

test('mixed attachments send image content and uploaded document IDs in one message',async({page})=>{
  await setup(page);let uploaded=0,sent;
  const fileId='11111111-1111-4111-8111-111111111111';
  await page.route('**/admin/api/conversations/*/files',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    uploaded++;expect(decodeURIComponent(route.request().headers()['x-file-name'])).toBe('synthetic-data.csv');
    expect(route.request().postDataBuffer().toString()).toBe('name,value\nexample,1');
    const path=new URL(route.request().url()).pathname;
    await route.fulfill({status:201,json:{file_id:fileId,name:'synthetic-data.csv',mime:'text/csv',size:20,url:path+'/'+fileId,origin:'upload'}});
  });
  await page.route('**/admin/api/conversations/*/messages',async route=>{
    sent=route.request().postDataJSON();await route.fulfill({status:202,json:{id:'22222222-2222-4222-8222-222222222222',status:'queued'}});
  });
  await add(page,'picker',await mixed());await expect(page.locator('.chat-image-drafts img')).toHaveCount(1);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>sent?.file_ids).toEqual([fileId]);expect(sent.attachments).toHaveLength(1);
  expect(sent.attachments[0].name).toBe('synthetic-image.bin');expect(sent.attachments[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  await expect(page.locator('.chat-attachment-drafts')).toHaveCount(0);expect(uploaded).toBe(1);
});
