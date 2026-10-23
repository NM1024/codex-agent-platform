import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OperationsClient } from '../src/manager/client.mjs';

test('an interrupted management response keeps its action outcome unknown after headers arrive',async t=>{
  let accepted=0;
  const server=createServer((req,res)=>{
    accepted++;
    res.writeHead(200,{'content-type':'application/json','content-length':'1024'});
    res.flushHeaders();res.write('{"task_id":"already-created"');
    setImmediate(()=>res.destroy());
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const client=new OperationsClient({url:`http://127.0.0.1:${server.address().port}`,token:'local-test'});
  await assert.rejects(client.execute('retry',{task_id:'original-task'}),error=>{
    assert.equal(error.code,'GATEWAY_UNAVAILABLE');assert.equal(error.effectUnknown,true);return true;
  });
  assert.equal(accepted,1);
});

test('a complete management rejection preserves its readable error and known outcome',async t=>{
  const server=createServer((req,res)=>{res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TASK_NOT_TERMINAL',message:'任务仍在执行。'}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const client=new OperationsClient({url:`http://127.0.0.1:${server.address().port}`,token:'local-test'});
  await assert.rejects(client.execute('retry',{task_id:'running-task'}),error=>{
    assert.equal(error.code,'TASK_NOT_TERMINAL');assert.equal(error.message,'任务仍在执行。');assert.equal(error.effectUnknown,undefined);return true;
  });
});
