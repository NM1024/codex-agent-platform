import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Alert, Button, Collapse, Drawer, Empty, Input, Modal, Spin, Typography} from 'antd';
import {ApiError} from '../api';
import {CatalogNote, LoadingState, Status} from '../components';
import {ChatAgentPicker} from '../ChatAgentPicker';
import {agentSettingsFromValues} from '../modelOptions';
import {useConsole} from '../context';
import {AgentMessage, CopyButton, MessageTime} from '../ChatMessage';
import {isPending, MessageProgress} from '../ChatActivity';
import {DraftImages, MessageImages} from '../ImageAttachments';
import {compressChatImage} from '../chatImages';
import {Icon} from '../Icon';
import {QuestionCard} from '../QuestionCard';
import {ChatQueue,type QueueAction} from '../ChatQueue';
import {SandboxActivity,SandboxProvider} from '../SandboxActivity';
import {SandboxAttachments,SandboxDraftFiles} from '../SandboxAttachments';
import {validateSandboxFiles} from '../sandbox-files';
import {connectionWarning,runPresentation} from '../chat-progress';
import type {Action, AgentSettings, ChatImage, ConfigGroup, Conversation, Message,SandboxAttachment} from '../types';

interface ChatAction extends Omit<Action, 'error'> {
  summary?: {task_id?: string};
  error?: {code: string; message?: string};
}
type History=NonNullable<Conversation['history']>;
interface ChatConversation extends Omit<Conversation, 'actions'> {actions?: ChatAction[];olderLoaded?:boolean;historyBacklog?:{resume?:History;boundary:string[]}[]}
interface ConversationPage {items:Conversation[];next_cursor:string|null}
interface TranscriptPart {message:Message;key:string;live:boolean;tail?:boolean}
const mergeRows=<T extends {id:string}>(older:T[]=[],newer:T[]=[])=>{const rows=new Map(older.map(row=>[row.id,row]));for(const row of newer)rows.set(row.id,{...rows.get(row.id),...row});return Array.from(rows.values());};
const rootIds=(item:ChatConversation)=>item.messages?.filter(message=>message.role==='user'||!message.reply_to).map(message=>message.id)??[];
const mergeConversation=(current:ChatConversation|undefined,item:ChatConversation):ChatConversation=>{
  if(current?.id!==item.id)return item;
  const previous=rootIds(current),roots=rootIds(item),start=roots.indexOf(item.history?.before??''),window=roots.slice(Math.max(0,start));
  const gap=!!item.history?.has_more&&previous.length>0&&window.length>0&&!window.some(id=>previous.includes(id));
  return {...current,...item,messages:mergeRows(current.messages,item.messages).sort((a,b)=>a.created_at-b.created_at),actions:mergeRows(current.actions,item.actions),
    ...(gap?{history:item.history,olderLoaded:true,historyBacklog:[{resume:current.history,boundary:previous},...current.historyBacklog??[]]}:current.olderLoaded?{history:current.history,olderLoaded:true}:{})};
};
const conversationCounts=(item:Conversation)=>({queued_count:item.queued_count??item.messages?.filter(message=>message.role==='user'&&message.status==='queued').length,running_count:item.running_count??item.messages?.filter(message=>message.role==='user'&&['running','interrupted','recovering'].includes(message.status)).length});
type ConversationSummary=Pick<Conversation,'id'|'title'|'execution'|'queued_count'|'running_count'>;
const conversationSummary=(item:Conversation):ConversationSummary=>({id:item.id,title:item.title,execution:item.execution,...conversationCounts(item)});

