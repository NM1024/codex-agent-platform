import { HttpError } from '../errors.mjs';
export class OperationsClient {
  constructor({url,token}){Object.assign(this,{url,token});}
  async claimPluginEntryKey(type,body) {
    let response,value;
    try {
      response=await fetch(new URL('/internal/plugin-connections/'+encodeURIComponent(type)+'/entry-key/claim',this.url),{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
      value=await response.json();
    } catch {throw Object.assign(new HttpError(503,'GATEWAY_UNAVAILABLE','领取结果可能未知；请刷新接入状态，必要时由人更换入口密钥。'),{effectUnknown:true});}
    if(!response.ok)throw new HttpError(response.status,value.error?.code??'CONNECTION_UPDATE_FAILED',value.error?.message??'接入配置操作失败。');
    return value;
  }
  async pluginConnection(type,patch) {
    let response,body;
    try {
      response=await fetch(new URL('/internal/plugin-connections/'+encodeURIComponent(type),this.url),{method:patch===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,...(patch===undefined?{}:{'content-type':'application/json'})},...(patch===undefined?{}:{body:JSON.stringify(patch)}),redirect:'error',signal:AbortSignal.timeout(20000)});
      body=await response.json();
    }catch {throw Object.assign(new HttpError(503,'GATEWAY_UNAVAILABLE','无法连接 Gateway，请刷新核对配置状态。'),{effectUnknown:true});}
    if(!response.ok)throw new HttpError(response.status,body.error?.code??'CONNECTION_UPDATE_FAILED',body.error?.message??'接入配置操作失败。');
    return body;
  }
  async execute(action,args={}) {
    let response,body;
    try {response=await fetch(new URL('/internal/admin',this.url),{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify({action,args}),redirect:'error',signal:AbortSignal.timeout(20000)});body=await response.json();}
    catch {throw Object.assign(new HttpError(503,'GATEWAY_UNAVAILABLE','无法连接 Gateway，操作结果可能未知，请查询记录。'),{effectUnknown:true});}
    if(!response.ok)throw new HttpError(response.status,body.error?.code ?? 'OPERATION_FAILED',body.error?.message ?? '管理操作失败。');return body;
  }
  artifact(taskId,artifactId){return fetch(new URL(`/internal/artifacts/${taskId}/${artifactId}`,this.url),{headers:{authorization:`Bearer ${this.token}`},redirect:'error',signal:AbortSignal.timeout(20000)});}
}
