import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,InputNumber,Switch,Typography} from 'antd';
import {Panel} from './components';
import {ApiError} from './api';
import {useConsole} from './context';
import type {ConfigGroup} from './types';
import './retention-i18n';

export default function RetentionPanel({group,onSaved,reload}:{group:ConfigGroup;onSaved:(group:ConfigGroup)=>void;reload:()=>Promise<void>}) {
  const {operation,notify,t}=useConsole();
  const [enabled,setEnabled]=useState<boolean>(),[days,setDays]=useState<number|null|undefined>();
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const lock=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const value=enabled??group.values.enabled===true;
  const age=days===undefined?Number(group.values.days):days;
  const save=async()=>{
    if(lock.current||conflict)return;
    if(age===null||!Number.isInteger(age)||age<1||age>3650){setError('保留天数须为 1 至 3650 的整数。');return;}
    lock.current=true;setSaving(true);setError('');
    try {
      const saved=await operation<ConfigGroup>('configuration_update',{scope:'retention',revision:group.revision,patch:{enabled:value,days:age}});
      if(!alive.current)return;
      onSaved(saved);setEnabled(undefined);setDays(undefined);notify(t('已保存历史清理设置。'));
    } catch(caught) {
      if(!alive.current)return;
      const changed=caught instanceof ApiError&&caught.status===409;
      setConflict(changed);setError(changed?'配置已被其他操作更新，请重新读取后再保存。':'历史清理设置保存失败，请重试。');
    } finally {if(alive.current){lock.current=false;setSaving(false);}}
  };
  const reread=async()=>{
    if(lock.current)return;
    lock.current=true;setSaving(true);
    try{await reload();if(alive.current){setEnabled(undefined);setDays(undefined);setError('');setConflict(false);}}
    catch{if(alive.current)setError('历史清理配置暂时无法读取，请重试。');}
    finally{if(alive.current){lock.current=false;setSaving(false);}}
  };
  return <Panel title={t('历史数据清理')}>
    <Typography.Paragraph>{t('默认关闭。开启后每天分批永久删除到期的管理对话、任务记录及关联图片和文件；保留未结束的工作、插件、定时计划和账号配置。')}</Typography.Paragraph>
    <Alert type="warning" showIcon title={t('删除不可恢复。开启或缩短保留天数后，已到期数据会从下一次后台检查开始清理。')}/>
    {error&&<Alert type="error" showIcon title={t(error)} action={conflict?<Button disabled={saving} onClick={()=>{void reread();}}>{t('重新读取')}</Button>:undefined}/>}
    <Form className="settings-form configuration-form admin-editor-form retention-form" layout="horizontal" colon={false} onFinish={()=>{void save();}}><div className="form-grid admin-form-grid">
      <Form.Item label={t('自动清理历史数据')} htmlFor="retention-enabled"><Switch id="retention-enabled" aria-label={t('自动清理历史数据')} checked={value} disabled={saving||conflict} onChange={setEnabled}/></Form.Item>
      <Form.Item label={t('保留天数')} htmlFor="retention-days">
        <InputNumber id="retention-days" aria-label={t('保留天数')} min={1} max={3650} precision={0} value={age} disabled={saving||conflict} onChange={setDays}/>
        <div className="retention-presets">{[30,60].map(preset=><Button key={preset} size="small" aria-pressed={age===preset} disabled={saving||conflict} onClick={()=>setDays(preset)}>{t('{days} 天',{days:preset})}</Button>)}</div>
      </Form.Item>
      </div>
      <Typography.Paragraph type="secondary">{t('对话按最后活动时间，任务按结束时间计算。排队、运行、等待恢复、未发送草稿和未完成回调暂不清理。关闭后不再开始新的清理批次。')}</Typography.Paragraph>
      <div className="configuration-actions"><Button type="primary" htmlType="submit" disabled={conflict} loading={saving} aria-label={t('保存清理设置')} aria-busy={saving}>{t('保存清理设置')}</Button></div>
    </Form>
  </Panel>;
}
