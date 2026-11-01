import {Form,Select,Typography} from 'antd';
import {CronExpressionParser} from 'cron-parser';
import {useConsole} from './context';
import {CronPicker} from './CronPicker';

const zones=['Asia/Shanghai','Etc/UTC','Asia/Tokyo','Asia/Singapore','America/Los_Angeles','America/New_York','Europe/London',...Intl.supportedValuesOf('timeZone')];
export function ScheduleTimingFields({cron,timezone,onCron,onTimezone}:{cron:string;timezone:string;onCron:(value:string)=>void;onTimezone:(value:string)=>void}) {
 const {t,locale}=useConsole();
 let preview:{iso:string;label:string}[]=[];
 try{
  if(cron.trim().split(/\s+/).length!==5)throw new Error();
  const iterator=CronExpressionParser.parse(cron,{tz:timezone}),formatter=new Intl.DateTimeFormat(locale,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'});
  preview=Array.from({length:3},()=>{const date=iterator.next().toDate();return {iso:date.toISOString(),label:formatter.format(date)};});
 }catch{}
 return <>
  <Form.Item label={t('Cron 规则')} htmlFor="schedule-cron" required><CronPicker id="schedule-cron" value={cron} onChange={onCron}/></Form.Item>
  <Form.Item label={t('时区')} htmlFor="schedule-timezone" required><Select virtual={false} id="schedule-timezone" showSearch optionFilterProp="label" value={timezone} onChange={onTimezone} options={[...new Set([timezone,...zones])].map(value=>{let offset='';try{offset=new Intl.DateTimeFormat('en',{timeZone:value,timeZoneName:'shortOffset'}).formatToParts().find(part=>part.type==='timeZoneName')?.value??'';}catch{}return {value,label:(value==='Asia/Shanghai'?t('中国标准时间')+' · ':value==='Etc/UTC'?t('协调世界时')+' · ':'')+value+' · '+offset};})}/></Form.Item>
  <Form.Item label={t('接下来执行')} className="schedule-preview admin-form-wide"><div className="schedule-preview-content" aria-live="polite"><span className="schedule-preview-zone">{timezone}</span>{preview.length?<div className="schedule-preview-times">{preview.map(value=><time dateTime={value.iso} key={value.iso}>{value.label}</time>)}</div>:<Typography.Text type="danger">{t('请检查 Cron 规则和时区。')}</Typography.Text>}</div></Form.Item>
 </>;
}
