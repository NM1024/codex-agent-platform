import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useRef,useState} from 'react';
import {Button} from 'antd';
import {useConsole} from './context';

export function CopyButton({text,label='复制'}:{text:string;label?:string}) {
  const {t}=useConsole(),locked=useRef(false),[state,setState]=useState<'idle'|'copying'|'copied'|'failed'>('idle');
  const copy=async()=>{
    if(locked.current)return;
    locked.current=true;setState('copying');
    try{
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);setState('copied');
    }catch{setState('failed');}
    finally{locked.current=false;}
  };
  return <span className="copy-control"><Button size="small" loading={state==='copying'} aria-label={t(label)} onClick={()=>void copy()}>{t(state==='copying'?'正在复制…':label)}</Button><span className="copy-feedback" role="status">{state==='copied'?t('已复制'):state==='failed'?t('复制失败，请手动选择文本复制。'):''}</span></span>;
}

function literalCode(node:unknown):string {
  if(!node||typeof node!=='object')return '';
  const value=node as {type?:string;value?:string;children?:unknown[]};
  return value.type==='text'?value.value??'':(value.children??[]).map(literalCode).join('');
}

// Keep raw HTML as text. Images become links so replies make no remote requests.
function safeUrl(value:string) {
  try {
    const url=new URL(value,window.location.href);
    return ['https:','http:','mailto:'].includes(url.protocol)?url.href:'';
  }catch{return '';}
}
export function AgentMessage({text}:{text:string}) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={{
    a:({href,children})=>href?<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
    img:({src,alt})=>typeof src==='string'&&src?<a href={src} target="_blank" rel="noopener noreferrer">{alt||src}</a>:<span>{alt}</span>,
    pre:({node,children,...props})=><div className="code-block"><CopyButton text={literalCode(node)} label="复制代码"/><pre {...props}>{children}</pre></div>,
  }}>{text}</Markdown></div>;
}
export function MessageTime({value}:{value:number}) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  const text=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'}).format(date);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <time dateTime={date.toISOString()} title={`${text} (${zone})`}>{text}</time>;
}
