import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createManagerServer} from '../src/manager/server.mjs';
import {createVersionService,createUpgradeClient} from '../src/manager/version.mjs';

const repo='https://github.com/NM1024/codex-agent-platform';
function release(tag='v1.2.3') {
  return {tag_name:tag,draft:false,prerelease:false,published_at:'2026-10-28T12:00:00Z',html_url:`${repo}/releases/tag/${tag}`,
    assets:[`codex-agent-platform-${tag}.tar.gz`,'SHA256SUMS','update.sh'].map(name=>({name,browser_download_url:`${repo}/releases/download/${tag}/${name}`}))};
}
const job={id:'synthetic-job-1',state:'running',phase:'building',started_at:1000,updated_at:2000,target_version:'v1.2.3'};
async function manager(t,extra={}) {
  const server=createManagerServer({store:{},agent:{},operations:{},metrics:{},auth:{authorize:req=>req.headers.cookie==='synthetic-human'},...extra});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function unix(t,handler) {
  const dir=await mkdtemp(join(tmpdir(),'platform-ipc-')),socketPath=join(dir,'updater.sock'),server=createServer(handler);
  await new Promise(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return socketPath;
}
const send=(base,path,options={})=>fetch(base+'/admin/api/'+path,{headers:{cookie:'synthetic-human',...options.headers},...options});

test('running version route uses package metadata without GitHub or host service',async t=>{
  const base=await manager(t),pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
  const response=await send(base,'version');
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{current:pkg.version});
  assert.equal((await fetch(base+'/admin/api/version')).status,401);
});

test('latest stable metadata is validated and requests share a cached check',async()=>{
  let calls=0,now=1000;
  const service=createVersionService({current:'1.0.0',now:()=>now,cacheTtlMs:100,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.github.com/repos/NM1024/codex-agent-platform/releases/latest');assert.equal(options.redirect,'error');
    return new Response(JSON.stringify(release()));
  }});
  const results=await Promise.all([service.latest(),service.latest(),service.latest()]);
  assert.deepEqual(results[0],{current:'1.0.0',latest:'1.2.3',update_available:true,release_url:repo+'/releases/tag/v1.2.3',checked_at:1000});
  assert.equal(calls,1);now=1050;await service.latest();assert.equal(calls,1);now=1101;await service.latest();assert.equal(calls,2);
});

test('latest compares semantic versions numerically and never offers downgrade',async()=>{
  for(const [current,latest,expected] of [['1.9.0','v1.10.0',true],['2.0.0','v1.10.0',false],['1.10.0','v1.10.0',false]]) {
    const service=createVersionService({current,fetchImpl:async()=>new Response(JSON.stringify(release(latest)))});
    assert.equal((await service.latest()).update_available,expected);
  }
});

test('latest rejects draft, prerelease, unpublished, invalid versions and missing or untrusted assets',async()=>{
  const variants=[{draft:true},{prerelease:true},{published_at:null},{published_at:'invalid'},{tag_name:'v2.0.0-beta.1'},{assets:[]},
    {assets:[...release().assets,release().assets[0]]},{assets:release().assets.map(a=>({...a,browser_download_url:'https://example.invalid/asset'}))}];
  for(const changes of variants) {
    const service=createVersionService({fetchImpl:async()=>new Response(JSON.stringify({...release(),...changes}))});
    await assert.rejects(service.latest(),{status:503,code:'VERSION_CHECK_UNAVAILABLE'});
  }
});

test('latest failures are cached briefly and stale success does not hide a failed refresh',async()=>{
  let now=1000,calls=0;
  const service=createVersionService({now:()=>now,cacheTtlMs:100,failureTtlMs:30,fetchImpl:async()=>{
    calls++;return calls===1?new Response(JSON.stringify(release())):new Response('rate limited',{status:403});
  }});
  await service.latest();now=1101;await assert.rejects(service.latest(),{status:503});
  await assert.rejects(service.latest(),{status:503});assert.equal(calls,2);
  now=1132;await assert.rejects(service.latest());assert.equal(calls,3);
});

