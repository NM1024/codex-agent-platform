import {HttpError} from '../errors.mjs';
import {assertNotificationCapability} from './catalog.mjs';
const fail=(status,code)=>{throw new HttpError(status,code,code);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
export const notificationManagementActions=new Set(['notification_channels','task_notifications_get','task_notifications_update','schedule_notifications_get','schedule_notifications_update','inspection_notifications_get','inspection_notifications_update']);
export const notificationPrivateActions=new Set(['inspection_execution_update','inspection_notification','inspection_notification_cleanup']);
export class NotificationOperations {
  constructor({store,schedules}){Object.assign(this,{store,schedules});}
  get notifications(){return this.store.notifications??fail(503,'NOTIFICATIONS_UNAVAILABLE');}
  view(owner,{available=true,...history}={}){return {...this.notifications.context(owner,history),...(available?{available_channels:this.notifications.listChannels()}:{})};}
  task(taskId,options){if(!this.store.raw(taskId))fail(404,'NOT_FOUND');return this.view({kind:'task',id:taskId},options);}
  updateTask(taskId,ids,revision,options){
    const row=this.store.raw(taskId);if(!row)fail(404,'NOT_FOUND');if(['completed','failed'].includes(row.status))fail(409,'TASK_NOT_EDITABLE');
    if(!Array.isArray(ids)||!Number.isSafeInteger(revision)||revision<0)fail(400,'INVALID_NOTIFICATION_BINDING');
    assertNotificationCapability(this.store.moduleFor(row),ids);this.notifications.setBinding({kind:'task',id:taskId},ids,{revision});return this.task(taskId,options);
  }
  schedule(id){
    const plan=this.schedules.get(id);
    const executions=this.store.db.prepare('SELECT task_id AS id,triggered_at AS created_at FROM platform_schedule_runs WHERE schedule_id=? ORDER BY triggered_at DESC,id DESC LIMIT 20').all(id).map(row=>{
      const task=this.store.raw(row.id),inspection=task?null:this.store.db.prepare('SELECT * FROM platform_inspections WHERE id=?').get(row.id);
      return {...row,kind:task?'task':inspection?'inspection':plan.kind,status:task?.status??(inspection?.status==='cancelled'?'cancelled':inspection?.execution_state)??'unknown'};
    });
    return {...this.view({kind:'schedule',id}),executions};
  }
  updateSchedule(id,ids,revision){
    const plan=this.schedules.get(id);if(!Array.isArray(ids)||!Number.isSafeInteger(revision)||revision<0)fail(400,'INVALID_NOTIFICATION_BINDING');
    if(plan.kind==='task'&&ids.length)assertNotificationCapability(this.store.registry.get(plan.type),ids);
    this.notifications.setBinding({kind:'schedule',id},ids,{revision});return this.schedule(id);
  }
  inspectionRow(id){if(!uuid(id))fail(400,'INVALID_INSPECTION');const row=this.store.db.prepare('SELECT * FROM platform_inspections WHERE id=?').get(id);if(!row)fail(404,'INSPECTION_NOT_FOUND');return row;}
  inspection(id){this.inspectionRow(id);return this.view({kind:'inspection',id});}
  updateInspection(id,ids,revision){
    const row=this.inspectionRow(id);if(row.status==='cancelled'||['completed','failed','cancelled'].includes(row.execution_state))fail(409,'INSPECTION_NOT_EDITABLE');
    if(!Array.isArray(ids)||!Number.isSafeInteger(revision)||revision<0)fail(400,'INVALID_NOTIFICATION_BINDING');
    this.notifications.setBinding({kind:'inspection',id},ids,{revision});return this.inspection(id);
  }
  scope(args,{running=false}={}){
    const row=this.inspectionRow(args.id);
    if(!uuid(args.conversation_id)||!uuid(args.message_id)||row.conversation_id!==args.conversation_id||row.message_id!==args.message_id)fail(403,'INSPECTION_SCOPE_DENIED');
    if(running&&(row.status!=='accepted'||row.execution_state!=='running'))fail(409,'INSPECTION_NOT_RUNNING');return row;
  }
  async executePrivate(action,args){
    if(action==='inspection_execution_update'){
      const row=this.scope(args);if(!['running','completed','failed','interrupted'].includes(args.state))fail(400,'INVALID_INSPECTION_STATE');
      if(row.status==='cancelled'||(['completed','failed','cancelled'].includes(row.execution_state)&&row.execution_state!==args.state))fail(409,'INSPECTION_CLOSED');
      this.store.db.prepare('UPDATE platform_inspections SET execution_state=?,finished_at=? WHERE id=?').run(args.state,['completed','failed'].includes(args.state)?Date.now():null,args.id);return {accepted:true,state:args.state};
    }
    if(action==='inspection_notification'){
      this.scope(args,{running:true});const owner={kind:'inspection',id:args.id};
      if(args.action==='context')return this.notifications.context(owner,args.args??{});
      if(args.action==='send')return this.notifications.send(owner,args.args,{validate:()=>this.scope(args,{running:true}),runId:args.message_id});fail(400,'INVALID_NOTIFICATION_OPERATION');
    }
    if(action==='inspection_notification_cleanup'){
      if(!uuid(args.id)||!uuid(args.conversation_id))fail(400,'INVALID_INSPECTION');const row=this.store.db.prepare('SELECT * FROM platform_inspections WHERE id=?').get(args.id);if(!row)return {deleted:true};
      if(row.conversation_id!==args.conversation_id)fail(403,'INSPECTION_SCOPE_DENIED');this.notifications.purgeOwner({kind:'inspection',id:args.id});
      this.store.db.prepare("UPDATE platform_inspections SET status='cancelled',execution_state='cancelled',finished_at=? WHERE id=?").run(Date.now(),args.id);return {deleted:true};
    }
    fail(400,'INVALID_NOTIFICATION_OPERATION');
  }
  execute(action,args){
    if(action==='notification_channels')return {items:this.notifications.listChannels()};
    if(action==='task_notifications_get')return this.task(args.task_id,{limit:args.limit,before:args.before});
    if(action==='task_notifications_update')return this.updateTask(args.task_id,args.notification_channels,args.notification_revision);
    if(action==='schedule_notifications_get')return this.schedule(args.id);
    if(action==='schedule_notifications_update')return this.updateSchedule(args.id,args.notification_channels,args.notification_revision);
    if(action==='inspection_notifications_get'){this.inspectionRow(args.id);return this.view({kind:'inspection',id:args.id},{limit:args.limit,before:args.before});}
    if(action==='inspection_notifications_update')return this.updateInspection(args.id,args.notification_channels,args.notification_revision);fail(400,'INVALID_NOTIFICATION_OPERATION');
  }
  channelOperation(action,args={}){
    if(action==='list')return {items:this.notifications.listChannels()};
    if(action==='save')return this.notifications.saveChannel(args.channel,{revision:args.revision});
    if(!uuid(args.id))fail(400,'INVALID_NOTIFICATION_CHANNEL');
    if(action==='enable')return this.notifications.setChannelEnabled(args.id,args.enabled,{revision:args.revision});
    if(action==='delete')return this.notifications.deleteChannel(args.id,{revision:args.revision});
    if(action==='test')return this.notifications.testChannel(args.id);fail(400,'INVALID_NOTIFICATION_OPERATION');
  }
}
