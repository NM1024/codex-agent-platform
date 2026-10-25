import {useCallback,useEffect,useRef,useState} from 'react';
import {useConsole} from '../context';
import type {Overview} from '../types';

// Keep the last snapshot visible on refresh failure, but mark it stale. A late
// poll must never replace a newer post-operation snapshot or a new page instance.
export function useOverview(){
  const {api,notify}=useConsole(),[data,setData]=useState<Overview>(),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const generation=useRef(0),alive=useRef(false),inFlight=useRef(0),hasSnapshot=useRef(false);
  const refresh=useCallback(async(skipBusy=false)=>{
    if(skipBusy&&inFlight.current>0)return;
    const request=++generation.current;inFlight.current++;
    try{const next=await api<Overview>('/overview');if(alive.current&&request===generation.current){setData(next);hasSnapshot.current=true;setError('');}}
    catch(cause){if(alive.current&&request===generation.current){const message=cause instanceof Error?cause.message:String(cause);setError(message);if(!hasSnapshot.current)notify(message);}}
    finally{inFlight.current--;if(alive.current&&request===generation.current)setLoading(false);}
  },[api,notify]);
  useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(true),10000);return()=>{alive.current=false;generation.current++;clearInterval(timer);};},[refresh]);
  return {data,loading,error,refresh};
}
