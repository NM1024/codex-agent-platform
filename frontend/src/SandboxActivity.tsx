import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {Alert,Button,Collapse,Typography} from 'antd';
import {useConsole} from './context';
import {SandboxAttachments} from './SandboxAttachments';
import type {SandboxContext,SandboxJob,SandboxPermission} from './types';
import './sandbox.css';

type Decision='allow'|'deny'|'revoke';
interface ActivityContext {conversationId:string;value?:SandboxContext;error:string;busy:Set<string>;act:(kind:'permission'|'cancel',id:string,decision?:Decision)=>Promise<void>}
const Context=createContext<ActivityContext|null>(null);
export function SandboxProvider({conversationId,children}:{conversationId:string|null;children:ReactNode}) {
  const {api,authenticated,t}=useConsole();
  const [snapshot,setSnapshot]=useState<{id:string;value:SandboxContext}>(),[error,setError]=useState(''),[busy,setBusy]=useState(new Set<string>());
  const active=useRef(0),version=useRef(0),locks=useRef(new Set<string>());
  useEffect(()=>{
    const generation=++active.current;let fetching=false;
    setError('');setBusy(new Set());locks.current.clear();
    if(!conversationId||!authenticated)return;
    const load=async()=>{
      if(fetching||document.visibilityState==='hidden')return;
      fetching=true;const readVersion=version.current;
      try {
        const value=await api<SandboxContext>('/conversations/'+encodeURIComponent(conversationId)+'/sandbox');
        if(active.current===generation&&readVersion===version.current){setSnapshot({id:conversationId,value});setError('');}
      }catch{if(active.current===generation&&readVersion===version.current)setError('沙箱状态暂时不可用，已保留当前记录。');}
      finally{fetching=false;}
    };
    void load();const timer=setInterval(()=>void load(),2000);
    const visible=()=>{if(document.visibilityState==='visible')void load();};document.addEventListener('visibilitychange',visible);
    return()=>{active.current++;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[conversationId,api,authenticated]);
  const act=async(kind:'permission'|'cancel',id:string,decision?:Decision)=>{
    const key=kind+':'+id;if(!conversationId||locks.current.has(key))return;
    const generation=active.current,owner=conversationId;locks.current.add(key);setBusy(new Set(locks.current));version.current++;
    try {
      const path='/conversations/'+encodeURIComponent(owner)+'/sandbox/'+(kind==='permission'?'permissions/':'jobs/')+encodeURIComponent(id)+(kind==='cancel'?'/cancel':'');
      const result=await api<SandboxPermission|SandboxJob>(path,kind==='permission'?{decision}:{});
      if(active.current!==generation)return;
      version.current++;setError('');setSnapshot(current=>{
        if(current?.id!==owner)return current;
        return {...current,value:{...current.value,...(kind==='permission'?{permissions:current.value.permissions.map(permission=>permission.id===id?result as SandboxPermission:permission)}:{executions:current.value.executions.map(job=>job.execution_id===id?result as SandboxJob:job)})}};
      });
    }catch(caught){if(active.current===generation)setError(caught instanceof Error?caught.message:String(caught));}
    finally{if(active.current===generation){locks.current.delete(key);setBusy(new Set(locks.current));}}
  };
  return <Context.Provider value={conversationId?{conversationId,value:snapshot?.id===conversationId?snapshot.value:undefined,error:t(error),busy,act}:null}>{children}</Context.Provider>;
}
const permissionLabels={pending:'等待授权',approved:'已允许本次操作',denied:'已拒绝',expired:'授权已过期',revoked:'已撤销',consumed:'授权已使用'};
const jobLabels={running:'正在执行',completed:'执行完成',failed:'执行失败',cancelled:'执行已取消',unknown:'执行状态未知'};
function PermissionCard({permission,activity}:{permission:SandboxPermission;activity:ActivityContext}) {
  const {t}=useConsole();
  const busy=activity.busy.has('permission:'+permission.id);
  const expired=permission.status==='pending'&&permission.expires_at<Date.now();
  const revocable=permission.status==='approved'||permission.status==='consumed'&&activity.value?.executions.some(job=>job.execution_id===permission.execution_id&&job.status==='running');
  return <section className="sandbox-permission" data-permission-id={permission.id} aria-label={t('等待授权')}>
    <Typography.Text strong>{t(permissionLabels[expired?'expired':permission.status])}</Typography.Text>
    <p>{permission.reason}</p><pre className="sandbox-command">{permission.command}</pre>
    <dl><dt>{t('工作目录')}</dt><dd>{permission.cwd||'.'}</dd><dt>{t('联网目标')}</dt><dd>{permission.domains.length?permission.domains.join(', '):t('离线')}</dd></dl>
    <p>{t('时限：{seconds} 秒 · 内存：{memory} MiB',{seconds:permission.timeout_seconds,memory:permission.memory_mb})}</p>
    {permission.status==='pending'&&!expired&&<><p className="sandbox-permission-note">{t('仅允许此命令和当前文件版本，需在 10 分钟内开始。联网操作可能向所列目标发送数据。')}</p><div className="sandbox-card-actions"><Button type="primary" aria-label={t('允许本次操作')} loading={busy} disabled={busy} onClick={()=>void activity.act('permission',permission.id,'allow')}>{t('允许本次操作')}</Button><Button aria-label={t('拒绝本次操作')} disabled={busy} onClick={()=>void activity.act('permission',permission.id,'deny')}>{t('拒绝本次操作')}</Button></div></>}
    {revocable&&<Button danger aria-label={t('撤销授权')} disabled={busy} loading={busy} onClick={()=>void activity.act('permission',permission.id,'revoke')}>{t('撤销授权')}</Button>}
  </section>;
}
export function SandboxActivity({messageId,existingFileIds=[],asAgentReply=false}:{messageId?:string;existingFileIds?:string[];asAgentReply?:boolean}) {
  const {t}=useConsole(),activity=useContext(Context);
  if(!activity)return null;
  const permissions=activity.value?.permissions.filter(permission=>!messageId||permission.message_id===messageId)??[];
  const executions=activity.value?.executions.filter(job=>!messageId||job.message_id===messageId||!job.message_id&&permissions.some(permission=>permission.execution_id===job.execution_id))??[];
  const files=activity.value?.files.filter(file=>file.origin==='sandbox'&&(!messageId||file.message_id===messageId)&&!existingFileIds.includes(file.file_id))??[];
  if(!permissions.length&&!executions.length&&!files.length)return null;
  const content=<div className="sandbox-activity" aria-label={t('沙箱活动')}>
    <SandboxAttachments conversationId={activity.conversationId} files={files}/>
    {permissions.map(permission=><PermissionCard key={permission.id} permission={permission} activity={activity}/>)}
    {executions.map(job=><section key={job.execution_id||job.request_key} className="sandbox-job" data-execution-id={job.execution_id} aria-label={t('沙箱执行')}><div className="sandbox-job-heading"><Typography.Text strong>{t(jobLabels[job.status])}</Typography.Text>{job.status==='running'&&<Button size="small" danger aria-label={t('停止执行')} disabled={activity.busy.has('cancel:'+job.execution_id)} loading={activity.busy.has('cancel:'+job.execution_id)} onClick={()=>void activity.act('cancel',job.execution_id)}>{t('停止执行')}</Button>}</div>{job.exit_code!==null&&<p>{t('退出码：{code}',{code:job.exit_code})}</p>}{job.reason&&<p>{job.reason}</p>}{(job.stdout||job.stderr)&&<Collapse size="small" items={[{key:'output',label:t('查看命令输出'),children:<>{(job.stdout_truncated||job.stderr_truncated)&&<p>{t('此处仅显示部分输出，可让 Agent 查询保留的完整输出。')}</p>}{job.stdout&&<pre className="sandbox-output">{job.stdout}</pre>}{job.stderr&&<pre className="sandbox-output sandbox-stderr">{job.stderr}</pre>}</>}]}/>}</section>)}
    {activity.error&&<Alert type="error" title={activity.error}/>}
  </div>;
  return asAgentReply?<article className="message assistant" data-message-id={'sandbox:'+messageId}><div className="message-avatar" aria-hidden="true">A</div><div className="message-content"><div className="message-label"><span>{t('管理 AGENT')}</span></div><div className="message-bubble">{content}</div></div></article>:content;
}
