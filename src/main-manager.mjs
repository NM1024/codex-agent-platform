import {createUpgradeClient} from './manager/version.mjs';
import {observeSystemUpgrade} from './observability/system-report.mjs';
import {SystemJournal} from './observability/system-journal.mjs';
import {createManagerSystem,systemObserve} from './observability/system-maintenance.mjs';
import {ManagerSandbox} from './manager/sandbox.mjs';
import {SandboxHostClient} from './sandbox/client.mjs';
import { createServer } from 'node:http';
import { join,resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { safeDirectory } from './files.mjs';
import { ManagerStore } from './manager/store.mjs';
import { ManagementAgent } from './manager/agent.mjs';
import { OperationsClient } from './manager/client.mjs';
import { createManagementMcpHandler } from './manager/mcp.mjs';
import { createManagerServer } from './manager/server.mjs';
import { ResourceSampler } from './observability/resources.mjs';
import {createManagerConfiguration} from './manager/configuration.mjs';
import {createManagerOperations} from './manager/operations.mjs';
import {AdminAuth} from './manager/auth.mjs';
import {readFile} from 'node:fs/promises';
import {acceptPendingInspections} from './manager/inspections.mjs';
import {InspectionNotificationBridge} from './manager/inspection-notifications.mjs';
import {HistoryRetentionWorker,compactHistoryDatabase} from './history/worker.mjs';
import {createManagerHistoryBatch} from './manager/history-retention.mjs';

let startupJournal;
try {
  const env=process.env,config=loadConfig('gateway',{...env,PORT:env.MANAGER_PORT ?? '3007'});
  const root=resolve(env.MANAGER_DATA_DIR ?? '/management');await safeDirectory(root);
  const mcpPort=Number(env.MANAGER_MCP_PORT ?? 3008);
  if(!Number.isSafeInteger(mcpPort)||mcpPort<1||mcpPort>65535)throw new Error('Invalid configuration: MANAGER_MCP_PORT');
  const store=new ManagerStore(join(root,'manager.sqlite'));
  const journal=new SystemJournal({db:store.db,service:'manager'});startupJournal=journal;journal.event({module:'system',event:'startup',code:'WORK_RUNNING',details:{phase:'start'}});
  const auth=new AdminAuth(store.db);
  if(!auth.initialized)await auth.initialize((await readFile(join(root,'initial-password'),'utf8')).trim());
  const client=new OperationsClient({url:config.gatewayInternalUrl,token:config.runnerToken});
  const inspectionNotifications=new InspectionNotificationBridge({store,client,journal});
  let agent;
  const sandbox=new ManagerSandbox({store,root,journal,client:new SandboxHostClient(),wake:id=>agent?.kick(id)});
  store.attachMessageFiles=(...args)=>sandbox.attach(...args);store.messageFiles=id=>sandbox.filesForMessage(id);store.canSteerMessage=id=>!sandbox.isPermissionContinuation(id);
  store.onDeleteOwner=conversation=>{inspectionNotifications.queueCleanup(conversation);sandbox.queueCleanup(conversation);};
  store.onFinishInspection=event=>inspectionNotifications.queueLifecycle(event);
  const metrics=new ResourceSampler({procRoot:env.HOST_PROC_PATH ?? '/host/proc',diskPath:root});
  agent=new ManagementAgent({store,root,journal,sandbox,authFile:join(env.CODEX_LOGIN_HOME ?? '/codex','auth.json'),mcpUrl:`http://127.0.0.1:${mcpPort}/mcp`,model:config.model,timeoutMs:config.taskTimeoutMs,toolTimeoutMs:config.toolTimeoutMs,inspectionLifecycle:event=>inspectionNotifications.lifecycle(event),inspectionCleanup:id=>inspectionNotifications.cleanup({conversationId:id})});
  const configuration=createManagerConfiguration({store,agent,auth});
  const operations=createManagerOperations({client,store,metrics,configuration,auth,sandbox});
  const mcp=createManagementMcpHandler({store,operations,authorize:token=>agent.authorize(token),executionContext:token=>agent.executionContext(token)});
  const upgradeClient=createUpgradeClient();
  const internal=createServer(mcp),api=createManagerServer({store,agent,operations,metrics,auth,sandbox,upgradeClient});
  await Promise.all([new Promise(r=>internal.listen(mcpPort,'127.0.0.1',r)),new Promise(r=>api.listen(config.port,'0.0.0.0',r))]);
  console.log(JSON.stringify({service:'manager',event:'listening',port:config.port}));
  try{await sandbox.recover();}catch{console.log(JSON.stringify({service:'manager',event:'sandbox_unavailable'}));}
  await agent.recover();let closing=false,inspectionTask;
  const retention=new HistoryRetentionWorker({db:store.db,journal,
    readPolicy:async()=>{const group=await client.execute('configuration_get',{scope:'retention'});return {...group.values,revision:group.revision};},
    runBatch:createManagerHistoryBatch({store,agent}),
    maintenance:async()=>{observeSystemUpgrade(journal,await upgradeClient.status());await agent.retryConversationCleanup({limit:50});await inspectionNotifications.retryLifecycle({limit:50});await inspectionNotifications.cleanup({limit:50});await sandbox.cleanup({limit:50});},
    compact:()=>compactHistoryDatabase(store.db,{idle:!agent.running.size&&store.isHistoryIdle()}),
    onSweep:state=>console.log(JSON.stringify({service:'manager',event:'history_retention_completed',deleted:state.deleted,failed:state.failed})),
  });
  const cleanHistory=()=>void retention.tick().catch(()=>console.error(JSON.stringify({service:'manager',event:'history_retention_retry_pending'})));
  const retentionTimer=setInterval(cleanHistory,60000);cleanHistory();
  const inspect=()=>{
    if(closing||inspectionTask)return;
    inspectionTask=acceptPendingInspections({client,store,agent,journal,closing:()=>closing}).catch(()=>{}).finally(()=>{inspectionTask=null;});
  };
  const system=createManagerSystem({journal,agent,sandbox,inspections:inspectionNotifications,retention,intake:({force=false}={})=>acceptPendingInspections({client,store,agent,journal,force,closing:()=>closing})});
  operations.system=system;agent.system=system;
  journal.event({module:'system',event:'listening',code:'SYSTEM_OK',details:{phase:'start'}});
  systemObserve(journal,{id:'manager-health',module:'health',state:'completed',code:'SERVICE_RECOVERED',allowed_actions:['health_check']});
  let lastInspection=Date.now();
  const inspectionTimer=setInterval(()=>{if(Date.now()-lastInspection>=agent.inspectionIntervalMs){lastInspection=Date.now();inspect();}},1000);inspect();
  async function stop(){
    if(closing)return;closing=true;journal.event({module:'system',event:'stopping',code:'WORK_IDLE',details:{phase:'stop'}});clearInterval(inspectionTimer);clearInterval(retentionTimer);await retention.stop();
    api.closeEventStreams();await agent.stop();await inspectionTask;await mcp.settle();
    await Promise.all([new Promise(r=>api.close(r)),new Promise(r=>internal.close(r))]);store.close();
  }
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
}catch(error){startupJournal?.event({module:'system',event:'startup_failed',code:'SERVICE_UNAVAILABLE',level:'error',details:{phase:'start'}});console.error(JSON.stringify({service:'manager',event:'startup_failed',reason:/^(Missing or invalid configuration:|Invalid configuration:|Configuration tokens)/.test(error.message)?error.message:'MANAGER_START_FAILED'}));process.exitCode=1;}
