import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const id='abababab-abab-4bab-8bab-abababababab';
const fileId='11111111-1111-4111-8111-111111111111';
const messageId='22222222-2222-4222-8222-222222222222';
const permissionId='33333333-3333-4333-8333-333333333333';
const attachment={file_id:fileId,name:'sample.csv',mime:'text/csv',size:12,url:`/admin/api/conversations/${id}/files/${fileId}`,preview_url:`/admin/api/conversations/${id}/files/${fileId}?preview=1`,origin:'upload'};
async function setup(page,{existing=true,context={}}={}) {
  const conversation={id,title:'Sandbox chat',execution:{},messages:[],queue:[],actions:[]};
  await page.addInitScript(()=>{window.sources=[];window.EventSource=class extends EventTarget{constructor(){super();window.sources.push(this);}close(){}};window.emit=(type,data)=>window.sources.at(-1).dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));});
  await page.route('**/admin/api/conversations',route=>route.request().method()==='POST'?route.fulfill({json:conversation}):route.fulfill({json:{items:existing?[conversation]:[],next_cursor:null}}));
  await page.route(`**/admin/api/conversations/${id}`,route=>route.fulfill({json:conversation}));
  await page.route(`**/admin/api/conversations/${id}/sandbox`,route=>route.fulfill({json:{available:true,exists:false,files:[],permissions:[],executions:[],...context}}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('#message-input')).toBeVisible();
  return conversation;
}
const selectFile=(page,name='sample.csv',mimeType='text/csv',buffer=Buffer.from('name\nexample'))=>page.locator('#chat-file-input').setInputFiles({name,mimeType,buffer});

for(const existing of [true,false])test(`file-only ${existing?'existing':'new'} chat uploads lazily and preserves stable IDs on send failure`,async({page})=>{
  await setup(page,{existing});let uploads=0,sends=0;
  await page.route(`**/conversations/${id}/files`,async route=>{uploads++;expect(route.request().headers()['content-type']).toBe('application/octet-stream');expect(route.request().headers()['x-file-name']).toBe('sample.csv');await route.fulfill({status:201,json:attachment});});
  await page.route(`**/conversations/${id}/messages`,async route=>{sends++;expect(route.request().postDataJSON()).toMatchObject({text:'',file_ids:[fileId]});await route.fulfill(sends===1?{status:503,json:{error:{message:'Synthetic send failure'}}}:{json:{id:messageId,status:'queued',files:[attachment]}});});
  await selectFile(page);expect(uploads).toBe(0);await expect(page.locator('.sandbox-draft-files')).toContainText('sample.csv');
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByText('Synthetic send failure')).toBeVisible();
  await navigate(page,'overview');await navigate(page,'chat');await expect(page.locator('.sandbox-draft-files')).toContainText('sample.csv');
  await page.getByRole('button',{name:'发送',exact:true}).dblclick();await expect(page.locator('.sandbox-draft-files')).toHaveCount(0);expect(uploads).toBe(1);expect(sends).toBe(2);
});

