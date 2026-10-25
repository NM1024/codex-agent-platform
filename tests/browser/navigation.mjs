export async function navigate(page,view){
  if(page.viewportSize()?.width<992){
    const toggle=page.locator('#navigation-toggle');
    if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
    await page.locator(`.mobile-navigation [data-view="${view}"]`).click();
  }else await page.locator(`.console-sidebar [data-view="${view}"]`).click();
}
