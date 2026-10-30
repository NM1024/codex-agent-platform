import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider} from 'antd';
import {ConsoleProvider} from '../../frontend/src/context';
import NotificationChannelsPanel from '../../frontend/src/NotificationChannelsPanel';
import {NotificationBindingsPanel} from '../../frontend/src/NotificationBindingsPanel';
import {NotificationRetryDialog} from '../../frontend/src/NotificationRetryDialog';
import {ScheduleNotificationExecutions} from '../../frontend/src/ScheduleNotificationExecutions';
import '../../frontend/src/console.css';
const query=new URLSearchParams(location.search);
const kind=query.get('kind')==='schedule'?'schedule':query.get('kind')==='inspection'?'inspection':'task';
function RetryHarness(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Reopen retry</button><NotificationRetryDialog task={{task_id:'synthetic-task',notification_channels:['synthetic-channel','old-channel']}} open={open} onCancel={()=>setOpen(false)} onSubmit={async ids=>{const response=await fetch('/admin/api/retry-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});if(!response.ok)throw new Error('Synthetic retry failure');setOpen(false);}}/></>;}
createRoot(document.getElementById('root')!).render(<ConfigProvider><ConsoleProvider>{query.has('retry')?<RetryHarness/>:query.has('executions')?<ScheduleNotificationExecutions scheduleId="synthetic-schedule"/>:location.search.includes('bindings')?<NotificationBindingsPanel kind={kind} id="synthetic-task" readOnly={query.has('readonly')}/>:<NotificationChannelsPanel/>}</ConsoleProvider></ConfigProvider>);
