import Ajv from 'ajv';
import {managementTools} from '../contracts/management.mjs';
import {bootstrapSettings} from '../configuration/bootstrap.mjs';
import {HttpError} from '../errors.mjs';
import {createModelCatalog} from '../codex/models.mjs';
import {filteredCodexEnv} from '../codex/rpc.mjs';
import {currentPlatformContext} from './project-context.mjs';
import {createProjectSourceReader} from './project-source.mjs';
const ajv=new Ajv({strict:true}),checks=new Map(managementTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
export function createManagerOperations({client,store,metrics,configuration,auth,models=createModelCatalog({env:{...filteredCodexEnv(),CODEX_HOME:process.env.CODEX_LOGIN_HOME ?? '/codex',HOME:process.env.CODEX_LOGIN_HOME ?? '/codex'}})}) {
  const projectSource=createProjectSourceReader();
  return {
    artifact:(...args)=>client.artifact(...args),
    // Browser-only transport: deliberately absent from execute/tool contracts.
    pluginConnection:(...args)=>client.pluginConnection(...args),
    claimPluginEntryKey:(...args)=>client.claimPluginEntryKey(...args),
    async execute(action,args={}) {
      const check=checks.get(action);
      if(!check||!check(args))throw new HttpError(400,'INVALID_MANAGEMENT_INPUT','管理操作或参数不正确。');
      if(action==='models')return models();
      if(action==='platform_context')return currentPlatformContext();
      if(action==='project_source')return projectSource(args);
      if(action==='admin_password_set'){if(!auth)throw new HttpError(503,'AUTH_UNAVAILABLE','密码服务不可用。');await auth.changePassword(args.currentPassword,args.password);return {updated:true,sessions_revoked:true};}
      if(action==='configuration_list') {
        let remote;try{remote=await client.execute(action,args);}catch{remote={groups:[],bootstrap:bootstrapSettings,gateway_unavailable:true};}
        return {...remote,groups:[...remote.groups,...configuration.list()]};
      }
      if(action==='configuration_get'&&configuration.scopes.has(args.scope))return configuration.get(args.scope);
      if(action==='configuration_update'&&configuration.scopes.has(args.scope))return {...configuration.update(args.scope,args.patch),synchronization:{manager:'applied'}};
      if(action!=='overview')return client.execute(action,args);
      let value;
      try{value=await client.execute(action,args);store.observe('last_platform',value);}
      catch(error){value={unavailable:true,error:{code:error.code ?? 'GATEWAY_UNAVAILABLE',message:error.message},last_known:store.observation('last_platform')};}
      return {...value,manager:{alive:true},resources:await metrics.sample(),investigations:store.investigations()};
    },
  };
}
