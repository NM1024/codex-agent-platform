import {SYSTEM_ACTIONS,SYSTEM_CODES} from './system-contracts.mjs';
import {parseSystemId,safeSystemDetails} from './system-journal.mjs';
const fault=code=>Object.assign(new Error(code),{code});
export function systemWork(journal,id){try{return journal?.detail(`${journal.service}:work:${id}`);}catch{return null;}}
export function systemDue(journal,id,{force=false,now=Date.now()}={}){
 let work;try{work=journal?.detail(`${journal.service}:work:${id}`);}catch{return true;}
 return force||!work||work.state!=='blocked'&&(!work.next_retry_at||work.next_retry_at<=now);
}
export function systemFailure(journal,input,error){
 const candidate=error?.code??error?.message,code=Object.hasOwn(SYSTEM_CODES,candidate)?candidate:input.code??'SYSTEM_ERROR';
 const permission=['EACCES','EPERM','EROFS','UNSAFE_PATH'].includes(code);
 const configuration=['INVALID_CONFIG','INVALID_RETENTION_POLICY','INSPECTION_EXECUTION_REJECTED','PLUGIN_DISABLED','PLUGIN_DELETED','PLUGIN_CONNECTION_REQUIRED','PLUGIN_CONNECTION_NOT_READY','NOTIFICATION_CAPABILITY_REQUIRED'].includes(candidate);
 const old=systemWork(journal,input.id),failures=(old?.consecutive_failures??0)+1;
 return journal?.work({...input,code,state:permission||configuration?'blocked':'retrying',classification:old?.classification==='code_defect'?'code_defect':permission?'permission':configuration?'configuration':'transient',next_retry_at:permission||configuration?null:Date.now()+Math.min(3600000,15000*2**Math.min(failures-1,8))});
}
/** Observe state changes, not ordinary healthy polls. Failure outcomes use systemFailure. */
export function systemObserve(journal,input){
 if(!journal)return null;const old=systemWork(journal,input.id);
 if(old&&old.state===input.state&&old.code===(input.code??`WORK_${input.state.toUpperCase()}`)&&old.pending_count===(input.pending_count??0)&&JSON.stringify(old.details)===JSON.stringify(safeSystemDetails(input.details)))return old;
 return journal.work({...input,...(old?.classification==='code_defect'?{classification:'code_defect'}:{}),attempted:input.attempted??(input.state==='completed'&&old?.state!=='running')});
}
/** Local callback registry only. Callbacks receive the reread owned work and must enforce
 * their fixed target/owner and record verified state. Return values never imply completion.
 * maintain({id,action,revision}) -> {action,work}; no arbitrary callback arguments. */
export function createSystemMaintenance({journal,actions={}}){
 if(Object.entries(actions).some(([name,fn])=>!SYSTEM_ACTIONS.includes(name)||typeof fn!=='function'))throw fault('SYSTEM_ACTION_UNSUPPORTED');
 const active=new Map();
 return async function maintain(args,{actor='system'}={}){
  if(!['system','admin','agent'].includes(actor))throw fault('SYSTEM_QUERY_INVALID');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='action,id,revision'||!SYSTEM_ACTIONS.includes(args.action)||!Number.isSafeInteger(args.revision)||args.revision<1)throw fault('SYSTEM_QUERY_INVALID');
  const identity=parseSystemId(args.id);if(identity?.kind!=='work')throw fault('SYSTEM_QUERY_INVALID');if(identity.service!==journal.service)throw fault('SYSTEM_SOURCE_MISMATCH');
  const key=args.id,existing=active.get(key);if(existing){if(existing.action===args.action&&existing.revision===args.revision)return existing.promise;throw fault('SYSTEM_WORK_BUSY');}
  const work=journal.detail(args.id);if(!work)throw fault('SYSTEM_WORK_NOT_FOUND');if(work.revision!==args.revision)throw fault('SYSTEM_REVISION_CONFLICT');
  if(!work.allowed_actions.includes(args.action)||!Object.hasOwn(actions,args.action))throw fault('SYSTEM_ACTION_UNSUPPORTED');
  const promise=Promise.resolve().then(async()=>{
   journal.event({module:work.module,event:'maintenance_requested',work_id:work.id,target_id:work.target_id,details:{phase:'verify',revision:work.revision,actor,action:args.action},code:'WORK_RUNNING'});
   try{await actions[args.action]({work,force:true});journal.event({module:work.module,event:'maintenance_returned',work_id:work.id,code:'OPERATION_COMPLETED',details:{phase:'verify',actor,action:args.action}});}
   catch(error){journal.event({module:work.module,event:'maintenance_failed',work_id:work.id,level:'error',code:'OPERATION_FAILED',details:{phase:'verify',actor,action:args.action}});throw fault('SYSTEM_MAINTENANCE_FAILED');}
   return {action:args.action,work:journal.detail(args.id)};
  }).finally(()=>active.delete(key));
  active.set(key,{action:args.action,revision:args.revision,promise});return promise;
 };
}
export function requireSystemTarget(work,id){if(work.id!==`${work.service}:work:${id}`)throw fault('SYSTEM_ACTION_UNSUPPORTED');}

