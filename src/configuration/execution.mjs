import {MAX_TIMER_DELAY_MS,DEFAULT_TOOL_TIMEOUT_MS} from '../config.mjs';
export const executionProperties={
  model:{type:'string',minLength:1,title:'业务模型'},concurrency:{type:'integer',minimum:1,title:'业务并发'},
  paused:{type:'boolean',title:'暂停领取'},queueLimit:{type:'integer',minimum:1,title:'队列上限'},
  taskTimeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS-5000,title:'任务超时（毫秒）'},
  toolTimeoutMs:{type:'integer',minimum:1,maximum:MAX_TIMER_DELAY_MS,title:'工具超时（毫秒）'},
};
export const executionSchema={type:'object',properties:executionProperties,required:Object.keys(executionProperties),additionalProperties:false};
export const runtimeSettings=config=>({model:config.model ?? 'gpt-6.1-sol',taskTimeoutMs:config.taskTimeoutMs ?? 2400000,toolTimeoutMs:config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS});
export function executionScope({store,config}) {
  const legacy=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_settings'").get()?store.db.prepare("SELECT value FROM platform_settings WHERE key='runtime'").get():null;
  return {name:'execution',title:'业务执行',schema:executionSchema,
    description:'调度设置立即生效。模型和超时用于下一次启动/恢复，不中断当前执行。',
    defaults:{...runtimeSettings(config),concurrency:config.concurrency ?? 1,paused:config.paused ?? false,queueLimit:config.queueLimit ?? 10000,...(legacy?JSON.parse(legacy.value):{})},
    apply(values){Object.assign(config,values);store.queueLimit=values.queueLimit;}};
}
