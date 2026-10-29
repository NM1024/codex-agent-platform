import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';

test('bounded recovery includes an old unconfirmed operation even after hundreds of newer reads',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic operation');store.markRunning(m.id);
  const uncertain=store.beginAction(c.id,'retry',{task_id:'synthetic-original'});
  store.finishAction(uncertain,null,{code:'CODEX_TIMEOUT',message:'Synthetic transport timeout',effectUnknown:true});
  for(let n=0;n<200;n++){const id=store.beginAction(c.id,'task',{task_id:'synthetic-read-'+n});store.finishAction(id,{status:'completed'});}
  const context=store.recoveryActionContext(c.id,m.id);
  assert.equal(context.actions.length,100);assert.equal(context.omitted_count,101);
  assert.ok(context.actions.some(row=>row.id===uncertain&&row.status==='unknown'));
  assert.equal(context.all_unconfirmed_included,true);assert.match(context.omitted_instruction,/not.*repeat/i);
});

test('too many unconfirmed actions pause recovery instead of silently dropping an uncertain operation',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),m=store.enqueue(c.id,'Synthetic operations');store.markRunning(m.id);
  for(let n=0;n<101;n++){const id=store.beginAction(c.id,'retry',{task_id:'uncertain-'+n});store.finishAction(id,null,{effectUnknown:true,code:'CODEX_TIMEOUT',message:'Synthetic'});}
  assert.throws(()=>store.recoveryActionContext(c.id,m.id),{code:'MANAGER_RECOVERY_ACTION_OVERFLOW'});
});

test('legacy unconfirmed records remain visible and unrelated conversation actions are excluded',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const c=store.createConversation(),other=store.createConversation();
  const legacy=store.beginAction(c.id,'retry',{task_id:'legacy'});store.finishAction(legacy,null,{effectUnknown:true,code:'CODEX_TIMEOUT',message:'Synthetic'});
  const m=store.enqueue(c.id,'Continue');store.markRunning(m.id);
  const foreign=store.beginAction(other.id,'retry',{task_id:'foreign'});store.finishAction(foreign,null,{effectUnknown:true,code:'CODEX_TIMEOUT',message:'Synthetic'});
  const context=store.recoveryActionContext(c.id,m.id);
  assert.ok(context.actions.some(row=>row.id===legacy));assert.ok(!context.actions.some(row=>row.id===foreign));
});
