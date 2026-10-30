export const channelIdsSchema={type:'array',uniqueItems:true,maxItems:32,items:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'}};
export const notificationContextSchema={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100},before:{type:'string',maxLength:300}}};
export const notificationSendSchema={type:'object',additionalProperties:false,required:['notification_key','deliveries'],properties:{notification_key:{type:'string',minLength:1,maxLength:128},deliveries:{type:'array',minItems:1,maxItems:32,items:{type:'object',additionalProperties:false,required:['channel_id','body'],properties:{channel_id:channelIdsSchema.items,body:{}}}}}};
export const notificationToolNames=['notification_context','send_notification'];
// Global channel maintenance is management-only, never an execution capability.
export const notificationChannelWriteTools=new Set(['notification_channel_save','notification_channel_delete']);
export const notificationChannelSchema={type:'object',additionalProperties:false,properties:{
  id:channelIdsSchema.items,name:{type:'string',minLength:1,maxLength:200},provider:{enum:['feishu','wecom','dingtalk','slack','discord','custom']},
  description:{type:'string',maxLength:8192},instructions:{type:'string',maxLength:16384},enabled:{type:'boolean'},
  url:{type:'string',minLength:1,maxLength:8192},token:{type:'string',maxLength:8192},signingSecret:{type:'string',maxLength:8192},
  headers:{type:'object',maxProperties:32,propertyNames:{maxLength:128},additionalProperties:{type:'string',maxLength:8192}},timeoutMs:{type:'integer',minimum:100,maximum:120000},
}};
