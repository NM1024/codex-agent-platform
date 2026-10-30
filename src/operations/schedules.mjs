import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import {assertNotificationCapability} from '../notifications/catalog.mjs';

const invalid=message=>new HttpError(400,'INVALID_SCHEDULE',`INVALID_SCHEDULE: ${message}`);
function nextAt(cron,timezone,now) {
  try {
    if (typeof cron!=='string' || cron.trim().split(/\s+/).length!==5) throw new Error();
    new Intl.DateTimeFormat('en',{timeZone:timezone}).format(new Date(now));
    return CronExpressionParser.parse(cron,{currentDate:new Date(now),tz:timezone}).next().getTime();
  } catch {throw invalid('请提供有效的五字段 cron 和 IANA 时区。');}
}
export class ScheduleStore {
  constructor(store,{clientId='default'}={}) {
    this.store=store;this.db=store.db;
    this.clientId=clientId;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_schedules(id TEXT PRIMARY KEY,definition TEXT NOT NULL,enabled INTEGER NOT NULL,next_run_at INTEGER NOT NULL,blocked_reason TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due_at INTEGER NOT NULL,triggered_at INTEGER NOT NULL,task_id TEXT NOT NULL,UNIQUE(schedule_id,due_at));
      CREATE TABLE IF NOT EXISTS platform_inspections(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,conversation_id TEXT,created_at INTEGER NOT NULL);
    `);
    if(!this.db.prepare('PRAGMA table_info(platform_schedules)').all().some(column=>column.name==='revision'))this.db.exec('ALTER TABLE platform_schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='finished_at')) {
      this.db.exec('ALTER TABLE platform_inspections ADD COLUMN finished_at INTEGER');
    }
    // Repair interrupted upgrades too. Legacy admission time does not establish
    // when an inspection finished, so unknown terminal ages start at migration.
    this.db.exec('CREATE INDEX IF NOT EXISTS platform_inspection_expiry ON platform_inspections(finished_at,id)');
    if(!this.db.prepare('PRAGMA table_info(platform_schedules)').all().some(column=>column.name==='deleted_at'))this.db.exec('ALTER TABLE platform_schedules ADD COLUMN deleted_at INTEGER');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='message_id'))this.db.exec('ALTER TABLE platform_inspections ADD COLUMN message_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='execution_state'))this.db.exec("ALTER TABLE platform_inspections ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'pending'");
    this.db.prepare("UPDATE platform_inspections SET finished_at=? WHERE finished_at IS NULL AND status IN ('accepted','cancelled') AND (message_id IS NULL OR execution_state IN ('completed','failed','cancelled'))").run(Date.now());
  }
  get(id) {
    const row=this.db.prepare('SELECT * FROM platform_schedules WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) throw new HttpError(404,'SCHEDULE_NOT_FOUND','找不到定时计划。');
    const binding=this.store.notifications?.getBinding({kind:'schedule',id});
    return {...JSON.parse(row.definition),revision:row.revision,next_run_at:row.next_run_at,blocked_reason:row.blocked_reason,updated_at:row.updated_at,...(binding?{notification_channels:binding.notification_channels,notification_revision:binding.notification_revision}:{})};
  }
  list() {return this.db.prepare('SELECT id FROM platform_schedules WHERE deleted_at IS NULL ORDER BY updated_at DESC,id').all().map(row=>this.get(row.id));}
  save(raw,now=Date.now(),{revision}={}) {
    if (!raw || typeof raw!=='object' || !['task','inspection'].includes(raw.kind) || typeof raw.name!=='string' || !raw.name.trim()) throw invalid('name 和 kind 不正确。');
    const timezone=raw.timezone ?? 'Asia/Shanghai',next_run_at=nextAt(raw.cron,timezone,now);
    const id=raw.id ?? randomUUID();if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid('id 不正确。');
    if(this.db.prepare('SELECT deleted_at FROM platform_schedules WHERE id=?').get(id)?.deleted_at!=null)throw new HttpError(409,'SCHEDULE_DELETED','定时计划已删除，不能通过保存重新启用。');
    if (raw.enabled!==undefined && typeof raw.enabled!=='boolean') throw invalid('enabled 必须为布尔值。');
    const definition={id,name:raw.name,kind:raw.kind,cron:raw.cron,timezone,enabled:raw.enabled ?? true};
    const ids=raw.notification_channels===undefined?(this.store.notifications?.getBinding({kind:'schedule',id}).notification_channels??[]):raw.notification_channels;
    if(!Array.isArray(ids)||ids.length>32)throw invalid('通知渠道必须为数组。');
    if (raw.kind==='task') {
      const module=this.store.registry.get(raw.type);
      if (!module.checkInput(raw.input)) throw invalid('业务输入不符合插件 input_schema。');
      assertNotificationCapability(module,ids);
      Object.assign(definition,{type:raw.type,input:raw.input});
    } else {
      if (typeof raw.message!=='string' || !raw.message.trim()) throw invalid('巡检需要 message。');
      definition.message=raw.message;
    }
    return this.store.transaction(()=>{
      if(revision!==undefined){const current=this.db.prepare('SELECT revision FROM platform_schedules WHERE id=?').get(id);if((current?.revision??0)!==revision)throw new HttpError(409,'SCHEDULE_REVISION_CONFLICT','定时计划已被修改，请重新读取后再保存。');}
      this.db.prepare('INSERT INTO platform_schedules(id,definition,enabled,next_run_at,blocked_reason,updated_at,revision) VALUES(?,?,?,?,NULL,?,1) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled,next_run_at=excluded.next_run_at,blocked_reason=NULL,updated_at=excluded.updated_at,revision=revision+1').run(id,JSON.stringify(definition),Number(definition.enabled),next_run_at,now);
      if(ids.length||raw.notification_channels!==undefined){if(!this.store.notifications)throw invalid('通知渠道暂不可用。');this.store.notifications.setBinding({kind:'schedule',id},ids);}
      return this.get(id);
    });
  }
  setEnabled(id,enabled) {
    const {next_run_at,blocked_reason,updated_at,revision,...definition}=this.get(id);
    if(typeof enabled!=='boolean')throw invalid('enabled 必须为布尔值。');
    if(enabled)return this.save({...definition,enabled});
    // Stopping a plan must remain possible even if its plugin can no longer execute it.
    this.db.prepare('UPDATE platform_schedules SET enabled=0,definition=?,updated_at=?,revision=revision+1 WHERE id=?').run(JSON.stringify({...definition,enabled:false}),Date.now(),id);
    return this.get(id);
  }
  delete(id) {
    return this.store.transaction(()=>{
      const row=this.db.prepare('SELECT definition,deleted_at FROM platform_schedules WHERE id=?').get(id);
      if(!row)throw new HttpError(404,'SCHEDULE_NOT_FOUND','找不到定时计划。');
      const deleted_at=row.deleted_at??Date.now();
      if(row.deleted_at===null)this.db.prepare('UPDATE platform_schedules SET enabled=0,definition=?,deleted_at=?,updated_at=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.definition),enabled:false}),deleted_at,deleted_at,id);
      this.db.prepare("UPDATE platform_inspections SET status='cancelled',finished_at=? WHERE schedule_id=? AND status='queued'").run(Date.now(),id);
      return {id,deleted:true,deleted_at};
    });
  }
  disableForPlugin(type) {
    for(const plan of this.list())if(plan.kind==='task'&&plan.type===type) {
      this.setEnabled(plan.id,false);
      this.db.prepare("UPDATE platform_schedules SET blocked_reason='PLUGIN_DELETED' WHERE id=?").run(plan.id);
    }
  }
  // The caller may compose this with RequestStore.purgeTaskHistory in its transaction.
  deleteTaskHistory(taskId) {
    return this.db.prepare('DELETE FROM platform_schedule_runs WHERE task_id=?').run(taskId).changes;
  }
  pruneInspectionHistory({cutoff,limit=50}={}) {
    if(!Number.isSafeInteger(cutoff)||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new HttpError(400,'INVALID_INPUT','Invalid retention bounds.');
    return this.store.transaction(()=>{
      const rows=this.db.prepare("SELECT id FROM platform_inspections WHERE status IN ('accepted','cancelled') AND finished_at<? ORDER BY finished_at,id LIMIT ?").all(cutoff,limit);
      let removed=0;
      for(const {id} of rows) {
        if(this.store.notifications?.hasActive({kind:'inspection',id}))continue;
        this.store.notifications?.purgeOwner({kind:'inspection',id});
        this.deleteTaskHistory(id);
        removed+=Number(this.db.prepare('DELETE FROM platform_inspections WHERE id=?').run(id).changes);
      }
      return removed;
    });
  }
  pendingInspections(){return this.db.prepare("SELECT id,message,status FROM platform_inspections WHERE status IN ('queued','claimed') OR (status='accepted' AND message_id IS NULL AND execution_state='pending') ORDER BY created_at").all();}
  claimInspection(id) {
    if(typeof id!=='string')throw new HttpError(400,'INVALID_INPUT','巡检记录编号不正确。');
    return this.store.transaction(()=>{
      this.db.prepare("UPDATE platform_inspections SET status='claimed' WHERE id=? AND status='queued'").run(id);
      const row=this.db.prepare('SELECT id,message,status,message_id FROM platform_inspections WHERE id=?').get(id);
      return row&&(row.status==='claimed'||row.status==='accepted'&&row.message_id===null&&row.execution_state==='pending')?{accepted:true,id:row.id,message:row.message,status:row.status}:{accepted:false};
    });
  }
  acknowledgeInspection(id,conversationId,messageId,messageStatus) {
    if(typeof id!=='string'||typeof conversationId!=='string')throw new HttpError(400,'INVALID_INPUT','巡检记录和管理会话编号不正确。');
    if(messageId!==undefined&&(typeof messageId!=='string'||!/^[a-f0-9-]{36}$/.test(messageId)))throw new HttpError(400,'INVALID_INPUT','巡检消息编号不正确。');
    return this.store.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM platform_inspections WHERE id=?').get(id);if(!row)return {accepted:false};
      if(row.status==='accepted'&&row.conversation_id===conversationId&&row.message_id===messageId)return {accepted:true};
      if(row.status!=='claimed'&&!(row.status==='accepted'&&row.message_id===null&&row.conversation_id===conversationId))return {accepted:false};
      const terminal=['completed','failed'].includes(messageStatus),state=messageId===undefined?'completed':terminal?messageStatus:messageStatus==='running'?'running':messageStatus==='interrupted'?'interrupted':'pending';
      this.db.prepare("UPDATE platform_inspections SET status='accepted',conversation_id=?,message_id=?,execution_state=?,finished_at=? WHERE id=?").run(conversationId,messageId??null,state,terminal||messageId===undefined?Date.now():null,id);return {accepted:true};
    });
  }
  async tick(now=Date.now()) {
    const rows=this.db.prepare('SELECT id FROM platform_schedules WHERE deleted_at IS NULL AND enabled=1 AND next_run_at<=? ORDER BY next_run_at,id').all(now);
    for (const {id} of rows) {
      try {this.store.transaction(()=>{
        const plan=this.get(id);if (!plan.enabled || plan.next_run_at>now) return;
        const event=randomUUID();let task_id;
        if (plan.kind==='task') task_id=this.store.accept(this.clientId,{type:plan.type,request_id:`schedule:${id}:${plan.next_run_at}`,input:plan.input,notification_channels:plan.notification_channels??[]},{notificationInherited:true}).task_id;
        else {
          task_id=randomUUID();this.db.prepare('INSERT INTO platform_inspections(id,schedule_id,message,status,conversation_id,created_at) VALUES(?,?,?,\'queued\',NULL,?)').run(task_id,id,plan.message,now);
          if(plan.notification_channels?.length)this.store.notifications.setBinding({kind:'inspection',id:task_id},plan.notification_channels,{allowUnavailable:true});
        }
        this.db.prepare('INSERT INTO platform_schedule_runs VALUES(?,?,?,?,?)').run(event,id,plan.next_run_at,now,task_id);
        this.db.prepare('UPDATE platform_schedules SET next_run_at=?,blocked_reason=NULL,updated_at=? WHERE id=?').run(nextAt(plan.cron,plan.timezone,now),now,id);
      });} catch(error) {this.db.prepare('UPDATE platform_schedules SET blocked_reason=? WHERE id=?').run(error.code ?? 'SCHEDULE_TRIGGER_FAILED',id);}
    }
  }
}
