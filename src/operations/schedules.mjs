import {systemFailure,systemDue,systemWork} from '../observability/system-maintenance.mjs';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import {assertNotificationCapability} from '../notifications/catalog.mjs';

const invalid=message=>new HttpError(400,'INVALID_SCHEDULE',`INVALID_SCHEDULE: ${message}`);
const terminalInspectionSql="(status='cancelled' OR (status='accepted' AND execution_state IN ('completed','failed','cancelled')))";
function nextAt(cron,timezone,now) {
  try {
    if (typeof cron!=='string' || cron.trim().split(/\s+/).length!==5) throw new Error();
    new Intl.DateTimeFormat('en',{timeZone:timezone}).format(new Date(now));
    return CronExpressionParser.parse(cron,{currentDate:new Date(now),tz:timezone}).next().getTime();
  } catch {throw invalid('请提供有效的五字段 cron 和 IANA 时区。');}
}
export class ScheduleStore {
  constructor(store,{clientId='default',journal}={}) {
    this.store=store;this.db=store.db;this.journal=journal;
    this.clientId=clientId;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_schedules(id TEXT PRIMARY KEY,definition TEXT NOT NULL,enabled INTEGER NOT NULL,next_run_at INTEGER NOT NULL,blocked_reason TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due_at INTEGER NOT NULL,triggered_at INTEGER NOT NULL,task_id TEXT NOT NULL,UNIQUE(schedule_id,due_at));
      CREATE INDEX IF NOT EXISTS platform_schedule_run_history ON platform_schedule_runs(triggered_at DESC,task_id DESC);
      CREATE TABLE IF NOT EXISTS platform_inspections(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,conversation_id TEXT,created_at INTEGER NOT NULL);
    `);
    if(!this.db.prepare('PRAGMA table_info(platform_schedules)').all().some(column=>column.name==='revision'))this.db.exec('ALTER TABLE platform_schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='finished_at')) {
      this.db.exec('ALTER TABLE platform_inspections ADD COLUMN finished_at INTEGER');
    }
    // Repair interrupted upgrades too. Admission alone does not establish
    // completion; only confirmed terminal records can acquire a retention age.
    this.db.exec('CREATE INDEX IF NOT EXISTS platform_inspection_expiry ON platform_inspections(finished_at,id)');
    if(!this.db.prepare('PRAGMA table_info(platform_schedules)').all().some(column=>column.name==='deleted_at'))this.db.exec('ALTER TABLE platform_schedules ADD COLUMN deleted_at INTEGER');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='message_id'))this.db.exec('ALTER TABLE platform_inspections ADD COLUMN message_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(platform_inspections)').all().some(column=>column.name==='execution_state'))this.db.exec("ALTER TABLE platform_inspections ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'pending'");
    this.db.prepare(`UPDATE platform_inspections SET finished_at=NULL WHERE finished_at IS NOT NULL AND NOT ${terminalInspectionSql}`).run();
    this.db.prepare(`UPDATE platform_inspections SET finished_at=? WHERE finished_at IS NULL AND ${terminalInspectionSql}`).run(Date.now());
  }
  get(id) {
    const row=this.db.prepare('SELECT * FROM platform_schedules WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) throw new HttpError(404,'SCHEDULE_NOT_FOUND','找不到定时计划。');
    const binding=this.store.notifications?.getBinding({kind:'schedule',id});
    return {...JSON.parse(row.definition),revision:row.revision,next_run_at:row.next_run_at,blocked_reason:row.blocked_reason,updated_at:row.updated_at,...(binding?{notification_channels:binding.notification_channels,notification_revision:binding.notification_revision}:{})};
  }
  list() {return this.db.prepare('SELECT id FROM platform_schedules WHERE deleted_at IS NULL ORDER BY updated_at DESC,id').all().map(row=>this.get(row.id));}
  runs({kind,status,search,schedule_id,after,before,limit=50,offset=0,id,include_total=false}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)throw invalid('执行记录分页不正确。');
    const query=`SELECT r.task_id AS id,r.schedule_id,r.due_at,r.triggered_at AS created_at,
      json_extract(s.definition,'$.name') AS schedule_name,json_extract(s.definition,'$.timezone') AS timezone,
      CASE WHEN q.task_id IS NOT NULL THEN 'task' WHEN i.id IS NOT NULL THEN 'inspection' ELSE json_extract(s.definition,'$.kind') END AS kind,
      COALESCE(q.status,CASE WHEN i.status='cancelled' THEN 'cancelled' WHEN i.status='queued' THEN 'queued' WHEN i.status='claimed' THEN 'dispatching' WHEN i.execution_state='pending' THEN 'queued' ELSE i.execution_state END,'unknown') AS status,
      q.type,q.error,i.conversation_id,i.message
      FROM platform_schedule_runs r LEFT JOIN platform_schedules s ON s.id=r.schedule_id
      LEFT JOIN agent_requests q ON q.task_id=r.task_id LEFT JOIN platform_inspections i ON i.id=r.task_id`;
    const clauses=[],values=[];
    if(kind){clauses.push('kind=?');values.push(kind);}
    if(status){clauses.push('status=?');values.push(status);}
    if(schedule_id){clauses.push('schedule_id=?');values.push(schedule_id);}
    if(id){clauses.push('id=?');values.push(id);}
    if(after!==undefined){clauses.push('created_at>=?');values.push(after);}
    if(before!==undefined){clauses.push('created_at<?');values.push(before);}
    if(search){clauses.push("(instr(lower(COALESCE(schedule_name,'')),lower(?))>0 OR instr(lower(id),lower(?))>0)");values.push(search,search);}
    const filtered=`FROM (${query}) ${clauses.length?'WHERE '+clauses.join(' AND '):''}`;
    const items=this.db.prepare(`SELECT * ${filtered} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values,limit,offset).map(row=>({...row,error:row.error?JSON.parse(row.error):null}));
    return include_total===true?{items,total:this.db.prepare(`SELECT COUNT(*) AS total ${filtered}`).get(...values).total}:items;
  }
  execution(id){const row=this.runs({id,limit:1})[0];if(!row)throw new HttpError(404,'SCHEDULE_EXECUTION_NOT_FOUND','找不到定时执行记录。');return row;}
  save(raw,now=Date.now(),{revision,notificationRevision}={}) {
    if (!raw || typeof raw!=='object' || !['task','inspection'].includes(raw.kind) || typeof raw.name!=='string' || !raw.name.trim()) throw invalid('name 和 kind 不正确。');
    const timezone=raw.timezone ?? 'Asia/Shanghai';let next_run_at=nextAt(raw.cron,timezone,now);
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
      const existing=this.db.prepare('SELECT definition,next_run_at FROM platform_schedules WHERE id=?').get(id);
      if(existing){const previous=JSON.parse(existing.definition);if(previous.cron===raw.cron&&previous.timezone===timezone&&previous.enabled===definition.enabled)next_run_at=existing.next_run_at;}
      if(revision!==undefined){const current=this.db.prepare('SELECT revision FROM platform_schedules WHERE id=?').get(id);if((current?.revision??0)!==revision)throw new HttpError(409,'SCHEDULE_REVISION_CONFLICT','定时计划已被修改，请重新读取后再保存。');}
      this.db.prepare('INSERT INTO platform_schedules(id,definition,enabled,next_run_at,blocked_reason,updated_at,revision) VALUES(?,?,?,?,NULL,?,1) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled,next_run_at=excluded.next_run_at,blocked_reason=NULL,updated_at=excluded.updated_at,revision=revision+1').run(id,JSON.stringify(definition),Number(definition.enabled),next_run_at,now);
      if(raw.notification_channels!==undefined){if(!this.store.notifications)throw invalid('通知渠道暂不可用。');this.store.notifications.setBinding({kind:'schedule',id},ids,{revision:notificationRevision});}
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
      const rows=this.db.prepare(`SELECT id FROM platform_inspections WHERE ${terminalInspectionSql} AND finished_at<? ORDER BY finished_at,id LIMIT ?`).all(cutoff,limit);
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
      const changed=this.db.prepare("UPDATE platform_inspections SET status='claimed' WHERE id=? AND status='queued'").run(id).changes;
      const row=this.db.prepare('SELECT id,message,status,message_id,execution_state,conversation_id FROM platform_inspections WHERE id=?').get(id);
      if(changed)this.journal?.event({module:'inspections',event:'inspection_claim',target_id:id,code:'WORK_RUNNING',details:{phase:'claim'}});
      return row&&(row.status==='claimed'||row.status==='accepted'&&row.message_id===null&&row.execution_state==='pending')?{accepted:true,id:row.id,message:row.message,status:row.status,conversation_id:row.conversation_id}:{accepted:false};
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
      this.db.prepare("UPDATE platform_inspections SET status='accepted',conversation_id=?,message_id=?,execution_state=?,finished_at=? WHERE id=?").run(conversationId,messageId??null,state,terminal||messageId===undefined?Date.now():null,id);this.journal?.event({module:'inspections',event:'inspection_ack',target_id:id,code:'HANDOFF_COMPLETED',details:{phase:'ack'}});return {accepted:true};
    });
  }
  async tick(now=Date.now()) {
    const rows=this.db.prepare('SELECT id FROM platform_schedules WHERE deleted_at IS NULL AND enabled=1 AND next_run_at<=? ORDER BY next_run_at,id').all(now);
    for (const {id} of rows) {
      const plan=this.get(id),details={phase:'dispatch',revision:plan.revision};
      if(plan.kind==='task') {
        details.plugin_revision=this.db.prepare('SELECT revision FROM platform_plugins WHERE type=?').get(plan.type)?.revision??0;
        details.connection_revision=this.store.pluginConnections?this.db.prepare('SELECT revision FROM platform_plugin_connections WHERE type=?').get(plan.type)?.revision??0:0;
      }
      const work={id:'schedule-trigger.'+id,module:'schedules',target_id:id,details},previous=systemWork(this.journal,work.id);
      // A human configuration change permits one fresh admission check. Unchanged
      // blocked dependencies never cause repeated admissions; diagnostic tags do not veto recovery.
      const force=previous?.state==='blocked'&&['revision','plugin_revision','connection_revision'].some(key=>previous.details[key]!==details[key]);
      if(!systemDue(this.journal,work.id,{now,force}))continue;
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
      });this.journal?.work({...work,state:'completed',code:'HANDOFF_COMPLETED'});} catch(error) {systemFailure(this.journal,{...work,code:'HANDOFF_FAILED'},error);this.db.prepare('UPDATE platform_schedules SET blocked_reason=? WHERE id=?').run(error.code ?? 'SCHEDULE_TRIGGER_FAILED',id);}
    }
  }
}
