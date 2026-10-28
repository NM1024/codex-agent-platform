export function createManagerHistoryBatch({store,agent}) {
  return async ({cutoff,cursor,limit})=>{
    store.pruneObservations(cutoff);
    const rows=store.expiredConversations({cutoff,cursor,limit});let deleted=0,failed=0;
    for(const row of rows) {
      if(agent.running.has(row.id))continue;
      try {
        const result=await agent.deleteConversation(row.id,{cutoff});
        if(result.deleted)deleted++;if(result.cleanup_pending)failed++;
      } catch(error) {
        if(!['CONVERSATION_BUSY','CONVERSATION_NOT_EXPIRED','CONVERSATION_NOT_FOUND'].includes(error.code))failed++;
      }
    }
    const last=rows.at(-1);
    return {deleted,failed,cursor:last?{time:last.updated_at,id:last.id}:cursor,hasMore:rows.length===limit};
  };
}
