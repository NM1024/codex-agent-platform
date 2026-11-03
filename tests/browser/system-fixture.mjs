import {DatabaseSync} from 'node:sqlite';
import {SystemJournal} from '../../src/observability/system-journal.mjs';
import {createSystemMaintenance} from '../../src/observability/system-maintenance.mjs';
import {executeSystemOwner} from '../../src/observability/system-operations.mjs';

// Synthetic service owners exercise the real journals, federation and fixed repair guards.
// No model, external delivery or deployed host is involved.
export function createSystemFixture({store,business}){
 const runnerDb=new DatabaseSync(':memory:');
 const journals={manager:new SystemJournal({db:store.db,service:'manager'}),gateway:new SystemJournal({db:business.db,service:'gateway'}),runner:new SystemJournal({db:runnerDb,service:'runner'})};
 let runnerAvailable=true;
 const facades=Object.fromEntries(Object.entries(journals).map(([service,journal])=>[service,{journal,maintain:createSystemMaintenance({journal,actions:{
  configuration_sync:async({work})=>journal.work({...work,state:'completed',code:'CONFIGURATION_SYNCED',attempted:true,details:{confirmed_revision:8}}),
  cleanup_retry:async({work})=>journal.work({...work,state:'completed',code:'CLEANUP_COMPLETED',attempted:true}),
  health_check:async({work})=>journal.work({...work,state:'completed',code:'SERVICE_RECOVERED',attempted:true}),
 }})}]));
 function reset(){
  runnerAvailable=true;
  for(const journal of Object.values(journals)){journal.db.exec('DELETE FROM system_events; DELETE FROM system_work;');}
  // Keep actionable issues on page two regardless of millisecond ties during seeding.
  const managerNow=journals.manager.now;journals.manager.now=()=>Date.now()-10000;
  journals.manager.work({id:'permissions',module:'cleanup',state:'blocked',code:'EACCES',classification:'permission',pending_count:1,allowed_actions:['cleanup_retry']});
  journals.manager.work({id:'defect',module:'inspections',state:'blocked',code:'HANDOFF_FAILED',classification:'code_defect',allowed_actions:['inspection_reconcile']});
  journals.manager.now=managerNow;
  for(let n=0;n<22;n++)journals.manager.work({id:'page-'+String(n).padStart(2,'0'),module:'events',state:'retrying',code:'EVENT_DELIVERY_FAILED',next_retry_at:Date.now()+60000});
  journals.gateway.work({id:'configuration',module:'configuration',state:'retrying',code:'RUNNER_UNAVAILABLE',classification:'transient',allowed_actions:['configuration_sync'],details:{revision:8,confirmed_revision:7},next_retry_at:Date.now()+60000});
  const oldNow=journals.runner.now;journals.runner.now=()=>Date.now()-600000;
  journals.runner.work({id:'stale',module:'runtime',state:'running',code:'WORK_RUNNING'});journals.runner.now=oldNow;
  journals.runner.work({id:'recovered-idle',module:'health',state:'blocked',code:'SERVICE_UNAVAILABLE'});
  journals.runner.work({id:'recovered-idle',module:'health',state:'completed',code:'SERVICE_RECOVERED',attempted:false});
  journals.runner.work({id:'recovered-idle',module:'health',state:'idle',code:'WORK_IDLE',attempted:false});
  journals.manager.event({module:'api',code:'EACCES',event:'request_rejected',level:'error'});
 }
 reset();return {owner:facades.manager,reset,setRunnerAvailable:value=>{runnerAvailable=value;},remote:(service,operation,args,context)=>{if(service==='runner'&&!runnerAvailable)throw new Error('synthetic unavailable');return executeSystemOwner(facades[service],operation,args,context);},close:()=>runnerDb.close()};
}
