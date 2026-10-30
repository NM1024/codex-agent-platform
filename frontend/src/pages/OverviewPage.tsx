import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Grid,InputNumber,Modal,Table,Typography} from 'antd';
import {AdminDrawer,AdminModal} from '../AdminOverlays';
import {useConsole} from '../context';
import {AsyncButton,DataLoading,Panel,TableField,TableIdentifier,time} from '../components';
import {Icon} from '../Icon';
import {measured,OverviewBadge,ResourceCard,resourceCards} from './overviewResources';
import {useOverview} from './useOverview';
import type {Conversation,Task} from '../types';
import './overview.css';

export default function OverviewPage(){
  const {api,operation,t,locale,notify,navigate,setChatId}=useConsole(),screens=Grid.useBreakpoint();
  const {data,loading,error,refresh}=useOverview();
  const [filter,setFilter]=useState('all'),[editing,setEditing]=useState(false),[concurrency,setConcurrency]=useState<number|null>(null);
  const [savingConcurrency,setSavingConcurrency]=useState(false),[concurrencyError,setConcurrencyError]=useState('');
  const [expanded,setExpanded]=useState<string|null>(null),[restartOpen,setRestartOpen]=useState(false),[restarting,setRestarting]=useState(false),[restartError,setRestartError]=useState('');
  const alive=useRef(true),restartLock=useRef(false),concurrencyLock=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  if(!data)return loading?<DataLoading/>:<Alert type="error" showIcon title={t('运行状态暂不可用')} description={error} action={<AsyncButton onClick={refresh}>{t('重试')}</AsyncButton>}/>;
  const platform=data.platform,runtime=platform.runtime,counts=platform.tasks;
  const fresh=!error,gateway=fresh?(platform.unavailable||platform.gateway?.alive===false?false:platform.gateway?.alive===true?true:null):null;
  const runner=fresh&&gateway===true&&typeof platform.runner?.ready==='boolean'?platform.runner.ready:null;
  const runtimeKnown=fresh&&gateway===true&&typeof runtime?.paused==='boolean';
  const limit=runtimeKnown&&measured(runtime?.concurrency)&&runtime.concurrency>0?runtime.concurrency:null;
  const state=!runtimeKnown?'unknown':runtime.paused?'paused':runner===false?'blocked':runner===true?'active':'unknown';
  // A failed Gateway read blocks collection only when its current runtime is
  // known. Without runtime settings, do not infer that collection was enabled.
  const stateLabel={unknown:'状态未获取',paused:'领取已暂停',blocked:'领取受阻',active:'任务领取中'}[state];
  const reason=platform.runner?.reason??platform.error?.message;
  const stateNote=state==='paused'?t('停止领取新任务，已执行任务继续完成。'):state==='blocked'?t('领取已开启，但执行服务尚未就绪。'):state==='active'?t('自动领取排队任务，按并发上限安排执行。'):t('等待获取运行设置与服务就绪状态。');
  const metrics=resourceCards(data.resources,t),attention=metrics.filter(metric=>metric.ratio!==null&&metric.ratio>=80);
  const taskCount=(keys:string[])=>fresh&&gateway===true&&counts&&keys.every(key=>measured(counts[key]))?keys.reduce((sum,key)=>sum+counts[key],0):'—';
  const investigate=async(task_id:string)=>{const conversation=await api<Conversation>('/conversations',{title:t('调查 ')+task_id.slice(0,8),task_id,investigate:true});if(alive.current){setChatId(conversation.id);navigate('chat');}};
  const saveConcurrency=async()=>{
    if(concurrencyLock.current||!Number.isSafeInteger(concurrency)||concurrency!<1||!runtimeKnown)return;
    concurrencyLock.current=true;setSavingConcurrency(true);setConcurrencyError('');
    try{await operation('runtime_update',{concurrency});if(alive.current){notify(t('并发设置已保存。'));await refresh();if(alive.current)setEditing(false);}}
    catch(cause){if(alive.current)setConcurrencyError(cause instanceof Error?cause.message:String(cause));}
    finally{concurrencyLock.current=false;if(alive.current)setSavingConcurrency(false);}
  };
  const restart=async()=>{
    if(restartLock.current)return;restartLock.current=true;setRestarting(true);setRestartError('');
    try{await operation('service_restart',{service:'runner'});if(alive.current){setRestartOpen(false);notify(t('已请求重启 Runner，请稍后刷新确认。'));await refresh();}}
    catch(cause){if(alive.current)setRestartError(cause instanceof Error?cause.message:String(cause));}
    finally{restartLock.current=false;if(alive.current)setRestarting(false);}
  };
  const services=[
    {id:'manager',name:'Manager',status:fresh?'程序可用':'状态未获取',tone:fresh?'success':'neutral',description:'管理对话与控制台',detail:fresh?t('管理接口可达，资源采集独立于业务服务。'):t('当前显示上次成功采样，等待连接恢复。')},
    {id:'gateway',name:'Gateway',status:gateway===true?'程序可用':gateway===false?'服务不可达':'状态未获取',tone:gateway===true?'success':gateway===false?'error':'neutral',description:'业务接口与任务队列',detail:gateway===true?t('业务接口可达，运行设置与任务队列可读取。'):platform.error?.message??t('等待获取服务状态。')},
    {id:'runner',name:'Codex Runner',status:runner===true?'已就绪':runner===false?'未就绪':'状态未获取',tone:runner===true?'success':runner===false?'warning':'neutral',description:'业务任务执行服务',detail:runner===true?t('执行服务已就绪，可按领取设置接收任务。'):runner===false?(reason?t(reason):t('执行服务尚未就绪。')):t('等待获取服务状态。')},
  ];
  const selectedService=services.find(service=>service.id===expanded);
  return <div className="ops-overview">
    <div className="ops-intro"><p>{t('资源、任务与服务状态，一处掌握。')}</p><Typography.Text id="updated" type="secondary">{t('采样于 {time}',{time:time(data.resources.sampled_at??data.sampled_at)})}</Typography.Text></div>
    {error&&<Alert className="ops-alert" type="warning" showIcon title={t('数据更新失败，当前显示上次采样。')} description={error} action={<AsyncButton onClick={refresh}>{t('重试')}</AsyncButton>}/>}
    {!error&&attention.length>0&&<Alert className="ops-alert" type={attention.some(metric=>metric.ratio!>=90)?'error':'warning'} showIcon title={t('资源占用偏高：{names}',{names:attention.map(metric=>metric.title).join(locale==='en'?', ':'、')})} description={t('请关注可用容量；任务领取仍保持当前设置。')}/>}
    <section aria-labelledby="ops-resources-title">
      <div className="ops-section-heading"><h2 id="ops-resources-title">{t('资源概览')}</h2><div className="ops-filters" role="group" aria-label={t('资源范围')}>{[['all','全部'],['host','宿主机'],['manager','Manager']].map(([value,label])=><Button size="small" type="text" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{t(label)}</Button>)}</div></div>
      <div className="ops-resource-grid">{metrics.filter(metric=>filter==='all'||metric.group===filter).map(metric=><ResourceCard key={metric.id} metric={metric}/>)}</div>
    </section>
    <section aria-labelledby="ops-tasks-title">
      <div className="ops-section-heading"><h2 id="ops-tasks-title">{t('任务运行')}</h2></div>
      <div className={'ops-card ops-dispatch ops-dispatch--'+state}>
        <div className="ops-dispatch-main"><span className="ops-state-icon"><Icon name={state==='active'?'play':state==='paused'?'pause':'alert'}/></span><div><h3 id="dispatch-title">{t(stateLabel)}</h3><p>{stateNote}</p></div></div>
        <div className="ops-dispatch-actions"><span className="ops-capacity">{t('并发上限')} <strong>{limit??'—'}</strong></span><Button disabled={savingConcurrency||!runtimeKnown||limit===null} aria-expanded={editing} aria-controls="concurrency-editor" onClick={()=>{if(concurrencyLock.current)return;setConcurrency(limit);setConcurrencyError('');setEditing(value=>!value);}}>{t(editing?'收起设置':'调整并发')}</Button>
          {state==='blocked'?<Button onClick={()=>setExpanded('runner')}>{t('查看原因')}</Button>:null}<AsyncButton type={state==='paused'?'primary':'default'} disabled={state==='unknown'} onClick={async()=>{await operation('runtime_update',{paused:!runtime?.paused});if(alive.current)await refresh();}}>{t(runtime?.paused?'恢复领取':'暂停领取')}</AsyncButton>
        </div>
      </div>
      <div className="ops-task-grid">{[
        {id:'running',label:'正在执行',value:taskCount(['running','dispatching','completing'])},
        {id:'queued',label:'排队等待',value:taskCount(['queued'])},{id:'suspended',label:'等待恢复',value:taskCount(['suspended'])},
        {id:'completed',label:'累计完成',value:taskCount(['completed'])},{id:'failed',label:'累计失败',value:taskCount(['failed'])},
      ].map(item=><article className={'ops-card ops-task ops-task--'+item.id} data-task-count={item.id} key={item.id}><h3>{t(item.label)}</h3><div className="ops-task-number">{item.value}{item.id==='running'&&limit!==null&&<span>/ {limit}</span>}</div></article>)}</div>
    </section>
    <section aria-labelledby="ops-services-title">
      <div className="ops-section-heading"><h2 id="ops-services-title">{t('服务健康')}</h2></div>
      <div className="ops-service-grid">{services.map(service=><article className="ops-card ops-service" key={service.id} data-service={service.id}>
        <div className="ops-service-heading"><h3><Icon name="server"/>{service.name}</h3><OverviewBadge tone={service.tone}>{t(service.status)}</OverviewBadge></div>
        <p className="ops-service-description">{t(service.description)}</p>
        <div className="ops-service-actions"><Button type="text" size="small" aria-label={t('{service}：查看状态',{service:service.name})} aria-expanded={expanded===service.id} aria-controls={'service-details-'+service.id} onClick={()=>setExpanded(value=>value===service.id?null:service.id)}>{t(expanded===service.id?'收起详情':'查看状态')}</Button>{service.id==='runner'&&<Button size="small" disabled={gateway!==true||restarting} onClick={()=>{setRestartError('');setRestartOpen(true);}}>{t('重启 Runner')}</Button>}</div>
      </article>)}</div>
    </section>
    <Panel title={t('最近执行异常')}>{gateway!==true?<Alert type="info" showIcon title={t('最近执行异常暂不可用')}/>:<Table<Task> loading={loading} rowKey="task_id" dataSource={platform.recent_errors??[]} pagination={false} className="responsive-table expanded-table" tableLayout="fixed" columns={[
      {title:t('业务类型'),key:'type',width:'15%',className:'table-name-cell',render:(_,row)=><TableField label={t('业务类型')}><span className="table-summary" title={row.type}>{row.type}</span></TableField>},
      {title:t('任务编号'),key:'task',width:'28%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('任务编号')}><TableIdentifier value={row.task_id}/></TableField>},
      {title:t('原因'),key:'reason',className:'table-text-cell',render:(_,row)=><TableField label={t('原因')}><span className="table-summary" title={row.error?.message??row.error?.code}>{row.error?.message??row.error?.code??t('历史记录未保存详情')}</span></TableField>},
      {title:t('时间（北京时间）'),key:'updated',width:160,className:'table-meta-cell',render:(_,row)=><TableField label={t('时间（北京时间）')}>{time(row.updated_at)}</TableField>},
      {title:t('操作'),key:'actions',width:locale==='en'?240:160,className:'table-actions-cell',render:(_,row)=><AsyncButton title={t('让 Agent 调查')} onClick={()=>investigate(row.task_id)}>{t(!screens.md?'调查':(data.investigations??[]).some(item=>item.task_id===row.task_id)?'查看调查':'让 Agent 调查')}</AsyncButton>},
    ]}/>}</Panel>
    <AdminDrawer title={selectedService?.name??t('服务健康')} subtitle={selectedService?t(selectedService.description):undefined} open={!!selectedService} onClose={()=>setExpanded(null)} width={640}>
      {selectedService&&<div id={'service-details-'+selectedService.id} className="ops-service-details"><Alert showIcon type={selectedService.tone==='error'?'error':selectedService.tone==='warning'?'warning':selectedService.tone==='success'?'success':'info'} title={t(selectedService.status)} description={selectedService.detail}/><Typography.Paragraph type="secondary">{t('采样于 {time}',{time:time(data.resources.sampled_at??data.sampled_at)})}</Typography.Paragraph></div>}
    </AdminDrawer>
    <AdminModal title={t('调整并发')} open={editing} onCancel={()=>{if(!concurrencyLock.current)setEditing(false);}} busy={savingConcurrency} width={560} footer={<><Button disabled={savingConcurrency} onClick={()=>{if(!concurrencyLock.current)setEditing(false);}}>{t('取消')}</Button><AsyncButton aria-label={t('保存')} type="primary" disabled={savingConcurrency||!runtimeKnown||!Number.isSafeInteger(concurrency)||concurrency!<1} onClick={saveConcurrency}>{t('保存')}</AsyncButton></>}>
      <Form id="concurrency-editor" className="admin-editor-form ops-concurrency" layout="horizontal" colon={false} onFinish={()=>void saveConcurrency()}>
        <Form.Item label={t('业务并发')} htmlFor="concurrency" extra={t('降低上限不终止已执行任务。')}><InputNumber id="concurrency" aria-label={t('业务并发')} min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={concurrency} onChange={setConcurrency} disabled={savingConcurrency||!runtimeKnown}/></Form.Item>
        {!runtimeKnown&&<Alert showIcon type="warning" title={t('等待获取运行设置与服务就绪状态。')}/>}
        {concurrencyError&&<Alert showIcon type="error" title={concurrencyError}/>}
      </Form>
    </AdminModal>
    <Modal title={t('重启 Runner')} open={restartOpen} okText={t('确认重启')} cancelText={t('取消')} onOk={()=>void restart()} onCancel={()=>{if(!restartLock.current)setRestartOpen(false);}} okButtonProps={{danger:true,loading:restarting,disabled:gateway!==true,'aria-busy':restarting}} cancelButtonProps={{disabled:restarting}} closable={!restarting} maskClosable={!restarting} keyboard={!restarting}>
      <Typography.Paragraph>{t('重启会中断 Runner 当前连接，正在执行的任务可能进入恢复流程。确定继续吗？')}</Typography.Paragraph>
      {restartError&&<Alert type="error" showIcon title={restartError}/>}
    </Modal>
  </div>;
}
