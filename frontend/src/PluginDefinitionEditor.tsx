import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Form,Input,Select,Tabs,Typography} from 'antd';
import {AdminModal} from './AdminOverlays';
import {ApiError} from './api';
import {LoadingState} from './components';
import {useConsole} from './context';
import type {Json,Plugin} from './types';

type Definition=Plugin&{routes?:string[]};
type Capabilities={tools?:string[];image_generation?:boolean;web_search?:boolean};
type CapabilityCatalog={tools:{name:string;description?:string}[];resources:{id:string}[];compatibility_profiles?:{type:string;tools:string[]}[]};
const emptySchema={type:'object',properties:{},additionalProperties:false};
const initial:Definition={type:'',name:'',description:'',instructions:'',enabled:false,input_schema:emptySchema,result_schema:emptySchema,capabilities:{tools:[],image_generation:false,web_search:false},delivery:{mode:'none'},resources:[]};
const serialize=(value:Json)=>JSON.stringify(value,null,2);

// Keep the saved business fields explicit: operation metadata and human-owned
// connection credentials never belong in a JSON plugin definition.
function businessDefinition(plugin:Definition):Definition {
  const {type,name,description,instructions,enabled,input_schema,result_schema,capabilities,delivery,resources,routes,execution}=plugin;
  return {type,name,...(description!==undefined?{description}:{}),instructions,enabled,input_schema,result_schema,capabilities,delivery,
    ...(resources!==undefined?{resources}:{}),...(routes!==undefined?{routes}:{}),...(execution!==undefined?{execution}:{})};
}

