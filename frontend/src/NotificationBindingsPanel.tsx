import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Form} from 'antd';
import {LoadingState} from './components';
import {useConsole} from './context';
import {ApiError} from './api';
import {NotificationChannelSelect} from './NotificationChannelSelect';
import {NotificationHistory} from './NotificationHistory';
import {type NotificationBindingView} from './notification-types';
import './notification-i18n';
import './notification.css';
type Kind='task'|'inspection'|'schedule'|'plugin';
export function useNotificationBinding(kind:Kind,id:string|undefined){
  const {api,t,notify}=useConsole();
  const [view,setView]=useState<NotificationBindingView|null>(null),[selected,setSelected]=useState<string[]>([]),[loading,setLoading]=useState(!!id),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const lock=useRef(false),generation=useRef(0);
  const path=`/${kind==='inspection'?'inspections':kind==='schedule'?'schedules':kind==='plugin'?'plugins':'tasks'}/${encodeURIComponent(id??'')}/notifications`;
  const load=useCallback(async()=>{
    const sequence=++generation.current;if(!id){setLoading(false);return;}setLoading(true);
    try{const next=await api<NotificationBindingView>(path);if(sequence!==generation.current)return;setView(next);setSelected(next.notification_channels);setError('');setConflict(false);}
    catch{if(sequence===generation.current)setError('通知绑定暂时无法读取，请重试。');}
    finally{if(sequence===generation.current)setLoading(false);}
  },[api,path,id]);
  useEffect(()=>{setView(null);setSelected([]);setConflict(false);setError('');lock.current=false;setBusy(false);void load();return()=>{generation.current++;};},[load]);
  const save=async()=>{
    if(lock.current||!view||conflict||loading)return;
    lock.current=true;setBusy(true);setError('');const sequence=generation.current;
    try{const next=await api<NotificationBindingView>(path,{notification_channels:selected,revision:view.notification_revision});if(sequence!==generation.current)return;setView(next);setSelected(next.notification_channels);notify(t('通知绑定已保存。'));}
    catch(cause){if(sequence!==generation.current)return;const changed=cause instanceof ApiError&&cause.status===409;setConflict(changed);setError(changed?'通知绑定已被更新，请重新读取后再保存。':'通知绑定保存失败，已保留当前选择。');}
    finally{if(sequence===generation.current){lock.current=false;setBusy(false);}}
  };
  return {kind,view,selected,setSelected,loading,busy,error,conflict,load,save,ready:!loading&&!!view&&!conflict,dirty:!!view&&JSON.stringify(selected)!==JSON.stringify(view.notification_channels)};
}
export function NotificationBindingFields({binding,disabled=false}:{binding:ReturnType<typeof useNotificationBinding>;disabled?:boolean}){
 const {t}=useConsole();
 return <>
  {binding.error&&<Alert type="error" showIcon title={t(binding.error)} action={!binding.view||binding.conflict?<Button disabled={disabled||binding.busy||binding.loading} onClick={()=>void binding.load()}>{t(binding.conflict?'重新读取（丢弃草稿）':'重试')}</Button>:undefined}/>}
  {binding.loading?<LoadingState/>:binding.view&&<Form.Item label={t('通知渠道')} htmlFor="notification-binding-channels" extra={t(binding.kind==='plugin'?'插件绑定用作新任务的默认渠道；任务单独指定时使用其选择，已有任务不变。':binding.kind==='schedule'?'计划的绑定只影响以后创建的执行。':'绑定是 Agent 可以使用的渠道集合；保存绑定不会发送消息。')}><NotificationChannelSelect id="notification-binding-channels" value={binding.selected} onChange={binding.setSelected} disabled={disabled||binding.busy||binding.conflict} knownChannels={[...(binding.view.available_channels??[]),...binding.view.channels]}/></Form.Item>}
 </>;
}
export function NotificationBindingsPanel({kind,id,readOnly=false}:{kind:Kind;id:string;readOnly?:boolean}){
 const {t}=useConsole(),binding=useNotificationBinding(kind,id);
 return <div className="notification-panel">
  {readOnly?<>{binding.error&&<Alert type="error" title={t(binding.error)} action={<Button onClick={()=>void binding.load()}>{t('重试')}</Button>}/>} {binding.loading?<LoadingState/>:<NotificationHistory history={binding.view?.history} showHeading={false}/>}</>:<>
   <Form layout="horizontal" colon={false} className="admin-editor-form"><NotificationBindingFields binding={binding}/><div className="admin-form-actions"><Button type="primary" aria-label={t('保存通知绑定')} loading={binding.busy} disabled={!binding.ready} onClick={()=>void binding.save()}>{t('保存通知绑定')}</Button></div></Form>
   {kind!=='schedule'&&kind!=='plugin'&&<NotificationHistory history={binding.view?.history}/>}
  </>}
 </div>;
}
