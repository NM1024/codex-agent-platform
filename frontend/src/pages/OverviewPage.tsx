import {useEffect,useState} from 'react';
import {Button,Col,InputNumber,Row,Space,Statistic,Table,Typography} from 'antd';
import {useConsole} from '../context';
import {bytes,Panel,Status,time,useLoad} from '../components';
import type {Conversation,Overview,Task} from '../types';
export default function OverviewPage(){
  const {api,operation,act,t,refresh,notify,navigate,setChatId}=useConsole(),[tick,setTick]=useState(0),[concurrency,setConcurrency]=useState(1);
  const {data}=useLoad(()=>api<Overview>('/overview'),[api,refresh,tick]);
  useEffect(()=>{const timer=setInterval(()=>setTick(value=>value+1),10000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(data?.platform.runtime)setConcurrency(data.platform.runtime.concurrency);},[data?.platform.runtime?.concurrency]);
  if(!data)return null;
  const platform=data.platform,host=data.resources.host??{},counts=platform.tasks??{},runtime=platform.runtime;
  const investigate=(task_id:string)=>act(async()=>{const conversation=await api<Conversation>('/conversations',{title:t('调查 ')+task_id.slice(0,8),task_id,investigate:true});setChatId(conversation.id);navigate('chat');});
  return <Space orientation="vertical" size="large" className="full-width">
    <Typography.Paragraph type="secondary">{t('状态来自实时采集与执行记录。点击异常，即可让管理 Agent 带着上下文调查。')}</Typography.Paragraph>
    <Typography.Text id="updated" type="secondary">{t('采样于 {time}',{time:time(data.resources.sampled_at??data.sampled_at)})}</Typography.Text>
    <Row gutter={[16,16]}>{[
      [t('宿主 CPU'),host.available?(host.cpu_percent==null?t('采样中'):host.cpu_percent+'%'):t('不可用')],
      [t('宿主内存'),host.memory_used_bytes===undefined?t('不可用'):bytes(host.memory_used_bytes)],
      [t('正在执行'),(counts.running??0)+(counts.dispatching??0)+(counts.completing??0)],
      [t('累计执行失败'),counts.failed??0],
    ].map(([title,value])=><Col xs={12} xl={6} key={title}><Panel title={String(title)}><Statistic value={value}/></Panel></Col>)}</Row>
    <Panel title={t('服务状态')}><Space wrap><Typography.Text>Manager</Typography.Text><Status value="程序可用"/><Typography.Text>Gateway</Typography.Text><Status value={platform.unavailable?'failed':'程序可用'}/><Typography.Text>Codex Runner</Typography.Text><Status value={platform.runner?.ready?'已就绪':'未就绪'}/></Space>
      <Typography.Paragraph type="secondary">{platform.runner?.reason??platform.error?.message}</Typography.Paragraph>
      <Typography.Text>{t('Manager 容器内存 ')+bytes(data.resources.container?.memory_used_bytes)+t(' · 数据磁盘可用 ')+bytes(data.resources.disk?.available_bytes)}</Typography.Text>
      <Typography.Paragraph>{t('排队 ')+(counts.queued??0)+t(' · 等待恢复 ')+(counts.suspended??0)+t('执行完成 ')+(counts.completed??0)}</Typography.Paragraph>
    </Panel>
    <Panel title={t('最近执行异常')}><Table<Task> rowKey="task_id" dataSource={platform.recent_errors??[]} pagination={false} scroll={{x:650}} columns={[
      {title:t('业务 / 任务'),render:(_,row)=><>{row.type}<br/><Typography.Text code>{row.task_id}</Typography.Text></>},
      {title:t('原因'),render:(_,row)=>row.error?.message??row.error?.code??t('历史记录未保存详情')},
      {title:t('时间（北京时间）'),render:(_,row)=>time(row.updated_at)},
      {title:t('操作'),render:(_,row)=><Button onClick={()=>void investigate(row.task_id)}>{t((data.investigations??[]).some(item=>item.task_id===row.task_id)?'查看调查':'让 Agent 调查')}</Button>},
    ]}/></Panel>
    <Panel title={t('调度设置')}><Space wrap>
      <Button onClick={()=>void act(async()=>{await operation('runtime_update',{paused:!runtime?.paused});setTick(value=>value+1);})}>{t(runtime?.paused?'恢复领取':'暂停领取')}</Button>
      <Typography.Text>{t('业务并发')}</Typography.Text><InputNumber id="concurrency" aria-label={t('业务并发')} min={1} value={concurrency} onChange={value=>setConcurrency(value??1)}/>
      <Button type="primary" onClick={()=>void act(async()=>{await operation('runtime_update',{concurrency});notify(t('并发设置已保存。'));})}>{t('保存')}</Button>
      <Button onClick={()=>void act(async()=>{await operation('service_restart',{service:'runner'});notify(t('已请求重启 Runner，请稍后刷新确认。'));})}>{t('重启 Runner')}</Button>
    </Space></Panel>
  </Space>;
}
