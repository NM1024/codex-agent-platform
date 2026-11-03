import Ajv from 'ajv';
import {HttpError} from '../errors.mjs';
import {SYSTEM_SERVICES,SYSTEM_MODULES,SYSTEM_STATES,SYSTEM_LEVELS,SYSTEM_CLASSIFICATIONS,SYSTEM_ACTIONS,SYSTEM_CODES,systemManagementTools} from './system-contracts.mjs';
import {parseSystemId,normalizeSystemQuery,mergeSystemPages,compareSystemRecords,systemRecordTime,decodeSystemCursor,safeSystemDetails} from './system-journal.mjs';
import {buildSystemIssueDraft} from './system-report.mjs';

const checks=new Map(systemManagementTools.map(t=>[t.name,new Ajv({strict:true}).compile(t.inputSchema)]));
export const systemToolNames=new Set(systemManagementTools.map(t=>t.name));
export const SYSTEM_OWNER_OPERATIONS=Object.freeze(['status','logs','work','issue','maintain','classify','review']);
const actors=['admin','agent','system'],object=x=>!!x&&typeof x==='object'&&!Array.isArray(x),time=x=>Number.isSafeInteger(x)&&x>=0;
const token=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const fault=code=>new HttpError(code==='SYSTEM_REVISION_CONFLICT'||code==='SYSTEM_WORK_BUSY'?409:code==='SYSTEM_HUMAN_REQUIRED'?403:code==='SYSTEM_WORK_NOT_FOUND'?404:['SYSTEM_SOURCE_UNAVAILABLE','SYSTEM_JOURNAL_UNAVAILABLE','SYSTEM_MAINTENANCE_FAILED'].includes(code)?503:400,code,code);
const guardCodes=new Set(['SYSTEM_QUERY_INVALID','SYSTEM_SOURCE_MISMATCH','SYSTEM_REVISION_CONFLICT','SYSTEM_WORK_BUSY','SYSTEM_CODE_DEFECT','SYSTEM_ACTION_UNSUPPORTED','SYSTEM_WORK_NOT_FOUND','SYSTEM_HUMAN_REQUIRED']);
export function validateSystemEnvelope(body,{gateway=false}={}) {
 if(!object(body)||Object.keys(body).some(k=>!(gateway?['service','args','actor']:['args','actor']).includes(k))||!object(body.args)||!actors.includes(body.actor)||gateway&&!['gateway','runner'].includes(body.service))throw fault('SYSTEM_QUERY_INVALID');
 return body;
}
function exactWork(args) {
 if(!object(args)||Object.keys(args).sort().join(',')!=='id,revision'||parseSystemId(args.id)?.kind!=='work'||!Number.isSafeInteger(args.revision)||args.revision<1)throw fault('SYSTEM_QUERY_INVALID');
}
/** Fixed owner facade. Private classify/review operations are authenticated transports,
 * never management tools; review additionally requires a server-derived human actor. */
export async function executeSystemOwner(facade,operation,args={}, {actor='system'}={}) {
 if(!SYSTEM_OWNER_OPERATIONS.includes(operation)||!actors.includes(actor))throw fault('SYSTEM_QUERY_INVALID');
 if(!facade?.journal)throw fault('SYSTEM_JOURNAL_UNAVAILABLE');const j=facade.journal;
 try {
  if(operation==='maintain')return await facade.maintain(args,{actor});
  if(operation==='classify'||operation==='review') {
   exactWork(args);if(parseSystemId(args.id).service!==j.service)throw fault('SYSTEM_SOURCE_MISMATCH');
   if(operation==='review'&&actor!=='admin')throw fault('SYSTEM_HUMAN_REQUIRED');
   const work=j.detail(args.id);if(!work)throw fault('SYSTEM_WORK_NOT_FOUND');if(work.revision!==args.revision)throw fault('SYSTEM_REVISION_CONFLICT');
   if(operation==='review'&&work.classification!=='code_defect')throw fault('SYSTEM_QUERY_INVALID');
   return j.classify(args.id,operation==='classify'?'code_defect':'unknown',args.revision,{actor,review:operation==='review'});
  }
  if(operation==='status') {
   if(!object(args)||Object.keys(args).length)throw fault('SYSTEM_QUERY_INVALID');
   const summary=j.summary();if(!summary.health.available)throw fault('SYSTEM_JOURNAL_UNAVAILABLE');
   return {summary,work:j.works({limit:20}).items,issues:j.issues({limit:20}).items};
  }
  if(args.id!==undefined) {
   if(!['work','issue'].includes(operation)||Object.keys(args).join(',')!=='id'||parseSystemId(args.id)?.kind!=='work')throw fault('SYSTEM_QUERY_INVALID');
   if(parseSystemId(args.id).service!==j.service)throw fault('SYSTEM_SOURCE_MISMATCH');return {work:j.detail(args.id)};
  }
  normalizeSystemQuery(args,{issues:operation==='issue'});
  return operation==='logs'?j.logs(args):operation==='issue'?j.issues(args):j.works(args);
 }catch(error){throw fault(guardCodes.has(error.code)||['SYSTEM_JOURNAL_UNAVAILABLE','SYSTEM_MAINTENANCE_FAILED'].includes(error.code)?error.code:'SYSTEM_SOURCE_UNAVAILABLE');}
}
const optionalTimes=['first_attempt_at','last_attempt_at','last_success_at','completed_at','next_retry_at','issue_opened_at','resolved_at'];
/** Validate foreign shapes and re-project fixed copy/allowlisted details. Never forward
 * arbitrary returned IDs, source selectors, diagnostic strings or extra properties. */
