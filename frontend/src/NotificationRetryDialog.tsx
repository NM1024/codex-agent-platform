import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Modal,Typography} from 'antd';
import {LoadingState} from './components';
import {useConsole} from './context';
import {providerLabel,type NotificationChannel} from './notification-types';
import './notification-i18n';
import './notification.css';
export function NotificationRetryDialog({task,open,onCancel,onSubmit}:{task:{task_id:string;notification_channels?:string[]};open:boolean;onCancel:()=>void;onSubmit:(ids:string[])=>Promise<void>}) {
  const {api,t}=useConsole();
  const [selected,setSelected]=useState<string[]>(()=>[...new Set(task.notification_channels??[])]),[channels,setChannels]=useState<NotificationChannel[]>([]),[loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState('');
  const lock=useRef(false),alive=useRef(true),reads=useRef(0),owner=useRef(task.task_id),epoch=useRef(0);
  const load=useCallback(async()=>{
    const sequence=++reads.current;setLoading(true);setLoadError('');
    try{const response=await api<{items:NotificationChannel[]}>('/notification-channels');if(!alive.current||sequence!==reads.current)return;setChannels(response.items);setLoaded(true);}
    catch{if(alive.current&&sequence===reads.current)setLoadError('重试渠道暂时无法读取，请重试。');}
    finally{if(alive.current&&sequence===reads.current)setLoading(false);}
  },[api]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;reads.current++;epoch.current++;};},[]);
  useEffect(()=>{
    if(owner.current!==task.task_id){owner.current=task.task_id;epoch.current++;setSelected([...new Set(task.notification_channels??[])]);setError('');setLoaded(false);lock.current=false;setBusy(false);}
    if(open)void load();else reads.current++;
  },[open,task.task_id,load]);
  const available=channels.filter(channel=>channel.enabled&&!channel.deleted&&channel.configured.url);
  const unavailable=selected.filter(id=>!available.some(channel=>channel.id===id));
  const submit=async()=>{
    if(lock.current||loading||!loaded||!!loadError||unavailable.length)return;
    lock.current=true;setBusy(true);setError('');const sequence=epoch.current;
    try{await onSubmit([...selected]);}
    catch(cause){if(alive.current&&sequence===epoch.current)setError(cause instanceof Error?cause.message:'重试失败，已保留渠道选择。');}
    finally{if(alive.current&&sequence===epoch.current){lock.current=false;setBusy(false);}}
  };
  return <Modal className="notification-editor notification-retry" open={open} title={t('重试任务的通知渠道')} onCancel={()=>{if(!lock.current)onCancel();}} onOk={()=>void submit()} okText={t('确认重试')} cancelText={t('取消')} okButtonProps={{loading:busy,disabled:loading||!loaded||!!loadError||!!unavailable.length,'aria-label':t('确认重试'),'aria-busy':busy}} cancelButtonProps={{disabled:busy,'aria-label':t('取消')}} closable={!busy} keyboard={!busy} mask={{closable:!busy}}>
    <Typography.Paragraph>{t('为新重试任务选择通知渠道。原任务及其通知记录保持不变；可取消全部选择。')}</Typography.Paragraph>
    {loadError&&<Alert type="error" showIcon title={t(loadError)} action={<Button disabled={loading||busy} onClick={()=>void load()}>{t('重新读取')}</Button>}/>}
    {loading?<LoadingState/>:loaded&&!loadError&&<><div className="notification-choices" role="group" aria-label={t('选择通知渠道')}>
      {available.map(channel=><Checkbox key={channel.id} checked={selected.includes(channel.id)} disabled={busy} onChange={event=>setSelected(current=>event.target.checked?[...current,channel.id]:current.filter(id=>id!==channel.id))}>{channel.name} · {t(providerLabel[channel.provider])}</Checkbox>)}
      {!available.length&&<Typography.Paragraph>{t('暂无可用通知渠道。可移除原绑定后不绑定渠道重试。')}</Typography.Paragraph>}
    </div>{!!unavailable.length&&<Alert type="warning" showIcon title={t('原绑定含不可用渠道。请先移除或替换，再确认重试。')} description={<div className="notification-unavailable-list">{unavailable.map(id=><div className="notification-unavailable" key={id}><Typography.Text>{channels.find(channel=>channel.id===id)?.name??id}</Typography.Text><Button size="small" disabled={busy} aria-label={t('移除不可用渠道：{id}',{id})} onClick={()=>setSelected(current=>current.filter(value=>value!==id))}>{t('移除')}</Button></div>)}</div>}/>}</>}
    {error&&<Alert type="error" showIcon title={t(error)}/>}
  </Modal>;
}
