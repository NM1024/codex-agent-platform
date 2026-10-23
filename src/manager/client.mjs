import { HttpError } from '../errors.mjs';
export class OperationsClient {
  constructor({url,token,publicUrl,ingressToken}){Object.assign(this,{url,token,publicUrl,ingressToken});}
  async execute(action,args={}) {
    let response,body;
    try {response=await fetch(new URL('/internal/admin',this.url),{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify({action,args}),redirect:'error',signal:AbortSignal.timeout(20000)});body=await response.json();}
    catch {throw Object.assign(new HttpError(503,'GATEWAY_UNAVAILABLE','无法连接 Gateway，操作结果可能未知，请查询记录。'),{effectUnknown:true});}
    if(!response.ok)throw new HttpError(response.status,body.error?.code ?? 'OPERATION_FAILED',body.error?.message ?? '管理操作失败。');return body;
  }
  artifact(taskId,artifactId){return fetch(new URL(`/internal/artifacts/${taskId}/${artifactId}`,this.url),{headers:{authorization:`Bearer ${this.token}`},redirect:'error',signal:AbortSignal.timeout(20000)});}
}
