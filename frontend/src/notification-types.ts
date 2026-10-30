export const notificationProviders=['feishu','wecom','dingtalk','slack','discord','custom'] as const;
export type NotificationProvider=typeof notificationProviders[number];
export interface NotificationChannel {
  id:string;name:string;provider:NotificationProvider;description:string;instructions:string;enabled:boolean;revision:number;timeoutMs?:number;deleted?:boolean;
  configured:{url:boolean;token:boolean;headers:boolean;signingSecret:boolean};
  format:{instructions:string;example:unknown};
}
export interface NotificationDelivery {channel_id:string;channel_name:string;provider:NotificationProvider;status:string;http_status:number|null;provider_code:string|number|null;summary:string;body:unknown;created_at:number|string;updated_at:number|string}
export interface NotificationBatch {batch_id:string;notification_key:string;status:string;created_at:number|string;deliveries:NotificationDelivery[]}
export interface NotificationHistory {items:NotificationBatch[];next_cursor:string|null}
export interface NotificationBindingView {notification_channels:string[];notification_revision:number;channels:NotificationChannel[];available_channels:NotificationChannel[];history?:NotificationHistory}
export const providerLabel:Record<NotificationProvider,string>={feishu:'飞书 / Lark',wecom:'企业微信',dingtalk:'钉钉',slack:'Slack',discord:'Discord',custom:'自定义 JSON Webhook'};