export default function ChatPage() {
  const {api, operation, notify, t,  chatId, setChatId, setAuthenticated, chatDraft:draft, setChatDraft:setDraft, chatImages:images, setChatImages:setImages,chatFiles:files,setChatFiles:setFiles,uploadChatFile,chatSendBusy:busy,beginChatSend,serializeConversation:serialize} = useConsole();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listLoading,setListLoading]=useState(true);
  const [listCursor,setListCursor]=useState<string|null>(null);
  const [moreLoading,setMoreLoading]=useState(false);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [historyError,setHistoryError]=useState('');
  const listExpanded=useRef(false),listLock=useRef(false),historyLock=useRef<string|null>(null);
  const prependAnchor=useRef<{height:number;top:number;messageId?:string;offset?:number}|null>(null);
  const [defaults, setDefaults] = useState<AgentSettings>({});
  const [selections, setSelections] = useState<Record<string, AgentSettings>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string | undefined>>({});
  const [conversation, setConversation] = useState<ChatConversation>();
  const [saving, setSaving] = useState<Record<string,boolean>>({});
  const [compressing,setCompressing]=useState(false);
  const [uploading,setUploading]=useState(false);
  const [imageError,setImageError]=useState('');
  const [loadingId,setLoadingId]=useState<string|null>(chatId);
  const [loadError,setLoadError]=useState('');
  const [loadRetry,setLoadRetry]=useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unconfirmedRoots,setUnconfirmedRoots]=useState<{id:string;ids:string[]}>({id:'',ids:[]});
  const [readFailure,setReadFailure]=useState<string|null>(null);
  const [streamStatus,setStreamStatus]=useState<'connecting'|'connected'|'reconnecting'|'fallback'>('connecting');
  const [deleteTarget,setDeleteTarget]=useState<Conversation>();
  const [deleting,setDeleting]=useState<string|null>(null);
  const [deleteError,setDeleteError]=useState('');
  const deleteLock=useRef<string|null>(null);
  const deletedIds=useRef(new Set<string>());
  const streamVersions=useRef<Record<string,number>>({});
  const messageVersions=useRef<Record<string,number>>({});
  const mounted = useRef(true);
  const submitting = useRef(false);
  const composing = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const currentId = useRef(chatId);
  const navigation = useRef(0);
  const initialSelectionDone = useRef(Boolean(chatId));
  const selectionVersions = useRef<Record<string, number>>({});
  const unsavedSelections = useRef<Record<string,boolean>>({});
  const syncSelection=(id:string,execution:AgentSettings)=>{if(!unsavedSelections.current[id])setSelections(current=>({...current,[id]:execution}));};
  const reads = useRef<Record<string, number>>({});
  const fileInput=useRef<HTMLInputElement>(null),genericFileInput=useRef<HTMLInputElement>(null);
  const compressLock=useRef(false);
  const imagesRef=useRef(images);imagesRef.current=images;
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
  const conversationRef=useRef(conversation);conversationRef.current=conversation;
  const messages=visibleConversation?.messages??[];
  const queued=messages.filter(message=>message.role==='user'&&message.status==='queued');
  const queue=visibleConversation?.queue??messages.filter(message=>['queued','draft','steering','steer_unknown'].includes(message.status));
  const unconfirmedIds=unconfirmedRoots.id===chatId?unconfirmedRoots.ids:[];
  const runConnection=readFailure===chatId?'failed':streamStatus;
  const actions = visibleConversation?.actions?.filter(action=>!action.message_id).slice(-8) ?? [];
  // Associate the public reply with its request so completion retains the live bubble's identity.
  const transcript=[...messages].sort((a,b)=>(a.started_at??a.created_at)-(b.started_at??b.created_at)).flatMap<TranscriptPart>(message=>{
    if(message.role==='user'&&['queued','draft','removed','steering','steer_unknown'].includes(message.status))return [];
    if(message.role!=='user')return message.reply_to&&messages.some(user=>user.id===message.reply_to)?[]:[{message,key:message.id,live:false}];
    if(message.steer_parent_id&&messages.some(parent=>parent.id===message.steer_parent_id))return [];
    const withGuidance=(parts:TranscriptPart[]):TranscriptPart[]=>{
      const guidance=messages.filter(item=>item.status==='steered'&&item.steer_parent_id===message.id).map(item=>({message:item,key:item.id,live:false}));
      const time=(part:TranscriptPart)=>part.message.role==='user'?part.message.started_at??part.message.created_at:part.message.updated_at??part.message.created_at;
      return [{message,key:message.id,live:false},...[...parts,...guidance].sort((a,b)=>time(a)-time(b))];
    };
    const reply=messages.find(item=>item.role==='assistant'&&item.reply_to===message.id);
    if(message.replies?.length) {
      const parts:{message:Message;key:string;live:boolean;tail:boolean}[]=message.replies.map(item=>({message:{...item,id:'reply:'+message.id+':'+item.id,reply_to:message.id,role:'assistant'},key:'reply:'+message.id+':'+item.id,live:item.status==='running'&&isPending(message.status),tail:false}));
      if(reply&&parts.at(-1)?.message.text!==reply.text)parts.push({message:reply,key:'reply:'+message.id,live:false,tail:false});
      parts[parts.length-1].tail=true;
      return withGuidance(parts);
    }
    const partial=message.partial_text??message.activity?.filter(item=>item.kind==='assistant_message').map(item=>item.text).filter(Boolean).join('\n\n')??'';
    return withGuidance(reply?[{message:reply,key:'reply:'+message.id,live:false,tail:true}]:['running','interrupted','recovering'].includes(message.status)||message.generated_images?.length?[{message:{id:'reply:'+message.id,reply_to:message.id,role:'assistant',status:message.status,text:partial,created_at:message.started_at??message.created_at,updated_at:message.updated_at},key:'reply:'+message.id,live:isPending(message.status),tail:true}]:[]);
  });

  const forgetConversation=(id:string)=>{
    deletedIds.current.add(id);
    setConversations(current=>current.filter(item=>item.id!==id));
    if(currentId.current===id){
      initialSelectionDone.current=true;currentId.current=null;navigation.current++;
      setConversation(undefined);setLoadingId(null);setLoadError('');setDrawerOpen(false);setChatId(null);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);

  useEffect(() => {
    let active = true,fetchingList=false;
    setListLoading(true);
    void Promise.all([api<ConversationPage|Conversation[]>('/conversations'), operation<ConfigGroup>('configuration_get', {scope:'manager'})])
      .then(([page, group]) => {
        if (!active) return;
        const items=Array.isArray(page)?page:page.items;
        if(!listExpanded.current)setListCursor(Array.isArray(page)?null:page.next_cursor);
        const available=items.filter(item=>!deletedIds.current.has(item.id)).map(conversationSummary);
        setConversations(current => [...available, ...current.filter(row => !deletedIds.current.has(row.id)&&!items.some(item => item.id === row.id))]);
        setDefaults(agentSettingsFromValues(group.values,'concise'));
        if (!initialSelectionDone.current) {
          initialSelectionDone.current = true;
          if (!currentId.current && available.length) setChatId(available[0].id);
        }
      }).catch(error => {if (active) notify(t(error instanceof Error ? error.message : String(error)));}).finally(()=>{if(active)setListLoading(false);});
    const timer=setInterval(async()=>{
      if(fetchingList)return;fetchingList=true;
      try {const page=await api<ConversationPage|Conversation[]>('/conversations');if(active){const items=(Array.isArray(page)?page:page.items).map(conversationSummary);setConversations(current=>mergeRows(items,current.filter(row=>!items.some(item=>item.id===row.id))).filter(item=>!deletedIds.current.has(item.id)));if(!listExpanded.current)setListCursor(Array.isArray(page)?null:page.next_cursor);}}catch{/* Background list failures preserve the sidebar. */}
      finally {fetchingList=false;}
    },5000);
    return () => {active = false;clearInterval(timer);};
  }, [api, operation]);

  useEffect(() => {
    if (!chatId) {setConversation(undefined);setLoadingId(null);setLoadError('');return;}
    let active = true, fetching = false, fallback=false;
    let source:EventSource|undefined;
    const generation = navigation.current;
    const isCurrent=()=>active&&currentId.current===chatId&&navigation.current===generation&&!deletedIds.current.has(chatId);
    const confirmMessages=(messages:Message[])=>setUnconfirmedRoots(current=>current.id===chatId?{id:chatId,ids:current.ids.filter(id=>!messages.some(message=>message.id===id))}:current);
    const reconcileOmitted=async(item:ChatConversation)=>{
      const cached=conversationRef.current;
      if(cached?.id!==chatId)return;
      const omitted=(cached.messages??[]).filter(message=>message.role==='user'&&isPending(message.status)&&!item.messages?.some(row=>row.id===message.id)).map(message=>message.id);
      if(omitted.length)setUnconfirmedRoots(current=>({id:chatId,ids:Array.from(new Set([...(current.id===chatId?current.ids:[]),...omitted]))}));
      for(let start=0;start<omitted.length;start+=100){
        const ids=omitted.slice(start,start+100),versions=Object.fromEntries(ids.map(id=>[id,messageVersions.current[id]??0])),actionVersion=streamVersions.current[chatId]??0;
        try {
          const groups=await api<{messages:Message[];actions:ChatAction[]}>('/conversations/'+chatId+'/messages?ids='+encodeURIComponent(ids.join(',')));
          if(!isCurrent())return;
          const valid=ids.filter(id=>(messageVersions.current[id]??0)===versions[id]);
          confirmMessages(groups.messages.filter(message=>valid.includes(message.id)));
          // Actions can change without a message patch. Keep newer stream state;
          // unscoped actions already belong to the snapshot being reconciled.
          const actions=(streamVersions.current[chatId]??0)===actionVersion?groups.actions.filter(action=>action.message_id&&valid.includes(action.message_id)):[];
          setConversation(current=>current?.id!==chatId?current:{...current,messages:mergeRows(current.messages,groups.messages.filter(message=>valid.includes(message.reply_to??message.steer_parent_id??message.id))).sort((a,b)=>a.created_at-b.created_at),actions:mergeRows(current.actions,actions)});
        }catch{if(isCurrent())fallback=true;/* Retry read-only reconciliation without resubmitting work. */}
      }
    };
    setLoadingId(chatId);setLoadError('');
    let hasLoaded=conversation?.id===chatId;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      const read = (reads.current[chatId] ?? 0) + 1;
      reads.current[chatId] = read;
      const streamVersion=streamVersions.current[chatId]??0;
      try {
        const item = await api<ChatConversation>('/conversations/' + chatId);
        if (!active || currentId.current !== chatId || navigation.current !== generation || reads.current[chatId] !== read || (streamVersions.current[chatId]??0)!==streamVersion || deletedIds.current.has(chatId)) return;
        confirmMessages(item.messages??[]);setConversation(current=>mergeConversation(current,item));
        for(const message of item.messages??[])messageVersions.current[message.id]=(messageVersions.current[message.id]??0)+1;
        void reconcileOmitted(item);
        hasLoaded=true;setLoadingId(null);setLoadError('');setReadFailure(null);
        setConversations(current => current.map(row => row.id === item.id ? {...row, title:item.title,...conversationCounts(item)} : row));
        syncSelection(chatId,item.execution??{});
      } catch (error) {
        if(active&&currentId.current===chatId&&navigation.current===generation&&reads.current[chatId]===read&&(streamVersions.current[chatId]??0)===streamVersion)setReadFailure(chatId);
        if(active && currentId.current===chatId && navigation.current===generation && reads.current[chatId]===read && (streamVersions.current[chatId]??0)===streamVersion && error instanceof ApiError && error.status===404){forgetConversation(chatId);return;}
        if (active && currentId.current === chatId && navigation.current === generation && reads.current[chatId] === read && !hasLoaded) {setLoadError(error instanceof Error ? error.message : String(error));setLoadingId(null);}
      } finally {fetching = false;}
    };
    void load();
    const received=()=>{
      streamVersions.current[chatId]=(streamVersions.current[chatId]??0)+1;
      fallback=false;hasLoaded=true;setReadFailure(null);setStreamStatus('connected');setLoadingId(null);setLoadError('');
    };
    setStreamStatus('connecting');
    try {
      source=new EventSource('/admin/api/conversations/'+chatId+'/events');
      source.addEventListener('open',()=>{if(isCurrent()){fallback=false;setStreamStatus('connected');}});
      source.addEventListener('error',()=>{if(isCurrent()){fallback=true;setStreamStatus(source?.readyState===2?'fallback':'reconnecting');}});
      source.addEventListener('conversation',event=>{
        if(!isCurrent())return;
        try {
          const item=JSON.parse((event as MessageEvent).data) as ChatConversation;
          if(item.id!==chatId)return;
          received();confirmMessages(item.messages??[]);setConversation(current=>mergeConversation(current,item));
          for(const message of item.messages??[])messageVersions.current[message.id]=(messageVersions.current[message.id]??0)+1;
          void reconcileOmitted(item);
          setConversations(current=>current.map(row=>row.id===chatId?conversationSummary(item):row));
          syncSelection(chatId,item.execution??{});
        }catch{fallback=true;setStreamStatus('fallback');}
      });
      source.addEventListener('patch',event=>{
        if(!isCurrent())return;
        try {
          const patch=JSON.parse((event as MessageEvent).data) as {conversation:Partial<ChatConversation>&{id:string};messages:Message[];actions:ChatAction[]};
          if(patch.conversation.id!==chatId)return;
          received();confirmMessages(patch.messages);
          for(const message of patch.messages)messageVersions.current[message.id]=(messageVersions.current[message.id]??0)+1;
          setConversation(current=>{
            if(current?.id!==chatId)return current;
            const changed=new Map(patch.messages.map(message=>[message.id,message]));
            return {...current,...patch.conversation,messages:[...(current.messages??[]).map(message=>changed.has(message.id)?{...message,...changed.get(message.id)}:message),...patch.messages.filter(message=>!current.messages?.some(existing=>existing.id===message.id))],actions:mergeRows(current.actions,patch.actions)};
          });
          if(Object.hasOwn(patch.conversation,'execution'))syncSelection(chatId,patch.conversation.execution??{});
          setConversations(current=>current.map(row=>row.id===chatId?conversationSummary({...row,...patch.conversation}):row));
        }catch{fallback=true;setStreamStatus('fallback');}
      });
      source.addEventListener('deleted',event=>{if(isCurrent()){try{if(JSON.parse((event as MessageEvent).data).id===chatId){source?.close();forgetConversation(chatId);}}catch{/* Ignore malformed events. */}}});
      source.addEventListener('session-expired',()=>{if(isCurrent()){source?.close();setAuthenticated(false);}});
    }catch{fallback=true;setStreamStatus('fallback');}
    const timer = setInterval(() => {if(fallback)void load();}, 1000);
    return () => {active = false;source?.close();clearInterval(timer);};
  }, [api, chatId, loadRetry]);

  useLayoutEffect(()=>{
    if(prependAnchor.current&&messagesRef.current){const anchor=prependAnchor.current,element=Array.from(messagesRef.current.querySelectorAll<HTMLElement>('[data-message-id]')).find(element=>element.dataset.messageId===anchor.messageId);messagesRef.current.scrollTop=element&&anchor.offset!==undefined?messagesRef.current.scrollTop+element.getBoundingClientRect().top-anchor.offset:anchor.top+messagesRef.current.scrollHeight-anchor.height;prependAnchor.current=null;}
  },[visibleConversation]);
  const followReply=()=>{if(nearBottom.current&&messagesRef.current)messagesRef.current.scrollTop=messagesRef.current.scrollHeight;};
  useEffect(() => {
    if (nearBottom.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    if(visibleConversation){
      setConversations(current=>current.map(row=>row.id===visibleConversation.id?{...row,title:visibleConversation.title,...conversationCounts(visibleConversation)}:row));
    }
  }, [visibleConversation]);

  const selectConversation = (id: string | null) => {
    initialSelectionDone.current = true;
    setDrawerOpen(false);
    if (id !== null && currentId.current === id) return;
    currentId.current = id;
    navigation.current += 1;
    nearBottom.current = true;
    prependAnchor.current=null;setHistoryError('');
    setConversation(undefined);
    setLoadingId(id);setLoadError('');
    setChatId(id);
  };

  const loadMoreConversations=async()=>{
    if(!listCursor||listLock.current)return;
    listLock.current=true;setMoreLoading(true);
    try {const page=await api<ConversationPage>('/conversations?before='+encodeURIComponent(listCursor));if(mounted.current){listExpanded.current=true;setConversations(current=>mergeRows(current,page.items.map(conversationSummary)).filter(item=>!deletedIds.current.has(item.id)));setListCursor(page.next_cursor);}}
    catch(error){if(mounted.current)notify(t(error instanceof Error?error.message:String(error)));}
    finally{listLock.current=false;if(mounted.current)setMoreLoading(false);}
  };
  const loadEarlierMessages=async()=>{
    const id=chatId,cursor=visibleConversation?.history?.before,generation=navigation.current;
    if(!id||!cursor||historyLock.current)return;
    historyLock.current=id;setHistoryLoading(true);setHistoryError('');
    try {
      const page=await api<ChatConversation>('/conversations/'+id+'?before='+encodeURIComponent(cursor));
      if(!mounted.current||currentId.current!==id||navigation.current!==generation)return;
      nearBottom.current=false;
      setConversation(current=>{
        if(current?.id!==id)return current;
        if(messagesRef.current){const box=messagesRef.current.getBoundingClientRect(),first=Array.from(messagesRef.current.querySelectorAll<HTMLElement>('[data-message-id]')).find(element=>element.getBoundingClientRect().bottom>box.top);prependAnchor.current={height:messagesRef.current.scrollHeight,top:messagesRef.current.scrollTop,messageId:first?.dataset.messageId,offset:first?.getBoundingClientRect().top};}
        const merged={...current,messages:mergeRows(page.messages,current.messages).sort((a,b)=>a.created_at-b.created_at),actions:mergeRows(page.actions,current.actions),olderLoaded:true};
        // Reconnecting can introduce a newer gap while this older read is pending.
        // Keep its rows, but only advance the cursor this request actually loaded.
        if(current.history?.before!==cursor)return merged;
        const backlog=current.historyBacklog??[],bridge=backlog[0]&&rootIds(page).some(id=>backlog[0].boundary.includes(id));
        return {...merged,history:bridge?backlog[0].resume:page.history,historyBacklog:bridge?backlog.slice(1):page.history?.has_more?backlog:[]};
      });
    }catch(error){if(mounted.current&&currentId.current===id&&navigation.current===generation)setHistoryError(error instanceof Error?error.message:String(error));}
    finally{historyLock.current=null;if(mounted.current)setHistoryLoading(false);}
  };

  // Queue explicit local edits before sending; clean server settings may also
  // change through the management Agent and must not be overwritten on send.
  const persistSelection = (id: string, value: AgentSettings) => {
    const version = (selectionVersions.current[id] ?? 0) + 1;
    selectionVersions.current[id] = version;
    unsavedSelections.current[id]=true;
    setSaving(current=>({...current,[id]:true}));
    setSaveErrors(current => ({...current, [id]:undefined}));
    void serialize(id, () => api('/conversations/' + id, {execution:value})).then(() => {
      if (!mounted.current || selectionVersions.current[id] !== version) return;
      unsavedSelections.current[id]=false;
      setConversations(current => current.map(item => item.id === id ? {...item, execution:value} : item));
      setSaveErrors(current => ({...current, [id]:undefined}));
    }).catch(error => {
      if (mounted.current && selectionVersions.current[id] === version) setSaveErrors(current => ({...current, [id]:error instanceof Error ? error.message : String(error)}));
    }).finally(()=>{if(mounted.current && selectionVersions.current[id]===version)setSaving(current=>({...current,[id]:false}));});
  };

  const addImages=async(files:File[])=>{
    if(compressLock.current || !files.length)return;
    if(imagesRef.current.length+files.length>4){setImageError(t('每条消息最多添加 4 张图片。'));return;}
    const generation=navigation.current;
    compressLock.current=true;setCompressing(true);setImageError('');
    try {
      const compressed:ChatImage[]=[];
      for(const file of files)compressed.push(await compressChatImage(file));
      if(mounted.current && navigation.current===generation)setImages(current=>[...current,...compressed].slice(0,4));
    }catch(error){if(mounted.current && navigation.current===generation)setImageError(t(error instanceof Error?error.message:String(error)));}
    finally {compressLock.current=false;if(mounted.current)setCompressing(false);}
  };
  const addFiles=(selected:File[])=>{
    if(!selected.length)return;
    setFiles(current=>{
      const error=validateSandboxFiles(current,selected);
      if(error){setImageError(t(error));return current;}
      setImageError('');return [...current,...selected.map(file=>({id:crypto.randomUUID(),file}))];
    });
  };
  const addDroppedFiles=(selected:File[])=>{
    if(selected.every(file=>/^image\/(jpeg|png|webp)$/.test(file.type)))void addImages(selected);
    else addFiles(selected);
  };
  const changeSelection = (value: AgentSettings) => {
    initialSelectionDone.current = true;
    setSelections(current => ({...current, [selectedKey]:value}));
    if (chatId) persistSelection(chatId, value);
  };

  const send = async () => {
    if (submitting.current || composing.current || compressLock.current || (!draft.trim()&&!images.length&&!files.length) || draft.length>20000) return;
    const lease=beginChatSend(draft,images.map(image=>image.id),files.map(file=>file.id));
    if(!lease)return;
    initialSelectionDone.current = true;
    submitting.current = true;
    let released=false;
    const releaseSend=()=>{if(released)return;released=true;submitting.current=false;lease.release();};
    const text = draft, sentImages=[...images],sentFiles=[...files], execution = {...selection}, generation = navigation.current;
    let id = chatId;
    const stillSelected = () => mounted.current && navigation.current === generation;
    try {
      if (!id) {
        const created = await api<ChatConversation>('/conversations', {title:text.slice(0, 30)||t(sentFiles.length?'文件消息':'图片消息'), execution});
        id = created.id;
        if(!lease.active())return;
        if(!mounted.current||stillSelected())lease.created(id);
        if (mounted.current) {
          setConversations(current => [conversationSummary(created), ...current.filter(row => row.id !== created.id)]);
          setSelections(current => ({...current, [created.id]:execution}));
        }
        if (stillSelected()) {
          // Creating the conversation is part of this send, not a new navigation.
          currentId.current = id;
          initialSelectionDone.current = true;
          setChatId(id);
        }
      }
      if(!lease.active())return;
      const sentId = id;
      if(sentFiles.length&&mounted.current)setUploading(true);
      const uploaded:SandboxAttachment[]=[];
      for(const file of sentFiles){
        if(!lease.active())return;
        uploaded.push(await uploadChatFile(sentId,file));
      }
      if(!lease.active())return;
      if(mounted.current)setUploading(false);
      const accepted=await serialize(sentId, async () => {
        if(!lease.active())throw new Error(t('登录已过期，请重新登录。'));
        if(unsavedSelections.current[sentId]){await api('/conversations/' + sentId, {execution});unsavedSelections.current[sentId]=false;}
        if(!lease.active())throw new Error(t('登录已过期，请重新登录。'));
        return api<Partial<Message>>('/conversations/' + sentId + '/messages', {text,...(sentImages.length?{attachments:sentImages.map(image=>({name:image.name,dataUrl:image.dataUrl}))}:{}),...(uploaded.length?{file_ids:uploaded.map(file=>file.file_id)}:{})});
      });
      if(!lease.active())return;
      // Clear accepted input before reading the conversation; a read failure must never suggest resending it.
      lease.accepted();
      if (mounted.current) {
        setSaveErrors(current => ({...current, [sentId]:undefined}));
      }
      if(stillSelected() && currentId.current===sentId && !deletedIds.current.has(sentId)){
        const optimistic:Message={id:accepted.id??crypto.randomUUID(),role:'user',text,status:'queued',created_at:Date.now(),...(uploaded.length?{files:uploaded}:{}),...accepted};
        setConversation(current=>current?.messages?.some(message=>message.id===optimistic.id)?current:({...(current?.id===sentId?current:{id:sentId,title:text.slice(0,30)||t(sentFiles.length?'文件消息':'图片消息'),execution}),messages:[...(current?.id===sentId?current.messages??[]:[]),optimistic],queue:[...(current?.id===sentId?current.queue??[]:[]),...(optimistic.status==='queued'?[optimistic]:[])]}));
      }
      if(mounted.current)setConversations(current=>current.map(row=>row.id===sentId?{...row,queued_count:(row.queued_count??0)+1}:row));
      releaseSend();
      const read = (reads.current[sentId] ?? 0) + 1;
      reads.current[sentId] = read;
      const streamVersion=streamVersions.current[sentId]??0;
      let updated:ChatConversation;
      try {updated=await api<ChatConversation>('/conversations/' + sentId);}catch{return;}
      if (!mounted.current || reads.current[sentId] !== read || (streamVersions.current[sentId]??0)!==streamVersion || deletedIds.current.has(sentId)) return;
      setConversations(current => current.map(row => row.id === sentId ? {...row, title:updated.title, execution:updated.execution??{},...conversationCounts(updated)} : row));
      syncSelection(sentId,updated.execution??{});
      if (stillSelected() && currentId.current === sentId && reads.current[sentId] === read) setConversation(current=>mergeConversation(current,updated));
    } catch (error) {
      if (lease.active()&&stillSelected()) notify(t(error instanceof Error ? error.message : String(error)));
    } finally {
      if(mounted.current)setUploading(false);
      releaseSend();
    }
  };

  const deleteConversation=async()=>{
    if(!deleteTarget||deleteLock.current)return;
    const id=deleteTarget.id;
    deleteLock.current=id;setDeleting(id);setDeleteError('');
    try {
      const result=await serialize(id,()=>api<{deleted:boolean;cleanup_pending?:boolean}>('/conversations/'+id,undefined,'DELETE'));
      if(!mounted.current)return;
      forgetConversation(id);setDeleteTarget(undefined);
      if(result.cleanup_pending)notify(t('对话记录已删除，但工作目录未能完全清理。'));
    }catch(error){if(mounted.current)setDeleteError(error instanceof Error?error.message:String(error));}
    finally{deleteLock.current=null;if(mounted.current)setDeleting(null);}
  };

  const queueAction=async(message:Message,action:QueueAction,text?:string)=>{
    const id=chatId,generation=navigation.current,version=messageVersions.current[message.id]??0;
    if(!id)return;
    const path='/conversations/'+id+'/messages/'+message.id;
    const result=await api<Message|{id:string;deleted:boolean}>(path+(action==='delete'?'':'/'+action),action==='delete'?undefined:action==='requeue'?{text}:{},action==='delete'?'DELETE':undefined);
    if(!mounted.current||currentId.current!==id||navigation.current!==generation)return;
    if((messageVersions.current[message.id]??0)===version) {
      const updated:Message='deleted' in result?{...message,text:'',status:'removed',attachments:[],files:[]}:result;
      setConversation(current=>{
        if(current?.id!==id)return current;
        const currentQueue=current.queue??(current.messages??[]).filter(item=>['queued','draft','steering','steer_unknown'].includes(item.status));
        const nextQueue=currentQueue.filter(item=>item.id!==updated.id);
        if(['queued','draft','steering','steer_unknown'].includes(updated.status))nextQueue.push(updated);
        return {...current,queue:nextQueue,queued_count:Math.max(0,(current.queued_count??queued.length)+(updated.status==='queued'?1:0)-(message.status==='queued'?1:0)),messages:mergeRows(current.messages,[updated])};
      });
    }
    const streamVersion=streamVersions.current[id]??0;
    try {
      const snapshot=await api<ChatConversation>('/conversations/'+id);
      if(mounted.current&&currentId.current===id&&navigation.current===generation&&(streamVersions.current[id]??0)===streamVersion)setConversation(current=>mergeConversation(current,snapshot));
    }catch{/* The durable mutation succeeded; SSE or the next read reconciles it. */}
  };

  const conversationNavigation = <>
    <div className="conversation-heading"><Typography.Title level={2}>{t('最近对话')}</Typography.Title>
      <Button type="primary" onClick={() => selectConversation(null)}>{t('＋ 新对话')}</Button>
    </div>
    <nav className="conversation-list" aria-label={t('会话列表')}>
      {listLoading&&<LoadingState className="conversation-list-loading" compact label="正在加载对话…"/>}
      {conversations.map(item => {
        const counts=conversationCounts(item),pendingCount=(counts.queued_count??0)+(counts.running_count??0);
        const protectedRow=pendingCount>0||(busy&&item.id===chatId);
        return <div key={item.id} className="conversation-row" title={protectedRow?t('对话仍有待处理消息，请等待执行结束后删除。'):undefined}>
          <button type="button" className={'conversation-item' + (item.id === chatId ? ' active' : '')}
            aria-current={item.id === chatId ? 'true' : undefined} title={item.title} onClick={() => selectConversation(item.id)}><span>{item.title}</span>{pendingCount>0 && <small className="conversation-pending">{t('待处理')} {pendingCount}</small>}</button>
          <Button className="conversation-delete" type="text" danger size="small" icon={<Icon name="trash"/>} aria-label={t('删除对话：{title}',{title:item.title})} title={protectedRow?t('对话仍有待处理消息，请等待执行结束后删除。'):t('删除对话')} disabled={protectedRow||deleting!==null} loading={deleting===item.id} onClick={()=>{setDeleteError('');setDeleteTarget(item);}}/>
        </div>;
      })}
      {listCursor&&<Button className="conversation-more" loading={moreLoading} onClick={()=>void loadMoreConversations()}>{t('加载更多对话')}</Button>}
    </nav>
  </>;

  return <SandboxProvider conversationId={chatId}><div className="chat-layout">
    <Modal title={t('删除对话')} open={!!deleteTarget} okText={t('删除')} cancelText={t('取消')} okButtonProps={{danger:true,loading:!!deleting,'aria-label':t('删除')}} cancelButtonProps={{disabled:!!deleting}} closable={!deleting} maskClosable={!deleting} keyboard={!deleting} onOk={()=>void deleteConversation()} onCancel={()=>{if(!deleteLock.current)setDeleteTarget(undefined);}}>
      <p>{t('确定删除“{title}”吗？删除后无法恢复。',{title:deleteTarget?.title??''})}</p>
      {deleteError&&<Alert type="error" title={t(deleteError)}/>}
    </Modal>
    <aside className="conversation-sidebar">{conversationNavigation}</aside>
    <Drawer title={t('会话列表')} open={drawerOpen} onClose={() => setDrawerOpen(false)} placement="left" size={300} className="conversation-drawer">{conversationNavigation}</Drawer>
    <section className="chat-main" aria-label={t('管理对话')}>
      <header className="chat-header">
        <Button className="conversation-toggle" icon={<Icon name="conversations"/>} title={t('会话列表')} onClick={() => setDrawerOpen(true)} aria-label={t('会话列表')}/>
        <div><Typography.Title level={2}>{visibleConversation?.title ?? selected?.title ?? t('新对话')}</Typography.Title>
          <Typography.Text type="secondary" className="chat-time-note">{t('消息时间按此浏览器的本地时区显示。')}</Typography.Text>
          {chatId&&<span className={'chat-stream-status '+streamStatus} role="status">{t({connecting:'正在连接实时回复…',connected:'实时连接',reconnecting:'正在重新连接，暂时定时更新…',fallback:'实时连接不可用，正在定时更新。'}[streamStatus])}</span>}</div>
      </header>
      <div id="messages" className="messages" ref={messagesRef} role="log" aria-label={t('管理对话')}
        onScroll={event => {const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;}}>
        {!visibleConversation&&((!!loadingId&&loadingId===chatId)||(listLoading&&!chatId))&&<LoadingState className="chat-loading" label="正在加载对话…"/>}
        {loadError && !visibleConversation && <Alert className="chat-load-error" type="error" title={t(loadError)} action={<Button size="small" onClick={()=>setLoadRetry(value=>value+1)}>{t('重试')}</Button>}/>}
        {visibleConversation?.history?.has_more&&<div className="history-more"><Button aria-label={t('加载更早消息')} aria-busy={historyLoading} loading={historyLoading} onClick={()=>void loadEarlierMessages()}>{t('加载更早消息')}</Button></div>}
        {historyError&&<Alert type="error" title={t(historyError)}/>}
        {transcript.map(({message,key,live,tail}) => {
          const source=message.role==='assistant'?messages.find(item=>item.role==='user'&&item.id===message.reply_to):undefined;
          const messageConnection=source&&unconfirmedIds.includes(source.id)?'unconfirmed':runConnection;
          const phase=source?runPresentation(source).label:'正在处理',warning=source&&isPending(source.status)?connectionWarning(messageConnection):'';
          const hasAssistant=message.role==='user'&&transcript.some(part=>part.message.role==='assistant'&&part.message.reply_to===message.id);
          const replyLabel=source?.questions?.some(question=>question.status==='pending')?'等待回答':source?.status==='interrupted'?'等待继续':source?.status==='recovering'?'恢复中':warning?'状态待确认':'回复中';
          return <article key={key} data-message-id={key} className={'message ' + message.role}>
          <div className="message-avatar" aria-hidden="true">{message.role === 'user' ? 'U' : 'A'}</div>
          <div className="message-content">
            <div className="message-label">{message.role!=='user'&&<span>{t('管理 AGENT')}</span>}<MessageTime value={message.created_at}/>{live&&<span className="partial-label">{t(replyLabel)}</span>}</div>
            <div className="message-bubble">{message.role === 'assistant' ? <div className={live?'message-partial':undefined} aria-live="off"><AgentMessage text={message.text} live={live} onReveal={followReply}/>{live&&!message.text&&!source?.generated_images?.length&&<span className="reply-placeholder">{t(warning||phase)}</span>}</div> : <div className="message-text">{message.text}</div>}
              {chatId&&!!message.files?.length&&<SandboxAttachments conversationId={chatId} files={message.files.filter(file=>message.role!=='user'||file.origin==='upload'||!hasAssistant)}/>}
              {tail&&source&&chatId&&<SandboxAttachments conversationId={chatId} files={(source.files??[]).filter(file=>file.origin==='sandbox'&&!message.files?.some(existing=>existing.file_id===file.file_id))}/>}
              {!!message.attachments?.length && <MessageImages images={message.attachments}/>}
              {tail&&!!source?.generated_images?.length&&<MessageImages images={source.generated_images} generated/>}
              {message.error && <div className="danger-text">{message.error.code}</div>}</div>
            {message.role==='user'&&!hasAssistant&&<SandboxActivity messageId={message.id} existingFileIds={message.files?.map(file=>file.file_id)}/>}
            {message.role==='assistant' && <div className="message-footer">
              {!live && <CopyButton text={message.text} label={t('复制回复')}/>}
              {source && tail && <><SandboxActivity messageId={source.id} existingFileIds={[...(source.files??[]),...(message.files??[])].map(file=>file.file_id)}/>{source.questions?.map(request=><QuestionCard key={request.id} request={request} conversationId={chatId!}/>)}<MessageProgress message={source} connection={messageConnection} actions={visibleConversation?.actions?.filter(action=>action.message_id===source.id)}/></>}
            </div>}
          </div>
        </article>;})}
        {!messages.length && !loadError && !listLoading && (!loadingId||loadingId!==chatId) && <div className="chat-empty"><Empty description={t('从一个问题开始。状态、异常和业务插件，都可以在这里管理。')}/></div>}
      </div>
      <div className="chat-compose" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
        onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();addDroppedFiles(Array.from(event.dataTransfer.files));}}}>
        <ChatQueue key={'queue:'+selectedKey} messages={queue} canSteer={messages.some(message=>message.role==='user'&&message.status==='running')} onAction={queueAction}/>
        {actions.length > 0 && <div id="actions" className="actions"><Collapse size="small" aria-label={t('执行记录')} items={[{key:'actions', label:`${t('执行记录')} (${actions.length})`, children:actions.map(action => <div key={action.id} className="chat-action">
          <Status value={action.status}/> {action.name}{action.target ? ' · ' + action.target : ''}{action.summary?.task_id ? ' → ' + action.summary.task_id : ''}{action.error ? ' · ' + t(action.error.message ?? action.error.code) : ''}
        </div>)}]}/></div>}
        <CatalogNote/>
        <SandboxDraftFiles files={files} remove={id=>setFiles(current=>current.filter(file=>file.id!==id))}/>
        <DraftImages images={images} remove={id=>setImages(current=>current.filter(image=>image.id!==id))}/>
        {imageError && <Alert type="error" className="chat-image-error" title={imageError} closable onClose={()=>setImageError('')}/>}
        {uploading&&<div className="chat-image-busy" role="status"><Spin size="small"/> {t('正在上传文件…')}</div>}
        {compressing && <div className="chat-image-busy" role="status"><Spin size="small"/> {t('正在压缩图片…')}</div>}
        <div className="composer-input-shell">
        <Input.TextArea id="message-input" aria-label={t('消息')} autoSize={{minRows:2, maxRows:6}} value={draft}
          placeholder={t('告诉我你想了解或处理什么，例如：查询失败任务并说明原因。')} onChange={event => setDraft(event.target.value)}
          onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();addDroppedFiles(files);}}}
          onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            if (!event.shiftKey || event.ctrlKey || event.metaKey) {event.preventDefault(); void send();}
          }}/>
        <div className="composer-toolbar">
          <ChatAgentPicker key={selectedKey} value={selection} defaults={defaults} disabled={busy} onChange={changeSelection} saving={!!chatId&&saving[chatId]} saveError={chatId?saveErrors[chatId]:undefined} onRetry={()=>{if(chatId)persistSelection(chatId,{...selection});}}/>
          <input ref={fileInput} id="chat-image-input" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event=>{void addImages(Array.from(event.target.files??[]));event.target.value='';}}/>
          <Button className="chat-image-picker" icon={<Icon name="image"/>} title={t('添加图片')} aria-label={t('添加图片')} disabled={compressing||images.length>=4} onClick={()=>fileInput.current?.click()}/>
          <input ref={genericFileInput} id="chat-file-input" type="file" multiple hidden onChange={event=>{addFiles(Array.from(event.target.files??[]));event.target.value='';}}/>
          <Button className="chat-file-picker" icon={<Icon name="box"/>} title={t('添加文件')} aria-label={t('添加文件')} disabled={files.length>=5} onClick={()=>genericFileInput.current?.click()}/>
          <Button type="primary" className="composer-send" icon={<Icon name="send"/>} title={t('发送')} aria-label={t('发送')} loading={busy} disabled={compressing||(!draft.trim()&&!images.length&&!files.length)||draft.length>20000} onClick={() => {void send();}}/>
        </div>
        </div>
        <div className="composer-footer"><Typography.Text type="secondary" className="composer-hint">{t('Enter 发送，Shift + Enter 换行')}</Typography.Text>
          {draft.length>20000 && <span className="danger-text">{t('消息不能超过 20000 个字符。')}</span>}
          {chatId && saving[chatId] && <span role="status">{t('正在保存模型设置…')}</span>}
          {chatId && saveErrors[chatId] && <Button type="link" size="small" danger title={saveErrors[chatId]} disabled={busy} onClick={() => persistSelection(chatId, {...selection})}>{t('保存失败，重试')}</Button>}</div>
      </div>
    </section>
  </div></SandboxProvider>;
}
