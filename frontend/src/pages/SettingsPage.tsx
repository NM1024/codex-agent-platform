import {useCallback, useRef, useState} from 'react';
import {Alert, Button, Checkbox, Collapse, Form, Input, InputNumber, Spin, Tabs, Typography} from 'antd';
import {AgentPicker, CatalogNote, JsonView, Panel,useLoad} from '../components';
import {useConsole} from '../context';
import type {AgentSettings, ConfigGroup, Json, Schema, Values} from '../types';
import HttpTargetsPanel from '../HttpTargetsPanel';

interface ConfigurationList {
  groups: ConfigGroup[];
  gateway_unavailable?: boolean;
  bootstrap?: {names:string[]; description:string}[];
}
type FieldDraft = string | boolean | number | null;
const structured = (schema: Schema) => schema.type === 'object' || schema.type === 'array';
const complex = (key:string,schema:Schema) => structured(schema) || key === 'instructions';
const fieldValue = (schema: Schema, value: Json | undefined): FieldDraft => {
  if (schema.writeOnly) return '';
  if (schema.type === 'boolean') return value === true;
  if (schema.type === 'integer') return typeof value === 'number' ? value : null;
  return typeof value === 'string' ? value : '';
};

function ConfigurationForm({group, reload}:{group:ConfigGroup; reload:()=>Promise<void>}) {
  const {operation, act, notify, t, navigate} = useConsole();
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [clears, setClears] = useState<Record<string, boolean>>({});
  const [agent, setAgent] = useState<AgentSettings>();
  const [saving, setSaving] = useState(false),saveLock=useRef(false);
  const properties = group.schema.properties ?? {};
  const simpleFields=Object.entries(properties).filter(([key,schema])=>!complex(key,schema));
  const complexFields=Object.entries(properties).filter(([key,schema])=>complex(key,schema));
  const savedAgent: AgentSettings = {
    ...(typeof group.values.model === 'string' ? {model:group.values.model} : {}),
    ...(typeof group.values.reasoningEffort === 'string' || group.values.reasoningEffort === null ? {reasoningEffort:group.values.reasoningEffort} : {}),
  };
  const update = (key:string, value:FieldDraft) => setDrafts(current => ({...current, [key]:value}));
  const save = async () => {
    if(saveLock.current)return;
    saveLock.current=true;setSaving(true);
    await act(async () => {
      const patch: Values = {};
      if (agent) {
        if (agent.model !== savedAgent.model) patch.model = agent.model;
        if (agent.reasoningEffort !== savedAgent.reasoningEffort) patch.reasoningEffort = agent.reasoningEffort ?? null;
      }
      for (const [key, schema] of Object.entries(properties)) {
        if (complex(key,schema)) continue;
        if (properties.model && (key === 'model' || key === 'reasoningEffort')) continue;
        if (schema.writeOnly) {
          if (clears[key]) patch[key] = '';
          else if (typeof drafts[key] === 'string' && drafts[key]) patch[key] = drafts[key];
          continue;
        }
        if (!Object.hasOwn(drafts, key)) continue;
        const raw = drafts[key];
        const value: Json = schema.type === 'integer' ? Number(raw) : raw;
        if (JSON.stringify(value) !== JSON.stringify(group.values[key])) patch[key] = value;
      }
      if (!Object.keys(patch).length) {notify(t('没有需要保存的修改。')); return;}
      const result = await operation<{synchronization?:{runner?:string}}>('configuration_update', {scope:group.scope, patch});
      await reload();
      setDrafts({}); setClears({}); setAgent(undefined);
      notify(t(result.synchronization?.runner === 'pending' ? '已保存，Runner 暂时不可用，恢复后自动同步。' : '已保存，配置按本组说明生效。'));
    });
    setSaving(false);saveLock.current=false;
  };

  return <Panel title={t(group.title)}>
    <Form id={'configuration-' + group.scope} className="settings-form" layout="horizontal" colon={false} onFinish={() => {void save();}}>
      <Typography.Paragraph>{t(group.description)}</Typography.Paragraph>
      {group.error && <Alert type="error" showIcon title={t(group.error.message)}/>}
      {properties.model && <><CatalogNote/><AgentPicker id={'setting-' + group.scope} value={agent ?? savedAgent} onChange={value => {if (!saving) setAgent(value);}}/></>}
      <div className="form-grid">
        {simpleFields.filter(([key]) => !properties.model || (key !== 'model' && key !== 'reasoningEffort')).map(([key, schema]) => {
          const id = 'setting-' + group.scope + '-' + key;
          const value = Object.hasOwn(drafts, key) ? drafts[key] : fieldValue(schema, group.values[key]);
          const label = t(schema.title ?? key);
          return <Form.Item key={key} label={label} htmlFor={id}>
            {schema.type === 'boolean'
              ? <Checkbox id={id} checked={value === true} disabled={saving} onChange={event => update(key, event.target.checked)}/>
              : schema.type === 'integer'
                  ? <InputNumber id={id} value={typeof value === 'number' ? value : null} min={schema.minimum} max={schema.maximum} precision={0} disabled={saving} onChange={number => update(key, number)}/>
                  : schema.writeOnly
                    ? <Input.Password id={id} autoComplete="new-password" value={String(value ?? '')} disabled={saving || clears[key]} placeholder={t(group.configured_secrets.includes('/' + key) ? '已配置，留空保持原值' : '尚未配置')} onChange={event => update(key, event.target.value)}/>
                    : <Input id={id} value={String(value ?? '')} disabled={saving} onChange={event => update(key, event.target.value)}/>}
            {schema.writeOnly && !schema.minLength && <Checkbox id={id + '-clear'} aria-label={t('清除 ') + label} checked={clears[key] ?? false} disabled={saving} onChange={event => setClears(current => ({...current, [key]:event.target.checked}))}>{t(' 清除已保存凭证')}</Checkbox>}
          </Form.Item>;
        })}
      </div>
      {!!complexFields.length&&<div className="complex-settings">
        <Typography.Paragraph type="secondary">{t('请通过管理 Agent 修改复杂配置。')}</Typography.Paragraph>
        <Collapse items={complexFields.map(([key,schema])=>({key,label:t(schema.title??key),children:typeof group.values[key]==='string'?<Typography.Paragraph className="literal-text">{String(group.values[key])}</Typography.Paragraph>:<JsonView value={group.values[key]??{}}/>}))}/>
        <Button onClick={()=>navigate('chat')}>{t('前往管理对话')}</Button>
      </div>}
      {!!group.configured_secrets.length && <Typography.Paragraph type="secondary">{t('已配置凭证：') + group.configured_secrets.join('、') + t('。省略字段保留原值，显式空值表示清除。')}</Typography.Paragraph>}
      {!!simpleFields.length&&<Button type="primary" htmlType="submit" loading={saving}>{t('保存配置')}</Button>}
    </Form>
  </Panel>;
}

