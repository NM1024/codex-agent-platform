import {useEffect,useRef,useState} from 'react';
import {Button,Grid,Image,Input,Select,Space,Table,Typography} from 'antd';
import {useConsole} from '../context';
import {AsyncButton,JsonView,Panel,Status,taskStatuses,time,useLoad} from '../components';
import type {Conversation,Task} from '../types';
export default function TasksPage(){
  const {api,operation,act,t,refresh,notify,setChatId,navigate}=useConsole();
  const screens=Grid.useBreakpoint();
  const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[filter,setFilter]=useState({search:'',status:''}),[offset,setOffset]=useState(0),[tick,setTick]=useState(0),[detail,setDetail]=useState<Task>(),[artifacts,setArtifacts]=useState<{url:string;filename:string;image:boolean}[]>([]);
  const retryLock=useRef(false),[retrying,setRetrying]=useState(false),detailsRef=useRef<HTMLDivElement>(null),detailRequest=useRef(0),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const query=new URLSearchParams({...(filter.search?{search:filter.search}:{}),...(filter.status?{status:filter.status}:{}),offset:String(offset),limit:'50'});
  const {data:rows=[],loading}=useLoad(()=>api<Task[]>('/tasks?'+query),[api,filter,offset,refresh,tick]);
  useEffect(()=>{setArtifacts([]);if(!detail)return;let active=true;const urls:string[]=[];
    void Promise.allSettled((detail.artifacts??[]).map(async artifact=>{
      const response=await fetch(`/admin/api/artifacts/${detail.task_id}/${artifact.artifact_id}`,{credentials:'same-origin'});
      if(!response.ok)throw new Error(t('请求失败'));
      const blob=await response.blob();if(!active)return undefined;
      const url=URL.createObjectURL(blob);urls.push(url);return {url,filename:artifact.filename??'artifact.txt',image:artifact.mime?.startsWith('image/')??false};
    })).then(results=>{if(active){setArtifacts(results.flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]));if(results.some(result=>result.status==='rejected'))notify(t('部分产物暂时无法读取。'));}});
    return()=>{active=false;urls.forEach(url=>URL.revokeObjectURL(url));};
  },[detail]);
  useEffect(()=>{if(detail){detailsRef.current?.focus({preventScroll:true});detailsRef.current?.scrollIntoView({behavior:'smooth',block:'start'});}},[detail]);
  const inspect=async(id:string)=>{const request=++detailRequest.current,value=await api<Task>('/tasks/'+id);if(alive.current&&request===detailRequest.current)setDetail(value);};
  const investigate=async(task_id:string)=>{const value=await api<Conversation>('/conversations',{title:t('调查 ')+task_id.slice(0,8),task_id,investigate:true});if(alive.current){setChatId(value.id);navigate('chat');}};
  const submit=()=>{detailRequest.current++;setOffset(0);setDetail(undefined);setFilter({search,status});};
  const retry=async()=>{
    if(retryLock.current||!detail)return;
    retryLock.current=true;setRetrying(true);
    try{await act(async()=>{const next=await operation<Task>('retry',{task_id:detail.task_id});notify(t('已创建新任务 ')+next.task_id+t('，原记录保留。'));setDetail(undefined);setTick(value=>value+1);});}
    finally{retryLock.current=false;setRetrying(false);}
  };
  return <Space orientation="vertical" size="large" className="full-width">
    <Typography.Paragraph type="secondary">{t('执行完成不等于所有业务项都成功。查看详情可区分最终结果、具体错误与交付状态。')}</Typography.Paragraph>
    <div className="task-filters"><Select id="task-status" aria-label={t('任务状态')} value={status} options={[{value:'',label:t('全部状态')},...taskStatuses.map(value=>({value,label:<Status value={value}/>}))]} onChange={setStatus}/><Input id="task-search" aria-label={t('搜索任务')} placeholder={t('搜索请求编号或输入内容')} value={search} onChange={event=>setSearch(event.target.value)} onPressEnter={()=>{if(!loading)submit();}}/><Button type="primary" loading={loading} onClick={submit}>{t('查询')}</Button></div>
    <Panel title={t('执行记录')}><Table<Task> loading={loading} rowKey="task_id" dataSource={rows} pagination={false} tableLayout="fixed" columns={[
      {title:t('业务 / 任务'),render:(_,row)=><div className="task-identity">{row.type}<br/><Typography.Text code ellipsis title={row.task_id}>{row.task_id}</Typography.Text><div className="task-request">{row.request_id?t('请求编号：{id}',{id:row.request_id}):''}</div></div>},
      {title:t('执行状态'),width:screens.md?108:82,render:(_,row)=><Status value={row.status}/>},
      {title:t('错误'),responsive:['md'],render:(_,row)=>row.error?.message??row.error?.code??'—'},
      {title:t('创建时间'),responsive:['lg'],render:(_,row)=>time(row.created_at)},
      {title:t('操作'),width:screens.md?160:84,render:(_,row)=><div className="task-row-actions"><AsyncButton onClick={()=>inspect(row.task_id)}>{t('详情')}</AsyncButton><AsyncButton onClick={()=>investigate(row.task_id)}>{t('调查')}</AsyncButton></div>},
    ]}/></Panel>
    <Space wrap><Button disabled={offset===0} onClick={()=>setOffset(value=>Math.max(0,value-50))}>{t('上一页')}</Button><Typography.Text>{t('从第 {start} 条开始 · 本页 {count} 条',{start:rows.length?offset+1:0,count:rows.length})}</Typography.Text><Button disabled={rows.length<50} onClick={()=>setOffset(value=>value+50)}>{t('下一页')}</Button></Space>
    {detail&&<div id="task-details" tabIndex={-1} ref={detailsRef}><Panel title={t('任务详情')}><Space wrap><AsyncButton onClick={()=>investigate(detail.task_id)}>{t('让 Agent 查看')}</AsyncButton>{['completed','failed'].includes(detail.status)&&<Button type="primary" loading={retrying} onClick={()=>void retry()}>{t('重新执行任务')}</Button>}</Space><Typography.Paragraph>{t('HTTP accepted 表示接口接收；业务端异步保存是否成功，以业务端记录为准。')}</Typography.Paragraph><JsonView value={detail}/><div className="previews">{artifacts.map(item=>item.image?<Image key={item.url} src={item.url} alt={item.filename}/>:<Typography.Link key={item.url} href={item.url} download={item.filename}>{item.filename}</Typography.Link>)}</div></Panel></div>}
  </Space>;
}
