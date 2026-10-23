import Ajv from 'ajv';
import { HttpError } from '../errors.mjs';
import {agentOverridesSchema} from '../configuration/agent-settings.mjs';
export const pluginDefinitionSchema = {
  type:'object', required:['type','name','instructions','input_schema','result_schema','capabilities','delivery'], additionalProperties:false,
  properties:{
    type:{type:'string',pattern:'^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$'},
    name:{type:'string',minLength:1},description:{type:'string'},instructions:{type:'string',minLength:1},
    input_schema:{type:'object'},result_schema:{type:'object'},enabled:{type:'boolean'},
    execution:agentOverridesSchema,
    capabilities:{type:'object',additionalProperties:false,properties:{tools:{type:'array',uniqueItems:true,items:{type:'string'}},image_generation:{type:'boolean'},web_search:{type:'boolean'}}},
    resources:{type:'array',uniqueItems:true,items:{type:'string'}},
    routes:{type:'array',uniqueItems:true,items:{type:'string',pattern:'^/hooks/[a-zA-Z0-9][a-zA-Z0-9/_-]*$'}},
    delivery:{type:'object',properties:{mode:{type:'string',minLength:1},target:{type:'string',minLength:1}},required:['mode'],additionalProperties:false},
  },
};
const check = new Ajv({strict:true}).compile(pluginDefinitionSchema);
export function validateDefinition(definition,catalog={}, {snapshot=false}={}) {
  if (!check(definition)) throw new HttpError(400,'INVALID_PLUGIN',`INVALID_PLUGIN: ${check.errors[0].instancePath || '/'} ${check.errors[0].message} ${JSON.stringify(check.errors[0].params)}`);
  const profile=catalog.profiles?.[definition.type];
  profile?.validateDefinition?.(definition);
  if ((definition.routes ?? []).some(path=>(catalog.reservedRoutes ?? []).includes(path))) throw new HttpError(409,'INVALID_PLUGIN','INVALID_PLUGIN: route is reserved by an existing integration.');
  if (!['none','callback_once',...(profile?.deliveryModes ?? [])].includes(definition.delivery.mode)) throw new HttpError(400,'INVALID_PLUGIN',`INVALID_PLUGIN: unknown delivery mode ${definition.delivery.mode}`);
  for (const name of definition.capabilities.tools ?? [])
    if (!Object.hasOwn(catalog.tools ?? {},name) && !Object.hasOwn(profile?.tools ?? {},name)) throw new HttpError(400,'CAPABILITY_UNAVAILABLE',`CAPABILITY_UNAVAILABLE: ${name}`);
  for (const name of definition.resources ?? [])
    if (!Object.hasOwn(catalog.resources ?? {},name)) throw new HttpError(400,'RESOURCE_UNAVAILABLE',`RESOURCE_UNAVAILABLE: ${name}`);
  if (definition.delivery.mode==='callback_once' && !definition.delivery.target) throw new HttpError(400,'INVALID_PLUGIN','INVALID_PLUGIN: callback_once requires target.');
  if (!snapshot && !catalog.requirePluginConnections && definition.delivery.mode === 'callback_once' && !Object.hasOwn(catalog.targets ?? {},definition.delivery.target))
    throw new HttpError(400,'TARGET_UNAVAILABLE',`TARGET_UNAVAILABLE: ${definition.delivery.target}`);
  if (!snapshot && definition.delivery.mode!=='none' && !profile?.delivery && typeof catalog.delivery!=='function') throw new HttpError(400,'DELIVERY_UNAVAILABLE',`DELIVERY_UNAVAILABLE: ${definition.delivery.mode}`);
  return structuredClone({...definition,enabled:definition.enabled ?? true,resources:definition.resources ?? []});
}
