import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessRegistry } from '../src/core/registry.mjs';
import { RequestStore } from '../src/core/store.mjs';

async function setup(t) {
  const {ScheduleStore}=await import('../src/operations/schedules.mjs');
  const root=mkdtempSync(join(tmpdir(),'schedule-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'tasks.sqlite'),store=new RequestStore(path,{registry:new BusinessRegistry()});t.after(()=>store.close());
  store.plugins.save({type:'text.generate',name:'文字',instructions:'完成输入',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});
  return {store,path,ScheduleStore,schedules:new ScheduleStore(store)};
}
test('a due schedule creates one task across repeated ticks, missed intervals and reopening',async t=>{
  const {store,path,ScheduleStore,schedules}=await setup(t);const start=Date.parse('2026-10-22T00:00:00Z');
  const plan=schedules.save({name:'每分钟',kind:'task',type:'text.generate',input:{topic:'海'},cron:'* * * * *',timezone:'Asia/Shanghai',enabled:true},start);
  assert.equal(plan.next_run_at,start+60000);
  await schedules.tick(start+5*60000);await schedules.tick(start+5*60000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_requests').get().n,1);
  assert.equal(schedules.list()[0].next_run_at,start+6*60000);
  const reopened=new RequestStore(path,{registry:new BusinessRegistry()});t.after(()=>reopened.close());
  await new ScheduleStore(reopened).tick(start+5*60000);assert.equal(reopened.queued().length,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_schedule_runs').get().n,1);
});
test('Shanghai daily trigger, disabled plugin and management inspection retain explicit state',async t=>{
  const {store,schedules}=await setup(t);const start=Date.parse('2026-10-22T00:00:00Z');
  const daily=schedules.save({name:'日报',kind:'task',type:'text.generate',input:{},cron:'0 9 * * *',timezone:'Asia/Shanghai',enabled:true},start);
  assert.equal(daily.next_run_at,Date.parse('2026-10-22T01:00:00Z'));
  store.plugins.setEnabled('text.generate',false);await schedules.tick(daily.next_run_at);
  assert.match(schedules.list()[0].blocked_reason,/PLUGIN_DISABLED/);assert.equal(store.queued().length,0);
  schedules.save({name:'巡检',kind:'inspection',message:'检查失败任务',cron:'* * * * *',timezone:'Asia/Shanghai',enabled:true},start);
  await schedules.tick(start+60000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_inspections').get().n,1);
  assert.throws(()=>schedules.save({name:'坏计划',kind:'task',type:'text.generate',input:{},cron:'invalid',timezone:'Mars',enabled:true},start),/INVALID_SCHEDULE/);
});
test('an obsolete schedule can be disabled after its plugin contract changes',async t=>{
  const {store,schedules}=await setup(t);
  const plan=schedules.save({name:'旧计划',kind:'task',type:'text.generate',input:{},cron:'* * * * *'});
  const {revision,updated_at,...definition}=store.plugins.get('text.generate');
  store.plugins.save({...definition,input_schema:{type:'object',properties:{new_field:{type:'string'}},required:['new_field']}});
  const disabled=schedules.setEnabled(plan.id,false);
  assert.equal(disabled.enabled,false);assert.equal(disabled.next_run_at,plan.next_run_at);
  await schedules.tick(plan.next_run_at+60000);assert.equal(store.queued().length,0);
  assert.throws(()=>schedules.setEnabled(plan.id,true),/INVALID_SCHEDULE/);
});
