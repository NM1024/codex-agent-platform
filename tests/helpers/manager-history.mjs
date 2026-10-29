// Mirror the pinned app-server's metadata/item pagination in existing recovery
// fixtures; the real protocol is also exercised by manager-history-codex.test.
export function managerHistoryResponse(method,params,turns) {
  if(method!=='thread/items/list'&&method!=='thread/turns/list')return undefined;
  const values=method==='thread/turns/list'?turns.map(turn=>({...turn,items:[]})):
    turns.filter(turn=>!params.turnId||turn.id===params.turnId).flatMap(turn=>turn.items.map((item,index)=>({turnId:turn.id,item:{id:`fixture-item-${turn.id}-${index}`,...item}})));
  if(params.sortDirection==='desc')values.reverse();
  const start=Number(params.cursor??0),end=start+params.limit;
  return {data:values.slice(start,end),nextCursor:end<values.length?String(end):null};
}
