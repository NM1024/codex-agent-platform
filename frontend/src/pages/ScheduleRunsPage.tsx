import {useEffect,useState} from 'react';
import {Alert,Button,Descriptions,Input,Select,Space,Table,Tooltip,Typography} from 'antd';
import {useConsole} from '../context';
import {Panel,Status,TableField,TableIdentifier,taskStatuses,time} from '../components';
import {AdminDrawer} from '../AdminOverlays';
import {ExecutionNotifications} from '../ExecutionNotifications';
import {InvestigationDialog} from '../InvestigationDialog';
import {PluginActionIcon} from '../PluginActionIcon';
import {Icon} from '../Icon';
interface Execution {id:string;schedule_id:string;schedule_name:string;kind:'task'|'inspection';status:string;timezone:string;created_at:number;due_at:number;message?:string;error?:{code:string;message?:string}}
export default function ScheduleRunsPage(){
 const {api,t}=useConsole();
 const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[filter,setFilter]=useState({search:'',status:''}),[offset,setOffset]=useState(0),[tick,setTick]=useState(0),[selected,setSelected]=useState<Execution>(),[investigate,setInvestigate]=useState<string>();
 const query=new URLSearchParams({...filter,offset:String(offset),limit:'50'});
 const [data,setData]=useState<Execution[]>(),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setLoading(true);void api<Execution[]>('/schedule-runs?'+query).then(value=>{if(active){setData(value);setError(false);}}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,filter,offset,tick]);
 const rows=data??[];
 return <Space orientation="vertical" size="large" className="full-width">
  <div className="task-filters"><Select virtual={false} aria-label={t('任务状态')} value={status} onChange={setStatus} options={[{value:'',label:t('全部状态')},...[...new Set([...taskStatuses,'pending','interrupted','cancelled','unknown'])].map(value=>({value,label:<Status value={value}/>}))]}/><Input aria-label={t('搜索定时执行')} placeholder={t('搜索计划名称或执行编号')} value={search} onChange={event=>setSearch(event.target.value)} onPressEnter={()=>{setOffset(0);setFilter({search,status});setTick(value=>value+1);}}/><Button type="primary" aria-label={t('查询')} aria-busy={loading} loading={loading} onClick={()=>{setOffset(0);setFilter({search,status});setTick(value=>value+1);}}>{t('查询')}</Button></div>
  {error&&<Alert type="error" title={t('定时执行记录暂时无法读取，请重试。')} action={<Button onClick={()=>setTick(value=>value+1)}>{t('重试')}</Button>}/>}
  <Panel title={t('定时任务执行记录')}>
   <Table<Execution> loading={loading} rowKey="id" dataSource={rows} pagination={false} className="responsive-table expanded-table" tableLayout="fixed" locale={{emptyText:t('暂无计划执行记录')}} columns={[
    {title:t('计划名称'),key:'name',width:'16%',className:'table-name-cell',render:(_,row)=><TableField label={t('计划名称')}><span className="table-summary" title={row.schedule_name}>{row.schedule_name}</span></TableField>},
    {title:t('计划类型'),key:'kind',width:'12%',className:'table-target-cell',render:(_,row)=><TableField label={t('计划类型')}>{t(row.kind==='inspection'?'管理巡检':'业务任务')}</TableField>},
    {title:t('执行编号'),key:'id',width:'20%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('执行编号')}><TableIdentifier value={row.id}/></TableField>},
    {title:t('执行状态'),key:'status',width:104,className:'table-status-cell',render:(_,row)=><TableField label={t('执行状态')}><Status value={row.status}/></TableField>},
    {title:t('错误'),key:'error',className:'table-text-cell',render:(_,row)=><TableField label={t('错误')}><span className="table-summary" title={row.error?.message??row.error?.code}>{row.error?.message??row.error?.code??'—'}</span></TableField>},
    {title:t('创建时间'),key:'created',width:150,className:'table-meta-cell',render:(_,row)=><TableField label={t('创建时间')}>{time(row.created_at)}</TableField>},
    {title:t('操作'),key:'actions',width:100,className:'table-actions-cell',render:(_,row)=><div className="admin-row-actions"><Tooltip title={t('详情')} trigger={['hover','focus']}><Button type="text" aria-label={t('详情')} icon={<PluginActionIcon name="eye"/>} onClick={()=>setSelected(row)}/></Tooltip><Tooltip title={t('调查')} trigger={['hover','focus']}><Button type="text" aria-label={t('调查')} icon={<Icon name="conversations"/>} onClick={()=>setInvestigate(row.id)}/></Tooltip></div>},
   ]}/>
  </Panel>
  <Space wrap><Button disabled={offset===0||loading} onClick={()=>setOffset(value=>Math.max(0,value-50))}>{t('上一页')}</Button><Typography.Text>{t('从第 {start} 条开始 · 本页 {count} 条',{start:rows.length?offset+1:0,count:rows.length})}</Typography.Text><Button disabled={rows.length<50||loading} onClick={()=>setOffset(value=>value+50)}>{t('下一页')}</Button></Space>
  <AdminDrawer open={!!selected} title={t('定时执行详情')} subtitle={selected?.id} onClose={()=>setSelected(undefined)} extra={selected&&<Button onClick={()=>setInvestigate(selected.id)}>{t('调查')}</Button>}>
   {selected&&<><Descriptions column={{xs:1,sm:2}} items={[{key:'name',label:t('计划名称'),children:selected.schedule_name},{key:'kind',label:t('计划类型'),children:t(selected.kind==='inspection'?'管理巡检':'业务任务')},{key:'id',label:t('执行编号'),children:<TableIdentifier value={selected.id}/>},{key:'status',label:t('执行状态'),children:<Status value={selected.status}/>},{key:'time',label:t('创建时间'),children:time(selected.created_at)},{key:'zone',label:t('时区'),children:selected.timezone},{key:'error',label:t('错误'),children:selected.error?.message??selected.error?.code??'—'}]}/>{selected.message&&<Typography.Paragraph className="literal-text">{selected.message}</Typography.Paragraph>}<ExecutionNotifications key={selected.kind+selected.id} kind={selected.kind} id={selected.id}/></>}
  </AdminDrawer>
  {investigate&&<InvestigationDialog key={investigate} id={investigate} scheduled onClose={()=>setInvestigate(undefined)}/>}
 </Space>;
}
