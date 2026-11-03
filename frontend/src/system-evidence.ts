import type {SystemDetail,SystemPageResult,SystemRecord} from './types';

export type SystemPageEvidence=SystemPageResult&{stale_ids:string[]};
const time=(item:SystemRecord)=>item.kind==='event'?item.last_seen_at:item.updated_at;

// The caller owns query identity. An unavailable source cannot establish absence.
// At most one bounded window per source survives; this is an evidence snapshot,
// not a new global cursor page, so pagination pauses until a fresh replacement.
export function preserveSystemPage(value:SystemPageResult,previous?:SystemPageEvidence):SystemPageEvidence {
 const unavailable=new Set(value.sources.filter(source=>!source.available).map(source=>String(source.service)));
 const retained=previous?.items.filter(item=>unavailable.has(item.service))??[];
 const items=[...value.items,...retained].sort((a,b)=>time(b)-time(a)||(a.id===b.id?0:a.id<b.id?1:-1));
 return {...value,items,next_cursor:unavailable.size?null:value.next_cursor,stale_ids:retained.map(item=>item.id)};
}

export function preserveSystemDetail(value:SystemDetail,previous:SystemDetail|undefined,id:string):SystemDetail {
 if(!value.sources.some(source=>!source.available))return value;
 const known=previous?.work?.id===id?previous:undefined;
 return {...value,work:value.work??known?.work??null,events:known?.events??value.events??[],allowed_actions:[]};
}
