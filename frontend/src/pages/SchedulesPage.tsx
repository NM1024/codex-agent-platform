import {useState} from 'react';
import {Button,Descriptions,Table,Tabs,Tooltip,Typography} from 'antd';
import {AgentGuidance,DataLoading,DeleteAction,EnableToggle,JsonView,Panel,Status,TableField,useLoad} from '../components';
import {useConsole} from '../context';
import {AdminDrawer} from '../AdminOverlays';
import {PluginActionIcon} from '../PluginActionIcon';
import {ScheduleEditor} from '../ScheduleEditor';
import {NotificationBindingsPanel} from '../NotificationBindingsPanel';
import {ScheduleNotificationExecutions} from '../ScheduleNotificationExecutions';
import type {Schedule} from '../types';

function nextRun(plan:Schedule) {
  if(!plan.next_run_at)return '—';
  return new Intl.DateTimeFormat(undefined,{timeZone:plan.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(plan.next_run_at));
}
export default function SchedulesPage() {
  const {api,operation,t}=useConsole();
  const [selectedId,setSelectedId]=useState<string>();
  const [editor,setEditor]=useState<Schedule|'new'>();
  const [detailTab,setDetailTab]=useState('overview');
  const [help,setHelp]=useState(false);
  const {data:loadedPlans,setData:setPlans,loading}=useLoad(()=>api<Schedule[]>('/schedules'),[api]);
  const plans=loadedPlans??[];
  const selected=plans.find(plan=>plan.id===selectedId);
  if(loading&&loadedPlans===undefined)return <DataLoading/>;
  return <>
    <AgentGuidance title={t('定时计划配置')} description={t('可直接新增、编辑、启用或停用定时计划，也可通过管理 Agent 操作。')}/>
    <Panel title={t('定时计划')} extra={<div className="schedule-header-actions"><Button onClick={()=>setHelp(true)}>{t('运行说明')}</Button><Button type="primary" onClick={()=>setEditor('new')}>{t('新增定时计划')}</Button></div>}>
      <Typography.Paragraph type="secondary">{t('时间按每个计划设置的时区显示；新计划默认停用。')}</Typography.Paragraph>
      <Table<Schedule> rowKey={plan=>plan.id??plan.name} dataSource={plans} loading={loading} pagination={false} className="responsive-table expanded-table" tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('计划名称'),key:'plan',className:'table-name-cell',render:(_,plan)=><TableField label={t('计划名称')}><span className="table-summary" title={plan.name}>{plan.name}</span></TableField>},
        {title:t('触发对象'),key:'target',width:'15%',className:'table-target-cell',render:(_,plan)=><TableField label={t('触发对象')}><span className="table-summary" title={plan.type}>{plan.kind==='inspection'?t('管理巡检'):plan.type}</span></TableField>},
        {title:t('Cron 规则'),key:'rule',width:'14%',className:'table-rule-cell',render:(_,plan)=><TableField label={t('Cron 规则')}><Typography.Text code>{plan.cron}</Typography.Text></TableField>},
        {title:t('时区'),key:'zone',width:'16%',className:'table-zone-cell',render:(_,plan)=><TableField label={t('时区')}>{plan.timezone}</TableField>},
        {title:t('下次触发'),key:'next',width:'18%',className:'table-meta-cell',render:(_,plan)=><TableField label={t('下次触发')}>{nextRun(plan)}</TableField>},
        {title:t('状态'),key:'status',width:100,className:'table-status-cell',render:(_,plan)=><TableField label={t('状态')}><EnableToggle enabled={plan.enabled} label={t('启停定时计划：{name}',{name:plan.name})} onChange={async enabled=>{
          const updated=await operation<Schedule>('schedule_enable',{id:plan.id,enabled});
          setPlans(current=>current?.map(item=>item.id===updated.id?updated:item));
        }}/>{plan.blocked_reason&&<div><Typography.Text type="danger">{t('触发受阻')}</Typography.Text></div>}</TableField>},
        {title:t('操作'),key:'actions',width:132,className:'table-actions-cell',render:(_,plan)=><div className="plugin-row-actions plugin-icon-actions admin-row-actions"><Tooltip title={t('编辑定时计划')} trigger={['hover','focus']}><Button type="text" icon={<PluginActionIcon name="settings"/>} aria-label={t('编辑定时计划')} onClick={()=>setEditor(plan)}/></Tooltip><Tooltip title={t('查看详情')} trigger={['hover','focus']}><Button type="text" icon={<PluginActionIcon name="eye"/>} aria-label={t('查看详情')} onClick={()=>{setDetailTab('overview');setSelectedId(plan.id);}}/></Tooltip><DeleteAction label={t('删除定时计划：{name}',{name:plan.name})} name={plan.name} description={t('删除后从列表隐藏、停止后续触发，并取消尚未交给管理 Agent 的巡检。已接单任务和对话继续执行，历史记录保留。')} onDelete={async()=>{
          await operation('schedule_delete',{id:plan.id});
          setPlans(current=>current?.filter(item=>item.id!==plan.id));
          if(selectedId===plan.id)setSelectedId(undefined);
        }}/></div>},
      ]}/>
    </Panel>
    {editor&&<ScheduleEditor key={editor==='new'?'new':editor.id} schedule={editor==='new'?undefined:editor} onCancel={()=>setEditor(undefined)} onSaved={updated=>{setPlans(current=>[updated,...(current??[]).filter(item=>item.id!==updated.id)]);setEditor(undefined);}}/>}
    <AdminDrawer open={!!selected} title={t('计划详情')} subtitle={selected?.name} onClose={()=>setSelectedId(undefined)}>
    {selected&&<div id="schedule-detail"><Tabs activeKey={detailTab} onChange={setDetailTab} items={[{key:'overview',label:t('概览'),children:<>
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
      </>},{key:'channels',label:t('通知渠道'),children:selected.id&&<NotificationBindingsPanel key={selected.id} kind="schedule" id={selected.id}/>},{key:'executions',label:t('执行记录'),children:selected.id&&<ScheduleNotificationExecutions key={selected.id+'-runs'} scheduleId={selected.id}/>} ]}/></div>}
    </AdminDrawer>
    <AdminDrawer title={t('运行说明')} open={help} onClose={()=>setHelp(false)} width={720}>
      <Typography.Paragraph>{t('定时任务按 Cron 周期自动执行：业务任务调用指定插件处理固定输入；管理巡检把巡检要求交给管理 Agent，并在管理对话中保存结果。')}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t('例如：每天 09:00 检查队列与失败任务，Cron 为 0 9 * * *。触发时间以计划填写的时区为准；启用后实际执行会使用模型额度。')}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t('停机期间错过的计划在恢复后执行一次，再进入下个正常时刻。每次触发都是独立任务，执行受统一并发设置控制。')}</Typography.Paragraph>
    </AdminDrawer>
  </>;
}
