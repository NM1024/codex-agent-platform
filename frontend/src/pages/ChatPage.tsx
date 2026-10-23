import {useEffect, useRef, useState} from 'react';
import {Button, Collapse, Drawer, Empty, Input, Typography} from 'antd';
import {AgentPicker, CatalogNote, Status} from '../components';
import {useConsole} from '../context';
import {AgentMessage, MessageTime} from '../ChatMessage';
import type {Action, AgentSettings, ConfigGroup, Conversation} from '../types';

interface ChatAction extends Omit<Action, 'error'> {
  summary?: {task_id?: string};
  error?: {code: string; message?: string};
}
interface ChatConversation extends Omit<Conversation, 'actions'> {actions?: ChatAction[]}
const messageStatuses: Record<string, string> = {queued:'排队中', running:'运行中', interrupted:'等待继续', completed:'执行完成', failed:'执行失败'};

export default function ChatPage() {
  const {api, operation, notify, t, refresh, chatId, setChatId, chatDraft:draft, setChatDraft:setDraft,serializeConversation:serialize} = useConsole();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [defaults, setDefaults] = useState<AgentSettings>({});
  const [selections, setSelections] = useState<Record<string, AgentSettings>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string | undefined>>({});
  const [conversation, setConversation] = useState<ChatConversation>();
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const composing = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const currentId = useRef(chatId);
  const navigation = useRef(0);
  const initialSelectionDone = useRef(Boolean(chatId));
  const selectionVersions = useRef<Record<string, number>>({});
  const reads = useRef<Record<string, number>>({});
  // Track external navigation as well as sidebar clicks before any async response can render.
  if (currentId.current !== chatId) {
    currentId.current = chatId;
    navigation.current += 1;
    nearBottom.current = true;
  }
  const selectedKey = chatId ?? 'new';
  const selected = conversations.find(item => item.id === chatId);
  const selection = selections[selectedKey] ?? selected?.execution ?? {};
  const visibleConversation = conversation?.id === chatId ? conversation : undefined;
  const actions = visibleConversation?.actions?.slice(-8) ?? [];

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([api<Conversation[]>('/conversations'), operation<ConfigGroup>('configuration_get', {scope:'manager'})])
      .then(([items, group]) => {
        if (!active) return;
        setConversations(current => [...items, ...current.filter(row => !items.some(item => item.id === row.id))]);
        setDefaults({...(typeof group.values.model === 'string' ? {model:group.values.model} : {}),
          ...(typeof group.values.reasoningEffort === 'string' || group.values.reasoningEffort === null ? {reasoningEffort:group.values.reasoningEffort} : {})});
        if (!initialSelectionDone.current) {
          initialSelectionDone.current = true;
          if (!currentId.current && items.length) setChatId(items[0].id);
        }
      }).catch(error => {if (active) notify(t(error instanceof Error ? error.message : String(error)));});
    return () => {active = false;};
  }, [api, operation, refresh]);

  useEffect(() => {
    if (!chatId) {setConversation(undefined); return;}
    let active = true, fetching = false;
    const generation = navigation.current;
    setConversation(undefined);
    const load = async () => {
      if (fetching) return;
      fetching = true;
      const read = (reads.current[chatId] ?? 0) + 1;
      reads.current[chatId] = read;
      try {
        const item = await api<ChatConversation>('/conversations/' + chatId);
        if (!active || currentId.current !== chatId || navigation.current !== generation || reads.current[chatId] !== read) return;
        setConversation(item);
        setConversations(current => current.map(row => row.id === item.id ? {...row, title:item.title} : row));
        setSelections(current => Object.hasOwn(current, chatId) ? current : {...current, [chatId]:item.execution ?? {}});
      } catch (error) {
        if (active && currentId.current === chatId && navigation.current === generation && reads.current[chatId] === read) notify(t(error instanceof Error ? error.message : String(error)));
      } finally {fetching = false;}
    };
    void load();
    const timer = setInterval(() => {void load();}, 2000);
    return () => {active = false; clearInterval(timer);};
  }, [api, chatId, refresh]);

  useEffect(() => {
    if (nearBottom.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [visibleConversation]);

  const selectConversation = (id: string | null) => {
    initialSelectionDone.current = true;
    setDrawerOpen(false);
    if (id !== null && currentId.current === id) return;
    currentId.current = id;
    navigation.current += 1;
    nearBottom.current = true;
    setConversation(undefined);
    setChatId(id);
  };

  // A send's configuration write and enqueue share the same queue as automatic saves.
  // A later selection cannot slip between those two requests.
  const persistSelection = (id: string, value: AgentSettings) => {
    const version = (selectionVersions.current[id] ?? 0) + 1;
    selectionVersions.current[id] = version;
    setSaveErrors(current => ({...current, [id]:undefined}));
    void serialize(id, () => api('/conversations/' + id, {execution:value})).then(() => {
      if (!mounted.current || selectionVersions.current[id] !== version) return;
      setConversations(current => current.map(item => item.id === id ? {...item, execution:value} : item));
      setSaveErrors(current => ({...current, [id]:undefined}));
    }).catch(error => {
      if (mounted.current && selectionVersions.current[id] === version) setSaveErrors(current => ({...current, [id]:error instanceof Error ? error.message : String(error)}));
    });
  };
  const changeSelection = (value: AgentSettings) => {
    initialSelectionDone.current = true;
    setSelections(current => ({...current, [selectedKey]:value}));
    if (chatId) persistSelection(chatId, value);
  };

  const send = async () => {
    if (submitting.current || composing.current || !draft.trim()) return;
    initialSelectionDone.current = true;
    submitting.current = true;
    setBusy(true);
    const text = draft, execution = {...selection}, generation = navigation.current;
    let id = chatId;
    const stillSelected = () => mounted.current && navigation.current === generation;
    try {
      if (!id) {
        const created = await api<ChatConversation>('/conversations', {title:text.slice(0, 30), execution});
        id = created.id;
        if (mounted.current) {
          setConversations(current => [created, ...current.filter(row => row.id !== created.id)]);
          setSelections(current => ({...current, [created.id]:execution}));
        }
        if (stillSelected()) {
          // Creating the conversation is part of this send, not a new navigation.
          currentId.current = id;
          initialSelectionDone.current = true;
          setChatId(id);
        }
      }
      const sentId = id;
      await serialize(sentId, async () => {
        await api('/conversations/' + sentId, {execution});
        await api('/conversations/' + sentId + '/messages', {text});
      });
      if (stillSelected()) {
        setDraft(current => current === text ? '' : current);
        setSaveErrors(current => ({...current, [sentId]:undefined}));
      }
      const read = (reads.current[sentId] ?? 0) + 1;
      reads.current[sentId] = read;
      const updated = await api<ChatConversation>('/conversations/' + sentId);
      if (!mounted.current || reads.current[sentId] !== read) return;
      setConversations(current => current.map(row => row.id === sentId ? {...row, title:updated.title, execution} : row));
      if (stillSelected() && currentId.current === sentId && reads.current[sentId] === read) setConversation(updated);
    } catch (error) {
      if (stillSelected()) notify(t(error instanceof Error ? error.message : String(error)));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const conversationNavigation = <>
    <div className="conversation-heading"><Typography.Title level={2}>{t('最近对话')}</Typography.Title>
      <Button onClick={() => selectConversation(null)}>{t('＋ 新对话')}</Button>
    </div>
    <nav className="conversation-list" aria-label={t('会话列表')}>
      {conversations.map(item => <button key={item.id} type="button" className={'conversation-item' + (item.id === chatId ? ' active' : '')}
        aria-current={item.id === chatId ? 'true' : undefined} title={item.title} onClick={() => selectConversation(item.id)}><span>{item.title}</span></button>)}
    </nav>
  </>;

  return <div className="chat-layout">
    <aside className="conversation-sidebar">{conversationNavigation}</aside>
    <Drawer title={t('会话列表')} open={drawerOpen} onClose={() => setDrawerOpen(false)} placement="left" size={300} className="conversation-drawer">{conversationNavigation}</Drawer>
    <section className="chat-main" aria-label={t('管理对话')}>
      <header className="chat-header">
        <Button className="conversation-toggle" onClick={() => setDrawerOpen(true)} aria-label={t('会话列表')}>{t('会话列表')}</Button>
        <div><Typography.Title level={2}>{visibleConversation?.title ?? selected?.title ?? t('新对话')}</Typography.Title>
          <Typography.Text type="secondary" className="chat-time-note">{t('消息时间按此浏览器的本地时区显示。')}</Typography.Text></div>
      </header>
      <div id="messages" className="messages" ref={messagesRef} role="log" aria-label={t('管理对话')}
        onScroll={event => {const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;}}>
        {(visibleConversation?.messages ?? []).map(message => <article key={message.id} className={'message ' + message.role}>
          <div className="message-avatar" aria-hidden="true">{message.role === 'user' ? 'U' : 'A'}</div>
          <div className="message-content">
            <div className="message-label"><span>{message.role === 'user' ? t('你 · ') + t(messageStatuses[message.status] ?? message.status) : t('管理 AGENT')}</span><MessageTime value={message.created_at}/></div>
            <div className="message-bubble">{message.role === 'assistant' ? <AgentMessage text={message.text}/> : <div className="message-text">{message.text}</div>}
              {message.error && <div className="danger-text">{message.error.code}</div>}</div>
          </div>
        </article>)}
        {!visibleConversation?.messages?.length && <div className="chat-empty"><Empty description={t('从一个问题开始。状态、异常和业务插件，都可以在这里管理。')}/></div>}
      </div>
      <div className="chat-compose">
        {actions.length > 0 && <div id="actions" className="actions"><Collapse size="small" aria-label={t('执行记录')} items={[{key:'actions', label:`${t('执行记录')} (${actions.length})`, children:actions.map(action => <div key={action.id} className="chat-action">
          <Status value={action.status}/> {action.name}{action.target ? ' · ' + action.target : ''}{action.summary?.task_id ? ' → ' + action.summary.task_id : ''}{action.error ? ' · ' + t(action.error.message ?? action.error.code) : ''}
        </div>)}]}/></div>}
        <CatalogNote/>
        <Input.TextArea id="message-input" aria-label={t('消息')} autoSize={{minRows:2, maxRows:6}} value={draft}
          placeholder={t('告诉我你想了解或处理什么，例如：查询失败任务并说明原因。')} onChange={event => setDraft(event.target.value)}
          onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            if (!event.shiftKey || event.ctrlKey || event.metaKey) {event.preventDefault(); void send();}
          }}/>
        <div className="composer-toolbar">
          <AgentPicker id="chat" value={selection} defaults={defaults} inherit compact disabled={busy} onChange={changeSelection}/>
          <Button type="primary" className="composer-send" loading={busy} disabled={!draft.trim()} onClick={() => {void send();}}>{t('发送')}</Button>
        </div>
        <div className="composer-footer"><Typography.Text type="secondary" className="composer-hint">{t('Enter 发送，Shift + Enter 换行')}</Typography.Text>
          {chatId && saveErrors[chatId] && <Button type="link" size="small" danger title={saveErrors[chatId]} disabled={busy} onClick={() => persistSelection(chatId, {...selection})}>{t('保存失败，重试')}</Button>}</div>
      </div>
    </section>
  </div>;
}
