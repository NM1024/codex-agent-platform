import {useState} from 'react';
import {Button,Image} from 'antd';
import {useConsole} from './context';
import {Icon} from './Icon';
import type {ChatImage,MessageImage} from './types';

export function DraftImages({images,remove}:{images:ChatImage[];remove:(id:string)=>void}) {
  const {t}=useConsole();
  return images.length?<div className="chat-image-drafts">{images.map(image=><figure key={image.id}><img src={image.dataUrl} alt={image.name}/><figcaption title={image.name}>{image.name}</figcaption><Button type="text" danger size="small" icon={<Icon name="trash"/>} title={t('移除')} onClick={()=>remove(image.id)} aria-label={t('移除图片')+' '+image.name}/></figure>)}</div>:null;
}
export function MessageImages({images,generated=false}:{images:MessageImage[];generated?:boolean}) {
  const {t}=useConsole(),[open,setOpen]=useState(false),[current,setCurrent]=useState(0);
  const available=images.filter(image=>{
    try {const url=new URL(image.url,window.location.href);return url.origin===window.location.origin && /^\/admin\/api\/conversations\/[^/]+\/images\/[^/]+$/.test(url.pathname);}catch{return false;}
  });
  if(!available.length)return null;
  return <div className="message-images"><Image.PreviewGroup items={available.map(image=>({src:image.url,alt:image.name}))} preview={{open,onOpenChange:setOpen,current:Math.min(current,available.length-1),alt:available[Math.min(current,available.length-1)].name,onChange:setCurrent,closeIcon:<span role="img" aria-label={t('关闭预览')}><Icon name="close"/></span>}} classNames={{popup:{root:'chat-image-preview'}}}/>{available.map((image,index)=><figure key={image.id}><button type="button" className="message-image-open" aria-label={t('预览图片：{name}',{name:image.name})} onClick={()=>{setCurrent(index);setOpen(true);}}><img src={image.url} alt={image.name} width={image.width} height={image.height} loading="lazy"/></button>{generated&&<figcaption><a href={image.url} download={image.name}>{t('下载图片')}</a></figcaption>}</figure>)}</div>;
}
