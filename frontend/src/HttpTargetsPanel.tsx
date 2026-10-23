import {useRef,useState} from 'react';
import {Alert,Button,Checkbox,Form,Input,InputNumber,Modal,Table,Typography} from 'antd';
import {DeleteAction,Panel} from './components';
import {useConsole} from './context';
import {ApiError} from './api';
import type {ConfigGroup,Json} from './types';

interface Target {url:string;timeoutMs?:number}
interface Draft {name:string;url:string;timeoutMs:number;token?:string}
const targetsOf=(group:ConfigGroup)=>group.values.targets as unknown as Record<string,Target>;
export default function HttpTargetsPanel({group,onSaved,reload}:{group:ConfigGroup;onSaved:(group:ConfigGroup)=>void;reload:()=>Promise<void>}) {
  const {operation,t,notify}=useConsole(),[form]=Form.useForm<Draft>(),lock=useRef(false);
  const [editor,setEditor]=useState<{name?:string;revision:number;targets:Record<string,Target>}|null>(null);
  const [busy,setBusy]=useState(false),[clearToken,setClearToken]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const targets=targetsOf(group),rows=Object.entries(targets).map(([name,value])=>({name,...value}));
  const configured=(name:string)=>group.configured_secrets.includes('/targets/'+name.replaceAll('~','~0').replaceAll('/','~1')+'/token');
  const open=(name?:string)=>{
    setError('');setConflict(false);setClearToken(false);form.resetFields();
    form.setFieldsValue({name:name??'',url:name?targets[name].url:'',timeoutMs:name?targets[name].timeoutMs??60000:10000,token:''});
    setEditor({name,revision:group.revision,targets});
  };
  const close=()=>{if(lock.current)return;setEditor(null);form.resetFields();setClearToken(false);setError('');};
  const save=async()=>{
    if(lock.current||!editor||conflict)return;
    lock.current=true;setBusy(true);setError('');
    try {
      const draft=await form.validateFields();
      if(!editor.name&&Object.hasOwn(editor.targets,draft.name)){form.setFields([{name:'name',errors:[t('目标名称已存在，请使用其他名称。')]}]);return;}
      const target:Record<string,Json>={url:draft.url,timeoutMs:draft.timeoutMs};
      if(clearToken)target.token='';else if(draft.token)target.token=draft.token;
      const next=Object.fromEntries([...Object.entries(editor.targets),[draft.name,target]]);
      const saved=await operation<ConfigGroup>('configuration_update',{scope:'http_targets',revision:editor.revision,patch:{targets:next}});
      onSaved(saved);setEditor(null);form.resetFields();setClearToken(false);notify(t('HTTP 目标已保存，下一次工具调用立即生效。'));
    } catch(cause) {
      if(cause instanceof ApiError&&cause.status===409){setConflict(true);try{await reload();}catch{}}
      if(!(cause&&typeof cause==='object'&&'errorFields' in cause))setError(cause instanceof Error?t(cause.message):t('保存失败，请重试。'));
    } finally {lock.current=false;setBusy(false);}
  };
  return <Panel title={t('HTTP 目标')} extra={<Button type="primary" onClick={()=>open()}>{t('新增 HTTP 目标')}</Button>}>
    <Typography.Paragraph>{t(group.description)}</Typography.Paragraph>
    <Typography.Paragraph type="secondary">{t('例如将 nvda_health 指向 https://nvda.chat，业务 Agent 可通过该名称调用 HTTP 工具。凭证请在此填写，不要发送到管理对话。')}</Typography.Paragraph>
    <Table className="responsive-table" rowKey="name" dataSource={rows} pagination={false} tableLayout="auto" locale={{emptyText:t('暂无 HTTP 目标')}} columns={[
      {title:t('目标名称'),dataIndex:'name',className:'table-identity-cell',render:name=><div className="table-identity"><Typography.Text code title={name}>{name}</Typography.Text></div>},
      {title:t('目标地址'),dataIndex:'url',className:'table-text-cell',render:url=><div className="table-summary" title={url}>{url}</div>},
      {title:t('超时（毫秒）'),key:'timeout',className:'table-meta-cell',render:(_,target)=>target.timeoutMs??60000},
      {title:t('访问凭证'),key:'token',className:'table-status-cell',render:(_,target)=>t(configured(target.name)?'已配置':'未配置')},
      {title:t('操作'),key:'actions',className:'table-actions-cell',render:(_,target)=><div className="plugin-row-actions"><Button aria-label={t('编辑 HTTP 目标：{name}',{name:target.name})} onClick={()=>open(target.name)}>{t('编辑')}</Button><DeleteAction label={t('删除 HTTP 目标：{name}',{name:target.name})} name={target.name} description={t('删除后 Agent 无法再通过该名称发起请求。已发出的请求和插件结果回调不受影响。')} onDelete={async()=>{
        const next=Object.fromEntries(Object.entries(targets).filter(([name])=>name!==target.name));
        try{onSaved(await operation<ConfigGroup>('configuration_update',{scope:'http_targets',revision:group.revision,patch:{targets:next}}));}
        catch(cause){if(cause instanceof ApiError&&cause.status===409)try{await reload();}catch{}throw cause;}
      }}/></div>},
    ]}/>
    <Modal open={!!editor} title={t(editor?.name?'编辑 HTTP 目标':'新增 HTTP 目标')} okText={t('保存目标')} cancelText={t('取消')} onOk={()=>void save()} onCancel={close} okButtonProps={{loading:busy,disabled:conflict,'aria-label':t('保存目标'),'aria-busy':busy}} cancelButtonProps={{disabled:busy}} closable={!busy} keyboard={!busy} maskClosable={!busy} forceRender>
      <Form name="http-target-editor" form={form} layout="horizontal" colon={false} className="settings-form http-target-form" disabled={busy}>
        <Form.Item name="name" label={t('目标名称')} rules={[{required:true,message:t('请输入目标名称。')},{pattern:/^[a-zA-Z0-9_-]+$/,message:t('名称只能包含英文字母、数字、下划线和短横线。')}]}><Input disabled={busy||!!editor?.name} maxLength={128}/></Form.Item>
        <Form.Item name="url" label={t('目标地址')} rules={[{required:true,message:t('请输入目标地址。')},{validator:async(_,value:string)=>{
          if(!value)return;
          let url;try{url=new URL(value);}catch{throw new Error(t('请填写完整的 HTTPS 地址，或本机 HTTP 地址。'));}
          if(value.trim()!==value||url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error(t('请填写完整的 HTTPS 地址，或本机 HTTP 地址。'));
        }}]}><Input placeholder="https://example.com/health"/></Form.Item>
        <Form.Item name="timeoutMs" label={t('超时（毫秒）')} rules={[{required:true,message:t('请输入超时时间。')}]}><InputNumber min={1} max={2147483647} precision={0}/></Form.Item>
        <Form.Item name="token" label={t('访问凭证')} extra={t('选填。请求时由平台通过 Authorization: Bearer 注入；已保存凭证不会回显，留空保留原值。')}><Input.Password autoComplete="new-password" maxLength={1024} disabled={busy||clearToken} placeholder={t(editor?.name&&configured(editor.name)?'已配置，留空保持原值':'尚未配置')}/></Form.Item>
        {editor?.name&&configured(editor.name)&&<Form.Item label=" "><Checkbox checked={clearToken} onChange={event=>setClearToken(event.target.checked)}>{t('清除已保存凭证')}</Checkbox></Form.Item>}
      </Form>
      {error&&<Alert type="error" showIcon title={error} description={conflict?t('请关闭此窗口后重新打开，读取最新目标配置再修改。'):undefined}/>}
    </Modal>
  </Panel>;
}
