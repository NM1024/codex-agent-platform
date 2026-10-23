import {readFileSync} from 'node:fs';
import {ConfigurationStore} from '../configuration/store.mjs';
import {MAX_TIMER_DELAY_MS} from '../config.mjs';
export function createManagerConfiguration({store,agent,auth}) {
  const scopes=[{name:'manager',title:'管理 Agent',description:'模型、提示词和超时用于下一轮。巡检轮询间隔动态生效，不打断当前对话。',
    schema:{type:'object',additionalProperties:false,required:['model','timeoutMs','toolTimeoutMs','instructions','inspectionIntervalMs'],properties:{model:{type:'string',minLength:1,title:'管理模型'},timeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS,title:'管理轮次超时（毫秒）'},toolTimeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS,title:'管理工具超时（毫秒）'},instructions:{type:'string',minLength:1,title:'管理提示词'},inspectionIntervalMs:{type:'integer',minimum:1000,maximum:MAX_TIMER_DELAY_MS,title:'巡检轮询间隔（毫秒）'}}},
    defaults:{model:agent.model,timeoutMs:agent.timeoutMs,toolTimeoutMs:agent.toolTimeoutMs,instructions:readFileSync(new URL('./prompt.md',import.meta.url),'utf8'),inspectionIntervalMs:15000},
    apply(value){Object.assign(agent,value);}}];
  if(auth)scopes.push({name:'admin',title:'Admin 会话',description:'登录会话有效期用于下一次登录；修改密码通过独立密码操作。',schema:{type:'object',additionalProperties:false,required:['sessionTtlMs'],properties:{sessionTtlMs:{type:'integer',minimum:60000,maximum:MAX_TIMER_DELAY_MS,title:'登录有效期（毫秒）'}}},defaults:{sessionTtlMs:auth.sessionTtlMs},apply(value){auth.sessionTtlMs=value.sessionTtlMs;}});
  return new ConfigurationStore(store.db,scopes);
}
