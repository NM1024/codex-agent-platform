import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import Ajv from 'ajv';
import {agentOverridesSchema} from '../configuration/agent-settings.mjs';
import {publicChatText} from './chat-progress.mjs';
import {EventEmitter} from 'node:events';
import {validateAnswers} from './questions.mjs';
const checkExecution=new Ajv({strict:true}).compile(agentOverridesSchema);
const conversationRow=row=>({...row,execution:JSON.parse(row.execution ?? '{}')});
const messageRow=row=>({...row,execution:row.execution?JSON.parse(row.execution):null});
const pageSize=(limit,fallback)=>{const value=limit??fallback;if(!Number.isInteger(value)||value<1||value>100)throw new HttpError(400,'INVALID_PAGINATION','每页数量必须是 1 到 100 的整数。');return value;};
const invalidCursor=()=>new HttpError(400,'INVALID_CURSOR','分页位置无效，请重新打开对话。');
const unfinishedUserStates="'queued','running','interrupted','draft','steering','steer_unknown'";
const busyHistorySql=(conversation=null)=>[
  `EXISTS(SELECT 1 FROM manager_messages m WHERE ${conversation?`m.conversation_id=${conversation} AND `:''}m.role='user' AND m.status IN (${unfinishedUserStates}))`,
  `EXISTS(SELECT 1 FROM manager_questions q JOIN manager_messages m ON m.id=q.message_id WHERE ${conversation?`m.conversation_id=${conversation} AND `:''}q.status='pending')`,
  `EXISTS(SELECT 1 FROM manager_actions a WHERE ${conversation?`a.conversation_id=${conversation} AND `:''}a.status IN ('pending','queued','executing','running'))`,
  ...['manager_message_activity','manager_reply_items'].map(table=>`EXISTS(SELECT 1 FROM ${table} a JOIN manager_messages m ON m.id=a.message_id WHERE ${conversation?`m.conversation_id=${conversation} AND `:''}a.status='running')`),
].join(' OR ');
const retentionCutoff=cutoff=>{if(!Number.isSafeInteger(cutoff))throw new HttpError(400,'INVALID_RETENTION','历史保留截止时间无效。');return cutoff;};

