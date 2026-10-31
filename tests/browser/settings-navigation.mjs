import {expect} from '@playwright/test';

export async function selectSettingsCategory(page,scope){
  const selector=page.locator('#settings-category');
  if(await selector.isVisible()){
    await selector.click();
    await page.locator('.ant-select-dropdown:visible [data-settings-choice="'+scope+'"]').click();
    await expect(selector).toHaveAttribute('aria-expanded','false');
  }else{
    const tab=page.getByRole('tab').filter({has:page.locator('[data-settings-tab="'+scope+'"]')});
    await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');
  }
}
