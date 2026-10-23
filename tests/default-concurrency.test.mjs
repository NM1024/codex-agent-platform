import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../src/config.mjs';
import {executionScope} from '../src/configuration/execution.mjs';
import {ConfigurationStore} from '../src/configuration/store.mjs';
import {BusinessRegistry} from '../src/core/registry.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {Dispatcher} from '../src/core/dispatcher.mjs';
import {AgentRuntime} from '../src/runtime/codex.mjs';

for(const role of ['gateway','runner']) {
  test(`${role} defaults to five business tasks and preserves an explicit one`,()=>{
    assert.equal(loadConfig(role,{RUNNER_TOKEN:'synthetic-token'}).concurrency,5);
    assert.equal(loadConfig(role,{RUNNER_TOKEN:'synthetic-token',CONCURRENCY:'1'}).concurrency,1);
  });
}

test('fresh execution settings default to five while a saved one wins over new bootstrap values',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const store={db},config={};
  const settings=new ConfigurationStore(db,[executionScope({store,config})]);
  assert.equal(settings.read('execution').concurrency,5);
  assert.equal(config.concurrency,5);
  settings.update('execution',{concurrency:1});
  const restarted={concurrency:5};
  const reopened=new ConfigurationStore(db,[executionScope({store,config:restarted})]);
  assert.equal(reopened.read('execution').concurrency,1);
  assert.equal(restarted.concurrency,1);
});

test('execution initialization preserves explicit and legacy concurrency one',t=>{
  for(const legacy of [false,true]) {
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());
    if(legacy)db.exec(`CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO platform_settings VALUES('runtime','{"concurrency":1}')`);
    const config={concurrency:legacy?5:1};
    const settings=new ConfigurationStore(db,[executionScope({store:{db},config})]);
    assert.equal(settings.read('execution').concurrency,1);
    assert.equal(config.concurrency,1);
  }
});

for(const [label,config,want] of [['default',{},5],['explicit one',{concurrency:1},1]]) {
  test(`dispatcher ${label} enforces capacity and synchronizes it to Runner`,async t=>{
    const definition={type:'test.concurrency',version:'1',prompt:'Submit a result.',inputSchema:{type:'object'},resultSchema:{type:'boolean'}};
    const registry=new BusinessRegistry([definition]),store=new RequestStore(':memory:',{registry});
    let configured;
    const runner={ready:async()=>({ready:true}),launch:async()=>({status:'running'}),configure:async values=>{configured=values;},active:async()=>({runs:[]})};
    const dispatcher=new Dispatcher({store,registry,runner,config});
    t.after(async()=>{await dispatcher.stop();store.close();});
    await dispatcher.synchronize();
    assert.equal(configured.concurrency,want);
    for(let index=0;index<6;index++)store.accept('synthetic',{type:definition.type,request_id:String(index),input:{}});
    await dispatcher.drain();
    assert.equal(store.unfinished().filter(run=>run.status==='running').length,want);
    assert.equal(store.queued().length,6-want);
  });
}

for(const [label,options,want] of [['default',{},5],['explicit one',{concurrency:1},1]]) {
  test(`Runner ${label} reserves capacity before starting external work`,async()=>{
    const runtime=new AgentRuntime(options);
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const launches=[];
    try {
      for(let index=0;index<want;index++)launches.push(runtime.launch({run_id:randomUUID(),task_id:randomUUID(),type:'test.concurrency',input:{}},{beforeStart:async()=>{await gate;throw new Error('SYNTHETIC_STOP');}}));
      // Attach handlers while reservations are pending; no Codex process starts.
      const completed=Promise.allSettled(launches);
      await assert.rejects(runtime.launch({run_id:randomUUID(),task_id:randomUUID(),type:'test.concurrency',input:{}}),/RUNNER_BUSY/);
      assert.equal(runtime.launches.size,want);
      release();
      await completed;
    } finally {
      release();
      await Promise.allSettled(launches);
      await runtime.stop();
    }
  });
}
