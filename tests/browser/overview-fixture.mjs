const GiB=1024**3,MiB=1024**2;
export function overviewFixture(){return {
  sampled_at:Date.now(),resources:{sampled_at:Date.now(),host:{available:true,cpu_percent:24.8,cpu_cores:8,memory_used_bytes:12.4*GiB,memory_total_bytes:32*GiB,memory_available_bytes:19.6*GiB},container:{memory_used_bytes:182*MiB,memory_limit_bytes:2*GiB,cpu_percent:12.6,quota_cores:2},process:{pid:42,memory_rss_bytes:92*MiB},disk:{total_bytes:256*GiB,used_bytes:118.6*GiB,free_bytes:137.4*GiB,available_bytes:124.6*GiB}},
  platform:{gateway:{alive:true},runner:{ready:true},runtime:{paused:false,concurrency:8},tasks:{running:2,dispatching:1,completing:1,queued:12,suspended:1,completed:386,failed:2},recent_errors:[]},investigations:[]
};}
export async function loginOverview(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expectOverview(page);}
async function expectOverview(page){await page.locator('#updated').waitFor();}
