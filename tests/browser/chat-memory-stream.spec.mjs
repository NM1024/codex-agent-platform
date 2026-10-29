import {test,expect} from '@playwright/test';
import {navigate} from './navigation.mjs';

const firstId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',secondId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stamp=Date.now()-10000;
const running={id:'running-memory',role:'user',status:'running',text:'Current full request',partial_text:'Untruncated live reply '.repeat(1000),created_at:stamp};
const queued={id:'queued-memory',role:'user',status:'queued',text:'Retain this complete queued request',created_at:stamp+1};
const first={id:firstId,title:'Memory first',execution:{},queued_count:1,running_count:1,messages:[running],queue:[queued],actions:[],history:{has_more:false,before:null},olderLoaded:true,historyBacklog:[]};
const second={id:secondId,title:'Memory second',execution:{},queued_count:0,running_count:0,messages:[],queue:[],actions:[],history:{has_more:false,before:null}};

async function setup(page,{cursor=null}={}){
  await page.addInitScript(()=>{
    window.sources=[];window.EventSource=class extends EventTarget{constructor(){super();window.sources.push(this);}close(){}};
    window.emit=(event,data)=>window.sources.at(-1).dispatchEvent(new MessageEvent(event,{data:JSON.stringify(data)}));
    // Inspect the real React state without retaining message values in the test hook.
    window.sidebarState=[];
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberUnmount(){},onCommitFiberRoot(_renderer,root){
      const walk=fiber=>{
        const state=fiber.memoizedState?.memoizedState;
        if(Array.isArray(state)&&state.some(row=>row?.id==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))window.sidebarState=state.map(row=>({id:row.id,keys:Object.keys(row)}));
        if(fiber.child)walk(fiber.child);if(fiber.sibling)walk(fiber.sibling);
      };walk(root.current);
    }};
  });
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[first,second],next_cursor:cursor}}));
  await page.route(`**/admin/api/conversations/${firstId}`,route=>route.fulfill({json:first}));
  await page.route(`**/admin/api/conversations/${secondId}`,route=>route.fulfill({json:second}));
  await page.goto('/admin/');await page.locator('#password').fill('local-browser-password');await page.getByRole('button',{name:'登录工作台',exact:true}).click();await navigate(page,'chat');
  await expect(page.locator('.chat-header')).toContainText(first.title);
}
const sidebarHeavyKeys=page=>page.evaluate(()=>window.sidebarState.flatMap(row=>row.keys.filter(key=>['messages','queue','actions','history','olderLoaded','historyBacklog'].includes(key))));

test('sidebar retains only summaries after REST lists, snapshots, queue patches and navigation',async({page})=>{
  await setup(page);await expect.poll(()=>page.evaluate(()=>window.sidebarState.length)).toBe(2);
  expect(await sidebarHeavyKeys(page)).toEqual([]);
  await page.evaluate(first=>window.emit('conversation',first),first);
  await expect(page.locator('.assistant')).toContainText('Untruncated live reply');
  expect(await sidebarHeavyKeys(page)).toEqual([]);
  await page.evaluate(({id,queued})=>window.emit('patch',{conversation:{id,title:'Changed memory title',queue:[queued]},messages:[],actions:[]}),{id:firstId,queued});
  await expect(page.locator('.chat-header')).toContainText('Changed memory title');expect(await sidebarHeavyKeys(page)).toEqual([]);
  await page.locator('.conversation-list').getByRole('button',{name:second.title,exact:true}).click();await expect(page.locator('.chat-header')).toContainText(second.title);
  expect(await sidebarHeavyKeys(page)).toEqual([]);await expect(page.locator('#messages')).not.toContainText('Untruncated live reply');
});

test('metadata-only stream patches preserve the selected queue and all loaded message text',async({page})=>{
  await setup(page);await page.evaluate(first=>window.emit('conversation',first),first);
  const row=page.locator(`[data-queue-message-id="${queued.id}"]`);await expect(row).toContainText(queued.text);
  await page.evaluate(id=>window.emit('patch',{conversation:{id,title:'Metadata only'},messages:[],actions:[]}),firstId);
  await expect(page.locator('.chat-header')).toContainText('Metadata only');await expect(row).toContainText(queued.text);
  await expect(page.locator('.assistant .message-partial')).toHaveText(running.partial_text.trim());
});

test('older list pages and background refreshes keep transcript data out of sidebar state',async({page})=>{
  await setup(page,{cursor:'synthetic-older'});
  const older={...second,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',title:'Memory older'};
  await page.route('**/admin/api/conversations?before=*',route=>route.fulfill({json:{items:[older],next_cursor:null}}));
  await page.getByRole('button',{name:'加载更多对话',exact:true}).click();await expect(page.locator('.conversation-list')).toContainText(older.title);
  expect(await sidebarHeavyKeys(page)).toEqual([]);
  await page.route('**/admin/api/conversations',route=>route.fulfill({json:{items:[{...first,title:'Refreshed memory list'},second],next_cursor:null}}));
  await expect(page.locator('.conversation-list')).toContainText('Refreshed memory list',{timeout:7000});
  expect(await sidebarHeavyKeys(page)).toEqual([]);await expect(page.locator('.conversation-list')).toContainText(older.title);
});
