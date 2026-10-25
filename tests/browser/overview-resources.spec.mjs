import {test,expect} from '@playwright/test';
import {overviewFixture,loginOverview} from './overview-fixture.mjs';
async function chooseLanguage(page,locale){await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible,.language-menu:visible').getByText(locale==='en'?'English':'简体中文',{exact:true}).click();}
const card=(page,id)=>page.locator(`[data-resource="${id}"]`);

test('overview shows six independently sourced cards and accurate capacity ratios',async({page})=>{
  const data=overviewFixture();await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));await loginOverview(page);
  await expect(page.locator('[data-resource]')).toHaveCount(6);
  await expect(card(page,'host-memory')).toContainText('12.4 GiB');await expect(card(page,'host-memory')).toContainText('/ 32 GiB');await expect(card(page,'host-memory')).toContainText('38.8%');
  await expect(card(page,'disk')).toContainText('118.6 GiB');await expect(card(page,'disk')).toContainText('124.6 GiB');await expect(card(page,'disk')).toContainText('46.3%');
  await expect(card(page,'container-cpu')).toContainText('0.13');await expect(card(page,'container-cpu')).toContainText('6.3%');await expect(card(page,'container-cpu')).toContainText('12.6%');
  await expect(card(page,'process-rss')).toContainText('92 MiB');await expect(card(page,'process-rss').getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('[data-task-count="running"]')).toContainText('4');await expect(page.locator('[data-task-count="running"]')).toContainText('/ 8');
  await page.getByRole('button',{name:'宿主机',exact:true}).click();await expect(page.locator('[data-resource]')).toHaveCount(3);
  await page.getByRole('button',{name:'Manager',exact:true}).click();await expect(page.locator('[data-resource]')).toHaveCount(3);
});

test('partial samples and unlimited quotas never invent zero or a capacity percentage',async({page})=>{
  const data=overviewFixture();data.resources.host={available:true,memory_used_bytes:1024**3,memory_total_bytes:4*1024**3};data.resources.container.memory_limit_bytes=null;data.resources.container.quota_cores=null;data.resources.disk={available:false};
  await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));await loginOverview(page);
  await expect(card(page,'host-cpu')).toContainText('—');await expect(card(page,'host-cpu')).not.toContainText('0.0%');await expect(card(page,'host-cpu')).not.toContainText('采样中');
  await expect(card(page,'host-memory')).toContainText('1 GiB');await expect(card(page,'container-memory')).toContainText('未设上限');await expect(card(page,'container-cpu')).toContainText('未设配额');
  for(const id of ['host-cpu','container-memory','container-cpu','disk'])await expect(card(page,id).getByRole('progressbar')).toHaveCount(0);
  data.resources.host.cpu_percent=null;delete data.resources.container.memory_limit_bytes;await page.reload();await page.locator('#updated').waitFor();
  await expect(card(page,'host-cpu')).toContainText('采样中');await expect(card(page,'container-memory')).toContainText('上限未获取');
});

test('resource cards align and remain readable across phone tablet and desktop in both languages',async({page})=>{
  const data=overviewFixture();data.resources.host.cpu_percent=84.2;data.resources.disk.used_bytes=236.8*1024**3;data.resources.disk.free_bytes=19.2*1024**3;data.resources.disk.available_bytes=6.4*1024**3;
  await page.route('**/admin/api/overview',route=>route.fulfill({json:data}));await loginOverview(page);
  for(const locale of ['zh-CN','en']){
    await chooseLanguage(page,locale);
    for(const width of [320,390,768,1440,1920]){
      await page.setViewportSize({width,height:1000});
      const boxes=await page.locator('[data-resource]').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,overflow:node.scrollWidth>node.clientWidth};}));
      expect(boxes).toHaveLength(6);expect(Math.max(...boxes.map(b=>b.height))-Math.min(...boxes.map(b=>b.height))).toBeLessThan(2);
      for(const box of boxes){expect(box.overflow).toBe(false);expect(box.x+box.width).toBeLessThanOrEqual(width);}
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const empty=page.locator('.ops-overview .ant-empty');await empty.scrollIntoViewIfNeeded();
      const emptyBox=await empty.boundingBox(),panelBox=await page.locator('.ops-overview .console-panel').boundingBox();expect(Math.abs(emptyBox.x+emptyBox.width/2-panelBox.x-panelBox.width/2)).toBeLessThan(2);
      await page.locator('.console-content').evaluate(el=>el.scrollTop=0);
      await page.screenshot({path:`.tmp/overview-implementation/overview-${locale}-${width}.png`,animations:'disabled'});
    }
  }
});
