import {useState} from 'react';
import {Button,Descriptions,Table,Typography} from 'antd';
import {AgentGuidance,EnableToggle,JsonView,Panel,useLoad} from '../components';
import {useConsole} from '../context';
import type {Plugin,PluginList} from '../types';

export default function PluginsPage() {
  const {api,operation,t,refresh}=useConsole();
  const [selectedType,setSelectedType]=useState<string>();
  const {data,setData,loading}=useLoad(()=>api<PluginList>('/plugins'),[api,refresh]);
  const selected=data?.configured.find(plugin=>plugin.type===selectedType);
  return <>
    <AgentGuidance title={t('业务插件配置')} description={t('可在此启用或停用。新增、编辑和试运行请通过管理 Agent 操作。')}/>
    <Panel title={t('已注册业务')}>
      <Table<Plugin> rowKey="type" dataSource={data?.configured??[]} loading={loading} pagination={false} tableLayout="fixed" locale={{emptyText:t('暂无记录')}} columns={[
        {title:t('业务'),key:'business',render:(_,plugin)=><>{plugin.name}<br/><Typography.Text code ellipsis title={plugin.type}>{plugin.type}</Typography.Text></>},
        {title:t('状态'),key:'status',width:92,render:(_,plugin)=><EnableToggle enabled={plugin.enabled??true} label={t('启停业务插件：{name}',{name:plugin.name})} onChange={async enabled=>{
          const updated=await operation<Plugin>('plugin_enable',{type:plugin.type,enabled});
          setData(current=>current?{...current,configured:current.configured.map(item=>item.type===updated.type?updated:item)}:current);
        }}/>},
        {title:t('说明'),dataIndex:'description',responsive:['md']},
        {title:t('操作'),key:'actions',width:112,render:(_,plugin)=><Button onClick={()=>setSelectedType(plugin.type)}>{t('查看详情')}</Button>},
      ]}/>
    </Panel>
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
