import {Button} from 'antd';
import {useConsole} from './context';
import type {ChatImage,MessageImage} from './types';

export function DraftImages({images,remove}:{images:ChatImage[];remove:(id:string)=>void}) {
  const {t}=useConsole();
  return images.length?<div className="chat-image-drafts">{images.map(image=><figure key={image.id}><img src={image.dataUrl} alt={image.name}/><figcaption title={image.name}>{image.name}</figcaption><Button size="small" onClick={()=>remove(image.id)} aria-label={t('移除图片')+' '+image.name}>{t('移除')}</Button></figure>)}</div>:null;
}
export function MessageImages({images}:{images:MessageImage[]}) {
  return <div className="message-images">{images.filter(image=>{
    try {const url=new URL(image.url,window.location.href);return url.origin===window.location.origin && /^\/admin\/api\/conversations\/[^/]+\/images\/[^/]+$/.test(url.pathname);}catch{return false;}
  }).map(image=><a key={image.id} href={image.url} target="_blank" rel="noopener noreferrer"><img src={image.url} alt={image.name} width={image.width} height={image.height} loading="lazy"/></a>)}</div>;
}
