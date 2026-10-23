import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Form,Input,Modal,Spin,Typography} from 'antd';
import {ApiError} from './api';
import {useConsole} from './context';
import type {Plugin,PluginConnection} from './types';

function callAddress(address:string) {
  try {
    const value=address.trim();
    if(value.startsWith('/hooks/'))return /^\/hooks\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(value)?value:'';
    if(!/^https?:\/\//i.test(value))return '';
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)&&url.pathname.startsWith('/hooks/')&&!url.username&&!url.password&&!url.search&&!url.hash?url.href:'';
  } catch {return '';}
}

export default function PluginConnectionModal({plugin,onClose,onSaved}:{plugin:Plugin;onClose:()=>void;onSaved:(connection:PluginConnection)=>void}) {
  const {api,t}=useConsole();
  const [connection,setConnection]=useState<PluginConnection>();
  const [entryAddress,setEntryAddress]=useState(''),[entryKey,setEntryKey]=useState('');
  const [callbackUrl,setCallbackUrl]=useState(''),[callbackToken,setCallbackToken]=useState(''),[clearCallbackToken,setClearCallbackToken]=useState(false);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[loadVersion,setLoadVersion]=useState(0);
  const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[copyNotice,setCopyNotice]=useState('');
  const [copying,setCopying]=useState<Record<string,boolean>>({}),copyLocks=useRef(new Set<string>());
  const alive=useRef(true),saveLock=useRef(false);
  const path='/plugins/'+encodeURIComponent(plugin.type)+'/connection';
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let active=true;
    setLoading(true);setError('');setConflict(false);setCopyNotice('');setConnection(undefined);
    setEntryAddress('');setEntryKey('');setCallbackUrl('');setCallbackToken('');setClearCallbackToken(false);
    void api<PluginConnection>(path).then(value=>{
      if(!active)return;
      setConnection(value);setEntryAddress(value.entryAddress??'');setCallbackUrl(value.callbackUrl??'');
    }).catch(()=>{if(active)setError('接入配置暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[api,path,loadVersion]);
  const requestAddress=callAddress(entryAddress),relativeAddress=requestAddress.startsWith('/');
  const fullUrl=relativeAddress?'https://<gateway-host>'+requestAddress:requestAddress;
  const copy=async(key:string,value:string)=>{
    if(copyLocks.current.has(key))return;
    copyLocks.current.add(key);setCopying(current=>({...current,[key]:true}));
    try{await navigator.clipboard.writeText(value);if(alive.current)setCopyNotice('已复制，请妥善保管。');}
    catch{if(alive.current)setCopyNotice('复制失败，请在字段中选择并复制。');}
    finally{copyLocks.current.delete(key);if(alive.current)setCopying(current=>({...current,[key]:false}));}
  };
  const generate=(setValue:(value:string)=>void)=>{
    try{
      const bytes=window.crypto.getRandomValues(new Uint8Array(32));
      setValue(Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join(''));
      setCopyNotice('新凭证仅在本次编辑中可见，请在保存前复制。');
    }catch{setError('浏览器无法生成安全随机值，请使用可信的密码生成器。');}
  };
  const save=async()=>{
    if(saveLock.current||!connection)return;
    setError('');setConflict(false);
    if(!requestAddress){setError('入口地址须为本平台的完整 HTTP(S) 地址或 /hooks/ 路径。');return;}
    if((!connection.entryKeyConfigured||entryKey)&&entryKey.length<24){setError('入口密钥为必填项，至少需要 24 个字符。');return;}
    if(callbackUrl.trim()){
      try{const url=new URL(callbackUrl.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}
      catch{setError('回调 URL 须为完整的 HTTP(S) 地址。');return;}
    }
    saveLock.current=true;setSaving(true);setCopyNotice('');
    try{
      const value=await api<PluginConnection>(path,{
        entryAddress:entryAddress.trim(),callbackUrl:callbackUrl.trim(),revision:connection.revision,
        ...(entryKey?{entryKey}:{}),
        ...(clearCallbackToken?{callbackToken:null}:callbackToken&&callbackUrl.trim()?{callbackToken}:{}),
      });
      if(!alive.current)return;
      setEntryKey('');setCallbackToken('');onSaved(value);
    }catch(caught){
      if(!alive.current)return;
      const changed=caught instanceof ApiError&&caught.message.includes('PLUGIN_CONNECTION_REVISION_CONFLICT');
      const duplicate=caught instanceof ApiError&&caught.message.includes('PLUGIN_CONNECTION_CONFLICT');
      setConflict(changed);setError(changed?'接入配置已被修改，请重新读取后再保存。':duplicate?'入口地址或密钥已被其他插件使用，请修改后重试。':'接入配置保存失败，请检查字段后重试。');
    }finally{saveLock.current=false;if(alive.current)setSaving(false);}
  };
  const example=fullUrl?`curl -X POST '${fullUrl}' \\\n  -H 'Authorization: Bearer <${t('入口密钥')}>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"request_id":"example-1","input":{}}'`:'';
  const locked=loading||saving;
  return <Modal className="plugin-connection-modal" title={t('配置接入：{name}',{name:plugin.name})} open width={760} onCancel={onClose} footer={[
    <Button key="cancel" onClick={onClose}>{t('取消')}</Button>,
    <Button key="save" type="primary" htmlType="submit" form="plugin-connection-form" disabled={!connection||loading||conflict} loading={saving}>{t('保存接入配置')}</Button>,
  ]}>
    <Typography.Paragraph>{t('Agent 负责业务逻辑；接入地址和凭证由管理员在此配置，请勿发送到管理对话。完成必填项后才能启用业务、提交任务、试运行或执行定时计划。')}</Typography.Paragraph>
    {loading&&<div role="status"><Spin/> {t('正在读取…')}</div>}
    {error&&<Alert type="error" showIcon title={t(error)} action={!connection||conflict?<Button disabled={saving} onClick={()=>setLoadVersion(value=>value+1)}>{t('重新读取')}</Button>:undefined}/>}
    {connection&&<Form id="plugin-connection-form" className="settings-form connection-form" layout="horizontal" colon={false} onFinish={()=>{void save();}}>
      <Form.Item label={t('入口地址')} htmlFor="plugin-entry-address" required>
        <Input id="plugin-entry-address" value={entryAddress} required maxLength={4096} autoComplete="off" disabled={locked} aria-describedby="plugin-entry-address-help" onChange={event=>setEntryAddress(event.target.value)}/>
        <Typography.Paragraph id="plugin-entry-address-help" type="secondary" className="connection-field-help">{t('必填。业务系统调用本平台的地址；默认路径已生成，可填写完整 HTTP(S) 公网 URL 或 /hooks/ 路径。域名和反向代理须已将该路径转发到本平台，填写地址不会创建域名或代理。')}{relativeAddress&&' '+t('相对路径的示例请将 <gateway-host> 替换为 Gateway 对外提供服务的域名和端口，并按部署选择 HTTP 或 HTTPS。Admin 端口不是业务入口。')}</Typography.Paragraph>
        {requestAddress&&<div className="connection-call-url"><Typography.Text strong>{t(relativeAddress?'调用地址 / 路径':'完整调用 URL')}</Typography.Text><Typography.Text code>{requestAddress}</Typography.Text><Button aria-label={t('复制调用地址')} disabled={locked} loading={copying.address} onClick={()=>{void copy('address',requestAddress);}}>{t('复制调用地址')}</Button></div>}
      </Form.Item>
      <Form.Item label={t('入口密钥')} htmlFor="plugin-entry-key" required>
        <Input.Password id="plugin-entry-key" value={entryKey} autoComplete="new-password" required={!connection.entryKeyConfigured} minLength={24} maxLength={1024} disabled={locked} placeholder={t(connection.entryKeyConfigured?'已配置，留空保持原值':'尚未配置')} aria-describedby="plugin-entry-key-help" onChange={event=>setEntryKey(event.target.value)}/>
        <Typography.Paragraph id="plugin-entry-key-help" type="secondary" className="connection-field-help">{t('必填，至少 24 个字符。调用方通过 Authorization: Bearer 携带它；仅授权当前插件的提交、查询与产物下载。已保存密钥不能读取，留空保留原值。')}</Typography.Paragraph>
        <div className="connection-secret-actions"><Button disabled={locked} onClick={()=>generate(setEntryKey)}>{t('生成入口密钥')}</Button><Button aria-label={t('复制入口密钥')} disabled={locked||!entryKey} loading={copying.entry} onClick={()=>{void copy('entry',entryKey);}}>{t('复制入口密钥')}</Button></div>
      </Form.Item>
      <Form.Item label={t('回调 URL')} htmlFor="plugin-callback-url">
        <Input id="plugin-callback-url" value={callbackUrl} maxLength={4096} autoComplete="off" disabled={locked} aria-describedby="plugin-callback-url-help" placeholder="https://example.com/callback" onChange={event=>setCallbackUrl(event.target.value)}/>
        <Typography.Paragraph id="plugin-callback-url-help" type="secondary" className="connection-field-help">{t('选填。本平台向您的业务系统发送最终结果的接收地址，使用 HTTP POST JSON。留空则仅执行任务并支持查询，不发送回调；清空地址也会清除已保存的回调凭证。')}</Typography.Paragraph>
      </Form.Item>
      <Form.Item label={t('回调凭证')} htmlFor="plugin-callback-token">
        <Input.Password id="plugin-callback-token" value={callbackToken} autoComplete="new-password" maxLength={1024} disabled={locked||clearCallbackToken} aria-describedby="plugin-callback-token-help" placeholder={t(connection.callbackTokenConfigured?'已配置，留空保持原值':'尚未配置')} onChange={event=>setCallbackToken(event.target.value)}/>
        <Typography.Paragraph id="plugin-callback-token-help" type="secondary" className="connection-field-help">{t('选填，按接收方要求填写。回调请求使用 Authorization: Bearer 携带此凭证；它与入口密钥独立。留空保留已保存值，未配置则不发送认证头。')}</Typography.Paragraph>
        <div className="connection-secret-actions"><Button disabled={locked||clearCallbackToken} onClick={()=>generate(setCallbackToken)}>{t('生成回调凭证')}</Button><Button aria-label={t('复制回调凭证')} disabled={locked||!callbackToken||clearCallbackToken} loading={copying.callback} onClick={()=>{void copy('callback',callbackToken);}}>{t('复制回调凭证')}</Button></div>
        {connection.callbackTokenConfigured&&<Checkbox checked={clearCallbackToken} disabled={locked} onChange={event=>{setClearCallbackToken(event.target.checked);setCallbackToken('');}}>{t('清除已保存回调凭证')}</Checkbox>}
      </Form.Item>
      {copyNotice&&<Typography.Paragraph role="status">{t(copyNotice)}</Typography.Paragraph>}
      <Typography.Title level={5}>{t('调用示例')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('将 input 替换为插件要求的业务输入。示例始终使用密钥占位符；请勿将真实凭证放入聊天、日志或公开示例。')}</Typography.Paragraph>
      {example&&<pre className="connection-example">{example}</pre>}
      <Typography.Paragraph type="secondary">{t('使用同一插件的入口密钥查询 GET /v2/tasks/{task_id}，或下载 GET /v2/tasks/{task_id}/artifacts/{artifact_id}。其他插件的密钥无权访问。')}</Typography.Paragraph>
    </Form>}
  </Modal>;
}
