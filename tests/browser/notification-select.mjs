import {expect} from '@playwright/test';
export async function setNotificationChoice(page,container,name,checked){
 const input=container.getByRole('combobox',{name:'选择通知渠道',exact:true});await input.click();
 const option=page.getByRole('option',{name});await expect(option).toBeVisible();
 const selected=(await option.getAttribute('aria-selected'))==='true';
 if(selected!==checked){if(!checked&&(await option.getAttribute('aria-disabled'))==='true'){await page.keyboard.press('Escape');await container.getByRole('button',{name:name instanceof RegExp?new RegExp('移除通知渠道：'+name.source):'移除通知渠道：'+name}).click();}else await option.click();}
 await page.keyboard.press('Escape');
}
export async function expectNotificationChoice(page,container,name,checked){
 await container.getByRole('combobox',{name:'选择通知渠道',exact:true}).click();await expect(page.getByRole('option',{name})).toHaveAttribute('aria-selected',String(checked));await page.keyboard.press('Escape');
}
