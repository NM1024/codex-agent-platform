// Shared across global settings and overrides. Omitted overrides inherit;
// explicit null budgets choose the model's automatic value.
export const modelOptionProperties = {
  verbosity: {type:'string',enum:['low','medium','high'],title:'回复详细程度',description:'默认为 medium；控制回复详细倾向，实际效果取决于模型能力，并非硬长度限制。覆盖省略时继承全局，用于下一次启动/恢复或管理轮次。'},
  reasoningSummary: {type:'string',enum:['auto','concise','detailed','none'],title:'公开思考摘要',description:'管理默认 concise，业务默认 auto；只影响公开摘要，不改变思考强度。覆盖省略时继承全局，用于下一次启动/恢复或管理轮次。'},
  autoCompactTokenLimit: {type:['integer','null'],minimum:1024,maximum:2147483647,title:'自动压缩 Token 阈值',description:'默认为 null，跟随模型自动阈值；手动阈值不会扩展真实上下文上限。覆盖省略时继承全局，显式 null 恢复自动，用于下一次启动/恢复或管理轮次。'},
  toolOutputTokenLimit: {type:['integer','null'],minimum:256,maximum:2147483647,title:'工具输出 Token 预算',description:'默认为 null，跟随模型自动预算；过小可能截断重要工具信息。覆盖省略时继承全局，显式 null 恢复自动，用于下一次启动/恢复或管理轮次。'},
};

export function modelOptionDefaults(summary = 'auto') {
  return {verbosity:'medium',reasoningSummary:summary,autoCompactTokenLimit:null,toolOutputTokenLimit:null};
}

export function codexModelOptions(settings = {}) {
  return {
    model_verbosity: settings.verbosity ?? 'medium',
    model_reasoning_summary: settings.reasoningSummary ?? 'auto',
    // Codex 0.159.2 expects i64, and rejects JSON null for these keys.
    ...(settings.autoCompactTokenLimit != null ? {model_auto_compact_token_limit:settings.autoCompactTokenLimit} : {}),
    ...(settings.toolOutputTokenLimit != null ? {tool_output_token_limit:settings.toolOutputTokenLimit} : {}),
  };
}