test('latest enforces response size and timeout while reading metadata',async()=>{
  const large=createVersionService({maxBytes:100,fetchImpl:async()=>new Response('x'.repeat(101))});
  await assert.rejects(large.latest(),{code:'VERSION_CHECK_UNAVAILABLE'});
  const stalled=createVersionService({timeoutMs:30,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  await assert.rejects(stalled.latest(),{code:'VERSION_CHECK_UNAVAILABLE'});
  const neverConnected=createVersionService({timeoutMs:30,fetchImpl:()=>new Promise(()=>{})});
  await assert.rejects(neverConnected.latest(),{code:'VERSION_CHECK_UNAVAILABLE'});
});

test('Unix client uses only fixed host routes and strips unrecognized private fields',async t=>{
  const received=[];
  const socketPath=await unix(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;received.push([req.method,req.url,body]);
    res.writeHead(req.method==='POST'?202:200,{'content-type':'application/json'});
    res.end(JSON.stringify({available:true,job:{...job,logs:'private',secret:'private'},logs:'private'}));
  });
  const client=createUpgradeClient({socketPath});
  assert.deepEqual(await client.status(),{available:true,job});
  assert.deepEqual(await client.start(),{available:true,job});
  assert.deepEqual(received,[['GET','/status',''],['POST','/upgrade','{}']]);
});

test('missing Unix service reports unavailable and cannot start a successful job',async()=>{
  const client=createUpgradeClient({socketPath:'/tmp/nonexistent-synthetic-platform-updater.sock'});
  assert.deepEqual(await client.status(),{available:false,job:null,error_code:'UPDATER_UNAVAILABLE'});
  assert.deepEqual(await client.start(),{available:false,job:null,error_code:'UPDATER_UNAVAILABLE'});
});

test('Unix client rejects malformed, oversized, failed HTTP, unsafe or fake-success responses',async t=>{
  let value={available:true,job};let status=200;
  const socketPath=await unix(t,(req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(typeof value==='string'?value:JSON.stringify(value));});
  const client=createUpgradeClient({socketPath,maxBytes:1024});
  for(const invalid of ['{','x'.repeat(1025),{available:true,job:{...job,state:'invented'}},{available:true,job:{...job,phase:'/private/path'}},
    {available:true,job:{...job,id:'secret\nvalue'}},{available:true,job:{...job,updated_at:-1}},{available:true,job:{...job,error_code:'/private/token'}},
    {available:true,job:{...job,target_version:'https://example.invalid'}},{available:'true',job:null},{available:false,job},{}]) {
    value=invalid;assert.deepEqual(await client.status(),{available:false,job:null,error_code:'UPDATER_INVALID_RESPONSE'});
  }
  value={available:true,job:null};status=202;assert.deepEqual(await client.start(),{available:false,job:null,error_code:'UPDATER_INVALID_RESPONSE'});
  value={available:true,job};status=500;assert.equal((await client.status()).available,false);
});

test('Unix client bounds a connection that never completes',async t=>{
  const socketPath=await unix(t,(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  const client=createUpgradeClient({socketPath,timeoutMs:30});
  assert.deepEqual(await client.status(),{available:false,job:null,error_code:'UPDATER_TIMEOUT'});
});

test('Unix client preserves sanitized host failure codes and interrupted jobs',async t=>{
  const interrupted={...job,state:'interrupted',phase:'interrupted',error_code:'updater_restarted'};
  const socketPath=await unix(t,(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({available:true,job:interrupted}));});
  assert.deepEqual(await createUpgradeClient({socketPath}).status(),{available:true,job:interrupted});
});

test('version/latest and upgrade routes require human auth and origin before host work',async t=>{
  let starts=0,reads=0,checks=0;
  const base=await manager(t,{versionService:{current:'1.0.0',latest:async()=>{checks++;return {current:'1.0.0',latest:'1.2.3'};}},
    upgradeClient:{status:async()=>{reads++;return {available:true,job};},start:async()=>{starts++;return {available:true,job};}}});
  for(const path of ['version/latest','upgrade'])assert.equal((await fetch(base+'/admin/api/'+path)).status,401);
  assert.equal((await fetch(base+'/admin/api/upgrade',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await send(base,'upgrade',{method:'POST',headers:{cookie:'synthetic-human',origin:'https://example.invalid','content-type':'application/json'},body:'{}'})).status,403);
  assert.deepEqual([starts,reads,checks],[0,0,0]);
  assert.equal((await send(base,'version/latest')).status,200);assert.equal((await send(base,'upgrade')).status,200);
  const result=await send(base,'upgrade',{method:'POST',headers:{cookie:'synthetic-human',origin:base,'content-type':'application/json'},body:'{}'});
  assert.equal(result.status,202);assert.deepEqual(await result.json(),{available:true,job});assert.equal(starts,1);
});

test('upgrade rejects all caller options and unavailable host never returns accepted',async t=>{
  let starts=0;
  const base=await manager(t,{upgradeClient:{status:async()=>({available:false,job:null}),start:async()=>{starts++;return {available:false,job:null,error_code:'UPDATER_UNAVAILABLE'};}}});
  for(const body of ['[]','null','""','{"version":"v2.0.0"}','{"command":"id"}','{"path":"/tmp"}','{"url":"https://example.invalid"}']) {
    assert.equal((await send(base,'upgrade',{method:'POST',headers:{cookie:'synthetic-human','content-type':'application/json'},body})).status,400);
  }
  assert.equal((await send(base,'upgrade?version=v2.0.0',{method:'POST',headers:{cookie:'synthetic-human','content-type':'application/json'},body:'{}'})).status,400);
  assert.equal(starts,0);
  const response=await send(base,'upgrade',{method:'POST',headers:{cookie:'synthetic-human','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{available:false,job:null,error_code:'UPDATER_UNAVAILABLE'});
});

test('latest route returns a localized service failure while running version still works',async t=>{
  const service=createVersionService({fetchImpl:async()=>new Response('rate limited',{status:429})});
  const base=await manager(t,{versionService:service});
  const response=await send(base,'version/latest');assert.equal(response.status,503);
  assert.equal((await response.json()).error.code,'VERSION_CHECK_UNAVAILABLE');
  assert.equal((await send(base,'version')).status,200);
});
