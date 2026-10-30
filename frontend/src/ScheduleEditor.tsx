import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Input,Select,Switch,Tabs,Typography} from 'antd';
import {CronExpressionParser} from 'cron-parser';
import {AdminModal} from './AdminOverlays';
import {NotificationBindingsPanel} from './NotificationBindingsPanel';
import {NotificationChannelSelect} from './NotificationChannelSelect';
import {ApiError} from './api';
import {useConsole} from './context';
import type {Json,Plugin,PluginList,Schedule} from './types';

export function ScheduleEditor({schedule,onCancel,onSaved}:{schedule?:Schedule;onCancel:()=>void;onSaved:(schedule:Schedule)=>void}) {
  const {api,operation,t}=useConsole();
  const [name,setName]=useState(schedule?.name??''),[kind,setKind]=useState<Schedule['kind']>(schedule?.kind??'inspection');
  const [cron,setCron]=useState(schedule?.cron??'0 9 * * *'),[timezone,setTimezone]=useState(schedule?.timezone??'Asia/Shanghai'),[enabled,setEnabled]=useState(schedule?.enabled??false);
  const [message,setMessage]=useState(schedule?.message??''),[type,setType]=useState(schedule?.type??''),[input,setInput]=useState(JSON.stringify(schedule?.input??{},null,2));
  const [channels,setChannels]=useState<string[]>([]),[plugins,setPlugins]=useState<Plugin[]>([]),[pluginError,setPluginError]=useState(false),[pluginLoading,setPluginLoading]=useState(true);
  const [tab,setTab]=useState('basic'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const locked=useRef(false),alive=useRef(true),revision=useRef(schedule?.revision);
  const [conflict,setConflict]=useState(false),[reloading,setReloading]=useState(false);
  const reload=async()=>{if(!schedule?.id||reloading)return;setReloading(true);try{const latest=(await api<Schedule[]>('/schedules')).find(item=>item.id===schedule.id);if(!alive.current)return;if(!latest)throw new Error();revision.current=latest.revision;setName(latest.name);setKind(latest.kind);setCron(latest.cron);setTimezone(latest.timezone);setEnabled(latest.enabled);setMessage(latest.message??'');setType(latest.type??'');setInput(JSON.stringify(latest.input??{},null,2));setConflict(false);setError('');}catch{if(alive.current)setError('定时计划暂时无法读取，请重试。');}finally{if(alive.current)setReloading(false);}};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{let active=true;void api<PluginList>('/plugins').then(result=>{if(active){setPlugins(result.configured);setPluginError(false);}}).catch(()=>{if(active)setPluginError(true);}).finally(()=>{if(active)setPluginLoading(false);});return()=>{active=false;};},[api]);
  const save=async()=>{
    if(locked.current||conflict||reloading)return;
    setError('');
    if(!name.trim()){setTab('basic');setError('请输入计划名称。');return;}
    try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{setTab('basic');setError('请输入有效的 IANA 时区。');return;}
    try{if(cron.trim().split(/\s+/).length!==5)throw new Error();CronExpressionParser.parse(cron,{tz:timezone}).next();}catch{setTab('basic');setError('请输入有效的五字段 Cron 规则。');return;}
    let parsed:Json={};
    if(kind==='inspection'&&!message.trim()){setTab('content');setError('请输入巡检要求。');return;}
    if(kind==='task'){
      if(!type){setTab('content');setError('请选择业务插件。');return;}
      try{parsed=JSON.parse(input) as Json;}catch{setTab('content');setError('请输入有效的 JSON。');return;}
    }
    locked.current=true;setBusy(true);
    try {
      // Existing bindings have their own revision-checked save and must not be overwritten here.
      const updated=await operation<Schedule>('schedule_save',{revision:schedule?.id?revision.current:0,schedule:{...(schedule?.id?{id:schedule.id}:{}),name,kind,cron,timezone,enabled,...(kind==='inspection'?{message}:{type,input:parsed}),...(!schedule?.id?{notification_channels:channels}:{})}});
      if(alive.current)onSaved(updated);
    }catch(cause){if(alive.current){if(cause instanceof ApiError&&cause.status===409)setConflict(true);const detail=cause instanceof Error?cause.message:'定时计划保存失败，已保留当前草稿。';setError(detail);if(/input_schema|业务输入|巡检需要/.test(detail))setTab('content');else if(/cron|IANA|时区/i.test(detail))setTab('basic');}}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const options=plugins.map(plugin=>({value:plugin.type,label:`${plugin.name} · ${plugin.type}`}));
  if(type&&!options.some(option=>option.value===type))options.push({value:type,label:type});
  return <AdminModal open title={t(schedule?.id?'编辑定时计划':'新增定时计划')} subtitle={t('新计划默认停用；启用后将按规则自动执行。')} busy={busy} onCancel={()=>{if(!locked.current)onCancel();}} footer={<><Button disabled={busy} onClick={()=>{if(!locked.current)onCancel();}}>{t('取消')}</Button><Button type="primary" loading={busy} disabled={conflict||reloading} aria-label={t('保存定时计划')} aria-busy={busy} onClick={()=>void save()}>{t('保存定时计划')}</Button></>}>
    {error&&<Alert type="error" showIcon title={t(error)} action={conflict?<Button disabled={busy||reloading} loading={reloading} onClick={()=>void reload()}>{t('重新读取（丢弃草稿）')}</Button>:undefined}/>}
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'basic',label:t('基本信息'),children:<Form layout="horizontal" colon={false} className="admin-editor-form" disabled={busy}><div className="admin-form-grid">
        <Form.Item label={t('计划名称')} htmlFor="schedule-name" required><Input id="schedule-name" value={name} onChange={event=>setName(event.target.value)}/></Form.Item>
        <Form.Item label={t('计划类型')} htmlFor="schedule-kind"><Select id="schedule-kind" value={kind} options={[{value:'inspection',label:t('管理巡检')},{value:'task',label:t('业务任务')}]} onChange={setKind}/></Form.Item>
        <Form.Item label={t('Cron 规则')} htmlFor="schedule-cron" required><Input id="schedule-cron" value={cron} onChange={event=>setCron(event.target.value)} placeholder="0 9 * * *"/></Form.Item>
        <Form.Item label={t('时区')} htmlFor="schedule-timezone" required><Input id="schedule-timezone" value={timezone} onChange={event=>setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></Form.Item>
        <Form.Item label={t('启用计划')} htmlFor="schedule-enabled"><Switch id="schedule-enabled" aria-label={t('启用计划')} checked={enabled} onChange={setEnabled}/></Form.Item>
      </div></Form>},
      {key:'content',label:t('执行内容'),children:<Form layout="horizontal" colon={false} className="admin-editor-form" disabled={busy}>
        {kind==='inspection'?<Form.Item label={t('巡检要求')} htmlFor="schedule-message" required><Input.TextArea id="schedule-message" rows={8} value={message} onChange={event=>setMessage(event.target.value)}/></Form.Item>:<>
          {pluginError&&<Alert type="warning" showIcon title={t('业务插件暂时无法读取，已保留当前选择。')}/>}
          <Form.Item label={t('业务插件')} htmlFor="schedule-plugin" required><Select id="schedule-plugin" showSearch optionFilterProp="label" value={type||undefined} loading={pluginLoading} options={options} onChange={setType}/></Form.Item>
          <Form.Item label={t('业务输入 JSON')} htmlFor="schedule-input" required><Input.TextArea id="schedule-input" className="code-input" rows={10} value={input} onChange={event=>setInput(event.target.value)}/></Form.Item>
        </>}
      </Form>},
      {key:'channels',label:t('通知渠道'),children:schedule?.id?<NotificationBindingsPanel key={schedule.id} kind="schedule" id={schedule.id}/>:<Form layout="horizontal" colon={false} className="admin-editor-form"><Typography.Paragraph type="secondary">{t('绑定是 Agent 可以使用的渠道集合；保存绑定不会发送消息。')}</Typography.Paragraph><Form.Item label={t('通知渠道')} htmlFor="schedule-channels"><NotificationChannelSelect id="schedule-channels" value={channels} onChange={setChannels} disabled={busy}/></Form.Item></Form>},
    ]}/>
  </AdminModal>;
}