function recordProjection(raw,service,kind,now) {
 if(!object(raw)||raw.service!==service||parseSystemId(raw.id)?.service!==service||parseSystemId(raw.id)?.kind!==kind||raw.kind!==kind||!SYSTEM_MODULES.includes(raw.module)||!Object.hasOwn(SYSTEM_CODES,raw.code)||!time(raw.created_at)||raw.target_id!==null&&!token(raw.target_id)||!object(raw.details))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const base={id:raw.id,kind,service,module:raw.module,code:raw.code,message:SYSTEM_CODES[raw.code],target_id:raw.target_id,details:safeSystemDetails(raw.details),created_at:raw.created_at};
 if(kind==='event') {
  if(!SYSTEM_LEVELS.includes(raw.level)||!token(raw.event)||!time(raw.first_seen_at)||!time(raw.last_seen_at)||!Number.isSafeInteger(raw.count)||raw.count<1||raw.state!==null&&!SYSTEM_STATES.includes(raw.state)||raw.work_id!==null&&(parseSystemId(raw.work_id)?.service!==service||parseSystemId(raw.work_id)?.kind!=='work'))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
  return {...base,event:raw.event,level:raw.level,state:raw.state,work_id:raw.work_id,first_seen_at:raw.first_seen_at,last_seen_at:raw.last_seen_at,count:raw.count};
 }
 if(!SYSTEM_STATES.includes(raw.state)||!SYSTEM_CLASSIFICATIONS.includes(raw.classification)||!Array.isArray(raw.allowed_actions)||raw.allowed_actions.some(x=>!SYSTEM_ACTIONS.includes(x))||raw.allowed_actions.length>SYSTEM_ACTIONS.length||!Number.isSafeInteger(raw.revision)||raw.revision<1||['updated_at','last_progress_at','attempts','consecutive_failures','pending_count','issue_count'].some(k=>!time(raw[k]))||optionalTimes.some(k=>raw[k]!==null&&!time(raw[k])))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const work={...base,title:raw.module,state:raw.state,classification:raw.classification,allowed_actions:[...new Set(raw.allowed_actions)].filter(x=>raw.classification!=='code_defect'||x==='health_check'),revision:raw.revision};
 for(const key of ['updated_at','last_progress_at','attempts','consecutive_failures','pending_count','issue_count',...optionalTimes])work[key]=raw[key];
 // Three trusted owner wake intervals plus request slack. This is only a read
 // annotation; it never modifies state/timestamps or admits duplicate work.
 const interval=raw.module==='events'?15000:60000;
 const progress=Math.max(raw.last_progress_at,Math.min(now,base.details.observed_progress_at??0));
 const expected=Math.max(progress+interval*3,raw.next_retry_at??0);
 const active=['running','retrying','unknown'].includes(raw.state);
 return {...work,age_ms:Math.max(0,now-raw.created_at),progress_age_ms:Math.max(0,now-raw.last_progress_at),expected_check_at:active?expected:null,stale:active&&now>expected,verification_required:raw.state==='unknown'||active&&now>expected};
}
function pageProjection(raw,service,kind,args,now) {
 if(!object(raw)||!Array.isArray(raw.items)||raw.items.length>(args.limit??50)||raw.next_cursor!==null&&typeof raw.next_cursor!=='string')throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 // Global merge requires every continued source to supply the full requested
 // window; a shorter window could hide newer records behind the global cursor.
 if(raw.next_cursor!==null&&raw.items.length!==(args.limit??50))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const items=raw.items.map(x=>recordProjection(x,service,kind,now));
 if(raw.next_cursor!==null){const cursor=decodeSystemCursor(raw.next_cursor),last=items.at(-1);if(!last||cursor.id!==last.id||cursor.time!==systemRecordTime(last))throw fault('SYSTEM_SOURCE_UNAVAILABLE');}
 if(new Set(items.map(x=>x.id)).size!==items.length||items.some((x,i)=>i>0&&compareSystemRecords(items[i-1],x)>0))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const position=args.cursor?decodeSystemCursor(args.cursor):null;
 if(position&&items.some(x=>systemRecordTime(x)>position.time||systemRecordTime(x)===position.time&&x.id>=position.id))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 if(items.some(x=>args.work_id!==undefined&&(kind==='event'?x.work_id:x.id)!==args.work_id||args.target_id!==undefined&&x.target_id!==args.target_id||args.module!==undefined&&x.module!==args.module||args.after!==undefined&&systemRecordTime(x)<args.after||args.before!==undefined&&systemRecordTime(x)>=args.before))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 return {items,next_cursor:raw.next_cursor};
}
function detailProjection(raw,service,id,now) {
 if(!object(raw)||!Object.hasOwn(raw,'work'))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const work=raw.work===null?null:recordProjection(raw.work,service,'work',now);
 if(work&&work.id!==id)throw fault('SYSTEM_SOURCE_UNAVAILABLE');return {work};
}
function statusProjection(raw,service,now) {
 const s=raw?.summary;
 if(!object(s)||s.service!==service||!time(s.collected_at)||s.health?.available!==true||!object(s.states)||SYSTEM_STATES.some(k=>!time(s.states[k]))||!time(s.unresolved)||!time(s.recovered_24h)||!Array.isArray(raw.work)||!Array.isArray(raw.issues)||raw.work.length>20||raw.issues.length>20)throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 const collection=s.health.collection;
 if(!object(collection)||typeof collection.pending!=='boolean'||['gap_count','failed_operations'].some(k=>!time(collection[k]))||['first_failed_at','last_failed_at','last_recovered_at','gap_started_at'].some(k=>collection[k]!==null&&!time(collection[k])))throw fault('SYSTEM_SOURCE_UNAVAILABLE');
 return {summary:{service,collected_at:s.collected_at,states:Object.fromEntries(SYSTEM_STATES.map(k=>[k,s.states[k]])),unresolved:s.unresolved,recovered_24h:s.recovered_24h,collection:Object.fromEntries(['pending','gap_count','failed_operations','first_failed_at','last_failed_at','last_recovered_at','gap_started_at'].map(k=>[k,collection[k]]))},work:raw.work.map(x=>recordProjection(x,service,'work',now)),issues:raw.issues.map(x=>recordProjection(x,service,'work',now))};
}
/** Manager federation over local facade + existing credentialed fixed remote adapter.
 * remote(service,operation,args,{actor}) cannot accept URLs/headers/paths from callers. */
