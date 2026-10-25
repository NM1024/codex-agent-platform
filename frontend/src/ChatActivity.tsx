import {MessageTime} from './ChatMessage';
import {useConsole} from './context';
import type {Action,Message} from './types';
import {connectionWarning,progressTiming,runPresentation,RunIndicator,useProgressClock,type ChatConnection} from './ChatRunStatus';

export const messageStatuses:Record<string,string>={queued:'排队中',running:'运行中',executing:'操作中',unknown:'结果未知',interrupted:'等待继续',recovering:'恢复中',completed:'执行完成',failed:'执行失败',steered:'已引导'};
export const isPending=(status:string)=>['queued','running','interrupted','recovering'].includes(status);
export function MessageProgress({message,actions=[],connection='connected'}:{message:Message;actions?:Action[];connection?:ChatConnection}) {
  const {t}=useConsole();
  const pending=isPending(message.status),activity=(message.activity??[]).filter(item=>item.kind!=='assistant_message');
  const now=useProgressClock(pending),{duration,latest}=progressTiming(message,now),presentation=runPresentation(message);
  const warning=pending?connectionWarning(connection):'';
  return <>
    <div className="message-progress" data-status={message.status}><span className="message-run-state" data-tone={warning?'warning':presentation.tone}><RunIndicator spinning={presentation.spinning&&!warning} tone={warning?'warning':presentation.tone}/><strong>{t(warning||presentation.label)}</strong>{pending&&<small>{t(messageStatuses[message.status]??message.status)}</small>}</span><span aria-live="off">{t('耗时')} {duration}s</span><span>{t('最近活动')} <MessageTime value={latest}/></span></div>
    {(activity.length>0 || actions.length>0) && <details className="message-activity"><summary>{t('执行过程')} ({activity.length+actions.length})</summary><ol>
      {activity.map(item=><li key={item.id} data-kind={item.kind}><div><strong>{t(item.kind==='reasoning_summary'?'推理摘要':item.kind==='assistant_message'?'Agent 进度':item.label)}</strong> <span>{t(messageStatuses[item.status]??item.status)}</span> <MessageTime value={item.updated_at}/></div>{item.text && <p>{item.text}</p>}</li>)}
      {actions.map(action=><li key={action.id}>{action.name} · {t(messageStatuses[action.status]??action.status)}{action.error && <span className="danger-text"> · {action.error.code}</span>}</li>)}
    </ol></details>}
  </>;
}
