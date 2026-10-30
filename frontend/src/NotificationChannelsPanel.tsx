import {useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Empty,Form,Input,InputNumber,Modal,Select,Switch,Tag,Typography} from 'antd';
import {DeleteAction,LoadingState,Panel,Status} from './components';
import {useConsole} from './context';
import {ApiError} from './api';
import {NotificationHistory} from './NotificationHistory';
import {notificationProviders,providerLabel,type NotificationBatch,type NotificationChannel,type NotificationProvider} from './notification-types';
import './notification-i18n';
import './notification.css';
interface Draft {name:string;provider:NotificationProvider;description:string;instructions:string;url:string;token:string;headers:string;signingSecret:string;timeoutMs?:number;enabled:boolean}
type Secret='token'|'headers'|'signingSecret';
const secretLabels:Record<Secret,string>={token:'Bearer token',headers:'私密请求头（JSON）',signingSecret:'签名密钥'};
export default function NotificationChannelsPanel() {
  const {api,t,notify}=useConsole(),[form]=Form.useForm<Draft>();
  const [channels,setChannels]=useState<NotificationChannel[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const [editor,setEditor]=useState<{channel?:NotificationChannel}|null>(null),[editorError,setEditorError]=useState(''),[editorConflict,setEditorConflict]=useState(false),[clear,setClear]=useState<Partial<Record<Secret,boolean>>>({});
  const [testing,setTesting]=useState<NotificationChannel|null>(null),[testError,setTestError]=useState(''),[testHistory,setTestHistory]=useState<NotificationBatch[]>([]);
  const lock=useRef(false),alive=useRef(true),reads=useRef(0);
  const load=useCallback(async()=>{
    const sequence=++reads.current;setLoading(true);
    try{const next=await api<{items:NotificationChannel[]}>('/notification-channels');if(!alive.current||sequence!==reads.current)return;setChannels(next.items);setError('');setConflict(false);return next.items;}
    catch{if(alive.current&&sequence===reads.current)setError('通知渠道暂时无法读取，请重试。');}
    finally{if(alive.current&&sequence===reads.current)setLoading(false);}
  },[api]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;reads.current++;};},[load]);
  const open=(channel?:NotificationChannel)=>{
    form.resetFields();setClear({});setEditorError('');setEditorConflict(false);setEditor({channel});
    form.setFieldsValue({name:channel?.name??'',provider:channel?.provider??'feishu',description:channel?.description??'',instructions:channel?.instructions??'',enabled:channel?.enabled??true,timeoutMs:channel?channel.timeoutMs:10000,url:'',token:'',headers:'',signingSecret:''});
  };
  const close=()=>{if(lock.current)return;setEditor(null);form.resetFields();setClear({});};
  const replace=(channel:NotificationChannel)=>setChannels(current=>current.some(item=>item.id===channel.id)?current.map(item=>item.id===channel.id?channel:item):[...current,channel]);
  const save=async()=>{
    if(lock.current||!editor||editorConflict)return;
    lock.current=true;setBusy(true);setEditorError('');
    try {
      const draft=await form.validateFields();
      const raw:Record<string,unknown>={...(editor.channel?{id:editor.channel.id}:{}),name:draft.name,provider:draft.provider,description:draft.description??'',instructions:draft.instructions??'',enabled:draft.enabled};
      if(draft.timeoutMs!==undefined&&draft.timeoutMs!==null)raw.timeoutMs=draft.timeoutMs;
      if(draft.url)raw.url=draft.url;
      for(const field of ['token','headers','signingSecret'] as const){if(clear[field])raw[field]='';else if(draft[field])raw[field]=field==='headers'?JSON.parse(draft.headers):draft[field];}
      const saved=await api<NotificationChannel>('/notification-channels',{channel:raw,...(editor.channel?{revision:editor.channel.revision}:{})});
      if(!alive.current)return;replace(saved);setEditor(null);form.resetFields();setClear({});notify(t('通知渠道已保存；未发送消息。'));
    } catch(cause){if(!alive.current)return;if(cause&&typeof cause==='object'&&'errorFields' in cause)return;const changed=cause instanceof ApiError&&cause.status===409;setEditorConflict(changed);setEditorError(changed?'渠道已被更新，请重新读取后再保存。':'渠道保存失败，已保留草稿。');}
    finally{if(alive.current){lock.current=false;setBusy(false);}}
  };
  const changeEnabled=async(channel:NotificationChannel)=>{
    if(lock.current||conflict)return;lock.current=true;setBusy(true);setError('');
    try{const next=await api<NotificationChannel>(`/notification-channels/${encodeURIComponent(channel.id)}/enable`,{enabled:!channel.enabled,revision:channel.revision});if(alive.current)replace(next);}
    catch(cause){if(alive.current){const changed=cause instanceof ApiError&&cause.status===409;setConflict(changed);setError(changed?'渠道已被更新，请重新读取后再保存。':'渠道状态修改失败，请重试。');}}
    finally{if(alive.current){lock.current=false;setBusy(false);}}
  };
  const remove=async(channel:NotificationChannel)=>{
    if(lock.current||conflict)throw new Error(t('请等待当前操作完成，或重新读取最新渠道。'));lock.current=true;setBusy(true);
    try{await api(`/notification-channels/${encodeURIComponent(channel.id)}`,{revision:channel.revision},'DELETE');if(alive.current)setChannels(current=>current.filter(item=>item.id!==channel.id));}
    catch(cause){if(alive.current&&cause instanceof ApiError&&cause.status===409){setConflict(true);setError('渠道已被更新，请重新读取后再保存。');}throw new Error(t('删除渠道失败，请重新读取后重试。'));}
    finally{if(alive.current){lock.current=false;setBusy(false);}}
  };
  const test=async()=>{
    if(lock.current||!testing)return;lock.current=true;setBusy(true);setTestError('');
    try{const batch=await api<NotificationBatch>(`/notification-channels/${encodeURIComponent(testing.id)}/test`,{});if(alive.current){setTestHistory(current=>[batch,...current]);setTesting(null);notify(t('测试已执行，请检查逐渠道结果。'));}}
    catch{if(alive.current)setTestError('测试结果未确认，请核查接收端；不要重复发送。');}
    finally{if(alive.current){lock.current=false;setBusy(false);}}
  };
  const rereadEditor=async()=>{if(lock.current||!editor)return;const id=editor.channel?.id;const next=await load();if(!next)return;const latest=next.find(channel=>channel.id===id);if(!latest){setEditorError('渠道已删除，请关闭窗口后重新选择。');return;}open(latest);};
  return <div className="notification-panel"><Panel title={t('通知渠道')} extra={<div className="notification-actions"><Button disabled={loading||busy||!!editor} onClick={()=>void load()}>{t('重新读取')}</Button><Button type="primary" disabled={loading||busy||conflict} onClick={()=>open()}>{t('新增通知渠道')}</Button></div>}>
    <Typography.Paragraph>{t('独立管理 Agent 可使用的 Webhook 渠道。保存配置不发送消息；任务绑定后由 Agent 按要求决定发送时机。')}</Typography.Paragraph>
    {error&&<Alert showIcon type="error" title={t(error)}/>}
    {loading?<LoadingState/>:!channels.length?<Empty description={t('暂无通知渠道')}/>:<div className="notification-channel-list">{channels.map(channel=><article className="notification-channel" key={channel.id}>
      <div className="notification-row-title"><Typography.Title level={3}>{channel.name}</Typography.Title><div><Tag>{t(providerLabel[channel.provider])}</Tag><Status value={channel.enabled?'已启用':'已停用'}/></div></div>
      <Typography.Paragraph>{channel.description}</Typography.Paragraph><Typography.Text code copyable={{text:channel.id}}>{channel.id}</Typography.Text>
      <div className="notification-credentials">{(['url','token','headers','signingSecret'] as const).map(field=><span key={field}>{t(field==='url'?'Webhook 地址':secretLabels[field])}: {t(channel.configured[field]?'已配置':'未配置')}</span>)}</div>
      <div className="notification-actions"><Button disabled={busy||conflict} aria-label={t('编辑通知渠道：{name}',{name:channel.name})} onClick={()=>open(channel)}>{t('编辑')}</Button><Button disabled={busy||conflict} onClick={()=>void changeEnabled(channel)} aria-label={t('切换渠道启停：{name}',{name:channel.name})}>{t(channel.enabled?'停用':'启用')}</Button><Button disabled={busy||!channel.enabled||conflict} aria-label={t('测试通知渠道：{name}',{name:channel.name})} onClick={()=>{setTesting(channel);setTestError('');}}>{t('测试通知（会发送消息）')}</Button>{<DeleteAction label={t('删除通知渠道：{name}',{name:channel.name})} name={channel.name} description={t('删除后不可发送；既有绑定和历史保留，原渠道 ID 不会被重用。')} onDelete={()=>remove(channel)}/>}</div>
      <details><summary>{t('消息格式与安全示例')}</summary><Typography.Paragraph>{channel.format.instructions}</Typography.Paragraph>{channel.instructions&&<Typography.Paragraph>{channel.instructions}</Typography.Paragraph>}<pre className="notification-json">{JSON.stringify(channel.format.example,null,2)}</pre></details>
    </article>)}</div>}
    {!!testHistory.length&&<NotificationHistory history={{items:testHistory,next_cursor:null}}/>}
    <Modal className="notification-editor" width={680} open={!!editor} title={t(editor?.channel?'编辑通知渠道':'新增通知渠道')} okText={t('保存渠道')} cancelText={t('取消')} onOk={()=>void save()} onCancel={close} okButtonProps={{loading:busy,disabled:editorConflict,'aria-busy':busy,'aria-label':t('保存渠道')}} cancelButtonProps={{disabled:busy,'aria-label':t('取消')}} closable={!busy} keyboard={!busy} mask={{closable:!busy}} forceRender>
      <Form name="notification-channel" form={form} layout="vertical" disabled={busy}>
        <Form.Item name="name" label={t('渠道名称')} rules={[{required:true,whitespace:true,message:t('请输入渠道名称。')}]}><Input maxLength={200}/></Form.Item>
        <Form.Item name="provider" label={t('渠道类型')} rules={[{required:true}]}><Select virtual={false} disabled={busy||!!editor?.channel} options={notificationProviders.map(provider=>({value:provider,label:t(providerLabel[provider])}))}/></Form.Item>
        <Form.Item name="description" label={t('用途说明')}><Input.TextArea rows={2} maxLength={8192}/></Form.Item>
        <Form.Item name="instructions" label={t('补充格式说明')}><Input.TextArea rows={3} maxLength={16384}/></Form.Item>
        <Form.Item name="url" label={t('Webhook 地址')} extra={t(editor?.channel?.configured.url?'已配置；留空保留原地址。地址包含私密信息，不会回显。':'地址只用于此渠道的消息发送。')} rules={[{required:!editor?.channel,message:t('请输入 Webhook 地址。')},{validator:async(_,value:string)=>{if(!value)return;let target;try{target=new URL(value);}catch{throw new Error(t('请填写完整的 HTTPS 地址，或本机 HTTP 地址。'));}if(value.trim()!==value||target.username||target.password||target.hash||!(target.protocol==='https:'||target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname)))throw new Error(t('请填写完整的 HTTPS 地址，或本机 HTTP 地址。'));}}]}><Input.Password autoComplete="new-password" maxLength={8192} placeholder="https://example.invalid/webhook"/></Form.Item>
        {(['token','headers','signingSecret'] as const).map(field=><div key={field}><Form.Item name={field} label={t(secretLabels[field])} extra={t(editor?.channel?.configured[field]?'已配置；留空保留原值。':'未配置；可选。')} rules={field==='headers'?[{validator:async(_,value:string)=>{if(!value||clear.headers)return;try{const headers:unknown=JSON.parse(value);if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.values(headers).some(part=>typeof part!=='string'))throw Error();}catch{throw new Error(t('请求头须为 JSON 对象，且每个值都是字符串。'));}}}]:[]}>
          {field==='headers'?<Input.TextArea rows={3} autoComplete="off" disabled={busy||clear[field]} placeholder={'{"X-Example-Key":"synthetic-value"}'}/>:<Input.Password autoComplete="new-password" maxLength={8192} disabled={busy||clear[field]}/>}
        </Form.Item>{editor?.channel?.configured[field]&&<Form.Item><Checkbox checked={!!clear[field]} disabled={busy} onChange={event=>setClear(current=>({...current,[field]:event.target.checked}))}>{t('清除已保存的 {field}',{field:t(secretLabels[field])})}</Checkbox></Form.Item>}</div>)}
        <Form.Item name="timeoutMs" label={t('超时（毫秒）')} rules={[{required:!editor?.channel,message:t('请输入超时时间。')}]}><InputNumber min={100} max={120000} precision={0}/></Form.Item>
        <Form.Item name="enabled" label={t('启用渠道')} valuePropName="checked"><Switch/></Form.Item>
      </Form>
      <Typography.Paragraph className="notification-save-note" type="secondary">{t('保存配置不会发送请求。测试通知使用已保存的配置，且会向接收端发送合成消息。')}</Typography.Paragraph>
      {editorError&&<Alert type="error" showIcon title={t(editorError)} action={editorConflict?<Button disabled={busy||loading} onClick={()=>void rereadEditor()}>{t('重新读取（丢弃草稿）')}</Button>:undefined}/>}
    </Modal>
    <Modal open={!!testing} title={t('测试通知（会发送消息）')} okText={t('发送测试消息')} cancelText={t('取消')} onOk={()=>void test()} onCancel={()=>{if(!lock.current)setTesting(null);}} okButtonProps={{loading:busy,'aria-busy':busy,'aria-label':t('发送测试消息')}} cancelButtonProps={{disabled:busy,'aria-label':t('取消')}} closable={!busy} mask={{closable:!busy}} keyboard={!busy}>
      <Typography.Paragraph>{t('将通过已保存渠道“{name}”发送一条合成测试消息。此操作会产生真实外发请求。',{name:testing?.name??''})}</Typography.Paragraph>
      {testError&&<Alert type="warning" showIcon title={t(testError)}/>}
    </Modal>
  </Panel></div>;
}
