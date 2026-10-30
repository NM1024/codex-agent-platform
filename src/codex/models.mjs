import {CodexRpcClient} from './rpc.mjs';
import {initialize} from './session.mjs';
import {HttpError} from '../errors.mjs';

export async function readModels(client) {
  await initialize(client);
  const models=new Map(),seen=new Set();
  let cursor;
  do {
    const page=await client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
    if(!Array.isArray(page.data))throw new HttpError(503,'MODEL_CATALOG_UNAVAILABLE','模型列表暂不可用。');
    for(const item of page.data) {
      if(item.hidden||typeof item.model!=='string')continue;
      models.set(item.model,{
        model:item.model,displayName:item.displayName ?? item.model,
        defaultReasoningEffort:item.defaultReasoningEffort ?? null,
        supportedReasoningEfforts:(item.supportedReasoningEfforts ?? []).filter(value=>typeof value.reasoningEffort==='string'),
        serviceTiers:(item.serviceTiers ?? []).filter(value=>typeof value.id==='string').map(({id,name,description})=>({id,name:name ?? id,...(typeof description==='string'?{description}:{})})),
        isDefault:item.isDefault===true,
      });
    }
    cursor=page.nextCursor;
    if(cursor && (seen.has(cursor)||seen.size>=100))throw new HttpError(503,'MODEL_CATALOG_UNAVAILABLE','模型列表分页异常。');
    seen.add(cursor);
  } while(cursor);
  return [...models.values()];
}

export async function validateModelEffort(client,settings) {
  return (await validateModelExecution(client,{...settings,serviceTier:'default'})).effort;
}

export async function validateModelExecution(client,settings) {
  const serviceTier=settings.serviceTier ?? 'default';
  if(!['default','priority'].includes(serviceTier))throw new HttpError(400,'UNSUPPORTED_SERVICE_TIER','请选择普通模式或快速模式。');
  if(settings.reasoningEffort===undefined && serviceTier==='default')return {effort:null,serviceTier};
  const models=await readModels(client),model=models.find(item=>item.model===settings.model);
  if(serviceTier==='priority'&&!model?.serviceTiers.some(tier=>tier.id==='priority'))throw new HttpError(400,'UNSUPPORTED_SERVICE_TIER','所选模型暂不支持快速模式，请选择普通模式或其他模型。');
  if(settings.reasoningEffort===undefined)return {effort:null,serviceTier};
  if(settings.reasoningEffort===null) {
    if(!model)throw new HttpError(400,'MODEL_UNAVAILABLE','所选模型不在当前模型列表中，请重新选择。');
    return {effort:model.defaultReasoningEffort,serviceTier};
  }
  if(!model || !model.supportedReasoningEfforts.some(item=>item.reasoningEffort===settings.reasoningEffort))
    throw new HttpError(400,'UNSUPPORTED_REASONING_EFFORT','所选模型不支持该思考程度，请重新选择。');
  return {effort:settings.reasoningEffort,serviceTier};
}

export function createModelCatalog({createClient=options=>new CodexRpcClient(options),env,now=Date.now}={}) {
  let cached,expires=0,pending;
  return async()=>{
    if(cached && now()<expires)return cached;
    if(!pending)pending=(async()=>{
      const client=createClient({...(env?{env}:{}),timeoutMs:10000});
      try {const models=await readModels(client);cached={models};expires=now()+60000;return cached;}
      catch {throw new HttpError(503,'MODEL_CATALOG_UNAVAILABLE','模型列表暂不可用，请检查 Codex 登录和服务连接。');}
      finally {await client.close();}
    })().finally(()=>{pending=null;});
    return pending;
  };
}
