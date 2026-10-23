import {fault} from './registry.mjs';
export function taskArtifacts(store,row) {
  const module=store.moduleFor(row);
  return (module.artifactsFor?.(row,{store}) ?? store.registry.catalog.artifactsFor?.(store,row.task_id) ?? []).map(({path,...artifact})=>artifact);
}
export function taskDetails(store,id) {
  const row=store.raw(id);if(!row)throw fault('NOT_FOUND',404);
  const module=store.moduleFor(row);
  return {...store.get(id),request_id:row.request_id,input:JSON.parse(row.input),definition:row.definition?JSON.parse(row.definition):null,
    artifacts:taskArtifacts(store,row),operations:store.operationRecords(row.run_id),
    ...(module.inspectTask?{business:module.inspectTask(row,{store})}:{})};
}
