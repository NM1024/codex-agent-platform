import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Typography} from 'antd';
import {LoadingState,Panel} from './components';
import {useConsole} from './context';
import {ApiError} from './api';
import {NotificationHistory} from './NotificationHistory';
import {providerLabel,type NotificationBindingView} from './notification-types';
import './notification-i18n';
import './notification.css';
export function NotificationBindingsPanel({kind,id,readOnly=false}:{kind:'task'|'inspection'|'schedule'|'plugin';id:string;readOnly?:boolean}) {
  const {api,t,notify}=useConsole();
  const [view,setView]=useState<NotificationBindingView|null>(null),[selected,setSelected]=useState<string[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const lock=useRef(false),generation=useRef(0);
  const path=`/${kind==='inspection'?'inspections':kind==='schedule'?'schedules':kind==='plugin'?'plugins':'tasks'}/${encodeURIComponent(id)}/notifications`;
  const load=useCallback(async()=>{
    const sequence=++generation.current;setLoading(true);
    try {const next=await api<NotificationBindingView>(path);if(sequence!==generation.current)return;setView(next);setSelected(next.notification_channels);setError('');setConflict(false);}
    catch{if(sequence===generation.current)setError(readOnly?'通知记录暂时无法读取，请重试。':'通知绑定暂时无法读取，请重试。');}
    finally{if(sequence===generation.current)setLoading(false);}
  },[api,path,readOnly]);
  useEffect(()=>{setView(null);setSelected([]);setConflict(false);setError('');lock.current=false;setBusy(false);void load();return()=>{generation.current++;};},[load]);
  const save=async()=>{
    if(lock.current||!view||conflict||readOnly||loading)return;
    lock.current=true;setBusy(true);setError('');const sequence=generation.current;
    try {const next=await api<NotificationBindingView>(path,{notification_channels:selected,revision:view.notification_revision});if(sequence!==generation.current)return;setView(next);setSelected(next.notification_channels);notify(t('通知绑定已保存。'));}
    catch(cause){if(sequence!==generation.current)return;const changed=cause instanceof ApiError&&cause.status===409;setConflict(changed);setError(changed?'通知绑定已被更新，请重新读取后再保存。':'通知绑定保存失败，已保留当前选择。');}
    finally{if(sequence===generation.current){lock.current=false;setBusy(false);}}
  };
  const available=(view?.available_channels??[]).filter(channel=>channel.enabled&&!channel.deleted);
  const unavailable=(view?.notification_channels??[]).filter(channelId=>!available.some(channel=>channel.id===channelId));
  const toggle=(channelId:string,checked:boolean)=>setSelected(current=>checked?[...current,channelId]:current.filter(value=>value!==channelId));
  return <div className="notification-panel"><Panel title={t(readOnly?'通知记录':'通知渠道')} extra={<Button disabled={busy||loading} onClick={()=>void load()}>{t('重新读取')}</Button>}>
    {!readOnly&&<Typography.Paragraph type="secondary">{t(kind==='plugin'?'插件绑定用作新任务的默认渠道；任务单独指定时使用其选择，已有任务不变。':kind==='schedule'?'计划的绑定只影响以后创建的执行；独立保存不会修改 cron 或下次执行时间。':'绑定是 Agent 可以使用的渠道集合；保存绑定不会发送消息。')}</Typography.Paragraph>}
    {error&&<Alert type="error" showIcon title={t(error)} action={conflict?<Button disabled={busy||loading} onClick={()=>void load()}>{t('重新读取')}</Button>:undefined}/>}
    {loading?<LoadingState/>:view&&(readOnly?<NotificationHistory history={view.history} showHeading={false}/>:<><div className="notification-choices" role="group" aria-label={t('选择通知渠道')}>
      {available.map(channel=><Checkbox key={channel.id} checked={selected.includes(channel.id)} disabled={readOnly||busy||conflict} onChange={event=>toggle(channel.id,event.target.checked)}><span>{channel.name} · {t(providerLabel[channel.provider])}</span>{channel.description&&<span className="notification-choice-description">{channel.description}</span>}</Checkbox>)}
      {unavailable.map(channelId=>{const channel=view.channels.find(item=>item.id===channelId);return <Checkbox key={channelId} checked={selected.includes(channelId)} disabled={readOnly||busy||conflict} onChange={event=>toggle(channelId,event.target.checked)}><span>{channel?.name??channelId}</span><span className="notification-choice-description">{t('不可用的原绑定；可以保留或取消选择移除。')}</span></Checkbox>;})}
      {!available.length&&!unavailable.length&&<Typography.Paragraph>{t('暂无可用通知渠道。请先在系统配置中新增渠道。')}</Typography.Paragraph>}
    </div>
    {!readOnly&&<Button type="primary" aria-label={t('保存通知绑定')} aria-busy={busy} loading={busy} disabled={conflict} onClick={()=>void save()}>{t('保存通知绑定')}</Button>}
    {kind!=='schedule'&&kind!=='plugin'&&<NotificationHistory history={view.history}/>}</>)}
  </Panel></div>;
}
