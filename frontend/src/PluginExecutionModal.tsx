import './plugin-execution-i18n';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Modal,Typography} from 'antd';
import {AgentPicker,CatalogNote,LoadingState} from './components';
import {useConsole} from './context';
import type {AgentSettings,ConfigGroup,Plugin} from './types';

export default function PluginExecutionModal({plugin,onClose,onSaved}:{plugin:Plugin;onClose:()=>void;onSaved:(plugin:Plugin)=>void}) {
  const {operation,t}=useConsole();
  const [current,setCurrent]=useState<Plugin>(),[value,setValue]=useState<AgentSettings>({}),[defaults,setDefaults]=useState<AgentSettings>({});
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[reload,setReload]=useState(0);
  const [error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const alive=useRef(true),saveLock=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');setConflict(false);setCurrent(undefined);
    void Promise.all([operation<Plugin>('plugin_get',{type:plugin.type}),operation<ConfigGroup>('configuration_get',{scope:'execution'})]).then(([latest,global])=>{
      if(!active)return;
      setCurrent(latest);setValue(latest.execution??{});
      setDefaults({...(typeof global.values.model==='string'?{model:global.values.model}:{}),
        ...(typeof global.values.reasoningEffort==='string'||global.values.reasoningEffort===null?{reasoningEffort:global.values.reasoningEffort}:{})});
    }).catch(()=>{if(active)setError('模型设置暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[operation,plugin.type,reload]);
  const save=async()=>{
    if(!current||loading||conflict||saveLock.current)return;
    saveLock.current=true;setSaving(true);setError('');
    try {
      const saved=await operation<Plugin>('plugin_execution_update',{type:plugin.type,execution:value,revision:current.revision});
      if(alive.current)onSaved(saved);
    } catch(caught) {
      if(!alive.current)return;
      const message=caught instanceof Error?caught.message:'';
      const changed=message.includes('PLUGIN_REVISION_CONFLICT')||message.includes('业务插件已被修改');
      setConflict(changed);setError(changed?'业务插件已被修改，请重新读取后再保存。':'模型设置保存失败，请重试。');
    } finally {if(alive.current){saveLock.current=false;setSaving(false);}}
  };
  return <Modal title={t('模型设置：{name}',{name:plugin.name})} open width={620} onCancel={onClose} footer={<>
    <Button onClick={onClose}>{t('取消')}</Button><Button type="primary" disabled={!current||loading||conflict} loading={saving} onClick={()=>{void save();}}>{t('保存模型设置')}</Button>
  </>}>
    <Typography.Paragraph type="secondary">{t('仅用于此业务插件的新任务；已接单任务保持原有设置。留空继承全局设置。')}</Typography.Paragraph>
    {loading&&<LoadingState label="正在读取…"/>}
    {error&&<Alert type="error" showIcon title={t(error)} action={!current||conflict?<Button disabled={saving} onClick={()=>setReload(value=>value+1)}>{t('重新读取')}</Button>:undefined}/>}
    {current&&<Form className="settings-form connection-form" layout="horizontal" colon={false} onFinish={()=>{void save();}}>
      <CatalogNote/><AgentPicker id="plugin-execution" value={value} defaults={defaults} inherit disabled={loading||saving||conflict} onChange={setValue}/>
    </Form>}
  </Modal>;
}
