import {useEffect,useRef,useState} from 'react';
import {Button,Input,Tooltip} from 'antd';
import {useConsole} from './context';
import {Icon} from './Icon';
import {SandboxAttachments} from './SandboxAttachments';
import {MessageImages} from './ImageAttachments';
import type {Message} from './types';

export type QueueAction='withdraw'|'delete'|'requeue'|'steer';
export function ChatQueue({messages,canSteer,onAction}:{messages:Message[];canSteer:boolean;onAction:(message:Message,action:QueueAction,text?:string)=>Promise<void>}) {
  const {t,chatId,queueDrafts,setQueueDraft}=useConsole();
  const [busy,setBusy]=useState<Record<string,boolean>>({}),[errors,setErrors]=useState<Record<string,string>>({});
  const locks=useRef(new Set<string>()),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const act=async(message:Message,action:QueueAction)=>{
    if(locks.current.has(message.id))return;
    locks.current.add(message.id);setBusy(current=>({...current,[message.id]:true}));setErrors(current=>({...current,[message.id]:''}));
    try {await onAction(message,action,queueDrafts[message.id]??message.text);if(['requeue','delete'].includes(action))setQueueDraft(message.id,undefined);}
    catch(error){if(mounted.current)setErrors(current=>({...current,[message.id]:error instanceof Error?error.message:String(error)}));}
    finally {locks.current.delete(message.id);if(mounted.current)setBusy(current=>({...current,[message.id]:false}));}
  };
  if(!messages.length)return null;
  return <div className="chat-queue" aria-label={t('待发消息')}>
    {messages.map(message=>{
      const editing=message.status==='draft',locked=busy[message.id],text=queueDrafts[message.id]??message.text;
      return <div key={message.id} className="chat-queue-item" data-queue-message-id={message.id}>
        <div className="chat-queue-row">
          <span className="chat-queue-marker" aria-hidden="true"><Icon name={editing?'edit':'conversations'}/></span>
          <span className="chat-queue-text" title={message.text}>{message.text||t(message.files?.length?'文件消息':'图片消息')}{!!message.attachments?.length&&<small> · {t('图片数量：{count}',{count:message.attachments.length})}</small>}{!!message.files?.length&&<small> · {message.files.map(file=>file.name).join(', ')}</small>}</span>
          {['queued','draft'].includes(message.status)?<div className="chat-queue-actions">
            {!editing&&<><Tooltip title={t('立即引导当前任务')}><Button size="small" type="text" icon={<Icon name="send"/>} aria-label={t('立即引导')} disabled={locked||!canSteer||message.steerable===false} loading={locked} onClick={()=>void act(message,'steer')}/></Tooltip>
              <Tooltip title={t('撤回编辑')}><Button size="small" type="text" icon={<Icon name="edit"/>} aria-label={t('撤回编辑')} disabled={locked} onClick={()=>void act(message,'withdraw')}/></Tooltip></>}
            <Tooltip title={t('删除排队消息')}><Button size="small" type="text" icon={<Icon name="trash"/>} aria-label={t('删除排队消息')} disabled={locked} onClick={()=>void act(message,'delete')}/></Tooltip>
          </div>:<span className="chat-queue-state" role="status">{t(message.status==='steering'?'正在引导…':'引导状态待确认')}</span>}
        </div>
        {editing&&<div className="chat-queue-editor">
          <Input.TextArea aria-label={t('编辑排队消息')} value={text} maxLength={20000} autoSize={{minRows:2,maxRows:4}} disabled={locked} onChange={event=>setQueueDraft(message.id,event.target.value)}/>
          {!!message.attachments?.length&&<MessageImages images={message.attachments}/>}
          {chatId&&!!message.files?.length&&<SandboxAttachments conversationId={chatId} files={message.files}/>}
          <Button size="small" type="primary" disabled={locked||(!text.trim()&&!message.attachments?.length&&!message.files?.length)} loading={locked} onClick={()=>void act(message,'requeue')}>{t('重新排队')}</Button>
        </div>}
        {message.status==='steer_unknown'&&<div className="chat-queue-note">{t('正在核对发送记录，不会自动重发。')}</div>}
        {errors[message.id]&&<div className="chat-queue-error" role="alert">{t(errors[message.id])}</div>}
      </div>;
    })}
  </div>;
}
