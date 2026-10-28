export function createTaskHistoryBatch({store,runner,schedules,activeDeliveries=new Set()}) {
  return async ({cutoff,now,cursor,limit})=>{
    const inspections=schedules.pruneInspectionHistory({cutoff,limit});
    const rows=store.expiredTasks({cutoff,now,cursor,limit});let deleted=0,failed=0;
    for(const row of rows) {
      if(activeDeliveries.has(row.task_id)||!store.canPurgeTaskHistory(row.task_id,{cutoff,now}))continue;
      if(row.run_id) {
        try {await runner.purgeHistory({run_id:row.run_id,task_id:row.task_id});}
        catch(error) {
          // Retry infrastructure outages next wakeup instead of timing out
          // separately for every expired record in a large history.
          if(!error.responseSettled)throw error;
          failed++;continue;
        }
      }
      try {
        // Files are gone before foreign-key-owned records. If this transaction
        // fails the terminal row remains a durable, idempotent cleanup request.
        const removed=store.transaction(()=>{
          if(activeDeliveries.has(row.task_id)||!store.purgeTaskHistory(row.task_id,{cutoff,now}))return false;
          schedules.deleteTaskHistory(row.task_id);return true;
        });
        if(removed)deleted++;
      } catch {failed++;}
    }
    const last=rows.at(-1);
    return {deleted:deleted+inspections,failed,cursor:last?{time:last.finished_at,id:last.task_id}:cursor,hasMore:rows.length===limit||inspections===limit};
  };
}
