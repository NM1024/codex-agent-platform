const string={type:'string'},id={type:'string',pattern:'^[a-f0-9-]{36}$'};
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,properties={},required=[])=>({name,description,inputSchema:object(properties,required)});
export const managementTools=[
  tool('overview','Read current gateway/runner health, execution queue, failures and delivery statistics.'),
  tool('models','List available Codex models and their supported reasoning efforts. Does not start a model turn.'),
  tool('tasks','List task metadata. Filter by status/type/time or search input data. completed means execution completed, not every business item succeeded.',{status:string,type:string,search:string,after:{type:'integer'},before:{type:'integer'},limit:{type:'integer',minimum:1,maximum:200},offset:{type:'integer',minimum:0}}),
  tool('task','Read one task including input, result, concrete errors, runtime and delivery records.',{task_id:id},['task_id']),
  tool('business_records','Query business-item records when an integration supplies them. Historical failures do not imply the latest attempt still failed. latest_only selects each item\'s latest attempt; this does not query the upstream business database.',{type:string,status:string,search:string,latest_only:{type:'boolean'},after:{type:'integer'},before:{type:'integer'},limit:{type:'integer',minimum:1,maximum:200},offset:{type:'integer',minimum:0}},['type']),
  tool('submit_task','Submit a new independent task, including a plugin trial. Uses the same API contract as external requests.',{type:string,input:{},request_id:string},['type','input']),
  tool('retry','Explicitly submit a new task related to an ended task. Keeps history. item_ids can select business items when its compatibility adapter supports that.',{task_id:id,item_ids:{type:'array',items:string,minItems:1}},['task_id']),
  tool('plugins','List configured plugins, builtin compatibility modules and configuration errors.'),
  tool('plugin_get','Read a complete plugin definition.',{type:string},['type']),
  tool('plugin_validate','Validate a JSON plugin definition and its capability references without saving.',{definition:{type:'object'}},['definition']),
  tool('plugin_save','Create/update a JSON-only plugin. Read capabilities first. No code, scripts or executable hooks.',{definition:{type:'object'}},['definition']),
  tool('plugin_enable','Enable or disable new requests for a plugin. Existing tasks keep their snapshots.',{type:string,enabled:{type:'boolean'}},['type','enabled']),
  tool('capabilities','List available tools with schemas, resource IDs and configured target names; credentials are never returned.'),
  tool('schedules','List persistent schedules and blocked reasons.'),
  tool('schedule_save','Save a schedule. schedule: name, kind=task or inspection, cron=five fields, timezone=IANA (default Asia/Shanghai), enabled; task needs type/input, inspection needs message; optional id updates an existing plan.',{schedule:{type:'object'}},['schedule']),
  tool('schedule_enable','Enable or disable a schedule.',{id,enabled:{type:'boolean'}},['id','enabled']),
  tool('runtime_update','Change persisted queue pause/concurrency. Does not kill existing running tasks.',{paused:{type:'boolean'},concurrency:{type:'integer',minimum:1}}),
  tool('configuration_list','List live configuration groups, schemas, configured-secret flags and bootstrap-only deployment settings. Never returns secret values.'),
  tool('configuration_get','Read one configuration group. Omitted secret fields mean keep current credentials when saving.',{scope:string},['scope']),
  tool('configuration_update','Persist and apply a partial configuration group. Read its schema first. Omit secrets to preserve them; use an explicit empty value only if clearing is allowed. Does not interrupt active work.',{scope:string,patch:{type:'object'}},['scope','patch']),
  tool('admin_password_set','Change the independent Admin password after verifying currentPassword and revoke existing web sessions. Both passwords are write-only.',{currentPassword:{type:'string',maxLength:1024},password:{type:'string',minLength:12,maxLength:1024}},['currentPassword','password']),
  tool('service_restart','Request a graceful gateway or runner restart; then check overview to verify recovery.',{service:{enum:['gateway','runner']}},['service']),
];
