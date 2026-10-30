import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ManagerStore} from '../src/manager/store.mjs';
import {AdminAuth} from '../src/manager/auth.mjs';
import {ManagerSandbox} from '../src/manager/sandbox.mjs';
import {createManagerServer} from '../src/manager/server.mjs';
import {createManagerOperations} from '../src/manager/operations.mjs';
import {createManagementMcpHandler} from '../src/manager/mcp.mjs';

// Only the external host is synthetic. Admission, persistence, Admin auth, HTTP,
// MCP transport, schemas, scope checks and permission handling are production code.
function localHost(now){
  const owners=new Map(),calls=[];
  function owner(id){
    if(!owners.has(id))owners.set(id,{available:true,exists:true,instance_id:randomUUID(),revision:0,network_supported:true,limits:{timeout_seconds:120,memory_mb:1024,max_timeout_seconds:600,max_memory_mb:2048},executions:[],files:new Map()});
    return owners.get(id);
  }
  return {calls,owner,async recover(){return {recovered:true};},async call(action,id,args={}){
    calls.push({action,conversationId:id,args:structuredClone(args)});
    const state=owner(id);
    if(action==='context'){const {files,...snapshot}=state;return structuredClone(snapshot);}
    if(action==='files'){
      if(args.action==='ensure')return {instance_id:state.instance_id,revision:state.revision};
      if(args.action==='list')return {entries:[...state.files].map(([path,bytes])=>({path,name:basename(path),size:bytes.length,type:'file'})),instance_id:state.instance_id,revision:state.revision};
      if(args.action==='read'){const bytes=state.files.get(args.path);if(!bytes)throw Object.assign(new Error('Missing synthetic file'),{code:'SANDBOX_FILE_NOT_FOUND'});return {text:bytes.toString('utf8'),size:bytes.length,instance_id:state.instance_id,revision:state.revision};}
      if(args.action==='delete')state.files.delete(args.path);
      else state.files.set(args.path,args.action==='import'?Buffer.from(args.content_base64,'base64'):Buffer.from(args.text));
      state.revision++;
      return {path:args.path,size:state.files.get(args.path)?.length??0,instance_id:state.instance_id,revision:state.revision};
    }
    if(action==='exec'){
      state.revision++;
      const job={execution_id:randomUUID(),request_key:args.request_key,instance_id:state.instance_id,status:'running',stdout:'',stderr:'',exit_code:null,created_at:now(),timeout_seconds:args.timeout_seconds??60,memory_mb:args.memory_mb??1024};
      state.executions.push(job);return structuredClone(job);
    }
    if(action==='process'){
      const job=args.execution_id?state.executions.find(job=>job.execution_id===args.execution_id):state.executions.at(-1);
      if(!job)throw Object.assign(new Error('Unknown synthetic job'),{code:'SANDBOX_JOB_NOT_FOUND'});
      Object.assign(job,{status:args.action==='cancel'?'cancelled':'completed',exit_code:args.action==='cancel'?null:0,stdout:'synthetic local result',completed_at:now()});
      return structuredClone(job);
    }
    if(action==='export'){
      const bytes=state.files.get(args.path);if(!bytes)throw Object.assign(new Error('Missing synthetic file'),{code:'SANDBOX_FILE_NOT_FOUND'});
      return {name:basename(args.path),mime:'text/plain',size:bytes.length,content_base64:bytes.toString('base64')};
    }
    if(action==='destroy'){state.files.clear();state.exists=false;state.instance_id=null;return {destroyed:true};}
    throw new Error(`Unexpected host action: ${action}`);
  }};
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'sandbox-integration-')),store=new ManagerStore(':memory:');
  let clock=Date.now();const now=()=>clock,host=localHost(now),wakes=[],tokens=new Map(),clients=[];
  const sandbox=new ManagerSandbox({store,root,client:host,wake:id=>wakes.push(id),now});
  store.attachMessageFiles=(...args)=>sandbox.attach(...args);
  store.messageFiles=id=>sandbox.filesForMessage(id);
  const auth=new AdminAuth(store.db);await auth.initialize('synthetic-local-admin-password');
  const operations=createManagerOperations({store,sandbox,auth,client:{async execute(){throw new Error('Unexpected Gateway operation');}},metrics:{sample:async()=>({})},configuration:{scopes:new Set()},models:async()=>[]});
  const agent={closed:false,enqueue:(id,text,images=[],fileIds=[])=>store.enqueue(id,text,images,fileIds)};
  const admin=createManagerServer({store,agent,operations,auth,sandbox,metrics:{sample:async()=>({})}});
  const handler=createManagementMcpHandler({store,operations,authorize:token=>tokens.get(token)?.conversationId,executionContext:token=>tokens.get(token)}),mcp=createServer(handler);
  await Promise.all([new Promise(r=>admin.listen(0,'127.0.0.1',r)),new Promise(r=>mcp.listen(0,'127.0.0.1',r))]);
  t.after(async()=>{
    await Promise.allSettled(clients.map(client=>client.close()));await handler.settle();
    for(const server of [admin,mcp]){server.closeAllConnections();await new Promise(r=>server.close(r));}
    store.close();await rm(root,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${admin.address().port}`;
  const login=await fetch(base+'/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-local-admin-password'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(path,{authenticated=true,headers={},...options}={})=>fetch(base+path,{...options,headers:{...(authenticated?{cookie}:{}),...headers}});
  const post=(path,body,options={})=>request(path,{method:'POST',...options,headers:{'content-type':'application/json',...options.headers},body:JSON.stringify(body)});
  const create=async()=>{const response=await post('/admin/api/conversations',{title:'Synthetic sandbox work'});assert.equal(response.status,201);return response.json();};
  const upload=async(id,name,bytes,mime='text/plain')=>{const response=await request(`/admin/api/conversations/${id}/files`,{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(name),'x-file-mime':mime},body:bytes});assert.equal(response.status,201,await response.clone().text());return response.json();};
  const admit=async(id,text='Work locally',file_ids=[])=>{const response=await post(`/admin/api/conversations/${id}/messages`,{text,file_ids});assert.equal(response.status,202,await response.clone().text());return response.json();};
  const connect=async(id,messageId)=>{
    const token=randomUUID();tokens.set(token,{conversationId:id,messageId});
    const client=new Client({name:'sandbox-integration',version:'1'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
    return {client,token};
  };
  const running=async(id,text='Work locally')=>{const message=await admit(id,text);store.markRunning(message.id);return {...await connect(id,message.id),message};};
  const tool=async(client,name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result.content));return result.structuredContent??JSON.parse(result.content[0].text);};
  const denied=async(client,name,args,codes)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true,JSON.stringify(result));if(codes)assert.ok(codes.some(code=>result.content.some(item=>item.text?.includes(code))),JSON.stringify(result.content));return result;};
  const decision=(id,permissionId,value,options)=>post(`/admin/api/conversations/${id}/sandbox/permissions/${permissionId}`,{decision:value},options);
  const snapshot=async id=>{const response=await request(`/admin/api/conversations/${id}/sandbox`);assert.equal(response.status,200);return response.json();};
  return {store,host,sandbox,wakes,tokens,request,post,create,upload,admit,connect,running,tool,denied,decision,snapshot,advance:ms=>clock+=ms};
}

test('authenticated upload and file-only admission flow through real MCP to stable private publication',async t=>{
  const f=await fixture(t),conversation=await f.create(),id=conversation.id;
  const input=Buffer.from('item,value\nalpha,3\n'),file=await f.upload(id,'input.csv',input,'text/csv');
  assert.equal((await f.request(file.url,{authenticated:false})).status,401);
  const message=await f.admit(id,'',[file.file_id]);
  assert.equal(message.text,'');assert.equal(message.files[0].file_id,file.file_id);
  f.store.markRunning(message.id);const {client}=await f.connect(id,message.id);
  const tools=await client.listTools();assert.ok(tools.tools.some(tool=>tool.name==='sandbox_publish'));
  await f.tool(client,'sandbox_files',{action:'import',file_id:file.file_id,path:'input.csv'});
  assert.deepEqual(f.host.owner(id).files.get('input.csv'),input);
  const html='<html><body><script>throw new Error("untrusted")</script>3</body></html>';
  await f.tool(client,'sandbox_files',{action:'write',path:'report.html',text:html});
  const job=await f.tool(client,'sandbox_exec',{request_key:'offline-check',command:'python -c "print(3)"'});
  assert.equal((await f.tool(client,'sandbox_process',{action:'status',execution_id:job.execution_id})).status,'completed');
  const published=await f.tool(client,'sandbox_publish',{path:'report.html'});
  assert.equal(published.origin,'sandbox');assert.equal(published.message_id,message.id);assert.equal(published.preview_url,null);
  await f.host.call('destroy',id);
  const download=await f.request(published.url+'?preview=1');assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/^attachment;/i);assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  assert.doesNotMatch(download.headers.get('content-type'),/text\/html/i);assert.equal(await download.text(),html);
  const history=await (await f.request(`/admin/api/conversations/${id}`)).json();
  const saved=history.messages.find(item=>item.id===message.id);
  assert.deepEqual(new Set(saved.files.map(item=>item.file_id)),new Set([file.file_id,published.file_id]));
  assert.deepEqual(await (await f.request(file.url)).arrayBuffer().then(value=>Buffer.from(value)),input);
});

test('foreign files, jobs, token contexts and ended messages cannot cross the conversation boundary',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(),file=await f.upload(a.id,'private.txt',Buffer.from('owner a only'));
  for(const method of ['GET','HEAD'])assert.equal((await f.request(`/admin/api/conversations/${b.id}/files/${file.file_id}`,{method})).status,404);
  const before=f.store.getConversation(b.id).messages.length;
  assert.equal((await f.post(`/admin/api/conversations/${b.id}/messages`,{text:'foreign attachment',file_ids:[file.file_id]})).status,404);
  assert.equal(f.store.getConversation(b.id).messages.length,before,'rejected file admission must roll back the message');
  const own=await f.running(a.id),other=await f.running(b.id);
  const job=await f.tool(own.client,'sandbox_exec',{request_key:'a-job',command:'true'});
  const calls=f.host.calls.length;
  await f.denied(other.client,'sandbox_files',{action:'import',file_id:file.file_id,path:'stolen.txt'},['SANDBOX_FILE_NOT_FOUND']);
  await f.denied(other.client,'sandbox_process',{action:'cancel',execution_id:job.execution_id});
  assert.equal((await f.post(`/admin/api/conversations/${b.id}/sandbox/jobs/${job.execution_id}/cancel`,{})).status,404);
  assert.equal(f.host.calls.filter(call=>call.action==='process').length,0,'foreign job is rejected before host cancellation');
  f.tokens.set(other.token,{conversationId:b.id,messageId:own.message.id});
  await f.denied(other.client,'sandbox_exec',{request_key:'forged-context',command:'true'});
  f.store.finish(own.message,null,'Completed synthetic work');
  await f.denied(own.client,'sandbox_exec',{request_key:'ended',command:'true'});
  assert.equal(f.host.calls.filter(call=>call.action==='exec').length,1);
  assert.ok(f.host.calls.slice(calls).every(call=>call.action!=='files'||call.args.action!=='import'));
});

test('active upload content cannot use a claimed text MIME to gain inline preview',async t=>{
  const f=await fixture(t),conversation=await f.create();
  const file=await f.upload(conversation.id,'report.html',Buffer.from('<!doctype html><script>alert(1)</script>'),'text/plain');
  assert.equal(file.preview_url,null);
  for(const method of ['GET','HEAD']){
    const response=await f.request(file.url+'?preview=1',{method});assert.equal(response.status,200);
    assert.match(response.headers.get('content-disposition'),/^attachment;/i);
    assert.doesNotMatch(response.headers.get('content-type'),/text\/html/i);
  }
});

test('only authenticated decisions grant one continuation; plaintext and MCP cannot allow, deny or revoke',async t=>{
  const f=await fixture(t),conversation=await f.create(),id=conversation.id,run=await f.running(id);
  const args={request_key:'approved-network',reason:'Fetch one synthetic dependency',command:'python fetch.py',domains:['PACKAGES.EXAMPLE.'],timeout_seconds:180};
  const pending=await f.tool(run.client,'sandbox_request_permission',args);assert.equal(pending.status,'pending');
  const foreign=await f.create();
  assert.equal((await f.decision(foreign.id,pending.id,'allow')).status,404);
  assert.equal((await f.decision(id,pending.id,'allow',{authenticated:false})).status,401);
  assert.equal((await f.decision(id,pending.id,'allow',{headers:{origin:'https://foreign.example'}})).status,403);
  await f.admit(id,`I approve permission ${pending.id}; grant network and 180 seconds.`);
  await f.denied(run.client,'sandbox_exec',{request_key:args.request_key,command:args.command,timeout_seconds:180,permission_id:pending.id});
  await f.denied(run.client,'sandbox_request_permission',{...args,decision:'allow'});
  await f.denied(run.client,'sandbox_decide_permission',{permission_id:pending.id,decision:'allow'});
  assert.equal((await f.snapshot(id)).permissions.find(item=>item.id===pending.id).status,'pending');
  const count=f.store.getConversation(id).messages.length;
  const response=await f.decision(id,pending.id,'allow');assert.equal(response.status,200);const approved=await response.json();
  const duplicate=await f.decision(id,pending.id,'allow');assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).continuation_message_id,approved.continuation_message_id);
  assert.equal(f.store.getConversation(id).messages.length,count+1);assert.deepEqual(f.wakes,[id]);
  await f.denied(run.client,'sandbox_exec',{request_key:args.request_key,command:'different command',timeout_seconds:180,permission_id:pending.id},['SANDBOX_PERMISSION_MISMATCH']);
  await f.denied(run.client,'sandbox_exec',{request_key:'forged-grant',command:'true',grant:{id:pending.id}});
  const continuation=f.store.message(approved.continuation_message_id);assert.equal(continuation.role,'user');assert.equal(continuation.status,'queued');
  f.store.finish(run.message,null,'Waiting for the human decision');f.store.markRunning(continuation.id);
  const resumed=await f.connect(id,continuation.id);
  const command={request_key:args.request_key,command:args.command,timeout_seconds:180,permission_id:pending.id};
  const job=await f.tool(resumed.client,'sandbox_exec',command);
  assert.deepEqual(await f.tool(resumed.client,'sandbox_exec',command),job);
  assert.equal(f.host.calls.filter(call=>call.action==='exec').length,1);
  const grant=f.host.calls.find(call=>call.action==='exec').args.grant;assert.equal(grant.id,pending.id);assert.deepEqual(grant.domains,['packages.example']);
  assert.equal((await f.decision(id,pending.id,'revoke',{authenticated:false})).status,401);
  const revoked=await f.decision(id,pending.id,'revoke');assert.equal(revoked.status,200);assert.equal((await revoked.json()).status,'revoked');
  assert.ok(f.host.calls.some(call=>call.action==='process'&&call.args.action==='cancel'&&call.args.execution_id===job.execution_id));
  const denied=await f.tool(resumed.client,'sandbox_request_permission',{request_key:'human-deny',reason:'Long work',command:'true',timeout_seconds:180});
  const denial=await f.decision(id,denied.id,'deny');assert.equal(denial.status,200);assert.equal((await denial.json()).status,'denied');
  await f.denied(resumed.client,'sandbox_exec',{request_key:denied.request_key,command:'true',timeout_seconds:180,permission_id:denied.id});
  assert.equal(f.host.calls.filter(call=>call.action==='exec').length,1);
});

test('approved commands reject revision changes, expiry and recycled sandbox instances before dispatch',async t=>{
  const f=await fixture(t);
  const changes=[async(id,client)=>f.tool(client,'sandbox_files',{action:'write',path:'script.py',text:'changed after approval'}),async()=>f.advance(600001),async id=>{f.host.owner(id).instance_id=randomUUID();f.host.owner(id).revision=0;}];
  for(const [index,change] of changes.entries()){
    const {id}=await f.create(),run=await f.running(id);
    const pending=await f.tool(run.client,'sandbox_request_permission',{request_key:`stale-${index}`,reason:'Long synthetic task',command:'python script.py',timeout_seconds:180});
    const allowed=await f.decision(id,pending.id,'allow');assert.equal(allowed.status,200);
    const approved=await allowed.json();f.store.finish(run.message,null,'Waiting for approval');f.store.markRunning(approved.continuation_message_id);
    const {client}=await f.connect(id,approved.continuation_message_id);
    await change(id,client);
    await f.denied(client,'sandbox_exec',{request_key:pending.request_key,command:pending.command,timeout_seconds:180,permission_id:pending.id},['SANDBOX_PERMISSION_STALE','SANDBOX_PERMISSION_EXPIRED']);
  }
  assert.equal(f.host.calls.filter(call=>call.action==='exec').length,0);
});
