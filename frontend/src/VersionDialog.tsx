import {useEffect,useRef,useState} from 'react';
import {activeUpgrade,type LatestVersion,type UpgradeJob,type UpgradeStatus,type VersionContext} from './version-types';

import {versionText} from './version-i18n';
const expired=(error:unknown)=>error instanceof Error&&'status' in error&&error.status===401;
const updateCommand='curl -fL https://github.com/NM1024/codex-agent-platform/releases/latest/download/update.sh -o /tmp/codex-platform-update.sh\nsudo bash /tmp/codex-platform-update.sh update';
const setupCommand='sudo ./deploy.sh web-update-status [runtime]\nsudo ./deploy.sh enable-web-update [runtime]';
const phases:Record<string,string>={queued:'等待升级',checking:'正在检查版本',downloading:'正在下载',building:'正在构建',stopping:'正在停止服务',backing_up:'正在备份',validating:'正在验证数据',restarting:'正在重启服务',verifying:'正在验证部署',completed:'升级完成',failed:'升级失败，请在部署服务器检查状态与备份。',interrupted:'升级已中断，需在部署服务器检查后手动处理。'};
function jobText(job:UpgradeJob){return job.state==='failed'?phases.failed:job.state==='interrupted'?phases.interrupted:job.state==='succeeded'?phases.completed:['completed','failed','interrupted'].includes(job.phase)?'升级正在进行':phases[job.phase]??'升级正在进行';}

