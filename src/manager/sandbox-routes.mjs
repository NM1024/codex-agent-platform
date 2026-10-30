import {HttpError} from '../errors.mjs';
import {readJson,json} from '../http.mjs';

const unavailable=()=>{throw new HttpError(503,'SANDBOX_UNAVAILABLE','代码沙箱暂不可用。');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
async function uploadedBytes(req) {
  const limit=20*1024*1024;
  if(!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type']??''))throw new HttpError(415,'UNSUPPORTED_MEDIA_TYPE','文件上传须使用二进制内容。');
  if(Number(req.headers['content-length'])>limit)throw new HttpError(413,'FILE_TOO_LARGE','文件不能超过 20 MiB。');
  let size=0;const chunks=[];
  for await(const part of req){size+=part.length;if(size>limit)throw new HttpError(413,'FILE_TOO_LARGE','文件不能超过 20 MiB。');chunks.push(part);}
  return Buffer.concat(chunks,size);
}

// Called only inside the existing authenticated, same-origin Admin boundary.
export async function handleSandboxRoute({req,res,url,store,sandbox}) {
  const route=url.pathname.match(/^\/admin\/api\/conversations\/([a-f0-9-]{36})\/(files|sandbox)(?:\/(.*))?$/);
  if(!route)return false;
  const [,conversationId,kind,tail]=route;store.metadata(conversationId);
  if(kind==='files'&&!tail&&req.method==='POST'){
    if(!sandbox)unavailable();
    let name;try{if(typeof req.headers['x-file-name']!=='string'||req.headers['x-file-name'].length>2048)throw new Error();name=decodeURIComponent(req.headers['x-file-name']);}catch{throw new HttpError(400,'INVALID_FILE_NAME','文件名无效。');}
    const mime=typeof req.headers['x-file-mime']==='string'?req.headers['x-file-mime']:'';
    json(res,201,await sandbox.upload(conversationId,{name,mime,bytes:await uploadedBytes(req)}));return true;
  }
  if(kind==='files'&&/^[a-f0-9-]{36}$/.test(tail??'')&&['GET','HEAD'].includes(req.method)){
    if(!sandbox)unavailable();
    const {metadata,bytes}=await sandbox.readFile(conversationId,tail);
    const image=['image/png','image/jpeg','image/webp'].includes(metadata.mime),text=/^(text\/(plain|csv|markdown)|application\/json)(?:;|$)/i.test(metadata.mime);
    const inline=url.searchParams.get('preview')==='1'&&(image||text);
    const mime=inline?(image?metadata.mime:'text/plain; charset=utf-8'):'application/octet-stream';
    const name=metadata.name.replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,120)||'download';
    res.writeHead(200,{'content-type':mime,'content-length':bytes.length,'content-disposition':`${inline?'inline':'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16))}`,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'});
    res.end(req.method==='HEAD'?undefined:bytes);return true;
  }
  if(kind==='sandbox'&&!tail&&req.method==='GET'){
    json(res,200,sandbox?await sandbox.context(conversationId):{available:false,exists:false,reason:'SANDBOX_UNAVAILABLE',files:[],permissions:[],executions:[]});return true;
  }
  if(kind==='sandbox'&&req.method==='POST'){
    if(!sandbox)unavailable();
    const permission=tail?.match(/^permissions\/([a-f0-9-]{36})$/);
    if(permission){const body=await readJson(req,2048);if(!object(body)||Object.keys(body).length!==1||!['allow','deny','revoke'].includes(body.decision))throw new HttpError(400,'INVALID_SANDBOX_DECISION','授权操作无效。');json(res,200,await sandbox.decide(conversationId,permission[1],body.decision));return true;}
    const job=tail?.match(/^jobs\/([a-f0-9-]{36})\/cancel$/);
    if(job){const body=await readJson(req,1024);if(!object(body)||Object.keys(body).length)throw new HttpError(400,'INVALID_SANDBOX_CANCEL','取消操作仅接受空对象。');json(res,200,await sandbox.cancel(conversationId,job[1]));return true;}
  }
  throw new HttpError(404,'NOT_FOUND','找不到接口。');
}
