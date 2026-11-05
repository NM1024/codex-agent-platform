import {useEffect,useState} from 'react';
import {Alert,Button,Descriptions,Select,Space,Table,Tooltip,Typography} from 'antd';
import {useConsole} from '../context';
import {Panel,Status,TableField,TableIdentifier,taskStatuses,time} from '../components';
import {AdminDrawer} from '../AdminOverlays';
import {ExecutionNotifications} from '../ExecutionNotifications';
import {InvestigationDialog} from '../InvestigationDialog';
import {PluginActionIcon} from '../PluginActionIcon';
import {Icon} from '../Icon';
import {ListPagination} from '../ListPagination';
import {RecordFilters,recordAfter,type RecordRange} from './RecordFilters';
interface Execution {id:string;schedule_id:string;schedule_name:string;kind:'task'|'inspection';status:string;timezone:string;created_at:number;due_at:number;message?:string;error?:{code:string;message?:string}}
export default function ScheduleRunsPage(){
 const {api,t}=useConsole();
 const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[kind,setKind]=useState(''),[range,setRange]=useState<RecordRange>('all'),[filter,setFilter]=useState<{search:string;status:string;kind:string;after?:number}>({search:'',status:'',kind:''}),[offset,setOffset]=useState(0),[pageSize,setPageSize]=useState(20),[tick,setTick]=useState(0),[selected,setSelected]=useState<Execution>(),[investigate,setInvestigate]=useState<string>();
 const query=new URLSearchParams({...(filter.search?{search:filter.search}:{}),...(filter.status?{status:filter.status}:{}),...(filter.kind?{kind:filter.kind}:{}),...(filter.after!==undefined?{after:String(filter.after)}:{}),offset:String(offset),limit:String(pageSize),include_total:'1'});
 const [data,setData]=useState<Execution[]|{items:Execution[];total:number}>(),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setLoading(true);void api<Execution[]|{items:Execution[];total:number}>('/schedule-runs?'+query).then(value=>{if(active){setData(value);setError(false);}}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,filter,offset,pageSize,tick]);
 const rows=Array.isArray(data)?data:data?.items??[],total=data&&!Array.isArray(data)?data.total:null;
 return <Space orientation="vertical" size="large" className="full-width">
  <Panel title={t('定时任务执行记录')} extra={<Button aria-label={t('刷新')} aria-busy={loading} onClick={()=>setTick(value=>value+1)} loading={loading}>{t('刷新')}</Button>}>
   <RecordFilters id="schedule-run" search={search} searchLabel={t('搜索定时执行')} searchPlaceholder={t('搜索计划名称或执行编号')} onSearch={setSearch} typeFilter={<Select virtual={false} id="schedule-run-kind" aria-label={t('计划类型')} value={kind} options={[{value:'',label:t('全部计划类型')},{value:'task',label:t('业务任务')},{value:'inspection',label:t('管理巡检')}]} onChange={setKind}/>} status={status} statuses={[...new Set([...taskStatuses,'pending','interrupted','cancelled','unknown'])]} onStatus={setStatus} range={range} onRange={setRange} loading={loading} onSubmit={()=>{setOffset(0);setFilter({search:search.trim(),status,kind,after:recordAfter(range)});}} onReset={()=>{setSearch('');setStatus('');setKind('');setRange('all');setOffset(0);setFilter({search:'',status:'',kind:''});}}/>
   {error&&<Alert type="error" title={t('定时执行记录暂时无法读取，请重试。')} action={<Button onClick={()=>setTick(value=>value+1)}>{t('重试')}</Button>}/>}
   <Table<Execution> loading={loading} rowKey="id" dataSource={rows} pagination={false} className="responsive-table expanded-table" tableLayout="fixed" locale={{emptyText:t('暂无计划执行记录')}} columns={[
    {title:t('计划名称'),key:'name',width:'16%',className:'table-name-cell',render:(_,row)=><TableField label={t('计划名称')}><span className="table-summary" title={row.schedule_name}>{row.schedule_name}</span></TableField>},
    {title:t('计划类型'),key:'kind',width:'12%',className:'table-target-cell',render:(_,row)=><TableField label={t('计划类型')}>{t(row.kind==='inspection'?'管理巡检':'业务任务')}</TableField>},
    {title:t('执行编号'),key:'id',width:'20%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('执行编号')}><TableIdentifier value={row.id}/></TableField>},
    {title:t('执行状态'),key:'status',width:104,className:'table-status-cell',render:(_,row)=><TableField label={t('执行状态')}><Status value={row.status}/></TableField>},
    {title:t('错误'),key:'error',className:'table-text-cell',render:(_,row)=><TableField label={t('错误')}><span className="table-summary" title={row.error?.message??row.error?.code}>{row.error?.message??row.error?.code??'—'}</span></TableField>},
    {title:t('创建时间'),key:'created',width:150,className:'table-meta-cell',render:(_,row)=><TableField label={t('创建时间')}>{time(row.created_at)}</TableField>},
    {title:t('操作'),key:'actions',width:100,className:'table-actions-cell',render:(_,row)=><div className="admin-row-actions"><Tooltip title={t('详情')} trigger={['hover','focus']}><Button type="text" aria-label={t('详情')} icon={<PluginActionIcon name="eye"/>} onClick={()=>setSelected(row)}/></Tooltip><Tooltip title={t('调查')} trigger={['hover','focus']}><Button type="text" aria-label={t('调查')} icon={<Icon name="conversations"/>} onClick={()=>setInvestigate(row.id)}/></Tooltip></div>},
   ]}/>
  <ListPagination id="schedule-run-pagination" page={Math.floor(offset/pageSize)+1} pageSize={pageSize} total={total} totalComplete={!loading&&!error} loading={loading} disabled={error} hasPrevious={offset>0} hasNext={total===null?rows.length>=pageSize:offset+rows.length<total} onPrevious={()=>setOffset(value=>Math.max(0,value-pageSize))} onNext={()=>setOffset(value=>value+pageSize)} onPageSizeChange={size=>{setOffset(0);setPageSize(size);}}/>
  </Panel>
  <AdminDrawer open={!!selected} title={t('定时执行详情')} subtitle={selected?.id} onClose={()=>setSelected(undefined)} extra={selected&&<Button onClick={()=>setInvestigate(selected.id)}>{t('调查')}</Button>}>
   {selected&&<><Descriptions column={{xs:1,sm:2}} items={[{key:'name',label:t('计划名称'),children:selected.schedule_name},{key:'kind',label:t('计划类型'),children:t(selected.kind==='inspection'?'管理巡检':'业务任务')},{key:'id',label:t('执行编号'),children:<TableIdentifier value={selected.id}/>},{key:'status',label:t('执行状态'),children:<Status value={selected.status}/>},{key:'time',label:t('创建时间'),children:time(selected.created_at)},{key:'zone',label:t('时区'),children:selected.timezone},{key:'error',label:t('错误'),children:selected.error?.message??selected.error?.code??'—'}]}/>{selected.message&&<Typography.Paragraph className="literal-text">{selected.message}</Typography.Paragraph>}<ExecutionNotifications key={selected.kind+selected.id} kind={selected.kind} id={selected.id}/></>}
  </AdminDrawer>
  {investigate&&<InvestigationDialog key={investigate} id={investigate} scheduled onClose={()=>setInvestigate(undefined)}/>}
 </Space>;
}
