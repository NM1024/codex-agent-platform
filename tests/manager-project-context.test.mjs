import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagerStore} from '../src/manager/store.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {managementTools} from '../src/contracts/management.mjs';

test('current platform rules and deployed management source remain readable without Gateway',async t=>{
  const store=new ManagerStore(':memory:');t.after(()=>store.close());
  const operations=createManagerOperations({store,configuration:{scopes:new Map()},client:{execute(){throw new Error('Gateway offline');}}});
  const context=await operations.execute('platform_context');
  assert.match(context.revision,/^[a-f0-9]{64}$/);
  assert.match(context.instructions,/project_source/);
  assert.match(context.instructions,/当前项目运营规范/);
  assert.equal((await operations.execute('platform_context')).revision,context.revision);
  const source=await operations.execute('project_source',{mode:'read',path:'src/manager/server.mjs',limit:5});
  assert.equal(source.path,'src/manager/server.mjs');assert.match(source.content,/createServer/);
  await assert.rejects(operations.execute('project_source',{mode:'write',path:'src/manager/server.mjs'}),{code:'INVALID_MANAGEMENT_INPUT'});
  assert.ok(managementTools.some(tool=>tool.name==='project_source'));
});
