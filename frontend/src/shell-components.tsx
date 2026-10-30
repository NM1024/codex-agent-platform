import {useRef,useState} from 'react';
import {Button,Spin,type ButtonProps} from 'antd';
import {useConsole} from './context';

// Keep shell primitives separate so authenticated controls stay behind lazy page imports.
export function AsyncButton({onClick,...props}:Omit<ButtonProps,'onClick'|'loading'>&{onClick:()=>Promise<unknown>}) {
  const locked=useRef(false),[busy,setBusy]=useState(false),{act}=useConsole();
  return <Button {...props} loading={busy} aria-busy={busy} onClick={()=>{
    if(locked.current)return;
    locked.current=true;setBusy(true);
    void act(onClick).finally(()=>{locked.current=false;setBusy(false);});
  }}/>;
}
export function LoadingState({label='正在加载数据…',className='',compact=false}:{label?:string;className?:string;compact?:boolean}) {
  const {t}=useConsole();
  return <div className={'loading-state '+(compact?'loading-state--compact ':'')+className} role="status" aria-live="polite" aria-atomic="true"><div className="loading-state-content"><span aria-hidden="true"><Spin size={compact?'small':'default'}/></span><span className="loading-state-label">{t(label)}</span></div></div>;
}
export function DataLoading(){return <LoadingState className="page-loading"/>;}
