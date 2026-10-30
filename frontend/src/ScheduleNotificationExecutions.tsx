import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Empty,Typography} from 'antd';
import {LoadingState,Panel,Status,time} from './components';
import {useConsole} from './context';
import {NotificationBindingsPanel} from './NotificationBindingsPanel';
import './notification-i18n';
import './notification.css';
interface Execution {id:string;kind:'task'|'inspection';status:string;created_at:number|string}
export function ScheduleNotificationExecutions({scheduleId}:{scheduleId:string}) {
  const {api,t}=useConsole();
  const [executions,setExecutions]=useState<Execution[]>([]),[selected,setSelected]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const reads=useRef(0);
  const load=useCallback(async()=>{
    const sequence=++reads.current;setLoading(true);
    try{const response=await api<{executions?:Execution[]}>(`/schedules/${encodeURIComponent(scheduleId)}/notifications`);if(sequence!==reads.current)return;const next=(response.executions??[]).slice(0,20);setExecutions(next);setSelected(current=>next.some(execution=>`${execution.kind}:${execution.id}`===current)?current:null);setError('');}
    catch{if(sequence===reads.current)setError('计划执行通知列表暂时无法读取，请重试。');}
    finally{if(sequence===reads.current)setLoading(false);}
  },[api,scheduleId]);
  useEffect(()=>{setExecutions([]);setSelected(null);setError('');void load();return()=>{reads.current++;};},[load]);
  const execution=executions.find(item=>`${item.kind}:${item.id}`===selected);
  return <div className="notification-panel"><Panel title={t('执行通知记录')} extra={<Button disabled={loading} onClick={()=>void load()}>{t('重新读取')}</Button>}>
    <Typography.Paragraph type="secondary">{t('显示最近 20 次执行。选择执行查看通知结果；未结束执行可修改绑定。')}</Typography.Paragraph>
    {error&&<Alert type="error" showIcon title={t(error)}/>}
    {loading?<LoadingState/>:!executions.length?<Empty description={t('暂无计划执行记录')}/>:<div className="notification-execution-list">{executions.map(item=><article className="notification-execution" key={`${item.kind}:${item.id}`}><div><Typography.Text strong>{t(item.kind==='inspection'?'巡检执行':'业务任务执行')}</Typography.Text><Status value={item.status}/><Typography.Text type="secondary">{time(item.created_at)}</Typography.Text><Typography.Paragraph code>{item.id}</Typography.Paragraph></div><Button aria-label={t('查看执行通知：{id}',{id:item.id})} aria-pressed={selected===`${item.kind}:${item.id}`} onClick={()=>setSelected(`${item.kind}:${item.id}`)}>{t('查看通知')}</Button></article>)}</div>}
  </Panel>{execution&&<div className="notification-selected-execution"><NotificationBindingsPanel key={`${execution.kind}:${execution.id}`} kind={execution.kind} id={execution.id} readOnly={['completed','failed','cancelled','canceled'].includes(execution.status)}/></div>}</div>;
}
