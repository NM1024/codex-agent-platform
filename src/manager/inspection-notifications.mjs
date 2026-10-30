import {HttpError} from '../errors.mjs';

// Gateway owns notification transport. These local outboxes only coordinate
// inspection lifecycle and deletion across the two independently durable stores.
export class InspectionNotificationBridge {
  constructor({store,client}) {
    Object.assign(this,{store,client});this.pending=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS manager_inspection_notification_cleanup(
      inspection_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,created_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS manager_inspection_notification_states(
      inspection_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,state TEXT NOT NULL,
      version INTEGER NOT NULL,created_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0);`);
  }
  serialize(id,work) {
    const previous=this.pending.get(id),operation=(previous??Promise.resolve()).catch(()=>{}).then(work);
    this.pending.set(id,operation);
    void operation.finally(()=>{if(this.pending.get(id)===operation)this.pending.delete(id);}).catch(()=>{});
    return operation;
  }
  queueCleanup(conversation) {
    if(!conversation.source_message_id||!conversation.source_id||conversation.source_id.startsWith('task:'))return;
    this.store.statement('INSERT OR IGNORE INTO manager_inspection_notification_cleanup(inspection_id,conversation_id,created_at) VALUES(?,?,?)').run(conversation.source_id,conversation.id,Date.now());
    this.store.statement('DELETE FROM manager_inspection_notification_states WHERE inspection_id=?').run(conversation.source_id);
  }
  async lifecycle(event) {
    if(event.state==='running')return this.serialize(event.id,async()=>{
      // A recovery start supersedes an older, not-yet-confirmed interruption.
      this.store.statement('DELETE FROM manager_inspection_notification_states WHERE inspection_id=?').run(event.id);
      return this.confirmLifecycle(event);
    });
    this.queueLifecycle(event);
    return this.serialize(event.id,()=>this.deliverLifecycle(event.id));
  }
  queueLifecycle(event) {
    if(!['completed','failed','interrupted'].includes(event.state))throw new HttpError(400,'INVALID_INSPECTION_STATE','巡检执行状态无效。');
    this.store.statement(`INSERT INTO manager_inspection_notification_states(inspection_id,conversation_id,message_id,state,version,created_at) VALUES(?,?,?,?,1,?)
      ON CONFLICT(inspection_id) DO UPDATE SET conversation_id=excluded.conversation_id,message_id=excluded.message_id,state=excluded.state,version=version+1,attempted_at=0
      WHERE conversation_id<>excluded.conversation_id OR message_id<>excluded.message_id OR state<>excluded.state`).run(event.id,event.conversation_id,event.message_id,event.state,Date.now());
  }
  async confirmLifecycle(event) {
    const result=await this.client.execute('inspection_execution_update',event);
    if(result?.accepted!==true)throw new HttpError(409,'INSPECTION_EXECUTION_REJECTED','巡检执行映射未被确认。');
    return result;
  }
  async deliverLifecycle(id) {
    const row=this.store.statement('SELECT * FROM manager_inspection_notification_states WHERE inspection_id=?').get(id);if(!row)return;
    try {
      await this.confirmLifecycle({id:row.inspection_id,conversation_id:row.conversation_id,message_id:row.message_id,state:row.state});
      this.store.statement('DELETE FROM manager_inspection_notification_states WHERE inspection_id=? AND version=?').run(id,row.version);
    }catch(error){this.store.statement('UPDATE manager_inspection_notification_states SET attempted_at=max(?,(SELECT COALESCE(max(attempted_at),0)+1 FROM manager_inspection_notification_states)) WHERE inspection_id=? AND version=?').run(Date.now(),id,row.version);throw error;}
  }
  async retryLifecycle({limit=50}={}) {
    this.validateLimit(limit);
    const rows=this.store.statement('SELECT inspection_id FROM manager_inspection_notification_states ORDER BY attempted_at,created_at,inspection_id LIMIT ?').all(limit);let completed=0;
    for(const row of rows)try{await this.serialize(row.inspection_id,()=>this.deliverLifecycle(row.inspection_id));completed++;}catch{}
    return {attempted:rows.length,completed,pending:rows.length-completed};
  }
  async cleanup({limit=50,conversationId}={}) {
    this.validateLimit(limit);
    const rows=this.store.statement(`SELECT * FROM manager_inspection_notification_cleanup ${conversationId===undefined?'':'WHERE conversation_id=?'} ORDER BY attempted_at,created_at,inspection_id LIMIT ?`).all(...(conversationId===undefined?[]:[conversationId]),limit);let completed=0;
    for(const row of rows)try {
      await this.serialize(row.inspection_id,async()=>{
        const result=await this.client.execute('inspection_notification_cleanup',{id:row.inspection_id,conversation_id:row.conversation_id});
        if(result?.accepted===false)throw new HttpError(409,'INSPECTION_CLEANUP_REJECTED','巡检通知清理尚未确认。');
        this.store.statement('DELETE FROM manager_inspection_notification_cleanup WHERE inspection_id=? AND conversation_id=?').run(row.inspection_id,row.conversation_id);
      });completed++;
    }catch{this.store.statement('UPDATE manager_inspection_notification_cleanup SET attempted_at=max(?,(SELECT COALESCE(max(attempted_at),0)+1 FROM manager_inspection_notification_cleanup)) WHERE inspection_id=?').run(Date.now(),row.inspection_id);}
    return {attempted:rows.length,completed,pending:rows.length-completed};
  }
  validateLimit(limit){if(!Number.isInteger(limit)||limit<1||limit>100)throw new HttpError(400,'INVALID_PAGINATION','每页数量必须是 1 到 100 的整数。');}
}
