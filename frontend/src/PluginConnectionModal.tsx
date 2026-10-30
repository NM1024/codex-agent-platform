import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Form,Input,Modal,Switch,Tabs,Tooltip,Typography} from 'antd';
import {ApiError} from './api';
import {Icon} from './Icon';
import {LoadingState} from './components';
import {NotificationBindingsPanel} from './NotificationBindingsPanel';
import {PluginExecutionSettings,usePluginExecutionSettings} from './PluginExecutionSettings';
import PluginIntegrationDrawer from './PluginIntegrationDrawer';
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

export default function PluginConnectionModal({plugin,onClose,onSaved,onModelSaved,onClaimed}:{plugin:Plugin;onClose:()=>void;onSaved:(connection:PluginConnection)=>void;onModelSaved:(plugin:Plugin)=>void;onClaimed?:(connection:PluginConnection)=>void}) {
  const {api,t}=useConsole();
  const [modelsOpened,setModelsOpened]=useState(false);
  const models=usePluginExecutionSettings(plugin,onModelSaved,modelsOpened);
  const [connection,setConnection]=useState<PluginConnection>();
  const [entryAddress,setEntryAddress]=useState(''),[entryKey,setEntryKey]=useState('');
  const [claimedEntryKey,setClaimedEntryKey]=useState(''),[claiming,setClaiming]=useState(false);
  const [callbackUrl,setCallbackUrl]=useState(''),[callbackToken,setCallbackToken]=useState(''),[clearCallbackToken,setClearCallbackToken]=useState(false);
  const [tab,setTab]=useState('entry'),[callbackEnabled,setCallbackEnabled]=useState(false),[showDocs,setShowDocs]=useState(false);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[loadVersion,setLoadVersion]=useState(0);
  const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[copyNotice,setCopyNotice]=useState('');
  const [copying,setCopying]=useState<Record<string,boolean>>({}),copyLocks=useRef(new Set<string>());
  const alive=useRef(true),generation=useRef(0),saveLock=useRef(false),claimLock=useRef(false);
  const path='/plugins/'+encodeURIComponent(plugin.type)+'/connection';
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  useEffect(()=>{
    let active=true;generation.current++;saveLock.current=false;claimLock.current=false;copyLocks.current.clear();
    setLoading(true);setError('');setConflict(false);setCopyNotice('');setConnection(undefined);
    setEntryAddress('');setEntryKey('');setClaimedEntryKey('');setCallbackUrl('');setCallbackToken('');setClearCallbackToken(false);setClaiming(false);setSaving(false);setCopying({});setTab('entry');setCallbackEnabled(false);
    void api<PluginConnection>(path).then(value=>{
      if(!active)return;
      setConnection(value);setEntryAddress(value.entryAddress??'');setCallbackUrl(value.callbackUrl??'');setCallbackEnabled(!!value.callbackUrl);
    }).catch(()=>{if(active)setError('接入配置暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;generation.current++;};
  },[api,path,loadVersion]);
  const close=()=>{generation.current++;setEntryKey('');setClaimedEntryKey('');setCallbackToken('');setCopyNotice('');onClose();};
  const requestAddress=callAddress(entryAddress);
  const copy=async(key:string,value:string)=>{
    if(copyLocks.current.has(key))return;
    const started=generation.current;
    copyLocks.current.add(key);setCopying(current=>({...current,[key]:true}));
    try{await navigator.clipboard.writeText(value);if(alive.current&&started===generation.current)setCopyNotice('已复制，请妥善保管。');}
    catch{if(alive.current&&started===generation.current)setCopyNotice('复制失败，请在字段中选择并复制。');}
    finally{if(alive.current&&started===generation.current){copyLocks.current.delete(key);setCopying(current=>({...current,[key]:false}));}}
  };
  const generate=(setValue:(value:string)=>void)=>{
    try{
      const bytes=window.crypto.getRandomValues(new Uint8Array(32));
      setValue(Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join(''));
      setCopyNotice('新凭证仅在本次编辑中可见，请在保存前复制。');
    }catch{setError('浏览器无法生成安全随机值，请使用可信的密码生成器。');}
  };
  const claim=async()=>{
    if(claimLock.current||saveLock.current||!connection?.entryKeyClaimable||conflict||entryKey)return;
    const started=generation.current;
    claimLock.current=true;setClaiming(true);setError('');setCopyNotice('');
    try{
      const value=await api<{entryKey:string;connection:PluginConnection}>(path+'/entry-key/claim',{revision:connection.revision});
      if(!alive.current||started!==generation.current)return;
      setConnection(value.connection);setClaimedEntryKey(value.entryKey);onClaimed?.(value.connection);
    }catch(caught){
      if(!alive.current||started!==generation.current)return;
      const changed=caught instanceof ApiError&&caught.message.includes('PLUGIN_CONNECTION_REVISION_CONFLICT');
      setConflict(true);setError(changed?'接入配置已被修改，请重新读取后再保存。':'领取失败或响应丢失，密钥可能已被领取。请重新读取；如果未保存密钥且已无法领取，请生成并保存新的入口密钥。');
    }finally{if(alive.current&&started===generation.current){claimLock.current=false;setClaiming(false);}}
  };
  const save=async()=>{
    if(saveLock.current||claimLock.current||conflict||!connection)return;
    const started=generation.current;
    setError('');setConflict(false);
    if(!requestAddress){setTab('entry');setError('入口地址须为本平台的完整 HTTP(S) 地址或 /hooks/ 路径。');return;}
    if((!connection.entryKeyConfigured||entryKey)&&entryKey.length<24){setTab('entry');setError('入口密钥为必填项，至少需要 24 个字符。');return;}
    if(callbackEnabled){
      try{const url=new URL(callbackUrl.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error();}
      catch{setTab('callback');setError('回调 URL 须为完整的 HTTP(S) 地址。');return;}
    }
    saveLock.current=true;setSaving(true);setCopyNotice('');
    try{
      const value=await api<PluginConnection>(path,{
        entryAddress:entryAddress.trim(),callbackUrl:callbackEnabled?callbackUrl.trim():'',revision:connection.revision,
        ...(entryKey?{entryKey}:{}),
        ...(callbackEnabled&&clearCallbackToken?{callbackToken:null}:callbackEnabled&&callbackToken?{callbackToken}:{}),
      });
      if(!alive.current||started!==generation.current)return;
      setEntryKey('');setClaimedEntryKey('');setCallbackToken('');onSaved(value);
    }catch(caught){
      if(!alive.current||started!==generation.current)return;
      const changed=caught instanceof ApiError&&caught.message.includes('PLUGIN_CONNECTION_REVISION_CONFLICT');
      const duplicate=caught instanceof ApiError&&caught.message.includes('PLUGIN_CONNECTION_CONFLICT');
      setConflict(changed);setError(changed?'接入配置已被修改，请重新读取后再保存。':duplicate?'入口地址或密钥已被其他插件使用，请修改后重试。':'接入配置保存失败，请检查字段后重试。');
    }finally{if(alive.current&&started===generation.current){saveLock.current=false;setSaving(false);}}
  };
  const locked=loading||saving||claiming||models.saving;
  const busy=saving||claiming||models.saving;
  const displayedKey=entryKey||claimedEntryKey;
  const claimedVisible=!!claimedEntryKey&&!entryKey;
  const copyAction=(key:string,value:string,label:string)=> <Tooltip title={t(label)}><Button icon={<Icon name="copy"/>} aria-label={t(label)} loading={copying[key]} disabled={locked||!value} onClick={()=>{void copy(key,value);}}/></Tooltip>;
  return <>
    <Modal className={'plugin-connection-modal admin-overlay admin-modal'+(loading&&['entry','callback'].includes(tab)?' connection-loading':'')} title={<><span>{t('配置接入：{name}',{name:plugin.name})}</span><Typography.Text className="connection-subtitle" type="secondary">{plugin.type} · {t(connection?.ready?'接入已就绪':connection?.entryKeyClaimable?'待领取入口密钥':'待配置接入')}</Typography.Text></>} open width={800} onCancel={close} footer={<div className="connection-footer"><Button type="link" onClick={()=>setShowDocs(true)}>{t('对接文档')}</Button><div><Button onClick={close}>{t('取消')}</Button>{tab!=='notifications'&&<Button type="primary" disabled={tab==='models'?!models.current||models.loading||models.conflict||busy:!connection||loading||conflict||busy} loading={tab==='models'?models.saving:saving} onClick={()=>{void (tab==='models'?models.save():save());}}>{t(tab==='models'?'保存模型设置':'保存接入配置')}</Button>}</div></div>}>
      {['entry','callback'].includes(tab)&&loading&&<LoadingState className="integration-loading" label="正在读取…"/>}
      {['entry','callback'].includes(tab)&&error&&<Alert type="error" showIcon title={t(error)} action={!connection||conflict?<Button disabled={saving||claiming} onClick={()=>setLoadVersion(value=>value+1)}>{t('重新读取')}</Button>:undefined}/>}
      <Form id="plugin-connection-form" className="settings-form connection-form" layout="horizontal" colon={false} onFinish={()=>{void (tab==='models'?models.save():save());}}>
        <Tabs activeKey={tab} onChange={key=>{if(busy)return;if(key==='models')setModelsOpened(true);setTab(key);}} items={[
          {key:'entry',label:t('入口配置'),forceRender:true,disabled:busy,children:connection&&<>
            <Typography.Paragraph type="secondary" className="connection-intro">{t('用于业务系统提交任务。密钥仅由管理员领取或修改，请勿发送到管理对话。')}</Typography.Paragraph>
            <Form.Item label={t('入口地址')} htmlFor="plugin-entry-address" required>
              <div className="connection-input-row"><Input id="plugin-entry-address" value={entryAddress} maxLength={4096} autoComplete="off" disabled={locked} aria-describedby="plugin-entry-address-help" onChange={event=>setEntryAddress(event.target.value)}/>{copyAction('address',requestAddress,'复制调用地址')}</div>
              <Typography.Paragraph id="plugin-entry-address-help" type="secondary" className="connection-field-help">{t('支持 /hooks/ 路径，或本平台的完整公网 HTTP(S) 地址。')}</Typography.Paragraph>
            </Form.Item>
            <Form.Item label={t('入口密钥')} htmlFor={claimedVisible?'plugin-claimed-entry-key':'plugin-entry-key'} required>
              {claimedVisible&&<Typography.Paragraph className="connection-key-notice" type="warning">{t('仅本次可见，请立即复制保存。丢失后可重设；保存新密钥后，旧密钥失效。')}</Typography.Paragraph>}
              <div className="connection-input-row"><Input.Password id={claimedVisible?'plugin-claimed-entry-key':'plugin-entry-key'} aria-label={t(claimedVisible?'已领取的入口密钥':'入口密钥')} value={displayedKey} readOnly={claimedVisible} autoComplete="new-password" maxLength={1024} disabled={locked} placeholder={t(connection.entryKeyConfigured?'已配置，留空保持原值':connection.entryKeyClaimable?'后台已生成，等待领取':'尚未配置')} aria-describedby="plugin-entry-key-help" onChange={event=>setEntryKey(event.target.value)}/>{copyAction(claimedVisible?'claimed':'entry',displayedKey,claimedVisible?'复制领取的入口密钥':'复制入口密钥')}</div>
              <div className="connection-secret-actions">
                <Typography.Text id="plugin-entry-key-help" type="secondary">{t('至少 24 个字符，使用 Authorization: Bearer。')}</Typography.Text>
                <div>{connection.entryKeyClaimable&&<Button aria-label={t('领取入口密钥')} loading={claiming} disabled={loading||saving||conflict||!!entryKey} onClick={()=>{void claim();}}>{t('领取入口密钥')}</Button>}<Button type="link" disabled={locked} onClick={()=>generate(value=>{setEntryKey(value);setClaimedEntryKey('');})}>{t('生成入口密钥')}</Button></div>
              </div>
              {!!entryKey&&connection.entryKeyConfigured&&<Typography.Paragraph type="warning" className="connection-field-help">{t('保存新密钥后，旧密钥立即失效，请同步更新调用方。')}</Typography.Paragraph>}
            </Form.Item>
            <details className="connection-help"><summary>{t('使用与安全说明')}</summary>
              {connection.entryKeyClaimable&&<p>{t('Agent 已请求初始化入口密钥，只有管理员可在此领取一次。领取前不能用于调用；领取成功后立即生效，无需再次保存。也可手动生成并保存替换密钥，未领取的密钥将失效。')}</p>}
              <p>{t('Agent 可初始化缺失的入口密钥，但不会读取密钥；只有管理员可在此领取一次或修改凭证。接入地址与回调由管理员配置，请勿将凭证发送到管理对话。完成必填项后才能启用业务、提交任务、试运行或执行定时计划。')}</p>
              <p>{t('必填。业务系统调用本平台的地址；默认路径已生成，可填写完整 HTTP(S) 公网 URL 或 /hooks/ 路径。域名和反向代理须已将该路径转发到本平台，填写地址不会创建域名或代理。')}</p>
              <p>{t('相对路径的示例请将 <gateway-host> 替换为 Gateway 对外提供服务的域名和端口，并按部署选择 HTTP 或 HTTPS。Admin 端口不是业务入口。')}</p>
              <p>{t('必填，至少 24 个字符。调用方通过 Authorization: Bearer 携带它；仅授权当前插件的提交、查询与产物下载。已保存密钥不能读取，留空保留原值。')}</p>
              <p>{t('领取的密钥仅在关闭此窗口前可见，请立即复制并保存在调用方的私密配置中。关闭后无法再次读取；如遗失，请生成并保存新的入口密钥；保存后旧密钥立即失效，请同步更新调用方。')}</p>
            </details>
          </>},
          {key:'callback',label:<>{t('结果回调')} <Typography.Text type="secondary">{t('可选')}</Typography.Text></>,forceRender:true,disabled:busy,children:connection&&<>
            <div className="connection-callback-toggle"><div><Typography.Text strong>{t('启用结果回调')}</Typography.Text><Typography.Paragraph type="secondary">{t('将最终结果发送到你指定的接收地址。')}</Typography.Paragraph></div><Switch aria-label={t('启用结果回调')} checked={callbackEnabled} disabled={locked} onChange={setCallbackEnabled}/></div>
            <Form.Item label={t('回调 URL')} htmlFor="plugin-callback-url" required={callbackEnabled}>
              <Input id="plugin-callback-url" value={callbackUrl} maxLength={4096} autoComplete="off" disabled={locked||!callbackEnabled} aria-describedby="plugin-callback-url-help" placeholder="https://example.com/callback" onChange={event=>setCallbackUrl(event.target.value)}/>
              <Typography.Paragraph id="plugin-callback-url-help" type="secondary" className="connection-field-help">{t('接收最终结果的完整 HTTP(S) 地址。')}</Typography.Paragraph>
            </Form.Item>
            <Form.Item label={t('回调凭证')} htmlFor="plugin-callback-token">
              <div className="connection-input-row"><Input.Password id="plugin-callback-token" value={callbackToken} autoComplete="new-password" maxLength={1024} disabled={locked||!callbackEnabled||clearCallbackToken} aria-describedby="plugin-callback-token-help" placeholder={t(connection.callbackTokenConfigured?'已配置，留空保持原值':'尚未配置')} onChange={event=>setCallbackToken(event.target.value)}/>{copyAction('callback',callbackEnabled&&!clearCallbackToken?callbackToken:'','复制回调凭证')}</div>
              <div className="connection-secret-actions"><Typography.Text id="plugin-callback-token-help" type="secondary">{t('按接收方要求填写，与入口密钥独立。')}</Typography.Text><Button type="link" disabled={locked||!callbackEnabled||clearCallbackToken} onClick={()=>generate(setCallbackToken)}>{t('生成回调凭证')}</Button></div>
              {connection.callbackTokenConfigured&&<Checkbox checked={clearCallbackToken} disabled={locked||!callbackEnabled} onChange={event=>{setClearCallbackToken(event.target.checked);setCallbackToken('');}}>{t('清除已保存回调凭证')}</Checkbox>}
            </Form.Item>
            {!callbackEnabled&&connection.callbackUrl&&<Typography.Paragraph type="warning">{t('关闭回调并保存，将清除已保存的回调地址和凭证。')}</Typography.Paragraph>}
            <details className="connection-help"><summary>{t('回调如何工作')}</summary><p>{t('选填。本平台向您的业务系统发送最终结果的接收地址，使用 HTTP POST JSON。留空则仅执行任务并支持查询，不发送回调；清空地址也会清除已保存的回调凭证。')}</p><p>{t('选填，按接收方要求填写。回调请求使用 Authorization: Bearer 携带此凭证；它与入口密钥独立。留空保留已保存值，未配置则不发送认证头。')}</p></details>
          </>},
          {key:'notifications',label:t('通知渠道'),disabled:busy,children:<NotificationBindingsPanel key={plugin.type} kind="plugin" id={plugin.type}/>},
          {key:'models',label:t('模型设置'),forceRender:true,disabled:busy,children:<PluginExecutionSettings settings={models}/>},
        ]}/>
        {copyNotice&&<Typography.Paragraph className="connection-copy-notice" role="status">{t(copyNotice)}</Typography.Paragraph>}
      </Form>
    </Modal>
    {showDocs&&<PluginIntegrationDrawer plugin={plugin} onClose={()=>setShowDocs(false)} onConfigure={()=>setShowDocs(false)}/>}
  </>;
}
