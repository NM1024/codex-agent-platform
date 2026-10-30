import type {ChatFile,SandboxAttachment} from './types';

export const validateSandboxFiles=(current:ChatFile[],files:File[])=>{
  if(current.length+files.length>5)return '每条消息最多添加 5 个文件。';
  if(files.some(file=>file.size>20*1024*1024))return '单个文件不能超过 20 MiB。';
  if([...current.map(draft=>draft.file),...files].reduce((total,file)=>total+file.size,0)>100*1024*1024)return '每条消息的文件总大小不能超过 100 MiB。';
  return '';
};
export const sandboxFileUrl=(file:SandboxAttachment,conversationId:string,preview=false)=>{
  try {
    const value=preview?file.preview_url:file.url;if(!value)return null;
    const url=new URL(value,window.location.href);
    if(url.origin!==window.location.origin||url.pathname!==`/admin/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(file.file_id)}`||url.hash)return null;
    if(preview&&url.search!=='?preview=1')return null;
    if(!preview&&url.search)return null;
    return url.pathname+url.search;
  }catch{return null;}
};
export const sandboxPreviewKind=(mime:string)=>{
  mime=mime.split(';',1)[0].trim().toLowerCase();
  if(/^(image\/(png|jpeg|webp|gif))$/i.test(mime))return 'image';
  if(/^(text\/(plain|csv|tab-separated-values)|application\/(json|x-ndjson))$/i.test(mime))return 'text';
  return null;
};
export const sandboxFileSize=(size:number)=>size>=1024*1024?`${(size/1024/1024).toFixed(1)} MiB`:size>=1024?`${(size/1024).toFixed(1)} KiB`:`${size} B`;
