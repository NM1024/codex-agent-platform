import {useEffect,useState} from 'react';
import {Alert,Button,Descriptions,Drawer,Tabs,Tooltip,Typography} from 'antd';
import {Icon} from './Icon';
import {LoadingState} from './components';
import {AgentMessage,CopyButton} from './ChatMessage';
import {useConsole} from './context';
import type {Plugin,PluginIntegration} from './types';

export default function PluginIntegrationDrawer({plugin,onClose,onConfigure}:{plugin:Plugin;onClose:()=>void;onConfigure:()=>void}) {
  const {api,t,locale}=useConsole();
  const [document,setDocument]=useState<PluginIntegration>(),[loading,setLoading]=useState(true),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    setDocument(undefined);setLoading(true);setError(false);
    void api<PluginIntegration>('/plugins/'+encodeURIComponent(plugin.type)+'/integration?locale='+encodeURIComponent(locale)).then(value=>{
      if(active)setDocument(value);
    }).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[api,plugin.type,locale,attempt]);
  const download=()=>{
    if(!document)return;
    const url=URL.createObjectURL(new Blob([document.markdown],{type:'text/markdown;charset=utf-8'}));
    const link=window.document.createElement('a');
    link.href=url;link.download=document.type.replace(/[^a-zA-Z0-9._-]/g,'_')+'-integration-'+document.locale+'.md';
    link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <Drawer open title={t('对接文档：{name}',{name:plugin.name})} onClose={onClose} size={960} className="plugin-integration-drawer" styles={{wrapper:{maxWidth:'100vw'}}}>
    {loading?<LoadingState className="integration-loading" label="正在加载对接文档…"/>:error?<Alert type="error" showIcon title={t('对接文档暂时无法读取，请重试。')} action={<Button onClick={()=>setAttempt(value=>value+1)}>{t('重试')}</Button>}/>:document&&<>
      <Descriptions className="integration-metadata" size="small" column={1} items={[
        {key:'plugin',label:t('业务'),children:<>{document.name} <Typography.Text code>{document.type}</Typography.Text></>},
        {key:'revision',label:t('业务定义版本'),children:document.revision??'—'},
        {key:'connection',label:t('接入配置版本'),children:document.connectionRevision??'—'},
      ]}/>
      {!document.ready&&<Alert type="warning" showIcon title={t('请先通过「配置接入」完成必填设置，再启用插件并提交任务。文档仍可查阅。')} action={<Button onClick={onConfigure}>{t('配置接入')}</Button>}/>}
      <div className="integration-export"><CopyButton text={document.markdown} label="复制 Markdown"/><Tooltip title={t('下载 Markdown')}><Button type="text" size="small" icon={<Icon name="download"/>} aria-label={t('下载 Markdown')} onClick={download}/></Tooltip></div>
      <Tabs className="integration-tabs" items={document.sections.map(section=>({key:section.key,label:section.title,children:<AgentMessage text={section.markdown}/>}))}/>
    </>}
  </Drawer>;
}
