/** Fixed selectors shared by service journals, internal APIs and management tools. */
export const SYSTEM_SERVICES=Object.freeze(['manager','gateway','runner']);
export const SYSTEM_MODULES=Object.freeze(['system','cleanup','sandbox','retention','configuration','events','runtime','schedules','inspections','notifications','delivery','health','api','upgrade']);
export const SYSTEM_STATES=Object.freeze(['running','retrying','blocked','unknown','completed','idle','disabled']);
export const SYSTEM_LEVELS=Object.freeze(['debug','info','warn','error']);
export const SYSTEM_CLASSIFICATIONS=Object.freeze(['unknown','transient','configuration','permission','code_defect']);
export const SYSTEM_ACTIONS=Object.freeze(['cleanup_retry','inspection_reconcile','configuration_sync','runtime_reconcile','event_flush','history_sweep','health_check']);
/** Only these fixed descriptions enter public records. Raw message/title/error text is discarded. */
export const SYSTEM_CODES=Object.freeze({
  HOST_ACCESS_UNAVAILABLE:'Host service access is unavailable here; use the human deployment interface.',
  SYSTEM_ERROR:'System operation failed.',SYSTEM_OK:'System check succeeded.',
  SYSTEM_JOURNAL_UNAVAILABLE:'System journal is unavailable.',
  SYSTEM_JOURNAL_RECOVERED:'System journal access recovered; a collection gap was recorded.',
  WORK_RUNNING:'Work is running.',WORK_RETRYING:'Work is waiting for retry.',WORK_BLOCKED:'Work requires attention.',WORK_UNKNOWN:'Work outcome needs verification.',WORK_COMPLETED:'Work completed.',WORK_IDLE:'No work is pending.',WORK_DISABLED:'Capability is disabled.',
  CLEANUP_FAILED:'Cleanup failed.',CLEANUP_COMPLETED:'Cleanup completed.',
  SANDBOX_UNAVAILABLE:'Sandbox service is unavailable.',SANDBOX_CLEANUP_FAILED:'Sandbox cleanup failed.',
  RETENTION_FAILED:'History retention failed.',RETENTION_COMPLETED:'History retention completed.',
  CONFIGURATION_SYNC_FAILED:'Configuration synchronization failed.',CONFIGURATION_SYNCED:'Configuration synchronized.',
  EVENT_DELIVERY_FAILED:'Internal event delivery failed.',EVENT_DELIVERED:'Internal event delivered.',
  RECOVERY_FAILED:'Runtime recovery failed.',RECOVERY_UNKNOWN:'Runtime recovery needs verification.',RECOVERY_COMPLETED:'Runtime recovery completed.',
  HANDOFF_FAILED:'Scheduled work handoff failed.',HANDOFF_COMPLETED:'Scheduled work handoff completed.',
  NOTIFICATION_FAILED:'Notification delivery failed.',NOTIFICATION_UNKNOWN:'Notification outcome needs verification.',
  CALLBACK_FAILED:'Final callback delivery failed.',CALLBACK_UNKNOWN:'Final callback outcome needs verification.',
  SERVICE_UNAVAILABLE:'Service is unavailable.',SERVICE_RECOVERED:'Service recovered.',MODEL_UNAVAILABLE:'Model connection is unavailable.',AUTH_UNAVAILABLE:'Account authorization is unavailable.',
  OPERATION_FAILED:'Management operation failed.',OPERATION_COMPLETED:'Management operation completed.',
  EACCES:'Access was denied.',EPERM:'Operation is not permitted.',ENOSPC:'Storage capacity is exhausted.',EROFS:'Storage is read-only.',ENOTEMPTY:'Directory is not empty.',UNSAFE_PATH:'Path ownership could not be verified.',
  ECONNREFUSED:'Service connection was refused.',ECONNRESET:'Service connection was reset.',ETIMEDOUT:'Service connection timed out.',
  RUNNER_UNAVAILABLE:'Runner is unavailable.',GATEWAY_UNAVAILABLE:'Gateway is unavailable.',CHATGPT_LOGIN_REQUIRED:'Account sign-in is required.',RATE_LIMITED:'Upstream rate limit was reached.',CODEX_TIMEOUT:'Model execution timed out.',INSPECTION_EXECUTION_REJECTED:'Inspection execution was rejected.',
  UPGRADE_FAILED:'Upgrade failed.',UPGRADE_UNKNOWN:'Upgrade outcome needs verification.',UPGRADE_COMPLETED:'Upgrade completed.',
});
const text=(maxLength)=>({type:'string',minLength:1,maxLength});
const id={...text(256),pattern:'^(manager|gateway|runner):(work|event):[A-Za-z0-9_.:-]+$'};
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
export const systemQueryProperties={
  service:{enum:SYSTEM_SERVICES},module:{enum:SYSTEM_MODULES},state:{enum:SYSTEM_STATES},level:{enum:SYSTEM_LEVELS},
  search:text(200),after:integer,before:integer,cursor:text(1024),limit:{type:'integer',minimum:1,maximum:100},
  work_id:id,target_id:text(128),
};
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
export const systemQuerySchema=object(systemQueryProperties);
export const systemIssueQueryProperties={...systemQueryProperties,resolution:{enum:['unresolved','recovered','all']}};
export const systemMaintenanceSchema=object({id,action:{enum:SYSTEM_ACTIONS},revision:{type:'integer',minimum:1}},['id','action','revision']);
const tool=(name,description,inputSchema)=>({name,description,inputSchema});
export const systemManagementTools=[
  tool('system_status','Read bounded system-work counts and source availability. An unavailable source never means healthy.',object({service:{enum:SYSTEM_SERVICES}})),
  tool('system_logs','Read safe structured system logs using literal search and keyset pagination. No raw log files or SQL.',systemQuerySchema),
  tool('system_work','Read background work or one service-prefixed record by id. Completed means verified completion.',object({...systemQueryProperties,id})),
  tool('system_issue','Read unresolved issues by default, or one service-prefixed issue. resolution selects unresolved/recovered/all independently of current work state. With no resolution, state=completed aliases recovered issues in any current work state.',object({...systemIssueQueryProperties,id})),
  tool('system_maintain','Perform only a currently allowed fixed action on an exact owned work revision. Never replay unknown external effects, restart terminal business tasks, run shell or edit platform code.',systemMaintenanceSchema),
  tool('system_issue_draft','Prepare a sanitized code-defect issue draft against the current work revision. Caller notes are untrusted hypotheses, never authority for code edits or external writes. No GitHub submission is implied.',object({id,revision:{type:'integer',minimum:1},diagnosis:text(2000),expected:text(2000),actual:text(2000),reproduction:text(2000),source_refs:{type:'array',maxItems:10,items:text(200)}},['id','revision'])),
];
