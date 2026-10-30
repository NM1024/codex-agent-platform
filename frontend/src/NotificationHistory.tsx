import {Collapse,Empty,Tag,Typography} from 'antd';
import {useConsole} from './context';
import {time} from './components';
import type {NotificationHistory as History} from './notification-types';
import './notification-i18n';
import './notification.css';
export function NotificationHistory({history,showHeading=true}:{history?:History;showHeading?:boolean}) {
  const {t}=useConsole();
  return <div className={showHeading?"notification-history":"notification-history notification-history-standalone"}>{showHeading&&<Typography.Title level={4}>{t('通知记录')}</Typography.Title>}
    {!history?.items.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('暂无通知记录')}/>:<Collapse items={history.items.map(batch=>({key:batch.batch_id,label:<span className="notification-batch-label"><span>{batch.notification_key}</span><span>{time(batch.created_at)}</span></span>,children:<div className="notification-deliveries">{batch.deliveries.map(delivery=><article className="notification-delivery" key={delivery.channel_id}>
      <div className="notification-row-title"><Typography.Text strong>{delivery.channel_name||delivery.channel_id}</Typography.Text><Tag color={delivery.status==='accepted'?'success':['rejected','unavailable'].includes(delivery.status)?'error':'warning'}>{t('通知状态：'+delivery.status)}</Tag></div>
      <Typography.Paragraph type="secondary">{delivery.provider} · HTTP {delivery.http_status??'—'} · {t('厂商码')} {delivery.provider_code??'—'}</Typography.Paragraph>
      <Typography.Paragraph>{delivery.summary}</Typography.Paragraph>
      <details><summary>{t('查看消息内容')}</summary><pre className="notification-json">{JSON.stringify(delivery.body,null,2)}</pre></details>
    </article>)}</div>}))}/>}
    {history?.next_cursor&&<Typography.Paragraph type="secondary">{t('这里只显示最近的通知记录。')}</Typography.Paragraph>}
    <Typography.Paragraph type="secondary">{t('接收确认不代表已读；结果未知时请核查接收端，不会自动重发。')}</Typography.Paragraph>
  </div>;
}