export default function SettingsPage() {
  const {api, operation, act, notify, t,  setAuthenticated, setChatId} = useConsole();
  const {data,setData,loading}=useLoad(()=>operation<ConfigurationList>('configuration_list'),[operation]);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''),[currentPassword,setCurrentPassword]=useState('');
  const [tab,setTab]=useState('manager');
  const [savingPassword, setSavingPassword] = useState(false);
  const passwordLock=useRef(false);
  const reload = useCallback(async () => {setData(await operation<ConfigurationList>('configuration_list'));}, [operation]);

  const changePassword = async () => {
    if(passwordLock.current)return;
    passwordLock.current=true;
    setSavingPassword(true);
    await act(async () => {
      if(!currentPassword)throw new Error(t('请输入当前密码。'));
      if (password !== confirmation) throw new Error(t('两次密码不一致。'));
      if (password.length < 12 || password.length > 1024) throw new Error(t('密码须为12至1024个字符。'));
      await api('/password', {currentPassword,password});
      setCurrentPassword('');setPassword(''); setConfirmation(''); setChatId(null); setAuthenticated(false);
      notify(t('密码已修改，请重新登录。'));
    });
    setSavingPassword(false);passwordLock.current=false;
  };
  const passwordPanel=<Panel title={t('Admin 密码')}>
      <Form className="settings-form" layout="horizontal" colon={false} onFinish={() => {void changePassword();}}>
        <Typography.Paragraph>{t('修改后所有网页会话退出，请使用新密码重新登录。业务入口密钥保持独立。')}</Typography.Paragraph>
        <Form.Item label={t('当前密码')} htmlFor="current-admin-password"><Input.Password id="current-admin-password" autoComplete="current-password" maxLength={1024} required value={currentPassword} disabled={savingPassword} onChange={event=>setCurrentPassword(event.target.value)}/></Form.Item>
        <Form.Item label={t('新密码（至少12个字符）')} htmlFor="new-admin-password"><Input.Password id="new-admin-password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} disabled={savingPassword} onChange={event => setPassword(event.target.value)}/></Form.Item>
        <Form.Item label={t('再次输入新密码')} htmlFor="confirm-admin-password"><Input.Password id="confirm-admin-password" autoComplete="new-password" required value={confirmation} disabled={savingPassword} onChange={event => setConfirmation(event.target.value)}/></Form.Item>
        <Button type="primary" htmlType="submit" loading={savingPassword}>{t('修改 Admin 密码')}</Button>
      </Form>
    </Panel>;
  const groups=data?.groups??[],admin=groups.find(group=>group.scope==='admin');
  const order=['manager','execution','http_targets','http','access'];
  const items=[...groups.filter(group=>group.scope!=='admin').sort((a,b)=>{
    const rank=(scope:string)=>order.includes(scope)?order.indexOf(scope):order.length;
    return rank(a.scope)-rank(b.scope);
  }).map(group=>({key:group.scope,label:<span data-settings-tab={group.scope}>{t(group.title)}</span>,forceRender:true,children:group.scope==='http_targets'?<HttpTargetsPanel group={group} reload={reload} onSaved={saved=>setData(current=>current?{...current,groups:current.groups.map(item=>item.scope===saved.scope?saved:item)}:current)}/>:<ConfigurationForm group={group} reload={reload}/>})),
    {key:'security',label:<span data-settings-tab="security">{t('安全与登录')}</span>,forceRender:true,children:<div className="settings-stack">{passwordPanel}{admin&&<ConfigurationForm group={admin} reload={reload}/>}</div>},
    {key:'deployment',label:<span data-settings-tab="deployment">{t('部署配置')}</span>,children:<Panel title={t('部署配置')}><Typography.Paragraph type="secondary">{t('这些配置通过服务器环境变量设置，修改后需要重启相应服务。')}</Typography.Paragraph>{data?.bootstrap?.map(item=><div className="deployment-setting" key={item.names.join('/')}><Typography.Text code>{item.names.join(' / ')}</Typography.Text><Typography.Paragraph>{t(item.description)}</Typography.Paragraph></div>)}</Panel>},
  ];
  return <section className="settings-page">
    <Typography.Paragraph type="secondary">{t('按类型管理配置。切换分类保留未保存的修改，每个分类单独保存。')}</Typography.Paragraph>
    {loading&&<div role="status"><Spin/> {t('正在读取…')}</div>}
    {data?.gateway_unavailable&&<Alert type="warning" showIcon title={t('Gateway 暂时不可用，仍可调整管理 Agent 和 Admin 配置。')}/>}
    {data&&<Tabs className="settings-tabs" activeKey={items.some(item=>item.key===tab)?tab:items[0]?.key} onChange={setTab} animated={false} items={items}/>}
  </section>;
}
