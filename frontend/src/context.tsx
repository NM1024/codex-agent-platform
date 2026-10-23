import {createContext,useContext,useEffect,useState,useCallback,useRef,type ReactNode} from 'react';
import {request,ApiError} from './api';
import {getLocale,setLocale,t} from './i18n';
import type {Catalog,View,ChatImage,QuestionDraft} from './types';
interface ConsoleContext {
  locale:string;changeLocale:(locale:string)=>void;t:typeof t;pending:number;notice:string;notify:(text:string)=>void;
  authenticated:boolean;setAuthenticated:(value:boolean)=>void;view:View;navigate:(view:View)=>void;
  api:<T>(path:string,body?:unknown,method?:'DELETE')=>Promise<T>;operation:<T>(action:string,args?:unknown)=>Promise<T>;
  act:<T>(work:()=>Promise<T>)=>Promise<T|undefined>;chatId:string|null;setChatId:(id:string|null)=>void;
  chatDraft:string;setChatDraft:(value:string|((previous:string)=>string))=>void;
  chatImages:ChatImage[];setChatImages:(value:ChatImage[]|((previous:ChatImage[])=>ChatImage[]))=>void;
  chatSendBusy:boolean;beginChatSend:(text:string,imageIds:string[])=>{accepted:()=>void;release:()=>void}|null;
  catalog:Catalog;refreshCatalog:()=>Promise<void>;
  serializeConversation:<T>(id:string,work:()=>Promise<T>)=>Promise<T>;
  questionDrafts:Record<string,QuestionDraft>;
  updateQuestionDraft:(id:string,change:(current:QuestionDraft)=>QuestionDraft)=>void;
  beginQuestionAnswer:(id:string)=>{accepted:()=>void;failed:(message:string,expired?:boolean)=>void;release:()=>void}|null;
}
const Context=createContext<ConsoleContext|null>(null);
export const useConsole=()=>{const value=useContext(Context);if(!value)throw new Error('Console context missing');return value;};
export function ConsoleProvider({children}:{children:ReactNode}) {
  const [locale,updateLocale]=useState(getLocale()),[authenticated,updateAuthenticated]=useState(false),[view,setView]=useState<View>('overview');
  const [pending,setPending]=useState(0),[notice,notify]=useState(''),[chatId,setChatId]=useState<string|null>(null),[catalog,setCatalog]=useState<Catalog>({models:[]});
  const [chatDraft,updateChatDraft]=useState('');
  const [chatImages,setChatImages]=useState<ChatImage[]>([]);
  const [chatSendBusy,setChatSendBusy]=useState(false);
  const [questionDrafts,setQuestionDrafts]=useState<Record<string,QuestionDraft>>({});
  const questionLocks=useRef(new Set<string>());
  const conversationWrites=useRef(new Map<string,Promise<void>>()),sessionGeneration=useRef(0);
  const draftVersion=useRef(0),chatSendLock=useRef<symbol|null>(null);
  const updateQuestionDraft=useCallback((id:string,change:(current:QuestionDraft)=>QuestionDraft)=>setQuestionDrafts(current=>({...current,[id]:change(current[id]??{choices:{},texts:{}})})),[]);
  const beginQuestionAnswer=useCallback((id:string)=>{
    if(questionLocks.current.has(id))return null;
    questionLocks.current.add(id);const generation=sessionGeneration.current;
    updateQuestionDraft(id,current=>({...current,pending:true,error:''}));
    return {
      accepted:()=>{if(generation===sessionGeneration.current)updateQuestionDraft(id,current=>({...current,answered:true}));},
      failed:(message:string,expired=false)=>{if(generation===sessionGeneration.current)updateQuestionDraft(id,current=>({...current,error:message,expired}));},
      release:()=>{if(generation===sessionGeneration.current){questionLocks.current.delete(id);updateQuestionDraft(id,current=>({...current,pending:false}));}},
    };
  },[]);
  const setChatDraft=useCallback((value:string|((previous:string)=>string))=>{draftVersion.current++;updateChatDraft(value);},[]);
  const beginChatSend=useCallback((text:string,imageIds:string[])=>{
    if(chatSendLock.current)return null;
    const lease=Symbol(),generation=sessionGeneration.current,version=draftVersion.current;
    chatSendLock.current=lease;setChatSendBusy(true);
    return {
      accepted:()=>{
        if(generation!==sessionGeneration.current)return;
        if(version===draftVersion.current)updateChatDraft(current=>current===text?'':current);
        setChatImages(current=>current.filter(image=>!imageIds.includes(image.id)));
      },
      release:()=>{if(chatSendLock.current===lease){chatSendLock.current=null;setChatSendBusy(false);}},
    };
  },[]);
  const setAuthenticated=useCallback((value:boolean)=>{updateAuthenticated(value);if(!value){sessionGeneration.current++;questionLocks.current.clear();setQuestionDrafts({});chatSendLock.current=null;setChatSendBusy(false);conversationWrites.current.clear();setChatDraft('');setChatImages([]);setChatId(null);notify('');setCatalog({models:[]});}},[]);
  // Writes must remain ordered even when ChatPage unmounts during navigation.
  const serializeConversation=useCallback(<T,>(id:string,work:()=>Promise<T>):Promise<T>=>{
    const generation=sessionGeneration.current;
    const result=(conversationWrites.current.get(id)??Promise.resolve()).then(()=>{
      if(generation!==sessionGeneration.current)throw new Error(t('登录已过期，请重新登录。'));
      return work();
    });
    const tail=result.then(()=>{},()=>{});conversationWrites.current.set(id,tail);
    void tail.then(()=>{if(conversationWrites.current.get(id)===tail)conversationWrites.current.delete(id);});
    return result;
  },[]);
  const api=useCallback(async<T,>(path:string,body?:unknown,method?:'DELETE')=>{
    try{return await request<T>(path,body,method);}catch(error){if(error instanceof ApiError&&error.status===401)setAuthenticated(false);throw error;}
  },[]);
  const operation=useCallback(<T,>(action:string,args:unknown={})=>api<T>('/operations',{action,args}),[api]);
  const act=useCallback(async<T,>(work:()=>Promise<T>)=>{
    setPending(value=>value+1);
    try{return await work();}catch(error){notify(t(error instanceof Error?error.message:String(error)));return undefined;}
    finally{setPending(value=>value-1);}
  },[]);
  const refreshCatalog=useCallback(async()=>{
    try{setCatalog(await operation<Catalog>('models'));}catch{setCatalog({models:[],unavailable:true});}
  },[operation]);
  useEffect(()=>{void api('/session').then(()=>setAuthenticated(true)).catch(()=>{});},[api]);
  useEffect(()=>{if(authenticated)void refreshCatalog();},[authenticated,refreshCatalog]);
  useEffect(()=>{document.documentElement.lang=locale;document.title='Codex Agent Platform';},[locale]);
  const changeLocale=(value:string)=>{setLocale(value);updateLocale(getLocale());};
  const navigate=(next:View)=>{notify('');setView(next);};
  return <Context.Provider value={{locale,changeLocale,t,pending,notice,notify,authenticated,setAuthenticated,view,navigate,api,operation,act,chatId,setChatId,chatDraft,setChatDraft,chatImages,setChatImages,chatSendBusy,beginChatSend,catalog,refreshCatalog,serializeConversation,questionDrafts,updateQuestionDraft,beginQuestionAnswer}}>{children}</Context.Provider>;
}
