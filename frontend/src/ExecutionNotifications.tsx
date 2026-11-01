import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Descriptions,Space,Tag,Typography} from 'antd';
import {LoadingState} from './components';
import {useConsole} from './context';
import {NotificationHistory} from './NotificationHistory';
import {providerLabel,type NotificationBindingView} from './notification-types';
import './notification-i18n';
import './notification.css';

// Execution records expose their bound channels and delivery history, without
// mounting the channel selector or fetching the global channel catalogue.
export function ExecutionNotifications({kind,id}:{kind:'task'|'inspection';id:string}){
 const {api,t}=useConsole();
 const [view,setView]=useState<NotificationBindingView>(),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 const generation=useRef(0);
 const path=`/${kind==='inspection'?'inspections':'tasks'}/${encodeURIComponent(id)}/notifications`;
 const load=useCallback(async()=>{
  const sequence=++generation.current;setLoading(true);
  try{const next=await api<NotificationBindingView>(path);if(sequence===generation.current){setView(next);setError(false);}}
  catch{if(sequence===generation.current)setError(true);}
  finally{if(sequence===generation.current)setLoading(false);}
 },[api,path]);
 useEffect(()=>{setView(undefined);setError(false);void load();return()=>{generation.current++;};},[load]);
 return <div className="notification-panel execution-notifications">
  {error&&<Alert type="error" showIcon title={t('通知绑定暂时无法读取，请重试。')} action={<Button disabled={loading} onClick={()=>void load()}>{t('重试')}</Button>}/>}
  {loading?<LoadingState/>:view&&<>
   <Descriptions column={1} items={[{key:'channels',label:t('通知渠道'),children:view.notification_channels.length?<Space orientation="vertical" size="small">{view.notification_channels.map(channelId=>{
    const channel=view.channels.find(item=>item.id===channelId);
    const available=!!channel&&channel.enabled&&!channel.deleted&&channel.configured.url;
    return <Space key={channelId} wrap><Typography.Text>{channel?.name||channelId}</Typography.Text>{channel&&<Tag>{t(providerLabel[channel.provider])}</Tag>}<Tag color={available?'success':'default'}>{t(available?'已启用':channel&&!channel.enabled&&!channel.deleted?'已停用':'不可用')}</Tag></Space>;
   })}</Space>:<Typography.Text type="secondary">—</Typography.Text>}]}/>
   <NotificationHistory history={view.history}/>
  </>}
 </div>;
}
