export function configuredDelivery(resolveTarget) {
  return {async execute({store,task}) {
    const target=typeof resolveTarget==='function'?resolveTarget():resolveTarget;
    if (!target) return {status:'blocked_configuration'};
    const reserved=store.db.prepare('UPDATE agent_deliveries SET status=? WHERE task_id=? AND status=?').run('unknown',task.task_id,'pending').changes;
    if (!reserved) return store.get(task.task_id).delivery;
    const row=store.raw(task.task_id),artifacts=store.registry.catalog.artifactsFor?.(store,task.task_id) ?? [];
    let status='unknown',http_status=null,error_code=null;
    try {
      const response=await fetch(target.url,{method:'POST',headers:{'content-type':'application/json',...(target.token?{authorization:`Bearer ${target.token}`}:{})},
        body:JSON.stringify({task_id:task.task_id,request_id:row.request_id,type:task.type,status:task.status,result:task.result,error:task.error,artifacts:artifacts.map(({path,...safe})=>safe)}),redirect:'manual',signal:AbortSignal.timeout(target.timeoutMs ?? 60000)});
      http_status=response.status;status=response.ok?'accepted':'failed';error_code=response.ok?null:'HTTP_REJECTED';await response.body?.cancel();
    } catch {error_code='DELIVERY_UNKNOWN';}
    store.db.prepare('UPDATE agent_deliveries SET status=? WHERE task_id=?').run(status,task.task_id);
    store.db.prepare('INSERT OR REPLACE INTO platform_delivery_details VALUES(?,?,?,?)').run(task.task_id,http_status,error_code,Date.now());
    return {status};
  }};
}

export function deliveryCatalog({targets={}}={}) {
  return {
    initializeStorage:({db})=>db.exec('CREATE TABLE IF NOT EXISTS platform_delivery_details(task_id TEXT PRIMARY KEY,http_status INTEGER,error_code TEXT,updated_at INTEGER)'),
    deliveryDetails:(store,taskId)=>store.db.prepare('SELECT http_status,error_code,updated_at FROM platform_delivery_details WHERE task_id=?').get(taskId),
    delivery:definition=>configuredDelivery(()=>Object.hasOwn(targets,definition.target)?targets[definition.target]:undefined),
  };
}
