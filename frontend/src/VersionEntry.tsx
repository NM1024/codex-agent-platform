import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import type {RunningVersion,VersionContext} from './version-types';
import {versionText} from './version-i18n';
import './version.css';
const VersionDialog=lazy(()=>import('./VersionDialog'));

export default function VersionEntry({api,locale,ui}:VersionContext){
  const {Button}=ui,t=(key:string)=>versionText(locale,key);
  const [current,setCurrent]=useState<string|null>(null),[open,setOpen]=useState(false);
  const alive=useRef(true);
  const refresh=useCallback(async()=>{const value=await api<RunningVersion>('/version');return value.current;},[api]);
  const updated=useCallback(()=>{void refresh().then(value=>{if(alive.current)setCurrent(value);}).catch(()=>{});},[refresh]);
  useEffect(()=>{alive.current=true;updated();return()=>{alive.current=false;};},[updated]);
  return <><Button id="version-entry" type="text" title={t('版本与更新')+' · '+(current?'v'+current:t('版本未知'))} aria-label={t('版本与更新')+' · '+(current?'v'+current:t('版本未知'))} onClick={()=>setOpen(true)}>{current?'v'+current:'?'}</Button>{open&&<Suspense fallback={null}><VersionDialog ui={ui} api={api} locale={locale} current={current} onClose={()=>setOpen(false)} onUpdated={updated}/></Suspense>}</>;
}
