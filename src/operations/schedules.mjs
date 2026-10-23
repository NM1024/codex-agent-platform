import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';

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
  }
  get(id) {
    const row=this.db.prepare('SELECT * FROM platform_schedules WHERE id=?').get(id);
    if (!row) throw new HttpError(404,'SCHEDULE_NOT_FOUND','找不到定时计划。');
    return {...JSON.parse(row.definition),next_run_at:row.next_run_at,blocked_reason:row.blocked_reason,updated_at:row.updated_at};
  }
  list() {return this.db.prepare('SELECT id FROM platform_schedules ORDER BY updated_at DESC,id').all().map(row=>this.get(row.id));}
  save(raw,now=Date.now()) {
    if (!raw || typeof raw!=='object' || !['task','inspection'].includes(raw.kind) || typeof raw.name!=='string' || !raw.name.trim()) throw invalid('name 和 kind 不正确。');
    const timezone=raw.timezone ?? 'Asia/Shanghai',next_run_at=nextAt(raw.cron,timezone,now);
    const id=raw.id ?? randomUUID();if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid('id 不正确。');
    if (raw.enabled!==undefined && typeof raw.enabled!=='boolean') throw invalid('enabled 必须为布尔值。');
    const definition={id,name:raw.name,kind:raw.kind,cron:raw.cron,timezone,enabled:raw.enabled ?? true};
    if (raw.kind==='task') {
      const module=this.store.registry.get(raw.type);
      if (!module.checkInput(raw.input)) throw invalid('业务输入不符合插件 input_schema。');
      Object.assign(definition,{type:raw.type,input:raw.input});
    } else {
      if (typeof raw.message!=='string' || !raw.message.trim()) throw invalid('巡检需要 message。');
      definition.message=raw.message;
    }
    this.db.prepare('INSERT INTO platform_schedules VALUES(?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled,next_run_at=excluded.next_run_at,blocked_reason=NULL,updated_at=excluded.updated_at').run(id,JSON.stringify(definition),Number(definition.enabled),next_run_at,now);
    return this.get(id);
  }
  setEnabled(id,enabled) {
    const {next_run_at,blocked_reason,updated_at,...definition}=this.get(id);
    if(typeof enabled!=='boolean')throw invalid('enabled 必须为布尔值。');
    if(enabled)return this.save({...definition,enabled});
    // Stopping a plan must remain possible even if its plugin can no longer execute it.
    this.db.prepare('UPDATE platform_schedules SET enabled=0,definition=?,updated_at=? WHERE id=?').run(JSON.stringify({...definition,enabled:false}),Date.now(),id);
    return this.get(id);
  }
  pendingInspections(){return this.db.prepare("SELECT id,message,status FROM platform_inspections WHERE status='queued' ORDER BY created_at").all();}
  acknowledgeInspection(id,conversationId) {
    if(typeof id!=='string'||typeof conversationId!=='string')throw new HttpError(400,'INVALID_INPUT','巡检记录和管理会话编号不正确。');
    this.db.prepare("UPDATE platform_inspections SET status='accepted',conversation_id=? WHERE id=? AND status='queued'").run(conversationId,id);
    return {accepted:true};
  }
  async tick(now=Date.now()) {
    const rows=this.db.prepare('SELECT id FROM platform_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id').all(now);
    for (const {id} of rows) {
      try {this.store.transaction(()=>{
        const plan=this.get(id);if (!plan.enabled || plan.next_run_at>now) return;
        const event=randomUUID();let task_id;
        if (plan.kind==='task') task_id=this.store.accept(this.clientId,{type:plan.type,request_id:`schedule:${id}:${plan.next_run_at}`,input:plan.input}).task_id;
        else {
          task_id=randomUUID();this.db.prepare('INSERT INTO platform_inspections VALUES(?,?,?,\'queued\',NULL,?)').run(task_id,id,plan.message,now);
        }
        this.db.prepare('INSERT INTO platform_schedule_runs VALUES(?,?,?,?,?)').run(event,id,plan.next_run_at,now,task_id);
        this.db.prepare('UPDATE platform_schedules SET next_run_at=?,blocked_reason=NULL,updated_at=? WHERE id=?').run(nextAt(plan.cron,plan.timezone,now),now,id);
      });} catch(error) {this.db.prepare('UPDATE platform_schedules SET blocked_reason=? WHERE id=?').run(error.code ?? 'SCHEDULE_TRIGGER_FAILED',id);}
    }
  }
}