export class ManagerStore {
  constructor(path) {
    this.events=new EventEmitter();this.events.setMaxListeners(0);
    this.statements=new Map();this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manager_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,thread_id TEXT,source_id TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,error TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_actions(id TEXT PRIMARY KEY,conversation_id TEXT,name TEXT NOT NULL,target TEXT,status TEXT NOT NULL,summary TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_observations(key TEXT PRIMARY KEY,value TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_chat_images(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_message_activity(message_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(message_id,id));
      CREATE TABLE IF NOT EXISTS manager_reply_items(message_id TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(message_id,id));
      CREATE TABLE IF NOT EXISTS manager_questions(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,questions TEXT NOT NULL,answers TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_generated_images(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,item_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL,UNIQUE(message_id,item_id));
      CREATE TABLE IF NOT EXISTS manager_conversation_cleanup(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS manager_ready_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS manager_queue_versions(conversation_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    `);
    for(const table of ['manager_conversations','manager_messages'])
      if(!this.statement(`PRAGMA table_info(${table})`).all().some(column=>column.name==='execution'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN execution TEXT`);
    for(const [table,columns] of [['manager_messages',{reply_to:'TEXT',started_at:'INTEGER',completed_at:'INTEGER',updated_at:'INTEGER',partial_text:'TEXT',queued_at:'INTEGER',steer_parent_id:'TEXT'}],['manager_actions',{message_id:'TEXT'}],['manager_conversation_cleanup',{attempted_at:'INTEGER NOT NULL DEFAULT 0'}]])
      for(const [name,type] of Object.entries(columns))if(!this.statement(`PRAGMA table_info(${table})`).all().some(column=>column.name===name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    this.db.exec('CREATE INDEX IF NOT EXISTS manager_action_message ON manager_actions(conversation_id,message_id,created_at); CREATE INDEX IF NOT EXISTS manager_history_order ON manager_messages(conversation_id,created_at); CREATE INDEX IF NOT EXISTS manager_reply_parent ON manager_messages(reply_to); CREATE INDEX IF NOT EXISTS manager_recent_conversations ON manager_conversations(updated_at DESC,id DESC);');
    this.db.exec("CREATE INDEX IF NOT EXISTS manager_pending_by_conversation ON manager_messages(conversation_id,status,COALESCE(queued_at,created_at)) WHERE role='user' AND status IN ('queued','interrupted')");
    const queued=alias=>`${alias}.role='user' AND ${alias}.status IN ('queued','draft','steering','steer_unknown')`;
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS manager_queue_insert AFTER INSERT ON manager_messages WHEN ${queued('NEW')} BEGIN
        INSERT INTO manager_queue_versions VALUES(NEW.conversation_id,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS manager_queue_delete AFTER DELETE ON manager_messages WHEN ${queued('OLD')} BEGIN
        INSERT INTO manager_queue_versions VALUES(OLD.conversation_id,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS manager_queue_update AFTER UPDATE ON manager_messages WHEN (${queued('OLD')}) OR (${queued('NEW')}) BEGIN
        INSERT INTO manager_queue_versions SELECT OLD.conversation_id,1 WHERE ${queued('OLD')}
          ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
        INSERT INTO manager_queue_versions SELECT NEW.conversation_id,1 WHERE (${queued('NEW')}) AND NOT ((${queued('OLD')}) AND OLD.conversation_id=NEW.conversation_id)
          ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
      END;
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS manager_conversation_cleanup_order ON manager_conversation_cleanup(attempted_at,created_at,id);');
  }
  statement(sql) {
    let statement=this.statements.get(sql);
    if(statement)this.statements.delete(sql);
    else {
      const native=this.db.prepare(sql);statement={};
      for(const method of ['get','all','run'])statement[method]=(...parameters)=>{
        // Node SQLite resets execution but retains bound values until reuse.
        // Do not keep large reply/image payloads alive through the LRU.
        const bytes=parameters.reduce((total,value)=>total+(typeof value==='string'?Buffer.byteLength(value):ArrayBuffer.isView(value)?value.byteLength:8),0);
        if(bytes>8192)this.statements.delete(sql);
        return native[method](...parameters);
      };
    }
    this.statements.set(sql,statement);
    if(this.statements.size>64)this.statements.delete(this.statements.keys().next().value);
    return statement;
  }
  close(){this.events.removeAllListeners();this.statements.clear();this.db.close();}
  watch(id,listener){const handler=change=>{if(change.conversationId===id)listener(change);};this.events.on('change',handler);return()=>this.events.off('change',handler);}
  changed(conversationId,messageId,deleted=false){queueMicrotask(()=>this.events.emit('change',{conversationId,messageId,deleted}));}
  changedMessage(id){const row=this.statement('SELECT conversation_id FROM manager_messages WHERE id=?').get(id);if(row)this.changed(row.conversation_id,id);}
  replies(id){return this.statement('SELECT id,text,status,created_at,updated_at FROM manager_reply_items WHERE message_id=? ORDER BY created_at,rowid').all(id);}
  questions(id){return this.statement('SELECT * FROM manager_questions WHERE message_id=? ORDER BY created_at,rowid').all(id).map(row=>({...row,questions:JSON.parse(row.questions),answers:row.answers?JSON.parse(row.answers):null}));}
  questionMessage(conversationId,id){return this.statement('SELECT m.id FROM manager_messages m JOIN manager_questions q ON q.message_id=m.id WHERE q.id=? AND m.conversation_id=?').get(id,conversationId);}
  publicMessage(message){return {...messageRow(message),error:message.error?JSON.parse(message.error):null,attachments:this.attachments(message.id),generated_images:this.generatedImages(message.id),replies:this.replies(message.id),questions:this.questions(message.id),activity:this.statement('SELECT id,kind,label,text,status,created_at,updated_at FROM manager_message_activity WHERE message_id=? ORDER BY created_at,rowid').all(message.id)};}
  message(id){const row=this.statement('SELECT * FROM manager_messages WHERE id=?').get(id);return row?this.publicMessage(row):null;}
  metadata(id){const row=this.statement('SELECT * FROM manager_conversations WHERE id=?').get(id);if(!row)throw new HttpError(404,'CONVERSATION_NOT_FOUND','找不到管理会话。');return conversationRow(row);}
  observe(key,value){this.statement('INSERT OR REPLACE INTO manager_observations VALUES(?,?,?)').run(key,JSON.stringify(value),Date.now());}
  observation(key){const row=this.statement('SELECT value,observed_at FROM manager_observations WHERE key=?').get(key);return row?{...JSON.parse(row.value),observed_at:row.observed_at}:null;}
  pruneObservations(cutoff){retentionCutoff(cutoff);return this.statement('DELETE FROM manager_observations WHERE observed_at<?').run(cutoff).changes;}
  createConversation(title='新会话',sourceId=null) {
    if (sourceId) {const old=this.statement('SELECT * FROM manager_conversations WHERE source_id=?').get(sourceId);if(old)return this.getConversationPage(old.id);}
    const id=randomUUID(),now=Date.now();this.statement('INSERT INTO manager_conversations(id,title,thread_id,source_id,created_at,updated_at) VALUES(?,?,NULL,?,?,?)').run(id,String(title).slice(0,100),sourceId,now,now);
    return this.getConversationPage(id);
  }
  getConversation(id) {
    return {...this.metadata(id),messages:this.statement('SELECT * FROM manager_messages WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(message=>this.publicMessage(message)),actions:this.actions(id)};
  }
  getConversationPage(id,{limit,before}={}) {
    const metadata=this.metadata(id),size=pageSize(limit,20);
    let boundary=Number.MAX_SAFE_INTEGER;
    if(before!==undefined){
      if(typeof before!=='string'||!/^[a-f0-9-]{36}$/.test(before))throw invalidCursor();
      const row=this.statement("SELECT rowid FROM manager_messages WHERE id=? AND conversation_id=? AND (role='user' OR reply_to IS NULL)").get(before,id);
      if(!row)throw invalidCursor();boundary=row.rowid;
    }
    const roots=this.statement("SELECT id,rowid FROM manager_messages WHERE conversation_id=? AND steer_parent_id IS NULL AND status NOT IN ('queued','draft','removed','steering','steer_unknown') AND (role='user' OR reply_to IS NULL) AND rowid<? ORDER BY rowid DESC LIMIT ?").all(id,boundary,size+1);
    const hasMore=roots.length>size,selected=roots.slice(0,size).reverse(),ids=selected.map(row=>row.id);
    // Keep an older active clarification reachable without moving the history cursor.
    if(before===undefined){const active=this.statement("SELECT id FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('running','interrupted') ORDER BY rowid LIMIT 1").get(id);if(active&&!ids.includes(active.id))ids.push(active.id);}
    const messages=ids.length?this.statement(`SELECT * FROM manager_messages WHERE conversation_id=? AND (id IN (${ids.map(()=>'?').join(',')}) OR reply_to IN (${ids.map(()=>'?').join(',')}) OR (steer_parent_id IN (${ids.map(()=>'?').join(',')}) AND status='steered')) ORDER BY created_at,rowid`).all(id,...ids,...ids,...ids).map(row=>this.publicMessage(row)):[];
    return {...metadata,...this.counts(id),queue:this.queue(id),messages,actions:this.actionsPage(id,ids),history:{has_more:hasMore,before:selected[0]?.id??null}};
  }
  queueVersion(id){return this.statement('SELECT revision FROM manager_queue_versions WHERE conversation_id=?').get(id)?.revision??0;}
  queue(id){return this.statement("SELECT * FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','draft','steering','steer_unknown') ORDER BY COALESCE(queued_at,created_at),rowid").all(id).map(row=>this.publicMessage(row));}
  queuedMessage(conversationId,id,statuses=['queued']) {
    this.metadata(conversationId);
    const message=this.message(id);
    if(!message||message.conversation_id!==conversationId||message.role!=='user')throw new HttpError(404,'MESSAGE_NOT_FOUND','找不到消息。');
    if(!statuses.includes(message.status))throw new HttpError(409,'MESSAGE_NOT_QUEUED','消息状态已改变，请刷新后重试。');
    return message;
  }
  withdrawQueued(conversationId,id) {
    this.queuedMessage(conversationId,id);
    this.statement("UPDATE manager_messages SET status='draft',updated_at=? WHERE id=? AND status='queued'").run(Date.now(),id);
    this.changed(conversationId,id);return this.message(id);
  }
  removeQueued(conversationId,id) {
    this.queuedMessage(conversationId,id,['queued','draft']);
    this.db.exec('SAVEPOINT remove_queued');
    try {
      this.statement("UPDATE manager_messages SET status='removed',text='',updated_at=? WHERE id=?").run(Date.now(),id);
      this.statement('DELETE FROM manager_chat_images WHERE message_id=?').run(id);
      this.db.exec('RELEASE remove_queued');
    }catch(error){this.db.exec('ROLLBACK TO remove_queued; RELEASE remove_queued');throw error;}
    this.changed(conversationId,id);return {id,deleted:true};
  }
  requeue(conversationId,id,text) {
    const message=this.queuedMessage(conversationId,id,['draft']);
    if(typeof text!=='string'||text.length>20000||(!text.trim()&&!message.attachments.length))throw new HttpError(400,'INVALID_MESSAGE','消息不能为空，文字最多 20000 个字符。');
    const now=Date.now();
    // A withdrawn message joins behind every currently queued request, even in the same millisecond.
    const last=this.statement("SELECT max(COALESCE(queued_at,created_at)) AS time FROM manager_messages WHERE conversation_id=? AND status='queued'").get(conversationId).time??0;
    this.statement("UPDATE manager_messages SET text=?,status='queued',queued_at=?,updated_at=? WHERE id=? AND status='draft'").run(text,Math.max(now,last+1),now,id);
    this.changed(conversationId,id);return this.message(id);
  }
  reserveSteer(conversationId,id,parentId,turnId) {
    const message=this.queuedMessage(conversationId,id);
    // Public history positions are assigned only on first dispatch; all references use message IDs.
    this.statement("UPDATE manager_messages SET rowid=(SELECT max(rowid)+1 FROM manager_messages),status='steering',steer_parent_id=?,turn_id=?,started_at=?,created_at=?,updated_at=? WHERE id=? AND status='queued'").run(parentId,turnId,Date.now(),Date.now(),Date.now(),id);
    this.changed(conversationId,id);return message;
  }
  settleSteer(id,status) {
    const now=Date.now();
    if(status==='queued')this.statement("UPDATE manager_messages SET status='queued',steer_parent_id=NULL,turn_id=NULL,started_at=NULL,updated_at=? WHERE id=? AND status='steering'").run(now,id);
    else this.statement("UPDATE manager_messages SET status=?,updated_at=?,completed_at=? WHERE id=? AND status IN ('steering','steer_unknown')").run(status,now,status==='steered'?now:null,id);
    this.changedMessage(id);return this.message(id);
  }
  pendingSteers(parentId){return this.statement("SELECT id,status FROM manager_messages WHERE steer_parent_id=? AND status IN ('steering','steer_unknown')").all(parentId);}
  counts(id){return this.statement("SELECT sum(status='queued') AS queued_count,sum(status IN ('running','interrupted')) AS running_count FROM manager_messages WHERE conversation_id=? AND role='user'").get(id);}
  messageGroups(id,ids){
    this.metadata(id);
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(value=>typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value)))throw new HttpError(400,'INVALID_INPUT','消息编号不正确。');
    const unique=[...new Set(ids)],placeholders=unique.map(()=>'?').join(',');
    const roots=this.statement(`SELECT id FROM manager_messages WHERE conversation_id=? AND role='user' AND id IN (${placeholders})`).all(id,...unique);
    if(roots.length!==unique.length)throw new HttpError(404,'MESSAGE_NOT_FOUND','找不到消息。');
    return {messages:this.statement(`SELECT * FROM manager_messages WHERE conversation_id=? AND (id IN (${placeholders}) OR reply_to IN (${placeholders}) OR (steer_parent_id IN (${placeholders}) AND status='steered')) ORDER BY created_at,rowid`).all(id,...unique,...unique,...unique).map(row=>this.publicMessage(row)),actions:this.actionsPage(id,unique)};
  }
  hasExecutionEffort(id){return !!this.statement("SELECT 1 FROM manager_messages WHERE conversation_id=? AND execution IS NOT NULL AND json_type(execution,'$.reasoningEffort') IS NOT NULL LIMIT 1").get(id);}
  listPage({limit,before}={}) {
    const size=pageSize(limit,30);let cursor;
    if(before!==undefined){
      if(typeof before!=='string'||before.length>100)throw invalidCursor();
      const match=/^(\d+):([a-f0-9-]{36})$/.exec(before);if(!match||!Number.isSafeInteger(Number(match[1])))throw invalidCursor();
      cursor={time:Number(match[1]),id:match[2]};
    }
    const rows=this.statement(`SELECT c.*,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status='queued') AS queued_count,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('running','interrupted')) AS running_count FROM manager_conversations c ${cursor?'WHERE c.updated_at<? OR (c.updated_at=? AND c.id<?)':''} ORDER BY c.updated_at DESC,c.id DESC LIMIT ?`).all(...(cursor?[cursor.time,cursor.time,cursor.id]:[]),size+1);
    const items=rows.slice(0,size).map(conversationRow),last=items.at(-1);
    return {items,next_cursor:rows.length>size?`${last.updated_at}:${last.id}`:null};
  }
  expiredConversations({cutoff,cursor=null,limit=50}) {
    retentionCutoff(cutoff);const size=pageSize(limit,50);
    if(cursor!==null&&(!cursor||!Number.isSafeInteger(cursor.time)||typeof cursor.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cursor.id)))throw invalidCursor();
    return this.statement(`SELECT c.id,c.updated_at FROM manager_conversations c WHERE c.updated_at<? AND NOT (${busyHistorySql('c.id')}) ${cursor?'AND (c.updated_at>? OR (c.updated_at=? AND c.id>?))':''} ORDER BY c.updated_at,c.id LIMIT ?`).all(cutoff,...(cursor?[cursor.time,cursor.time,cursor.id]:[]),size);
  }
  isHistoryIdle(){return !this.statement(`SELECT (${busyHistorySql()}) AS busy`).get().busy;}
  pendingConversationCleanup(limit=50){return this.statement('SELECT id,created_at FROM manager_conversation_cleanup ORDER BY attempted_at,created_at,id LIMIT ?').all(pageSize(limit,50));}
  deferConversationCleanup(id){this.statement('UPDATE manager_conversation_cleanup SET attempted_at=max(?,(SELECT COALESCE(max(attempted_at),0)+1 FROM manager_conversation_cleanup)) WHERE id=?').run(Date.now(),id);}
  finishConversationCleanup(id){this.statement('DELETE FROM manager_conversation_cleanup WHERE id=?').run(id);}
  deleteConversation(id,{cutoff}={}) {
    if(cutoff!==undefined)retentionCutoff(cutoff);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // The scan is advisory: take the write lock before rechecking both age and activity.
      const conversation=this.metadata(id);
      const busy=cutoff===undefined?this.statement("SELECT 1 FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','running','interrupted') LIMIT 1").get(id):this.statement(`SELECT 1 FROM manager_conversations c WHERE c.id=? AND (${busyHistorySql('c.id')})`).get(id);
      if(busy)throw new HttpError(409,'CONVERSATION_BUSY','请等待此对话的排队或执行完成后再删除。');
      if(cutoff!==undefined&&conversation.updated_at>=cutoff)throw new HttpError(409,'CONVERSATION_NOT_EXPIRED','此对话尚未达到历史保留期限。');
      this.statement('INSERT OR IGNORE INTO manager_conversation_cleanup(id,created_at) VALUES(?,?)').run(id,Date.now());
      this.statement('DELETE FROM manager_message_activity WHERE message_id IN (SELECT id FROM manager_messages WHERE conversation_id=?)').run(id);
      this.statement('DELETE FROM manager_reply_items WHERE message_id IN (SELECT id FROM manager_messages WHERE conversation_id=?)').run(id);
      this.statement('DELETE FROM manager_questions WHERE message_id IN (SELECT id FROM manager_messages WHERE conversation_id=?)').run(id);
      for(const table of ['manager_chat_images','manager_generated_images','manager_actions','manager_messages'])this.statement(`DELETE FROM ${table} WHERE conversation_id=?`).run(id);
      this.statement('DELETE FROM manager_ready_queue WHERE conversation_id=?').run(id);
      this.statement('DELETE FROM manager_queue_versions WHERE conversation_id=?').run(id);
      this.statement('DELETE FROM manager_conversations WHERE id=?').run(id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.changed(id,undefined,true);return {id,deleted:true};
  }
  list(){return this.statement("SELECT c.*,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status='queued') AS queued_count,(SELECT count(*) FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('running','interrupted')) AS running_count FROM manager_conversations c ORDER BY c.updated_at DESC").all().map(conversationRow);}
  validateExecution(execution){if(!checkExecution(execution))throw new HttpError(400,'INVALID_CONFIGURATION','模型或思考程度配置不正确。');}
  setConversationExecution(id,execution){
    this.validateExecution(execution);this.metadata(id);
    this.statement('UPDATE manager_conversations SET execution=?,updated_at=? WHERE id=?').run(JSON.stringify(execution),Date.now(),id);
    this.changed(id);
    return this.getConversationPage(id);
  }
  recordMessageExecution(id,execution){this.statement('UPDATE manager_messages SET execution=? WHERE id=? AND execution IS NULL').run(JSON.stringify(execution),id);}
  investigations(){return this.statement("SELECT c.id,c.source_id,c.updated_at,EXISTS(SELECT 1 FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('queued','running','interrupted')) AS active FROM manager_conversations c WHERE c.source_id LIKE 'task:%' ORDER BY c.updated_at DESC LIMIT 100").all().map(row=>({...row,task_id:row.source_id.slice(5)}));}
  acceptInspection(sourceId,text) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.statement('SELECT id FROM manager_conversations WHERE source_id=?').get(sourceId);
      if(old){const conversation=this.getConversationPage(old.id);this.db.exec('COMMIT');return {created:false,conversation};}
      const conversation=this.createConversation('定时巡检',sourceId),message=this.enqueue(conversation.id,text);
      this.db.exec('COMMIT');return {created:true,conversation,message};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  enqueue(id,text,images=[]) {
    this.metadata(id);
    if(typeof text!=='string'||text.length>20000||(!text.trim()&&!images.length))throw new HttpError(400,'INVALID_MESSAGE','消息不能为空，文字最多 20000 个字符。');
    const now=Date.now(),message={id:randomUUID(),conversation_id:id,role:'user',text,status:'queued',created_at:now,updated_at:now,started_at:null,completed_at:null,reply_to:null,activity:[],error:null};
    // Images have already passed asynchronous byte/decode validation at admission.
    this.db.exec('SAVEPOINT enqueue_chat_message');
    try {
    this.statement("INSERT INTO manager_messages(id,conversation_id,role,text,status,turn_id,error,created_at) VALUES(?,?,'user',?,'queued',NULL,NULL,?)").run(message.id,id,text,Date.now());
    for(const image of images)this.statement('INSERT INTO manager_chat_images VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),message.id,id,image.name,image.mime,image.width,image.height,image.size,image.bytes);
    const last=this.statement("SELECT max(COALESCE(queued_at,created_at)) AS time FROM manager_messages WHERE conversation_id=? AND status='queued' AND id<>?").get(id,message.id).time??0;
    this.statement('UPDATE manager_messages SET updated_at=?,queued_at=? WHERE id=?').run(Date.now(),Math.max(now,last+1),message.id);
    this.statement('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),id);
    this.db.exec('RELEASE enqueue_chat_message');
    }catch(error){this.db.exec('ROLLBACK TO enqueue_chat_message; RELEASE enqueue_chat_message');throw error;}
    message.attachments=this.attachments(message.id);
    this.changed(id,message.id);
    return message;
  }
  attachments(messageId){return this.statement('SELECT id,name,mime,width,height,size,conversation_id FROM manager_chat_images WHERE message_id=? ORDER BY rowid').all(messageId).map(({conversation_id,...image})=>({...image,url:`/admin/api/conversations/${conversation_id}/images/${image.id}`}));}
  generatedImages(messageId){return this.statement('SELECT id,name,mime,width,height,size,conversation_id FROM manager_generated_images WHERE message_id=? ORDER BY rowid').all(messageId).map(({conversation_id,...image})=>({...image,url:`/admin/api/conversations/${conversation_id}/images/${image.id}`}));}
  generatedImage(messageId,itemId){return this.statement('SELECT id FROM manager_generated_images WHERE message_id=? AND item_id=?').get(messageId,itemId);}
  saveGeneratedImage(messageId,itemId,image){
    const message=this.statement('SELECT conversation_id,status FROM manager_messages WHERE id=?').get(messageId);
    if(!message||!['running','interrupted'].includes(message.status))return;
    const total=this.statement('SELECT COALESCE(sum(size),0) AS bytes FROM manager_generated_images WHERE message_id=?').get(messageId).bytes;
    if(total+image.size>64*1024*1024)throw new Error('IMAGE_BUDGET_EXCEEDED');
    this.statement('INSERT OR IGNORE INTO manager_generated_images VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),messageId,message.conversation_id,itemId,image.name,image.mime,image.width,image.height,image.size,image.bytes);
    this.changedMessage(messageId);
  }
  getImage(conversationId,attachmentId){const image=this.statement('SELECT * FROM manager_chat_images WHERE conversation_id=? AND id=?').get(conversationId,attachmentId)??this.statement('SELECT * FROM manager_generated_images WHERE conversation_id=? AND id=?').get(conversationId,attachmentId);if(!image)throw new HttpError(404,'IMAGE_NOT_FOUND','找不到图片。');return image;}
  imageInputs(messageId){return this.statement('SELECT mime,bytes FROM manager_chat_images WHERE message_id=? ORDER BY rowid').all(messageId).map(image=>({type:'image',url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}));}
  schedule(id){this.statement('INSERT OR IGNORE INTO manager_ready_queue(conversation_id) VALUES(?)').run(id);}
  scheduled(id){return !!this.statement('SELECT 1 FROM manager_ready_queue WHERE conversation_id=?').get(id);}
  takeScheduled(excludeIds=[]) {
    const row=this.statement(`SELECT seq,conversation_id FROM manager_ready_queue ${excludeIds.length?`WHERE conversation_id NOT IN (${excludeIds.map(()=>'?').join(',')})`:''} ORDER BY seq LIMIT 1`).get(...excludeIds);
    if(!row)return;
    this.statement('DELETE FROM manager_ready_queue WHERE seq=?').run(row.seq);
    return row.conversation_id;
  }
  reschedule(id,{interrupted=false}={}) {
    // A row inserted while this conversation executes is its durable wake signal.
    // Rotate at completion, even if that wake arrived before another conversation.
    const wake=this.statement('DELETE FROM manager_ready_queue WHERE conversation_id=?').run(id).changes;
    if((!interrupted||wake)&&this.statement("SELECT 1 FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','interrupted') LIMIT 1").get(id))this.schedule(id);
  }
  next(id) {const row=this.statement("SELECT * FROM manager_messages WHERE conversation_id=? AND role='user' AND status IN ('queued','interrupted') ORDER BY status,COALESCE(queued_at,created_at),rowid LIMIT 1").get(id);return row?messageRow(row):undefined;}
  markRunning(id){const now=Date.now();this.statement("UPDATE manager_messages SET rowid=CASE WHEN status='queued' THEN (SELECT max(rowid)+1 FROM manager_messages) ELSE rowid END,created_at=CASE WHEN status='queued' THEN ? ELSE created_at END,status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status IN ('queued','interrupted')").run(now,now,now,id);this.changedMessage(id);}
  thread(conversationId,threadId){this.statement('UPDATE manager_conversations SET thread_id=? WHERE id=?').run(threadId,conversationId);}
  syncTitle(conversationId,name){
    if(typeof name!=='string')return;
    const title=name.replace(/\s+/g,' ').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,100);
    if(title){const result=this.statement('UPDATE manager_conversations SET title=?,updated_at=? WHERE id=? AND title<>?').run(title,Date.now(),conversationId,title);if(result.changes)this.changed(conversationId);}
  }
  turn(messageId,turnId){this.statement('UPDATE manager_messages SET turn_id=? WHERE id=?').run(turnId,messageId);}
  interrupted(id,error){const now=Date.now();if(error)this.statement('UPDATE manager_messages SET error=? WHERE id=?').run(JSON.stringify(error),id);this.statement("UPDATE manager_messages SET status='interrupted',updated_at=? WHERE id=? AND status='running'").run(now,id);this.statement("UPDATE manager_message_activity SET status='unknown',updated_at=? WHERE message_id=? AND status='running'").run(now,id);this.statement("UPDATE manager_reply_items SET status='unknown',updated_at=? WHERE message_id=? AND status='running'").run(now,id);this.expireQuestions(id);this.changedMessage(id);}
  addQuestion(messageId,questions) {
    const m=this.statement('SELECT status FROM manager_messages WHERE id=?').get(messageId);
    if(m?.status!=='running'||this.statement('SELECT count(*) AS n FROM manager_questions WHERE message_id=?').get(messageId).n>=20)throw new HttpError(409,'QUESTION_EXPIRED','此提问已结束，请等待 Agent 重新提问。');
    const id=randomUUID(),now=Date.now();this.statement("INSERT INTO manager_questions VALUES(?,?,?,NULL,'pending',?,?)").run(id,messageId,JSON.stringify(questions),now,now);this.changedMessage(messageId);
    return this.questions(messageId).find(q=>q.id===id);
  }
  answerQuestion(conversationId,id,answers) {
    const q=this.statement('SELECT q.*,m.conversation_id,m.status AS message_status FROM manager_questions q JOIN manager_messages m ON m.id=q.message_id WHERE q.id=? AND m.conversation_id=?').get(id,conversationId);
    if(!q)throw new HttpError(404,'QUESTION_NOT_FOUND','找不到此对话的提问。');
    if(q.status!=='pending'||q.message_status!=='running')throw new HttpError(409,'QUESTION_EXPIRED','此提问已结束，请等待 Agent 重新提问。');
    const value=validateAnswers(JSON.parse(q.questions),answers);
    const saved=Object.fromEntries(Object.entries(value).map(([key,answer])=>[key,{answers:answer.answers.map(text=>publicChatText(text,[],false,4000))}]));
    const changed=this.statement("UPDATE manager_questions SET answers=?,status='answered',updated_at=? WHERE id=? AND status='pending'").run(JSON.stringify(saved),Date.now(),id);
    if(!changed.changes)throw new HttpError(409,'QUESTION_EXPIRED','此提问已结束，请等待 Agent 重新提问。');
    this.changedMessage(q.message_id);return {...this.questions(q.message_id).find(item=>item.id===id),response:{answers:value}};
  }
  expireQuestions(messageId,id) {
    this.statement("UPDATE manager_questions SET status='expired',updated_at=? WHERE message_id=? AND status='pending'"+(id?' AND id=?':'')).run(Date.now(),messageId,...(id?[id]:[]));this.changedMessage(messageId);
  }
  reply(id,text){const result=this.statement("UPDATE manager_messages SET partial_text=?,updated_at=? WHERE id=? AND status='running'").run(publicChatText(text,[],false,1048576),Date.now(),id);if(result.changes)this.changedMessage(id);}
  replyItem(messageId,id,text,status) {
    if(typeof id!=='string'||id.length>200||!['running','completed'].includes(status))return;
    if(this.statement('SELECT status FROM manager_messages WHERE id=?').get(messageId)?.status!=='running')return;
    const old=this.statement('SELECT text FROM manager_reply_items WHERE message_id=? AND id=?').get(messageId,id);
    const total=this.statement('SELECT count(*) AS count,COALESCE(sum(length(text)),0) AS size FROM manager_reply_items WHERE message_id=?').get(messageId);
    if(!old&&total.count>=100)return;
    const value=publicChatText(text,[],false,Math.max(0,1048576-total.size+(old?.text.length??0))),now=Date.now();
    this.statement('INSERT INTO manager_reply_items VALUES(?,?,?,?,?,?) ON CONFLICT(message_id,id) DO UPDATE SET text=excluded.text,status=excluded.status,updated_at=excluded.updated_at').run(messageId,id,value,status,now,now);
    this.changedMessage(messageId);
  }
  progress(messageId,entry) {
    const message=this.statement('SELECT status FROM manager_messages WHERE id=?').get(messageId);
    if(message?.status!=='running'||!['reasoning_summary','assistant_message','tool','status'].includes(entry.kind)||typeof entry.id!=='string')return;
    const old=this.statement('SELECT text FROM manager_message_activity WHERE message_id=? AND id=?').get(messageId,entry.id);
    const total=this.statement('SELECT count(*) AS count,COALESCE(sum(length(text)),0) AS size FROM manager_message_activity WHERE message_id=?').get(messageId);
    if(!old&&total.count>=100)return;
    const text=publicChatText(entry.text,[],false,Math.min(8192,Math.max(0,65536-total.size+(old?.text.length ?? 0)))),now=Date.now();
    this.statement('INSERT INTO manager_message_activity VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id,id) DO UPDATE SET label=excluded.label,text=excluded.text,status=excluded.status,updated_at=excluded.updated_at').run(messageId,entry.id.slice(0,200),entry.kind,publicChatText(entry.label,[],false,120),text,['running','completed','failed','unknown','interrupted'].includes(entry.status)?entry.status:'unknown',now,now);
    this.statement('UPDATE manager_messages SET updated_at=? WHERE id=?').run(now,messageId);
    this.changedMessage(messageId);
  }
  finish(message,error,text) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now=Date.now(),changed=this.statement("UPDATE manager_messages SET status=?,error=?,completed_at=?,updated_at=?,partial_text=NULL WHERE id=? AND status IN ('queued','running','interrupted')").run(error?'failed':'completed',error?JSON.stringify(error):null,now,now,message.id);
      if(!changed.changes){this.db.exec('COMMIT');return;}
      this.statement("UPDATE manager_message_activity SET status=?,updated_at=? WHERE message_id=? AND status='running'").run(error?'failed':'completed',now,message.id);
      this.statement("UPDATE manager_reply_items SET status=?,updated_at=? WHERE message_id=? AND status='running'").run(error?'failed':'completed',now,message.id);
      this.expireQuestions(message.id);
      const replyId=randomUUID();
      this.statement("INSERT INTO manager_messages(id,conversation_id,role,text,status,turn_id,error,created_at,reply_to,completed_at,updated_at) VALUES(?,?,'assistant',?,'completed',NULL,?,?,?,?,?)").run(replyId,message.conversation_id,publicChatText(text,[],false,null) || (error?error.message:'本轮已结束，请查看操作记录。'),error?JSON.stringify(error):null,now,message.id,now,now);
      this.statement('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),message.conversation_id);
      this.db.exec('COMMIT');
      this.changed(message.conversation_id,message.id);this.changed(message.conversation_id,replyId);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  recover() {
    const now=Date.now();this.db.exec('SAVEPOINT recover_manager_queue');
    try {
      for(const table of ['manager_message_activity','manager_reply_items'])this.statement(`UPDATE ${table} SET status='unknown',updated_at=? WHERE status='running' AND message_id IN (SELECT id FROM manager_messages WHERE status='running')`).run(now);
      this.statement("UPDATE manager_questions SET status='expired',updated_at=? WHERE status='pending' AND message_id IN (SELECT id FROM manager_messages WHERE status='running')").run(now);
      this.statement("UPDATE manager_messages SET status='interrupted',updated_at=? WHERE status='running'").run(now);
      this.db.exec("UPDATE manager_actions SET status='unknown' WHERE status='executing'");
      this.db.exec("DELETE FROM manager_ready_queue WHERE NOT EXISTS (SELECT 1 FROM manager_messages m WHERE m.conversation_id=manager_ready_queue.conversation_id AND m.role='user' AND m.status IN ('queued','interrupted'))");
      this.db.exec("INSERT OR IGNORE INTO manager_ready_queue(conversation_id) SELECT c.id FROM manager_conversations c WHERE EXISTS (SELECT 1 FROM manager_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('queued','interrupted')) ORDER BY c.rowid");
      const count=this.statement('SELECT count(*) AS count FROM manager_ready_queue').get().count;
      this.db.exec('RELEASE recover_manager_queue');return count;
    }catch(error){this.db.exec('ROLLBACK TO recover_manager_queue; RELEASE recover_manager_queue');throw error;}
  }
  beginAction(conversationId,name,args={}) {
    const id=randomUUID(),now=Date.now(),target=args.task_id ?? args.type ?? args.id ?? args.definition?.type;
    const active=conversationId?this.statement("SELECT id FROM manager_messages WHERE conversation_id=? AND role='user' AND status='running' ORDER BY created_at,rowid LIMIT 1").get(conversationId):null;
    this.statement("INSERT INTO manager_actions(id,conversation_id,name,target,status,summary,error,created_at,updated_at,message_id) VALUES(?,?,?,?,'executing',NULL,NULL,?,?,?)").run(id,conversationId,name,typeof target==='string'?target:null,now,now,active?.id ?? null);if(conversationId){this.statement('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(now,conversationId);this.changed(conversationId);}return id;
  }
  finishAction(id,value,error) {
    const summary=value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>['task_id','retry_of','type','id','status','enabled','accepted','paused','concurrency'].includes(key))):null;
    this.statement('UPDATE manager_actions SET status=?,summary=?,error=?,updated_at=? WHERE id=?').run(error?(error.effectUnknown?'unknown':'failed'):'completed',summary?JSON.stringify(summary):null,error?JSON.stringify({code:error.code ?? 'OPERATION_FAILED',message:error.message}):null,Date.now(),id);
    const row=this.statement('SELECT conversation_id FROM manager_actions WHERE id=?').get(id);if(row?.conversation_id){this.statement('UPDATE manager_conversations SET updated_at=? WHERE id=?').run(Date.now(),row.conversation_id);this.changed(row.conversation_id);}
  }
  actions(id){return this.statement('SELECT * FROM manager_actions WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(row=>({...row,summary:row.summary?JSON.parse(row.summary):null,error:row.error?JSON.parse(row.error):null}));}
  recoveryActionContext(conversationId,messageId) {
    const scope="conversation_id=? AND (message_id=? OR message_id IS NULL)",values=[conversationId,messageId];
    const counts=this.statement(`SELECT count(*) AS total,COALESCE(sum(status NOT IN ('completed','failed')),0) AS unconfirmed FROM manager_actions WHERE ${scope}`).get(...values);
    if(counts.unconfirmed>100)throw new HttpError(409,'MANAGER_RECOVERY_ACTION_OVERFLOW','待核实的操作记录过多，已暂停自动恢复，请先核查操作结果。');
    const actions=this.statement(`SELECT * FROM manager_actions WHERE ${scope} ORDER BY (status NOT IN ('completed','failed')) DESC,created_at DESC,rowid DESC LIMIT 100`).all(...values).map(row=>({...row,summary:row.summary?JSON.parse(row.summary):null,error:row.error?JSON.parse(row.error):null}));
    return {actions,omitted_count:counts.total-actions.length,all_unconfirmed_included:true,
      omitted_instruction:'Older confirmed operations may be omitted from this bounded summary. Omission does not mean an operation did not happen. Do not repeat completed operations; inspect live state for every uncertain effect.'};
  }
  actionsPage(id,messageIds=[]){return this.statement(`SELECT * FROM (SELECT * FROM manager_actions WHERE conversation_id=? ${messageIds.length?`AND (message_id IS NULL OR message_id IN (${messageIds.map(()=>'?').join(',')}))`:''} ORDER BY created_at DESC,rowid DESC LIMIT 100) ORDER BY created_at`).all(id,...messageIds).map(row=>({...row,summary:row.summary?JSON.parse(row.summary):null,error:row.error?JSON.parse(row.error):null}));}
}
