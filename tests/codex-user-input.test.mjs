import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexRpcClient} from '../src/codex/rpc.mjs';

test('RPC defers only registered user-input requests, leaves approvals denied and drops resolved requests',async()=>{
  const client=Object.assign(Object.create(CodexRpcClient.prototype),{buffer:'',closed:false,listeners:new Set(),pending:new Map(),serverHandlers:new Map(),serverPending:new Map()});
  const sent=[];client.send=value=>sent.push(value);
  let resolve;
  client.handleServerRequest('item/tool/requestUserInput',()=>new Promise(r=>resolve=r));
  client.read(JSON.stringify({id:77,method:'item/tool/requestUserInput',params:{}})+'\n');
  await new Promise(setImmediate);assert.deepEqual(sent,[]);
  resolve({answers:{format:{answers:['JSON']}}});await new Promise(setImmediate);
  assert.deepEqual(sent,[{id:77,result:{answers:{format:{answers:['JSON']}}}}]);
  client.read(JSON.stringify({id:78,method:'item/tool/requestUserInput',params:{}})+'\n');await new Promise(setImmediate);
  client.read(JSON.stringify({method:'serverRequest/resolved',params:{requestId:78}})+'\n');
  resolve({answers:{}});await new Promise(setImmediate);assert.equal(sent.length,1);
  client.read(JSON.stringify({id:79,method:'item/commandExecution/requestApproval',params:{}})+'\n');
  assert.deepEqual(sent.at(-1),{id:79,result:{decision:'decline'}});
  assert.throws(()=>client.handleServerRequest('item/tool/call',()=>({})),/UNSUPPORTED_SERVER_HANDLER/);
});
