import {readFileSync} from 'node:fs';
import {request} from 'node:http';
import {HttpError} from '../errors.mjs';

const runningVersion=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
const repository='https://github.com/NM1024/codex-agent-platform';
const latestApi='https://api.github.com/repos/NM1024/codex-agent-platform/releases/latest';
const stable=/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const versionParts=value=>typeof value==='string'&&value.length<=80?stable.exec(value)?.slice(1).map(BigInt):null;
const unavailable=()=>new HttpError(503,'VERSION_CHECK_UNAVAILABLE','暂时无法检查最新稳定版本，请稍后重试。');

function validateRelease(info,current,checkedAt) {
  const parts=versionParts(info?.tag_name),currentParts=versionParts(current);
  if(!parts||!currentParts||info.draft!==false||info.prerelease!==false||typeof info.published_at!=='string'||!Number.isFinite(Date.parse(info.published_at))||!Array.isArray(info.assets))throw unavailable();
  const tag=info.tag_name;
  for(const name of [`codex-agent-platform-${tag}.tar.gz`,'SHA256SUMS','update.sh']) {
    const assets=info.assets.filter(asset=>asset?.name===name);
    if(assets.length!==1||assets[0].browser_download_url!==`${repository}/releases/download/${tag}/${name}`)throw unavailable();
  }
  let newer=false;
  for(let i=0;i<3;i++){if(parts[i]!==currentParts[i]){newer=parts[i]>currentParts[i];break;}}
  return {current,latest:parts.join('.'),update_available:newer,release_url:`${repository}/releases/tag/${tag}`,checked_at:checkedAt};
}

async function boundedMetadata(fetchImpl,timeoutMs,maxBytes) {
  const controller=new AbortController();let timer,reader;
  const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},timeoutMs);});
  const read=async()=>{
    const response=await fetchImpl(latestApi,{headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'codex-agent-platform-manager'},redirect:'error',signal:controller.signal});
    if(!response.ok||Number(response.headers.get('content-length'))>maxBytes||!response.body)throw unavailable();
    reader=response.body.getReader();const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw unavailable();chunks.push(Buffer.from(value));}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  };
  try{return await Promise.race([read(),deadline]);}
  finally{clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}

// Constructing the service performs no network or host access. Failures never return stale metadata.
export function createVersionService({current=runningVersion,fetchImpl=globalThis.fetch,now=Date.now,cacheTtlMs=300000,failureTtlMs=30000,timeoutMs=8000,maxBytes=2*1024*1024}={}) {
  let cache,inFlight;
  return {current,latest(){
    if(cache&&now()<cache.expiresAt)return cache.error?Promise.reject(unavailable()):Promise.resolve({...cache.value});
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      try {
        const value=validateRelease(await boundedMetadata(fetchImpl,timeoutMs,maxBytes),current,now());
        cache={value,expiresAt:now()+cacheTtlMs};return {...value};
      }catch{cache={error:true,expiresAt:now()+failureTtlMs};throw unavailable();}
      finally{inFlight=null;}
    })();
    return inFlight;
  }};
}

const states=new Set(['queued','running','succeeded','failed','interrupted']);
const phases=new Set(['queued','checking','downloading','building','stopping','backing_up','validating','restarting','verifying','completed','failed','interrupted']);
const errorCode=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const failed=error_code=>({available:false,job:null,error_code});

function publicStatus(value,start) {
  if(!value||typeof value.available!=='boolean'||!(value.job===null||(value.job&&typeof value.job==='object'&&!Array.isArray(value.job))))throw new Error('Invalid updater envelope');
  if(value.error_code!==undefined&&!errorCode(value.error_code))throw new Error('Invalid updater error');
  if(!value.available&&value.job!==null)throw new Error('Unavailable updater with job');
  let job=null;
  if(value.job!==null){
    const source=value.job;
    if(typeof source.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(source.id)||!states.has(source.state)||!phases.has(source.phase)||!timestamp(source.started_at)||!timestamp(source.updated_at)||source.updated_at<source.started_at)throw new Error('Invalid updater job');
    job={id:source.id,state:source.state,phase:source.phase,started_at:source.started_at,updated_at:source.updated_at};
    for(const key of ['target_version','installed_version'])if(source[key]!==undefined){if(!versionParts(source[key]))throw new Error('Invalid updater version');job[key]=source[key];}
    if(source.error_code!==undefined){if(!errorCode(source.error_code))throw new Error('Invalid updater job error');job.error_code=source.error_code;}
  }
  if(start&&value.available&&!job)throw new Error('No admitted job');
  return {available:value.available,job,...(value.error_code?{error_code:value.error_code}:{})};
}

// Only these two fixed HTTP operations cross the optional host boundary; no shell or Docker API.
export function createUpgradeClient({socketPath='/run/platform-updater/updater.sock',timeoutMs=3000,maxBytes=16384}={}) {
  const call=start=>new Promise(resolve=>{
    let done=false,timer;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const req=request({socketPath,path:start?'/upgrade':'/status',method:start?'POST':'GET',headers:{accept:'application/json',...(start?{'content-type':'application/json','content-length':2}:{})}},res=>{
      const expected=start?202:200;
      if(res.statusCode!==expected){res.resume();finish(failed('UPDATER_UNAVAILABLE'));req.destroy();return;}
      if(!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']??'')||Number(res.headers['content-length'])>maxBytes){finish(failed('UPDATER_INVALID_RESPONSE'));req.destroy();return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){finish(failed('UPDATER_INVALID_RESPONSE'));req.destroy();}else chunks.push(chunk);});
      res.on('error',()=>finish(failed('UPDATER_UNAVAILABLE')));
      res.on('end',()=>{
        if(done)return;
        try{finish(publicStatus(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),start));}
        catch{finish(failed('UPDATER_INVALID_RESPONSE'));}
      });
    });
    req.on('error',()=>finish(failed('UPDATER_UNAVAILABLE')));
    timer=setTimeout(()=>{finish(failed('UPDATER_TIMEOUT'));req.destroy();},timeoutMs);
    req.end(start?'{}':undefined);
  });
  return {status:()=>call(false),start:()=>call(true)};
}
