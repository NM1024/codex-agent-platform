import {randomUUID,createHash} from 'node:crypto';
import {join,basename,extname,isAbsolute,posix} from 'node:path';
import {mkdir,lstat,open,unlink,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {domainToASCII} from 'node:url';
import {isIP} from 'node:net';
import Ajv from 'ajv';
import {HttpError} from '../errors.mjs';
import {readRegular,containedPath} from '../files.mjs';
import {withImageWork} from './image-work.mjs';
import {SandboxHostClient} from '../sandbox/client.mjs';
import {sandboxTools} from '../sandbox/contracts.mjs';
const MAX_FILE=20*1024*1024,STORAGE_LIMIT=256*1024*1024,TTL=600000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=(code,message=code,status=409)=>new HttpError(status,code,message);
const validators=new Map(sandboxTools.map(tool=>[tool.name,new Ajv({strict:false}).compile(tool.inputSchema)]));
const fileRow=row=>({file_id:row.id,name:row.name,mime:row.mime,size:row.size,url:`/admin/api/conversations/${row.conversation_id}/files/${row.id}`,preview_url:row.preview?`/admin/api/conversations/${row.conversation_id}/files/${row.id}?preview=1`:null,origin:row.origin,message_id:row.message_id??null});
const summaryJob=job=>{
  const result={...job};
  for(const stream of ['stdout','stderr']){
    const text=typeof job[stream]==='string'?job[stream]:'';
    let prefix='',size=0;
    for(const point of text){const bytes=Buffer.byteLength(point);if(size+bytes>2048)break;prefix+=point;size+=bytes;}
    result[stream]=prefix;
    result[stream+'_truncated']=Boolean(job[stream+'_truncated'])||prefix.length<text.length;
  }
  return result;
};
const permissionRow=row=>row?{...JSON.parse(row.payload),status:row.status,execution_id:row.execution_id??undefined,continuation_message_id:row.continuation_message_id??undefined}:null;
function relativePath(path){if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.split('/').includes('..')||path.length>4096)throw error('SANDBOX_INVALID_PATH','Use a relative sandbox workspace path.',400);return posix.normalize(path);}
function domainsOf(domains=[]){return [...new Set(domains.map(value=>{const raw=value.toLowerCase().replace(/\.$/,''),domain=domainToASCII(raw);if(!domain||domain.length>253||isIP(domain)||!domain.includes('.')||domain.split('.').some(label=>!/^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(label))||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(domain)||/^\d+(?:\.\d+)*$/.test(domain))throw error('SANDBOX_INVALID_DOMAIN','Specify canonical public DNS domains only.',400);return domain;}))].sort();}
function normalized(args){return {request_key:args.request_key,command:args.command,cwd:args.cwd?relativePath(args.cwd):'.',timeout_seconds:args.timeout_seconds??60,memory_mb:args.memory_mb??1024};}
function sameCommand(permission,command){return ['request_key','command','cwd','timeout_seconds','memory_mb'].every(key=>permission[key]===command[key]);}
async function contentInfo(name,bytes){
  const ext=extname(name).toLowerCase();
  if(bytes.length>=8&&(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(0,3).equals(Buffer.from([255,216,255]))||bytes.subarray(0,4).toString()==='RIFF')){
    try{return await withImageWork(async sharp=>{const metadata=await sharp(bytes,{limitInputPixels:16777216}).metadata();if(!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height)throw new Error();await sharp(bytes,{limitInputPixels:16777216}).stats();return {mime:'image/'+metadata.format,preview:true};});}catch{return {mime:'application/octet-stream',preview:false};}
  }
  if(['.txt','.csv','.tsv','.json','.jsonl','.ndjson','.log','.md','.markdown','.py','.js','.mjs','.cjs','.ts','.tsx','.jsx','.yaml','.yml','.toml','.ini','.cfg','.conf','.sh','.bash','.sql','.xml','.css','.scss','.less','.r','.rb','.go','.rs','.java','.c','.h','.cpp','.hpp','.cs','.swift','.kt'].includes(ext)&&!bytes.includes(0)){
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);return {mime:['.md','.markdown'].includes(ext)?'text/markdown; charset=utf-8':'text/plain; charset=utf-8',preview:true};}catch{}
  }
  return {mime:'application/octet-stream',preview:false};
}
export class ManagerSandbox {
  constructor({store,root,client=new SandboxHostClient(),wake=()=>{},now=Date.now}){
    if(!isAbsolute(root))throw new Error('Sandbox attachment root must be absolute.');
    Object.assign(this,{store,root:join(root,'sandbox-attachments'),client,wake,now});this.locks=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS manager_sandbox_files(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,preview INTEGER NOT NULL,origin TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,digest TEXT NOT NULL,deleting INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS manager_sandbox_files_owner ON manager_sandbox_files(conversation_id);
      CREATE TABLE IF NOT EXISTS manager_sandbox_message_files(message_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(message_id,file_id));
      CREATE TABLE IF NOT EXISTS manager_sandbox_permissions(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,request_key TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,execution_id TEXT,continuation_message_id TEXT,UNIQUE(conversation_id,request_key));
      CREATE TABLE IF NOT EXISTS manager_sandbox_operations(conversation_id TEXT NOT NULL,request_key TEXT NOT NULL,message_id TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,request_key));
      CREATE TABLE IF NOT EXISTS manager_sandbox_cleanup(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0);`);
    if(!this.sql('PRAGMA table_info(manager_sandbox_files)').all().some(column=>column.name==='deleting'))store.db.exec('ALTER TABLE manager_sandbox_files ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0');
  }
  sql(text){return this.store.db.prepare(text);}
  notify(id,messageId){this.store.changed?.(id,messageId);}
  async locked(id,run){const previous=this.locks.get(id)??Promise.resolve();let release;const gate=new Promise(resolve=>release=resolve);this.locks.set(id,gate);await previous;try{return await run();}finally{release();if(this.locks.get(id)===gate)this.locks.delete(id);}}
  scope({conversationId,messageId}={}){this.store.metadata(conversationId);const message=this.sql("SELECT * FROM manager_messages WHERE id=? AND conversation_id=? AND role='user' AND status='running'").get(messageId,conversationId);if(!message||this.sql("SELECT id FROM manager_messages WHERE conversation_id=? AND role='user' AND status='running' ORDER BY rowid LIMIT 1").get(conversationId)?.id!==messageId)throw error('SANDBOX_SCOPE_INVALID','Sandbox tools require the current running message.',403);return message;}
  validateFiles(conversationId,fileIds){this.store.metadata(conversationId);if(!Array.isArray(fileIds)||fileIds.length>5||new Set(fileIds).size!==fileIds.length)throw error('SANDBOX_INVALID_FILES','Select at most five distinct uploaded files.',400);let total=0;const rows=fileIds.map(id=>{const row=this.sql('SELECT * FROM manager_sandbox_files WHERE id=? AND conversation_id=? AND deleting=0').get(id,conversationId);if(!row)throw error('SANDBOX_FILE_NOT_FOUND','Attachment not found.',404);if(row.origin!=='upload')throw error('SANDBOX_UPLOAD_REQUIRED','Only original uploads can attach to a user message.',400);total+=row.size;return row;});if(total>100*1024*1024)throw error('SANDBOX_FILES_TOO_LARGE','Message attachments exceed 100 MiB.',413);return rows.map(fileRow);}
  attach(conversationId,messageId,fileIds){const message=this.sql("SELECT id FROM manager_messages WHERE id=? AND conversation_id=? AND role='user'").get(messageId,conversationId);if(!message)throw error('SANDBOX_SCOPE_INVALID','Message does not belong to this conversation.',403);this.validateFiles(conversationId,fileIds);for(const id of fileIds)this.sql('INSERT OR IGNORE INTO manager_sandbox_message_files VALUES(?,?)').run(messageId,id);}
  filesForMessage(messageId){return this.sql(`SELECT f.*,? AS message_id FROM manager_sandbox_files f WHERE f.message_id=? OR EXISTS(SELECT 1 FROM manager_sandbox_message_files m WHERE m.message_id=? AND m.file_id=f.id) ORDER BY f.created_at,f.rowid LIMIT 100`).all(messageId,messageId,messageId).map(fileRow);}
  async directory(conversationId){const directory=join(this.root,conversationId);for(const path of [this.root,directory]){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw error('SANDBOX_STORAGE_UNSAFE');}return directory;}
  async save(conversationId,{name,bytes,origin,messageId=null}){
    this.store.metadata(conversationId);if(!Buffer.isBuffer(bytes)||bytes.length>MAX_FILE)throw error('SANDBOX_FILE_TOO_LARGE','Attachment exceeds 20 MiB.',413);
    const display=basename(String(name??'attachment').replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,255)||'attachment';
    const info=await contentInfo(display,bytes),directory=await this.directory(conversationId),id=randomUUID(),path=join(directory,id);
    this.store.metadata(conversationId);const total=this.sql('SELECT COALESCE(sum(size),0) AS size,count(*) AS count FROM manager_sandbox_files WHERE conversation_id=?').get(conversationId);if(total.size+bytes.length>STORAGE_LIMIT||total.count>=100)throw error('SANDBOX_STORAGE_FULL','Conversation attachment storage is full.',413);
    const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    try{this.store.metadata(conversationId);if(messageId&&!this.sql("SELECT id FROM manager_messages WHERE id=? AND conversation_id=? AND status='running'").get(messageId,conversationId))throw error('SANDBOX_SCOPE_INVALID');this.sql('INSERT INTO manager_sandbox_files(id,conversation_id,name,mime,size,preview,origin,message_id,created_at,digest) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,conversationId,display,info.mime,bytes.length,Number(info.preview),origin,messageId,this.now(),hash(bytes));}catch(e){await unlink(path).catch(()=>{});throw e;}
    this.notify(conversationId,messageId);return fileRow(this.sql('SELECT * FROM manager_sandbox_files WHERE id=?').get(id));
  }
  upload(conversationId,input){return this.locked(conversationId,()=>this.save(conversationId,{...input,origin:'upload'}));}
  async readFile(conversationId,fileId){this.store.metadata(conversationId);const row=this.sql('SELECT * FROM manager_sandbox_files WHERE conversation_id=? AND id=? AND deleting=0').get(conversationId,fileId);if(!row)throw error('SANDBOX_FILE_NOT_FOUND','Attachment not found.',404);try{const bytes=await readRegular(this.root,join(this.root,conversationId,row.id),MAX_FILE,{allowEmpty:true});if(bytes.length!==row.size||hash(bytes)!==row.digest)throw new Error();return {metadata:fileRow(row),bytes};}catch{throw error('SANDBOX_FILE_UNAVAILABLE','Attachment bytes are unavailable.',404);}}
  permission(id,conversationId){return permissionRow(this.sql('SELECT * FROM manager_sandbox_permissions WHERE id=? AND conversation_id=?').get(id,conversationId));}
  expire(conversationId,context){for(const row of this.sql("SELECT * FROM manager_sandbox_permissions WHERE conversation_id=? AND status IN ('pending','approved')").all(conversationId)){const p=permissionRow(row);if(p.expires_at<=this.now()||(context?.available&&(p.instance_id!==context.instance_id||p.revision!==context.revision)))this.sql("UPDATE manager_sandbox_permissions SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(p.id);}}
  context(conversationId){return this.locked(conversationId,()=>this.snapshot(conversationId));}
  async snapshot(conversationId){this.store.metadata(conversationId);let context;try{context=await this.client.call('context',conversationId);}catch{context={available:false,exists:false,network_supported:false,reason:'The local code sandbox is unavailable.',executions:[]};}this.store.metadata(conversationId);this.expire(conversationId,context);const stored=this.sql('SELECT * FROM manager_sandbox_operations WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 16').all(conversationId);const jobs=new Map((context.executions??[]).map(job=>[job.request_key,job]));const executions=stored.map(row=>{const old=JSON.parse(row.result),received=jobs.get(row.request_key),current=received&&['completed','failed','cancelled'].includes(old.status)&&received.status==='running'?null:received,result={...old,...(current??{}),message_id:row.message_id};for(const stream of ['stdout','stderr'])if(current?.[stream+'_truncated']&&typeof old[stream]==='string'&&typeof current[stream]==='string'&&old[stream].startsWith(current[stream])&&old[stream].length>current[stream].length)result[stream]=old[stream];if(current)this.sql('UPDATE manager_sandbox_operations SET result=? WHERE conversation_id=? AND request_key=?').run(JSON.stringify(result),conversationId,row.request_key);return result;});return {...context,files:this.sql('SELECT * FROM manager_sandbox_files WHERE conversation_id=? AND deleting=0 ORDER BY created_at DESC,rowid DESC LIMIT 100').all(conversationId).map(fileRow),permissions:this.sql('SELECT * FROM manager_sandbox_permissions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100').all(conversationId).map(permissionRow),executions:executions.map(summaryJob)};}
  async execute(toolName,args,context){const validator=validators.get(toolName);if(!validator||!validator(args))throw error('SANDBOX_INVALID_ARGUMENTS','Invalid sandbox tool arguments.',400);return this.locked(context?.conversationId,async()=>{this.scope(context);const id=context.conversationId;
    if(toolName==='sandbox_files')return this.files(args,context);
    if(toolName==='sandbox_exec')return this.exec(args,context);
    if(toolName==='sandbox_request_permission')return this.requestPermission(args,context);
    if(toolName==='sandbox_process')return this.process(id,args,context);
    const output=await this.client.call('export',id,{path:relativePath(args.path)});this.scope(context);if(typeof output.content_base64!=='string'||output.content_base64.length>Math.ceil(MAX_FILE/3)*4||!Number.isSafeInteger(output.size)||output.size<0||output.size>MAX_FILE)throw error('SANDBOX_INVALID_EXPORT');const bytes=Buffer.from(output.content_base64,'base64');if(bytes.length!==output.size||bytes.toString('base64')!==output.content_base64)throw error('SANDBOX_INVALID_EXPORT');return this.save(id,{name:output.name??basename(args.path),bytes,origin:'sandbox',messageId:context.messageId});
  });}
  async files(args,context){const id=context.conversationId;if(args.action==='info')return this.client.call('context',id);const path=args.path?relativePath(args.path):undefined;if(!['list'].includes(args.action)&&!path)throw error('SANDBOX_INVALID_PATH','A workspace path is required.',400);
    if(args.action==='import'){
      if(!args.file_id)throw error('SANDBOX_FILE_NOT_FOUND');
      const row=this.sql('SELECT * FROM manager_sandbox_files WHERE id=?').get(args.file_id);
      let bytes;
      if(row){
        const attached=row.message_id||this.sql('SELECT 1 FROM manager_sandbox_message_files WHERE file_id=? LIMIT 1').get(row.id);
        if(row.conversation_id!==id||row.deleting||!attached)throw error('SANDBOX_FILE_NOT_FOUND','Only attached files from this conversation can be imported.',404);
        ({bytes}=await this.readFile(id,args.file_id));
      }else{
        // The established image picker stores its native inputs separately.
        // Its owner-checked lookup also covers generated conversation images.
        let image;
        try{image=this.store.getImage(id,args.file_id);}catch(e){if(e.code!=='IMAGE_NOT_FOUND')throw e;throw error('SANDBOX_FILE_NOT_FOUND','Only attached files from this conversation can be imported.',404);}
        bytes=Buffer.from(image.bytes);
        if(bytes.length>MAX_FILE)throw error('SANDBOX_FILE_TOO_LARGE','Attachment exceeds 20 MiB.',413);
        if(!bytes.length||bytes.length!==image.size)throw error('SANDBOX_FILE_UNAVAILABLE','Attachment bytes are unavailable.',404);
      }
      this.scope(context);
      return this.client.call('files',id,{action:'import',path,content_base64:bytes.toString('base64')});
    }
    if(args.action==='patch'){if(typeof args.text!=='string'||!args.expected_hash)throw error('SANDBOX_PATCH_CONFLICT','Patch needs replacement text and the expected SHA-256 hash.',400);const current=await this.client.call('files',id,{action:'read',path,offset:0,limit:65536});if(typeof current.text!=='string'||hash(current.text)!==args.expected_hash||current.truncated||(current.size??Buffer.byteLength(current.text))>65536)throw error('SANDBOX_PATCH_CONFLICT','File changed or is too large for atomic patch.');this.scope(context);return this.client.call('files',id,{action:'write',path,text:args.text,expected_revision:current.revision});}
    if(args.action==='write'&&(typeof args.text!=='string'||Buffer.byteLength(args.text)>256*1024))throw error('SANDBOX_FILE_TOO_LARGE','Text writes are limited to 256 KiB.',413);
    return this.client.call('files',id,{action:args.action,...(path?{path}:{}),...(args.text!==undefined?{text:args.text}:{}),...(args.offset!==undefined?{offset:args.offset}:{}),...(args.limit!==undefined?{limit:args.limit}:{})});
  }
  async requestPermission(args,context){const id=context.conversationId,command=normalized(args),domains=domainsOf(args.domains);let host=await this.client.call('context',id);this.scope(context);if(host.executions?.some(job=>job.status==='running'))throw error('SANDBOX_BUSY','Wait for the current command to finish before requesting workspace-bound approval.');if(!host.available||domains.length&&!host.network_supported||command.timeout_seconds>(host.limits?.max_timeout_seconds??120)||command.memory_mb>(host.limits?.max_memory_mb??1024)||(!domains.length&&command.timeout_seconds<=(host.limits?.timeout_seconds??120)&&command.memory_mb<=(host.limits?.memory_mb??1024)))throw error('SANDBOX_PERMISSION_UNSUPPORTED','This request is unnecessary or unsupported by this installation.',400);
    if(!host.exists){await this.client.call('files',id,{action:'ensure'});host=await this.client.call('context',id);this.scope(context);}if(!host.instance_id)throw error('SANDBOX_UNAVAILABLE','Sandbox instance unavailable.',503);
    const old=this.sql('SELECT * FROM manager_sandbox_permissions WHERE conversation_id=? AND request_key=?').get(id,args.request_key);if(old){const p=permissionRow(old);if(!sameCommand(p,command)||JSON.stringify(p.domains)!==JSON.stringify(domains)||p.message_id!==context.messageId)throw error('SANDBOX_REQUEST_KEY_CONFLICT');this.expire(id,host);return this.permission(p.id,id);}
    if(this.sql('SELECT count(*) AS count FROM manager_sandbox_permissions WHERE conversation_id=?').get(id).count>=100)throw error('SANDBOX_PERMISSION_LIMIT');
    const now=this.now(),p={id:randomUUID(),message_id:context.messageId,...command,status:'pending',reason:args.reason,domains,instance_id:host.instance_id,revision:host.revision,created_at:now,expires_at:now+TTL};this.sql('INSERT INTO manager_sandbox_permissions(id,conversation_id,message_id,request_key,status,payload) VALUES(?,?,?,?,?,?)').run(p.id,id,p.message_id,p.request_key,p.status,JSON.stringify(p));this.notify(id,p.message_id);return p;
  }
  async exec(args,context){const id=context.conversationId,command=normalized(args),signature=hash(JSON.stringify({...command,permission_id:args.permission_id??null}));const old=this.sql('SELECT * FROM manager_sandbox_operations WHERE conversation_id=? AND request_key=?').get(id,args.request_key);if(old){if(old.signature!==signature)throw error('SANDBOX_REQUEST_KEY_CONFLICT');return JSON.parse(old.result);}
    let permission;if(args.permission_id){permission=this.permission(args.permission_id,id);if(!permission||!sameCommand(permission,command)||permission.continuation_message_id!==context.messageId)throw error('SANDBOX_PERMISSION_MISMATCH');if(permission.expires_at<=this.now()){this.expire(id);throw error('SANDBOX_PERMISSION_EXPIRED');}if(permission.status!=='approved')throw error('SANDBOX_PERMISSION_REQUIRED');const host=await this.client.call('context',id);this.scope(context);if(permission.expires_at<=this.now()){this.expire(id);throw error('SANDBOX_PERMISSION_EXPIRED');}if(!host.available||permission.instance_id!==host.instance_id||permission.revision!==host.revision){this.expire(id,host);throw error('SANDBOX_PERMISSION_STALE');}}
    else if(command.timeout_seconds>120||command.memory_mb>1024)throw error('SANDBOX_PERMISSION_REQUIRED','Extra resources require an exact human approval.',403);
    if(this.sql('SELECT count(*) AS count FROM manager_sandbox_operations WHERE conversation_id=?').get(id).count>=1000)throw error('SANDBOX_OPERATION_LIMIT','Sandbox operation history is full; start a new conversation.');
    this.scope(context);const unknown={request_key:args.request_key,message_id:context.messageId,status:'unknown',stdout:'',stderr:'',exit_code:null,reason:'Execution admission or result is not yet confirmed.',created_at:this.now(),timeout_seconds:command.timeout_seconds,memory_mb:command.memory_mb};
    this.store.db.exec('SAVEPOINT sandbox_exec_admission');try{if(permission){const consumed=this.sql("UPDATE manager_sandbox_permissions SET status='consumed' WHERE id=? AND status='approved'").run(permission.id);if(!consumed.changes)throw error('SANDBOX_PERMISSION_REQUIRED');}this.sql('INSERT INTO manager_sandbox_operations VALUES(?,?,?,?,?,?)').run(id,args.request_key,context.messageId,signature,JSON.stringify(unknown),this.now());this.store.db.exec('RELEASE sandbox_exec_admission');}catch(e){this.store.db.exec('ROLLBACK TO sandbox_exec_admission; RELEASE sandbox_exec_admission');throw e;}
    this.trimOperations(id);this.notify(id,context.messageId);try{const result={...await this.client.call('exec',id,{...command,...(permission?{grant:{id:permission.id,...command,domains:permission.domains,instance_id:permission.instance_id,revision:permission.revision,expires_at:permission.expires_at}}:{})}),message_id:context.messageId};this.sql('UPDATE manager_sandbox_operations SET result=? WHERE conversation_id=? AND request_key=?').run(JSON.stringify(result),id,args.request_key);if(permission&&result.execution_id)this.sql('UPDATE manager_sandbox_permissions SET execution_id=? WHERE id=?').run(result.execution_id,permission.id);this.notify(id,context.messageId);return result;}catch(e){this.notify(id,context.messageId);throw e;}
  }
  trimOperations(conversationId){
    this.sql("UPDATE manager_sandbox_operations SET result=json_set(result,'$.stdout','','$.stderr','','$.output_omitted',json('true')) WHERE conversation_id=? AND request_key NOT IN (SELECT request_key FROM manager_sandbox_operations WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 16)").run(conversationId,conversationId);
  }
  isPermissionContinuation(messageId){return Boolean(this.sql("SELECT 1 FROM manager_sandbox_permissions WHERE continuation_message_id=? AND status IN ('approved','consumed') LIMIT 1").get(messageId));}
  async decide(conversationId,permissionId,decision){if(!['allow','deny','revoke'].includes(decision))throw error('SANDBOX_INVALID_DECISION','Invalid human decision.',400);return this.locked(conversationId,async()=>{this.store.metadata(conversationId);let p=this.permission(permissionId,conversationId);if(!p)throw error('SANDBOX_PERMISSION_NOT_FOUND','Permission not found.',404);
    if(decision==='deny'){if(p.status==='pending'){this.sql("UPDATE manager_sandbox_permissions SET status='denied' WHERE id=? AND status='pending'").run(p.id);this.notify(conversationId,p.message_id);}return this.permission(p.id,conversationId);}
    if(decision==='revoke'){this.sql("UPDATE manager_sandbox_permissions SET status='revoked' WHERE id=?").run(p.id);this.notify(conversationId,p.message_id);const row=this.sql('SELECT result FROM manager_sandbox_operations WHERE conversation_id=? AND request_key=?').get(conversationId,p.request_key),job=row?JSON.parse(row.result):null;if(job&&['running','unknown'].includes(job.status)){if(job.execution_id)await this.process(conversationId,{action:'cancel',execution_id:job.execution_id});else{await this.client.call('destroy',conversationId);this.sql('UPDATE manager_sandbox_operations SET result=? WHERE conversation_id=? AND request_key=?').run(JSON.stringify({...job,status:'cancelled',reason:'Sandbox destroyed after an unconfirmed execution.'}),conversationId,p.request_key);}}return this.permission(p.id,conversationId);}
    if(['approved','consumed'].includes(p.status))return p;if(p.status!=='pending')throw error('SANDBOX_PERMISSION_EXPIRED');const host=await this.client.call('context',conversationId);this.store.metadata(conversationId);if(p.expires_at<=this.now()){this.expire(conversationId);throw error('SANDBOX_PERMISSION_EXPIRED');}if(p.instance_id!==host.instance_id||p.revision!==host.revision){this.expire(conversationId,host);throw error('SANDBOX_PERMISSION_STALE');}if(p.domains.length&&!host.network_supported||p.timeout_seconds>(host.limits?.max_timeout_seconds??120)||p.memory_mb>(host.limits?.max_memory_mb??1024))throw error('SANDBOX_PERMISSION_UNSUPPORTED');
    const approved={...p,status:'approved',expires_at:this.now()+TTL};this.store.db.exec('SAVEPOINT sandbox_permission_decision');try{const changed=this.sql("UPDATE manager_sandbox_permissions SET status='approved',payload=? WHERE id=? AND status='pending'").run(JSON.stringify(approved),p.id);if(changed.changes){const message=this.store.enqueue(conversationId,`Human approved sandbox permission ${p.id} for request_key ${p.request_key}. Continue only its exact approved command using sandbox_exec with permission_id ${p.id}; do not replay unrelated work. ${p.command.length<19000?"Command: "+p.command:"The exact command is in the original permission request; SHA-256: "+hash(p.command)}`);this.sql('UPDATE manager_sandbox_permissions SET continuation_message_id=? WHERE id=?').run(message.id,p.id);}this.store.db.exec('RELEASE sandbox_permission_decision');}catch(e){this.store.db.exec('ROLLBACK TO sandbox_permission_decision; RELEASE sandbox_permission_decision');throw e;}this.wake(conversationId);this.notify(conversationId,p.message_id);return this.permission(p.id,conversationId);
  });}
  async process(conversationId,args,context){let executionId=args.execution_id;const rows=this.sql('SELECT * FROM manager_sandbox_operations WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 16').all(conversationId);if(executionId&&!rows.some(row=>JSON.parse(row.result).execution_id===executionId))throw error('SANDBOX_EXECUTION_NOT_FOUND','Execution not found.',404);if(!executionId)executionId=rows.map(row=>JSON.parse(row.result)).find(job=>job.execution_id)?.execution_id;const result=await this.client.call('process',conversationId,{action:args.action,...(executionId?{execution_id:executionId}:{})});if(context)this.scope(context);const row=rows.find(row=>JSON.parse(row.result).execution_id===result.execution_id);if(row){const job={...JSON.parse(row.result),...result,message_id:row.message_id};this.sql('UPDATE manager_sandbox_operations SET result=? WHERE conversation_id=? AND request_key=?').run(JSON.stringify(job),conversationId,row.request_key);this.notify(conversationId,row.message_id);return job;}return result;}
  cancel(conversationId,executionId){this.store.metadata(conversationId);return this.locked(conversationId,()=>this.process(conversationId,{action:'cancel',execution_id:executionId}));}
  async cancelMessage(messageId,{expirePermissions=true}={}){const message=this.sql('SELECT conversation_id FROM manager_messages WHERE id=?').get(messageId);if(!message)return;return this.locked(message.conversation_id,async()=>{if(expirePermissions)this.sql("UPDATE manager_sandbox_permissions SET status='expired' WHERE message_id=? AND status IN ('pending','approved')").run(messageId);const rows=this.sql('SELECT * FROM manager_sandbox_operations WHERE conversation_id=? AND message_id=?').all(message.conversation_id,messageId);for(const row of rows){const job=JSON.parse(row.result);if(job.status==='running'&&job.execution_id)await this.process(message.conversation_id,{action:'cancel',execution_id:job.execution_id});else if(job.status==='unknown')await this.client.call('destroy',message.conversation_id);}this.notify(message.conversation_id,messageId);});}
  queueCleanup(metadata){const id=metadata?.id;if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw error('SANDBOX_SCOPE_INVALID');this.sql('INSERT OR IGNORE INTO manager_sandbox_cleanup(id,created_at) VALUES(?,?)').run(id,this.now());this.sql("UPDATE manager_sandbox_permissions SET status='expired' WHERE conversation_id=? AND status IN ('pending','approved')").run(id);}
  async cleanupLocalFiles(conversationId){
    const path=join(this.root,conversationId);
    try{await containedPath(this.root,path);await rm(path,{recursive:true,force:true});}catch(e){if(e.code!=='ENOENT')throw e;}
    this.store.db.exec('SAVEPOINT sandbox_cleanup');
    try{
      this.sql('DELETE FROM manager_sandbox_message_files WHERE file_id IN (SELECT id FROM manager_sandbox_files WHERE conversation_id=?)').run(conversationId);
      for(const table of ['files','permissions','operations'])this.sql(`DELETE FROM manager_sandbox_${table} WHERE conversation_id=?`).run(conversationId);
      this.store.db.exec('RELEASE sandbox_cleanup');
    }catch(e){this.store.db.exec('ROLLBACK TO sandbox_cleanup; RELEASE sandbox_cleanup');throw e;}
  }
  async cleanup({limit=50,conversationId}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw error('SANDBOX_INVALID_LIMIT');
    if(conversationId!==undefined&&(typeof conversationId!=='string'||!/^[0-9a-f-]{36}$/.test(conversationId)))throw error('SANDBOX_SCOPE_INVALID');
    let cleaned=0,failed=0;
    const rows=this.sql(`SELECT * FROM manager_sandbox_cleanup ${conversationId?'WHERE id=?':''} ORDER BY attempted_at,created_at LIMIT ?`).all(...(conversationId?[conversationId]:[]),limit);
    for(const row of rows){
      if(this.sql('SELECT id FROM manager_conversations WHERE id=?').get(row.id))continue;
      // Stable private attachments do not depend on the optional host helper.
      // Attempt each side independently and retain the durable job until both
      // have completed; destroy and missing local directories are idempotent.
      let localDone=false,hostDone=false;
      try{await this.cleanupLocalFiles(row.id);localDone=true;}catch{}
      try{await this.client.call('destroy',row.id);hostDone=true;}catch{}
      if(localDone&&hostDone){this.sql('DELETE FROM manager_sandbox_cleanup WHERE id=?').run(row.id);cleaned++;}
      else{this.sql('UPDATE manager_sandbox_cleanup SET attempted_at=? WHERE id=?').run(this.now(),row.id);failed++;}
    }
    const abandoned=this.sql(`SELECT f.* FROM manager_sandbox_files f WHERE f.origin='upload' AND f.created_at<? AND NOT EXISTS(SELECT 1 FROM manager_sandbox_message_files m WHERE m.file_id=f.id) ${conversationId?'AND f.conversation_id=?':''} LIMIT ?`).all(this.now()-86400000,...(conversationId?[conversationId]:[]),limit);for(const file of abandoned){
      // Claim synchronously before any filesystem await. Message admission uses
      // the same SQLite owner and cannot attach a file once deletion is claimed.
      const claimed=this.sql('UPDATE manager_sandbox_files SET deleting=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM manager_sandbox_message_files m WHERE m.file_id=manager_sandbox_files.id)').run(file.id);
      if(!claimed.changes)continue;
      try{try{const path=await containedPath(this.root,join(this.root,file.conversation_id,file.id));await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}this.sql('DELETE FROM manager_sandbox_files WHERE id=? AND deleting=1').run(file.id);}catch{}
    }
    return {cleaned,failed,pending:Boolean(this.sql(`SELECT 1 FROM manager_sandbox_cleanup ${conversationId?'WHERE id=?':''} LIMIT 1`).get(...(conversationId?[conversationId]:[])))};}
  async recover(){this.sql("UPDATE manager_sandbox_permissions SET status='expired' WHERE status IN ('pending','approved')").run();this.sql("UPDATE manager_sandbox_operations SET result=json_set(result,'$.status','unknown','$.reason','Sandbox restart; no command was replayed.') WHERE json_extract(result,'$.status')='running'").run();return this.client.recover();}
}
