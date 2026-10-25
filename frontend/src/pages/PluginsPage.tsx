import {useState} from 'react';
import {Button,Descriptions,Switch,Table,Typography} from 'antd';
import {AgentGuidance,DeleteAction,EnableToggle,JsonView,Panel,Status,TableField,TableIdentifier,useLoad} from '../components';
import {useConsole} from '../context';
import PluginConnectionModal from '../PluginConnectionModal';
import PluginIntegrationDrawer from '../PluginIntegrationDrawer';
import type {Plugin,PluginConnection,PluginList} from '../types';

export default function PluginsPage() {
  const {api,operation,t,locale}=useConsole();
  const [selectedType,setSelectedType]=useState<string>();
  const [connectionPlugin,setConnectionPlugin]=useState<Plugin>(),[loadVersion,setLoadVersion]=useState(0);
  const [integrationPlugin,setIntegrationPlugin]=useState<Plugin>();
  const {data,setData,loading}=useLoad(()=>api<PluginList>('/plugins'),[api,loadVersion]);
  const updateConnection=(connection:PluginConnection)=>setData(current=>current?{...current,configured:current.configured.map(plugin=>plugin.type===connection.type?{...plugin,enabled:connection.ready?plugin.enabled:false,connection:{ready:connection.ready,entryAddress:connection.entryAddress,entryPath:connection.entryPath,entryKeyClaimable:connection.entryKeyClaimable,callbackConfigured:!!connection.callbackUrl,missingFields:connection.missingFields}}:plugin)}:current);
  const selected=data?.configured.find(plugin=>plugin.type===selectedType);
  return <>
    <AgentGuidance title={t('业务插件配置')} description={t('新增、编辑业务逻辑和试运行请通过管理 Agent 操作。Agent 可初始化缺失的入口密钥；请点击「配置接入」由管理员领取一次、修改凭证或设置回调，勿将凭证发送到聊天。完成必填接入配置后才能启用、提交任务、试运行或执行定时计划。')}/>
    <Panel title={t('已注册业务')}>
      <Table<Plugin> className="responsive-table expanded-table" rowKey="type" dataSource={data?.configured??[]} loading={loading} pagination={false} tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('业务名称'),key:'business',width:'14%',className:'table-name-cell',render:(_,plugin)=><TableField label={t('业务名称')}><div className="table-summary" title={plugin.name}>{plugin.name}</div></TableField>},
        {title:t('业务标识'),key:'type',width:'18%',className:'table-identifier-cell',render:(_,plugin)=><TableField label={t('业务标识')}><TableIdentifier value={plugin.type}/></TableField>},
        {title:t('启用状态'),key:'status',width:100,className:'table-status-cell',render:(_,plugin)=><TableField label={t('启用状态')}>{!plugin.connection?.ready&&plugin.enabled!==true?<div className="enable-toggle"><Switch checked={false} disabled aria-label={t('启停业务插件：{name}',{name:plugin.name})} aria-describedby={'plugin-connection-status-'+plugin.type}/></div>:<EnableToggle enabled={plugin.enabled??false} label={t('启停业务插件：{name}',{name:plugin.name})} onChange={async enabled=>{
          const updated=await operation<Plugin>('plugin_enable',{type:plugin.type,enabled});
          setData(current=>current?{...current,configured:current.configured.map(item=>item.type===updated.type?updated:item)}:current);
        }}/>}</TableField>},
        {title:t('接入状态'),key:'connection',width:150,className:'table-connection-cell',render:(_,plugin)=><TableField label={t('接入状态')}><Status id={'plugin-connection-status-'+plugin.type} value={plugin.connection?.ready?'接入已就绪':plugin.connection?.entryKeyClaimable?'待领取入口密钥':'待配置接入'}/></TableField>},
        {title:t('说明'),dataIndex:'description',className:'table-text-cell',render:value=><TableField label={t('说明')}><div className="table-summary" title={value}>{value||'—'}</div></TableField>},
        {title:t('操作'),key:'actions',width:360,className:'table-actions-cell',render:(_,plugin)=><div className="plugin-row-actions"><Button onClick={()=>setConnectionPlugin(plugin)}>{t('配置接入')}</Button><Button type="text" onClick={()=>setIntegrationPlugin(plugin)}>{t('对接文档')}</Button><Button type="text" onClick={()=>setSelectedType(plugin.type)}>{t('查看详情')}</Button><DeleteAction label={t('删除业务插件：{name}',{name:plugin.name})} name={plugin.name} description={t('删除后从列表隐藏、停止接收新任务，并停用关联的定时计划。已接单任务继续执行，历史任务和结果保留。')} onDelete={async()=>{
          await operation('plugin_delete',{type:plugin.type});
          setData(current=>current?{...current,configured:current.configured.filter(item=>item.type!==plugin.type)}:current);
          if(connectionPlugin?.type===plugin.type)setConnectionPlugin(undefined);
          if(integrationPlugin?.type===plugin.type)setIntegrationPlugin(undefined);
          if(selectedType===plugin.type)setSelectedType(undefined);
        }}/></div>},
      ]}/>
    </Panel>
    {integrationPlugin&&<PluginIntegrationDrawer key={integrationPlugin.type+':'+locale} plugin={integrationPlugin} onClose={()=>setIntegrationPlugin(undefined)} onConfigure={()=>{setConnectionPlugin(integrationPlugin);setIntegrationPlugin(undefined);}}/>}
    {connectionPlugin&&<PluginConnectionModal key={connectionPlugin.type} plugin={connectionPlugin} onClose={()=>{setConnectionPlugin(undefined);setLoadVersion(value=>value+1);}} onClaimed={updateConnection} onSaved={connection=>{
      updateConnection(connection);
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
