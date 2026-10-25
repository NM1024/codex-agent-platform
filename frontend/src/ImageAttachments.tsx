import {Button} from 'antd';
import {useConsole} from './context';
import {Icon} from './Icon';
import type {ChatImage,MessageImage} from './types';

export function DraftImages({images,remove}:{images:ChatImage[];remove:(id:string)=>void}) {
  const {t}=useConsole();
  return images.length?<div className="chat-image-drafts">{images.map(image=><figure key={image.id}><img src={image.dataUrl} alt={image.name}/><figcaption title={image.name}>{image.name}</figcaption><Button type="text" danger size="small" icon={<Icon name="trash"/>} title={t('移除')} onClick={()=>remove(image.id)} aria-label={t('移除图片')+' '+image.name}/></figure>)}</div>:null;
}
export function MessageImages({images,generated=false}:{images:MessageImage[];generated?:boolean}) {
  const {t}=useConsole();
  return <div className="message-images">{images.filter(image=>{
    try {const url=new URL(image.url,window.location.href);return url.origin===window.location.origin && /^\/admin\/api\/conversations\/[^/]+\/images\/[^/]+$/.test(url.pathname);}catch{return false;}
  }).map(image=><figure key={image.id}><a href={image.url} target="_blank" rel="noopener noreferrer"><img src={image.url} alt={image.name} width={image.width} height={image.height} loading="lazy"/></a>{generated&&<figcaption><a href={image.url} download={image.name}>{t('下载图片')}</a></figcaption>}</figure>)}</div>;
}
