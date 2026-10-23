import { validateUrl } from '../config.mjs';
import { HttpError } from '../errors.mjs';
export function httpConfiguration(targets,{name='http',initialTargets}={}) {
  return {name,title:'HTTP 目标',requireRevision:name==='http_targets',description:'供 Agent 主动请求网站或接口使用，与插件入口和结果回调独立。保存后下一次工具调用立即使用新配置，不会自动发送请求。省略 token 保留凭证，空字符串清除凭证。',
    schema:{type:'object',additionalProperties:false,required:['targets'],properties:{targets:{type:'object',additionalProperties:{type:'object',additionalProperties:false,required:['url'],properties:{url:{type:'string',title:'目标地址'},token:{type:'string',writeOnly:true,title:'凭证'},timeoutMs:{type:'integer',minimum:1,maximum:2147483647,title:'超时（毫秒）'}}}}}},defaults:initialTargets?()=>({targets:initialTargets()}):{targets},
    validate(value){try{loadTargets({PLATFORM_HTTP_TARGETS_JSON:JSON.stringify(value.targets)});}catch{throw new HttpError(400,'INVALID_CONFIGURATION','HTTP 目标名称、地址、凭证或超时不正确。');}},
    apply(value){for(const key of Object.keys(targets))delete targets[key];for(const [key,target]of Object.entries(value.targets))Object.defineProperty(targets,key,{value:target,enumerable:true,writable:true,configurable:true});}};
}
export function loadTargets(env=process.env) {
  const targets=JSON.parse(env.PLATFORM_HTTP_TARGETS_JSON || '{}');
  if (!targets || Array.isArray(targets) || typeof targets!=='object') throw new Error('Invalid configuration: PLATFORM_HTTP_TARGETS_JSON');
  for (const [name,target] of Object.entries(targets)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !target || typeof target.url!=='string') throw new Error('Invalid configuration: PLATFORM_HTTP_TARGETS_JSON');
    validateUrl(target.url,'PLATFORM_HTTP_TARGETS_JSON');
    if (target.token!==undefined && (typeof target.token!=='string' || /[\r\n]/.test(target.token))) throw new Error('Invalid configuration: PLATFORM_HTTP_TARGETS_JSON');
    if (target.timeoutMs!==undefined && (!Number.isSafeInteger(target.timeoutMs) || target.timeoutMs<1 || target.timeoutMs>2147483647)) throw new Error('Invalid configuration: PLATFORM_HTTP_TARGETS_JSON');
  }
  return targets;
}
