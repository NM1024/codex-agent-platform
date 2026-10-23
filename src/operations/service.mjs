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

const fault=(code,status=400)=>new HttpError(status,code,code);
export class OperationsService {
  constructor({store,registry=store.registry,config,dispatcher,runner,restartGateway,configuration}) {
    Object.assign(this,{store,registry,config,dispatcher,runner,restartGateway});
    this.configuration=configuration ?? new ConfigurationStore(store.db,[executionScope({store,config})]);
    this.schedules=new ScheduleStore(store,{clientId:config.clientId ?? 'default'});
    this.metrics=new ResourceSampler({diskPath:config.workspace ?? '/data'});
    const ajv=new Ajv({strict:true});this.checks=new Map(managementTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
  }
  async execute(action,args={}) {
    const pluginView=definition=>this.store.pluginConnections?{...definition,connection:this.store.pluginConnections.status(definition.type)}:definition;
    if(action==='inspection_list')return this.schedules.pendingInspections();
    if(action==='inspection_ack')return this.schedules.acknowledgeInspection(args.id,args.conversation_id);
    const check=this.checks.get(action);
    if (!check) throw new HttpError(400,'INVALID_MANAGEMENT_INPUT','未知管理操作。');
    if (!check(args)) throw new HttpError(400,'INVALID_MANAGEMENT_INPUT',`${check.errors[0].instancePath || '/'} ${check.errors[0].message} ${JSON.stringify(check.errors[0].params)}`);
    if(action==='models')return this.runner.models();
    if(action==='configuration_list')return {groups:this.configuration.list(),bootstrap:bootstrapSettings};
    if(action==='configuration_get')return this.configuration.get(args.scope);
    if(action==='configuration_update') {
      const saved=this.configuration.update(args.scope,args.patch),synchronization={gateway:'applied'};
      if(args.scope==='execution') {
        this.runner.toolTimeoutMs=this.config.toolTimeoutMs;
        try{await this.runner.configure?.({concurrency:this.config.concurrency,...runtimeSettings(this.config)});synchronization.runner='applied';}catch{synchronization.runner='pending';}
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
      const task=this.store.accept(this.config.clientId ?? 'default',{type:args.type,input:args.input,request_id:args.request_id ?? `management:${randomUUID()}`});
      void this.dispatcher.drain();return task;
    }
    if(action==='retry') {
      const next=this.store.retry(args.task_id,{itemIds:args.item_ids});
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
      const saved=pluginView(this.store.plugins.save(args.definition));
      return saved.connection&&!saved.connection.ready?{...saved,user_action_required:'可调用 plugin_connection_initialize 初始化缺失入口信息；请到业务插件列表的“配置接入”领取生成的入口密钥或手动配置，完成后单独启用。回调地址和凭证可选，必须由人配置；请勿发送到管理对话。未完成配置或密钥未领取前不能启用、提交任务、试运行或执行定时计划。'}:saved;
    }
    if (action==='plugin_enable') return pluginView(this.store.plugins.setEnabled(args.type,args.enabled));
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
    if (action==='schedules') return this.schedules.list();
    if (action==='schedule_save') return this.schedules.save(args.schedule);
    if (action==='schedule_enable') return this.schedules.setEnabled(args.id,args.enabled);
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
