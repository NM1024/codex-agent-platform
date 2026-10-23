import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Alert,Button,Card,Form,Select,Switch,Tag,Typography} from 'antd';
import {useConsole} from './context';
import type {AgentSettings} from './types';
export const pretty=(value:unknown)=>JSON.stringify(value,null,2);
export const time=(value?:number|string)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'—';
export const bytes=(value?:number)=>value===undefined?'—':value>=1073741824?(value/1073741824).toFixed(1)+' GB':(value/1048576).toFixed(1)+' MB';
const labels:Record<string,string>={queued:'排队中',dispatching:'启动中',running:'运行中',completing:'提交中',suspended:'等待恢复',completed:'执行完成',failed:'执行失败',accepted:'接口已接收',unknown:'结果未知',not_required:'无需交付',pending:'等待交付',interrupted:'等待继续',executing:'操作中'};
export const taskStatuses=['queued','dispatching','running','completing','suspended','completed','failed'];
export function Status({value}:{value:string}){const {t}=useConsole();return <Tag color={['failed','unknown','未就绪'].includes(value)?'error':['completed','accepted','已就绪','已启用','程序可用'].includes(value)?'success':'default'}>{t(labels[value]??value)}</Tag>;}
export function Panel({title,children,extra}:{title:string;children:ReactNode;extra?:ReactNode}){return <Card className="console-panel" title={<Typography.Title level={2}>{title}</Typography.Title>} extra={extra}>{children}</Card>;}
export function AgentGuidance({title,description}:{title:string;description:string}) {
  const {navigate,t}=useConsole();
  return <Alert className="agent-guidance" type="info" showIcon title={title} description={<div className="agent-guidance-content"><Typography.Paragraph>{description}</Typography.Paragraph><Button type="primary" onClick={()=>navigate('chat')}>{t('前往管理对话')}</Button></div>}/>;
}
export function EnableToggle({enabled,label,onChange}:{enabled:boolean;label:string;onChange:(value:boolean)=>Promise<unknown>}) {
  const {act,t}=useConsole(),locked=useRef(false),[loading,setLoading]=useState(false);
  return <div className="enable-toggle"><Switch checked={enabled} aria-label={label} loading={loading} disabled={loading} onChange={value=>{
    if(locked.current)return;
    locked.current=true;setLoading(true);
    void act(()=>onChange(value)).finally(()=>{locked.current=false;setLoading(false);});
  }}/><Typography.Text type="secondary">{t(enabled?'已启用':'已停用')}</Typography.Text></div>;
}
export function JsonView({value}:{value:unknown}){return <pre className="json-view">{pretty(value)}</pre>;}
export function CatalogNote(){const {catalog,t}=useConsole();return catalog.unavailable?<Alert type="warning" showIcon title={t('模型列表暂不可用，保留当前配置。请检查 Codex 登录和服务连接后刷新。')}/>:null;}
export function AgentPicker({id,value,onChange,defaults={},inherit=false}:{id:string;value:AgentSettings;onChange:(value:AgentSettings)=>void;defaults?:AgentSettings;inherit?:boolean}) {
  const {catalog,t}=useConsole(),chosen=value.model??defaults.model,model=catalog.models.find(item=>item.model===chosen);
  const modelOptions=catalog.models.map(item=>({value:item.model,label:item.displayName}));
  if(inherit)modelOptions.unshift({value:'',label:t('继承全局设置')});
  if(value.model&&!modelOptions.some(item=>item.value===value.model))modelOptions.push({value:value.model,label:t('当前保存值：{value}',{value:value.model})});
  const effortOptions=[...(inherit?[{value:'__inherit__',label:t(value.model&&value.model!==defaults.model?'所选模型默认':'继承全局设置')}]:[]),{value:'',label:t('模型默认')},...(model?.supportedReasoningEfforts??[]).map(item=>({value:item.reasoningEffort,label:item.reasoningEffort}))];
  const effort=Object.hasOwn(value,'reasoningEffort')?(value.reasoningEffort??''):inherit?'__inherit__':'';
  if(effort&&!effortOptions.some(item=>item.value===effort))effortOptions.push({value:effort,label:t('当前保存值：{value}',{value:effort})});
  return <div className="form-grid agent-picker">
    <Form.Item label={t('模型')} htmlFor={id+'-model'}><Select id={id+'-model'} value={value.model??''} options={modelOptions} optionFilterProp="label" showSearch onChange={model=>onChange({...(!inherit?{model}:model?{model}:{}),...(!inherit?{reasoningEffort:null}:{})})}/></Form.Item>
    <Form.Item label={t('思考程度')} htmlFor={id+'-reasoningEffort'}><Select id={id+'-reasoningEffort'} value={effort} options={effortOptions} onChange={effort=>{const next={...value};if(effort==='__inherit__')delete next.reasoningEffort;else next.reasoningEffort=effort||null;onChange(next);}}/></Form.Item>
  </div>;
}
export function useLoad<T>(load:()=>Promise<T>,dependencies:unknown[]) {
  const [data,setData]=useState<T>(),[loading,setLoading]=useState(true),{notify,t}=useConsole();
  useEffect(()=>{let active=true;setLoading(true);void load().then(value=>{if(active)setData(value);}).catch(error=>{if(active)notify(t(error.message));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},dependencies);
  return {data,setData,loading};
}
