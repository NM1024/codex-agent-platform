import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  }}>{text}</Markdown></div>;
}
export function MessageTime({value}:{value:number}) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  const text=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'}).format(date);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <time dateTime={date.toISOString()} title={`${text} (${zone})`}>{text}</time>;
}
