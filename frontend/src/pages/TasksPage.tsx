import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Descriptions,Empty,Image,Input,Select,Space,Table,Tabs,Tooltip,Typography} from 'antd';
import {useConsole} from '../context';
import {AsyncButton,DataLoading,JsonView,LoadingState,Panel,Status,TableField,TableIdentifier,taskStatuses,time,useLoad} from '../components';
import {NotificationBindingsPanel} from '../NotificationBindingsPanel';
import {NotificationRetryDialog} from '../NotificationRetryDialog';
import type {Conversation,Task} from '../types';
import {AdminDrawer} from '../AdminOverlays';
import {Icon} from '../Icon';
import {PluginActionIcon} from '../PluginActionIcon';
export default function TasksPage(){
  const {api,operation,act,t,notify,setChatId,navigate}=useConsole();
  const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[filter,setFilter]=useState({search:'',status:''}),[offset,setOffset]=useState(0),[tick,setTick]=useState(0),[detail,setDetail]=useState<Task>(),[artifacts,setArtifacts]=useState<{url:string;filename:string;image:boolean}[]>([]);
  const [retryOpen,setRetryOpen]=useState(false),[detailOpen,setDetailOpen]=useState(false),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState(''),[detailTab,setDetailTab]=useState('summary'),[artifactsLoading,setArtifactsLoading]=useState(false);
  const retryLock=useRef(false),[retrying,setRetrying]=useState(false),detailRequest=useRef(0),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;detailRequest.current++;};},[]);
  const query=new URLSearchParams({...(filter.search?{search:filter.search}:{}),...(filter.status?{status:filter.status}:{}),offset:String(offset),limit:'50'});
  const {data:loadedRows,loading}=useLoad(()=>api<Task[]>('/tasks?'+query),[api,filter,offset,tick]);
  const rows=loadedRows??[];
  useEffect(()=>{setArtifacts([]);setArtifactsLoading(!!detail?.artifacts?.length);if(!detail)return;let active=true;const urls:string[]=[],controller=new AbortController();
    void Promise.allSettled((detail.artifacts??[]).map(async artifact=>{
      const response=await fetch(`/admin/api/artifacts/${detail.task_id}/${artifact.artifact_id}`,{credentials:'same-origin',signal:controller.signal});
      if(!response.ok)throw new Error(t('请求失败'));
      const blob=await response.blob();if(!active)return undefined;
      const url=URL.createObjectURL(blob);urls.push(url);return {url,filename:artifact.filename??'artifact.txt',image:artifact.mime?.startsWith('image/')??false};
    })).then(results=>{if(active){setArtifactsLoading(false);setArtifacts(results.flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]));if(results.some(result=>result.status==='rejected'))notify(t('部分产物暂时无法读取。'));}});
    return()=>{active=false;controller.abort();urls.forEach(url=>URL.revokeObjectURL(url));};
  },[detail]);
  const closeDetail=()=>{if(retryLock.current)return;detailRequest.current++;setDetailOpen(false);setDetail(undefined);setDetailLoading(false);setDetailError('');setRetryOpen(false);};
  const inspect=async(id:string)=>{
    const request=++detailRequest.current;setDetail(undefined);setRetryOpen(false);setDetailTab('summary');setDetailError('');setDetailLoading(true);setDetailOpen(true);
    try{const value=await api<Task>('/tasks/'+encodeURIComponent(id));if(alive.current&&request===detailRequest.current)setDetail(value);}
    catch{if(alive.current&&request===detailRequest.current)setDetailError(t('任务详情暂时无法读取，请重试。'));}
    finally{if(alive.current&&request===detailRequest.current)setDetailLoading(false);}
  };
  const investigate=async(task_id:string)=>{const value=await api<Conversation>('/conversations',{title:t('调查 ')+task_id.slice(0,8),task_id,investigate:true});if(alive.current){setChatId(value.id);navigate('chat');}};
  const submit=()=>{closeDetail();setOffset(0);setFilter({search,status});};
  const retry=async(notification_channels?:string[])=>{
    if(retryLock.current||!detail)return;
    retryLock.current=true;setRetrying(true);const request=detailRequest.current;
    try{const next=await operation<Task>('retry',{task_id:detail.task_id,...(notification_channels!==undefined?{notification_channels}:{})});if(alive.current&&request===detailRequest.current){notify(t('已创建新任务 ')+next.task_id+t('，原记录保留。'));detailRequest.current++;setDetailOpen(false);setDetail(undefined);setRetryOpen(false);setTick(value=>value+1);}}
    finally{retryLock.current=false;if(alive.current)setRetrying(false);}
  };
  if(loading&&loadedRows===undefined)return <DataLoading/>;
  return <Space orientation="vertical" size="large" className="full-width">
    <Typography.Paragraph type="secondary">{t('执行完成不等于所有业务项都成功。查看详情可区分最终结果、具体错误与交付状态。')}</Typography.Paragraph>
    <div className="task-filters"><Select id="task-status" aria-label={t('任务状态')} value={status} options={[{value:'',label:t('全部状态')},...taskStatuses.map(value=>({value,label:<Status value={value}/>}))]} onChange={setStatus}/><Input id="task-search" aria-label={t('搜索任务')} placeholder={t('搜索请求编号或输入内容')} value={search} onChange={event=>setSearch(event.target.value)} onPressEnter={()=>{if(!loading)submit();}}/><Button type="primary" loading={loading} onClick={submit}>{t('查询')}</Button></div>
    <Panel title={t('执行记录')}><Table<Task> loading={loading} rowKey="task_id" dataSource={rows} pagination={false} className="responsive-table expanded-table" tableLayout="fixed" columns={[
      {title:t('业务类型'),key:'type',width:'10%',className:'table-name-cell',render:(_,row)=><TableField label={t('业务类型')}><span className="table-summary" title={row.type}>{row.type}</span></TableField>},
      {title:t('任务编号'),key:'task',width:'18%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('任务编号')}><TableIdentifier value={row.task_id}/></TableField>},
      {title:t('请求编号'),key:'request',width:'14%',className:'table-identifier-cell',render:(_,row)=><TableField label={t('请求编号')}><TableIdentifier value={row.request_id}/></TableField>},
      {title:t('执行状态'),key:'status',width:104,className:'table-status-cell',render:(_,row)=><TableField label={t('执行状态')}><Status value={row.status}/></TableField>},
      {title:t('错误'),key:'error',className:'table-text-cell',render:(_,row)=><TableField label={t('错误')}><span className="table-summary" title={row.error?.message??row.error?.code}>{row.error?.message??row.error?.code??'—'}</span></TableField>},
      {title:t('创建时间'),key:'created',width:150,className:'table-meta-cell',render:(_,row)=><TableField label={t('创建时间')}>{time(row.created_at)}</TableField>},
      {title:t('操作'),key:'actions',width:100,className:'table-actions-cell',render:(_,row)=><div className="admin-row-actions"><Tooltip title={t('详情')} trigger={['hover','focus']}><AsyncButton type="text" aria-label={t('详情')} icon={<PluginActionIcon name="eye"/>} onClick={()=>inspect(row.task_id)}/></Tooltip><Tooltip title={t('调查')} trigger={['hover','focus']}><AsyncButton type="text" aria-label={t('调查')} icon={<Icon name="conversations"/>} onClick={()=>investigate(row.task_id)}/></Tooltip></div>},
    ]}/></Panel>
    <Space wrap><Button disabled={offset===0} onClick={()=>setOffset(value=>Math.max(0,value-50))}>{t('上一页')}</Button><Typography.Text>{t('从第 {start} 条开始 · 本页 {count} 条',{start:rows.length?offset+1:0,count:rows.length})}</Typography.Text><Button disabled={rows.length<50} onClick={()=>setOffset(value=>value+50)}>{t('下一页')}</Button></Space>
    <AdminDrawer open={detailOpen} title={t('任务详情')} subtitle={detail?.task_id} onClose={closeDetail} extra={detail&&<Space wrap><AsyncButton disabled={retrying} onClick={()=>investigate(detail.task_id)}>{t('让 Agent 查看')}</AsyncButton>{['completed','failed'].includes(detail.status)&&<Button type="primary" loading={retrying} onClick={()=>detail.notification_channels?.length?setRetryOpen(true):void act(()=>retry())}>{t('重新执行任务')}</Button>}</Space>}>
      <div id="task-details">
        {detailLoading?<LoadingState/>:detailError?<Alert type="error" showIcon title={detailError}/>:detail&&<Tabs activeKey={detailTab} onChange={setDetailTab} items={[
          {key:'summary',label:t('概览'),children:<><Descriptions column={{xs:1,sm:2}} items={[
            {key:'type',label:t('业务类型'),children:detail.type},
            {key:'id',label:t('任务编号'),children:<TableIdentifier value={detail.task_id}/>},
            {key:'request',label:t('请求编号'),children:<TableIdentifier value={detail.request_id}/>},
            {key:'status',label:t('执行状态'),children:<Status value={detail.status}/>},
            {key:'created',label:t('创建时间'),children:time(detail.created_at)},
            {key:'updated',label:t('更新时间'),children:time(detail.updated_at)},
          ]}/>{detail.input!==undefined&&<><Typography.Title level={3}>{t('业务输入 JSON')}</Typography.Title><JsonView value={detail.input}/></>}<details><summary>{t('原始记录')}</summary><JsonView value={detail}/></details></>},
          {key:'result',label:t('结果'),children:<><Typography.Paragraph type="secondary">{t('HTTP accepted 表示接口接收；业务端异步保存是否成功，以业务端记录为准。')}</Typography.Paragraph><JsonView value={Object.fromEntries(Object.entries(detail).filter(([key])=>['result','error','errors','execution','delivery'].includes(key)))}/></>},
          {key:'notifications',label:t('通知记录'),children:<NotificationBindingsPanel key={detail.task_id} kind="task" id={detail.task_id} readOnly={['completed','failed','cancelled','canceled'].includes(detail.status)}/>},
          {key:'artifacts',label:t('产物'),children:artifactsLoading?<LoadingState/>:!artifacts.length?<Empty description={t('暂无产物')}/>:<div className="previews">{artifacts.map(item=>item.image?<Image key={item.url} src={item.url} alt={item.filename}/>:<Typography.Link key={item.url} href={item.url} download={item.filename}>{item.filename}</Typography.Link>)}</div>},
        ]}/>}
      </div>
    </AdminDrawer>
    {detail&&retryOpen&&<NotificationRetryDialog key={detail.task_id} task={detail} open={retryOpen} onCancel={()=>setRetryOpen(false)} onSubmit={ids=>retry(ids)}/> }
  </Space>;
}
