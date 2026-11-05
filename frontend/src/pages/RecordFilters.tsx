import type {ReactNode} from 'react';
import {Button,Input,Select} from 'antd';
import {useConsole} from '../context';
import {Status} from '../components';
import './record-filters.css';

export type RecordRange='all'|'24h'|'7d'|'30d';
export function recordAfter(range:RecordRange){
 return range==='all'?undefined:Date.now()-({ '24h':1,'7d':7,'30d':30 }[range])*86400000;
}
interface Props {
 id:string;search:string;searchLabel:string;searchPlaceholder:string;onSearch:(value:string)=>void;
 typeFilter:ReactNode;status:string;statuses:string[];onStatus:(value:string)=>void;
 range:RecordRange;onRange:(value:RecordRange)=>void;loading:boolean;onSubmit:()=>void;onReset:()=>void;
}
export function RecordFilters({id,search,searchLabel,searchPlaceholder,onSearch,typeFilter,status,statuses,onStatus,range,onRange,loading,onSubmit,onReset}:Props){
 const {t}=useConsole();
 return <form className="record-filters" onSubmit={event=>{event.preventDefault();if(!loading)onSubmit();}}>
  <Input id={id+'-search'} maxLength={500} aria-label={searchLabel} placeholder={searchPlaceholder} value={search} onChange={event=>onSearch(event.target.value)}/>
  {typeFilter}
  <Select virtual={false} id={id+'-status'} aria-label={t('任务状态')} value={status} options={[{value:'',label:t('全部状态')},...statuses.map(value=>({value,label:<Status value={value}/>}))]} onChange={onStatus}/>
  <Select virtual={false} id={id+'-range'} aria-label={t('时间范围')} value={range} options={(['all','24h','7d','30d'] as const).map((value,index)=>({value,label:t(['全部时间','最近 24 小时','最近 7 天','最近 30 天'][index])}))} onChange={onRange}/>
  <div className="record-filter-actions"><Button htmlType="button" disabled={loading} onClick={onReset}>{t('重置筛选')}</Button><Button type="primary" htmlType="submit" aria-label={t('查询')} aria-busy={loading} loading={loading}>{t('查询')}</Button></div>
 </form>;
}