export function createSystemOperations({local,remote,now=Date.now,version='unknown'}) {
 const call=(service,operation,args,context)=>service==='manager'?executeSystemOwner(local(),operation,args,context):remote?remote(service,operation,args,context):Promise.reject(fault('SYSTEM_SOURCE_UNAVAILABLE'));
 async function query(operation,args={},services=SYSTEM_SERVICES) {
  const at=now();const results=await Promise.all(services.map(async service=>{
   try{const raw=await call(service,operation,args,{actor:'system'});const value=operation==='status'?statusProjection(raw,service,at):args.id?detailProjection(raw,service,args.id,at):pageProjection(raw,service,operation==='logs'?'event':'work',args,at);return {value,source:{service,available:true,observed_at:at,error_code:null}};}
   catch{return {value:null,source:{service,available:false,observed_at:at,error_code:'SYSTEM_SOURCE_UNAVAILABLE'}};}
  }));return {results,sources:results.map(r=>r.source)};
 }
 async function detail(id) {
  const identity=parseSystemId(id);if(identity?.kind!=='work')throw fault('SYSTEM_QUERY_INVALID');
  const read=await query('work',{id},[identity.service]);return {work:read.results[0].value?.work??null,sources:read.sources};
 }
 async function mutate(operation,args,context) {
  const identity=parseSystemId(args.id);if(identity?.kind!=='work')throw fault('SYSTEM_QUERY_INVALID');
  try{return await call(identity.service,operation,args,context);}catch(error){if(guardCodes.has(error.code)||error.code==='SYSTEM_MAINTENANCE_FAILED')throw fault(error.code);throw Object.assign(fault('SYSTEM_SOURCE_UNAVAILABLE'),{effectUnknown:true});}
 }
 return {
  async review(args) {exactWork(args);await mutate('review',args,{actor:'admin'});return detail(args.id);},
  async execute(name,args={},context={}) {
   const check=checks.get(name);if(!check||!check(args))throw fault('SYSTEM_QUERY_INVALID');
   const actor=context.actor??'system';if(!actors.includes(actor))throw fault('SYSTEM_QUERY_INVALID');
   if(name==='system_status') {
    const {results,sources}=await query('status',{},args.service?[args.service]:SYSTEM_SERVICES),values=results.flatMap(r=>r.value?[r.value]:[]);
    return {sampled_at:now(),sources,summary:{complete:sources.every(s=>s.available),states:Object.fromEntries(SYSTEM_STATES.map(k=>[k,values.reduce((n,v)=>n+v.summary.states[k],0)])),unresolved:values.reduce((n,v)=>n+v.summary.unresolved,0),recovered_24h:values.reduce((n,v)=>n+v.summary.recovered_24h,0),collections:values.map(v=>({service:v.summary.service,...v.summary.collection}))},work:values.flatMap(v=>v.work).sort(compareSystemRecords).slice(0,20),issues:values.flatMap(v=>v.issues).sort(compareSystemRecords).slice(0,20)};
   }
   if(name==='system_maintain') {
    let outcome='accepted';try{await mutate('maintain',args,{actor});}catch(error){if(error.code==='SYSTEM_MAINTENANCE_FAILED')outcome='failed';else if(error.effectUnknown)outcome='unknown';else throw error;}
    const fresh=await detail(args.id);if(outcome==='accepted')outcome=!fresh.sources[0].available?'unknown':fresh.work?.state==='completed'?'recovered':'unconfirmed';
    return {action:args.action,outcome,...fresh};
   }
   if(name==='system_issue_draft') {
    const fresh=await detail(args.id);if(!fresh.sources[0].available)throw fault('SYSTEM_SOURCE_UNAVAILABLE');if(!fresh.work)throw fault('SYSTEM_WORK_NOT_FOUND');if(fresh.work.revision!==args.revision)throw fault('SYSTEM_REVISION_CONFLICT');
    const related=await query('logs',{work_id:args.id,limit:20},[fresh.work.service]);if(!related.sources[0].available)throw fault('SYSTEM_SOURCE_UNAVAILABLE');
    await mutate('classify',{id:args.id,revision:args.revision},{actor});
    return buildSystemIssueDraft({work:fresh.work,events:related.results[0].value.items,notes:args,version});
   }
   const operation={system_logs:'logs',system_work:'work',system_issue:'issue'}[name];
   if(args.id) {
    if(Object.keys(args).length!==1)throw fault('SYSTEM_QUERY_INVALID');
    const fresh=await detail(args.id);if(name!=='system_issue'||!fresh.work)return fresh;
    const related=await query('logs',{work_id:args.id,limit:20},[fresh.work.service]);return {...fresh,events:related.results[0].value?.items??[],allowed_actions:fresh.work.allowed_actions,sources:related.sources};
   }
   normalizeSystemQuery(args,{issues:operation==='issue'});
   const {results,sources}=await query(operation,args,args.service?[args.service]:SYSTEM_SERVICES);
   return {...mergeSystemPages(results.flatMap(r=>r.value?[r.value]:[]),{limit:args.limit??50}),sources};
  },
 };
}
