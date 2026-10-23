import { createHash,randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { lstat,symlink } from 'node:fs/promises';
import { safeDirectory } from '../files.mjs';
import { CodexRpcClient,filteredCodexEnv } from '../codex/rpc.mjs';
import { initialize } from '../codex/session.mjs';
import { runtimeConfig } from '../codex/config.mjs';
import { safeDiagnostic } from '../codex/diagnostics.mjs';
import { readSystemPrompt,renderSystemPrompt } from '../prompts.mjs';
import { managementTools } from '../contracts/management.mjs';
import {resolveAgentSettings} from '../configuration/agent-settings.mjs';
import {validateModelEffort} from '../codex/models.mjs';
import {ChatProgress,publicChatText} from './chat-progress.mjs';

const hash=token=>createHash('sha256').update(token).digest('hex');
export class ManagementAgent {
  constructor({store,root,authFile,mcpUrl,model='gpt-6.1-sol',timeoutMs=2400000,toolTimeoutMs=180000,createClient=options=>new CodexRpcClient(options)}) {
    Object.assign(this,{store,root,authFile,mcpUrl,model,timeoutMs,toolTimeoutMs,createClient});this.running=new Map();this.active=new Map();this.tokens=new Map();this.waiting=new Set();this.wakes=new Set();this.closed=false;
  }
  authorize(token){return typeof token==='string'&&token.length<256?this.tokens.get(hash(token)):undefined;}
  enqueue(conversationId,text,images=[]) {const message=this.store.enqueue(conversationId,text,images);if(this.running.has(conversationId))this.wakes.add(conversationId);this.waiting.delete(conversationId);this.kick(conversationId);return message;}
  kick(id) {
    if(this.closed||this.running.has(id))return;
    const pending=this.loop(id).finally(()=>{this.running.delete(id);if(!this.closed&&!this.waiting.has(id)&&this.store.next(id))this.kick(id);});
    this.running.set(id,pending);
  }
  async idle(id){while(this.running.has(id))await this.running.get(id);}
  async recover(){for(const row of this.store.recover())this.kick(row.conversation_id);}
  async loop(id) {
    while(!this.closed) {
      const message=this.store.next(id);if(!message)return;
      this.wakes.delete(id);
      if(await this.execute(message)==='interrupted'&&!this.wakes.delete(id)){this.waiting.add(id);return;}
    }
  }
  async execute(message) {
    const conversation=this.store.getConversation(message.conversation_id),recovering=message.status==='interrupted';
    const settings=message.execution ?? resolveAgentSettings({model:this.model,...(this.reasoningEffort!==undefined?{reasoningEffort:this.reasoningEffort}:{}),timeoutMs:this.timeoutMs,toolTimeoutMs:this.toolTimeoutMs},conversation.execution);
    // An omitted legacy global effort must clear an earlier conversation override.
    if(settings.reasoningEffort===undefined && conversation.thread_id && conversation.messages.some(item=>item.execution?.reasoningEffort!==undefined))settings.reasoningEffort=null;
    this.store.recordMessageExecution(message.id,settings);
    const marker=`[management_message_id:${message.id}]`;
    this.store.markRunning(message.id);
    const token=randomBytes(32).toString('base64url');this.tokens.set(hash(token),conversation.id);
    const home=join(this.root,'codex',conversation.id),workDir=join(this.root,'work',conversation.id);
    let client,unsubscribe,timer;const state={text:'',resolve:null,finalized:false,turnId:null,pending:[]};this.active.set(message.id,state);
    const progress=new ChatProgress({store:this.store,messageId:message.id,secrets:[token]});
    try {
      await safeDirectory(home);await safeDirectory(workDir);
      try{await lstat(join(home,'auth.json'));}catch(error){if(error.code!=='ENOENT')throw error;await symlink(this.authFile,join(home,'auth.json'));}
      const env={...filteredCodexEnv(),HOME:home,CODEX_HOME:home,AGENT_TASK_MCP_TOKEN:token,AGENT_TASK_WORK_DIR:workDir,AGENT_TASK_READ_ROOTS:JSON.stringify([workDir]),AGENT_TASK_REFERENCE_FILES:'[]'};
      client=this.createClient({cwd:workDir,env});state.client=client;
      await initialize(client);
      if(this.closed){this.store.interrupted(message.id);return;}
      const prompt=(this.instructions ?? readSystemPrompt('manager'))+'\n\n'+readSystemPrompt('manager-connections');
      const config=runtimeConfig({native:{},tools:managementTools.map(tool=>tool.name)},this.mcpUrl,{toolTimeoutMs:settings.toolTimeoutMs});
      const response=await client.request(conversation.thread_id?'thread/resume':'thread/start',{
        ...(conversation.thread_id?{threadId:conversation.thread_id,excludeTurns:false}:{ephemeral:false}),
        model:settings.model,cwd:workDir,approvalPolicy:'never',sandbox:'read-only',developerInstructions:prompt,config,
      });
      const threadId=response.thread.id;this.store.thread(conversation.id,threadId);
      const syncTitle=name=>this.store.syncTitle(conversation.id,safeDiagnostic(name,[token],{maxLength:null}));
      syncTitle(response.thread.name);
      // Reconcile the original submission before deciding whether a continuation is needed.
      // turn/start may have reached Codex even when its acknowledgement was not persisted.
      const turns=response.thread.turns ?? [];
      const recorded=[...turns].reverse().find(turn=>turn.items?.some(item=>item.type==='userMessage'&&item.content?.some(part=>part.type==='text'&&part.text?.startsWith(marker))))
        ?? turns.find(turn=>turn.id===message.turn_id);
      if(recovering&&recorded&&['completed','failed'].includes(recorded.status)) {
        for(const item of recorded.items ?? [])progress.event({method:'item/completed',params:{item}});
        progress.finish(recorded.status==='completed'?'completed':'failed');
        const text=publicChatText(recorded.items?.filter(item=>item.type==='agentMessage').at(-1)?.text ?? '',[token],false,null);
        this.store.turn(message.id,recorded.id);
        this.store.finish(message,recorded.status==='completed'?null:{code:'CODEX_TURN_FAILED',message:safeDiagnostic(recorded.error?.message,[token]) || '管理轮次失败，运行时没有提供具体错误。'},safeDiagnostic(text,[token],{maxLength:null}));
        return;
      }
      const continuation=recovering&&(recorded||message.turn_id);
      const outcome=new Promise(resolve=>{state.resolve=resolve;});
      const consume=event=>{
        if(state.finalized)return;
        const params=event.params ?? {},turnId=params.turnId ?? params.turn?.id;
        if(turnId!==state.turnId)return;
        if(event.method==='turn/completed') {
          state.finalized=true;const failed=params.turn?.status!=='completed';
          progress.finish(failed?'failed':'completed');state.text=progress.text;
          state.resolve({error:failed?{code:'CODEX_TURN_FAILED',message:publicChatText(params.turn?.error?.message,[token]) || '管理轮次失败，运行时没有提供具体错误。'}:null});
        }else progress.event(event);
      };
      unsubscribe=client.subscribe(event=>{
        if(state.finalized)return;
        if(event.method==='transport/closed'){state.disconnected=true;state.finalized=true;progress.finish('unknown');state.resolve({interrupted:true});return;}
        const params=event.params ?? {};if(params.threadId!==threadId)return;
        if(event.method==='thread/name/updated'){syncTitle(params.threadName);return;}
        if(!state.turnId){if(state.pending.length<200)state.pending.push(event);return;}
        consume(event);
      });
      timer=setTimeout(()=>{if(state.finalized)return;state.finalized=true;progress.finish('failed');state.text=progress.text;state.resolve({error:{code:'MANAGEMENT_TIMEOUT',message:'管理轮次超过配置的执行时间。'}});},settings.timeoutMs);
      const text=continuation?renderSystemPrompt('manager-resume',{recorded_actions_json:JSON.stringify(this.store.actions(conversation.id))}):message.text;
      if(this.closed){this.store.interrupted(message.id);return;}
      const effort=await validateModelEffort(client,settings);
      const started=await client.request('turn/start',{threadId,model:settings.model,effort,summary:'concise',input:[{type:'text',text:marker+'\n'+text},...(!continuation?this.store.imageInputs(message.id):[])]});
      this.store.turn(message.id,started.turn.id);
      state.turnId=started.turn.id;
      for(const event of state.pending)consume(event);state.pending=[];
      const result=await outcome;
      if(result.interrupted||this.closed){this.store.interrupted(message.id);return 'interrupted';}
      else {
        this.store.finish(message,result.error,state.text);
        if(!result.error) {
          // Title metadata is optional. Persist completion before this bounded lookup
          // so a transport timeout cannot interrupt or replay completed operations.
          try {
            const metadata=await client.request('thread/read',{threadId,includeTurns:false},1000);
            if(metadata.thread?.id===threadId)syncTitle(metadata.thread.name);
          }catch{}
        }
      }
    }catch(error) {
      progress.finish(this.closed||state.disconnected?'unknown':'failed');state.text=progress.text;
      if(this.closed||state.disconnected||['CODEX_EXIT','CODEX_TIMEOUT'].includes(error.message)) {
        this.store.interrupted(message.id);return 'interrupted';
      }
      else this.store.finish(message,{code:error.code ?? 'MANAGEMENT_START_FAILED',message:safeDiagnostic(error.message,[token]) || '管理会话启动失败。'},state.text);
    }finally {
      state.finalized=true;
      clearTimeout(timer);unsubscribe?.();await client?.close().catch(()=>{});this.tokens.delete(hash(token));this.active.delete(message.id);
    }
  }
  async stop() {
    this.closed=true;
    for(const state of this.active.values()) {state.resolve?.({interrupted:true});await state.client?.close().catch(()=>{});}
    await Promise.allSettled([...this.running.values()]);
  }
}
