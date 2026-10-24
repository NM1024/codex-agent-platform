// State projections are sent from durable storage, never from raw Codex events.
export function streamConversation({req,res,store,auth,id,onClose}) {
  const initial=store.getConversationPage(id);
  let closed=false,pending,timer,heartbeat;const messages=new Set();
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);clearInterval(heartbeat);unwatch();onClose?.(close);res.end();};
  const send=(event,data)=>{
    if(closed)return false;
    if(!auth.authorize(req)){res.write('event: session-expired\ndata: {}\n\n');close();return false;}
    // A slow browser reconnects to a fresh snapshot instead of retaining an unbounded queue.
    if(res.writableLength>1048576){close();return false;}
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);return true;
  };
  const flush=()=>{
    timer=null;if(closed||!pending)return;pending=false;
    try {
      const conversation={...store.metadata(id),...store.counts(id)},changed=[...messages].map(messageId=>store.message(messageId)).filter(Boolean);messages.clear();
      send('patch',{conversation,messages:changed,actions:store.actionsPage(id)});
    }catch(error){if(error.code==='CONVERSATION_NOT_FOUND'){send('deleted',{id});close();}else close();}
  };
  const unwatch=store.watch(id,change=>{
    if(closed)return;
    if(change.deleted){send('deleted',{id});close();return;}
    pending=true;if(change.messageId)messages.add(change.messageId);
    if(!timer)timer=setTimeout(flush,40);
  });
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no','x-content-type-options':'nosniff'});
  res.flushHeaders();res.on('close',close);
  send('conversation',initial);
  if(!closed)heartbeat=setInterval(()=>{if(!auth.authorize(req)){send('session-expired',{});return;}if(res.writableLength>1048576){close();return;}res.write(': keep-alive\n\n');},15000);
  return close;
}
