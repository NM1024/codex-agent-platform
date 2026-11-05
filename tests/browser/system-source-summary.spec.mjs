import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const sampledAt=Date.UTC(2026,0,1);
const sources=(at=sampledAt)=>['manager','gateway','runner'].map(service=>({service,available:true,observed_at:at,error_code:null}));
const summary=(overrides={})=>({sampled_at:sampledAt,sources:sources(),summary:{complete:true,states:{retrying:0,running:0},unresolved:0,recovered_24h:0,collections:[],...overrides},work:[],issues:[]});
async function setup(page,status=summary()) {
  await page.route('**/admin/api/operations',async route=>{
    const {action}=route.request().postDataJSON()??{};
    if(action==='system_status')return route.fulfill({json:status});
    if(['system_issue','system_work','system_logs'].includes(action)) {
      const index=['system_issue','system_work','system_logs'].indexOf(action);
      return route.fulfill({json:{items:[],next_cursor:null,sources:sources(sampledAt+(index+1)*60000)}});
    }
    return route.continue();
  });
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'system');
  await expect(page.locator('#system-metrics strong')).toHaveText(['0','0','0','0']);
}

test('healthy system summary leaves one source strip with the current tab collection times',async({page})=>{
  await setup(page);
  for(const [index,name] of ['待处理问题','后台工作','系统日志'].entries()) {
    await page.getByRole('tab',{name,exact:true}).click();
    await expect(page.locator('#system-page .system-sources')).toHaveCount(1);
    await expect(page.locator('#system-sources .system-source')).toHaveCount(3);
    await expect.poll(()=>page.locator('#system-sources time').evaluateAll(items=>items.map(item=>item.dateTime))).toEqual(Array(3).fill(new Date(sampledAt+(index+1)*60000).toISOString()));
    await expect(page.locator('.system-summary-source')).toHaveCount(0);
    await expect(page.locator('.system-summary-alerts')).toHaveCount(0);
    await expect(page.locator('#system-page')).not.toContainText('最后采集');
  }
  await page.screenshot({path:'.tmp/inspection-handoff/system-sources-once.png',fullPage:true,animations:'disabled'});
});

test('incomplete summary and collection evidence remain visible when current tab sources are healthy',async({page})=>{
  const status=summary({complete:false,collections:[
    {service:'gateway',pending:false,gap_count:1,failed_operations:2,first_failed_at:sampledAt,last_failed_at:sampledAt,last_recovered_at:sampledAt+1000,gap_started_at:sampledAt},
    {service:'runner',pending:true,gap_count:0,failed_operations:1,first_failed_at:sampledAt,last_failed_at:sampledAt,last_recovered_at:null,gap_started_at:sampledAt},
  ]});
  status.sources[1]={...status.sources[1],available:false,error_code:'SYSTEM_SOURCE_UNAVAILABLE'};
  await setup(page,status);
  await expect(page.locator('#system-metrics')).toContainText('仅可用来源');
  await expect(page.locator('.system-summary-alerts')).toContainText('概览来源不完整');
  await expect(page.locator('.system-summary-alerts')).toContainText('SYSTEM_SOURCE_UNAVAILABLE');
  await expect(page.locator('.system-summary-alerts')).toContainText('Gateway · 采集存在缺口');
  await expect(page.locator('.system-summary-alerts')).toContainText('Runner · 待补记采集证据');
  await expect(page.locator('.system-summary-alerts')).toContainText('采集失败次数 2');
  await expect(page.locator('#system-sources .system-source-unavailable')).toHaveCount(0);
  await expect(page.locator('#system-page .system-sources')).toHaveCount(1);
  await page.screenshot({path:'.tmp/inspection-handoff/system-sources-partial.png',fullPage:true,animations:'disabled'});
  await page.locator('#app-language').click();
  await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
  await expect(page.locator('.system-summary-alerts')).toContainText('Summary sources are incomplete');
  await expect(page.locator('.system-summary-alerts')).toContainText('Collection evidence pending');
});
