import {useState} from 'react';
import {Button,Descriptions,Grid,Switch,Table,Typography} from 'antd';
import {AgentGuidance,EnableToggle,JsonView,Panel,useLoad} from '../components';
import {useConsole} from '../context';
import PluginConnectionModal from '../PluginConnectionModal';
import type {Plugin,PluginList} from '../types';

export default function PluginsPage() {
  const {api,operation,t,refresh}=useConsole();
  const [selectedType,setSelectedType]=useState<string>();
  const [connectionPlugin,setConnectionPlugin]=useState<Plugin>(),[loadVersion,setLoadVersion]=useState(0);
  const screens=Grid.useBreakpoint();
  const {data,setData,loading}=useLoad(()=>api<PluginList>('/plugins'),[api,refresh,loadVersion]);
  const selected=data?.configured.find(plugin=>plugin.type===selectedType);
  return <>
    <AgentGuidance title={t('业务插件配置')} description={t('新增、编辑业务逻辑和试运行请通过管理 Agent 操作。接入地址和凭证请点击「配置接入」由管理员填写，勿发送到聊天。完成必填接入配置后才能启用、提交任务、试运行或执行定时计划。')}/>
    <Panel title={t('已注册业务')}>
      <Table<Plugin> rowKey="type" dataSource={data?.configured??[]} loading={loading} pagination={false} tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('业务'),key:'business',render:(_,plugin)=><>{plugin.name}<br/><Typography.Text code ellipsis title={plugin.type}>{plugin.type}</Typography.Text></>},
        {title:t('状态'),key:'status',width:104,render:(_,plugin)=><div className="plugin-connection-status">{!plugin.connection?.ready&&plugin.enabled!==true?<div className="enable-toggle"><Switch checked={false} disabled aria-label={t('启停业务插件：{name}',{name:plugin.name})} aria-describedby={'plugin-connection-status-'+plugin.type}/></div>:<EnableToggle enabled={plugin.enabled??false} label={t('启停业务插件：{name}',{name:plugin.name})} onChange={async enabled=>{
          const updated=await operation<Plugin>('plugin_enable',{type:plugin.type,enabled});
          setData(current=>current?{...current,configured:current.configured.map(item=>item.type===updated.type?updated:item)}:current);
        }}/>}<Typography.Text id={'plugin-connection-status-'+plugin.type} type={plugin.connection?.ready?'secondary':'warning'}>{t(plugin.connection?.ready?'接入已就绪':'待配置接入')}</Typography.Text></div>},
        {title:t('说明'),dataIndex:'description',responsive:['md']},
        {title:t('操作'),key:'actions',width:screens.md?288:96,render:(_,plugin)=><div className="plugin-row-actions"><Button onClick={()=>setConnectionPlugin(plugin)}>{t('配置接入')}</Button><Button onClick={()=>setSelectedType(plugin.type)}>{t('查看详情')}</Button></div>},
      ]}/>
    </Panel>
    {connectionPlugin&&<PluginConnectionModal key={connectionPlugin.type} plugin={connectionPlugin} onClose={()=>setConnectionPlugin(undefined)} onSaved={connection=>{
      setData(current=>current?{...current,configured:current.configured.map(plugin=>plugin.type===connection.type?{...plugin,enabled:connection.ready?plugin.enabled:false,connection:{ready:connection.ready,entryPath:connection.entryPath,callbackConfigured:!!connection.callbackUrl,missingFields:connection.missingFields}}:plugin)}:current);
      setConnectionPlugin(undefined);setLoadVersion(value=>value+1);
    }}/>}
    {selected&&<Panel title={t('插件定义')}><div id="plugin-detail">
      <Descriptions column={1} items={[
        {key:'model',label:t('模型'),children:selected.execution?.model??t('继承全局设置')},
        {key:'effort',label:t('思考程度'),children:selected.execution?.reasoningEffort??t(selected.execution&&Object.hasOwn(selected.execution,'reasoningEffort')?'模型默认':'继承默认设置')},
      ]}/>
      <JsonView value={selected}/>
    </div></Panel>}
    {!!data?.builtin?.length&&<Typography.Paragraph type="secondary">{t('兼容模块：')+data.builtin.map(item=>item.type).join('、')}</Typography.Paragraph>}
    {!!data?.invalid?.length&&<Panel title={t('无效插件')}><JsonView value={data.invalid}/></Panel>}
  </>;
}
