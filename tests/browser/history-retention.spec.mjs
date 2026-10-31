import {selectSettingsCategory} from './settings-navigation.mjs';
import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

async function operation(page,action,args={}) {
  const response=await page.request.post('/admin/api/operations',{data:{action,args}});
  expect(response.ok()).toBeTruthy();return response.json();
}
test.beforeEach(async({page})=>{
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await navigate(page,'settings');
  const config=await operation(page,'configuration_get',{scope:'retention'});
  await operation(page,'configuration_update',{scope:'retention',revision:config.revision,patch:{enabled:false,days:60}});
  await navigate(page,'overview');await navigate(page,'settings');
  await selectSettingsCategory(page,'retention');
});

test('retention has an opt-in switch, 30/60 day presets and persisted custom age',async({page})=>{
  const toggle=page.getByRole('switch',{name:'自动清理历史数据'});
  await expect(toggle).not.toBeChecked();await expect(page.getByRole('spinbutton',{name:'保留天数'})).toHaveValue('60');
  await page.getByRole('button',{name:'30 天',exact:true}).click();
  await toggle.click();await page.getByRole('button',{name:'保存清理设置'}).click();
  await expect.poll(async()=>(await operation(page,'configuration_get',{scope:'retention'})).values).toEqual({enabled:true,days:30});
  await page.getByRole('spinbutton',{name:'保留天数'}).fill('45');
  await page.getByRole('button',{name:'保存清理设置'}).click();
  await expect.poll(async()=>(await operation(page,'configuration_get',{scope:'retention'})).values.days).toBe(45);
  await toggle.click();await page.getByRole('button',{name:'保存清理设置'}).click();
  await expect.poll(async()=>(await operation(page,'configuration_get',{scope:'retention'})).values).toEqual({enabled:false,days:45});
});

test('stale retention settings cannot silently overwrite another operator policy',async({page})=>{
  await page.getByRole('button',{name:'30 天',exact:true}).click();
  const config=await operation(page,'configuration_get',{scope:'retention'});
  await operation(page,'configuration_update',{scope:'retention',revision:config.revision,patch:{days:90}});
  await page.getByRole('button',{name:'保存清理设置'}).click();
  await expect(page.getByRole('alert').filter({hasText:'配置已被其他操作更新'})).toBeVisible();
  expect((await operation(page,'configuration_get',{scope:'retention'})).values.days).toBe(90);
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.getByRole('spinbutton',{name:'保留天数'})).toHaveValue('90');
});

test('retention controls stay usable in English on a phone without enabling cleanup on navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
  await expect(page.getByRole('switch',{name:'Automatically delete history'})).not.toBeChecked();
  await expect(page.getByRole('spinbutton',{name:'Retention days'})).toHaveValue('60');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await operation(page,'configuration_get',{scope:'retention'})).values.enabled).toBe(false);
});
