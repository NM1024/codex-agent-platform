import Ajv from 'ajv';
import {managementTools} from '../contracts/management.mjs';
import {bootstrapSettings} from '../configuration/bootstrap.mjs';
import {HttpError} from '../errors.mjs';
import {createModelCatalog} from '../codex/models.mjs';
import {filteredCodexEnv} from '../codex/rpc.mjs';
import {currentPlatformContext} from './project-context.mjs';
import {createProjectSourceReader} from './project-source.mjs';
import {conversationExecution} from './model-configuration.mjs';
import {sandboxToolNames} from '../sandbox/contracts.mjs';
const ajv=new Ajv({strict:true}),checks=new Map(managementTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
export function createManagerOperations({client,store,metrics,configuration,auth,sandbox,models=createModelCatalog({env:{...filteredCodexEnv(),CODEX_HOME:process.env.CODEX_LOGIN_HOME ?? '/codex',HOME:process.env.CODEX_LOGIN_HOME ?? '/codex'}})}) {
  const projectSource=createProjectSourceReader();
  return {
    artifact:(...args)=>client.artifact(...args),
    // Browser-only transport: deliberately absent from execute/tool contracts.
    pluginConnection:(...args)=>client.pluginConnection(...args),
    claimPluginEntryKey:(...args)=>client.claimPluginEntryKey(...args),
    notificationChannels:(...args)=>client.notificationChannels(...args),
    async execute(action,args={},context={}) {
      const check=checks.get(action);
      if(!check||!check(args))throw new HttpError(400,'INVALID_MANAGEMENT_INPUT','管理操作或参数不正确。');
      if(sandboxToolNames.has(action)){if(!sandbox)throw new HttpError(503,'SANDBOX_UNAVAILABLE','代码沙箱暂不可用。');return sandbox.execute(action,args,context);}
      if(action==='models')return models();
      if(action==='conversation_execution')return conversationExecution({store,configuration,conversationId:context.conversationId},args);
      if(action==='notification_context'||action==='send_notification'){
        const conversation=context.conversationId?store.metadata(context.conversationId):null;
        const message=context.messageId?store.message(context.messageId):null;
        if(!conversation||!conversation.inspection_admitted||conversation.source_message_id!==context.messageId||!/^[a-f0-9-]{36}$/.test(conversation.source_id??'')||message?.conversation_id!==conversation.id||message.role!=='user'||message.status!=='running')throw new HttpError(403,'INSPECTION_SCOPE_DENIED','通知工具只允许本次定时巡检的原始执行消息使用。');
        return client.execute('inspection_notification',{id:conversation.source_id,conversation_id:conversation.id,message_id:message.id,action:action==='notification_context'?'context':'send',args});
      }
      if(action==='inspection_notifications_update'&&context.conversationId){
        const conversation=store.metadata(context.conversationId);
        if(conversation.source_id===args.id&&conversation.source_message_id===context.messageId)throw new HttpError(403,'INSPECTION_BINDING_SELF_UPDATE_DENIED','巡检执行不能扩大自身的通知渠道绑定，请由管理对话或人在执行详情中修改。');
      }
      if(action==='platform_context')return currentPlatformContext();
      if(action==='project_source')return projectSource(args);
      if(action==='admin_password_set'){if(!auth)throw new HttpError(503,'AUTH_UNAVAILABLE','密码服务不可用。');await auth.changePassword(args.currentPassword,args.password);return {updated:true,sessions_revoked:true};}
      if(action==='configuration_list') {
        let remote;try{remote=await client.execute(action,args);}catch{remote={groups:[],bootstrap:bootstrapSettings,gateway_unavailable:true};}
        return {...remote,groups:[...remote.groups,...configuration.list()]};
      }
      if(action==='configuration_get'&&configuration.scopes.has(args.scope))return configuration.get(args.scope);
      if(action==='configuration_update'&&configuration.scopes.has(args.scope))return {...configuration.update(args.scope,args.patch,{revision:args.revision}),synchronization:{manager:'applied'}};
      if(action!=='overview')return client.execute(action,args);
      let value;
      try{value=await client.execute(action,args);store.observe('last_platform',value);}
      catch(error){value={unavailable:true,error:{code:error.code ?? 'GATEWAY_UNAVAILABLE',message:error.message},last_known:store.observation('last_platform')};}
      return {...value,manager:{alive:true},resources:await metrics.sample(),investigations:store.investigations()};
    },
  };
}
