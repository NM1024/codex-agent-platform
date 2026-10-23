import { validateUrl } from '../config.mjs';
import { HttpError } from '../errors.mjs';
export function httpConfiguration(targets) {
  return {name:'http',title:'HTTP 目标',description:'下一工具调用或尚未发送的交付使用新目标；省略已有目标的 token 保留凭证，删除目标名称则移除目标。',
    schema:{type:'object',additionalProperties:false,required:['targets'],properties:{targets:{type:'object',additionalProperties:{type:'object',additionalProperties:false,required:['url'],properties:{url:{type:'string',title:'目标地址'},token:{type:'string',writeOnly:true,title:'凭证'},timeoutMs:{type:'integer',minimum:1,maximum:2147483647,title:'超时（毫秒）'}}}}}},defaults:{targets},
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