export default function VersionDialog({api,locale,ui,current,onClose,onUpdated}:VersionContext&{current:string|null;onClose:()=>void;onUpdated:()=>void}){
  const {Alert,Button,Modal,Typography}=ui,t=(key:string)=>versionText(locale,key);
  const [status,setStatus]=useState<UpgradeStatus|null>(null),[latest,setLatest]=useState<LatestVersion|null>(null);
  const [checking,setChecking]=useState(false),[latestError,setLatestError]=useState(false),[reconnecting,setReconnecting]=useState(false);
  const [confirming,setConfirming]=useState(false),[starting,setStarting]=useState(false),[requestError,setRequestError]=useState(false),[copyState,setCopyState]=useState('');
  const alive=useRef(true),startLock=useRef(false),checkLock=useRef(false),kick=useRef(()=>{}),updated=useRef(onUpdated);
  const trackedJob=useRef<UpgradeJob|null>(null);
  updated.current=onUpdated;
  useEffect(()=>{
    alive.current=true;let stopped=false,inFlight=false,again=false,timer:ReturnType<typeof setTimeout>|undefined,terminalJob='';
    const schedule=()=>{if(!stopped)timer=setTimeout(()=>{void read();},2000);};
    const read=async()=>{
      if(stopped)return;if(inFlight){again=true;return;}inFlight=true;
      try{
        const value=await api<UpgradeStatus>('/upgrade');if(stopped)return;
        if(!value.job&&activeUpgrade(trackedJob.current)){setStatus({...value,job:trackedJob.current});setReconnecting(true);schedule();return;}
        trackedJob.current=value.job;
        setStatus(value);setReconnecting(false);
        if(value.job&&!activeUpgrade(value.job)&&value.job.id!==terminalJob){terminalJob=value.job.id;setLatest(null);updated.current();}
        if(activeUpgrade(value.job))schedule();
      }catch(error){if(stopped||expired(error))return;setReconnecting(true);schedule();}
      finally{inFlight=false;if(again&&!stopped){again=false;if(timer)clearTimeout(timer);void read();}}
    };
    kick.current=()=>{if(timer)clearTimeout(timer);void read();};void read();
    return()=>{stopped=true;alive.current=false;kick.current=()=>{};if(timer)clearTimeout(timer);};
  },[api]);
  const check=async()=>{
    if(checkLock.current)return;checkLock.current=true;setChecking(true);setLatestError(false);setConfirming(false);
    try{const value=await api<LatestVersion>('/version/latest');if(alive.current)setLatest(value);}
    catch{if(alive.current){setLatest(null);setLatestError(true);}}
    finally{checkLock.current=false;if(alive.current)setChecking(false);}
  };
  const canUpgrade=Boolean(latest?.update_available&&status?.available&&!activeUpgrade(status.job)&&!reconnecting&&!checking&&!starting);
  const start=async()=>{
    if(startLock.current||!canUpgrade)return;startLock.current=true;setStarting(true);setRequestError(false);setConfirming(false);
    try{const value=await api<UpgradeStatus>('/upgrade',{});if(!alive.current)return;trackedJob.current=value.job;setStatus(value);kick.current();}
    catch(error){if(!alive.current||expired(error))return;setRequestError(true);setReconnecting(true);kick.current();}
    finally{startLock.current=false;if(alive.current)setStarting(false);}
  };
  const job=status?.job,busy=activeUpgrade(job);
  return <Modal open title={t('版本与更新')} className="console-modal version-modal" width={570} onCancel={onClose} footer={<>
    {confirming?<><Button onClick={()=>setConfirming(false)}>{t('取消')}</Button><Button id="version-confirm-upgrade" type="primary" disabled={!canUpgrade} loading={starting} onClick={()=>{void start();}}>{t('确认开始升级')}</Button></>:<Button id="version-upgrade" type="primary" disabled={!canUpgrade} loading={starting} onClick={()=>setConfirming(true)}>{t('升级到最新稳定版本')}</Button>}
    {job?.state==='succeeded'&&<Button id="version-reload" onClick={()=>window.location.reload()}>{t('刷新界面')}</Button>}
    <Button onClick={onClose}>{locale==='en'?'Close':'关闭'}</Button>
  </>}>
    <div id="version-dialog-content">
      <dl className="version-summary"><div><dt>{t('当前运行版本')}</dt><dd>{current?'v'+current:t('版本未知')}</dd></div><div><dt>{t('最新稳定版本')}</dt><dd>{latest?'v'+latest.latest:t('尚未检查')}</dd></div></dl>
      <div className="version-check-row"><Button id="version-check" loading={checking} disabled={Boolean(busy)||starting} onClick={()=>{void check();}}>{t('检查更新')}</Button>{latest&&<Typography.Link id="version-release" href={latest.release_url} target="_blank" rel="noopener noreferrer">{t('发布说明')}</Typography.Link>}</div>
      {latestError&&<Alert type="warning" showIcon title={t('暂时无法检查最新版本，请稍后重试。')}/>}
      {latest&&<Typography.Paragraph type="secondary">{t(latest.update_available?'发现新版本':latest.current===latest.latest?'当前已是最新稳定版本':'当前版本比最新稳定版本更新')} · {t('上次检查')} {new Date(latest.checked_at).toLocaleString(locale==='en'?'en-US':'zh-CN')}</Typography.Paragraph>}
      {reconnecting&&<Alert role="status" type="warning" showIcon title={t(job?'正在重新连接；升级任务会在服务器上继续。':'升级服务暂时无法连接，正在重试。')}/>}
      {starting&&<Alert role="status" type="info" showIcon title={t('正在确认升级任务，请勿重复提交。')}/>}
      {requestError&&!job&&<Alert type="warning" showIcon title={t('升级请求未能确认，请检查服务器状态后重试。')}/>}
      {job&&<Alert role="status" type={job.state==='succeeded'?'success':job.state==='failed'||job.state==='interrupted'?'error':'info'} showIcon title={t(jobText(job))} description={<div className="version-details">{job.target_version&&<span>{t('目标版本')} · v{job.target_version}</span>}{job.installed_version&&<span>{t('已安装版本')} · v{job.installed_version}</span>}{job.error_code&&<span>{t('错误代码')} · {job.error_code}</span>}{busy&&<span>{t('升级任务未完成时可关闭此窗口，稍后重新打开查看进度。')}</span>}</div>}/>}
      {confirming&&<Alert type="warning" showIcon title={t('维护期间服务会短暂中断，运行中的工作可能暂停。升级会先构建、备份，再重启服务；请确认当前适合维护。')}/>}
      {status===null&&!reconnecting&&<Typography.Paragraph type="secondary">{t('正在读取升级服务状态…')}</Typography.Paragraph>}
      {status?.available&&!job&&<Typography.Paragraph type="secondary">{t('升级服务已就绪')}</Typography.Paragraph>}
      {status?.available===false&&!busy&&<section className="version-section"><h3>{t('检查网页升级服务')}</h3><p>{t('标准部署会自动配置网页升级。服务可能已关闭或自动配置未完成；请先检查状态，需要时恢复启用。将 [runtime] 替换为已有运行目录。不支持 systemd 的环境请使用命令行更新。')}</p><pre className="version-command">{setupCommand}</pre></section>}
      <section className="version-section"><h3>{t('命令行更新')}</h3><p>{t('在部署服务器上运行。多个实例时，请在 update 后加上已有运行目录。')}</p><pre id="version-update-command" className="version-command">{updateCommand}</pre><div className="version-copy-row"><Button onClick={()=>{void navigator.clipboard?.writeText(updateCommand).then(()=>{if(alive.current)setCopyState('更新命令已复制。');}).catch(()=>{if(alive.current)setCopyState('无法复制，请手动选择命令。');});if(!navigator.clipboard)setCopyState('无法复制，请手动选择命令。');}}>{t('复制更新命令')}</Button>{copyState&&<span role="status">{t(copyState)}</span>}</div></section>
    </div>
  </Modal>;
}
