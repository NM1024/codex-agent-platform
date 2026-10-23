import {Component,lazy,Suspense,useState,type ReactNode} from 'react';
import {Alert,Button,Card,ConfigProvider,Form,Grid,Input,Layout,Select,Space,Spin,Typography} from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import {useConsole} from './context';
import type {View} from './types';
const titles:Record<View,string>={overview:'运行概览',chat:'管理对话',tasks:'任务记录',plugins:'业务插件',schedules:'定时计划',settings:'系统配置'};
const pages={
  overview:lazy(()=>import('./pages/OverviewPage')),
  chat:lazy(()=>import('./pages/ChatPage')),
  tasks:lazy(()=>import('./pages/TasksPage')),
  plugins:lazy(()=>import('./pages/PluginsPage')),
  schedules:lazy(()=>import('./pages/SchedulesPage')),
  settings:lazy(()=>import('./pages/SettingsPage')),
};
class PageBoundary extends Component<{children:ReactNode;message:string;reload:string},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<Alert type="error" showIcon title={this.props.message} action={<Button onClick={()=>window.location.reload()}>{this.props.reload}</Button>}/>:this.props.children;}
}
function Language({id}:{id:string}){const {locale,changeLocale,t,pending}=useConsole();return <Select id={id} aria-label={t('界面语言')} data-language-switch value={locale} disabled={pending>0} onChange={changeLocale} options={[{value:'zh-CN',label:'简体中文'},{value:'en',label:'English'}]}/>;}
function Console(){
  const screens=Grid.useBreakpoint();
  const {authenticated,setAuthenticated,api,act,t,view,navigate,notice,pending,refreshPage}=useConsole(),[password,setPassword]=useState(''),[loginError,setLoginError]=useState('');
  if(!authenticated)return <main id="login" className="login-shell"><Card className="login-card"><Space className="brand-row"><Typography.Text strong>A / AGENT</Typography.Text><Language id="login-language"/></Space><Typography.Title level={1}>{t('从这里，了解并管理运行。')}</Typography.Title><Typography.Paragraph type="secondary">{t('使用独立 Admin 密码登录，初始密码由部署时生成。')}</Typography.Paragraph><Form layout="vertical" onFinish={()=>void act(async()=>{setLoginError('');try{await api('/login',{password});setPassword('');setAuthenticated(true);}catch(error){setLoginError(t(error instanceof Error?error.message:String(error)));}})}><Form.Item label={t('Admin 密码')} htmlFor="password"><Input.Password id="password" autoComplete="current-password" required placeholder={t('输入 Admin 密码')} value={password} onChange={event=>setPassword(event.target.value)}/></Form.Item><Button htmlType="submit" type="primary" loading={pending>0} block>{t('登录工作台')}</Button></Form>{(loginError||notice)&&<Alert type="error" title={loginError||notice} showIcon role="alert"/>}</Card></main>;
  const Page=pages[view];
  return <Layout id="workspace" className="console-layout"><Layout.Sider width={220} breakpoint="lg" collapsedWidth={0} trigger={null} className="console-sidebar"><Typography.Title level={3}>A / AGENT</Typography.Title><Typography.Text type="secondary">{t('运行工作台')}</Typography.Text>{screens.lg && <nav id="navigation">{(Object.keys(titles) as View[]).map(key=><Button key={key} data-view={key} type={view===key?'primary':'text'} onClick={()=>navigate(key)} block>{t(titles[key])}</Button>)}</nav>}</Layout.Sider><Layout><Layout.Header className="console-header"><Typography.Title id="page-title" level={1}>{t(titles[view])}</Typography.Title><Space wrap><Language id="app-language"/><Button id="refresh" onClick={refreshPage}>{t('刷新')}</Button><Button id="logout" onClick={()=>void act(async()=>{try{await api('/logout',{});}finally{setPassword('');setAuthenticated(false);}})}>{t('退出')}</Button></Space></Layout.Header>{!screens.lg && <nav className="mobile-navigation">{(Object.keys(titles) as View[]).map(key=><Button key={key} data-view={key} type={view===key?'primary':'default'} onClick={()=>navigate(key)}>{t(titles[key])}</Button>)}</nav>}<Layout.Content className="console-content">{notice&&<Alert id="notice" role="status" type="info" showIcon title={notice}/>}<main id="view"><PageBoundary key={view} message={t('页面加载失败，请刷新后重试。')} reload={t('刷新')}><Suspense fallback={<div role="status"><Spin/> {t('正在加载页面…')}</div>}><Page/></Suspense></PageBoundary></main></Layout.Content></Layout></Layout>;
}
export default function App(){const {locale}=useConsole(),nonce=document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;return <ConfigProvider button={{autoInsertSpace:false}} locale={locale==='en'?enUS:zhCN} csp={{nonce:nonce??''}} theme={{token:{colorPrimary:'#345e4f',borderRadius:10,fontFamily:'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',controlHeight:40}}}><Console/></ConfigProvider>;}
