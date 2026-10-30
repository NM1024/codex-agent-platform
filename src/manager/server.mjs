import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import { readJson,json,errorResponse } from '../http.mjs';
import { HttpError } from '../errors.mjs';
import {renderSystemPrompt} from '../prompts.mjs';
import { managementTools } from '../contracts/management.mjs';
import {staticEncoding} from './static-encoding.mjs';
import {validateChatImages} from './chat-images.mjs';
import {streamConversation} from './events.mjs';
import {buildPluginIntegration} from './plugin-integration.mjs';
import {createVersionService,createUpgradeClient} from './version.mjs';

const webRoot=new URL('./web-dist/index.html',import.meta.url);
const assetPath=/^\/admin\/(favicon\.svg|third-party-notices\.md|assets\/[a-zA-Z0-9_-]+\.(?:js|css))$/;
const entityTag=bytes=>'"'+createHash('sha256').update(bytes).digest('base64url')+'"';
const matchesTag=(header,etag)=>(header??'').split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag);
export function createManagerServer({store,agent,operations,auth,metrics,versionService=createVersionService(),upgradeClient=createUpgradeClient()}) {
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
        const etag=index?null:entityTag(data);
        const headers={'content-type':type,...(etag?{'etag':etag}:{}),...(hashed?{'vary':'Accept-Encoding'}:{}),...(encoding!=='identity'?{'content-encoding':encoding}:{}),'cache-control':index?'no-store':hashed?'public, max-age=31536000, immutable':'no-cache','x-content-type-options':'nosniff','content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,'referrer-policy':'no-referrer'};
        if(etag&&matchesTag(req.headers['if-none-match'],etag)){res.writeHead(304,headers);return res.end();}
        res.writeHead(200,{...headers,'content-length':data.length});return res.end(req.method==='HEAD'?undefined:data);
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
      if(req.method==='GET'&&path==='/admin/api/version')return json(res,200,{current:versionService.current});
      if(req.method==='GET'&&path==='/admin/api/version/latest')return json(res,200,await versionService.latest());
      if(req.method==='GET'&&path==='/admin/api/upgrade')return json(res,200,await upgradeClient.status());
      if(req.method==='POST'&&path==='/admin/api/upgrade') {
        const body=await readJson(req,1024);
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length||url.search)throw new HttpError(400,'INVALID_INPUT','升级操作仅接受空对象。');
        const status=await upgradeClient.start();
        return json(res,status.available&&status.job?202:503,status);
      }
      if(req.method==='GET'&&path==='/admin/api/session')return json(res,200,{authenticated:true});
      if(req.method==='POST'&&path==='/admin/api/logout'){auth.logout(req);res.setHeader('set-cookie',auth.cookie('',req));return json(res,200,{logged_out:true});}
      if(req.method==='POST'&&path==='/admin/api/password'){const body=await readJson(req);await auth.changePassword(body.currentPassword,body.password);res.setHeader('set-cookie',auth.cookie('',req));return json(res,200,{updated:true,sessions_revoked:true});}
      const questionAnswer=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/questions\/([a-f0-9-]{36})\/answer$/);
      if(req.method==='POST'&&questionAnswer){const body=await readJson(req);return json(res,200,agent.answerQuestion(questionAnswer[1],questionAnswer[2],body.answers));}
      const queuedMessage=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})(?:\/(withdraw|requeue|steer))?$/);
      if(queuedMessage) {
        const [,conversationId,messageId,action]=queuedMessage;
        if(req.method==='DELETE'&&!action)return json(res,200,store.removeQueued(conversationId,messageId));
        if(req.method==='POST'&&action==='withdraw')return json(res,200,store.withdrawQueued(conversationId,messageId));
        if(req.method==='POST'&&action==='requeue'){const body=await readJson(req);return json(res,200,agent.requeue(conversationId,messageId,body.text));}
        if(req.method==='POST'&&action==='steer')return json(res,200,await agent.steerQueued(conversationId,messageId));
      }
      const events=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/events$/);
      if(req.method==='GET'&&events){if(eventsClosed)throw new HttpError(503,'SERVER_SHUTTING_DOWN','服务正在重启，请稍后重连。');const close=streamConversation({req,res,store,auth,id:events[1],onClose:closed=>streams.delete(closed)});if(!res.writableEnded)streams.add(close);return;}
      const chatImage=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/images\/([a-f0-9-]{36})$/);
      if(['GET','HEAD'].includes(req.method)&&chatImage) {
        const image=store.getImage(chatImage[1],chatImage[2]);
        const etag=entityTag(image.bytes);
        const headers={'content-type':image.mime,'cache-control':'private, no-cache','etag':etag,'vary':'Cookie','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",'referrer-policy':'no-referrer'};
        // Revalidate only after authentication and ownership/deletion checks.
        if(matchesTag(req.headers['if-none-match'],etag)){
          res.writeHead(304,headers);return res.end();
        }
        res.writeHead(200,{...headers,'content-length':image.size});
        return res.end(req.method==='HEAD'?undefined:Buffer.from(image.bytes));
      }
      if(path==='/admin/api/notification-channels'&&['GET','POST'].includes(req.method))return json(res,200,await operations.notificationChannels(req.method==='GET'?'list':'save',req.method==='GET'?{}:await readJson(req)));
      const notificationChannel=path.match(/^\/admin\/api\/notification-channels\/([a-f0-9-]{36})(?:\/(enable|test))?$/);
      if(notificationChannel&&['POST','DELETE'].includes(req.method)){
        const [,id,action]=notificationChannel;if(req.method==='POST'&&!action)throw new HttpError(404,'NOT_FOUND');
        return json(res,200,await operations.notificationChannels(req.method==='DELETE'?'delete':action,{...(await readJson(req)),id}));
      }
      const notificationBinding=path.match(/^\/admin\/api\/(tasks|schedules|inspections)\/([a-f0-9-]{36})\/notifications$/);
      if(notificationBinding&&['GET','POST'].includes(req.method)){
        const [,kind,id]=notificationBinding,name=kind==='tasks'?'task':kind==='schedules'?'schedule':'inspection',identity=kind==='tasks'?{task_id:id}:{id};
        if(req.method==='GET')return json(res,200,await operations.execute(name+'_notifications_get',{...identity,...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),...(url.searchParams.has('before')?{before:url.searchParams.get('before')}:{})}));
        const body=await readJson(req);if(!body||Object.keys(body).some(key=>!['notification_channels','revision'].includes(key)))throw new HttpError(400,'INVALID_NOTIFICATION_BINDING');
        return json(res,200,await operations.execute(name+'_notifications_update',{...identity,notification_channels:body.notification_channels,notification_revision:body.revision}));
      }
      const pluginConnection=path.match(/^\/admin\/api\/plugins\/([^/]+)\/connection$/);
      const pluginKeyClaim=path.match(/^\/admin\/api\/plugins\/([^/]+)\/connection\/entry-key\/claim$/);
      if(req.method==='POST'&&pluginKeyClaim)return json(res,200,await operations.claimPluginEntryKey(decodeURIComponent(pluginKeyClaim[1]),await readJson(req)));
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
        if(req.method==='GET')return json(res,200,store.listPage({...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),...(url.searchParams.has('before')?{before:url.searchParams.get('before')}:{})}));
        if(req.method==='POST') {
          const body=await readJson(req);
          store.validateExecution(body.execution ?? {});
          if(body.task_id!==undefined&&!/^[a-f0-9-]{36}$/.test(body.task_id))throw new HttpError(400,'INVALID_INPUT','任务编号不正确。');
          const conversation=store.createConversation(body.title,body.task_id?'task:'+body.task_id:null);
          if(body.execution)store.setConversationExecution(conversation.id,body.execution);
          if(body.investigate===true&&body.task_id&&!conversation.messages.length&&!conversation.queue?.length)
            agent.enqueue(conversation.id,renderSystemPrompt('task-investigation',{task_id:body.task_id}));
          return json(res,201,store.getConversationPage(conversation.id));
        }
      }
      const conversation=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})(\/messages)?$/);
      if(conversation) {
        if(req.method==='GET'&&conversation[2])return json(res,200,store.messageGroups(conversation[1],(url.searchParams.get('ids')??'').split(',')));
        if(req.method==='DELETE'&&!conversation[2])return json(res,200,await agent.deleteConversation(conversation[1]));
        if(req.method==='GET'&&!conversation[2])return json(res,200,store.getConversationPage(conversation[1],{...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),...(url.searchParams.has('before')?{before:url.searchParams.get('before')}:{})}));
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
