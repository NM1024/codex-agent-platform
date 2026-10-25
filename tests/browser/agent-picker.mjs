import {expect} from '@playwright/test';

export const chatPicker=page=>page.locator('.chat-agent-panel:visible');
export async function openChatPicker(page){if(await page.locator('#chat-model').getAttribute('aria-expanded')!=='true')await page.locator('#chat-model').click();await expect(chatPicker(page)).toBeInViewport({ratio:1});await chatPicker(page).hover({position:{x:8,y:8}});}
export async function chooseChatModel(page,label){await openChatPicker(page);await chatPicker(page).getByRole('radio',{name:label,exact:true}).click();await page.keyboard.press('Escape');await expect(chatPicker(page)).toHaveCount(0);}
export async function chooseChatEffort(page,value){
  await openChatPicker(page);
  if(value==='__inherit__'){const reset=chatPicker(page).getByRole('button',{name:'恢复默认思考程度',exact:true});if(await reset.isEnabled())await reset.click();}
  else if(value===null)await chatPicker(page).getByRole('button',{name:'使用模型默认',exact:true}).click();
  else await chatPicker(page).locator(`[data-effort="${value}"]`).click();
  await page.keyboard.press('Escape');await expect(chatPicker(page)).toHaveCount(0);
}