test('file count and raw size validation retain the existing draft',async({page})=>{
  await setup(page);await selectFile(page);
  await selectFile(page,'too-large.zip','application/zip',Buffer.alloc(20*1024*1024+1));
  await expect(page.locator('.sandbox-draft-files')).toContainText('sample.csv');await expect(page.getByRole('alert')).toContainText('20 MiB');
  await page.locator('#chat-file-input').setInputFiles(Array.from({length:5},(_,i)=>({name:`extra-${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('x')})));
  await expect(page.getByRole('alert')).toContainText('5');await expect(page.locator('.sandbox-draft-file')).toHaveCount(1);
});

test('scoped permission cards lock decisions and show command domains limits and revoke',async({page})=>{
  const permission={id:permissionId,message_id:messageId,request_key:'install-example',status:'pending',reason:'Install a synthetic dependency',command:'npm install example-package',cwd:'.',domains:['registry.example.com'],timeout_seconds:180,memory_mb:1536,created_at:Date.now(),expires_at:Date.now()+600000};
  const conversation=await setup(page,{context:{permissions:[permission]}});conversation.messages.push({id:messageId,role:'user',status:'completed',text:'Prepare a report',created_at:Date.now()});
  // Reload the current view so its synthetic durable snapshot includes the source message.
  await navigate(page,'overview');await navigate(page,'chat');
  const card=page.locator(`[data-permission-id="${permissionId}"]`);await expect(card).toContainText('registry.example.com');await expect(card).toContainText(permission.command);await expect(card).toContainText('180');await expect(card).toContainText('1536');
  let calls=0;await page.route(`**/permissions/${permissionId}`,async route=>{calls++;const {decision}=route.request().postDataJSON();permission.status=decision==='allow'?'approved':'revoked';await new Promise(resolve=>setTimeout(resolve,100));await route.fulfill({json:permission});});
  await card.getByRole('button',{name:'允许本次操作',exact:true}).dblclick();await expect(card.getByRole('button',{name:'撤销授权',exact:true})).toBeVisible();expect(calls).toBe(1);
  await card.getByRole('button',{name:'撤销授权',exact:true}).click();await expect(card).toContainText('已撤销');expect(calls).toBe(2);
});

test('active formats are download only and text previews render escaped text',async({page})=>{
  const html={...attachment,file_id:'html-file',name:'report.html',mime:'text/html',url:`/admin/api/conversations/${id}/files/html-file`,preview_url:`/admin/api/conversations/${id}/files/html-file?preview=1`,origin:'sandbox',message_id:messageId};
  const text={...attachment,mime:'text/plain; charset=utf-8',message_id:messageId};
  const conversation=await setup(page,{context:{files:[html,text]}});conversation.messages.push({id:messageId,role:'user',status:'completed',text:'Prepare files',files:[text],created_at:Date.now()});
  await page.route(`**/files/${fileId}?preview=1`,route=>route.fulfill({contentType:'text/plain',body:'<script>window.unsafe=true</script>'}));
  await navigate(page,'overview');await navigate(page,'chat');
  await expect(page.locator('.sandbox-attachment').filter({hasText:'report.html'}).getByRole('button')).toHaveCount(0);
  await expect(page.locator('.sandbox-attachment').filter({hasText:'sample.csv'})).toHaveCount(1);
  await page.getByRole('button',{name:'预览文件：sample.csv',exact:true}).click();await expect(page.locator('.sandbox-text-preview')).toContainText('<script>');expect(await page.evaluate(()=>window.unsafe)).toBeUndefined();
});

test('logout invalidates a delayed upload without posting a message or restoring files',async({page})=>{
  await setup(page);let release;const gate=new Promise(resolve=>{release=resolve;});let sends=0;
  await page.route(`**/conversations/${id}/files`,async route=>{await gate;await route.fulfill({status:201,json:attachment});});
  await page.route(`**/conversations/${id}/messages`,route=>{sends++;return route.fulfill({json:{id:messageId,status:'queued'}});});
  await selectFile(page);await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.chat-image-busy')).toContainText('正在上传文件');
  await page.locator('#logout').click();await expect(page.locator('#login')).toBeVisible();release();
  await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.sandbox-draft-files')).toHaveCount(0);expect(sends).toBe(0);
});

test('execution cancellation waits for confirmation and output stays plain text',async({page})=>{
  const job={execution_id:'synthetic-job',message_id:messageId,request_key:'synthetic-job',instance_id:id,status:'running',stdout:'<img src=x onerror=unsafe()>',stdout_truncated:true,stderr:'synthetic warning',exit_code:null,created_at:Date.now(),timeout_seconds:60,memory_mb:1024};
  const conversation=await setup(page,{context:{executions:[job]}});conversation.messages.push({id:messageId,role:'user',status:'completed',text:'Run a test',created_at:Date.now()});
  await navigate(page,'overview');await navigate(page,'chat');const card=page.locator('[data-execution-id="synthetic-job"]');
  let release;const gate=new Promise(resolve=>{release=resolve;});let cancels=0;
  await page.route('**/jobs/synthetic-job/cancel',async route=>{cancels++;await gate;job.status='cancelled';job.reason='Temporary workspace removed';await route.fulfill({json:job});});
  await card.getByRole('button',{name:'停止执行',exact:true}).click();await expect(card).toContainText('正在执行');await expect(card.getByRole('button',{name:'停止执行',exact:true})).toBeDisabled();release();
  await expect(card).toContainText('执行已取消');expect(cancels).toBe(1);await card.getByText('查看命令输出',{exact:true}).click();await expect(card.locator('.sandbox-output').first()).toHaveText(job.stdout);await expect(card.locator('img')).toHaveCount(0);
  await expect(card).toContainText('此处仅显示部分输出，可让 Agent 查询保留的完整输出。');
});

test('English permission cards and file controls fit phone layouts',async({page})=>{
  const permission={id:permissionId,message_id:messageId,request_key:'install-example',status:'pending',reason:'Install a synthetic dependency',command:'npm install example-package',cwd:'.',domains:['registry.example.com'],timeout_seconds:180,memory_mb:1536,created_at:Date.now(),expires_at:Date.now()+600000};
  const conversation=await setup(page,{context:{permissions:[permission]}});conversation.messages.push({id:messageId,role:'user',status:'completed',text:'Prepare a report',created_at:Date.now()});
  await navigate(page,'overview');await navigate(page,'chat');await page.locator('#app-language').click();await page.locator('.ant-select-dropdown:visible, .language-menu:visible').getByText('English',{exact:true}).click();
  const card=page.locator(`[data-permission-id="${permissionId}"]`);await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();
  await selectFile(page,'a-very-long-synthetic-input-filename-for-layout.csv');
  for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
    await page.setViewportSize(viewport);await expect(page.getByRole('button',{name:'Add files',exact:true})).toBeInViewport({ratio:1});await expect(page.getByRole('button',{name:'Send',exact:true})).toBeInViewport({ratio:1});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBeTruthy();
    await expect(card).toContainText('Timeout: 180 seconds');
  }
});

test('failed decisions retain permission details and denial does not disappear on a polling failure',async({page})=>{
  const permission={id:permissionId,message_id:messageId,request_key:'install-example',status:'pending',reason:'Install a synthetic dependency',command:'npm install example-package',cwd:'.',domains:['registry.example.com'],timeout_seconds:180,memory_mb:1536,created_at:Date.now(),expires_at:Date.now()+600000};
  const conversation=await setup(page,{context:{permissions:[permission]}});conversation.messages.push({id:messageId,role:'user',status:'completed',text:'Prepare a report',created_at:Date.now()});
  await navigate(page,'overview');await navigate(page,'chat');const card=page.locator(`[data-permission-id="${permissionId}"]`);await expect(card).toBeVisible();
  let attempts=0;await page.route(`**/permissions/${permissionId}`,route=>{attempts++;if(attempts===1)return route.fulfill({status:503,json:{error:{message:'Synthetic decision failure'}}});permission.status='denied';return route.fulfill({json:permission});});
  await card.getByRole('button',{name:'拒绝本次操作',exact:true}).click();await expect(page.getByText('Synthetic decision failure')).toBeVisible();await expect(card).toContainText(permission.command);
  await card.getByRole('button',{name:'拒绝本次操作',exact:true}).click();await expect(card).toContainText('已拒绝');
  await page.route(`**/conversations/${id}/sandbox`,route=>route.fulfill({status:503,json:{error:{message:'Synthetic polling failure'}}}));
  await expect(page.getByText('沙箱状态暂时不可用，已保留当前记录。')).toBeVisible();await expect(card).toContainText('已拒绝');
});

test('message patches preserve attachment linkage when the patch omits files',async({page})=>{
  const conversation=await setup(page);conversation.messages.push({id:messageId,role:'user',status:'running',text:'Read the CSV',files:[attachment],created_at:Date.now()});
  await navigate(page,'overview');await navigate(page,'chat');await expect(page.locator('.sandbox-attachment')).toContainText('sample.csv');
  await page.evaluate(({id,messageId})=>window.emit('patch',{conversation:{id},messages:[{id:messageId,role:'user',status:'completed',text:'Read the CSV',created_at:Date.now()}],actions:[]}),{id,messageId});
  await expect(page.locator('.sandbox-attachment')).toContainText('sample.csv');await expect(page.locator('.sandbox-attachment')).toHaveCount(1);
});

test('file-only queued requests retain their files when withdrawn and requeued',async({page})=>{
  const conversation=await setup(page);const message={id:messageId,role:'user',status:'queued',text:'',files:[attachment],created_at:Date.now()};conversation.messages=[message];conversation.queue=[message];
  await navigate(page,'overview');await navigate(page,'chat');const row=page.locator(`[data-queue-message-id="${messageId}"]`);await expect(row).toContainText('sample.csv');
  await page.route(`**/messages/${messageId}/withdraw`,route=>{message.status='draft';return route.fulfill({json:message});});
  await page.route(`**/messages/${messageId}/requeue`,route=>{expect(route.request().postDataJSON()).toEqual({text:''});message.status='queued';return route.fulfill({json:message});});
  await row.getByRole('button',{name:'撤回编辑',exact:true}).click();await expect(row.getByRole('button',{name:'重新排队',exact:true})).toBeEnabled();await expect(row.locator('.sandbox-attachment')).toContainText('sample.csv');
  await row.getByRole('button',{name:'重新排队',exact:true}).click();await expect(row.getByRole('textbox')).toHaveCount(0);await expect(row).toContainText('sample.csv');
});

test('retry after a partial batch upload reuses the successful file',async({page})=>{
  await setup(page);const calls=[];let sends=0;
  await page.route(`**/conversations/${id}/files`,route=>{
    const name=decodeURIComponent(route.request().headers()['x-file-name']);calls.push(name);
    if(name==='second.txt'&&calls.filter(value=>value===name).length===1)return route.fulfill({status:503,json:{error:{message:'Synthetic second upload failure'}}});
    const uploadedId=name==='first.txt'?fileId:'44444444-4444-4444-8444-444444444444';
    return route.fulfill({status:201,json:{...attachment,file_id:uploadedId,name,url:`/admin/api/conversations/${id}/files/${uploadedId}`,preview_url:`/admin/api/conversations/${id}/files/${uploadedId}?preview=1`}});
  });
  await page.route(`**/conversations/${id}/messages`,route=>{sends++;expect(route.request().postDataJSON().file_ids).toEqual([fileId,'44444444-4444-4444-8444-444444444444']);return route.fulfill({json:{id:messageId,status:'queued'}});});
  await page.locator('#chat-file-input').setInputFiles(['first.txt','second.txt'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.from('synthetic')})));
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByText('Synthetic second upload failure')).toBeVisible();expect(sends).toBe(0);
  await navigate(page,'overview');await navigate(page,'chat');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.sandbox-draft-files')).toHaveCount(0);
  expect(calls).toEqual(['first.txt','second.txt','second.txt']);expect(sends).toBe(1);
});

test('permission continuations cannot steer while ordinary file-only requests can',async({page})=>{
  const conversation=await setup(page);
  const active={id:'55555555-5555-4555-8555-555555555555',role:'user',status:'running',text:'Active task',created_at:Date.now()};
  const continuation={id:messageId,role:'user',status:'queued',text:'Continue the approved command',steerable:false,created_at:Date.now()+1};
  const ordinary={id:'66666666-6666-4666-8666-666666666666',role:'user',status:'queued',text:'',files:[attachment],created_at:Date.now()+2};
  conversation.messages=[active,continuation,ordinary];conversation.queue=[continuation,ordinary];
  await navigate(page,'overview');await navigate(page,'chat');
  await expect(page.locator(`[data-queue-message-id="${messageId}"]`).getByRole('button',{name:'立即引导',exact:true})).toBeDisabled();
  await expect(page.locator(`[data-queue-message-id="${ordinary.id}"]`).getByRole('button',{name:'立即引导',exact:true})).toBeEnabled();
});
