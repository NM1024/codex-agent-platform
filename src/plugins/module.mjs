import {renderSystemPrompt} from '../prompts.mjs';
import { HttpError } from '../errors.mjs';
export function createConfiguredModule(definition,catalog={}) {
  const profile=catalog.profiles?.[definition.type];
  const tools=Object.fromEntries((definition.capabilities.tools ?? []).map(name=>[name,catalog.tools?.[name] ?? profile?.tools?.[name]]));
  return {
    ...(profile ?? {}),
    type:definition.type,version:'configuration-v1',definition,
    inputSchema:definition.input_schema,resultSchema:definition.result_schema,tools,
    processors:{...catalog.processors,...profile?.processors},
    availability(state) {
      if (profile?.availability) return profile.availability(state);
      if (!state.ready) return state;
      if (definition.capabilities.image_generation && !state.imageGeneration) return {ready:false,reason:'IMAGE_GENERATION_UNAVAILABLE'};
      return state;
    },
    buildTask(input) {
      return {
        prompt:renderSystemPrompt('task',{plugin_instructions:definition.instructions,input_json:JSON.stringify(input),result_schema_json:JSON.stringify(definition.result_schema)}),
        native:{imageGeneration:definition.capabilities.image_generation === true,webSearch:definition.capabilities.web_search === true},
        tools:[...Object.keys(tools),'complete_task'],
        inputAttachments:(definition.resources ?? []).filter(id=>catalog.resources[id].kind==='image').map(id=>({type:'localImage',path:catalog.resources[id].path})),
      };
    },
    runtimeScope(state) {return profile?.runtimeScope?.(state) ?? catalog.scope?.({...state,definition}) ?? {readRoots:[state.workDir],referenceFiles:[]};},
    async validateResult(result,context) {if (profile?.validateResult)return profile.validateResult(result,context);if (catalog.validateResult) await catalog.validateResult(result,context);return result;},
    delivery:profile?profile.delivery:definition.delivery.mode==='none' ? undefined : catalog.delivery?.(definition.delivery),
    describeError(error) {
      if (profile?.describeError) return profile.describeError(error);
      if (error instanceof HttpError) return {code:error.code,message:error.message,operation_status:'failed',action:'Correct the specified input or inspect the task error.'};
      return undefined;
    },
  };
}
