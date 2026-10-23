export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type Values = Record<string, Json | undefined>;
export interface AgentSettings {model?:string;reasoningEffort?:string|null}
export interface Model {model:string;displayName:string;defaultReasoningEffort?:string|null;supportedReasoningEfforts:{reasoningEffort:string;description?:string}[]}
export interface Catalog {models:Model[];unavailable?:boolean}
export interface Schema {type?:string|string[];title?:string;writeOnly?:boolean;minLength?:number;minimum?:number;maximum?:number;properties?:Record<string,Schema>}
export interface ConfigGroup {scope:string;title:string;description:string;schema:Schema;values:Values;configured_secrets:string[];revision:number;updated_at:number;error?:{message:string}}
export interface Plugin {type:string;name:string;description?:string;instructions:string;enabled?:boolean;execution?:AgentSettings;input_schema:Json;result_schema:Json;capabilities:Json;delivery:Json;resources?:string[];revision?:number;updated_at?:number}
export interface PluginList {configured:Plugin[];builtin?:{type:string;version:string}[];invalid?:Json[]}
export interface Task {task_id:string;type:string;status:string;request_id?:string;error?:{code:string;message?:string};created_at:number;updated_at:number;input?:Json;artifacts?:Artifact[]}
export interface Artifact {artifact_id:string;filename?:string;mime?:string}
export interface Message {id:string;role:string;text:string;status:string;created_at:number;error?:{code:string};execution?:AgentSettings}
export interface Action {id:string;name:string;status:string;target?:string;error?:{code:string}}
export interface Conversation {id:string;title:string;execution:AgentSettings;messages?:Message[];actions?:Action[]}
export interface Schedule {id?:string;name:string;kind:'task'|'inspection';cron:string;timezone:string;enabled:boolean;type?:string;input?:Json;message?:string;next_run_at?:number;blocked_reason?:string}
export interface Resources {sampled_at?:number;host?:{available?:boolean;cpu_percent?:number|null;memory_used_bytes?:number;memory_total_bytes?:number};container?:{memory_used_bytes?:number};disk?:{available_bytes?:number}}
export interface Overview {sampled_at:number;resources:Resources;investigations?:{task_id:string}[];platform:{unavailable?:boolean;error?:{message:string};runner?:{ready:boolean;reason?:string};tasks?:Record<string,number>;runtime?:{paused:boolean;concurrency:number};recent_errors?:Task[]}}
export type View='overview'|'chat'|'tasks'|'plugins'|'schedules'|'settings';
