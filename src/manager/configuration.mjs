import {readSystemPrompt} from '../prompts.mjs';
import {ConfigurationStore} from '../configuration/store.mjs';
import {MAX_TIMER_DELAY_MS} from '../config.mjs';
import {reasoningEffortSchema,serviceTierSchema} from '../configuration/agent-settings.mjs';
export function createManagerConfiguration({store,agent,auth}) {
  // ConfigurationStore validates saved records before applying them. Add this
  // newly required field without changing the user's existing settings/revision.
  store.db.exec('CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  store.db.exec("UPDATE platform_settings SET value=json_set(value,'$.values.concurrency',2) WHERE key='configuration:manager' AND json_type(value,'$.values.concurrency') IS NULL");
  const scopes=[{name:'manager',title:'管理 Agent',description:'模型、提示词和超时用于下一轮。管理并发默认 2，最多 5；调整并发和巡检间隔不打断正在执行的轮次。',
    schema:{type:'object',additionalProperties:false,required:['model','timeoutMs','toolTimeoutMs','instructions','inspectionIntervalMs','concurrency'],properties:{reasoningEffort:reasoningEffortSchema,serviceTier:serviceTierSchema,concurrency:{type:'integer',minimum:1,maximum:5,title:'管理并发数'},model:{type:'string',minLength:1,title:'管理模型'},timeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS,title:'管理轮次超时（毫秒）'},toolTimeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS,title:'管理工具超时（毫秒）'},instructions:{type:'string',minLength:1,title:'管理提示词'},inspectionIntervalMs:{type:'integer',minimum:1000,maximum:MAX_TIMER_DELAY_MS,title:'巡检轮询间隔（毫秒）'}}},
    defaults:{model:agent.model,serviceTier:'default',concurrency:agent.concurrency??2,timeoutMs:agent.timeoutMs,toolTimeoutMs:agent.toolTimeoutMs,instructions:readSystemPrompt('manager'),inspectionIntervalMs:15000},
    apply({concurrency,serviceTier='default',...value}){Object.assign(agent,{...value,serviceTier});if(agent.setConcurrency)agent.setConcurrency(concurrency);else agent.concurrency=concurrency;}}];
  if(auth)scopes.push({name:'admin',title:'Admin 会话',description:'登录会话有效期用于下一次登录；修改密码通过独立密码操作。',schema:{type:'object',additionalProperties:false,required:['sessionTtlMs'],properties:{sessionTtlMs:{type:'integer',minimum:60000,maximum:MAX_TIMER_DELAY_MS,title:'登录有效期（毫秒）'}}},defaults:{sessionTtlMs:auth.sessionTtlMs},apply(value){auth.sessionTtlMs=value.sessionTtlMs;}});
  return new ConfigurationStore(store.db,scopes);
}
