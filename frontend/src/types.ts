export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type Values = Record<string, Json | undefined>;
export interface AgentSettings {model?:string;reasoningEffort?:string|null;serviceTier?:'default'|'priority';verbosity?:'low'|'medium'|'high';reasoningSummary?:'auto'|'concise'|'detailed'|'none';autoCompactTokenLimit?:number|null;toolOutputTokenLimit?:number|null}
export interface Model {model:string;displayName:string;defaultReasoningEffort?:string|null;supportedReasoningEfforts:{reasoningEffort:string;description?:string}[];serviceTiers?:{id:string;name:string;description?:string}[]}
export interface Catalog {models:Model[];unavailable?:boolean}
export interface Schema {type?:string|string[];title?:string;writeOnly?:boolean;minLength?:number;minimum?:number;maximum?:number;properties?:Record<string,Schema>}
export interface ConfigGroup {scope:string;title:string;description:string;schema:Schema;values:Values;configured_secrets:string[];revision:number;updated_at:number;error?:{message:string}}
export interface PluginConnectionStatus {ready:boolean;entryPath:string|null;entryAddress?:string|null;entryKeyClaimable?:boolean;callbackConfigured:boolean;missingFields:string[]}
export interface PluginConnection {type:string;entryAddress:string|null;entryPath:string|null;entryKeyConfigured:boolean;entryKeyClaimable?:boolean;callbackUrl:string|null;callbackTokenConfigured:boolean;ready:boolean;missingFields:string[];revision:number}
export interface Plugin {type:string;name:string;description?:string;instructions:string;enabled?:boolean;connection?:PluginConnectionStatus;execution?:AgentSettings;input_schema:Json;result_schema:Json;capabilities:Json;delivery:Json;resources?:string[];revision?:number;updated_at?:number}
export interface PluginList {configured:Plugin[];builtin?:{type:string;version:string}[];invalid?:Json[]}
export interface PluginIntegration {type:string;name:string;revision?:number;connectionRevision?:number;locale:'en'|'zh-CN';generated_at:number;ready:boolean;sections:{key:string;title:string;markdown:string}[];markdown:string}
export interface Task {notification_channels?:string[];notification_revision?:number;task_id:string;type:string;status:string;request_id?:string;error?:{code:string;message?:string};created_at:number;updated_at:number;input?:Json;artifacts?:Artifact[]}
export interface Artifact {artifact_id:string;filename?:string;mime?:string}
export interface ChatImage {id:string;name:string;dataUrl:string;size:number;width:number;height:number}
export interface ChatFile {id:string;file:File;uploaded?:Record<string,SandboxAttachment>}
export interface SandboxAttachment {file_id:string;name:string;mime:string;size:number;url:string;preview_url?:string|null;origin:'upload'|'sandbox';message_id?:string|null}
export interface SandboxPermission {id:string;message_id:string;request_key:string;status:'pending'|'approved'|'denied'|'expired'|'revoked'|'consumed';reason:string;command:string;cwd:string;domains:string[];timeout_seconds:number;memory_mb:number;instance_id?:string;revision?:number;created_at:number;expires_at:number;execution_id?:string;continuation_message_id?:string}
export interface SandboxJob {execution_id:string;message_id?:string;request_key:string;instance_id:string;status:'running'|'completed'|'failed'|'cancelled'|'unknown';stdout:string;stderr:string;stdout_truncated?:boolean;stderr_truncated?:boolean;exit_code:number|null;reason?:string;created_at:number;completed_at?:number;timeout_seconds:number;memory_mb:number}
export interface SandboxContext {available:boolean;exists:boolean;reason?:string;files:SandboxAttachment[];permissions:SandboxPermission[];executions:SandboxJob[]}
export interface MessageImage {id:string;name:string;mime:string;width:number;height:number;size:number;url:string}
export interface MessageActivity {id:string;kind:'reasoning_summary'|'assistant_message'|'tool'|'status';label:string;text:string;status:string;created_at:number;updated_at:number}
export interface ReplyItem {id:string;text:string;status:string;created_at:number;updated_at?:number}
export interface AgentQuestion {id:string;header:string;question:string;isOther:boolean;options:{label:string;description:string}[]}
export interface QuestionRequest {id:string;status:'pending'|'answered'|'expired';questions:AgentQuestion[];answers?:Record<string,{answers:string[]}>|null;created_at:number;updated_at?:number}
export interface QuestionDraft {choices:Record<string,string>;texts:Record<string,string>;pending?:boolean;answered?:boolean;expired?:boolean;error?:string}
export interface Message {id:string;role:string;text:string;status:string;created_at:number;updated_at?:number|null;started_at?:number|null;completed_at?:number|null;reply_to?:string|null;steer_parent_id?:string|null;steerable?:boolean;partial_text?:string|null;replies?:ReplyItem[];questions?:QuestionRequest[];files?:SandboxAttachment[];attachments?:MessageImage[];generated_images?:MessageImage[];activity?:MessageActivity[];error?:{code:string};execution?:AgentSettings}
export interface Action {id:string;name:string;status:string;target?:string;message_id?:string|null;error?:{code:string}}
export interface Conversation {id:string;title:string;execution:AgentSettings;messages?:Message[];queue?:Message[];actions?:Action[];queued_count?:number;running_count?:number;history?:{has_more:boolean;before:string|null}}
export interface Schedule {id?:string;revision?:number;name:string;kind:'task'|'inspection';cron:string;timezone:string;enabled:boolean;type?:string;input?:Json;message?:string;next_run_at?:number;blocked_reason?:string}
export interface Resources {
  sampled_at?:number;
  host?:{available?:boolean;cpu_percent?:number|null;cpu_cores?:number;memory_used_bytes?:number;memory_total_bytes?:number;memory_available_bytes?:number};
  container?:{cpu_percent?:number|null;quota_cores?:number|null;memory_used_bytes?:number;memory_limit_bytes?:number|null};
  process?:{pid?:number;memory_rss_bytes?:number};
  disk?:{path?:string;available?:boolean;total_bytes?:number;free_bytes?:number;used_bytes?:number;available_bytes?:number};
}
export interface Overview {sampled_at:number;resources:Resources;investigations?:{task_id:string}[];platform:{unavailable?:boolean;error?:{code?:string;message:string};gateway?:{alive?:boolean};runner?:{ready?:boolean;reason?:string};tasks?:Record<string,number>;runtime?:{paused:boolean;concurrency:number};recent_errors?:Task[]}}
export type View='overview'|'chat'|'tasks'|'plugins'|'schedules'|'settings';
