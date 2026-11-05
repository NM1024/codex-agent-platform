import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Empty,Input,Select,Space,Table,Tabs,Typography} from 'antd';
import {useConsole} from '../context';
import {LoadingState,Panel,Status,TableField,TableIdentifier} from '../components';
import {AdminDrawer} from '../AdminOverlays';
import {systemClassifications,systemCodes,systemModules} from '../system-i18n';
import {preserveSystemDetail,preserveSystemPage} from '../system-evidence';
import type {SystemPageEvidence} from '../system-evidence';
import type {Conversation,SystemDetail,SystemEvent,SystemPageResult,SystemRecord,SystemSource,SystemStatus,SystemWork} from '../types';
import './system.css';

type Tab='issues'|'work'|'logs';
type Filters={search:string;service:string;module:string;state:string;level:string;resolution:string;range:string;work_id?:string};
const initial:Filters={search:'',service:'',module:'',state:'',level:'',resolution:'unresolved',range:'all'};
const pageSize=20,services=['manager','gateway','runner'],states=['running','retrying','blocked','unknown','completed','idle','disabled'];
const serviceName=(value:string)=>({manager:'Manager',gateway:'Gateway',runner:'Runner'}[value]??value);
export default function SystemPage(){
 const {operation,api,locale,t,setChatId,navigate}=useConsole();
 const [tab,setTab]=useState<Tab>('issues'),[draftFilters,setDraftFilters]=useState<Filters>(initial),[filters,setFilters]=useState<Filters>(initial),[cursors,setCursors]=useState<string[]>(['']),[tick,setTick]=useState(0);
 const [status,setStatus]=useState<SystemStatus>(),[statusError,setStatusError]=useState(false),[statusLoading,setStatusLoading]=useState(true);
 const [page,setPage]=useState<SystemPageEvidence>(),[loading,setLoading]=useState(true),[pageError,setPageError]=useState(false),[loadedPage,setLoadedPage]=useState(1);
 const [selection,setSelection]=useState<{id:string;event?:SystemEvent}>(),[detail,setDetail]=useState<SystemDetail>(),[detailError,setDetailError]=useState(false),[detailLoading,setDetailLoading]=useState(false);
 const [handoffBusy,setHandoffBusy]=useState(false),[actionError,setActionError]=useState('');
 const listRequest=useRef(0),summaryRequest=useRef(0),detailRequest=useRef(0),handoffLock=useRef(false),alive=useRef(true),loadedQuery=useRef(''),loadedFilters=useRef(''),retainRefresh=useRef(false);
 const cursor=cursors.at(-1)??'';
 const format=(at?:number|null)=>at===undefined||at===null?'—':new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'medium'}).format(new Date(at));
 const code=(value:string)=>t(systemCodes[value]??'系统操作失败。');
 const progressing=(work:SystemWork)=>['running','retrying','blocked','unknown'].includes(work.state);
 const workTime=(work:SystemWork)=>progressing(work)?work.last_progress_at:work.state==='completed'?work.completed_at??work.updated_at:work.updated_at;
 const progress=(work:SystemWork)=>!progressing(work)?'':work.progress_age_ms===null?t('尚无进展记录'):t('无进展 {minutes} 分钟',{minutes:Math.floor(work.progress_age_ms/60000)});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;listRequest.current++;summaryRequest.current++;detailRequest.current++;};},[]);
 useEffect(()=>{
  const request=++summaryRequest.current;setStatusLoading(true);
  void operation<SystemStatus>('system_status').then(value=>{if(alive.current&&request===summaryRequest.current){setStatus(value);setStatusError(false);}}).catch(()=>{if(alive.current&&request===summaryRequest.current)setStatusError(true);}).finally(()=>{if(alive.current&&request===summaryRequest.current)setStatusLoading(false);});
 },[operation,tick]);
 useEffect(()=>{
  const request=++listRequest.current,key=JSON.stringify({tab,filters,cursor}),query=JSON.stringify({tab,filters});
  if(loadedFilters.current!==query||loadedQuery.current!==key&&!retainRefresh.current){setPage(undefined);setPageError(false);}retainRefresh.current=false;loadedQuery.current=key;loadedFilters.current=query;setLoading(true);
  const args={limit:pageSize,...(cursor?{cursor}:{}),...(filters.search?{search:filters.search}:{}),...(filters.service?{service:filters.service}:{}),...(filters.module?{module:filters.module}:{}),...(filters.state?{state:filters.state}:{}),...(tab==='logs'&&filters.level?{level:filters.level}:{}),...(tab==='issues'?{resolution:filters.resolution}:{}),...(filters.range==='all'?{}:{[tab==='issues'&&filters.resolution==='recovered'?'resolved_after':'after']:Date.now()-(filters.range==='24h'?86400000:604800000)}),...(filters.work_id?{work_id:filters.work_id}:{})};
  void operation<SystemPageResult>(tab==='issues'?'system_issue':tab==='work'?'system_work':'system_logs',args).then(value=>{if(alive.current&&request===listRequest.current){setPage(previous=>preserveSystemPage(value,previous));setLoadedPage(cursors.length);setPageError(false);}}).catch(()=>{if(alive.current&&request===listRequest.current)setPageError(true);}).finally(()=>{if(alive.current&&request===listRequest.current)setLoading(false);});
 },[operation,tab,filters,cursor,tick]);
 const refresh=()=>{retainRefresh.current=true;setCursors(['']);setTick(value=>value+1);};
 const apply=()=>{setCursors(['']);setFilters({...draftFilters,search:draftFilters.search.trim(),work_id:undefined});};
 const chooseTab=(next:string)=>{setTab(next as Tab);setDraftFilters(initial);setFilters(initial);setCursors(['']);};
 const readDetail=async(id:string,request:number)=>{
  const value=await operation<SystemDetail>('system_issue',{id});
  if(alive.current&&request===detailRequest.current){setDetail(previous=>preserveSystemDetail(value,previous,id));setDetailError(false);}return value;
 };
 const inspect=async(record:SystemRecord)=>{
  const request=++detailRequest.current;setSelection({id:record.kind==='event'?(record.work_id??record.id):record.id,...(record.kind==='event'?{event:record}:{})});setDetail(record.kind==='work'&&record.service?{work:record,sources:page?.sources.filter(source=>source.service===record.service)??[]}:undefined);setDetailError(false);setActionError('');
  if(record.kind==='event')return;
  setDetailLoading(true);try{await readDetail(record.id,request);}catch{if(alive.current&&request===detailRequest.current)setDetailError(true);}finally{if(alive.current&&request===detailRequest.current)setDetailLoading(false);}
 };
 const reloadDetail=async()=>{
  if(!selection)return;const request=++detailRequest.current;setDetailLoading(true);setActionError('');
  try{await readDetail(selection.id,request);}catch{if(alive.current&&request===detailRequest.current)setDetailError(true);}finally{if(alive.current&&request===detailRequest.current)setDetailLoading(false);}
 };
 const close=()=>{detailRequest.current++;setSelection(undefined);setDetailLoading(false);};
 const analyze=async(id:string)=>{
  if(handoffLock.current)return;handoffLock.current=true;setHandoffBusy(true);setActionError('');
  try{const conversation=await api<Conversation>('/conversations',{system_reference:{id}});if(alive.current){setChatId(conversation.id);navigate('chat');}}
  catch{if(alive.current)setActionError('操作未完成，请重新读取详情后核对当前版本。');}
  finally{handoffLock.current=false;if(alive.current)setHandoffBusy(false);}
 };
 const sources=(items:SystemSource[],id?:string)=><div id={id} className="system-sources" aria-label={t('来源状态')}>{items.map(source=><div key={source.service} className={'system-source '+(source.available?'':'system-source-unavailable')}><span><i className="status-dot" aria-hidden="true"/>{serviceName(source.service)} · {t(source.available?'已就绪':'未就绪')}</span><small>{t('来源采集时间')} <time dateTime={new Date(source.observed_at).toISOString()}>{format(source.observed_at)}</time></small>{!source.available&&<code>{source.error_code}</code>}</div>)}</div>;
 const partial=(items?:SystemSource[])=>items?.some(source=>!source.available);
 const sourceWarning=<Alert type="warning" showIcon title={t('部分来源不可用；当前结果不完整，不能据此判断系统健康。')}/>;
 const related=(workId:string)=>{close();setTab('logs');const next={...initial,work_id:workId};setDraftFilters(next);setFilters(next);setCursors(['']);};
 const work=detail?.work;
 const event=selection?.event;
 const stalePage=!!page?.stale_ids.length,staleDetail=partial(detail?.sources),allUnavailable=(items?:SystemSource[])=>!!items?.length&&items.every(source=>!source.available);
 const unavailableSummarySources=status?.sources.filter(source=>!source.available)??[];
 const collectionWarnings=status?.summary.collections.filter(item=>item.gap_count>0||item.pending)??[];
 const renderState=(row:SystemRecord)=><Status value={row.kind==='event'?row.level:row.state}/>;
 const renderRecovery=(row:SystemWork)=><Typography.Text type="secondary">{row.issue_opened_at?t(row.resolved_at?'已恢复':'未恢复'):'—'}</Typography.Text>;
 const renderVerification=(row:SystemWork)=>row.verification_required?<Status value="需要核验"/>:<Typography.Text type="secondary">—</Typography.Text>;
 const eventFacts=(item:SystemEvent)=><dl className="system-facts"><dt>{t('首次出现')}</dt><dd>{format(item.first_seen_at)}</dd><dt>{t('最近出现')}</dt><dd>{format(item.last_seen_at)}</dd><dt>{t('创建时间')}</dt><dd>{format(item.created_at)}</dd><dt>{t('问题次数')}</dt><dd>{item.count}</dd><dt>{t('安全原因')}</dt><dd>{code(item.code)} <code>{item.code}</code></dd><dt>{t('服务与编号')}</dt><dd>{serviceName(item.service)} · {item.id}</dd></dl>;
 return <div id="system-page" className="system-page">
  <div id="system-metrics" className="system-metrics" aria-busy={statusLoading} aria-label={t('按概览筛选')}>
   {[
    {label:'需要处理',value:status?.summary.unresolved,tab:'issues' as Tab,query:{...initial}},
    {label:'等待重试',value:status?.summary.states.retrying,tab:'work' as Tab,query:{...initial,state:'retrying'}},
    {label:'正在运行',value:status?.summary.states.running,tab:'work' as Tab,query:{...initial,state:'running'}},
    {label:'最近恢复',value:status?.summary.recovered_24h,tab:'issues' as Tab,query:{...initial,resolution:'recovered',range:'24h'}},
   ].map((item,index)=><Button id={'system-metric-'+index} key={item.label} className="system-metric" title={t(item.label)+(index===3?' · '+t('过去 24 小时'):'')} aria-label={t(item.label)+(index===3?' · '+t('过去 24 小时'):'')+' '+(item.value===undefined||allUnavailable(status?.sources)?'—':item.value)} aria-pressed={tab===item.tab&&JSON.stringify(filters)===JSON.stringify(item.query)} onClick={()=>{setTab(item.tab);setDraftFilters(item.query);setFilters(item.query);setCursors(['']);}}><span>{t(item.label)}{index===3&&<small> · {t('过去 24 小时')}</small>}</span><strong>{item.value===undefined||allUnavailable(status?.sources)?'—':item.value}</strong></Button>)}
   {status&&!status.summary.complete&&<small className="system-metrics-partial">{t('仅可用来源')}</small>}
  </div>
  {statusError&&<Alert type="warning" showIcon title={t(status?'刷新失败，数据可能过期；保留上次读取的记录。':'概览暂时无法读取。')}/>}
  {status&&(!status.summary.complete||unavailableSummarySources.length>0||collectionWarnings.length>0)&&<div className="system-summary-alerts">{(!status.summary.complete||unavailableSummarySources.length>0)&&<Alert type="warning" showIcon title={t('概览来源不完整；统计仅包含可用来源，不能据此判断系统健康。')} description={unavailableSummarySources.length?<Space wrap>{unavailableSummarySources.map(source=><span key={source.service}>{serviceName(source.service)}{source.error_code&&<> · <code>{source.error_code}</code></>}</span>)}</Space>:undefined}/>} {collectionWarnings.map(item=><Alert key={item.service} type="warning" showIcon title={serviceName(item.service)+' · '+t(item.pending?'待补记采集证据':'采集存在缺口')} description={<span>{t('采集失败次数')} {item.failed_operations} · {t('最近采集失败')} {format(item.last_failed_at)} · {t('最近采集恢复')} {format(item.last_recovered_at)}</span>}/>)}</div>}
  <Tabs activeKey={tab} onChange={chooseTab} aria-label={t('系统运维')} items={[{key:'issues',label:t('待处理问题')},{key:'work',label:t('后台工作')},{key:'logs',label:t('系统日志')}]}/>
  <Panel title={t(tab==='issues'?'待处理问题':tab==='work'?'后台工作':'系统日志')} extra={<Button id="system-refresh" onClick={refresh} loading={loading||statusLoading}>{t('刷新')}</Button>}>
   <form className="system-filters" onSubmit={e=>{e.preventDefault();if(!loading)apply();}}>
    <Input id="system-search" type="search" maxLength={200} aria-label={t('搜索关键词、错误码或编号')} placeholder={t('搜索关键词、错误码或编号')} value={draftFilters.search} onChange={e=>setDraftFilters(value=>({...value,search:e.target.value}))}/>
    <Select virtual={false} id="system-service" aria-label={t('按服务筛选')} value={draftFilters.service} options={[{value:'',label:t('全部服务')},...services.map(value=>({value,label:serviceName(value)}))]} onChange={service=>setDraftFilters(value=>({...value,service}))}/>
    <Select virtual={false} id="system-module" aria-label={t('按模块筛选')} value={draftFilters.module} options={[{value:'',label:t('全部模块')},...Object.entries(systemModules).map(([value,label])=>({value,label:t(label)}))]} onChange={module=>setDraftFilters(value=>({...value,module}))}/>
    <Select virtual={false} id="system-state" aria-label={t('按状态筛选')} value={draftFilters.state} options={[{value:'',label:t('全部状态')},...states.map(value=>({value,label:<Status value={value}/>}))]} onChange={state=>setDraftFilters(value=>({...value,state}))}/>
    {tab==='issues'&&<Select virtual={false} id="system-resolution" aria-label={t('问题解决状态')} value={draftFilters.resolution} options={['unresolved','recovered','all'].map((value,index)=>({value,label:t(['未恢复','已恢复','全部问题'][index])}))} onChange={resolution=>setDraftFilters(value=>({...value,resolution}))}/>}
    {tab==='logs'&&<Select virtual={false} id="system-level" aria-label={t('按级别筛选')} value={draftFilters.level} options={[{value:'',label:t('全部级别')},...['debug','info','warn','error'].map(value=>({value,label:<Status value={value}/>}))]} onChange={level=>setDraftFilters(value=>({...value,level}))}/>}
    <Select virtual={false} id="system-range" aria-label={t('时间范围')} value={draftFilters.range} options={['all','24h','7d'].map((value,index)=>({value,label:t(['全部时间','最近 24 小时','最近 7 天'][index])}))} onChange={range=>setDraftFilters(value=>({...value,range}))}/>
    <Button id="system-query" type="primary" htmlType="submit" loading={loading}>{t('查询')}</Button>
   </form>
   <Typography.Paragraph className="system-notice" type="secondary">{t(tab==='issues'?'相同问题合并计数，恢复历史按解决状态筛选；当前工作状态单独显示。':tab==='work'?'没有新进展不代表完成；需要核验的工作保留原状态。':'仅记录脱敏系统事件，不包含业务正文、提示词或凭证。')}</Typography.Paragraph>
   {page&&sources(page.sources,'system-sources')}{partial(page?.sources)&&sourceWarning}
   {pageError&&<Alert type="warning" showIcon title={t(page?'刷新失败，数据可能过期；保留上次读取的记录。':'数据加载失败，请刷新重试。')}/>}
   {stalePage&&<Alert type="warning" showIcon title={t('部分来源失败，数据可能过期；保留已知记录，暂停分页，恢复后请刷新。')}/>}
   {actionError&&!selection&&<Alert type="error" showIcon title={t(actionError)}/>}
   {loading&&!page?<LoadingState/>:<Table<SystemRecord> id="system-records" rowKey="id" dataSource={page?.items??[]} loading={loading} pagination={false} tableLayout="fixed" className="responsive-table expanded-table system-table" locale={{emptyText:<Empty description={t(pageError?'数据加载失败，请刷新重试。':partial(page?.sources)?'来源暂时无法读取。':'没有匹配的记录，请调整筛选条件。')}/>}} columns={[
    {title:t(tab==='issues'?'问题与影响':'名称与原因'),key:'name',width:tab==='logs'?'29%':'21%',className:'table-name-cell',render:(_,row)=><TableField label={t('名称与原因')}><strong>{t(systemModules[row.module]??'系统')}</strong><div>{code(row.code)}</div><small><code>{row.code}</code>{row.kind==='work'?' · '+t('问题次数')+' '+row.issue_count:' · '+row.count}</small></TableField>},
    {title:t('服务与编号'),key:'identity',width:tab==='logs'?'21%':'19%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('服务与编号')}><div>{serviceName(row.service)}</div><TableIdentifier value={row.id}/>{page?.stale_ids.includes(row.id)&&<Typography.Text className="system-data-freshness" type="warning">{t('数据可能过期')}</Typography.Text>}</TableField>},
    {title:t(tab==='logs'?'日志级别':'工作状态'),key:'state',width:tab==='logs'?'16%':'11%',className:'table-status-cell',render:(_,row)=><TableField label={t(tab==='logs'?'日志级别':'工作状态')}>{renderState(row)}</TableField>},
    ...(tab==='logs'?[]:[
     {title:t('问题恢复'),key:'resolution',width:'10%',className:'system-resolution-cell',render:(_:unknown,row:SystemRecord)=><TableField label={t('问题恢复')}>{row.kind==='work'&&renderRecovery(row)}</TableField>},
     {title:t('核验情况'),key:'verification',width:'10%',className:'system-verification-cell',render:(_:unknown,row:SystemRecord)=><TableField label={t('核验情况')}>{row.kind==='work'&&renderVerification(row)}</TableField>},
    ]),
    {title:t(tab==='logs'?'最近出现':'最近进展'),key:'progress',width:tab==='logs'?'20%':'19%',className:'table-meta-cell',render:(_,row)=><TableField label={t(tab==='logs'?'最近出现':'最近进展')}>{format(row.kind==='event'?row.last_seen_at:workTime(row))}{row.kind==='work'&&<>{progressing(row)&&<small>{progress(row)}</small>}{row.next_retry_at&&<small>{t('下次重试')} {format(row.next_retry_at)}</small>}</>}</TableField>},
    {title:t('操作'),key:'actions',width:tab==='logs'?'14%':'10%',className:'table-actions-cell',render:(_,row)=><Space wrap size={4}><Button type="link" onClick={()=>void inspect(row)}>{t('详情')}</Button>{row.kind==='work'&&<Button type="link" disabled={handoffBusy||pageError||page?.stale_ids.includes(row.id)} onClick={()=>void analyze(row.id)}>{t('交给管理 Agent')}</Button>}</Space>},
   ]}/>}
   <div id="system-pagination" className="system-pagination"><Button disabled={cursors.length===1||loading||stalePage} onClick={()=>setCursors(value=>value.slice(0,-1))}>{t('上一页')}</Button><Typography.Text type="secondary">{stalePage?t('已知记录 {count} 条；包含过期证据',{count:page?.items.length??0}):t('每页 {limit} 条 · 第 {page} 页 · 本页 {count} 条',{limit:pageSize,page:page?loadedPage:cursors.length,count:page?.items.length??0})}</Typography.Text><Button disabled={!page?.next_cursor||loading||pageError||stalePage} onClick={()=>{if(page?.next_cursor)setCursors(value=>[...value,page.next_cursor!]);}}>{t('下一页')}</Button></div>
   <Typography.Paragraph className="system-page-help" type="secondary">{t('当前状态游标分页；来源恢复或数据变化后请从首页刷新。')}</Typography.Paragraph>
  </Panel>
  <Typography.Paragraph className="system-retention" type="secondary">{t('系统记录遵循全局历史清理的启用开关与保留天数；未完成工作、未恢复问题及必要证据受保护。')}</Typography.Paragraph>
  <AdminDrawer open={!!selection} title={t(event?'系统事件详情':'系统工作详情')} subtitle={event?.id??selection?.id} width={620} onClose={close}>
   <div id="system-detail" className="system-detail" aria-busy={detailLoading}>
    {detailLoading?<LoadingState/>:event?<>{eventFacts(event)}{event.work_id&&<Button onClick={()=>void inspect({id:event.work_id,kind:'work'} as SystemWork)}>{t('系统工作详情')}</Button>}</>:<>
     <div className="system-detail-toolbar">{detail&&sources(detail.sources)}<Button onClick={()=>void reloadDetail()}>{t('重新读取详情')}</Button></div>
     {partial(detail?.sources)&&sourceWarning}
     {detailError&&<Alert type="error" showIcon title={t('详情暂时无法读取，请重试。')}/>}
     {staleDetail&&work&&<Alert type="warning" showIcon title={t('数据可能过期；保留上次读取的证据，来源恢复后请重新读取详情。')}/>}
     {!detailLoading&&detail&&!work&&<Alert type="warning" showIcon title={t(staleDetail?'来源暂时无法读取。':'找不到工作；请核对来源状态或刷新。')}/>}
     {work&&<>
      <dl className="system-detail-summary">{[
       ['工作状态',renderState(work)],['问题恢复',renderRecovery(work)],['核验情况',renderVerification(work)],['问题分类',t(systemClassifications[work.classification]??'分类待确认')],
      ].map(([label,value])=><div key={String(label)}><dt>{t(String(label))}</dt><dd>{value}</dd></div>)}</dl>
      {work.stale&&<Alert type="warning" showIcon title={t('记录可能过期，请核对来源与进展。')} description={progress(work)}/>}
      <dl className="system-facts">{[
       ['服务与编号',<TableIdentifier value={work.id}/>],['安全原因',<>{code(work.code)} <code>{work.code}</code></>],['记录版本',work.revision],['创建时间',format(work.created_at)],['首次出现',format(work.issue_opened_at)],['最近进展',<>{format(workTime(work))}{progressing(work)&&<> · {progress(work)}</>}</>],['首次尝试',format(work.first_attempt_at)],['最近尝试',format(work.last_attempt_at)],['最近成功',format(work.last_success_at)],['下次重试',format(work.next_retry_at)],['尝试次数',work.attempts],['连续失败',work.consecutive_failures],['问题次数',work.issue_count],['待处理数量',work.pending_count],
      ].map(([label,value])=><div className="system-fact" key={String(label)}><dt>{t(String(label))}</dt><dd>{value}</dd></div>)}</dl>
      {actionError&&<Alert type="error" showIcon title={t(actionError)}/>}
      <div className="system-detail-actions"><Button type="primary" disabled={handoffBusy||detailError||staleDetail} onClick={()=>void analyze(work.id)}>{t('交给管理 Agent')}</Button><Button onClick={()=>related(work.id)}>{t('查看关联日志')}</Button></div>
      <Typography.Title level={3}>{t('处理经过')}</Typography.Title><div className="system-timeline">{(detail?.events??[]).map(item=><div key={item.id}><Typography.Text>{code(item.code)}</Typography.Text><small>{format(item.last_seen_at)} · <code>{item.id}</code> · {item.count}</small></div>)}</div>
     </>}
    </>}
   </div>
  </AdminDrawer>

 </div>;
}
