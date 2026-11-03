import {createSystemMaintenance,requireSystemTarget,systemFailure,systemDue,systemObserve,systemWork} from '../observability/system-maintenance.mjs';
import {executeSystemOwner,SYSTEM_OWNER_OPERATIONS,systemToolNames} from '../observability/system-operations.mjs';
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import { managementTools } from '../contracts/management.mjs';
import { ScheduleStore } from './schedules.mjs';
import { ResourceSampler } from '../observability/resources.mjs';
import { pluginDefinitionSchema } from '../plugins/definition.mjs';
import {taskDetails} from '../core/task-results.mjs';
import {ConfigurationStore} from '../configuration/store.mjs';
import {executionScope,runtimeSettings} from '../configuration/execution.mjs';
import {bootstrapSettings} from '../configuration/bootstrap.mjs';
import {retentionScope} from '../configuration/retention.mjs';
import {NotificationOperations,notificationManagementActions,notificationPrivateActions} from '../notifications/operations.mjs';

const fault=(code,status=400)=>new HttpError(status,code,code);
export class OperationsService {
  constructor({journal,store,registry=store.registry,config,dispatcher,runner,restartGateway,configuration}) {
    Object.assign(this,{journal,store,registry,config,dispatcher,runner,restartGateway});
    this.configuration=configuration ?? new ConfigurationStore(store.db,[executionScope({store,config}),retentionScope()]);
    this.schedules=new ScheduleStore(store,{clientId:config.clientId ?? 'default',journal});
    if(journal){store.journal=journal;if(store.notifications)store.notifications.journal=journal;}
    this.notifications=new NotificationOperations({store,schedules:this.schedules});
    this.metrics=new ResourceSampler({diskPath:config.workspace ?? '/data'});
    if(journal)this.system={journal,maintain:createSystemMaintenance({journal,actions:{
      configuration_sync:async({work})=>{requireSystemTarget(work,'configuration-sync');await this.syncConfiguration({force:true});},
      runtime_reconcile:async({work})=>{requireSystemTarget(work,'runtime-reconcile');await this.dispatcher.synchronize({force:true});},
      history_sweep:async({work})=>{if(!['history-sweep','history-compact'].some(id=>work.id===`${journal.service}:work:${id}`)||!this.retention)throw new Error('SYSTEM_ACTION_UNSUPPORTED');await this.retention.retry();},
      health_check:async({work})=>{requireSystemTarget(work,'runner-health');let state;try{state=await this.runner.ready();}catch{state={ready:false};}systemObserve(journal,{id:'runner-health',module:'health',state:state.ready?'completed':'unknown',code:state.ready?'SERVICE_RECOVERED':'RUNNER_UNAVAILABLE',allowed_actions:['health_check']});},
    }})};
    const ajv=new Ajv({strict:true});this.checks=new Map(managementTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
  }
  async syncConfiguration({force=false}={}) {
    if(this.configurationSync)return this.configurationSync;
    if(!systemDue(this.journal,'configuration-sync',{force}))return false;
    this.configurationSync=(async()=>{
      const saved=this.configuration.get('execution'),settings={concurrency:this.config.concurrency,...runtimeSettings(this.config)};
      const work={id:'configuration-sync',module:'configuration',allowed_actions:['configuration_sync'],details:{revision:saved.revision,...(systemWork(this.journal,'configuration-sync')?.details.confirmed_revision!==undefined?{confirmed_revision:systemWork(this.journal,'configuration-sync').details.confirmed_revision}:{})},pending_count:1};
      try {
        const confirmed=await this.runner.configure?.(settings);
        if(!confirmed||Object.entries(settings).some(([key,value])=>value!==undefined&&JSON.stringify(confirmed[key])!==JSON.stringify(value)))throw new Error('CONFIGURATION_SYNC_FAILED');
        if(this.configuration.get('execution').revision!==saved.revision){systemObserve(this.journal,{...work,state:'unknown',code:'CONFIGURATION_SYNC_FAILED'});return false;}
        systemObserve(this.journal,{...work,state:'completed',code:'CONFIGURATION_SYNCED',pending_count:0,details:{revision:saved.revision,confirmed_revision:saved.revision}});return true;
      }catch(error){systemFailure(this.journal,{...work,code:'CONFIGURATION_SYNC_FAILED'},error);return false;}
    })().finally(()=>{this.configurationSync=null;});return this.configurationSync;
  }
  async systemOperation(service,operation,args,context) {
    if(!['gateway','runner'].includes(service)||!SYSTEM_OWNER_OPERATIONS.includes(operation))throw fault('SYSTEM_QUERY_INVALID');
    return service==='gateway'?executeSystemOwner(this.system,operation,args,context):this.runner.system(operation,args,context);
  }
  async execute(action,args={}) {
    // Federation is owned by Manager. Private classification/review routes cannot
    // be selected through the generic management transport.
    if(systemToolNames.has(action))throw fault('SYSTEM_SOURCE_MISMATCH');
    const pluginView=definition=>this.store.pluginConnections?{...definition,connection:this.store.pluginConnections.status(definition.type)}:definition;
    if(action==='inspection_list')return this.schedules.pendingInspections();
    if(action==='inspection_claim')return this.schedules.claimInspection(args.id);
    if(action==='inspection_ack')return this.schedules.acknowledgeInspection(args.id,args.conversation_id,args.message_id,args.message_status);
    if(notificationPrivateActions.has(action))return this.notifications.executePrivate(action,args);
    const check=this.checks.get(action);
    if (!check) throw new HttpError(400,'INVALID_MANAGEMENT_INPUT','未知管理操作。');
    if (!check(args)) throw new HttpError(400,'INVALID_MANAGEMENT_INPUT',`${check.errors[0].instancePath || '/'} ${check.errors[0].message} ${JSON.stringify(check.errors[0].params)}`);
    if(notificationManagementActions.has(action))return this.notifications.execute(action,args);
    if(action==='models')return this.runner.models();
    if(action==='configuration_list')return {groups:this.configuration.list(),bootstrap:bootstrapSettings};
    if(action==='configuration_get')return this.configuration.get(args.scope);
    if(action==='configuration_update') {
      const saved=this.configuration.update(args.scope,args.patch,{revision:args.revision}),synchronization={gateway:'applied'};
      if(args.scope==='execution') {
        this.runner.toolTimeoutMs=this.config.toolTimeoutMs;
        synchronization.runner=await this.syncConfiguration({force:true})?'applied':'pending';
        void this.dispatcher.drain();
      }
      return {...saved,synchronization};
    }
    if (action==='overview') {
      const runner=await this.runner.ready().catch(()=>({ready:false,reason:'RUNNER_UNAVAILABLE'}));
      return {sampled_at:Date.now(),gateway:{alive:true,resources:await this.metrics.sample()},runner:{...runner,resources:await Promise.resolve(this.runner.metrics?.()).catch(()=>null)},runtime:{paused:this.config.paused,concurrency:this.config.concurrency},...this.store.overview(),invalid_plugins:[...this.store.plugins.invalid,...this.registry.configurationErrors()]};
    }
    if(action==='tasks')return this.store.listTasks(args);
    if(action==='task')return taskDetails(this.store,args.task_id);
    if (action==='business_records') {
      const module=this.registry.get(args.type);
      if (!module.inspectRecords) throw new HttpError(400,'BUSINESS_RECORDS_UNAVAILABLE','该插件使用通用任务结果，请通过 tasks/task 查询结构化结果。');
      return module.inspectRecords(args,{store:this.store});
    }
    if (action==='submit_task') {
      const task=this.store.accept(this.config.clientId ?? 'default',{type:args.type,input:args.input,request_id:args.request_id ?? `management:${randomUUID()}`,...(args.notification_channels!==undefined?{notification_channels:args.notification_channels}:{})});
      void this.dispatcher.drain();return task;
    }
    if(action==='retry') {
      const next=this.store.retry(args.task_id,{itemIds:args.item_ids,notification_channels:args.notification_channels});
      setImmediate(()=>void this.dispatcher.drain());return next;
    }
    if (action==='plugins') return {configured:this.store.plugins.list().map(pluginView),builtin:[...this.registry.modules.values()].filter(module=>!module.definition).map(module=>({type:module.type,version:module.version})),invalid:[...this.store.plugins.invalid,...this.registry.configurationErrors()]};
    if (action==='plugin_get') return pluginView(this.store.plugins.get(args.type));
    if (action==='plugin_connection_initialize') {
      if(!this.store.pluginConnections)throw new HttpError(400,'PLUGIN_CONNECTION_UNAVAILABLE');
      return this.store.pluginConnections.initialize(args.type);
    }
    if (action==='plugin_validate') {this.registry.compileDefinition(args.definition);return {valid:true,...(this.store.pluginConnections?{human_connection_required:true}: {})};}
    if (action==='plugin_save') {
      const saved=this.store.transaction(()=>{
        if(args.revision!==undefined){const current=this.store.db.prepare('SELECT revision FROM platform_plugins WHERE type=?').get(typeof args.definition.type==='string'?args.definition.type:'');if((current?.revision??0)!==args.revision)throw new HttpError(409,'PLUGIN_REVISION_CONFLICT','业务插件已被修改，请重新读取后再保存。');}
        return pluginView(this.store.plugins.save(args.definition));
      });
      return saved.connection&&!saved.connection.ready?{...saved,user_action_required:'可调用 plugin_connection_initialize 初始化缺失入口信息；请到业务插件列表的“配置接入”领取生成的入口密钥或手动配置，完成后单独启用。回调地址和凭证可选，必须由人配置；请勿发送到管理对话。未完成配置或密钥未领取前不能启用、提交任务、试运行或执行定时计划。'}:saved;
    }
    if (action==='plugin_enable') return pluginView(this.store.plugins.setEnabled(args.type,args.enabled));
    if (action==='plugin_execution_update') return pluginView(this.store.transaction(()=>this.store.plugins.setExecution(args.type,args.execution,args.revision)));
    if (action==='plugin_delete') return this.store.transaction(()=>{
      // Pause dependent plans and mark the plugin in one durable transaction.
      this.schedules.disableForPlugin(args.type);
      return this.store.plugins.delete(args.type);
    });
    if (action==='capabilities') return {
      plugin_schema:pluginDefinitionSchema,
      delivery_modes:this.store.pluginConnections?['none']:['none','callback_once'],
      ...(this.store.pluginConnections?{connection_policy:{agent_writable:false,agent_initialize_operation:'plugin_connection_initialize',entry_address_generated:true,entry_key_human_claim_required:true,entry_key_rotation:'human_only',required_for_activation:['entryAddress','entryKey'],human_owned_fields:['entryAddress','entryKey','callbackUrl','callbackToken'],callback_optional:true}}:{}),
      tools:Object.entries(this.registry.catalog.tools ?? {}).map(([name,tool])=>({name,description:tool.description,inputSchema:tool.inputSchema})),
      native:['image_generation','web_search'],
      resources:Object.entries(this.registry.catalog.resources ?? {}).map(([id,resource])=>({id,kind:resource.kind})),
      targets:Object.keys(this.registry.catalog.targets ?? {}),
      compatibility_profiles:Object.entries(this.registry.catalog.profiles ?? {}).map(([type,module])=>({type,tools:Object.keys(module.tools),contract:'Input/output/callback are fixed for the existing integration. Instructions may be edited.'}))
    };
    if(action==='schedule_runs')return this.schedules.runs(args);
    if(action==='schedule_execution')return this.schedules.execution(args.id);
    if (action==='schedules') return this.schedules.list();
    if (action==='schedule_save') return this.schedules.save(args.schedule,Date.now(),{revision:args.revision,notificationRevision:args.notification_revision});
    if (action==='schedule_enable') return this.schedules.setEnabled(args.id,args.enabled);
    if (action==='schedule_delete') return this.schedules.delete(args.id);
    if (action==='runtime_update') {
      if (args.paused===undefined && args.concurrency===undefined) throw fault('INVALID_MANAGEMENT_INPUT');
      await this.execute('configuration_update',{scope:'execution',patch:args});
      return {paused:this.config.paused,concurrency:this.config.concurrency};
    }
    if (action==='service_restart') {
      if (args.service==='runner') await this.runner.restart();
      else {if (!this.restartGateway) throw fault('RESTART_UNAVAILABLE',503);setTimeout(()=>this.restartGateway(),100);}
      return {accepted:true,service:args.service,status:'restart_requested'};
    }
    throw fault('UNKNOWN_OPERATION');
  }
}
