import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {RequestStore} from '../src/core/store.mjs';
import {OperationsService} from '../src/operations/service.mjs';
function fixture(t){const app=createApplication('gateway',{RUNNER_TOKEN:'synthetic-editor-token'}),store=new RequestStore(':memory:',{registry:app.registry});t.after(()=>store.close());const operations=new OperationsService({...app,store,dispatcher:{drain:async()=>{}},runner:{ready:async()=>({ready:true})},configuration:app.configuration(store)});return {store,operations};}
const definition={type:'synthetic.editor',name:'Synthetic editor',instructions:'Synthetic instructions',input_schema:{type:'object'},result_schema:{type:'object'},capabilities:{tools:[]},delivery:{mode:'none'},enabled:false};
test('plugin editor create-only revision cannot overwrite a concurrently created business definition',async t=>{
 const {store,operations}=fixture(t);const saved=await operations.execute('plugin_save',{definition,revision:0});assert.equal(saved.name,definition.name);
 await assert.rejects(operations.execute('plugin_save',{definition:{...definition,name:'Stale create'},revision:0}),{status:409,code:'PLUGIN_REVISION_CONFLICT'});assert.equal(store.plugins.get(definition.type).name,definition.name);
});
test('plugin editor compares the definition revision atomically and preserves concurrent model overrides',async t=>{
 const {store,operations}=fixture(t);const first=store.plugins.save(definition);const newer=store.plugins.setExecution(definition.type,{verbosity:'high'},first.revision);
 await assert.rejects(operations.execute('plugin_save',{definition:{...definition,name:'Stale edit'},revision:first.revision}),{status:409,code:'PLUGIN_REVISION_CONFLICT'});assert.equal(store.plugins.get(definition.type).execution.verbosity,'high');
 const edited=await operations.execute('plugin_save',{definition:{...definition,name:'Fresh edit',execution:newer.execution},revision:newer.revision});assert.equal(edited.name,'Fresh edit');assert.equal(edited.execution.verbosity,'high');
});
