import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Empty,Input,Modal,Select,Space,Table,Tabs,Typography} from 'antd';
import {useConsole} from '../context';
import {LoadingState,Panel,Status,TableField,TableIdentifier} from '../components';
import {AdminDrawer} from '../AdminOverlays';
import {systemActions,systemClassifications,systemCodes,systemModules} from '../system-i18n';
import type {Conversation,SystemDetail,SystemDraft,SystemEvent,SystemPageResult,SystemRecord,SystemSource,SystemStatus,SystemWork} from '../types';
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
 const [page,setPage]=useState<SystemPageResult>(),[loading,setLoading]=useState(true),[pageError,setPageError]=useState(false),[loadedPage,setLoadedPage]=useState(1);
 const [selection,setSelection]=useState<{id:string;event?:SystemEvent}>(),[detail,setDetail]=useState<SystemDetail>(),[detailError,setDetailError]=useState(false),[detailLoading,setDetailLoading]=useState(false);
 const [busy,setBusy]=useState(false),[handoffBusy,setHandoffBusy]=useState(false),[result,setResult]=useState(''),[actionError,setActionError]=useState(''),[draft,setDraft]=useState<SystemDraft>(),[reviewOpen,setReviewOpen]=useState(false);
 const listRequest=useRef(0),summaryRequest=useRef(0),detailRequest=useRef(0),actionLock=useRef(false),handoffLock=useRef(false),alive=useRef(true),loadedQuery=useRef(''),retainRefresh=useRef(false);
 const [copyResult,setCopyResult]=useState('');
 const cursor=cursors.at(-1)??'';
 const format=(at?:number|null)=>at===undefined||at===null?'—':new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'medium'}).format(new Date(at));
 const code=(value:string)=>t(systemCodes[value]??'系统操作失败。');
 const progress=(work:SystemWork)=>work.progress_age_ms===null?t('尚无进展记录'):t('无进展 {minutes} 分钟',{minutes:Math.floor(work.progress_age_ms/60000)});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;listRequest.current++;summaryRequest.current++;detailRequest.current++;};},[]);
 useEffect(()=>{
  const request=++summaryRequest.current;setStatusLoading(true);
  void operation<SystemStatus>('system_status').then(value=>{if(alive.current&&request===summaryRequest.current){setStatus(value);setStatusError(false);}}).catch(()=>{if(alive.current&&request===summaryRequest.current)setStatusError(true);}).finally(()=>{if(alive.current&&request===summaryRequest.current)setStatusLoading(false);});
 },[operation,tick]);
 useEffect(()=>{
  const request=++listRequest.current,key=JSON.stringify({tab,filters,cursor});
  if(loadedQuery.current!==key&&!retainRefresh.current){setPage(undefined);setPageError(false);}retainRefresh.current=false;loadedQuery.current=key;setLoading(true);
  const args={limit:pageSize,...(cursor?{cursor}:{}),...(filters.search?{search:filters.search}:{}),...(filters.service?{service:filters.service}:{}),...(filters.module?{module:filters.module}:{}),...(filters.state?{state:filters.state}:{}),...(tab==='logs'&&filters.level?{level:filters.level}:{}),...(tab==='issues'?{resolution:filters.resolution}:{}),...(filters.range==='all'?{}:{after:Date.now()-(filters.range==='24h'?86400000:604800000)}),...(filters.work_id?{work_id:filters.work_id}:{})};
  void operation<SystemPageResult>(tab==='issues'?'system_issue':tab==='work'?'system_work':'system_logs',args).then(value=>{if(alive.current&&request===listRequest.current){setPage(value);setLoadedPage(cursors.length);setPageError(false);}}).catch(()=>{if(alive.current&&request===listRequest.current)setPageError(true);}).finally(()=>{if(alive.current&&request===listRequest.current)setLoading(false);});
 },[operation,tab,filters,cursor,tick]);
 const refresh=()=>{retainRefresh.current=true;setCursors(['']);setTick(value=>value+1);};
 const apply=()=>{setCursors(['']);setFilters({...draftFilters,search:draftFilters.search.trim(),work_id:undefined});};
 const chooseTab=(next:string)=>{setTab(next as Tab);setDraftFilters(initial);setFilters(initial);setCursors(['']);};
 const readDetail=async(id:string,request:number)=>{
  const value=await operation<SystemDetail>('system_issue',{id});
  if(alive.current&&request===detailRequest.current){setDetail(value);setDetailError(false);}return value;
 };
 const inspect=async(record:SystemRecord)=>{
  if(actionLock.current)return;const request=++detailRequest.current;setSelection({id:record.kind==='event'?(record.work_id??record.id):record.id,...(record.kind==='event'?{event:record}:{})});setDetail(undefined);setDetailError(false);setActionError('');setResult('');setDraft(undefined);setCopyResult('');setReviewOpen(false);
  if(record.kind==='event')return;
  setDetailLoading(true);try{await readDetail(record.id,request);}catch{if(alive.current&&request===detailRequest.current)setDetailError(true);}finally{if(alive.current&&request===detailRequest.current)setDetailLoading(false);}
 };
 const reloadDetail=async()=>{
  if(!selection||actionLock.current)return;const request=++detailRequest.current;setDetailLoading(true);setActionError('');
  try{await readDetail(selection.id,request);}catch{if(alive.current&&request===detailRequest.current)setDetailError(true);}finally{if(alive.current&&request===detailRequest.current)setDetailLoading(false);}
 };
 const close=()=>{if(actionLock.current)return;detailRequest.current++;setSelection(undefined);setReviewOpen(false);setDetailLoading(false);};
 const mutate=async(kind:'maintain'|'review'|'draft',action?:string)=>{
  const work=detail?.work;if(!work||actionLock.current||detailError||detailLoading)return;
  actionLock.current=true;setBusy(true);setActionError('');setResult('');setCopyResult('');const request=detailRequest.current;
  try{
   if(kind==='draft'){
    const value=await operation<SystemDraft>('system_issue_draft',{id:work.id,revision:work.revision});if(alive.current&&request===detailRequest.current)setDraft(value);
   }else if(kind==='review'){
    await api<SystemDetail>('/system/review',{id:work.id,revision:work.revision});if(alive.current&&request===detailRequest.current){setResult('已解除代码缺陷分类；未执行修复，未确认恢复。');setReviewOpen(false);}
   }else{
    const value=await operation<{outcome:'recovered'|'unconfirmed'|'unknown'|'failed'}>('system_maintain',{id:work.id,revision:work.revision,action});
    const messages={recovered:'已核验恢复',unconfirmed:'请求已返回，尚未核验恢复。',unknown:'结果未知，请先核验现状，不要盲目重试。',failed:'维护执行失败；请读取最新证据。'};
    if(alive.current&&request===detailRequest.current)setResult(messages[value.outcome]??messages.unknown);
   }
  }catch{if(alive.current&&request===detailRequest.current)setActionError('操作未完成，请重新读取详情后核对当前版本。');}
  finally{
   try{await readDetail(work.id,request);}catch{if(alive.current&&request===detailRequest.current)setDetailError(true);}
   if(alive.current&&request===detailRequest.current){setBusy(false);setCursors(['']);setTick(value=>value+1);}actionLock.current=false;
  }
 };
 const analyze=async(id:string,intent='diagnose')=>{
  if(handoffLock.current||actionLock.current)return;handoffLock.current=true;setHandoffBusy(true);setActionError('');
  try{const conversation=await api<Conversation>('/conversations',{system_reference:{id,intent}});if(alive.current){setChatId(conversation.id);navigate('chat');}}
  catch{if(alive.current)setActionError('操作未完成，请重新读取详情后核对当前版本。');}
  finally{handoffLock.current=false;if(alive.current)setHandoffBusy(false);}
 };
 const sources=(items:SystemSource[],id?:string)=><div id={id} className="system-sources" aria-label={t('来源状态')}>{items.map(source=><div key={source.service} className={'system-source '+(source.available?'':'system-source-unavailable')}><span><i className="status-dot" aria-hidden="true"/>{serviceName(source.service)} · {t(source.available?'已就绪':'未就绪')}</span><small>{t('来源采集时间')} {format(source.observed_at)}</small></div>)}</div>;
 const partial=(items?:SystemSource[])=>items?.some(source=>!source.available);
 const sourceWarning=<Alert type="warning" showIcon title={t('部分来源不可用；当前结果不完整，不能据此判断系统健康。')}/>;
 const related=(workId:string)=>{close();setTab('logs');const next={...initial,work_id:workId};setDraftFilters(next);setFilters(next);setCursors(['']);};
 const work=detail?.work;
 const allowed=work&&(detail?.allowed_actions??work.allowed_actions).filter(action=>systemActions[action]&&(work.classification!=='code_defect'||action==='health_check'));
 const event=selection?.event;
 const renderState=(row:SystemRecord)=><Space orientation="vertical" size={4}><Status value={row.kind==='event'?row.level:row.state}/>{row.kind==='work'&&row.verification_required&&<Status value="需要核验"/>}{row.kind==='work'&&row.issue_opened_at&&<Typography.Text type="secondary">{t(row.resolved_at?'已恢复':'未恢复')}</Typography.Text>}</Space>;
 const eventFacts=(item:SystemEvent)=><dl className="system-facts"><dt>{t('首次出现')}</dt><dd>{format(item.first_seen_at)}</dd><dt>{t('最近出现')}</dt><dd>{format(item.last_seen_at)}</dd><dt>{t('创建时间')}</dt><dd>{format(item.created_at)}</dd><dt>{t('问题次数')}</dt><dd>{item.count}</dd><dt>{t('安全原因')}</dt><dd>{code(item.code)} <code>{item.code}</code></dd><dt>{t('服务与编号')}</dt><dd>{serviceName(item.service)} · {item.id}</dd></dl>;
 return <div id="system-page" className="system-page">
  <Typography.Paragraph type="secondary">{t('查看系统内部状态，跟踪异常与处理结果。')}</Typography.Paragraph>
  <div id="system-metrics" className="system-metrics" aria-busy={statusLoading}>{[
   ['需要处理',status?.summary.unresolved],['等待重试',status?.summary.states.retrying],['正在运行',status?.summary.states.running],['最近恢复',status?.summary.recovered_24h],
  ].map(([label,value])=><Card key={label} className="system-metric"><Typography.Text type="secondary">{t(String(label))}</Typography.Text><strong>{value===undefined?'—':value}</strong><small>{t(status&&!status.summary.complete?'仅可用来源':label==='最近恢复'?'过去 24 小时':'来源状态')}</small></Card>)}</div>
  {statusError&&<Alert type="warning" showIcon title={t(status?'刷新失败，数据可能过期；保留上次读取的记录。':'概览暂时无法读取。')}/>}
  {status&&<div className="system-summary-source"><Typography.Text type="secondary">{t('最后采集')} {format(status.sampled_at)}</Typography.Text>{sources(status.sources)}{!status.summary.complete&&sourceWarning}{status.summary.collections.filter(item=>item.gap_count>0||item.pending).map(item=><Alert key={item.service} type="warning" showIcon title={serviceName(item.service)+' · '+t(item.pending?'待补记采集证据':'采集存在缺口')} description={<span>{t('采集失败次数')} {item.failed_operations} · {t('最近采集失败')} {format(item.last_failed_at)} · {t('最近采集恢复')} {format(item.last_recovered_at)}</span>}/>)}</div>}
  <Tabs activeKey={tab} onChange={chooseTab} aria-label={t('系统运维')} items={[{key:'issues',label:t('待处理问题')},{key:'work',label:t('后台工作')},{key:'logs',label:t('系统日志')}]}/>
  <Panel title={t(tab==='issues'?'待处理问题':tab==='work'?'后台工作':'系统日志')} extra={<Button id="system-refresh" onClick={refresh} loading={loading||statusLoading}>{t('刷新')}</Button>}>
   <form className="system-filters" onSubmit={e=>{e.preventDefault();if(!loading)apply();}}>
    <Input id="system-search" type="search" maxLength={200} aria-label={t('搜索关键词、错误码或编号')} placeholder={t('搜索关键词、错误码或编号')} value={draftFilters.search} onChange={e=>setDraftFilters(value=>({...value,search:e.target.value}))}/>
    <Select id="system-service" aria-label={t('按服务筛选')} value={draftFilters.service} options={[{value:'',label:t('全部服务')},...services.map(value=>({value,label:serviceName(value)}))]} onChange={service=>setDraftFilters(value=>({...value,service}))}/>
    <Select id="system-module" aria-label={t('按模块筛选')} value={draftFilters.module} options={[{value:'',label:t('全部模块')},...Object.entries(systemModules).map(([value,label])=>({value,label:t(label)}))]} onChange={module=>setDraftFilters(value=>({...value,module}))}/>
    <Select id="system-state" aria-label={t('按状态筛选')} value={draftFilters.state} options={[{value:'',label:t('全部状态')},...states.map(value=>({value,label:<Status value={value}/>}))]} onChange={state=>setDraftFilters(value=>({...value,state}))}/>
    {tab==='issues'&&<Select id="system-resolution" aria-label={t('问题解决状态')} value={draftFilters.resolution} options={['unresolved','recovered','all'].map((value,index)=>({value,label:t(['未恢复','已恢复','全部问题'][index])}))} onChange={resolution=>setDraftFilters(value=>({...value,resolution}))}/>}
    {tab==='logs'&&<Select id="system-level" aria-label={t('按级别筛选')} value={draftFilters.level} options={[{value:'',label:t('全部级别')},...['debug','info','warn','error'].map(value=>({value,label:<Status value={value}/>}))]} onChange={level=>setDraftFilters(value=>({...value,level}))}/>}
    <Select id="system-range" aria-label={t('时间范围')} value={draftFilters.range} options={['all','24h','7d'].map((value,index)=>({value,label:t(['全部时间','最近 24 小时','最近 7 天'][index])}))} onChange={range=>setDraftFilters(value=>({...value,range}))}/>
    <Button id="system-query" type="primary" htmlType="submit" loading={loading}>{t('查询')}</Button>
   </form>
   <Typography.Paragraph className="system-notice" type="secondary">{t(tab==='issues'?'相同问题合并计数，恢复历史按解决状态筛选；当前工作状态单独显示。':tab==='work'?'没有新进展不代表完成；需要核验的工作保留原状态。':'仅记录脱敏系统事件，不包含业务正文、提示词或凭证。')}</Typography.Paragraph>
   {page&&sources(page.sources,'system-sources')}{partial(page?.sources)&&sourceWarning}
   {pageError&&<Alert type="warning" showIcon title={t(page?'刷新失败，数据可能过期；保留上次读取的记录。':'数据加载失败，请刷新重试。')}/>}
   {actionError&&!selection&&<Alert type="error" showIcon title={t(actionError)}/>}
   {loading&&!page?<LoadingState/>:<Table<SystemRecord> id="system-records" rowKey="id" dataSource={page?.items??[]} loading={loading} pagination={false} tableLayout="fixed" className="responsive-table expanded-table system-table" locale={{emptyText:<Empty description={t(pageError?'数据加载失败，请刷新重试。':'没有匹配的记录，请调整筛选条件。')}/>}} columns={[
    {title:t(tab==='issues'?'问题与影响':'名称与原因'),key:'name',width:'29%',className:'table-name-cell',render:(_,row)=><TableField label={t('名称与原因')}><strong>{t(systemModules[row.module]??'系统')}</strong><div>{code(row.code)}</div><small><code>{row.code}</code>{row.kind==='work'?' · '+t('问题次数')+' '+row.issue_count:' · '+row.count}</small></TableField>},
    {title:t('服务与编号'),key:'identity',width:'21%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('服务与编号')}><div>{serviceName(row.service)}</div><TableIdentifier value={row.id}/></TableField>},
    {title:t('当前状态'),key:'state',width:'16%',className:'table-status-cell',render:(_,row)=><TableField label={t('当前状态')}>{renderState(row)}</TableField>},
    {title:t(tab==='logs'?'最近出现':'最近进展'),key:'progress',width:'20%',className:'table-meta-cell',render:(_,row)=><TableField label={t(tab==='logs'?'最近出现':'最近进展')}>{format(row.kind==='event'?row.last_seen_at:row.last_progress_at)}{row.kind==='work'&&<><small>{progress(row)}</small>{row.next_retry_at&&<small>{t('下次重试')} {format(row.next_retry_at)}</small>}</>}</TableField>},
    {title:t('操作'),key:'actions',width:'14%',className:'table-actions-cell',render:(_,row)=><Space wrap size={4}><Button type="link" onClick={()=>void inspect(row)}>{t('详情')}</Button>{row.kind==='work'&&<Button type="link" disabled={handoffBusy} onClick={()=>void analyze(row.id)}>{t('Agent 分析')}</Button>}</Space>},
   ]}/>}
   <div id="system-pagination" className="system-pagination"><Button disabled={cursors.length===1||loading} onClick={()=>setCursors(value=>value.slice(0,-1))}>{t('上一页')}</Button><Typography.Text type="secondary">{t('每页 {limit} 条 · 第 {page} 页 · 本页 {count} 条',{limit:pageSize,page:page?loadedPage:cursors.length,count:page?.items.length??0})}</Typography.Text><Button disabled={!page?.next_cursor||loading||pageError} onClick={()=>{if(page?.next_cursor)setCursors(value=>[...value,page.next_cursor!]);}}>{t('下一页')}</Button></div>
   <Typography.Paragraph className="system-page-help" type="secondary">{t('当前状态游标分页；来源恢复或数据变化后请从首页刷新。')}</Typography.Paragraph>
  </Panel>
  <Typography.Paragraph className="system-retention" type="secondary">{t('系统记录遵循全局历史清理的启用开关与保留天数；未完成工作、未恢复问题及必要证据受保护。')}</Typography.Paragraph>
  <AdminDrawer open={!!selection} title={t(event?'系统事件详情':'系统工作详情')} subtitle={event?.id??selection?.id} width={620} onClose={close}>
   <div id="system-detail" className="system-detail" aria-busy={detailLoading||busy}>
    {detailLoading?<LoadingState/>:event?<>{eventFacts(event)}{event.work_id&&<Button onClick={()=>void inspect({id:event.work_id,kind:'work'} as SystemWork)}>{t('系统工作详情')}</Button>}</>:<>
     {detail&&sources(detail.sources)}{partial(detail?.sources)&&sourceWarning}
     {detailError&&<Alert type="error" showIcon title={t('详情暂时无法读取，请重试。')}/>}
     <Button disabled={busy} onClick={()=>void reloadDetail()}>{t('重新读取详情')}</Button>
     {!detailLoading&&detail&&!work&&<Alert type="warning" showIcon title={t('找不到工作；请核对来源状态或刷新。')}/>}
     {work&&<>
      <div className="system-detail-state">{renderState(work)}<Typography.Text>{t(systemClassifications[work.classification]??'分类待确认')}</Typography.Text></div>
      {work.stale&&<Alert type="warning" showIcon title={t('记录可能过期，请核对来源与进展。')} description={progress(work)}/>}
      <dl className="system-facts">{[
       ['服务与编号',<TableIdentifier value={work.id}/>],['安全原因',<>{code(work.code)} <code>{work.code}</code></>],['记录版本',work.revision],['创建时间',format(work.created_at)],['首次出现',format(work.issue_opened_at)],['最近进展',<>{format(work.last_progress_at)} · {progress(work)}</>],['首次尝试',format(work.first_attempt_at)],['最近尝试',format(work.last_attempt_at)],['最近成功',format(work.last_success_at)],['下次重试',format(work.next_retry_at)],['尝试次数',work.attempts],['连续失败',work.consecutive_failures],['问题次数',work.issue_count],['待处理数量',work.pending_count],
      ].map(([label,value])=><div className="system-fact" key={String(label)}><dt>{t(String(label))}</dt><dd>{value}</dd></div>)}</dl>
      {result&&<Alert role="status" type={result==='已核验恢复'?'success':'info'} showIcon title={t(result)}/>}{actionError&&<Alert type="error" showIcon title={t(actionError)}/>}
      <div className="system-detail-actions"><Button disabled={busy||handoffBusy||detailError} onClick={()=>void analyze(work.id)}>{t('Agent 分析')}</Button><Button disabled={busy} onClick={()=>related(work.id)}>{t('查看关联日志')}</Button>{allowed&&allowed.length>0?allowed.map(action=><Button key={action} type="primary" disabled={busy||detailError||partial(detail?.sources)} onClick={()=>void mutate('maintain',action)}>{t(systemActions[action])}</Button>):<Typography.Text type="secondary">{t('未提供受控维护操作。')}</Typography.Text>}</div>
      <div className="system-detail-actions"><Button disabled={busy||detailError||partial(detail?.sources)} onClick={()=>void mutate('draft')}>{t('生成代码问题草稿')}</Button><Button disabled={busy||handoffBusy||detailError} onClick={()=>void analyze(work.id,'issue_draft')}>{t('请 Agent 整理草稿')}</Button>{work.classification==='code_defect'&&<Button disabled={busy||detailError||partial(detail?.sources)} onClick={()=>setReviewOpen(true)}>{t('重新开放维护')}</Button>}</div>
      {draft&&<section id="system-draft"><Alert type="info" showIcon title={t('未提交 GitHub；请核对脱敏内容后自行发布。')}/><Typography.Link href={draft.repository_url} target="_blank" rel="noopener noreferrer">{draft.repository_url}</Typography.Link><pre>{draft.markdown}</pre><Button onClick={()=>{void navigator.clipboard.writeText(draft.markdown).then(()=>setCopyResult('草稿已复制。')).catch(()=>setCopyResult('草稿复制失败，请手动选择复制。'));}}>{t('复制草稿')}</Button>{copyResult&&<Typography.Paragraph role="status">{t(copyResult)}</Typography.Paragraph>}</section>}
      <Typography.Title level={3}>{t('处理经过')}</Typography.Title><div className="system-timeline">{(detail?.events??[]).map(item=><div key={item.id}><Typography.Text>{code(item.code)}</Typography.Text><small>{format(item.last_seen_at)} · <code>{item.id}</code> · {item.count}</small></div>)}</div>
     </>}
    </>}
   </div>
  </AdminDrawer>
  <Modal className="admin-overlay admin-modal" open={reviewOpen} title={t('重新开放维护')} okText={t('确认重新开放')} cancelText={t('取消')} onOk={()=>void mutate('review')} onCancel={()=>{if(!actionLock.current)setReviewOpen(false);}} okButtonProps={{loading:busy}} cancelButtonProps={{disabled:busy}} closable={!busy} keyboard={!busy} mask={{closable:!busy}}><Typography.Paragraph>{t('请确认开发者已部署修复或人工已重新诊断。这只解除代码缺陷分类限制，不代表已经恢复，也不会执行修复或重试；问题保持未恢复，直到实际核验。此入口仅供人工使用。')}</Typography.Paragraph></Modal>
 </div>;
}
