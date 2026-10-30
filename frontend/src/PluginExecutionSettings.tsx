import './plugin-execution-i18n';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Typography} from 'antd';
import {AgentPicker,CatalogNote,LoadingState} from './components';
import {useConsole} from './context';
import {agentSettingsFromValues} from './modelOptions';
import type {AgentSettings,ConfigGroup,Plugin} from './types';

export function usePluginExecutionSettings(plugin:Plugin,onSaved:(plugin:Plugin)=>void,enabled:boolean) {
  const {operation}=useConsole();
  const [current,setCurrent]=useState<Plugin>(),[value,setValue]=useState<AgentSettings>({}),[defaults,setDefaults]=useState<AgentSettings>({});
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[reload,setReload]=useState(0);
  const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[saved,setSaved]=useState(false);
  const alive=useRef(true),saveLock=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!enabled)return;
    let active=true;setSaved(false);setLoading(true);setError('');setConflict(false);setCurrent(undefined);
    void Promise.all([operation<Plugin>('plugin_get',{type:plugin.type}),operation<ConfigGroup>('configuration_get',{scope:'execution'})]).then(([latest,global])=>{
      if(!active)return;
      setCurrent(latest);setValue(latest.execution??{});
      setDefaults(agentSettingsFromValues(global.values));
    }).catch(()=>{if(active)setError('模型设置暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[operation,plugin.type,reload,enabled]);
  const save=async()=>{
    if(!current||loading||conflict||saveLock.current)return;
    saveLock.current=true;setSaving(true);setError('');setSaved(false);
    try {
      const updated=await operation<Plugin>('plugin_execution_update',{type:plugin.type,execution:value,revision:current.revision});
      if(alive.current){setCurrent(updated);setSaved(true);onSaved(updated);}
    } catch(caught) {
      if(!alive.current)return;
      const message=caught instanceof Error?caught.message:'';
      const changed=message.includes('PLUGIN_REVISION_CONFLICT')||message.includes('业务插件已被修改');
      setConflict(changed);setError(changed?'业务插件已被修改，请重新读取后再保存。':'模型设置保存失败，请重试。');
    } finally {if(alive.current){saveLock.current=false;setSaving(false);}}
  };
  return {current,value,defaults,loading,saving,error,conflict,saved,save,
    reload:()=>setReload(value=>value+1),setValue:(next:AgentSettings)=>{setValue(next);setSaved(false);}};
}

export function PluginExecutionSettings({settings}:{settings:ReturnType<typeof usePluginExecutionSettings>}) {
  const {t}=useConsole();
  return <>
    <Typography.Paragraph type="secondary">{t('仅用于此业务插件的新任务；已接单任务保持原有设置。留空继承全局设置。')}</Typography.Paragraph>
    <Typography.Paragraph type="secondary">{t('此页单独保存，不会修改入口与回调配置。')}</Typography.Paragraph>
    {settings.loading&&<LoadingState label="正在读取…"/>}
    {settings.error&&<Alert type="error" showIcon title={t(settings.error)} action={!settings.current||settings.conflict?<Button disabled={settings.saving} onClick={settings.reload}>{t('重新读取')}</Button>:undefined}/>}
    {settings.current&&<><CatalogNote/><AgentPicker id="plugin-execution" value={settings.value} defaults={settings.defaults} inherit disabled={settings.loading||settings.saving||settings.conflict} onChange={settings.setValue}/></>}
    {settings.saved&&<Typography.Paragraph role="status">{t('模型设置已保存。')}</Typography.Paragraph>}
  </>;
}
