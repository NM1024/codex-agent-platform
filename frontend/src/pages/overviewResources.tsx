import {Tag} from 'antd';
import {Icon} from '../Icon';
import {useConsole} from '../context';
import type {Resources} from '../types';

type Translate=ReturnType<typeof useConsole>['t'];
export const measured=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const positive=(value:unknown):value is number=>measured(value)&&value>0;
export const capacity=(value:unknown)=>{
  if(!measured(value))return '—';
  const index=Math.min(4,Math.max(0,Math.floor(Math.log2(value||1)/10)));
  return `${Number((value/1024**index).toFixed(1))} ${['B','KiB','MiB','GiB','TiB'][index]}`;
};
const ratio=(value:unknown,total:unknown)=>measured(value)&&positive(total)?value/total*100:null;
const percent=(value:number)=>value.toFixed(1)+'%';
export type ResourceCardData={id:string;group:'host'|'manager';title:string;kind:string;icon:'cpu'|'memory'|'disk'|'box'|'activity';value:string;total?:string;ratio:number|null;note:string;empty:string;missing:boolean};
export function resourceCards(resources:Resources,t:Translate):ResourceCardData[]{
  const host=resources.host??{},container=resources.container??{},disk=resources.disk??{},process=resources.process??{};
  const unavailable=t('暂无采样数据'),missingLimit=t('上限未获取');
  const cpu=measured(host.cpu_percent),memory=measured(host.memory_used_bytes),diskUsed=disk.available!==false&&measured(disk.used_bytes),containerCpu=measured(container.cpu_percent);
  return [
    {id:'host-cpu',group:'host',title:t('宿主 CPU'),kind:t('整机'),icon:'cpu',value:cpu?percent(host.cpu_percent!):'—',ratio:cpu?host.cpu_percent!:null,missing:!cpu,note:positive(host.cpu_cores)?t('{count} 核处理器',{count:host.cpu_cores}):t('核心数未获取'),empty:host.cpu_percent===null?t('采样中'):unavailable},
    {id:'host-memory',group:'host',title:t('宿主内存'),kind:t('整机'),icon:'memory',value:capacity(host.memory_used_bytes),total:capacity(host.memory_total_bytes),ratio:ratio(host.memory_used_bytes,host.memory_total_bytes),missing:!memory,note:t('可用 {value}',{value:capacity(host.memory_available_bytes)}),empty:t('总量未获取')},
    {id:'disk',group:'host',title:t('数据磁盘'),kind:t('数据卷'),icon:'disk',value:diskUsed?capacity(disk.used_bytes):'—',total:disk.available===false?'—':capacity(disk.total_bytes),ratio:diskUsed?ratio(disk.used_bytes,disk.total_bytes):null,missing:!diskUsed,note:t('可用 {value}（不含预留）',{value:disk.available===false?'—':capacity(disk.available_bytes)}),empty:t('总量未获取')},
    {id:'container-memory',group:'manager',title:t('Manager 容器内存'),kind:t('容器额度'),icon:'box',value:capacity(container.memory_used_bytes),total:container.memory_limit_bytes===null?t('未设上限'):positive(container.memory_limit_bytes)?capacity(container.memory_limit_bytes):missingLimit,ratio:ratio(container.memory_used_bytes,container.memory_limit_bytes),missing:!measured(container.memory_used_bytes),note:t('含容器内进程与缓存'),empty:container.memory_limit_bytes===null?t('未设上限'):missingLimit},
    {id:'container-cpu',group:'manager',title:t('Manager 容器 CPU'),kind:t('容器配额'),icon:'cpu',value:containerCpu?t('{count} 核',{count:(container.cpu_percent!/100).toFixed(2)}):'—',total:container.quota_cores===null?t('未设配额'):positive(container.quota_cores)?t('{count} 核',{count:container.quota_cores}):t('配额未获取'),ratio:containerCpu?ratio(container.cpu_percent!/100,container.quota_cores):null,missing:!containerCpu,note:containerCpu?t('单核基准用量 {value}',{value:percent(container.cpu_percent!)}):container.cpu_percent===null?t('采样中'):unavailable,empty:container.quota_cores===null?t('未设配额'):t('配额未获取')},
    {id:'process-rss',group:'manager',title:t('Manager 进程内存'),kind:t('Node 进程'),icon:'activity',value:capacity(process.memory_rss_bytes),ratio:null,missing:!measured(process.memory_rss_bytes),note:t('进程驻留内存 RSS'),empty:t('共享容器额度')},
  ];
}
export function OverviewBadge({children,tone='neutral'}:{children:React.ReactNode;tone?:string}){return <Tag className={'status-tag status-tag--'+tone}><span className="status-dot" aria-hidden="true"/>{children}</Tag>;}
export function ResourceCard({metric}:{metric:ResourceCardData}){
  const {t}=useConsole(),tone=metric.ratio===null?'neutral':metric.ratio>=90?'error':metric.ratio>=80?'warning':'success';
  return <article className={'ops-card ops-resource ops-resource--'+tone} data-resource={metric.id} aria-labelledby={'resource-'+metric.id}>
    <div className="ops-card-heading"><span className={'ops-icon ops-icon--'+metric.group}><Icon name={metric.icon}/></span><h3 id={'resource-'+metric.id}>{metric.title}</h3><span className="ops-kind">{metric.kind}</span></div>
    <div className="ops-value"><strong>{metric.value}</strong>{metric.total&&<span className="ops-denominator">/ {metric.total}</span>}</div>
    <div className="ops-meter-row">{metric.ratio!==null?<><div className="ops-meter" role="progressbar" aria-label={metric.title+' '+t('使用率')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100,Math.max(0,metric.ratio))} aria-valuetext={percent(metric.ratio)}><span style={{width:Math.min(100,Math.max(0,metric.ratio))+'%'}}/></div><span className="ops-percent">{percent(metric.ratio)}</span></>:<span className="ops-meter-note">{metric.missing?(metric.id==='host-cpu'?metric.empty:metric.id==='container-cpu'&&metric.note===t('采样中')?metric.note:t('暂无采样数据')):metric.empty}</span>}</div>
    <div className="ops-card-footer"><span>{metric.note}</span>{tone==='error'||tone==='warning'?<OverviewBadge tone={tone}>{t(tone==='error'?'高占用':'需留意')}</OverviewBadge>:null}</div>
  </article>;
}
