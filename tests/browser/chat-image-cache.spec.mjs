import {test,expect} from '@playwright/test';
import sharp from 'sharp';

test('the browser reuses private image bytes on 304 and rechecks deletion and logout',async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();
  const created=await page.request.post('/admin/api/conversations',{data:{title:'Synthetic image cache'}});expect(created.ok()).toBeTruthy();
  const conversation=await created.json(),bytes=await sharp({create:{width:20,height:10,channels:3,background:'#345e4f'}}).png().toBuffer();
  const queued=await page.request.post(`/admin/api/conversations/${conversation.id}/messages`,{data:{text:'Synthetic cache image',attachments:[{name:'synthetic-cache.png',dataUrl:'data:image/png;base64,'+bytes.toString('base64')}]}});
  expect(queued.ok()).toBeTruthy();const image=(await queued.json()).attachments[0];
  // Route interception disables Chromium caching, so use the actual fixture server.
  const network=await page.context().newCDPSession(page),requests=new Map(),statuses=[];
  await network.send('Network.enable');await network.send('Network.setCacheDisabled',{cacheDisabled:false});
  network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,new URL(event.request.url).pathname));
  network.on('Network.responseReceivedExtraInfo',event=>{if(requests.get(event.requestId)===image.url)statuses.push(event.statusCode);});
  const read=()=>page.evaluate(async url=>{const response=await fetch(url,{cache:'no-cache'});return {status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};},image.url);
  expect(await read()).toEqual({status:200,bytes:Array.from(bytes)});
  expect(await read()).toEqual({status:200,bytes:Array.from(bytes)});
  await expect.poll(()=>statuses).toEqual([200,304]);
  await expect.poll(async()=>{const response=await page.request.get(`/admin/api/conversations/${conversation.id}`);return (await response.json()).messages.find(message=>message.role==='user').status;}).toBe('completed');
  expect((await page.request.delete(`/admin/api/conversations/${conversation.id}`)).ok()).toBeTruthy();
  expect((await read()).status).toBe(404);
  expect((await page.request.post('/admin/api/logout')).ok()).toBeTruthy();
  expect((await read()).status).toBe(401);await network.detach();
});

test('hashed JS and CSS use the browser cache while conditional reloads return 304 and HTML stays fresh',async({page})=>{
  await page.goto('/admin/');await expect(page.locator('#password')).toBeVisible();
  const paths=await page.locator('script[src], link[rel="stylesheet"][href]').evaluateAll(nodes=>nodes.map(node=>node.src||node.href));
  expect(paths.some(path=>path.endsWith('.js'))).toBeTruthy();expect(paths.some(path=>path.endsWith('.css'))).toBeTruthy();
  const network=await page.context().newCDPSession(page),requests=new Map(),statuses=[];
  await network.send('Network.enable');await network.send('Network.setCacheDisabled',{cacheDisabled:false});
  network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url));
  network.on('Network.responseReceivedExtraInfo',event=>{if(paths.includes(requests.get(event.requestId)))statuses.push(event.statusCode);});
  for(const path of paths){
    const cached=await page.evaluate(async url=>{const response=await fetch(url);const bytes=(await response.arrayBuffer()).byteLength;return {status:response.status,policy:response.headers.get('cache-control'),bytes,transfer:performance.getEntriesByName(url).at(-1).transferSize};},path);
    expect(cached.status).toBe(200);expect(cached.policy).toBe('public, max-age=31536000, immutable');expect(cached.bytes).toBeGreaterThan(0);expect(cached.transfer).toBe(0);
    const before=statuses.length;
    expect(await page.evaluate(async url=>{const response=await fetch(url,{cache:'no-cache'});await response.arrayBuffer();return response.status;},path)).toBe(200);
    await expect.poll(()=>statuses.slice(before)).toEqual([304]);
  }
  const entries=await page.evaluate(async()=>{
    const read=async()=>{const response=await fetch('/admin/');return {policy:response.headers.get('cache-control'),text:await response.text()};};
    return [await read(),await read()];
  });
  expect(entries[0].policy).toBe('no-store');expect(entries[1].policy).toBe('no-store');expect(entries[0].text).not.toBe(entries[1].text);
  await network.detach();
});
