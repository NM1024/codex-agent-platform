import {useEffect,useState} from 'react';
import {Alert,Button,Descriptions,Switch,Table,Tooltip,Typography} from 'antd';
import {AgentGuidance,DataLoading,DeleteAction,EnableToggle,JsonView,Panel,Status,TableField,TableIdentifier,useLoad} from '../components';
import {AdminDrawer} from '../AdminOverlays';
import {Icon} from '../Icon';
import {useConsole} from '../context';
import PluginConnectionModal from '../PluginConnectionModal';
import PluginIntegrationDrawer from '../PluginIntegrationDrawer';
import PluginDefinitionEditor from '../PluginDefinitionEditor';
import {PluginActionIcon} from '../PluginActionIcon';
import type {Plugin,PluginConnection,PluginList} from '../types';

function PluginRecordDrawer({plugin,onClose}:{plugin:Plugin;onClose:()=>void}) {
  const {operation,t}=useConsole();
  const [record,setRecord]=useState<Plugin>(),[loading,setLoading]=useState(true),[error,setError]=useState(''),[version,setVersion]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setRecord(undefined);setError('');
    void operation<Plugin>('plugin_get',{type:plugin.type}).then(value=>{if(active)setRecord(value);}).catch(()=>{if(active)setError('业务插件暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[operation,plugin.type,version]);
  return <AdminDrawer open title={t('插件定义')} subtitle={plugin.name+' · '+plugin.type} onClose={onClose}>
    {loading&&<DataLoading/>}
    {error&&<Alert type="error" showIcon title={t(error)} action={<Button onClick={()=>setVersion(value=>value+1)}>{t('重试')}</Button>}/>}
    {record&&<div id="plugin-detail"><Descriptions column={1} items={[
      {key:'model',label:t('模型'),children:record.execution?.model??t('继承全局设置')},
      {key:'effort',label:t('思考程度'),children:record.execution?.reasoningEffort??t(record.execution&&Object.hasOwn(record.execution,'reasoningEffort')?'模型默认':'继承默认设置')},
    ]}/><JsonView value={record}/></div>}
  </AdminDrawer>;
}

export default function PluginsPage() {
  const {api,operation,t,locale}=useConsole();
  const [selectedType,setSelectedType]=useState<string>();
  const [connectionPlugin,setConnectionPlugin]=useState<Plugin>(),[loadVersion,setLoadVersion]=useState(0);
  const [integrationPlugin,setIntegrationPlugin]=useState<Plugin>();
  const [editor,setEditor]=useState<{plugin?:Plugin}>(),[invalidOpen,setInvalidOpen]=useState(false);
  const {data,setData,loading}=useLoad(()=>api<PluginList>('/plugins'),[api,loadVersion]);
  const updateConnection=(connection:PluginConnection)=>setData(current=>current?{...current,configured:current.configured.map(plugin=>plugin.type===connection.type?{...plugin,enabled:connection.ready?plugin.enabled:false,connection:{ready:connection.ready,entryAddress:connection.entryAddress,entryPath:connection.entryPath,entryKeyClaimable:connection.entryKeyClaimable,callbackConfigured:!!connection.callbackUrl,missingFields:connection.missingFields}}:plugin)}:current);
  const selected=data?.configured.find(plugin=>plugin.type===selectedType);
  if(loading&&!data)return <DataLoading/>;
  return <>
    <AgentGuidance title={t('业务插件配置')} description={t('可直接新增、编辑 JSON 业务定义，也可通过管理 Agent 操作和试运行。入口凭证与回调请在「配置接入」中设置，勿将凭证发送到聊天。完成必填接入配置后才能单独启用业务。')}/>
    <Panel title={t('已注册业务')} extra={<Button type="primary" onClick={()=>setEditor({})}>{t('新增业务插件')}</Button>}>
      <Table<Plugin> className="responsive-table expanded-table" rowKey="type" dataSource={data?.configured??[]} loading={loading} pagination={false} tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('业务名称'),key:'business',width:'14%',className:'table-name-cell',render:(_,plugin)=><TableField label={t('业务名称')}><div className="table-summary" title={plugin.name}>{plugin.name}</div></TableField>},
        {title:t('业务标识'),key:'type',width:'18%',className:'table-identifier-cell',render:(_,plugin)=><TableField label={t('业务标识')}><TableIdentifier value={plugin.type}/></TableField>},
        {title:t('启用状态'),key:'status',width:100,className:'table-status-cell',render:(_,plugin)=><TableField label={t('启用状态')}>{!plugin.connection?.ready&&plugin.enabled!==true?<div className="enable-toggle"><Switch checked={false} disabled aria-label={t('启停业务插件：{name}',{name:plugin.name})} aria-describedby={'plugin-connection-status-'+plugin.type}/></div>:<EnableToggle enabled={plugin.enabled??false} label={t('启停业务插件：{name}',{name:plugin.name})} onChange={async enabled=>{
          const updated=await operation<Plugin>('plugin_enable',{type:plugin.type,enabled});
          setData(current=>current?{...current,configured:current.configured.map(item=>item.type===updated.type?updated:item)}:current);
        }}/>}</TableField>},
        {title:t('接入状态'),key:'connection',width:150,className:'table-connection-cell',render:(_,plugin)=><TableField label={t('接入状态')}><Status id={'plugin-connection-status-'+plugin.type} value={plugin.connection?.ready?'接入已就绪':plugin.connection?.entryKeyClaimable?'待领取入口密钥':'待配置接入'}/></TableField>},
        {title:t('说明'),dataIndex:'description',className:'table-text-cell',render:value=><TableField label={t('说明')}><div className="table-summary" title={value}>{value||'—'}</div></TableField>},
        {title:t('操作'),key:'actions',width:220,className:'table-actions-cell',render:(_,plugin)=><div className="plugin-row-actions plugin-icon-actions"><Tooltip title={t('配置接入')} trigger={['hover','focus']}><Button type="text" icon={<PluginActionIcon name="settings"/>} aria-label={t('配置接入')} onClick={()=>setConnectionPlugin(plugin)}/></Tooltip><Tooltip title={t('编辑业务插件')} trigger={['hover','focus']}><Button type="text" icon={<Icon name="edit"/>} aria-label={t('编辑业务插件')} onClick={()=>setEditor({plugin})}/></Tooltip><Tooltip title={t('对接文档')} trigger={['hover','focus']}><Button type="text" icon={<PluginActionIcon name="document"/>} aria-label={t('对接文档')} onClick={()=>setIntegrationPlugin(plugin)}/></Tooltip><Tooltip title={t('查看详情')} trigger={['hover','focus']}><Button type="text" icon={<PluginActionIcon name="eye"/>} aria-label={t('查看详情')} onClick={()=>setSelectedType(plugin.type)}/></Tooltip><DeleteAction label={t('删除业务插件：{name}',{name:plugin.name})} name={plugin.name} description={t('删除后从列表隐藏、停止接收新任务，并停用关联的定时计划。已接单任务继续执行，历史任务和结果保留。')} onDelete={async()=>{
          await operation('plugin_delete',{type:plugin.type});
          setData(current=>current?{...current,configured:current.configured.filter(item=>item.type!==plugin.type)}:current);
          if(connectionPlugin?.type===plugin.type)setConnectionPlugin(undefined);
          if(integrationPlugin?.type===plugin.type)setIntegrationPlugin(undefined);
          if(selectedType===plugin.type)setSelectedType(undefined);
        }}/></div>},
      ]}/>
    </Panel>
    {integrationPlugin&&<PluginIntegrationDrawer key={integrationPlugin.type+':'+locale} plugin={integrationPlugin} onClose={()=>setIntegrationPlugin(undefined)} onConfigure={()=>{setConnectionPlugin(integrationPlugin);setIntegrationPlugin(undefined);}}/>}
    {connectionPlugin&&<PluginConnectionModal key={connectionPlugin.type} plugin={connectionPlugin} onModelSaved={updated=>setData(current=>current?{...current,configured:current.configured.map(plugin=>plugin.type===updated.type?updated:plugin)}:current)} onClose={()=>{setConnectionPlugin(undefined);setLoadVersion(value=>value+1);}} onClaimed={updateConnection} onSaved={connection=>{
      updateConnection(connection);
      setConnectionPlugin(undefined);setLoadVersion(value=>value+1);
    }}/>}
    {editor&&<PluginDefinitionEditor key={editor.plugin?.type??'new'} plugin={editor.plugin} onClose={()=>setEditor(undefined)} onSaved={saved=>{
      setData(current=>current?{...current,configured:current.configured.some(item=>item.type===saved.type)?current.configured.map(item=>item.type===saved.type?saved:item):[...current.configured,saved]}:current);
      setEditor(undefined);setLoadVersion(value=>value+1);
    }}/>}
    {selected&&<PluginRecordDrawer key={selected.type} plugin={selected} onClose={()=>setSelectedType(undefined)}/>}
    {!!data?.builtin?.length&&<Typography.Paragraph type="secondary">{t('兼容模块：')+data.builtin.map(item=>item.type).join('、')}</Typography.Paragraph>}
    {!!data?.invalid?.length&&<Panel title={t('无效插件')}><Button onClick={()=>setInvalidOpen(true)}>{t('查看无效插件记录')}</Button></Panel>}
    {invalidOpen&&<AdminDrawer open title={t('无效插件')} onClose={()=>setInvalidOpen(false)}><JsonView value={data?.invalid??[]}/></AdminDrawer>}
  </>;
}
