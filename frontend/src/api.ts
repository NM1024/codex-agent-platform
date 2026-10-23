export class ApiError extends Error {
  constructor(message:string,public status:number){super(message);}
}
export async function request<T>(path:string,body?:unknown):Promise<T> {
  const response=await fetch('/admin/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const value=await response.json();
  if(!response.ok)throw new ApiError(value.error?.message ?? value.error?.code ?? 'Request failed',response.status);
  return value as T;
}
