import './chat-status-i18n';
import {useEffect,useState} from 'react';
import {Icon} from './Icon';
import type {Message} from './types';

export type ChatConnection='connecting'|'connected'|'reconnecting'|'fallback'|'failed'|'unconfirmed';
export function runPresentation(message:Message) {
  if(message.status==='completed')return {label:'执行完成',tone:'success',spinning:false};
  if(message.status==='failed')return {label:'执行失败',tone:'error',spinning:false};
  if(message.status==='interrupted')return {label:'等待继续',tone:'warning',spinning:false};
  if(message.status==='queued')return {label:'排队等待',tone:'neutral',spinning:false};
  if(message.status==='recovering')return {label:'正在恢复',tone:'working',spinning:true};
  if(message.questions?.some(question=>question.status==='pending'))return {label:'等待你回答',tone:'warning',spinning:false};
  if(message.status!=='running')return {label:'结果未知',tone:'warning',spinning:false};
  const active=(message.activity??[]).filter(item=>['running','executing'].includes(item.status)).sort((a,b)=>b.updated_at-a.updated_at);
  const tool=active.find(item=>item.kind==='tool');
  if(tool)return {label:tool.label==='imageGeneration'?'正在生成图片':tool.label==='webSearch'?'正在搜索网页':'正在调用工具',tone:'working',spinning:true,detail:['imageGeneration','webSearch'].includes(tool.label)?undefined:tool.label};
  const current=active[0];
  return {label:current?.kind==='assistant_message'?'正在输出回复':current?.kind==='reasoning_summary'?'正在思考':'正在处理',tone:'working',spinning:true};
}
export function progressTiming(message:Message,now:number) {
  const pending=['running','queued','recovering','interrupted'].includes(message.status);
  const end=message.completed_at??(pending?now:message.updated_at??message.created_at);
  const latest=Math.max(message.updated_at??message.created_at,...(message.activity??[]).map(item=>item.updated_at),...(message.replies??[]).map(item=>item.updated_at??item.created_at),...(message.questions??[]).map(item=>item.updated_at??item.created_at));
  return {duration:Math.max(0,Math.floor((end-(message.started_at??message.created_at))/1000)),latest};
}
export function useProgressClock(ticking:boolean) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!ticking)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[ticking]);
  return now;
}
export function connectionWarning(connection:ChatConnection) {
  return {unconfirmed:'正在核对运行状态',connecting:'正在连接，状态待确认',connected:'',reconnecting:'正在重新连接，状态可能延迟',fallback:'实时连接不可用，正在定时更新。',failed:'状态更新失败，显示上次记录'}[connection];
}
export function RunIndicator({spinning,tone}:{spinning:boolean;tone:string}) {
  return <span className="run-indicator" data-spinning={spinning} data-tone={tone} aria-hidden="true">{!spinning&&<Icon name={tone==='success'?'check':tone==='error'?'close':tone==='warning'?'alert':'pause'}/>}</span>;
}
