import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema,CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { managementTools } from '../contracts/management.mjs';
import { readJson,json,errorResponse } from '../http.mjs';
import { HttpError } from '../errors.mjs';

export function createManagementMcpHandler({store,operations,authorize}) {
  const pending=new Set();
  const handler=async(req,res)=>{
    let server,transport;
    try {
      if(new URL(req.url,'http://local').pathname!=='/mcp')return json(res,404,{error:{code:'NOT_FOUND'}});
      const credentials=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='authorization')credentials.push(req.rawHeaders[i+1]);
      const conversationId=credentials.length===1&&credentials[0].startsWith('Bearer ')?authorize(credentials[0].slice(7)):null;
      if(!conversationId)throw new HttpError(401,'UNAUTHORIZED','认证失败');
      if(req.headers.origin)throw new HttpError(403,'ORIGIN_DENIED','管理 MCP 不接受浏览器来源。');
      if(req.method!=='POST')return json(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});
      const body=await readJson(req);
      server=new Server({name:'platform-management',version:'1.0.0'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:managementTools}));
      server.setRequestHandler(CallToolRequestSchema,async request=>{
        const name=request.params.name,args=request.params.arguments ?? {};
        if(!managementTools.some(tool=>tool.name===name))return {isError:true,content:[{type:'text',text:'TOOL_NOT_ALLOWED'}]};
        const id=store.beginAction(conversationId,name,args);
        const operation=(async()=>{
          try {
            const value=await operations.execute(name,args);store.finishAction(id,value);
            return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value&&typeof value==='object'&&!Array.isArray(value)?value:{result:value}};
          }catch(error){store.finishAction(id,null,error);return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:error.code ?? 'OPERATION_FAILED',message:error.message,operation_status:error.effectUnknown?'unknown':'failed',action:error.effectUnknown?'Inspect current records before deciding whether to retry.':'Correct the input or inspect service health.'}})}]};}
        })();pending.add(operation);try{return await operation;}finally{pending.delete(operation);}
      });
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      const close=()=>{void transport.close().catch(()=>{});void server.close().catch(()=>{});};res.once('finish',close);res.once('close',close);
      await server.connect(transport);await transport.handleRequest(req,res,body);
    }catch(error){if(!res.headersSent)errorResponse(res,error);else res.destroy();await transport?.close().catch(()=>{});await server?.close().catch(()=>{});}
  };
  handler.settle=()=>Promise.allSettled([...pending]);return handler;
}
