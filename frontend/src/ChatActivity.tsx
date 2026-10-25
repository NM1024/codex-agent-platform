import {useEffect,useState} from 'react';
import {MessageTime} from './ChatMessage';
import {useConsole} from './context';
import type {Action,Message} from './types';

export const messageStatuses:Record<string,string>={queued:'排队中',running:'运行中',executing:'操作中',unknown:'结果未知',interrupted:'等待继续',recovering:'恢复中',completed:'执行完成',failed:'执行失败',steered:'已引导'};
export const isPending=(status:string)=>['queued','running','interrupted','recovering'].includes(status);
export function MessageProgress({message,actions=[]}:{message:Message;actions?:Action[]}) {
  const {t}=useConsole();const [now,setNow]=useState(Date.now());
  const pending=isPending(message.status),activity=(message.activity??[]).filter(item=>item.kind!=='assistant_message');
  useEffect(()=>{if(!pending)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[pending]);
  const end=message.completed_at??(pending?now:message.updated_at??message.created_at);
  const duration=Math.max(0,Math.floor((end-(message.started_at??message.created_at))/1000));
  const latest=Math.max(message.updated_at??message.created_at,...(message.activity??[]).map(item=>item.updated_at),...(message.questions??[]).map(item=>item.updated_at??item.created_at));
  return <>
    <div className="message-progress" data-status={message.status}><span>{t(message.questions?.some(q=>q.status==='pending')?'等待回答':messageStatuses[message.status]??message.status)}</span><span>{t('耗时')} {duration}s</span><span>{t('最近活动')} <MessageTime value={latest}/></span></div>
    {(activity.length>0 || actions.length>0) && <details className="message-activity"><summary>{t('执行过程')} ({activity.length+actions.length})</summary><ol>
      {activity.map(item=><li key={item.id} data-kind={item.kind}><div><strong>{t(item.kind==='reasoning_summary'?'推理摘要':item.kind==='assistant_message'?'Agent 进度':item.label)}</strong> <span>{t(messageStatuses[item.status]??item.status)}</span> <MessageTime value={item.updated_at}/></div>{item.text && <p>{item.text}</p>}</li>)}
      {actions.map(action=><li key={action.id}>{action.name} · {t(messageStatuses[action.status]??action.status)}{action.error && <span className="danger-text"> · {action.error.code}</span>}</li>)}
    </ol></details>}
  </>;
}
