// Claim in Gateway before creating local work: a stale list must not revive a
// cancelled inspection. Claimed rows remain discoverable after a lost response
// or restart; ManagerStore deduplicates their source IDs.
export async function acceptPendingInspections({client,store,agent,closing=()=>false}) {
  for(const item of await client.execute('inspection_list')) {
    if(closing())return;
    const claimed=await client.execute('inspection_claim',{id:item.id});
    if(!claimed.accepted)continue;
    const accepted=store.acceptInspection(claimed.id,claimed.message);
    if(accepted.created)agent.kick(accepted.conversation.id);
    await client.execute('inspection_ack',{id:claimed.id,conversation_id:accepted.conversation.id});
  }
}
