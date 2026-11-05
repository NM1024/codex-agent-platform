import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

async function login(page){await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await expect(page.locator('#workspace')).toBeVisible();}
for(const scheduled of [false,true])test(`${scheduled?'schedule':'task'} records use filtered totals, adjustable sizes and reset filters to page one`,async({page})=>{
  const path=scheduled?'schedule-runs':'tasks',paginationId=scheduled?'schedule-run-pagination':'task-pagination',requests=[];
  await page.route(`**/admin/api/${path}?*`,async route=>{
    const query=new URL(route.request().url()).searchParams;requests.push(Object.fromEntries(query));
    const total=query.get('search')?7:135,offset=Number(query.get('offset')),limit=Number(query.get('limit'));
    const items=Array.from({length:Math.max(0,Math.min(limit,total-offset))},(_,n)=>{
      const id=`synthetic-pagination-${offset+n}`;
      return scheduled?{id,schedule_id:'synthetic-plan',schedule_name:'Synthetic pagination plan',kind:'inspection',status:'queued',timezone:'Etc/UTC',created_at:1,due_at:1}:{task_id:id,request_id:id,type:'synthetic.pagination',status:'queued',created_at:1,updated_at:1};
    });
    await route.fulfill({json:{items,total}});
  });
  await login(page);await navigate(page,'tasks');if(scheduled)await page.getByRole('tab',{name:'定时任务',exact:true}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'20',offset:'0',include_total:'1'});
  const pagination=page.locator('#'+paginationId);
  await expect(pagination).toContainText('135');
  await pagination.getByRole('button',{name:'下一页',exact:true}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'20',offset:'20'});
  await pagination.getByRole('combobox').click();
  const options=page.getByRole('option');
  await expect(options).toHaveCount(4);
  await page.getByRole('option',{name:/^100/}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'100',offset:'0'});
  await pagination.getByRole('button',{name:'下一页',exact:true}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'100',offset:'100'});
  await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  await page.getByRole('textbox',{name:scheduled?'搜索定时执行':'搜索任务',exact:true}).fill('needle');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect.poll(()=>requests.at(-1)).toMatchObject({limit:'100',offset:'0',search:'needle'});
  await expect(pagination).toContainText('7');
  await expect(pagination).not.toContainText('135');
  await expect(pagination.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
  await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
});

test('legacy task arrays remain readable without reporting a fabricated total',async({page})=>{
  await page.route('**/admin/api/tasks?*',route=>route.fulfill({json:[{task_id:'synthetic-legacy-record',request_id:'legacy',type:'synthetic.pagination',status:'queued',created_at:1,updated_at:1}]}));
  await login(page);await navigate(page,'tasks');
  await expect(page.getByRole('row').filter({hasText:'synthetic-legacy-record'})).toBeVisible();
  const pagination=page.locator('#task-pagination');await expect(pagination).toBeVisible();
  await expect(pagination).not.toContainText(/共\s*1\s*条|Total\s*1/i);
});

for(const scheduled of [false,true])test(`${scheduled?'schedule':'task'} failed filters do not report an old total as matching`,async({page})=>{
  const path=scheduled?'schedule-runs':'tasks',paginationId=scheduled?'schedule-run-pagination':'task-pagination';
  await page.route(`**/admin/api/${path}?*`,route=>{
    const query=new URL(route.request().url()).searchParams;
    return route.fulfill(query.get('search')?{status:503,json:{error:{code:'SYNTHETIC_UNAVAILABLE',message:'Synthetic unavailable'}}}:{json:{items:[],total:135}});
  });
  await login(page);await navigate(page,'tasks');if(scheduled)await page.getByRole('tab',{name:'定时任务',exact:true}).click();
  const pagination=page.locator('#'+paginationId);await expect(pagination).toContainText('共 135 条');
  await page.getByRole('textbox',{name:scheduled?'搜索定时执行':'搜索任务',exact:true}).fill('unavailable filter');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(pagination).toContainText('总条数暂不可用');await expect(pagination).not.toContainText('共 135 条');
  await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
});
