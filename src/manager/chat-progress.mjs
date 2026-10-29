import { safeDiagnostic } from '../codex/diagnostics.mjs';

const MAX_TEXT=8192,MAX_ITEMS=100,MAX_REPLY=1048576;
export function publicChatText(text,secrets=[],streaming=false,maxLength=MAX_TEXT) {
  if(typeof text!=='string')return '';
  // Keep the trailing credential-like ASCII token private until its boundary is known. A credential
  // can arrive over many deltas; sanitizing each individual delta would leak it.
  // Chinese prose need not wait for whitespace to become visible.
  let value=streaming?text.replace(/[A-Za-z0-9_~+\/.=:@%\-]+$/u,''):text;
  // A bounded record can end mid-token even when an item/turn completes.
  for(const secret of secrets)if(typeof secret==='string')for(let length=Math.min(secret.length-1,value.length);length>=4;length--)
    if(value.endsWith(secret.slice(0,length))){value=value.slice(0,-length)+'[REDACTED]';break;}
  value=value.replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*)"[^"]*(?:"|$)/gi,'$1"[REDACTED]"')
    .replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*)'[^']*(?:'|$)/gi,"$1'[REDACTED]'");
  value=value.replace(/data\s*:\s*image\/[^\s)\]"'<>]*/gi,'[IMAGE OMITTED]');
  return safeDiagnostic(value,secrets,{maxLength}) ?? '';
}

// Only explicitly public fields enter storage. This object never receives raw
// reasoning deltas or serializes tool arguments/results.
export class ChatProgress {
  constructor({store,messageId,secrets=[]}) {Object.assign(this,{store,messageId,secrets});this.items=new Map();this.text='';this.closed=false;this.replyId=null;this.replyText='';this.replyCompleted=false;this.replyStreaming=false;this.replyDirty=false;this.replyTimer=null;}
  reply(id,text,delta=false,streaming=false,completed=false) {
    if(this.replyId!==id){this.flushReply();this.replyId=id;this.replyText='';this.replyCompleted=false;this.replyStreaming=false;}
    if(delta) {
      const remaining=MAX_REPLY-this.replyText.length;
      if(remaining>0&&text.length){this.replyText+=text.slice(0,remaining);this.replyDirty=true;}
    }else {this.replyText=text.slice(0,MAX_REPLY);this.replyDirty=true;}
    if(this.replyCompleted!==completed||this.replyStreaming!==streaming)this.replyDirty=true;
    this.replyCompleted=completed;this.replyStreaming=streaming;
    if(!this.replyDirty)return;
    // Keep short replies immediate. Long replies persist the latest safe state
    // once per window, instead of copying and cleaning a growing SQL value for
    // every upstream token. Lifecycle boundaries synchronously flush this state.
    if(this.replyText.length<=MAX_TEXT||completed)this.flushReply();
    else if(!this.replyTimer)this.replyTimer=setTimeout(()=>this.flushReply(),40);
  }
  flushReply(streaming=this.replyStreaming,completed=this.replyCompleted) {
    clearTimeout(this.replyTimer);this.replyTimer=null;
    if(!this.replyDirty)return;
    this.replyDirty=false;
    const value=publicChatText(this.replyText,this.secrets,streaming,null);
    this.store.reply?.(this.messageId,value);
    this.store.replyItem?.(this.messageId,this.replyId,value,completed?'completed':'running');
    return value;
  }
  save(id,kind,label,text,status='running',streaming=false) {
    this.store.progress(this.messageId,{id,kind,label:publicChatText(label,this.secrets,false,120),text:publicChatText(text,this.secrets,streaming),status});
  }
  event(event) {
    if(this.closed)return;
    const params=event.params ?? {},item=params.item,completed=event.method==='item/completed';
    if(event.method==='item/reasoning/summaryTextDelta'||event.method==='item/agentMessage/delta') {
      if(typeof params.itemId!=='string'||typeof params.delta!=='string')return;
      const summary=event.method==='item/reasoning/summaryTextDelta';
      if(!summary)this.reply(params.itemId,params.delta,true,true);
      const id=(summary?'summary:':'assistant:')+params.itemId+(summary?':'+(Number.isInteger(params.summaryIndex)?params.summaryIndex:0):'');
      if(!this.items.has(id)&&this.items.size>=MAX_ITEMS)return;
      const old=this.items.get(id),previous=old?.text??'',remaining=MAX_TEXT-previous.length;
      const value=remaining>0?previous+params.delta.slice(0,remaining):previous;
      if(old?.status==='running'&&old.text===value)return;
      this.items.set(id,{kind:summary?'reasoning_summary':'assistant_message',label:summary?'Reasoning summary':'Assistant',text:value,status:'running'});
      this.save(id,summary?'reasoning_summary':'assistant_message',summary?'Reasoning summary':'Assistant',value,'running',true);return;
    }
    if(!['item/started','item/completed'].includes(event.method)||!item||typeof item.id!=='string')return;
    if(item.type==='reasoning') {
      if(!Array.isArray(item.summary))return;
      for(const [index,text] of item.summary.slice(0,20).entries()) {
        if(typeof text!=='string')continue;
        const id='summary:'+item.id+':'+index;
        if(!this.items.has(id)&&this.items.size>=MAX_ITEMS)break;
        const value={kind:'reasoning_summary',label:'Reasoning summary',text:text.slice(0,MAX_TEXT),status:completed?'completed':'running'};
        this.items.set(id,value);this.save(id,value.kind,value.label,value.text,value.status,!completed);
      }
    }else if(item.type==='agentMessage') {
      this.reply(item.id,typeof item.text==='string'?item.text:this.replyId===item.id?this.replyText:'',false,!completed,completed);
      // Final replies are independent of the bounded activity budget.
      if(completed)this.text=publicChatText(item.text,this.secrets,false,null);
      const id='assistant:'+item.id;
      if(!this.items.has(id)&&this.items.size>=MAX_ITEMS)return;
      const value={kind:'assistant_message',label:'Assistant',text:(typeof item.text==='string'?item.text:this.items.get(id)?.text ?? '').slice(0,MAX_TEXT),status:completed?'completed':'running'};
      this.items.set(id,value);this.save(id,value.kind,value.label,value.text,value.status,!completed);
    }else if(['mcpToolCall','dynamicToolCall','webSearch','imageGeneration','commandExecution','fileChange','collabAgentToolCall'].includes(item.type)) {
      const id='tool:'+item.id;if(!this.items.has(id)&&this.items.size>=MAX_ITEMS)return;
      const label=typeof item.tool==='string'?item.tool:item.type;
      const status=completed?(['failed','declined','cancelled'].includes(item.status)?'failed':item.status==='interrupted'?'unknown':'completed'):'running';
      this.items.set(id,{kind:'tool',label,text:'',status});this.save(id,'tool',label,'',status);
    }
  }
  finish(status='completed') {
    if(this.closed)return;
    if(this.replyText&&!this.replyCompleted)this.replyDirty=true;
    const partial=this.flushReply(false,status==='completed');
    if(this.replyText&&!this.replyCompleted)this.text=partial;
    for(const [id,item] of this.items)if(item.status==='running') {
      this.save(id,item.kind,item.label,item.text,status,false);
      if(item.kind==='assistant_message'&&!this.text)this.text=publicChatText(item.text,this.secrets,false,null);
    }
    this.closed=true;
  }
}
