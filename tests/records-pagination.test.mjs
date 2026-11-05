import test from 'node:test';
import assert from 'node:assert/strict';
import {BusinessRegistry} from '../src/core/registry.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';

function fixture(t) {
  const store=new RequestStore(':memory:',{registry:new BusinessRegistry()});
  t.after(()=>store.close());
  for(const type of ['synthetic.alpha','synthetic.beta'])store.plugins.save({type,name:type,instructions:'Synthetic task only',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'}});
  const service=new OperationsService({store,config:{concurrency:1,paused:false},dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})}});
  return {store,service};
}
function tasks(store) {
  for(let n=0;n<125;n++) {
    const task=store.accept('synthetic-client',{type:n<110?'synthetic.alpha':'synthetic.beta',request_id:`record-${n}`,input:{content:n<110?'matching needle':'other'}});
    store.db.prepare('UPDATE agent_requests SET created_at=? WHERE task_id=?').run(1000+n,task.task_id);
    if(n<10){const run=store.claim(task.task_id);store.fail(run.run_id,'SYNTHETIC_FAILURE');}
  }
}

test('task totals apply the same filters as pages and never include offset or limit',async t=>{
  const {store,service}=fixture(t);tasks(store);
  const first=await service.execute('tasks',{include_total:true,limit:100});
  assert.equal(first.total,125);assert.equal(first.items.length,100);
  const second=await service.execute('tasks',{include_total:true,limit:100,offset:100});
  assert.equal(second.total,125);assert.equal(second.items.length,25);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.task_id)).size,125);
  for(const [filter,want] of [[{search:'needle'},110],[{type:'synthetic.beta'},15],[{status:'failed'},10],[{search:'needle',status:'queued',after:1020,before:1080},60],[{search:'absent'},0]]) {
    const page=await service.execute('tasks',{...filter,include_total:true,limit:10,offset:20});
    assert.equal(page.total,want);assert.ok(page.items.length<=10);
  }
  const empty=await service.execute('tasks',{include_total:true,limit:20,offset:1000});
  assert.deepEqual(empty,{items:[],total:125});
});

test('schedule totals retain deleted plans and count both task and inspection execution filters',async t=>{
  const {service}=fixture(t),start=Date.parse('2026-10-22T00:00:00Z');
  const common={cron:'* * * * *',timezone:'Etc/UTC',enabled:true};
  const task=service.schedules.save({...common,name:'Synthetic task plan',kind:'task',type:'synthetic.alpha',input:{}},start);
  const inspection=service.schedules.save({...common,name:'Synthetic inspection plan',kind:'inspection',message:'Synthetic inspection only'},start);
  for(let n=1;n<=65;n++)await service.schedules.tick(start+n*60000);
  service.schedules.delete(inspection.id);
  const first=await service.execute('schedule_runs',{include_total:true,limit:100});
  assert.equal(first.total,130);assert.equal(first.items.length,100);
  const second=await service.execute('schedule_runs',{include_total:true,limit:100,offset:100});
  assert.equal(second.total,130);assert.equal(second.items.length,30);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,130);
  for(const [filter,want] of [[{search:'inspection plan'},65],[{schedule_id:task.id},65],[{status:'cancelled'},65],[{status:'queued',search:'task plan'},65],[{after:start+60000,before:start+4*60000},6],[{search:'absent'},0]]) {
    const page=await service.execute('schedule_runs',{...filter,include_total:true,limit:20,offset:40});
    assert.equal(page.total,want);assert.ok(page.items.length<=20);
  }
  assert.deepEqual(await service.execute('schedule_runs',{include_total:true,offset:1000}),{items:[],total:130});
});

test('counted records cap page size at 100 and legacy callers retain arrays and limit 200',async t=>{
  const {store,service}=fixture(t);tasks(store);
  for(const action of ['tasks','schedule_runs']) {
    for(const limit of [10,20,50,100])assert.ok(Array.isArray((await service.execute(action,{include_total:true,limit})).items));
    for(const limit of [101,200])await assert.rejects(service.execute(action,{include_total:true,limit}),{status:400,code:'INVALID_MANAGEMENT_INPUT'});
    for(const include_total of [undefined,false]) {
      const rows=await service.execute(action,{limit:200,...(include_total===undefined?{}:{include_total})});
      assert.ok(Array.isArray(rows));if(action==='tasks')assert.equal(rows.length,125);
    }
  }
});

test('Admin record routes request totals through Manager operations and preserve legacy responses',async t=>{
  const {store,service}=fixture(t);tasks(store);
  const operations=createManagerOperations({store:{},client:{execute:(...args)=>service.execute(...args)},models:async()=>[]});
  const server=createManagerServer({store:{},auth:{authorize:()=>true},agent:{},operations,metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/admin/api`;
  const page=await(await fetch(`${base}/tasks?include_total=1&search=needle&limit=20&offset=100`)).json();
  assert.equal(page.total,110);assert.equal(page.items.length,10);
  const schedules=await(await fetch(`${base}/schedule-runs?include_total=1&limit=20`)).json();
  assert.deepEqual(schedules,{items:[],total:0});
  for(const path of ['tasks','schedule-runs']) {
    assert.equal((await fetch(`${base}/${path}?include_total=1&limit=101`)).status,400);
    assert.ok(Array.isArray(await(await fetch(`${base}/${path}?limit=200`)).json()));
    assert.ok(Array.isArray(await(await fetch(`${base}/${path}?include_total=0&limit=200`)).json()));
  }
});
