import type {AgentSettings,Values} from './types';

export const modelOptionKeys=['verbosity','reasoningSummary','autoCompactTokenLimit','toolOutputTokenLimit'] as const;
export const agentSettingKeys=['model','reasoningEffort','serviceTier',...modelOptionKeys] as const;
export const tokenLimitMaximum=2147483647;
export const budgetSettings={
  autoCompactTokenLimit:{minimum:1024,suggestion:65536},
  toolOutputTokenLimit:{minimum:256,suggestion:8192},
} as const;

export function agentSettingsFromValues(values:Values,summary:NonNullable<AgentSettings['reasoningSummary']>='auto'):AgentSettings {
  return {
    ...(typeof values.model==='string'?{model:values.model}:{}),
    ...(typeof values.reasoningEffort==='string'||values.reasoningEffort===null?{reasoningEffort:values.reasoningEffort}:{}),
    serviceTier:values.serviceTier==='priority'?'priority':'default',
    verbosity:values.verbosity==='low'||values.verbosity==='high'?values.verbosity:'medium',
    reasoningSummary:['auto','concise','detailed','none'].includes(String(values.reasoningSummary))?values.reasoningSummary as AgentSettings['reasoningSummary']:summary,
    autoCompactTokenLimit:typeof values.autoCompactTokenLimit==='number'?values.autoCompactTokenLimit:null,
    toolOutputTokenLimit:typeof values.toolOutputTokenLimit==='number'?values.toolOutputTokenLimit:null,
  };
}

export function changeAgentModel(value:AgentSettings,model:string|undefined,inherit:boolean):AgentSettings {
  const next={...value};
  delete next.model;delete next.reasoningEffort;
  if(model)next.model=model;
  if(!inherit)next.reasoningEffort=null;
  return next;
}
