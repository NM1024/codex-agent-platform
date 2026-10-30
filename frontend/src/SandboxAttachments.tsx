import {useEffect,useState} from 'react';
import {Alert,Button,Drawer,Segmented,Spin} from 'antd';
import {useConsole} from './context';
import {Icon} from './Icon';
import {AgentMessage} from './ChatMessage';
import {sandboxFileSize,sandboxFileUrl,sandboxPreviewKind} from './sandbox-files';
import type {ChatFile,SandboxAttachment} from './types';
import './sandbox.css';

export function SandboxDraftFiles({files,remove}:{files:ChatFile[];remove:(id:string)=>void}) {
  const {t}=useConsole();
  return files.length?<div className="sandbox-draft-files">{files.map(({id,file})=><div key={id} className="sandbox-draft-file"><span title={file.name}>{file.name}</span><small>{sandboxFileSize(file.size)}</small><Button size="small" type="text" danger icon={<Icon name="trash"/>} aria-label={t('移除文件：{name}',{name:file.name})} onClick={()=>remove(id)}/></div>)}</div>:null;
}
function FilePreview({file,url}:{file:SandboxAttachment;url:string}) {
  const {t,setAuthenticated}=useConsole();
  const [text,setText]=useState<string>(),[error,setError]=useState(false),[mode,setMode]=useState('preview');
  const kind=sandboxPreviewKind(file.mime,file.name);
  useEffect(()=>{
    if(kind!=='text'&&kind!=='markdown')return;
    let active=true;const controller=new AbortController();
    void fetch(url,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
      if(active&&response.status===401)setAuthenticated(false);
      if(!response.ok)throw new Error();
      // Preview responses are bounded by the server; keep the rendered text bounded too.
      const reader=response.body?.getReader();if(!reader)throw new Error();
      const decoder=new TextDecoder();let result='',bytes=0;
      try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>256*1024)throw new Error();result+=decoder.decode(next.value,{stream:true});}result+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
      if(active)setText(result);
    }).catch(()=>{if(active)setError(true);});
    return()=>{active=false;controller.abort();};
  },[url,kind,setAuthenticated]);
  return kind==='image'?<img className="sandbox-image-preview" src={url} alt={file.name}/>:error?<Alert type="error" title={t('无法加载预览，请下载文件。')}/>:text===undefined?<Spin/>:<>{kind==='markdown'&&<Segmented className="sandbox-preview-modes" value={mode} onChange={setMode} options={[{value:'preview',label:t('预览')},{value:'source',label:t('原文')}]}/>}{kind==='markdown'&&mode==='preview'?<div className="sandbox-markdown-preview"><AgentMessage text={text}/></div>:<pre className="sandbox-text-preview">{text}</pre>}</>;
}
export function SandboxAttachments({files,conversationId}:{files:SandboxAttachment[];conversationId:string}) {
  const {t}=useConsole(),[preview,setPreview]=useState<SandboxAttachment>();
  const available=Array.from(new Map(files.map(file=>[file.file_id,file])).values()).filter(file=>sandboxFileUrl(file,conversationId));
  const previewUrl=preview&&sandboxFileUrl(preview,conversationId,true);
  return <>{!!available.length&&<div className="sandbox-attachments" aria-label={t('对话附件')}>{available.map(file=>{
    const canPreview=sandboxPreviewKind(file.mime,file.name)&&sandboxFileUrl(file,conversationId,true);
    return <div key={file.file_id} className="sandbox-attachment"><span className="sandbox-file-name" title={file.name}>{file.name}</span><small>{sandboxFileSize(file.size)}</small>{canPreview&&<Button size="small" type="text" aria-label={t('预览文件：{name}',{name:file.name})} onClick={()=>setPreview(file)}>{t('文件预览')}</Button>}<a href={sandboxFileUrl(file,conversationId)!} download={file.name} aria-label={t('下载文件：{name}',{name:file.name})}><Icon name="download"/></a></div>;
  })}</div>}<Drawer className="sandbox-preview-drawer" title={preview?.name??t('文件预览')} open={!!preview} onClose={()=>setPreview(undefined)} destroyOnHidden width="min(880px, 100vw)" extra={preview&&<a href={sandboxFileUrl(preview,conversationId)!} download={preview.name} aria-label={t('下载文件：{name}',{name:preview.name})}>{t('下载文件')}</a>}>{preview&&previewUrl&&<FilePreview key={preview.file_id} file={preview} url={previewUrl}/>}</Drawer></>;
}
