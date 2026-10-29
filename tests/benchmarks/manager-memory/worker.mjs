import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,cp,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

// Internal worker entry point. Use run.py for the supported CLI.
const project=fileURLToPath(new URL('../../../',import.meta.url));
const mode=process.argv[2],spec=JSON.parse(process.argv[3]??'{}');
const scratch=resolve(spec.scratch??join(project,'.tmp/manager-memory-benchmark'));
const bin=spec.codexBinary;
if(!bin)throw new Error('run.py must provide the pinned native Codex binary');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const importSrc=async(version,path)=>import(pathToFileURL(join(version==='baseline'?join(scratch,'baseline'):project,'src',path)).href);
async function proc(pid){try{const [status,smaps]=await Promise.all([readFile(`/proc/${pid}/status`,'utf8'),readFile(`/proc/${pid}/smaps_rollup`,'utf8')]);const get=(s,k)=>Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`,'m'))?.[1]??0)*1024;return {pid,rss:get(status,'VmRSS'),rssHwm:get(status,'VmHWM'),pss:get(smaps,'Pss'),anonymous:get(smaps,'Anonymous'),privateClean:get(smaps,'Private_Clean'),privateDirty:get(smaps,'Private_Dirty')};}catch{return null;}}
async function tree(pid,depth=0){const p=await proc(pid);if(!p)return [];p.depth=depth;let ids=[];try{ids=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);}catch{}return [p,...(await Promise.all(ids.map(id=>tree(id,depth+1)))).flat()];}
async function sample(agent,clients,label){return {label,at:Date.now(),worker:{...process.memoryUsage(),...(await proc(process.pid))},codex:(await Promise.all(clients.filter(c=>!c.closed).map(c=>tree(c.process.pid)))).flat(),active:agent?.active.size??0,running:agent?.running.size??0,clients:clients.filter(c=>!c.closed).length};}
function emit(x){process.stdout.write(JSON.stringify(x)+'\n');}
// Count JSON result bytes without constructing another history-sized JSON string.
function jsonBytes(v){if(v===null)return 4;if(typeof v==='string'){let n=Buffer.byteLength(v)+2;for(const m of v.matchAll(/["\\\u0000-\u001f]/g))n+=JSON.stringify(m[0]).length-3;return n;}if(Array.isArray(v))return 2+Math.max(0,v.length-1)+v.reduce((n,x)=>n+jsonBytes(x),0);if(typeof v==='object'){const pairs=Object.entries(v).filter(([,x])=>x!==undefined);return 2+Math.max(0,pairs.length-1)+pairs.reduce((n,[k,x])=>n+jsonBytes(k)+1+jsonBytes(x),0);}return Buffer.byteLength(JSON.stringify(v));}

if(mode==='fixture'){
 let n=0,bytes=0;const size=spec.size??262144;
 const server=createServer(async(req,res)=>{if(req.url!=='/v1/responses'){res.writeHead(404);return res.end();}let body='';for await(const part of req)body+=part;bytes+=Buffer.byteLength(body);let parsed=JSON.parse(body);let requestBytes=Buffer.byteLength(body);parsed=null;body=null;n++;if(spec.delay)await wait(spec.delay);const text='Synthetic reply '+n+' '+ 'x'.repeat(size-30);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.output_item.done',item:{id:'reply-'+n,type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{id:'response-'+n,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}})+'\n\n');emit({fixtureRequest:n,requestBytes,totalRequestBytes:bytes});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));emit({port:server.address().port});
}else if(mode==='seed'){
 await mkdir(spec.home,{recursive:true});const {CodexRpcClient}=await importSrc('current','codex/rpc.mjs'),{initialize}=await importSrc('current','codex/session.mjs');
 const c=new CodexRpcClient({command:bin,cwd:spec.home,env:{PATH:process.env.PATH,HOME:spec.home,CODEX_HOME:spec.home,NO_PROXY:'127.0.0.1,localhost'},timeoutMs:30000});await initialize(c);
 const config={model_provider:'local_fixture',model_providers:{local_fixture:{name:'Synthetic fixture',base_url:spec.base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}},web_search:'disabled'};
 const {thread}=await c.request('thread/start',{ephemeral:false,cwd:spec.home,model:'gpt-6.1-sol',approvalPolicy:'never',sandbox:'read-only',config});
 for(let i=0;i<spec.turns;i++){let done;const completion=new Promise(r=>done=r),unsub=c.subscribe(e=>{if(e.method==='turn/completed')done(e.params.turn);});await c.request('turn/start',{threadId:thread.id,input:[{type:'text',text:`Synthetic request ${i}`} ]});const result=await completion;unsub();if(result.status!=='completed')throw new Error(JSON.stringify(result));if((i+1)%8===0)emit({seedTurns:i+1,threadId:thread.id});}
 await c.close();await writeFile(join(spec.home,'benchmark-thread.json'),JSON.stringify({threadId:thread.id,turns:spec.turns}));emit({seedDone:true,threadId:thread.id});
}else if(mode==='worker'){
 const {ManagementAgent}=await importSrc(spec.version,'manager/agent.mjs'),{ManagerStore}=await importSrc(spec.version,'manager/store.mjs'),{CodexRpcClient}=await importSrc(spec.version,'codex/rpc.mjs');
 await mkdir(spec.root,{recursive:true});const store=new ManagerStore(join(spec.root,'manager.sqlite'));const clients=[],rpc=[],samples=[];let agent,created=0;
 const createClient=options=>{
   if(spec.stub){created++;let closed=false;const c={request:async(method,params)=>{if(method==='thread/start')return {thread:{id:'stub-'+created,turns:[]}};if(method==='turn/start')return {turn:{id:'turn-'+created}};if(method==='thread/read')return {thread:{id:params.threadId}};return {};},notify(){},subscribe(){return ()=>{};},handleServerRequest(){return ()=>{};},async close(){closed=true;},get closed(){return closed;}};return c;}
   const c=new CodexRpcClient({...options,command:bin,env:{PATH:process.env.PATH,HOME:options.env.HOME,CODEX_HOME:options.env.CODEX_HOME,NO_PROXY:'127.0.0.1,localhost'},timeoutMs:30000}),request=c.request.bind(c);clients.push(c);created++;
   c.request=async(method,params,...rest)=>{if(method==='thread/start'||method==='thread/resume')params={...params,config:{...params.config,web_search:'disabled',mcp_servers:{},model_provider:'local_fixture',model_providers:{local_fixture:{name:'Synthetic fixture',base_url:spec.base+'/v1',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}};const result=await request(method,params,...rest);rpc.push({method,responseBytes:jsonBytes(result),turns:result.thread?.turns?.length,excludeTurns:params?.excludeTurns});if(method==='thread/resume'){samples.push(await sample(agent,clients,'resume-response'));}return result;};return c;
 };
 agent=new ManagementAgent({store,root:spec.root,authFile:join(spec.root,'unused-auth.json'),mcpUrl:'http://127.0.0.1:1/mcp',timeoutMs:30000,createClient});
 global.gc();samples.push(await sample(agent,clients,'initial-idle-gc'));
 const conversations=[];
 for(let i=0;i<(spec.quantity??1);i++){const conv=store.createConversation('Benchmark '+i);conversations.push(conv.id);if(spec.seed){const home=join(spec.root,'codex',conv.id);await mkdir(home,{recursive:true});await cp(spec.seed,home,{recursive:true});const saved=JSON.parse(await readFile(join(home,'benchmark-thread.json'),'utf8'));const dbfile=(await readdir(home)).find(f=>/^state_.*\.sqlite$/.test(f));if(dbfile){const db=new DatabaseSync(join(home,dbfile));try{const rows=db.prepare('SELECT id,rollout_path FROM threads').all();for(const row of rows)if(row.rollout_path?.startsWith(spec.seed))db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(home+row.rollout_path.slice(spec.seed.length),row.id);}finally{db.close();}}store.thread(conv.id,saved.threadId);}agent.enqueue(conv.id,'Benchmark synthetic continuation '+ 'q'.repeat(spec.stub?1024:0));}
 let monitor=true;const sampling=(async()=>{while(monitor){samples.push(await sample(agent,clients,'active'));await wait(25);}})();
 if(spec.stub){await wait(500);global.gc();samples.push(await sample(agent,clients,'held-active-gc'));emit({checkpoint:{active:agent.active.size,running:agent.running.size,created}});}
 else{await Promise.all(conversations.map(id=>agent.idle(id)));}
 monitor=false;await sampling;await agent.stop();global.gc();await wait(100);global.gc();samples.push(await sample(agent,clients,'final-idle-gc'));
 const result={spec,rpc,samples,created,remainingChildProcesses:(await Promise.all(clients.map(c=>tree(c.process.pid)))).flat(),dbBytes:Number((await (await import('node:fs/promises')).stat(join(spec.root,'manager.sqlite'))).size),rows:store.db.prepare('SELECT status,COUNT(*) AS n FROM manager_messages GROUP BY status').all()};store.close();emit({result});
}
