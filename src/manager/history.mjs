// History stays on Codex's durable store. Keep only one small page in memory;
// callers project selected items directly into their own bounded/persisted state.
const PAGE_SIZE=32;
const statuses=new Set(['completed','interrupted','failed','inProgress']);
// Pinned Codex 0.159.2 ThreadItem and persisted UserInput discriminants.
// Unknown variants cannot safely be ignored: they could conceal a submission
// marker or a final reply and turn an ambiguous recovery into a replay.
const itemTypes=new Set(['userMessage','hookPrompt','agentMessage','functionCallOutput','plan','reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','imageView','sleep','imageGeneration','enteredReviewMode','exitedReviewMode','contextCompaction']);
const inputFields=new Map([
  ['text',['text']],['image',[]],['localImage',['path']],['audio',['url']],
  ['localAudio',['path']],['skill',['name','path']],['mention',['name','path']],
]);
const invalid=()=>Object.assign(new Error('MANAGER_HISTORY_INVALID'),{code:'MANAGER_HISTORY_INVALID'});
const nonempty=value=>typeof value==='string'&&value.length>0;

function validInput(part) {
  const fields=inputFields.get(part?.type);
  return fields!==undefined&&fields.every(field=>typeof part[field]==='string');
}

async function* pages(client,method,params,validate) {
  let cursor,checkpoint,power=1,distance=0;
  for(;;) {
    const page=await client.request(method,{...params,limit:PAGE_SIZE,...(cursor===undefined?{}:{cursor})});
    if(!page||!Array.isArray(page.data)||page.data.length>PAGE_SIZE)throw invalid();
    // Manager requires an explicit null terminal cursor, even though the
    // upstream response schema allows omission, so truncation fails closed.
    const next=page.nextCursor;
    if(next!==null&&(!nonempty(next)||page.data.length===0))throw invalid();
    // Brent's cycle detection retains one checkpoint rather than a growing set
    // of every historical cursor. Also reject an immediately repeated cursor.
    if(next!==null) {
      if(next===cursor||next===checkpoint)throw invalid();
      distance++;
      if(distance===power){checkpoint=next;power*=2;distance=0;}
    }
    for(const value of page.data)validate(value);
    yield page.data;
    if(next===null)return;
    cursor=next;
  }
}

async function* items(client,{threadId,turnId},sortDirection) {
  if(!nonempty(threadId)||(turnId!==undefined&&!nonempty(turnId)))throw invalid();
  const params={threadId,sortDirection,...(turnId===undefined?{}:{turnId})};
  for await(const page of pages(client,'thread/items/list',params,entry=>{
    if(!entry||!nonempty(entry.turnId)||!entry.item||!nonempty(entry.item.id)||!itemTypes.has(entry.item.type)||(turnId!==undefined&&entry.turnId!==turnId))throw invalid();
    if(entry.item.type==='userMessage'&&(!Array.isArray(entry.item.content)||!entry.item.content.every(validInput)))throw invalid();
    if(entry.item.type==='agentMessage'&&typeof entry.item.text!=='string')throw invalid();
  }))for(const entry of page)yield entry;
}

function hasMarker(item,messageId) {
  const marker=`[management_message_id:${messageId}]`;
  return item.type==='userMessage'&&Array.isArray(item.content)&&item.content.some(part=>part?.type==='text'&&typeof part.text==='string'&&part.text.startsWith(marker));
}

async function findTurnMetadata(client,threadId,turnId) {
  for await(const page of pages(client,'thread/turns/list',{threadId,sortDirection:'desc',itemsView:'notLoaded'},turn=>{
    if(!turn||!nonempty(turn.id)||!statuses.has(turn.status)||!Array.isArray(turn.items)||turn.items.length!==0)throw invalid();
  })) {
    const turn=page.find(value=>value.id===turnId);
    if(turn)return {id:turn.id,status:turn.status,error:typeof turn.error?.message==='string'?{message:turn.error.message}:null};
  }
  return null;
}

/** Find the latest original/continuation marker, falling back to the saved ID.
 * Errors deliberately propagate: uncertainty must never cause a fresh replay.
 * A marker is authoritative even if a different turn ID was persisted earlier.
 */
export async function findRecordedTurn(client,{threadId,turnId,messageId}) {
  if(!nonempty(threadId)||(messageId!==undefined&&!nonempty(messageId))||(turnId!==undefined&&turnId!==null&&!nonempty(turnId)))throw invalid();
  let selected=turnId,foundMarker=false;
  if(messageId!==undefined)for await(const entry of items(client,{threadId},'desc')) {
    if(hasMarker(entry.item,messageId)){selected=entry.turnId;foundMarker=true;break;}
  }
  if(!selected)return null;
  const recorded=await findTurnMetadata(client,threadId,selected);
  if(foundMarker&&!recorded)throw invalid();
  return recorded;
}

/** Visit one selected turn in persisted order; await each projection for
 * backpressure. No array of turn items is constructed or returned.
 */
export async function forEachTurnItem(client,{threadId,turnId},onItem) {
  if(!nonempty(turnId)||typeof onItem!=='function')throw invalid();
  for await(const entry of items(client,{threadId,turnId},'asc'))await onItem(entry.item);
}

/** Reconcile a caller-owned pending set. Memory depends on pending messages,
 * never on the number of old turns or the total thread history.
 */
export async function findRecordedMessageIds(client,{threadId,turnId,messageIds}) {
  if(!Array.isArray(messageIds)||messageIds.some(id=>!nonempty(id)))throw invalid();
  const pending=new Set(messageIds),found=new Set();
  if(pending.size===0)return found;
  const prefix='[management_message_id:';
  for await(const {item} of items(client,{threadId,turnId},'desc')) {
    if(item.type!=='userMessage'||!Array.isArray(item.content))continue;
    for(const part of item.content) {
      if(part?.type!=='text'||typeof part.text!=='string'||!part.text.startsWith(prefix))continue;
      const end=part.text.indexOf(']',prefix.length);
      if(end===-1)continue;
      const id=part.text.slice(prefix.length,end);
      if(pending.delete(id))found.add(id);
    }
    if(pending.size===0)break;
  }
  return found;
}
