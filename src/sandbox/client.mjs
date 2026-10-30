import {request} from 'node:http';
import {HttpError} from '../errors.mjs';

const CONTROL=512*1024,BINARY=30*1024*1024;
const unavailable=()=>new HttpError(503,'SANDBOX_UNAVAILABLE','The local code sandbox is unavailable.');
const uncertain=()=>new HttpError(503,'SANDBOX_EFFECT_UNKNOWN','The sandbox response was lost. The operation may have taken effect; do not repeat it with a new request key.');

export class SandboxHostClient {
  constructor({socketPath='/run/platform-sandbox/sandbox.sock',timeoutMs=10000}={}){
    this.socketPath=socketPath;this.timeoutMs=timeoutMs;
  }
  async call(action,conversationId,args={}){
    const binary=action==='export'||(action==='files'&&args.action==='import');
    const requestLimit=binary?BINARY:CONTROL,responseLimit=binary?BINARY:1024*1024;
    const body=Buffer.from(JSON.stringify({action,...(conversationId?{conversation_id:conversationId}:{}),args}));
    if(body.length>requestLimit)throw new HttpError(413,'SANDBOX_REQUEST_TOO_LARGE','Sandbox request exceeds its byte limit.');
    const mutation=['exec','destroy'].includes(action)||(action==='process'&&args.action==='cancel')||(action==='files'&&['ensure','import','write','delete'].includes(args.action));
    return new Promise((resolve,reject)=>{
      let sent=false,settled=false,timer;
      const finish=(error,value)=>{
        if(settled)return;
        settled=true;clearTimeout(timer);
        if(error)reject(error);else resolve(value);
      };
      const lost=()=>sent&&mutation?uncertain():unavailable();
      const req=request({socketPath:this.socketPath,path:'/sandbox',method:'POST',headers:{'content-type':'application/json','content-length':body.length}},res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{
          size+=chunk.length;
          if(size>responseLimit){finish(lost());res.destroy();}else chunks.push(chunk);
        });
        res.on('error',()=>finish(lost()));
        res.on('end',()=>{
          if(settled)return;
          let value;
          try{
            value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
          }catch{finish(lost());return;}
          if(res.statusCode<200||res.statusCode>=300){
            const code=value.error?.code,status=res.statusCode>=500?503:res.statusCode;
            finish(new HttpError(status,typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'SANDBOX_UNAVAILABLE','The local sandbox rejected the operation.'));
            return;
          }
          finish(null,value);
        });
      });
      req.on('socket',socket=>{
        // A pooled Unix socket has already emitted connect. Any lost response
        // after assigning that live transport can have an unknown remote effect.
        if(req.reusedSocket||(!socket.connecting&&!socket.destroyed&&socket.readyState==='open'))sent=true;
        else socket.once('connect',()=>{sent=true;});
      });
      req.on('error',()=>finish(lost()));
      // A wall-clock deadline also bounds a peer that continuously drips bytes.
      timer=setTimeout(()=>{finish(lost());req.destroy();},this.timeoutMs);
      req.end(body);
    });
  }
  recover(){return this.call('recover');}
}
