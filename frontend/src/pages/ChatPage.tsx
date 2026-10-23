import {useEffect, useRef, useState} from 'react';
import {Button, Empty, Form, Input, Space, Typography} from 'antd';
import {AgentPicker, CatalogNote, Panel, Status} from '../components';
import {useConsole} from '../context';
import {AgentMessage,MessageTime} from '../ChatMessage';
import type {Action, AgentSettings, ConfigGroup, Conversation} from '../types';

interface ChatAction extends Omit<Action, 'error'> {
  summary?: {task_id?: string};
  error?: {code: string; message?: string};
}
interface ChatConversation extends Omit<Conversation, 'actions'> {actions?: ChatAction[]}
const messageStatuses: Record<string, string> = {queued:'排队中', running:'运行中', interrupted:'等待继续', completed:'执行完成', failed:'执行失败'};

export default function ChatPage() {
  const {api, operation, act, notify, t, refresh, chatId, setChatId,chatDraft:draft,setChatDraft:setDraft} = useConsole();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [defaults, setDefaults] = useState<AgentSettings>({});
  const [selections, setSelections] = useState<Record<string, AgentSettings>>({});
  const [conversation, setConversation] = useState<ChatConversation>();
  const [busy, setBusy] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const selectedKey = chatId ?? 'new';
  const selected = conversations.find(item => item.id === chatId);
  const selection = selections[selectedKey] ?? selected?.execution ?? {};

  useEffect(() => {
    let active = true;
    void Promise.all([api<Conversation[]>('/conversations'), operation<ConfigGroup>('configuration_get', {scope:'manager'})])
      .then(([items, group]) => {
        if (!active) return;
        setConversations(items);
        setDefaults({...(typeof group.values.model === 'string' ? {model:group.values.model} : {}),
          ...(typeof group.values.reasoningEffort === 'string' || group.values.reasoningEffort === null ? {reasoningEffort:group.values.reasoningEffort} : {})});
        if (!chatId && items.length) setChatId(items[0].id);
      }).catch(error => {if (active) notify(t(error instanceof Error ? error.message : String(error)));});
    return () => {active = false;};
  }, [api, operation, refresh]);

  useEffect(() => {
    if (!chatId) {setConversation(undefined); return;}
    let active = true, fetching = false;
    setConversation(undefined);
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const item = await api<ChatConversation>('/conversations/' + chatId);
        if (!active) return;
        const container = messagesRef.current;
        nearBottom.current = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        setConversation(item);
        setConversations(current=>current.map(row=>row.id===item.id?{...row,title:item.title}:row));
        setSelections(current => Object.hasOwn(current, chatId) ? current : {...current, [chatId]:item.execution ?? {}});
      } catch (error) {
        if (active) notify(t(error instanceof Error ? error.message : String(error)));
      } finally {fetching = false;}
    };
    void load();
    const timer = setInterval(() => {void load();}, 2000);
    return () => {active = false; clearInterval(timer);};
  }, [api, chatId, refresh]);

  useEffect(() => {
    if (nearBottom.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [conversation]);

  const remember = (item: Conversation) => {
    setConversations(current => [item, ...current.filter(row => row.id !== item.id)]);
    setSelections(current => ({...current, [item.id]:item.execution ?? {}}));
    setChatId(item.id);
  };
  const saveSelection = async (title: string) => {
    if (chatId) {
      await api('/conversations/' + chatId, {execution:selection});
      setConversations(current => current.map(item => item.id === chatId ? {...item, execution:selection} : item));
      return chatId;
    }
    const created = await api<Conversation>('/conversations', {title, execution:selection});
    remember(created);
    return created.id;
  };
  const send = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    const text = draft;
    await act(async () => {
      const id = await saveSelection(text.slice(0, 30));
      await api('/conversations/' + id + '/messages', {text});
      setDraft(current => current === text ? '' : current);
      const updated = await api<ChatConversation>('/conversations/' + id);
      setConversation(updated);
      setConversations(current=>current.map(row=>row.id===id?{...row,title:updated.title}:row));
    });
    setBusy(false);
  };

  return <>
    <Typography.Paragraph>{t('可以自由提问，也可以让 Agent 创建插件、试运行、管理计划或处理指定任务。Ctrl / ⌘ + Enter 发送。')}</Typography.Paragraph>
    <div className="chat-layout">
      <Space orientation="vertical" className="conversation-list">
        <Button disabled={busy} onClick={() => {void act(async () => {remember(await api<Conversation>('/conversations', {title:t('新对话')}));});}}>{t('＋ 新对话')}</Button>
        {conversations.map(item => <Button key={item.id} type={item.id === chatId ? 'primary' : 'default'} disabled={busy} onClick={() => setChatId(item.id)}>{item.title}</Button>)}
      </Space>
      <Panel title={selected?.title ?? t('管理对话')}>
        <div>
          <CatalogNote/>
          <Form layout="vertical" component="div">
            <AgentPicker id="chat" value={selection} defaults={defaults} inherit onChange={value => setSelections(current => ({...current, [selectedKey]:value}))}/>
          </Form>
          <Button disabled={busy} onClick={() => {setBusy(true); void act(async () => {await saveSelection(t('新对话')); notify(t('对话配置已保存'));}).finally(() => setBusy(false));}}>{t('保存对话配置')}</Button>
          <Typography.Paragraph type="secondary" className="chat-time-note">{t('消息时间按此浏览器的本地时区显示。')}</Typography.Paragraph>
          <div id="messages" className="messages" ref={messagesRef} role="log" aria-label={t('管理对话')}>
            {(conversation?.messages ?? []).map(message => <div key={message.id} className={'message ' + message.role}>
              <div className="message-label"><span>{message.role === 'user' ? t('你 · ') + t(messageStatuses[message.status] ?? message.status) : t('管理 AGENT')}</span><MessageTime value={message.created_at}/></div>
              {message.role==='assistant'?<AgentMessage text={message.text}/>:<div className="message-text">{message.text}</div>}
              {message.error && <div className="danger-text">{message.error.code}</div>}
            </div>)}
            {!conversation?.messages?.length && <Empty description={t('从一个问题开始。状态、异常和业务插件，都可以在这里管理。')}/>}
          </div>
          <div id="actions" className="actions">{conversation?.actions?.slice(-8).map(action => <div key={action.id}>
            <Status value={action.status}/> {action.name}{action.target ? ' · ' + action.target : ''}{action.summary?.task_id ? ' → ' + action.summary.task_id : ''}{action.error ? ' · ' + t(action.error.message ?? action.error.code) : ''}
          </div>)}</div>
          <div className="chat-compose">
            <Input.TextArea id="message-input" aria-label={t('消息')} rows={4} value={draft} placeholder={t('告诉我你想了解或处理什么，例如：查询失败任务并说明原因。')} onChange={event => setDraft(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault(); void send();}}}/>
            <Button type="primary" loading={busy} onClick={() => {void send();}}>{t('发送')}</Button>
          </div>
        </div>
      </Panel>
    </div>
  </>;
}
