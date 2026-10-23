import { safeDiagnostic } from '../codex/diagnostics.mjs';

const MAX_TEXT=8192,MAX_ITEMS=100;
export function publicChatText(text,secrets=[],streaming=false,maxLength=MAX_TEXT) {
  if(typeof text!=='string')return '';
  // Keep the final lexical token private until its boundary is known. A credential
  // can arrive over many deltas; sanitizing each individual delta would leak it.
  let value=streaming?text.replace(/\S+$/u,''):text;
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
  constructor({store,messageId,secrets=[]}) {Object.assign(this,{store,messageId,secrets});this.items=new Map();this.text='';this.closed=false;}
  save(id,kind,label,text,status='running',streaming=false) {
    this.store.progress(this.messageId,{id,kind,label:publicChatText(label,this.secrets,false,120),text:publicChatText(text,this.secrets,streaming),status});
  }
  event(event) {
    if(this.closed)return;
    const params=event.params ?? {},item=params.item,completed=event.method==='item/completed';
    if(event.method==='item/reasoning/summaryTextDelta'||event.method==='item/agentMessage/delta') {
      if(typeof params.itemId!=='string'||typeof params.delta!=='string')return;
      const summary=event.method==='item/reasoning/summaryTextDelta';
      const id=(summary?'summary:':'assistant:')+params.itemId+(summary?':'+(Number.isInteger(params.summaryIndex)?params.summaryIndex:0):'');
      if(!this.items.has(id)&&this.items.size>=MAX_ITEMS)return;
      const value=((this.items.get(id)?.text ?? '')+params.delta).slice(0,MAX_TEXT);
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
    for(const [id,item] of this.items)if(item.status==='running') {
      this.save(id,item.kind,item.label,item.text,status,false);
      if(item.kind==='assistant_message'&&!this.text)this.text=publicChatText(item.text,this.secrets,false,null);
    }
    this.closed=true;
  }
}
