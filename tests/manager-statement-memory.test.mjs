import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';

test('large disk-backed scheduling workloads reuse bounded SQL statements and keep query results live',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const original=store.db.prepare.bind(store.db);let prepares=0;
  store.db.prepare=sql=>{prepares++;return original(sql);};
  for(let n=0;n<250;n++){
    const c=store.createConversation(),message=store.enqueue(c.id,'Synthetic request '+n);store.schedule(c.id);
    assert.equal(store.next(c.id).text,'Synthetic request '+n);store.markRunning(message.id);store.finish(message,null,'Synthetic result '+n);
    assert.equal(store.metadata(c.id).id,c.id);assert.equal(store.message(message.id).status,'completed');
  }
  assert.ok(prepares<64,`repeated parameterized workloads should reuse native statements, got ${prepares}`);
});

test('statement caching cannot grow with arbitrary query shapes and reuses the most recent shape',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  for(let n=0;n<500;n++)assert.equal(store.statement(`SELECT ${n} AS value`).get().value,n);
  assert.ok(store.statements.size<=64);
  const last=store.statement('SELECT 499 AS value');assert.equal(store.statement('SELECT 499 AS value'),last);
  assert.equal(store.statement('SELECT ? AS value').get('fresh').value,'fresh');
  assert.equal(store.statement('SELECT ? AS value').get('changed').value,'changed');
});

test('large text and image bindings are not retained in the prepared statement cache',t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  store.db.exec('CREATE TABLE synthetic_payload(bytes BLOB)');
  const sql='INSERT INTO synthetic_payload VALUES(?)';
  store.statement(sql).run(Buffer.alloc(64*1024));assert.equal(store.statements.has(sql),false);
  store.statement(sql).run('x'.repeat(64*1024));assert.equal(store.statements.has(sql),false);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM synthetic_payload').get().count,2);
});
