import {systemFailure,systemDue,systemObserve} from '../observability/system-maintenance.mjs';
// Claim in Gateway before creating local work: a stale list must not revive a
// cancelled inspection. Claimed rows remain discoverable after a lost response
// or restart; ManagerStore deduplicates their source IDs.
export async function acceptPendingInspections({client,store,agent,journal,force=false,closing=()=>false}) {
  const work={id:'inspection-intake',module:'inspections',allowed_actions:['inspection_reconcile']};
  if(!systemDue(journal,work.id,{force}))return;
  try {const pending=await accept({client,store,agent,journal,closing});if(!closing())systemObserve(journal,{...work,state:pending?'unknown':'completed',code:pending?'HANDOFF_FAILED':'HANDOFF_COMPLETED',pending_count:pending});}
  catch(error){systemFailure(journal,{...work,code:'HANDOFF_FAILED',pending_count:1},error);throw error;}
}
async function accept({client,store,agent,journal,closing}) {
  const reconciled=new Set(),unconfirmed=new Set(),rejected=new Set();
  const admit=async mapping=>{
    const acknowledgement=await client.execute('inspection_ack',mapping);
    if(acknowledgement?.accepted!==true){unconfirmed.add(mapping.id);return;}
    store.admitInspection(mapping.id,mapping.conversation_id,mapping.message_id);
    journal?.event({module:'inspections',event:'inspection_admitted',target_id:mapping.id,code:'HANDOFF_COMPLETED',details:{phase:'ack'}});
    // A repeated intake also repairs a wake lost after durable ACK admission.
    if(!['completed','failed'].includes(mapping.message_status))agent.kick(mapping.conversation_id);
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
    if(!claimed.accepted){rejected.add(item.id);continue;}
    // Legacy accepted records already belong to a conversation. Reconcile only
    // its original message; missing history must never create replacement work.
    const accepted=claimed.status==='accepted'?store.existingInspection(claimed.id,claimed.conversation_id):store.acceptInspection(claimed.id,claimed.message);
    if(!accepted){unconfirmed.add(item.id);continue;}
    const mapping={id:claimed.id,conversation_id:accepted.conversation.id,message_id:accepted.message.id,message_status:accepted.message.status};
    await admit(mapping);
  }
  // A list can race with cancellation or another confirmed admission. Only
  // claims that are still pending indicate an unresolved handoff.
  if(rejected.size)for(const item of await client.execute('inspection_list'))if(rejected.has(item.id))unconfirmed.add(item.id);
  return unconfirmed.size;
}
