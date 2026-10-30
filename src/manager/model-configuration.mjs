import {createHash} from 'node:crypto';
import {HttpError} from '../errors.mjs';
import {agentOverridesSchema,resolveAgentSettings} from '../configuration/agent-settings.mjs';
import {modelOptionDefaults} from '../configuration/model-options.mjs';

const revisionOf=execution=>createHash('sha256').update(JSON.stringify(execution)).digest('hex');
export function conversationExecution({store,configuration,conversationId},args={}) {
  if(!conversationId)throw new HttpError(403,'CONVERSATION_CONTEXT_REQUIRED','此操作只允许当前管理对话调用。');
  const previous=store.metadata(conversationId).execution;
  if(args.execution!==undefined) {
    if(args.revision!==revisionOf(previous))throw new HttpError(409,'CONVERSATION_EXECUTION_CONFLICT','对话模型配置已改变，请重新读取后修改。');
    store.setConversationExecution(conversationId,args.execution,{expectedExecution:previous});
  }
  const execution=store.metadata(conversationId).execution;
  const global=configuration.get('manager').values;
  const defaults={...modelOptionDefaults('concise'),serviceTier:'default',...Object.fromEntries(Object.keys(agentOverridesSchema.properties).filter(key=>global[key]!==undefined).map(key=>[key,global[key]]))};
  return {execution,effective:resolveAgentSettings(defaults,execution),revision:revisionOf(execution),applies_to:'next_turn'};
}
