export const reasoningEffortSchema = {type:['string','null'],pattern:'^[a-z][a-z0-9_]*$',maxLength:40,title:'思考程度'};
export const agentOverridesSchema = {
  type:'object',additionalProperties:false,
  properties:{model:{type:'string',minLength:1,maxLength:200},reasoningEffort:reasoningEffortSchema},
};

export function resolveAgentSettings(defaults, overrides = {}) {
  return {...defaults,...(overrides.model && overrides.model!==defaults.model ? {reasoningEffort:null} : {}),...overrides};
}
