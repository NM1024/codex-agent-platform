import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import Ajv from 'ajv';
import {agentOverridesSchema} from '../configuration/agent-settings.mjs';
import {publicChatText} from './chat-progress.mjs';
const checkExecution=new Ajv({strict:true}).compile(agentOverridesSchema);
const conversationRow=row=>({...row,execution:JSON.parse(row.execution ?? '{}')});
const messageRow=row=>({...row,execution:row.execution?JSON.parse(row.execution):null});

export class ManagerStore {
  constructor(path) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manager_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,thread_id TEXT,source_id TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,error TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_actions(id TEXT PRIMARY KEY,conversation_id TEXT,name TEXT NOT NULL,target TEXT,status TEXT NOT NULL,summary TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_observations(key TEXT PRIMARY KEY,value TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_chat_images(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_message_activity(message_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(message_id,id));
    `);
    for(const table of ['manager_conversations','manager_messages'])
      if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name==='execution'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN execution TEXT`);
    for(const [table,columns] of [['manager_messages',{reply_to:'TEXT',started_at:'INTEGER',completed_at:'INTEGER',updated_at:'INTEGER'}],['manager_actions',{message_id:'TEXT'}]])
      for(const [name,type] of Object.entries(columns))if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name===name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  close(){this.db.close();}
  observe(key,value){this.db.prepare('INSERT OR REPLACE INTO manager_observations VALUES(?,?,?)').run(key,JSON.stringify(value),Date.now());}
  observation(key){const row=this.db.prepare('SELECT value,observed_at FROM manager_observations WHERE key=?').get(key);return row?{...JSON.parse(row.value),observed_at:row.observed_at}:null;}
  createConversation(title='新会话',sourceId=null) {
    if (sourceId) {const old=this.db.prepare('SELECT * FROM manager_conversations WHERE source_id=?').get(sourceId);if(old)return this.getConversation(old.id);}
    const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO manager_conversations(id,title,thread_id,source_id,created_at,updated_at) VALUES(?,?,NULL,?,?,?)').run(id,String(title).slice(0,100),sourceId,now,now);
    return this.getConversation(id);
  }
  getConversation(id) {
    const row=this.db.prepare('SELECT * FROM manager_conversations WHERE id=?').get(id);
    if(!row)throw new HttpError(404,'CONVERSATION_NOT_FOUND','找不到管理会话。');
    return {...conversationRow(row),messages:this.db.prepare('SELECT * FROM manager_messages WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(message=>({...messageRow(message),error:message.error?JSON.parse(message.error):null,attachments:this.attachments(message.id),activity:this.db.prepare('SELECT id,kind,label,text,status,created_at,updated_at FROM manager_message_activity WHERE message_id=? ORDER BY created_at,rowid').all(message.id)})),actions:this.actions(id)};
  }
  list(){return this.db.prepare("SELECT c.*,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status='queued') AS queued_count,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('running','interrupted')) AS running_count FROM manager_conversations c ORDER BY c.updated_at DESC").all().map(conversationRow);}
  validateExecution(execution){if(!checkExecution(execution))throw new HttpError(400,'INVALID_CONFIGURATION','模型或思考程度配置不正确。');}
  setConversationExecution(id,execution){
    this.validateExecution(execution);this.getConversation(id);
    this.db.prepare('UPDATE manager_conversations SET execution=?,updated_at=? WHERE id=?').run(JSON.stringify(execution),Date.now(),id);
    return this.getConversation(id);
  }
  recordMessageExecution(id,execution){this.db.prepare('UPDATE manager_messages SET execution=? WHERE id=? AND execution IS NULL').run(JSON.stringify(execution),id);}
  investigations(){return this.db.prepare("SELECT c.id,c.source_id,c.updated_at,EXISTS(SELECT 1 FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('queued','running','interrupted')) AS active FROM manager_conversations c WHERE c.source_id LIKE 'task:%' ORDER BY c.updated_at DESC LIMIT 100").all().map(row=>({...row,task_id:row.source_id.slice(5)}));}
  acceptInspection(sourceId,text) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT id FROM manager_conversations WHERE source_id=?').get(sourceId);
      if(old){const conversation=this.getConversation(old.id);this.db.exec('COMMIT');return {created:false,conversation};}
      const conversation=this.createConversation('定时巡检',sourceId),message=this.enqueue(conversation.id,text);
      this.db.exec('COMMIT');return {created:true,conversation,message};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  enqueue(id,text,images=[]) {
    this.getConversation(id);
    if(typeof text!=='string'||text.length>20000||(!text.trim()&&!images.length))throw new HttpError(400,'INVALID_MESSAGE','消息不能为空，文字最多 20000 个字符。');
    const now=Date.now(),message={id:randomUUID(),conversation_id:id,role:'user',text,status:'queued',created_at:now,updated_at:now,started_at:null,completed_at:null,reply_to:null,activity:[],error:null};
    // Images have already passed asynchronous byte/decode validation at admission.
    this.db.exec('SAVEPOINT enqueue_chat_message');
    try {
    this.db.prepare("INSERT INTO manager_messages(id,conversation_id,role,text,status,turn_id,error,created_at) VALUES(?,?,'user',?,'queued',NULL,NULL,?)").run(message.id,id,text,Date.now());
    for(const image of images)this.db.prepare('INSERT INTO manager_chat_images VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),message.id,id,image.name,image.mime,image.width,image.height,image.size,image.bytes);
    this.db.prepare('UPDATE manager_messages SET updated_at=? WHERE id=?').run(Date.now(),message.id);
    this.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),id);
    this.db.exec('RELEASE enqueue_chat_message');
    }catch(error){this.db.exec('ROLLBACK TO enqueue_chat_message; RELEASE enqueue_chat_message');throw error;}
    message.attachments=this.attachments(message.id);
    return message;
  }
  attachments(messageId){return this.db.prepare('SELECT id,name,mime,width,height,size,conversation_id FROM manager_chat_images WHERE message_id=? ORDER BY rowid').all(messageId).map(({conversation_id,...image})=>({...image,url:`/admin/api/conversations/${conversation_id}/images/${image.id}`}));}
  getImage(conversationId,attachmentId){const image=this.db.prepare('SELECT * FROM manager_chat_images WHERE conversation_id=? AND id=?').get(conversationId,attachmentId);if(!image)throw new HttpError(404,'IMAGE_NOT_FOUND','找不到图片。');return image;}
  imageInputs(messageId){return this.db.prepare('SELECT mime,bytes FROM manager_chat_images WHERE message_id=? ORDER BY rowid').all(messageId).map(image=>({type:'image',url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}));}
  next(id) {const row=this.db.prepare("SELECT * FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','interrupted') ORDER BY created_at,rowid LIMIT 1").get(id);return row?messageRow(row):undefined;}
  markRunning(id){const now=Date.now();this.db.prepare("UPDATE manager_messages SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status IN ('queued','interrupted')").run(now,now,id);}
  thread(conversationId,threadId){this.db.prepare('UPDATE manager_conversations SET thread_id=? WHERE id=?').run(threadId,conversationId);}
  syncTitle(conversationId,name){
    if(typeof name!=='string')return;
    const title=name.replace(/\s+/g,' ').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,100);
    if(title)this.db.prepare('UPDATE manager_conversations SET title=?,updated_at=? WHERE id=? AND title<>?').run(title,Date.now(),conversationId,title);
  }
  turn(messageId,turnId){this.db.prepare('UPDATE manager_messages SET turn_id=? WHERE id=?').run(turnId,messageId);}
  interrupted(id){const now=Date.now();this.db.prepare("UPDATE manager_messages SET status='interrupted',updated_at=? WHERE id=? AND status='running'").run(now,id);this.db.prepare("UPDATE manager_message_activity SET status='unknown',updated_at=? WHERE message_id=? AND status='running'").run(now,id);}
  progress(messageId,entry) {
    const message=this.db.prepare('SELECT status FROM manager_messages WHERE id=?').get(messageId);
    if(message?.status!=='running'||!['reasoning_summary','assistant_message','tool','status'].includes(entry.kind)||typeof entry.id!=='string')return;
    const old=this.db.prepare('SELECT text FROM manager_message_activity WHERE message_id=? AND id=?').get(messageId,entry.id);
    const total=this.db.prepare('SELECT count(*) AS count,COALESCE(sum(length(text)),0) AS size FROM manager_message_activity WHERE message_id=?').get(messageId);
    if(!old&&total.count>=100)return;
    const text=publicChatText(entry.text,[],false,Math.min(8192,Math.max(0,65536-total.size+(old?.text.length ?? 0)))),now=Date.now();
    this.db.prepare('INSERT INTO manager_message_activity VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id,id) DO UPDATE SET label=excluded.label,text=excluded.text,status=excluded.status,updated_at=excluded.updated_at').run(messageId,entry.id.slice(0,200),entry.kind,publicChatText(entry.label,[],false,120),text,['running','completed','failed','unknown','interrupted'].includes(entry.status)?entry.status:'unknown',now,now);
    this.db.prepare('UPDATE manager_messages SET updated_at=? WHERE id=?').run(now,messageId);
  }
  finish(message,error,text) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now=Date.now(),changed=this.db.prepare("UPDATE manager_messages SET status=?,error=?,completed_at=?,updated_at=? WHERE id=? AND status IN ('queued','running','interrupted')").run(error?'failed':'completed',error?JSON.stringify(error):null,now,now,message.id);
      if(!changed.changes){this.db.exec('COMMIT');return;}
      this.db.prepare("UPDATE manager_message_activity SET status=?,updated_at=? WHERE message_id=? AND status='running'").run(error?'failed':'completed',now,message.id);
      this.db.prepare("INSERT INTO manager_messages(id,conversation_id,role,text,status,turn_id,error,created_at,reply_to,completed_at,updated_at) VALUES(?,?,'assistant',?,'completed',NULL,?,?,?,?,?)").run(randomUUID(),message.conversation_id,publicChatText(text,[],false,null) || (error?error.message:'本轮已结束，请查看操作记录。'),error?JSON.stringify(error):null,now,message.id,now,now);
      this.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),message.conversation_id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  recover() {
    for(const row of this.db.prepare("SELECT id FROM manager_messages WHERE status='running'").all())this.interrupted(row.id);
    this.db.exec("UPDATE manager_actions SET status='unknown' WHERE status='executing'");
    return this.db.prepare("SELECT DISTINCT conversation_id FROM manager_messages WHERE role='user' AND status IN ('queued','interrupted')").all();
  }
  beginAction(conversationId,name,args={}) {
    const id=randomUUID(),now=Date.now(),target=args.task_id ?? args.type ?? args.id ?? args.definition?.type;
    const active=conversationId?this.db.prepare("SELECT id FROM manager_messages WHERE conversation_id=? AND role='user' AND status='running' ORDER BY created_at,rowid LIMIT 1").get(conversationId):null;
    this.db.prepare("INSERT INTO manager_actions(id,conversation_id,name,target,status,summary,error,created_at,updated_at,message_id) VALUES(?,?,?,?,'executing',NULL,NULL,?,?,?)").run(id,conversationId,name,typeof target==='string'?target:null,now,now,active?.id ?? null);return id;
  }
  finishAction(id,value,error) {
    const summary=value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>['task_id','retry_of','type','id','status','enabled','accepted','paused','concurrency'].includes(key))):null;
    this.db.prepare('UPDATE manager_actions SET status=?,summary=?,error=?,updated_at=? WHERE id=?').run(error?(error.effectUnknown?'unknown':'failed'):'completed',summary?JSON.stringify(summary):null,error?JSON.stringify({code:error.code ?? 'OPERATION_FAILED',message:error.message}):null,Date.now(),id);
  }
  actions(id){return this.db.prepare('SELECT * FROM manager_actions WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(row=>({...row,summary:row.summary?JSON.parse(row.summary):null,error:row.error?JSON.parse(row.error):null}));}
}
