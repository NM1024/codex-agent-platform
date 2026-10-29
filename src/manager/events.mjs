// State projections are sent from durable storage, never from raw Codex events.
export function streamConversation({req,res,store,auth,id,onClose}) {
  let queueVersion=store.queueVersion?.(id);
  const initial=store.getConversationPage(id);
  let closed=false,pending,timer,heartbeat,backpressureTimer,blocked=false,refreshSnapshot=false;const messages=new Set();
  // Ending an unfinished blocked response can retain its buffer forever after
  // cleanup cancels the stall timer. Explicit closure must release that socket.
  const close=(destroy=false)=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(backpressureTimer);clearInterval(heartbeat);messages.clear();unwatch();res.off('drain',drain);onClose?.(close);if(destroy===true||(blocked&&!res.writableFinished))res.destroy();else res.end();};
  const ready=()=>{
    if(closed||blocked)return false;
    if(!auth.authorize(req)){res.write('event: session-expired\ndata: {}\n\n');close();return false;}
    if(res.writableLength>1048576){close();return false;}
    return true;
  };
  const write=frame=>{
    if(res.write(frame)===false){
      // A large legitimate frame can exceed highWaterMark. Let it drain fully;
      // never build more projections while this response is backpressured.
      blocked=true;backpressureTimer=setTimeout(()=>close(true),15000);backpressureTimer.unref?.();
    }
    return true;
  };
  const send=(event,data)=>{
    if(!ready())return false;
    return write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const flush=()=>{
    timer=null;if(!pending||!ready())return;pending=false;
    try {
      const revision=store.queueVersion?.(id);
      if(refreshSnapshot){
        const snapshot=store.getConversationPage(id);refreshSnapshot=false;messages.clear();queueVersion=revision;send('conversation',snapshot);return;
      }
      const conversation={...store.metadata(id),...store.counts(id),...(revision===undefined||revision!==queueVersion?{queue:store.queue(id)}:{})},changed=[...messages].map(messageId=>store.message(messageId)).filter(Boolean);messages.clear();queueVersion=revision;
      send('patch',{conversation,messages:changed,actions:store.actionsPage(id)});
    }catch(error){if(error.code==='CONVERSATION_NOT_FOUND'){send('deleted',{id});close();}else close();}
  };
  const drain=()=>{blocked=false;clearTimeout(backpressureTimer);if(pending){clearTimeout(timer);flush();}};
  const unwatch=store.watch(id,change=>{
    if(closed)return;
    if(change.deleted){send('deleted',{id});close();return;}
    pending=true;if(change.messageId&&!refreshSnapshot){messages.add(change.messageId);if(messages.size>100){messages.clear();refreshSnapshot=true;}}
    if(!timer)timer=setTimeout(flush,40);
  });
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no','x-content-type-options':'nosniff'});
  res.flushHeaders();res.on('close',close);res.on('drain',drain);
  send('conversation',initial);
  if(!closed)heartbeat=setInterval(()=>{if(ready())write(': keep-alive\n\n');},15000);
  return close;
}
