import {createHash, randomUUID} from 'node:crypto';
import {HttpError} from '../errors.mjs';
import {notificationProviders, validateNotificationTarget, notificationFormat, notificationRequest, notificationOutcome} from './providers.mjs';

const MAX_CHANNELS=32, MAX_BODY=131072, MAX_BATCH=524288, MAX_RESPONSE=65536;
const terminal=new Set(['accepted','rejected','unavailable','unknown']);
let savepointSequence=0;
const fail=(status,code)=>{throw new HttpError(status,code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=4096)=>typeof value==='string'&&value.length<=max&&!/[\u0000]/.test(value);
const own=(value,key)=>Object.hasOwn(value,key);
function ownerIdentity(owner) {
  if(!object(owner)||!['task','inspection','schedule','plugin','test'].includes(owner.kind)||!text(owner.id,512)||!owner.id.trim())fail(400,'INVALID_NOTIFICATION_OWNER');
  return [owner.kind,owner.id];
}
function transaction(db,fn) {
  const point=`notification_${++savepointSequence}`;db.exec(`SAVEPOINT ${point}`);
  try {const result=fn();db.exec(`RELEASE ${point}`);return result;}
  catch(error){db.exec(`ROLLBACK TO ${point};RELEASE ${point}`);throw error;}
}
function json(value,max) {
  const visit=(item,depth=0)=>{
    if(depth>40)fail(400,'INVALID_NOTIFICATION_BODY');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'&&Number.isFinite(item))return;
    if(Array.isArray(item)){for(const part of item)visit(part,depth+1);return;}
    if(object(item)&&[Object.prototype,null].includes(Object.getPrototypeOf(item))){for(const part of Object.values(item))visit(part,depth+1);return;}
    fail(400,'INVALID_NOTIFICATION_BODY');
  };
  let serialized;try {visit(value);serialized=JSON.stringify(value);}catch(error){if(error instanceof HttpError)throw error;fail(400,'INVALID_NOTIFICATION_BODY');}
  if(Buffer.byteLength(serialized)>max)fail(400,'NOTIFICATION_BODY_TOO_LARGE');
  return serialized;
}
function sample(provider) {
  const value='Synthetic notification test';
  if(provider==='feishu')return {msg_type:'text',content:{text:value}};
  if(provider==='wecom'||provider==='dingtalk')return {msgtype:'text',text:{content:value}};
  if(provider==='discord')return {content:value};
  return {text:value};
}
function aggregate(statuses) {
  if(statuses.includes('sending'))return 'sending';
  if(statuses.includes('pending'))return 'pending';
  const unique=new Set(statuses);return unique.size===1?statuses[0]:'partial';
}

/** Gateway-owned durable notifications; private channel records never leave this module. */
export class NotificationStore {
  constructor({db,fetchImpl=globalThis.fetch,now=Date.now}) {
    this.db=db;this.fetchImpl=fetchImpl;this.now=now;this.active=new Map();
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,
        description TEXT NOT NULL,instructions TEXT NOT NULL,enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL,url TEXT NOT NULL,token TEXT NOT NULL,headers TEXT NOT NULL,
        signing_secret TEXT NOT NULL,timeout_ms INTEGER NOT NULL,deleted_at INTEGER,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_bindings (
        owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,channels TEXT NOT NULL,
        revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_kind,owner_id)
      );
      CREATE TABLE IF NOT EXISTS notification_batches (
        id TEXT PRIMARY KEY,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,
        notification_key TEXT NOT NULL,digest TEXT NOT NULL,created_at INTEGER NOT NULL,
        run_id TEXT,operation_id TEXT,UNIQUE(owner_kind,owner_id,notification_key)
      );
      CREATE INDEX IF NOT EXISTS notification_owner_history ON notification_batches(owner_kind,owner_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS notification_test_history ON notification_batches(owner_kind,created_at,id);
      CREATE TABLE IF NOT EXISTS notification_attempts (
        batch_id TEXT NOT NULL,position INTEGER NOT NULL,channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,provider TEXT NOT NULL,channel_revision INTEGER,
        status TEXT NOT NULL,body TEXT NOT NULL,http_status INTEGER,provider_code TEXT,
        summary TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(batch_id,channel_id)
      );
    `);
    // A process stopped after reservation may already have reached the recipient.
    db.prepare("UPDATE notification_attempts SET status='unknown',summary='Notification outcome unknown after restart',updated_at=? WHERE status='sending'").run(this.now());
  }
  #private(id) {return this.db.prepare('SELECT * FROM notification_channels WHERE id=?').get(id);}
  #require(id) {if(!text(id,128))fail(400,'INVALID_NOTIFICATION_CHANNEL');const channel=this.#private(id);if(!channel)fail(404,'NOTIFICATION_CHANNEL_NOT_FOUND');return channel;}
  #redactor(extra=[]) {
    const values=new Set();
    for(const row of [...this.db.prepare('SELECT provider,url,token,headers,signing_secret FROM notification_channels').all(),...extra]) {
      for(const value of [row.url,row.token,row.signing_secret??row.signingSecret,...Object.values(typeof row.headers==='string'?JSON.parse(row.headers):row.headers??{})])if(value)values.add(String(value));
      if(row.url)try {const url=new URL(row.url);values.add(url.href);for(const value of url.searchParams.values())if(value)values.add(value);for(const part of url.pathname.split('/'))if(part.length>=8){values.add(part);values.add(decodeURIComponent(part));}}catch{}
    }
    const ordered=[...values].sort((a,b)=>b.length-a.length);
    const pattern=ordered.length?new RegExp('\\[redacted\\]|'+ordered.map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g'):null;
    const scrub=value=>{
      if(typeof value==='string')return pattern?value.replace(pattern,'[redacted]'):value;
      if(Array.isArray(value))return value.map(scrub);
      if(object(value))return Object.fromEntries(Object.entries(value).map(([key,part])=>[scrub(key),scrub(part)]));
      return value;
    };
    return scrub;
  }
  #metadata(row,scrub=this.#redactor()) {
    return {id:row.id,name:scrub(row.name),provider:row.provider,description:scrub(row.description),instructions:scrub(row.instructions),enabled:!!row.enabled&&row.deleted_at===null,revision:row.revision,timeoutMs:row.timeout_ms,
      configured:{url:!!row.url,token:!!row.token,headers:Object.keys(JSON.parse(row.headers)).length>0,signingSecret:!!row.signing_secret},format:notificationFormat(row.provider),...(row.deleted_at!==null?{deleted:true}:{})};
  }
  listChannels() {const scrub=this.#redactor();return this.db.prepare('SELECT * FROM notification_channels WHERE deleted_at IS NULL ORDER BY name,id').all().map(row=>this.#metadata(row,scrub));}
  channel(id) {return this.#metadata(this.#require(id));}
  saveChannel(raw,{revision}={}) {
    if(!object(raw)||Object.keys(raw).some(key=>!['id','name','provider','description','instructions','enabled','url','token','headers','signingSecret','timeoutMs'].includes(key)))fail(400,'INVALID_NOTIFICATION_CHANNEL');
    return transaction(this.db,()=>{
      const old=raw.id===undefined?null:this.#require(raw.id);
      if(old?.deleted_at!==null&&old)fail(409,'NOTIFICATION_CHANNEL_DELETED');
      if(old&&revision!==old.revision)fail(409,'NOTIFICATION_CHANNEL_REVISION_CONFLICT');
      if(old&&raw.provider!==undefined&&raw.provider!==old.provider)fail(400,'NOTIFICATION_PROVIDER_IMMUTABLE');
      const value={name:old?.name,provider:old?.provider,description:old?.description??'',instructions:old?.instructions??'',enabled:old?!!old.enabled:true,url:old?.url,token:old?.token??'',headers:old?JSON.parse(old.headers):{},signingSecret:old?.signing_secret??'',timeoutMs:old?.timeout_ms??10000,...raw};
      if(!text(value.name,200)||!value.name.trim()||!notificationProviders.includes(value.provider)||!text(value.description,8192)||!text(value.instructions,16384)||typeof value.enabled!=='boolean'||!text(value.url,8192)||!value.url||!text(value.token,8192)||!text(value.signingSecret,8192)||!Number.isInteger(value.timeoutMs)||value.timeoutMs<100||value.timeoutMs>120000)fail(400,'INVALID_NOTIFICATION_CHANNEL');
      if(value.headers===''||value.headers===null)value.headers={};
      if(!object(value.headers)||Object.keys(value.headers).length>32||Object.entries(value.headers).some(([key,part])=>!text(key,128)||!text(part,8192)))fail(400,'INVALID_NOTIFICATION_CHANNEL');
      validateNotificationTarget(value.provider,value.url);notificationRequest(value,sample(value.provider),{now:this.now()});
      const scrub=this.#redactor([value]);value.name=scrub(value.name.trim());value.description=scrub(value.description);value.instructions=scrub(value.instructions);
      const collision=this.db.prepare('SELECT id FROM notification_channels WHERE name=?').get(value.name);if(collision&&collision.id!==old?.id)fail(409,'NOTIFICATION_CHANNEL_NAME_RESERVED');
      const id=old?.id??randomUUID(),timestamp=this.now(),nextRevision=(old?.revision??0)+1;
      if(old)this.db.prepare('UPDATE notification_channels SET name=?,description=?,instructions=?,enabled=?,revision=?,url=?,token=?,headers=?,signing_secret=?,timeout_ms=?,updated_at=? WHERE id=?').run(value.name,value.description,value.instructions,+value.enabled,nextRevision,value.url,value.token,JSON.stringify(value.headers),value.signingSecret,value.timeoutMs,timestamp,id);
      else this.db.prepare('INSERT INTO notification_channels(id,name,provider,description,instructions,enabled,revision,url,token,headers,signing_secret,timeout_ms,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)').run(id,value.name,value.provider,value.description,value.instructions,+value.enabled,nextRevision,value.url,value.token,JSON.stringify(value.headers),value.signingSecret,value.timeoutMs,timestamp,timestamp);
      return this.channel(id);
    });
  }
  setChannelEnabled(id,enabled,{revision}={}) {return this.saveChannel({id,enabled},{revision});}
  deleteChannel(id,{revision}={}) {
    return transaction(this.db,()=>{const row=this.#require(id);if(row.deleted_at!==null)return {id,deleted:true};if(row.revision!==revision)fail(409,'NOTIFICATION_CHANNEL_REVISION_CONFLICT');this.db.prepare('UPDATE notification_channels SET deleted_at=?,enabled=0,revision=revision+1,updated_at=? WHERE id=?').run(this.now(),this.now(),id);return {id,deleted:true};});
  }
  #binding(owner) {const [kind,id]=ownerIdentity(owner);return this.db.prepare('SELECT * FROM notification_bindings WHERE owner_kind=? AND owner_id=?').get(kind,id);}
  getBinding(owner) {
    const row=this.#binding(owner),ids=row?JSON.parse(row.channels):[];
    return {notification_channels:ids,notification_revision:row?.revision??0,channels:ids.map(id=>{
      const channel=this.#private(id);return channel?this.#metadata(channel):{id,name:'Unavailable channel',provider:'custom',description:'',instructions:'',enabled:false,revision:0,configured:{url:false,token:false,headers:false,signingSecret:false},format:notificationFormat('custom'),deleted:true};
    })};
  }
  setBinding(owner,ids,{revision,allowUnavailable=false}={}) {
    const [kind,id]=ownerIdentity(owner);
    if(!Array.isArray(ids)||ids.length>MAX_CHANNELS||ids.some(channel=>!text(channel,128)||!channel)||new Set(ids).size!==ids.length)fail(400,'INVALID_NOTIFICATION_BINDING');
    return transaction(this.db,()=>{
      const old=this.#binding(owner);if(revision!==undefined&&revision!==(old?.revision??0))fail(409,'NOTIFICATION_BINDING_REVISION_CONFLICT');const existing=new Set(old?JSON.parse(old.channels):[]);
      for(const channelId of ids){const channel=this.#private(channelId);if(!allowUnavailable&&!existing.has(channelId)&&(!channel||!channel.enabled||channel.deleted_at!==null))fail(400,'NOTIFICATION_CHANNEL_UNAVAILABLE');}
      this.db.prepare('INSERT INTO notification_bindings(owner_kind,owner_id,channels,revision,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(owner_kind,owner_id) DO UPDATE SET channels=excluded.channels,revision=revision+1,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(ids),this.now());return this.getBinding(owner);
    });
  }
  context(owner,options={}) {return {...this.getBinding(owner),history:this.history(owner,options)};}
  #batch(id) {
    const row=this.db.prepare('SELECT * FROM notification_batches WHERE id=?').get(id),scrub=this.#redactor();
    const deliveries=this.db.prepare('SELECT * FROM notification_attempts WHERE batch_id=? ORDER BY position').all(id).map(attempt=>({channel_id:attempt.channel_id,channel_name:scrub(attempt.channel_name),provider:attempt.provider,status:attempt.status,http_status:attempt.http_status,provider_code:attempt.provider_code===null?null:scrub(JSON.parse(attempt.provider_code)),summary:scrub(attempt.summary),body:scrub(JSON.parse(attempt.body)),created_at:attempt.created_at,updated_at:attempt.updated_at}));
    return {batch_id:row.id,notification_key:scrub(row.notification_key),status:aggregate(deliveries.map(item=>item.status)),created_at:row.created_at,deliveries};
  }
  async send(owner,input,{validate,runId,operationId}={}) {
    const [kind,id]=ownerIdentity(owner);if(kind==='schedule')fail(403,'NOTIFICATION_OWNER_CANNOT_SEND');
    if(validate!==undefined&&typeof validate!=='function')fail(400,'INVALID_NOTIFICATION_VALIDATOR');validate?.();
    if(!object(input)||Object.keys(input).some(key=>!['notification_key','deliveries'].includes(key))||!text(input.notification_key,256)||!input.notification_key.trim()||!Array.isArray(input.deliveries)||!input.deliveries.length||input.deliveries.length>MAX_CHANNELS)fail(400,'INVALID_NOTIFICATION_BATCH');
    const seen=new Set();
    for(const delivery of input.deliveries){if(!object(delivery)||Object.keys(delivery).some(key=>!['channel_id','body'].includes(key))||!text(delivery.channel_id,128)||!delivery.channel_id||!object(delivery.body)||seen.has(delivery.channel_id))fail(400,'INVALID_NOTIFICATION_DELIVERY');seen.add(delivery.channel_id);json(delivery.body,MAX_BODY);}
    const serialized=json(input.deliveries,MAX_BATCH),digest=createHash('sha256').update(serialized).digest('hex'),deliveries=JSON.parse(serialized),key=input.notification_key;
    let batch=this.db.prepare('SELECT * FROM notification_batches WHERE owner_kind=? AND owner_id=? AND notification_key=?').get(kind,id,key);
    if(batch&&batch.digest!==digest)fail(409,'NOTIFICATION_KEY_CONFLICT');
    // Recorded terminal results remain readable after channel bindings/configuration change.
    if(batch&&!this.db.prepare("SELECT 1 FROM notification_attempts WHERE batch_id=? AND status='pending'").get(batch.id))return this.active.has(batch.id)?await this.active.get(batch.id):this.#batch(batch.id);
    const pending=batch?new Set(this.db.prepare("SELECT channel_id FROM notification_attempts WHERE batch_id=? AND status='pending'").all(batch.id).map(row=>row.channel_id)):seen;
    const bound=new Set(this.getBinding(owner).notification_channels);
    for(const delivery of deliveries)if(pending.has(delivery.channel_id)&&!bound.has(delivery.channel_id))fail(403,'NOTIFICATION_CHANNEL_NOT_BOUND');
    // Validate every body before reserving or sending any target. Unavailable channels
    // still receive a recorded per-target result rather than aborting other targets.
    for(const delivery of deliveries){const channel=this.#private(delivery.channel_id);if(pending.has(delivery.channel_id)&&channel)notificationRequest(this.#transport(channel),delivery.body,{now:this.now()});}
    if(!batch)batch=transaction(this.db,()=>{
      const existing=this.db.prepare('SELECT * FROM notification_batches WHERE owner_kind=? AND owner_id=? AND notification_key=?').get(kind,id,key);
      if(existing){if(existing.digest!==digest)fail(409,'NOTIFICATION_KEY_CONFLICT');return existing;}
      const batchId=randomUUID(),timestamp=this.now(),scrub=this.#redactor();
      this.db.prepare('INSERT INTO notification_batches(id,owner_kind,owner_id,notification_key,digest,created_at,run_id,operation_id) VALUES(?,?,?,?,?,?,?,?)').run(batchId,kind,id,key,digest,timestamp,text(runId,512)?runId:null,text(operationId,512)?operationId:null);
      for(const [position,delivery] of deliveries.entries()){const channel=this.#private(delivery.channel_id);this.db.prepare('INSERT INTO notification_attempts(batch_id,position,channel_id,channel_name,provider,channel_revision,status,body,http_status,provider_code,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,\'pending\',?,NULL,NULL,\'\',?,?)').run(batchId,position,delivery.channel_id,scrub(channel?.name??'Unavailable channel'),channel?.provider??'custom',channel?.revision??null,JSON.stringify(scrub(delivery.body)),timestamp,timestamp);}
      return this.db.prepare('SELECT * FROM notification_batches WHERE id=?').get(batchId);
    });
    if(this.active.has(batch.id))return await this.active.get(batch.id);
    // Start on a microtask so the active guard exists even for synchronous failures.
    const work=Promise.resolve().then(()=>this.#execute(owner,batch.id,deliveries,validate));this.active.set(batch.id,work);
    try{return await work;}finally{if(this.active.get(batch.id)===work)this.active.delete(batch.id);}
  }
  #transport(channel) {return {provider:channel.provider,url:channel.url,token:channel.token,headers:JSON.parse(channel.headers),signingSecret:channel.signing_secret,timeoutMs:channel.timeout_ms};}
  #finish(batchId,channelId,status,{http_status=null,provider_code=null,summary=''}={},transport) {
    const scrub=this.#redactor(transport?[transport]:[]);this.db.prepare('UPDATE notification_attempts SET status=?,http_status=?,provider_code=?,summary=?,updated_at=? WHERE batch_id=? AND channel_id=?').run(status,http_status,provider_code===null?null:JSON.stringify(scrub(provider_code)),scrub(String(summary)).slice(0,2048),this.now(),batchId,channelId);
  }
  async #execute(owner,batchId,deliveries,validate) {
    for(const delivery of deliveries) {
      const attempt=this.db.prepare('SELECT status FROM notification_attempts WHERE batch_id=? AND channel_id=?').get(batchId,delivery.channel_id);if(!attempt||terminal.has(attempt.status)||attempt.status==='sending')continue;
      validate?.();const bound=this.getBinding(owner).notification_channels,channel=this.#private(delivery.channel_id);
      if(!bound.includes(delivery.channel_id)||!channel||!channel.enabled||channel.deleted_at!==null){this.#finish(batchId,delivery.channel_id,'unavailable',{summary:'Notification channel is no longer available or bound'});continue;}
      const transport=this.#transport(channel);
      let request;try{request=notificationRequest(transport,delivery.body,{now:this.now()});}catch{this.#finish(batchId,delivery.channel_id,'unavailable',{summary:'Notification channel configuration is unavailable'});continue;}
      const reserved=this.db.prepare("UPDATE notification_attempts SET status='sending',channel_revision=?,updated_at=? WHERE batch_id=? AND channel_id=? AND status='pending'").run(channel.revision,this.now(),batchId,delivery.channel_id);if(!reserved.changes)continue;
      const controller=new AbortController();let timer;
      try {
        const response=await Promise.race([(async()=>{
          const response=await this.fetchImpl(request.url,{...request.options,redirect:'manual',signal:controller.signal});
          const responseText=await this.#response(response);return {response,responseText};
        })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},channel.timeout_ms);})]);
        const responseText=channel.provider==='custom'?this.#redactor([transport])(response.responseText):response.responseText;
        const outcome=notificationOutcome(channel.provider,response.response.status,responseText);
        this.#finish(batchId,delivery.channel_id,outcome.status,{http_status:response.response.status,provider_code:outcome.provider_code,summary:outcome.summary},transport);
      }catch{this.#finish(batchId,delivery.channel_id,'unknown',{summary:controller.signal.aborted?'Notification request timed out; outcome unknown':'Notification transport outcome unknown'},transport);}
      finally{clearTimeout(timer);controller.abort();}
    }
    return this.#batch(batchId);
  }
  async #response(response) {
    const length=Number(response.headers?.get?.('content-length'));if(Number.isFinite(length)&&length>MAX_RESPONSE){await response.body?.cancel?.();throw new Error('response too large');}
    if(!response.body?.getReader){const value=await response.text();if(Buffer.byteLength(value)>MAX_RESPONSE)throw new Error('response too large');return value;}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE){await reader.cancel();throw new Error('response too large');}chunks.push(value);}return Buffer.concat(chunks).toString('utf8');}finally{reader.releaseLock();}
  }
  history(owner,{limit=30,before}={}) {
    const [kind,id]=ownerIdentity(owner);if(!Number.isInteger(limit)||limit<1||limit>100)fail(400,'INVALID_NOTIFICATION_HISTORY');let cursor;
    if(before!==undefined&&before!==null){try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{fail(400,'INVALID_NOTIFICATION_CURSOR');}if(!object(cursor)||cursor.kind!==kind||cursor.owner!==id||!Number.isSafeInteger(cursor.time)||!text(cursor.id,128))fail(400,'INVALID_NOTIFICATION_CURSOR');}
    const rows=cursor?this.db.prepare('SELECT id,created_at FROM notification_batches WHERE owner_kind=? AND owner_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?').all(kind,id,cursor.time,cursor.time,cursor.id,limit+1):this.db.prepare('SELECT id,created_at FROM notification_batches WHERE owner_kind=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(kind,id,limit+1);
    const page=rows.slice(0,limit),last=page.at(-1);return {items:page.map(row=>this.#batch(row.id)),next_cursor:rows.length>limit?Buffer.from(JSON.stringify({kind,owner:id,time:last.created_at,id:last.id})).toString('base64url'):null};
  }
  hasActive(owner) {const [kind,id]=ownerIdentity(owner);for(const batchId of this.active.keys()){const batch=this.db.prepare('SELECT owner_kind,owner_id FROM notification_batches WHERE id=?').get(batchId);if(batch?.owner_kind===kind&&batch.owner_id===id)return true;}return false;}
  purgeOwner(owner) {
    const [kind,id]=ownerIdentity(owner);return transaction(this.db,()=>{if(this.hasActive(owner))fail(409,'NOTIFICATION_SEND_ACTIVE');this.db.prepare('DELETE FROM notification_attempts WHERE batch_id IN (SELECT id FROM notification_batches WHERE owner_kind=? AND owner_id=?)').run(kind,id);this.db.prepare('DELETE FROM notification_batches WHERE owner_kind=? AND owner_id=?').run(kind,id);this.db.prepare('DELETE FROM notification_bindings WHERE owner_kind=? AND owner_id=?').run(kind,id);});
  }
  pruneTestHistory({cutoff,limit=50}={}) {
    if(!Number.isSafeInteger(cutoff)||cutoff<0||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'INVALID_NOTIFICATION_RETENTION');
    return transaction(this.db,()=>{
      const candidates=this.db.prepare("SELECT id,owner_id FROM notification_batches WHERE owner_kind='test' AND created_at<? ORDER BY created_at,id LIMIT ?").all(cutoff,limit);let deleted=0;
      for(const batch of candidates) {
        if(this.hasActive({kind:'test',id:batch.owner_id}))continue;
        this.db.prepare('DELETE FROM notification_attempts WHERE batch_id=?').run(batch.id);
        deleted+=this.db.prepare("DELETE FROM notification_batches WHERE id=? AND owner_kind='test' AND created_at<?").run(batch.id,cutoff).changes;
        this.db.prepare("DELETE FROM notification_bindings WHERE owner_kind='test' AND owner_id=? AND NOT EXISTS(SELECT 1 FROM notification_batches WHERE owner_kind='test' AND owner_id=?)").run(batch.owner_id,batch.owner_id);
      }
      return {deleted};
    });
  }
  async testChannel(id) {
    const channel=this.#require(id);if(!channel.enabled||channel.deleted_at!==null)fail(400,'NOTIFICATION_CHANNEL_UNAVAILABLE');const owner={kind:'test',id:randomUUID()};this.setBinding(owner,[id]);return await this.send(owner,{notification_key:'synthetic-channel-test',deliveries:[{channel_id:id,body:sample(channel.provider)}]});
  }
}
