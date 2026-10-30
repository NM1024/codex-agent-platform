import {NotificationStore} from './store.mjs';
import {HttpError} from '../errors.mjs';
import {notificationContextSchema,notificationSendSchema,notificationToolNames} from './contracts.mjs';

export function assertNotificationCapability(module,ids) {
  if(ids.length&&!notificationToolNames.every(name=>Object.hasOwn(module.tools,name)))throw new HttpError(403,'NOTIFICATION_CAPABILITY_REQUIRED','此业务插件尚未授权通知工具。');
}
export function taskNotificationScope(context) {
  const {store,taskId,runId,generation}=context;
  return ()=>{
    const row=store.raw(taskId),run=store.run(runId);
    if(!row||row.run_id!==runId||!run||!['dispatching','running'].includes(row.status)||!['dispatching','running'].includes(run.status)||(generation!==undefined&&run.generation!==generation))throw new HttpError(409,'TASK_CLOSED','当前任务已不允许发送通知。');
  };
}
export function notificationCatalog() {
  return {
    initializeStorage({db,store}){if(store)store.notifications=new NotificationStore({db});},
    deleteTaskHistory({store,taskId}){store.notifications?.purgeOwner({kind:'task',id:taskId});},
    tools:{
      notification_context:{readOnly:true,description:'Read only this task\'s currently bound notification channels, native JSON format guidance and paginated notification history. Channel URLs and credentials are never returned. Refresh after binding changes.',inputSchema:notificationContextSchema,execute(args,ctx){taskNotificationScope(ctx)();return ctx.store.notifications.context({kind:'task',id:ctx.taskId},args);}},
      send_notification:{effect:'external',description:'Send Agent-authored native JSON to one or more channels explicitly bound to this task, whenever its instructions require. Use a stable notification_key per logical event; identical repeats reuse records. Each channel has a separate outcome. Never automatically replay unknown effects or change bindings.',inputSchema:notificationSendSchema,execute(args,ctx){return ctx.store.notifications.send({kind:'task',id:ctx.taskId},args,{validate:taskNotificationScope(ctx),runId:ctx.runId,operationId:ctx.operationId});}},
    },
  };
}
