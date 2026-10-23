import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';

export class ManagerStore {
  constructor(path) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manager_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,thread_id TEXT,source_id TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,error TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_actions(id TEXT PRIMARY KEY,conversation_id TEXT,name TEXT NOT NULL,target TEXT,status TEXT NOT NULL,summary TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_observations(key TEXT PRIMARY KEY,value TEXT NOT NULL,observed_at INTEGER NOT NULL);
    `);
  }
  close(){this.db.close();}
  observe(key,value){this.db.prepare('INSERT OR REPLACE INTO manager_observations VALUES(?,?,?)').run(key,JSON.stringify(value),Date.now());}
  observation(key){const row=this.db.prepare('SELECT value,observed_at FROM manager_observations WHERE key=?').get(key);return row?{...JSON.parse(row.value),observed_at:row.observed_at}:null;}
  createConversation(title='新会话',sourceId=null) {
    if (sourceId) {const old=this.db.prepare('SELECT * FROM manager_conversations WHERE source_id=?').get(sourceId);if(old)return this.getConversation(old.id);}
    const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO manager_conversations VALUES(?,?,NULL,?,?,?)').run(id,String(title).slice(0,100),sourceId,now,now);
    return this.getConversation(id);
  }
  getConversation(id) {
    const row=this.db.prepare('SELECT * FROM manager_conversations WHERE id=?').get(id);
    if(!row)throw new HttpError(404,'CONVERSATION_NOT_FOUND','找不到管理会话。');
    return {...row,messages:this.db.prepare('SELECT * FROM manager_messages WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(message=>({...message,error:message.error?JSON.parse(message.error):null})),actions:this.actions(id)};
  }
  list(){return this.db.prepare('SELECT * FROM manager_conversations ORDER BY updated_at DESC').all();}
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
  enqueue(id,text) {
    this.getConversation(id);
    if(typeof text!=='string'||!text.trim())throw new HttpError(400,'INVALID_MESSAGE','消息不能为空。');
    const message={id:randomUUID(),conversation_id:id,text,status:'queued'};
    this.db.prepare("INSERT INTO manager_messages VALUES(?,?,'user',?,'queued',NULL,NULL,?)").run(message.id,id,text,Date.now());
    this.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),id);
    return message;
  }
  next(id) {return this.db.prepare("SELECT * FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','interrupted') ORDER BY created_at,rowid LIMIT 1").get(id);}
  markRunning(id){this.db.prepare("UPDATE manager_messages SET status='running' WHERE id=?").run(id);}
  thread(conversationId,threadId){this.db.prepare('UPDATE manager_conversations SET thread_id=? WHERE id=?').run(threadId,conversationId);}
  turn(messageId,turnId){this.db.prepare('UPDATE manager_messages SET turn_id=? WHERE id=?').run(turnId,messageId);}
  interrupted(id){this.db.prepare("UPDATE manager_messages SET status='interrupted' WHERE id=? AND status='running'").run(id);}
  finish(message,error,text) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE manager_messages SET status=?,error=? WHERE id=?').run(error?'failed':'completed',error?JSON.stringify(error):null,message.id);
      this.db.prepare("INSERT INTO manager_messages VALUES(?,?,'assistant',?,'completed',NULL,?,?)").run(randomUUID(),message.conversation_id,text || (error?error.message:'本轮已结束，请查看操作记录。'),error?JSON.stringify(error):null,Date.now());
      this.db.prepare('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),message.conversation_id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  recover() {
    this.db.exec("UPDATE manager_messages SET status='interrupted' WHERE status='running';UPDATE manager_actions SET status='unknown' WHERE status='executing'");
    return this.db.prepare("SELECT DISTINCT conversation_id FROM manager_messages WHERE role='user' AND status IN ('queued','interrupted')").all();
  }
  beginAction(conversationId,name,args={}) {
    const id=randomUUID(),now=Date.now(),target=args.task_id ?? args.type ?? args.id ?? args.definition?.type;
    this.db.prepare("INSERT INTO manager_actions VALUES(?,?,?,?,'executing',NULL,NULL,?,?)").run(id,conversationId,name,typeof target==='string'?target:null,now,now);return id;
  }
  finishAction(id,value,error) {
    const summary=value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>['task_id','retry_of','type','id','status','enabled','accepted','paused','concurrency'].includes(key))):null;
    this.db.prepare('UPDATE manager_actions SET status=?,summary=?,error=?,updated_at=? WHERE id=?').run(error?(error.effectUnknown?'unknown':'failed'):'completed',summary?JSON.stringify(summary):null,error?JSON.stringify({code:error.code ?? 'OPERATION_FAILED',message:error.message}):null,Date.now(),id);
  }
  actions(id){return this.db.prepare('SELECT * FROM manager_actions WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(row=>({...row,summary:row.summary?JSON.parse(row.summary):null,error:row.error?JSON.parse(row.error):null}));}
}
