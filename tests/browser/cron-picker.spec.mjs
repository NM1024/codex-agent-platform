import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

test.beforeEach(async({page})=>{
 await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.locator('#workspace')).toBeVisible();await navigate(page,'schedules');await page.getByRole('button',{name:'新增定时计划',exact:true}).click();
});

test('Cron input opens a dedicated picker and preserves complex manual expressions',async({page})=>{
 const modal=page.getByRole('dialog',{name:'新增定时计划'}),input=modal.getByLabel('Cron 规则',{exact:true});
 await expect(page.locator('#schedule-frequency')).toHaveCount(0);
 await input.fill('15,45 7-19/2 * JAN,MAR MON-FRI');
 const picker=page.getByRole('dialog',{name:'Cron 选择器',exact:true});await expect(picker).toBeVisible();
 await expect(picker.locator('.ant-select').first()).toContainText('自定义 Cron');
 await page.keyboard.press('Escape');await expect(picker).toHaveCount(0);await expect(input).toBeFocused();await expect(modal).toBeVisible();
 await modal.getByRole('tab',{name:'通知渠道',exact:true}).click();await modal.getByRole('tab',{name:'基本信息',exact:true}).click();await expect(input).toHaveValue('15,45 7-19/2 * JAN,MAR MON-FRI');
 await input.fill('0 0 9 * * *');await expect(input).toHaveAttribute('aria-invalid','true');await expect(modal).toContainText('请输入有效的五字段 Cron 规则。');await page.keyboard.press('Escape');
 await input.fill('0 7 * * 1-5');await expect(input).toHaveAttribute('aria-invalid','false');
});

test('opening during modal enter keeps the picker usable for weekly selection and timezone preview',async({page})=>{
 const modal=page.getByRole('dialog',{name:'新增定时计划'}),input=modal.getByLabel('Cron 规则',{exact:true});
 await modal.getByRole('button',{name:'打开 Cron 选择器',exact:true}).click();const picker=page.getByRole('dialog',{name:'Cron 选择器',exact:true});
 await picker.getByLabel('执行频率',{exact:true}).click();await page.getByRole('option',{name:'每周',exact:true}).click();
 await picker.getByLabel('执行时间',{exact:true}).fill('20:30');await picker.getByLabel('执行日期',{exact:true}).click();await page.getByRole('option',{name:'星期五',exact:true}).click();await expect(input).toHaveValue('30 20 * * 5');
 await picker.getByRole('button',{name:'完成',exact:true}).click();await expect(picker).toHaveCount(0);await expect(modal.locator('#schedule-frequency')).toHaveCount(0);
 await modal.getByLabel('时区',{exact:true}).fill('New_York');await page.getByRole('option',{name:/America\/New_York/}).click();await expect(modal.locator('.schedule-preview')).toContainText('America/New_York');
 await input.focus();await page.keyboard.press('ArrowDown');await expect(page.locator('#schedule-frequency')).toBeFocused();
});

test('Cron picker stays inside mobile and short viewport bounds',async({page})=>{
 for(const viewport of [{width:320,height:740},{width:568,height:320}]){
  await page.setViewportSize(viewport);await page.getByRole('button',{name:'打开 Cron 选择器',exact:true}).click();const picker=page.getByRole('dialog',{name:'Cron 选择器',exact:true});await expect(picker).toBeVisible();
  const box=await picker.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await picker.getByRole('button',{name:'完成',exact:true}).click();await expect(picker).toHaveCount(0);
 }
 await page.screenshot({path:'.tmp/agent-tab-cron/cron-picker-mobile.png'});
});
