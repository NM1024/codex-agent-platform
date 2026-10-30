import {Drawer,Modal} from 'antd';
import type {ReactNode} from 'react';
import {useConsole} from './context';
import './admin-overlays.css';
interface Common {open:boolean;title:ReactNode;subtitle?:ReactNode;children:ReactNode;width?:number}
function Heading({title,subtitle}:{title:ReactNode;subtitle?:ReactNode}){return <div className="admin-overlay-heading"><div>{title}</div>{subtitle&&<small title={typeof subtitle==='string'?subtitle:undefined}>{subtitle}</small>}</div>;}
export function AdminDrawer({open,title,subtitle,onClose,children,extra,width=960}:Common&{onClose:()=>void;extra?:ReactNode}){
 const {t}=useConsole();return <Drawer className="admin-overlay admin-drawer" open={open} title={<Heading title={title} subtitle={subtitle}/>} onClose={onClose} extra={extra} width={width} closable={{'aria-label':t('关闭')}} destroyOnHidden>{children}</Drawer>;
}
export function AdminModal({open,title,subtitle,onCancel,children,footer=null,width=880,busy=false,forceRender=false}:Common&{onCancel:()=>void;footer?:ReactNode;busy?:boolean;forceRender?:boolean}){
 const {t}=useConsole();return <Modal className="admin-overlay admin-modal" open={open} title={<Heading title={title} subtitle={subtitle}/>} onCancel={()=>{if(!busy)onCancel();}} width={width} footer={footer&&<div className="admin-overlay-footer">{footer}</div>} keyboard={!busy} mask={{closable:!busy}} closable={busy?false:{'aria-label':t('关闭')}} destroyOnHidden={!forceRender} forceRender={forceRender}>{children}</Modal>;
}
