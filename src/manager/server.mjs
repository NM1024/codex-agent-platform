import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readJson,json,errorResponse } from '../http.mjs';
import { HttpError } from '../errors.mjs';
import {renderSystemPrompt} from '../prompts.mjs';
import { managementTools } from '../contracts/management.mjs';

const assets=new Map([['/admin/',['index.html','text/html; charset=utf-8']],['/admin/app.js',['app.js','text/javascript; charset=utf-8']],['/admin/i18n.js',['i18n.js','text/javascript; charset=utf-8']],['/admin/style.css',['style.css','text/css; charset=utf-8']],['/admin/favicon.svg',['favicon.svg','image/svg+xml']]]);
export function createManagerServer({store,agent,operations,auth,metrics}) {
  return createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://local'),path=url.pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{alive:true});
      if(req.method==='GET'&&path==='/admin'){res.writeHead(308,{location:'/admin/'});return res.end();}
      if(req.method==='GET'&&assets.has(path)) {
        const [file,type]=assets.get(path),data=await readFile(new URL(`./web/${file}`,import.meta.url));
        res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'});return res.end(data);
      }
      if(!path.startsWith('/admin/api/'))throw new HttpError(404,'NOT_FOUND','找不到接口。');
      if(req.method==='POST'&&req.headers.origin) {
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
      if(req.method==='POST'&&path==='/admin/api/password'){const body=await readJson(req);await auth.setPassword(body.password);res.setHeader('set-cookie',auth.cookie('',req));return json(res,200,{updated:true,sessions_revoked:true});}
      if(req.method==='GET'&&path==='/admin/api/overview') {
        let platform;try{platform=await operations.execute('overview',{});}catch(error){platform={unavailable:true,error:{code:error.code ?? 'GATEWAY_UNAVAILABLE',message:error.message}};}
        return json(res,200,{sampled_at:Date.now(),manager:{alive:true},platform,resources:platform.resources ?? await metrics.sample(),investigations:store.investigations()});
      }
      if(path==='/admin/api/conversations') {
        if(req.method==='GET')return json(res,200,store.list());
        if(req.method==='POST') {
          const body=await readJson(req);
          if(body.task_id!==undefined&&!/^[a-f0-9-]{36}$/.test(body.task_id))throw new HttpError(400,'INVALID_INPUT','任务编号不正确。');
          const conversation=store.createConversation(body.title,body.task_id?'task:'+body.task_id:null);
          if(body.investigate===true&&body.task_id&&!conversation.messages.length)
            agent.enqueue(conversation.id,renderSystemPrompt('task-investigation',{task_id:body.task_id}));
          return json(res,201,store.getConversation(conversation.id));
        }
      }
      const conversation=path.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})(\/messages)?$/);
      if(conversation) {
        if(req.method==='GET'&&!conversation[2])return json(res,200,store.getConversation(conversation[1]));
        if(req.method==='POST'&&conversation[2]) {const body=await readJson(req);return json(res,202,agent.enqueue(conversation[1],body.text));}
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
}
