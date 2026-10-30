// Claim in Gateway before creating local work: a stale list must not revive a
// cancelled inspection. Claimed rows remain discoverable after a lost response
// or restart; ManagerStore deduplicates their source IDs.
export async function acceptPendingInspections({client,store,agent,closing=()=>false}) {
  const reconciled=new Set();
  const admit=async mapping=>{
    const acknowledgement=await client.execute('inspection_ack',mapping);
    if(acknowledgement?.accepted!==true)return;
    store.admitInspection(mapping.id,mapping.conversation_id,mapping.message_id);
    // A repeated intake also repairs a wake lost after durable ACK admission.
    agent.kick(mapping.conversation_id);
  };
  // Gateway may have committed the ACK while its reply (or the following local
  // admission) was lost. Its pending list no longer contains that inspection.
  let after;
  while(!closing()){
    const pending=store.pendingInspectionAdmissions({after});if(!pending.length)break;
    for(const mapping of pending){
      if(closing())return;
      reconciled.add(mapping.id);await admit(mapping);
    }
    after=pending.at(-1).conversation_id;
  }
  if(closing())return;
  for(const item of await client.execute('inspection_list')) {
    if(closing())return;
    if(reconciled.has(item.id))continue;
    const claimed=await client.execute('inspection_claim',{id:item.id});
    if(!claimed.accepted)continue;
    const accepted=store.acceptInspection(claimed.id,claimed.message);
    const mapping={id:claimed.id,conversation_id:accepted.conversation.id,message_id:accepted.message.id,message_status:accepted.message.status};
    await admit(mapping);
  }
}