/** Startup-owned Manager facade; every destructive callback delegates to its
 * original durable queue and ownership checks. intake is the existing claim/ACK loop. */
export function createManagerSystem({journal,agent,sandbox,inspections,retention,intake}){
 const actions={
  cleanup_retry:async({work})=>{
   if(work.id===`manager:work:conversation-cleanup.${work.target_id}`)return agent.retryConversationCleanup({conversationId:work.target_id,force:true});
   if(work.id===`manager:work:sandbox-cleanup.${work.target_id}`)return sandbox.cleanup({conversationId:work.target_id,force:true});
   if(work.id.startsWith('manager:work:inspection-cleanup.'))return inspections.cleanup({conversationId:work.target_id,force:true});
   throw fault('SYSTEM_ACTION_UNSUPPORTED');
  },
  inspection_reconcile:async({work})=>{
   if(work.id==='manager:work:inspection-intake')return intake({force:true});
   if(work.id===`manager:work:inspection-lifecycle.${work.target_id}`)return inspections.retryLifecycle({inspectionId:work.target_id,force:true});
   throw fault('SYSTEM_ACTION_UNSUPPORTED');
  },
  history_sweep:async({work})=>{if(!['manager:work:history-sweep','manager:work:history-compact'].includes(work.id))throw fault('SYSTEM_ACTION_UNSUPPORTED');return retention.retry();},
  health_check:async({work})=>{requireSystemTarget(work,'manager-health');const available=journal.summary().health.available&&!agent.closed;systemObserve(journal,{id:'manager-health',module:'health',state:available?'completed':'unknown',code:available?'SERVICE_RECOVERED':'SERVICE_UNAVAILABLE',allowed_actions:['health_check']});},
 };
 return {journal,maintain:createSystemMaintenance({journal,actions})};
}
/** Runner cleanup never purges artifacts or launch history. Those require the
 * existing authenticated Gateway terminal/retention authorization. */
export function createRunnerSystem({journal,runtime,outbox,probe}){
 return {journal,maintain:createSystemMaintenance({journal,actions:{
  cleanup_retry:async({work})=>{if(work.id!==`runner:work:transient-cleanup.${work.target_id}`)throw fault('SYSTEM_ACTION_UNSUPPORTED');await runtime.cleanupTransient(work.target_id,{force:true});},
  event_flush:async({work})=>{requireSystemTarget(work,'event-outbox');await outbox.flush({force:true});},
  health_check:async({work})=>{requireSystemTarget(work,'runner-health');const state=await probe();systemObserve(journal,{id:'runner-health',module:'health',state:state.ready?'completed':'unknown',code:state.ready?'SERVICE_RECOVERED':state.reason==='CHATGPT_LOGIN_REQUIRED'?'AUTH_UNAVAILABLE':'MODEL_UNAVAILABLE',allowed_actions:['health_check']});},
 }})};
}
