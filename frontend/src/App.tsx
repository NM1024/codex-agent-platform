import {cloneElement,Component,lazy,Suspense,useEffect,useRef,useState,type ReactElement,type ReactNode} from 'react';
import {Alert,Button,Card,ConfigProvider,Form,Grid,Input,Layout,Modal,Select,Space,Typography,type ButtonProps,type DropdownProps} from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import {useConsole} from './context';
import type {View} from './types';
import {AsyncButton,LoadingState} from './components';
import {Icon} from './Icon';
import {consoleTheme} from './theme';
import {useVisualViewport} from './useVisualViewport';
const titles:Record<View,string>={overview:'运行概览',chat:'管理对话',tasks:'任务记录',plugins:'业务插件',schedules:'定时计划',settings:'系统配置'};
const icons:Record<View,string>={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',chat:'M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z',tasks:'M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01',plugins:'m8 8-5 4 5 4 M16 8l5 4-5 4 M14 4l-4 16',schedules:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',settings:'M4 6h16 M4 12h16 M4 18h16 M9 3v6 M15 9v6 M9 15v6'};
function NavIcon({view}:{view:View}){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[view]}/></svg>;}
const pages={
  overview:lazy(()=>import('./pages/OverviewPage')),
  chat:lazy(()=>import('./pages/ChatPage')),
  tasks:lazy(()=>import('./pages/TasksPage')),
  plugins:lazy(()=>import('./pages/PluginsPage')),
  schedules:lazy(()=>import('./pages/SchedulesPage')),
  settings:lazy(()=>import('./pages/SettingsPage')),
};
const DeferredDropdown=lazy(()=>import('antd/es/dropdown'));
// Reuse the shell's UI components so this lazy feature does not split AntD's cold-login chunks.
const VersionEntry=lazy(()=>import('./VersionEntry')),versionUi={Alert,Button,Modal,Typography};
class PageBoundary extends Component<{children:ReactNode;message:string;reload:string},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<Alert type="error" showIcon title={this.props.message} action={<Button onClick={()=>window.location.reload()}>{this.props.reload}</Button>}/>:this.props.children;}
}
// Menus are only used after mobile sign-in. Keep their code off the login path.
function MobileDropdown({children,...props}:Omit<DropdownProps,'children'>&{children:ReactElement<ButtonProps>}){
  const {t}=useConsole();
  return <PageBoundary message={t('页面加载失败，请刷新后重试。')} reload={t('刷新')}><Suspense fallback={cloneElement(children,{disabled:true,'aria-busy':true})}><DeferredDropdown {...props}>{children}</DeferredDropdown></Suspense></PageBoundary>;
}
function Language({id,compact=false}:{id:string;compact?:boolean}){
  const {locale,changeLocale,t}=useConsole(),options=[{value:'zh-CN',label:'简体中文'},{value:'en',label:'English'}];
  const [open,setOpen]=useState(false);
  useEffect(()=>{setOpen(false);},[compact]);
  return compact?<MobileDropdown trigger={['click']} placement="bottomRight" open={open} onOpenChange={setOpen} classNames={{root:'language-menu'}} menu={{id:id+'-menu','aria-label':t('界面语言'),selectable:true,selectedKeys:[locale],items:options.map(item=>({key:item.value,label:item.label})),onClick:({key})=>{setOpen(false);changeLocale(key);}}}><Button id={id} type="text" icon={<Icon name="language"/>} aria-label={t('界面语言')} title={t('界面语言')} aria-haspopup="menu" aria-controls={id+'-menu'} aria-expanded={open} data-language-switch/></MobileDropdown>:<Select id={id} aria-label={t('界面语言')} prefix={<Icon name="language"/>} data-language-switch value={locale} onChange={changeLocale} options={options}/>;
}
function Console(){
  useVisualViewport();
  const screens=Grid.useBreakpoint();
  const [menuOpen,setMenuOpen]=useState(false);
  const {authenticated,setAuthenticated,api,act,t,view,navigate,notice,locale}=useConsole(),[password,setPassword]=useState(''),[loginError,setLoginError]=useState(''),[loggingIn,setLoggingIn]=useState(false),loginLock=useRef(false);
  useEffect(()=>{setMenuOpen(false);},[view,authenticated,screens.lg]);
  if(!authenticated)return <main id="login" className="login-shell"><Card className="login-card"><Space className="brand-row"><Typography.Text strong>Codex Agent Platform</Typography.Text><Language id="login-language"/></Space><Typography.Title level={1}>{t('从这里，了解并管理运行。')}</Typography.Title><Typography.Paragraph type="secondary">{t('使用独立 Admin 密码登录，初始密码由部署时生成。')}</Typography.Paragraph><Form layout="vertical" onFinish={()=>{if(loginLock.current)return;loginLock.current=true;setLoggingIn(true);void act(async()=>{setLoginError('');try{await api('/login',{password});setPassword('');setAuthenticated(true);}catch(error){setLoginError(t(error instanceof Error?error.message:String(error)));}}).finally(()=>{loginLock.current=false;setLoggingIn(false);});}}><Form.Item label={t('Admin 密码')} htmlFor="password"><Input.Password id="password" autoComplete="current-password" required placeholder={t('输入 Admin 密码')} value={password} onChange={event=>setPassword(event.target.value)}/></Form.Item><Button htmlType="submit" type="primary" loading={loggingIn} block>{t('登录工作台')}</Button></Form>{(loginError||notice)&&<Alert type="error" title={loginError||notice} showIcon role="alert"/>}</Card></main>;
  const Page=pages[view];
  const navigation=(Object.keys(titles) as View[]).map(key=><Button key={key} data-view={key} aria-current={view===key?'page':undefined} icon={<NavIcon view={key}/>} type={view===key?'primary':'text'} onClick={()=>navigate(key)}>{t(titles[key])}</Button>);
  return <Layout id="workspace" className="console-layout">
    <Layout.Sider width={210} breakpoint="lg" collapsedWidth={0} trigger={null} className="console-sidebar">
      <div className="console-brand"><Typography.Title level={3}>Codex Agent Platform</Typography.Title></div>
      {screens.lg&&<nav id="navigation" aria-label={t('主导航')}>{navigation}</nav>}
    </Layout.Sider>
    <Layout className="console-main">
      <Layout.Header className="console-header">
        <div className="console-title">
          {!screens.lg&&<MobileDropdown trigger={['click']} placement="bottomLeft" open={menuOpen} onOpenChange={setMenuOpen} classNames={{root:'mobile-navigation'}} menu={{id:'mobile-navigation-menu','aria-label':t('主导航'),selectedKeys:[view],selectable:true,items:(Object.keys(titles) as View[]).map(key=>({key,icon:<NavIcon view={key}/>,label:<span data-view={key} aria-current={view===key?'page':undefined}>{t(titles[key])}</span>})),onClick:({key})=>{setMenuOpen(false);navigate(key as View);}}}>
            <Button id="navigation-toggle" type="text" icon={<Icon name="menu"/>} aria-label={t('主导航')} title={t('主导航')} aria-haspopup="menu" aria-controls="mobile-navigation-menu" aria-expanded={menuOpen}/>
          </MobileDropdown>}
          <Typography.Title id="page-title" level={1}>Codex Agent Platform</Typography.Title>
          <Typography.Title id="view-title" level={2}>{t(titles[view])}</Typography.Title>
        </div>
        <ConfigProvider componentSize="small"><Space className="console-header-actions" size={screens.lg?8:2}><Suspense fallback={null}><VersionEntry ui={versionUi} api={api} locale={locale}/></Suspense><Button id="repository-link" type="text" aria-label={t('项目仓库')} title={t('项目仓库')} icon={<Icon name="repository"/>} href="https://github.com/NM1024/codex-agent-platform" target="_blank" rel="noopener noreferrer">{screens.lg?t('项目仓库'):undefined}</Button><Language id="app-language" compact={!screens.lg}/><AsyncButton id="logout" type="text" aria-label={t('退出')} title={t('退出')} icon={<Icon name="logout"/>} onClick={async()=>{try{await api('/logout',{});}finally{setPassword('');setAuthenticated(false);}}}>{screens.lg?t('退出'):undefined}</AsyncButton></Space></ConfigProvider>
      </Layout.Header>
      <Layout.Content className={'console-content view-'+view}>
        {notice&&<Alert id="notice" role="status" type="info" showIcon title={notice}/>}
        <main id="view"><PageBoundary key={view} message={t('页面加载失败，请刷新后重试。')} reload={t('刷新')}><Suspense fallback={<LoadingState className="page-loading" label="正在加载页面…"/>}><Page/></Suspense></PageBoundary></main>
      </Layout.Content>
    </Layout>
  </Layout>;
}
export default function App(){const {locale}=useConsole(),nonce=document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;return <ConfigProvider componentSize="middle" button={{autoInsertSpace:false}} modal={{centered:true,className:'console-modal'}} locale={locale==='en'?enUS:zhCN} csp={{nonce:nonce??''}} theme={consoleTheme}><Console/></ConfigProvider>;}