export default function PluginDefinitionEditor({plugin,onClose,onSaved}:{plugin?:Plugin;onClose:()=>void;onSaved:(plugin:Plugin)=>void}) {
  const {operation,t}=useConsole();
  const [original,setOriginal]=useState<Definition>(),[draft,setDraft]=useState<Definition>(initial);
  const [input,setInput]=useState(serialize(initial.input_schema)),[result,setResult]=useState(serialize(initial.result_schema));
  const [catalog,setCatalog]=useState<CapabilityCatalog>(),[tab,setTab]=useState('basic');
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[loadVersion,setLoadVersion]=useState(0);
  const alive=useRef(true),saveLock=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setCatalog(undefined);setError('');setConflict(false);
    void Promise.all([operation<CapabilityCatalog>('capabilities'),plugin?operation<Definition>('plugin_get',{type:plugin.type}):Promise.resolve(initial)]).then(([capabilities,current])=>{
      if(!active)return;
      setCatalog(capabilities);setOriginal(plugin?current:undefined);setDraft(businessDefinition(current));setInput(serialize(current.input_schema));setResult(serialize(current.result_schema));
    }).catch(()=>{if(active)setError('业务插件暂时无法读取，请重试。');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[operation,plugin?.type,loadVersion]);
  const update=(patch:Partial<Definition>)=>setDraft(current=>({...current,...patch}));
  const capability=draft.capabilities as Capabilities;
  const updateCapabilities=(patch:Partial<Capabilities>)=>update({capabilities:{...capability,...patch}});
  const locked=loading||saving;
  const save=async()=>{
    if(saveLock.current||loading||conflict||!catalog)return;
    setError('');
    if(!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(draft.type.trim())||!draft.name.trim()) {setTab('basic');setError('请填写业务名称及有效的点分业务标识。');return;}
    if(!draft.instructions.trim()){setTab('instructions');setError('请填写业务指令。');return;}
    let inputSchema:Json,resultSchema:Json;
    try{inputSchema=JSON.parse(input);if(!inputSchema||typeof inputSchema!=='object'||Array.isArray(inputSchema))throw new Error();}
    catch{setTab('input');setError('输入结构须为 JSON 对象。');return;}
    try{resultSchema=JSON.parse(result);if(!resultSchema||typeof resultSchema!=='object'||Array.isArray(resultSchema))throw new Error();}
    catch{setTab('result');setError('结果结构须为 JSON 对象。');return;}
    saveLock.current=true;setSaving(true);
    try{
      // A fresh read gives a clear conflict before validation; plugin_save also
      // receives the revision so a concurrent write cannot slip through.
      if(original){
        const latest=await operation<Definition>('plugin_get',{type:original.type});
        if(latest.revision!==original.revision){if(alive.current){setConflict(true);setError('业务插件已被修改，请重新读取后再保存。');}return;}
      }
      const definition=businessDefinition({...draft,type:draft.type.trim(),name:draft.name.trim(),input_schema:inputSchema,result_schema:resultSchema,...(!original?{enabled:false}:{})});
      await operation('plugin_validate',{definition});
      const saved=await operation<Plugin>('plugin_save',{definition,...(original?{revision:original.revision}:{revision:0})});
      if(alive.current)onSaved(saved);
    }catch(caught){
      if(!alive.current)return;
      const changed=caught instanceof ApiError&&caught.status===409;
      if(caught instanceof ApiError){if(caught.message.includes('input_schema'))setTab('input');else if(caught.message.includes('result_schema'))setTab('result');else if(/CAPABILITY_|RESOURCE_|capabilities/.test(caught.message))setTab('capabilities');}
      setConflict(changed);setError(changed?'业务插件已被修改，请重新读取后再保存。':'业务插件保存失败，请检查字段和能力配置后重试。');
    }finally{if(alive.current){saveLock.current=false;setSaving(false);}}
  };
  const toolNames=[...new Set([...(catalog?.tools??[]).map(tool=>tool.name),...(catalog?.compatibility_profiles?.find(profile=>profile.type===draft.type)?.tools??[]),...(capability.tools??[])])];
  const options=toolNames.map(name=>({value:name,label:name}));
  return <AdminModal open title={t(plugin?'编辑业务插件':'新增业务插件')} subtitle={plugin?.type} onCancel={onClose} busy={saving} footer={<><Button disabled={saving} onClick={onClose}>{t('取消')}</Button><Button type="primary" aria-label={t('保存业务插件')} aria-busy={saving} loading={saving} disabled={locked||conflict||!catalog} onClick={()=>void save()}>{t('保存业务插件')}</Button></>}>
    {loading&&<LoadingState label="正在读取…"/>}
    {error&&<Alert showIcon type="error" title={t(error)} action={conflict||!catalog?<Button disabled={saving} onClick={()=>setLoadVersion(value=>value+1)}>{t('重新读取')}</Button>:undefined}/>}
    <Form id="plugin-definition-form" className="admin-editor-form" layout="horizontal" colon={false} onFinish={()=>void save()}>
      <Tabs activeKey={tab} onChange={setTab} items={[
        {key:'basic',label:t('基本信息'),forceRender:true,disabled:saving,children:<div className="admin-form-grid">
          <Form.Item label={t('业务标识')} htmlFor="plugin-definition-type" required><Input id="plugin-definition-type" value={draft.type} disabled={locked||!!plugin} placeholder="text.summarize" onChange={event=>update({type:event.target.value})}/></Form.Item>
          <Form.Item label={t('业务名称')} htmlFor="plugin-definition-name" required><Input id="plugin-definition-name" value={draft.name} disabled={locked} onChange={event=>update({name:event.target.value})}/></Form.Item>
          <Form.Item label={t('说明')} htmlFor="plugin-definition-description" className="admin-form-wide"><Input.TextArea id="plugin-definition-description" value={draft.description??''} disabled={locked} autoSize={{minRows:2,maxRows:4}} onChange={event=>update({description:event.target.value})}/></Form.Item>
          <Typography.Paragraph className="admin-form-wide" type="secondary">{t('新增插件默认停用。保存业务定义后，请配置接入并单独启用。')}</Typography.Paragraph>
        </div>},
        {key:'instructions',label:t('业务指令'),forceRender:true,disabled:saving,children:<Form.Item label={t('业务指令')} htmlFor="plugin-definition-instructions" required><Input.TextArea id="plugin-definition-instructions" value={draft.instructions} disabled={locked} autoSize={{minRows:9,maxRows:16}} onChange={event=>update({instructions:event.target.value})}/></Form.Item>},
        {key:'input',label:t('输入结构'),forceRender:true,disabled:saving,children:<Form.Item label={t('输入结构')} htmlFor="plugin-definition-input" required><Input.TextArea id="plugin-definition-input" value={input} disabled={locked} autoSize={{minRows:10,maxRows:18}} spellCheck={false} onChange={event=>setInput(event.target.value)}/></Form.Item>},
        {key:'result',label:t('结果结构'),forceRender:true,disabled:saving,children:<Form.Item label={t('结果结构')} htmlFor="plugin-definition-result" required><Input.TextArea id="plugin-definition-result" value={result} disabled={locked} autoSize={{minRows:10,maxRows:18}} spellCheck={false} onChange={event=>setResult(event.target.value)}/></Form.Item>},
        {key:'capabilities',label:t('能力配置'),forceRender:true,disabled:saving,children:<>
          <Typography.Paragraph type="secondary">{t('仅可选择平台已提供的能力。插件是 JSON 业务定义，不支持代码、脚本或可执行钩子。')}</Typography.Paragraph>
          <Form.Item label={t('可用工具')} htmlFor="plugin-definition-tools"><Select id="plugin-definition-tools" mode="multiple" value={capability.tools??[]} options={options} disabled={locked} onChange={tools=>updateCapabilities({tools})}/></Form.Item>
          <div className="admin-form-grid"><Form.Item label={t('图片生成')}><Checkbox checked={capability.image_generation??false} disabled={locked} onChange={event=>updateCapabilities({image_generation:event.target.checked})}>{t('图片生成')}</Checkbox></Form.Item><Form.Item label={t('网页搜索')}><Checkbox checked={capability.web_search??false} disabled={locked} onChange={event=>updateCapabilities({web_search:event.target.checked})}>{t('网页搜索')}</Checkbox></Form.Item></div>
          <Form.Item label={t('参考资源')} htmlFor="plugin-definition-resources"><Select id="plugin-definition-resources" mode="multiple" value={draft.resources??[]} options={[...new Set([...(catalog?.resources??[]).map(resource=>resource.id),...(draft.resources??[])])].map(id=>({value:id,label:id}))} disabled={locked} onChange={resources=>update({resources})}/></Form.Item>
        </>},
      ]}/>
    </Form>
  </AdminModal>;
}
