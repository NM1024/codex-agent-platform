import {useState} from 'react';
import {Button,Descriptions,Table,Typography} from 'antd';
import {AgentGuidance,EnableToggle,JsonView,Panel,Status,useLoad} from '../components';
import {useConsole} from '../context';
import type {Schedule} from '../types';

function nextRun(plan:Schedule) {
  if(!plan.next_run_at)return '—';
  return new Intl.DateTimeFormat(undefined,{timeZone:plan.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(plan.next_run_at));
}
export default function SchedulesPage() {
  const {api,operation,t}=useConsole();
  const [selectedId,setSelectedId]=useState<string>();
  const {data:plans=[],setData:setPlans,loading}=useLoad(()=>api<Schedule[]>('/schedules'),[api]);
  const selected=plans.find(plan=>plan.id===selectedId);
  return <>
    <AgentGuidance title={t('定时计划配置')} description={t('可在此启用或停用。新增和编辑定时任务，请通过管理 Agent 操作。')}/>
    <Panel title={t('定时计划')}>
      <Typography.Paragraph type="secondary">{t('时间按每个计划设置的时区显示；新增或编辑请在管理对话中说明。')}</Typography.Paragraph>
      <Table<Schedule> rowKey={plan=>plan.id??plan.name} dataSource={plans} loading={loading} pagination={false} tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('计划'),key:'plan',render:(_,plan)=><>{plan.name}<br/><Typography.Text type="secondary">{plan.kind==='inspection'?t('管理巡检'):plan.type}</Typography.Text></>},
        {title:t('规则'),key:'rule',width:190,responsive:['md'],render:(_,plan)=><><Typography.Text code>{plan.cron}</Typography.Text><br/><Typography.Text type="secondary">{plan.timezone}</Typography.Text></>},
        {title:t('下次触发'),key:'next',width:190,responsive:['lg'],render:(_,plan)=>nextRun(plan)},
        {title:t('状态'),key:'status',width:92,render:(_,plan)=><><EnableToggle enabled={plan.enabled} label={t('启停定时计划：{name}',{name:plan.name})} onChange={async enabled=>{
          const updated=await operation<Schedule>('schedule_enable',{id:plan.id,enabled});
          setPlans(current=>current?.map(item=>item.id===updated.id?updated:item));
        }}/>{plan.blocked_reason&&<div><Typography.Text type="danger">{t('触发受阻')}</Typography.Text></div>}</>},
        {title:t('操作'),key:'actions',width:112,render:(_,plan)=><Button onClick={()=>setSelectedId(plan.id)}>{t('查看详情')}</Button>},
      ]}/>
    </Panel>
    {selected&&<Panel title={t('计划详情')}><div id="schedule-detail">
      <Descriptions column={{xs:1,sm:1,md:2}} items={[
        {key:'name',label:t('计划名称'),children:selected.name},
        {key:'kind',label:t('触发对象'),children:selected.kind==='inspection'?t('管理巡检'):t('业务任务')},
        {key:'cron',label:t('规则'),children:<Typography.Text code>{selected.cron}</Typography.Text>},
        {key:'zone',label:t('时区'),children:selected.timezone},
        {key:'next',label:t('下次触发'),children:nextRun(selected)},
        {key:'status',label:t('状态'),children:<Status value={selected.enabled?'已启用':'已停用'}/>},
      ]}/>
      {selected.blocked_reason&&<Typography.Paragraph type="danger">{selected.blocked_reason}</Typography.Paragraph>}
      {selected.kind==='inspection'?<><Typography.Title level={3}>{t('巡检要求')}</Typography.Title><Typography.Paragraph className="literal-text">{selected.message}</Typography.Paragraph></>:<><Typography.Paragraph>{t('业务类型')+': '+selected.type}</Typography.Paragraph><Typography.Title level={3}>{t('业务输入 JSON')}</Typography.Title><JsonView value={selected.input??{}}/></>}
    </div></Panel>}
    <Panel title={t('运行说明')}>
      <Typography.Paragraph>{t('定时任务按 Cron 周期自动执行：业务任务调用指定插件处理固定输入；管理巡检把巡检要求交给管理 Agent，并在管理对话中保存结果。')}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t('例如：每天 09:00 检查队列与失败任务，Cron 为 0 9 * * *。触发时间以计划填写的时区为准；启用后实际执行会使用模型额度。')}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t('停机期间错过的计划在恢复后执行一次，再进入下个正常时刻。每次触发都是独立任务，执行受统一并发设置控制。')}</Typography.Paragraph>
    </Panel>
  </>;
}
