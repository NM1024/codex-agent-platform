import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import { readRegular } from '../files.mjs';
import { saveArtifact, sourceRoots } from './processors.mjs';
import { join } from 'node:path';

const fail=(code,status=400)=>new HttpError(status,code,code);
export function artifactFor(store,taskId,id) {
  const row=store.db.prepare('SELECT metadata FROM platform_artifacts WHERE artifact_id=? AND task_id=?').get(id,taskId);
  if (!row) throw fail('ARTIFACT_NOT_OWNED',403);
  return JSON.parse(row.metadata);
}
export function capabilityCatalog({workspace,targets={},resources={}}={}) {
  const catalog={targets,resources,processors:{register_image:saveArtifact,write_text_artifact:saveArtifact}};
  catalog.initializeStorage=({db})=>db.exec('CREATE TABLE IF NOT EXISTS platform_artifacts(artifact_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,metadata TEXT NOT NULL)');
  catalog.artifactsFor=(store,taskId)=>store.db.prepare('SELECT metadata FROM platform_artifacts WHERE task_id=?').all(taskId).map(row=>JSON.parse(row.metadata));
  catalog.readArtifact=async(store,taskId,id)=>{
    const artifact=artifactFor(store,taskId,id);
    return {...artifact,data:await readRegular(join(workspace,'artifacts',artifact.run_id),artifact.path,32*1024*1024,{allowEmpty:artifact.mime.startsWith('text/')})};
  };
  catalog.scope=({run,workDir,home,definition})=>({readRoots:[...sourceRoots({workDir,home}),join(workspace,'artifacts',run.run_id)],referenceFiles:(definition.resources ?? []).map(id=>resources[id].path)});
  async function save(name,args,context) {
    const artifact_id=randomUUID();let processed;
    try {processed=await context.process({name,artifact_id,run_id:context.runId,...args});}
    catch(error) {if (/^[A-Z_]+$/.test(error.message)) throw fail(error.message);throw error;}
    const {preview,preview_mime,...artifact}=processed;
    if (!['dispatching','running'].includes(context.store.run(context.runId)?.status)) throw fail('TASK_CLOSED',409);
    context.store.db.prepare('INSERT INTO platform_artifacts VALUES(?,?,?,?)').run(artifact_id,context.taskId,context.runId,JSON.stringify(artifact));
    return name==='register_image'?{content:[{type:'image',mimeType:preview_mime,data:preview},{type:'text',text:JSON.stringify({artifact_id,...artifact})}],structuredContent:{artifact_id,...artifact}}:artifact;
  }
  catalog.tools={
    register_image:{effect:'local',contentResult:true,description:'Save an image generated in this task as a task-owned artifact. Returns an image preview and artifact_id. Choose format and dimensions according to the task instructions.',
      inputSchema:{type:'object',additionalProperties:false,properties:{source_path:{type:'string',minLength:1},format:{enum:['jpeg','png','webp']},width:{type:'integer',minimum:1},height:{type:'integer',minimum:1},quality:{type:'integer',minimum:1,maximum:100}},required:['source_path']},execute:(args,ctx)=>save('register_image',args,ctx)},
    write_text_artifact:{effect:'local',description:'Save supplied UTF-8 text as a task artifact, returning artifact_id. filename is a simple display filename, not a path.',
      inputSchema:{type:'object',additionalProperties:false,properties:{filename:{type:'string',minLength:1},text:{type:'string'}},required:['filename','text']},execute:(args,ctx)=>save('write_text_artifact',args,ctx)},
    read_artifact:{readOnly:true,description:'Read metadata of an artifact belonging to this task.',inputSchema:{type:'object',additionalProperties:false,properties:{artifact_id:{type:'string'}},required:['artifact_id']},
      async execute(args,ctx) {return artifactFor(ctx.store,ctx.taskId,args.artifact_id);}},
    http_request:{effect:'external',description:'Send a JSON HTTP request to a configured target by its name. Credentials are injected by the service. A transport error may have an unknown effect; decide according to the task instructions.',
      inputSchema:{type:'object',additionalProperties:false,properties:{target:{type:'string'},method:{enum:['GET','POST']},body:{}},required:['target','method']},
      async execute(args) {
        const target=Object.hasOwn(targets,args.target)?targets[args.target]:undefined;if (!target) throw fail('TARGET_UNAVAILABLE');
        const response=await fetch(target.url,{method:args.method,headers:{...(args.method==='POST'?{'content-type':'application/json'}:{}),...(target.token?{authorization:`Bearer ${target.token}`}:{})},...(args.method==='POST'?{body:JSON.stringify(args.body ?? {})}:{}),redirect:'manual',signal:AbortSignal.timeout(target.timeoutMs ?? 60000)});
        const text=await response.text();return {http_status:response.status,body:target.token?text.replaceAll(target.token,'[REDACTED]'):text};
      }},
  };
  catalog.validateResult=async(result,ctx)=>{
    const visit=async value=>{if (!value || typeof value!=='object') return;
      for (const [key,item] of Object.entries(value)) {
        if ((key==='artifact_id' || key.endsWith('_artifact_id')) && typeof item==='string') {
          const artifact=artifactFor(ctx.store,ctx.taskId,item);await readRegular(`${workspace}/artifacts/${artifact.run_id}`,artifact.path,32*1024*1024,{allowEmpty:artifact.mime.startsWith('text/')});
        } else await visit(item);
      }
    };await visit(result);
  };
  return catalog;
}
