import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const runs=Array.from({length:50},(_,index)=>({id:`synthetic-schedule-run-${String(index).padStart(2,'0')}`,schedule_id:'synthetic-plan',schedule_name:`Synthetic plan ${index}`,kind:index%2?'task':'inspection',status:index===1?'failed':'queued',timezone:'Etc/UTC',created_at:1700000000000+index,due_at:1700000000000,error:index===1?{code:'SYNTHETIC_ERROR',message:'Synthetic execution error'}:undefined}));
const channel=(id,name,enabled=true)=>({id,name,provider:'custom',description:'Synthetic safe channel metadata',instructions:'',enabled,revision:1,configured:{url:true,token:false,headers:false,signingSecret:false},format:{instructions:'',example:{}}});
const active=channel('synthetic-active-channel','Synthetic active channel'),disabled=channel('synthetic-disabled-channel','Synthetic disabled channel',false);
const binding={notification_channels:[active.id,disabled.id,'synthetic-missing-channel'],notification_revision:1,channels:[active,disabled],available_channels:[channel('synthetic-unbound-channel','Synthetic unbound channel')],history:{items:[{batch_id:'synthetic-batch',notification_key:'synthetic-notification-event',created_at:1700000000000,deliveries:[{channel_id:active.id,channel_name:active.name,provider:'custom',status:'accepted',http_status:200,provider_code:null,summary:'Synthetic accepted delivery',body:{text:'Synthetic notification body'},created_at:1700000000000,updated_at:1700000000000}]}],next_cursor:null}};
async function openHistory(page){
 await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();await navigate(page,'tasks');await page.getByRole('tab',{name:'定时任务',exact:true}).click();
}

test('scheduled history uses the shared responsive table with filters, pagination and named icon actions',async({page})=>{
 const queries=[];
 await page.route('**/admin/api/schedule-runs?*',route=>{const query=Object.fromEntries(new URL(route.request().url()).searchParams);queries.push(query);return route.fulfill({json:query.search||query.offset==='50'?[runs[1]]:runs});});
 await openHistory(page);
 const table=page.locator('.responsive-table.expanded-table');await expect(table).toBeVisible();
 for(const name of ['计划名称','计划类型','执行编号','执行状态','错误','创建时间','操作'])await expect(table.getByRole('columnheader',{name,exact:true})).toBeVisible();
 const row=table.getByRole('row').filter({hasText:runs[1].id});await expect(row).toContainText('Synthetic execution error');await expect(row).toContainText('业务任务');
 for(const name of ['详情','调查']){const action=row.getByRole('button',{name,exact:true});await expect(action).toHaveText('');await expect(action.locator('svg')).toBeVisible();}
 await expect(page.locator('.notification-execution')).toHaveCount(0);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect.poll(()=>queries.at(-1)?.offset).toBe('50');await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'上一页',exact:true}).click();await expect.poll(()=>queries.at(-1)?.offset).toBe('0');await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeEnabled();
 await page.getByRole('combobox',{name:'任务状态',exact:true}).click();await page.getByRole('option',{name:'执行失败',exact:true}).click();await page.getByRole('textbox',{name:'搜索定时执行',exact:true}).fill('Synthetic plan 1');await page.getByRole('button',{name:'查询',exact:true}).click();
 await expect.poll(()=>queries.at(-1)).toMatchObject({search:'Synthetic plan 1',status:'failed',offset:'0',limit:'50'});await expect(table.getByRole('row').filter({hasText:runs[1].id})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(row.getByRole('button',{name:'详情',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:'Responsive history layout settles after viewport resize'}).toBeLessThanOrEqual(390);await page.screenshot({path:'.tmp/agent-tab-cron/scheduled-history-mobile.png',animations:'disabled'});
});

test('execution notifications show bound metadata and history without editing or channel catalogue requests',async({page})=>{
 await page.route('**/admin/api/schedule-runs?*',route=>route.fulfill({json:[runs[0],runs[3]]}));
 let taskReads=0;
 await page.route('**/admin/api/inspections/*/notifications',route=>route.fulfill({json:binding}));
 await page.route('**/admin/api/tasks/*/notifications',route=>{taskReads++;return route.fulfill(taskReads===1?{status:503,json:{error:{message:'Synthetic temporary read failure'}}}:{json:{...binding,notification_channels:[],channels:[],history:{items:[],next_cursor:null}}});});
 await openHistory(page);
 const catalogueReads=[],writes=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/admin/api/notification-channels')catalogueReads.push(path);if(request.method()!=='GET'&&path.endsWith('/notifications'))writes.push(path);});
 await page.getByRole('row').filter({hasText:runs[0].id}).getByRole('button',{name:'详情',exact:true}).click();const drawer=page.getByRole('dialog',{name:/定时执行详情/});
 for(const text of [active.name,disabled.name,'synthetic-missing-channel','自定义 JSON Webhook','已启用','已停用','不可用'])await expect(drawer).toContainText(text);
 await expect(drawer).not.toContainText('Synthetic unbound channel');await expect(drawer.getByRole('combobox')).toHaveCount(0);await expect(drawer.getByRole('textbox')).toHaveCount(0);await expect(drawer.getByRole('button',{name:/保存|重新读取|重试/})).toHaveCount(0);await expect(drawer).not.toContainText('保存绑定不会发送消息');
 await drawer.getByText('synthetic-notification-event',{exact:true}).click();await expect(drawer).toContainText('Synthetic accepted delivery');await drawer.getByText('查看消息内容',{exact:true}).click();await expect(drawer).toContainText('Synthetic notification body');await page.screenshot({path:'.tmp/agent-tab-cron/execution-notifications-readonly.png',animations:'disabled'});
 await drawer.getByRole('button',{name:/^(关闭|Close)$/}).click();await page.getByRole('row').filter({hasText:runs[3].id}).getByRole('button',{name:'详情',exact:true}).click();await expect(drawer.getByRole('alert')).toContainText('通知绑定暂时无法读取');await drawer.getByRole('button',{name:'重试',exact:true}).click();await expect(drawer).toContainText('暂无通知记录');await expect(drawer).not.toContainText(active.name);await expect(drawer.getByRole('button',{name:'重试',exact:true})).toHaveCount(0);await expect(drawer.getByRole('combobox')).toHaveCount(0);expect(taskReads).toBe(2);expect(catalogueReads).toEqual([]);expect(writes).toEqual([]);
});
