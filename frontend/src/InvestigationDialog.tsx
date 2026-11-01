import {useEffect,useRef,useState} from 'react';
import {Alert,Modal,Typography} from 'antd';
import {useConsole} from './context';
import type {Conversation} from './types';
export function InvestigationDialog({id,scheduled=false,onClose}:{id:string;scheduled?:boolean;onClose:()=>void}){
 const {api,t,setChatId,navigate}=useConsole(),lock=useRef(false),alive=useRef(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const confirm=async()=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{const value=await api<Conversation>('/conversations',{title:t('调查 ')+id.slice(0,8),...(scheduled?{schedule_execution_id:id}:{task_id:id}),investigate:true});if(alive.current){setChatId(value.id);navigate('chat');onClose();}}
  catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:t('调查启动失败，请重试。'));}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 };
 return <Modal className="admin-overlay admin-modal" open title={t('确认调查')} okText={t('开始调查')} cancelText={t('取消')} onOk={()=>void confirm()} onCancel={()=>{if(!lock.current)onClose();}} okButtonProps={{loading:busy}} cancelButtonProps={{disabled:busy}} closable={!busy} maskClosable={!busy} keyboard={!busy}>
  <Typography.Paragraph>{t('将创建管理对话，由 Agent 调查这条执行记录，可能消耗模型额度。是否继续？')}</Typography.Paragraph><Typography.Text code>{id}</Typography.Text>{error&&<Alert type="error" title={error}/>}
 </Modal>;
}
