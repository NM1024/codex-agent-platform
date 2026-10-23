import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import { readJson,json,errorResponse } from '../http.mjs';
import { HttpError } from '../errors.mjs';
import {renderSystemPrompt} from '../prompts.mjs';
import { managementTools } from '../contracts/management.mjs';
import {staticEncoding} from './static-encoding.mjs';
import {validateChatImages} from './chat-images.mjs';
import {streamConversation} from './events.mjs';
import {buildPluginIntegration} from './plugin-integration.mjs';

const webRoot=new URL('./web-dist/index.html',import.meta.url);
const assetPath=/^\/admin\/(favicon\.svg|third-party-notices\.md|assets\/[a-zA-Z0-9_-]+\.(?:js|css))$/;
export function createManagerServer({store,agent,operations,auth,metrics}) {
  const streams=new Set();let eventsClosed=false;
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://local'),path=url.pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{alive:true});
      if(req.method==='GET'&&path==='/admin'){res.writeHead(308,{location:'/admin/'});return res.end();}
      if((req.method==='GET'||req.method==='HEAD')&&(path==='/admin/'||assetPath.test(path))) {
        const index=path==='/admin/',file=index?'index.html':path.slice('/admin/'.length),nonce=randomBytes(18).toString('base64');
        const hashed=file.startsWith('assets/'),encoding=hashed?staticEncoding(req.headers['accept-encoding']):'identity';
        if(!encoding){res.writeHead(406,{'vary':'Accept-Encoding'});return res.end();}
        let data;
        try {data=await readFile(new URL(file+(encoding==='br'?'.br':encoding==='gzip'?'.gz':''),webRoot));}
        catch(error){if(error.code==='ENOENT')throw new HttpError(404,'NOT_FOUND','找不到接口。');throw error;}
        const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.md')?'text/plain; charset=utf-8':'image/svg+xml';
        if(index)data=Buffer.from(data.toString('utf8').replace('__CSP_NONCE__',nonce));
        res.writeHead(200,{'content-type':type,'content-length':data.length,...(hashed?{'vary':'Accept-Encoding'}:{}),...(encoding!=='identity'?{'content-encoding':encoding}:{}),'cache-control':index?'no-store':hashed?'public, max-age=31536000, immutable':'no-cache','x-content-type-options':'nosniff','content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,'referrer-policy':'no-referrer'});return res.end(req.method==='HEAD'?undefined:data);
      }
      if(!path.startsWith('/admin/api/'))throw new HttpError(404,'NOT_FOUND','找不到接口。');
      if(['POST','DELETE'].includes(req.method)&&req.headers.origin) {
        const protocol=req.headers['x-forwarded-proto'] ?? (req.socket.encrypted?'https':'http');
        if(req.headers.origin!==`${protocol}://${req.headers.host}`)throw new HttpError(403,'ORIGIN_DENIED','拒绝跨来源管理操作。');
      }
      if(req.method==='POST'&&path==='/admin/api/login') {
        const body=await readJson(req),session=await auth.login(body.password);
        res.setHeader('set-cookie',auth.cookie(session.token,req,session.expires_at));return json(res,200,{authenticated:true,expires_at:session.expires_at});
      }
      if(!auth.authorize(req))throw new HttpError(401,'UNAUTHORIZED','请使用 Admin 密码登录。');
      if(req.method==='GET'&&path==='/admin/api/session')return json(res,200,{authenticated:true});
      if(req.method==='POST'&&path==='/admin/api/logout'){auth.logout(req);res.setHeader('set-cookie',auth.cookie('',req));return json(res,200,{logged_out:true});}
      if(req.method==='POST'&&path==='/admin/api/password'){const body=await readJson(req);await auth.changePassword(body.currentPassword,body.password);res.setHeader('set-cookie',auth.cookie('',req));return json(res,200,{updated:true,sessions_revoked:true});}
      const events=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/events$/);
      if(req.method==='GET'&&events){if(eventsClosed)throw new HttpError(503,'SERVER_SHUTTING_DOWN','服务正在重启，请稍后重连。');const close=streamConversation({req,res,store,auth,id:events[1],onClose:closed=>streams.delete(closed)});if(!res.writableEnded)streams.add(close);return;}
      const chatImage=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/images\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&chatImage) {
        const image=store.getImage(chatImage[1],chatImage[2]);
        res.writeHead(200,{'content-type':image.mime,'content-length':image.size,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",'referrer-policy':'no-referrer'});
        return res.end(Buffer.from(image.bytes));
      }
      const pluginConnection=path.match(/^\/admin\/api\/plugins\/([^/]+)\/connection$/);
      const pluginIntegration=path.match(/^\/admin\/api\/plugins\/([^/]+)\/integration$/);
      if(req.method==='GET'&&pluginIntegration){
        const type=decodeURIComponent(pluginIntegration[1]);
        const [definition,connection]=await Promise.all([Promise.resolve().then(()=>operations.execute('plugin_get',{type})),Promise.resolve().then(()=>operations.pluginConnection(type))]);
        return json(res,200,buildPluginIntegration(definition,connection,{locale:url.searchParams.get('locale')}));
      }
      if(pluginConnection&&(req.method==='GET'||req.method==='POST')) {
        const type=decodeURIComponent(pluginConnection[1]);
        return json(res,200,await operations.pluginConnection(type,req.method==='POST'?await readJson(req):undefined));
      }
      if(req.method==='GET'&&path==='/admin/api/overview') {
        let platform;try{platform=await operations.execute('overview',{});}catch(error){platform={unavailable:true,error:{code:error.code ?? 'GATEWAY_UNAVAILABLE',message:error.message}};}
        return json(res,200,{sampled_at:Date.now(),manager:{alive:true},platform,resources:platform.resources ?? await metrics.sample(),investigations:store.investigations()});
      }
      if(path==='/admin/api/conversations') {
        if(req.method==='GET')return json(res,200,store.list());
        if(req.method==='POST') {
          const body=await readJson(req);
          store.validateExecution(body.execution ?? {});
          if(body.task_id!==undefined&&!/^[a-f0-9-]{36}$/.test(body.task_id))throw new HttpError(400,'INVALID_INPUT','任务编号不正确。');
          const conversation=store.createConversation(body.title,body.task_id?'task:'+body.task_id:null);
          if(body.execution)store.setConversationExecution(conversation.id,body.execution);
          if(body.investigate===true&&body.task_id&&!conversation.messages.length)
            agent.enqueue(conversation.id,renderSystemPrompt('task-investigation',{task_id:body.task_id}));
          return json(res,201,store.getConversation(conversation.id));
        }
      }
      const conversation=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})(\/messages)?$/);
      if(conversation) {
        if(req.method==='DELETE'&&!conversation[2])return json(res,200,await agent.deleteConversation(conversation[1]));
        if(req.method==='GET'&&!conversation[2])return json(res,200,store.getConversation(conversation[1]));
        if(req.method==='POST'&&!conversation[2]){const body=await readJson(req);return json(res,200,store.setConversationExecution(conversation[1],body.execution));}
        if(req.method==='POST'&&conversation[2]) {const body=await readJson(req),images=await validateChatImages(body.attachments);return json(res,202,agent.enqueue(conversation[1],body.text,images));}
      }
      if(req.method==='POST'&&path==='/admin/api/operations') {
        const body=await readJson(req);if(!managementTools.some(tool=>tool.name===body.action))throw new HttpError(400,'UNKNOWN_OPERATION','未知管理操作。');
        const id=store.beginAction(null,body.action,body.args ?? {});
        try {const value=await operations.execute(body.action,body.args ?? {});store.finishAction(id,value);return json(res,200,value);}
        catch(error){store.finishAction(id,null,error);throw error;}
      }
      const task=path.match(/^\/admin\/api\/tasks\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&task)return json(res,200,await operations.execute('task',{task_id:task[1]}));
      const artifact=path.match(/^\/admin\/api\/artifacts\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&artifact) {
        const response=await operations.artifact(artifact[1],artifact[2]);
        res.writeHead(response.status,{'content-type':response.headers.get('content-type') ?? 'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
      const lists={'/admin/api/tasks':'tasks','/admin/api/plugins':'plugins','/admin/api/capabilities':'capabilities','/admin/api/resources':'capabilities','/admin/api/schedules':'schedules'};
      if(req.method==='GET'&&lists[path]) {
        const args=path==='/admin/api/tasks'?Object.fromEntries([...url.searchParams].filter(([key])=>['status','type','search','limit','offset','after','before'].includes(key)).map(([key,value])=>[key,['limit','offset','after','before'].includes(key)?Number(value):value])):{};
        return json(res,200,await operations.execute(lists[path],args));
      }
      throw new HttpError(404,'NOT_FOUND','找不到接口。');
    }catch(error){if(!res.headersSent)errorResponse(res,error);else res.destroy();}
  });
  server.closeEventStreams=()=>{eventsClosed=true;for(const close of streams)close();streams.clear();};
  return server;
}
