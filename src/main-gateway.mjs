import {SystemJournal} from './observability/system-journal.mjs';
import { dirname } from "node:path";
import { createApplication } from "./application.mjs";
import { safeDirectory } from "./files.mjs";
import { RequestStore } from "./core/store.mjs";
import { Dispatcher } from "./core/dispatcher.mjs";
import { RuntimeClient } from "./runtime/client.mjs";
import { createTaskApi, createPrivateApi } from "./api.mjs";
import { createDeliveryWorker } from "./delivery/worker.mjs";
import { OperationsService } from './operations/service.mjs';
import {HistoryRetentionWorker,compactHistoryDatabase} from './history/worker.mjs';
import {createTaskHistoryBatch} from './core/history-retention.mjs';

let startupJournal;
try {
  const { config, registry,configuration } = createApplication("gateway");
  await safeDirectory(dirname(config.dbPath));
  await safeDirectory(config.workspace);
  const store = new RequestStore(config.dbPath, {
    registry,
    queueLimit: config.queueLimit,
  });
  const journal=new SystemJournal({db:store.db,service:'gateway'});startupJournal=journal;store.journal=journal;
  journal.event({module:'system',event:'startup',code:'WORK_RUNNING',details:{phase:'start'}});
  const settings=configuration(store);
  for (const module of registry.modules.values()) await module.migrate?.(store);
  const runner = new RuntimeClient({
    url: config.runnerUrl,
    token: config.runnerToken,
    toolTimeoutMs: config.toolTimeoutMs,
  });
  store.context = {
    workspace: config.workspace,
    process: (body) => runner.process(body,store.executionSettings(body.run_id,body.generation)?.toolTimeoutMs),
  };
  const deliver = createDeliveryWorker({ store, config });
  const dispatcher = new Dispatcher({
    store,
    registry,
    runner,
    config,
    deliver,
    journal,
  });
  const api = createTaskApi({ store, registry, dispatcher, config, runner });
  const operations=new OperationsService({journal,store,registry,dispatcher,runner,config,configuration:settings,restartGateway:()=>void stop().then(()=>process.exit(0))});
  const retention=new HistoryRetentionWorker({db:store.db,journal,
    pruneRemote:args=>runner.pruneSystemHistory(args),
    readPolicy:()=>{const group=settings.get('retention');return {...group.values,revision:group.revision};},
    maintenance:()=>store.notifications?.pruneTestHistory({cutoff:Date.now()-7*24*60*60*1000,limit:50}),
    runBatch:createTaskHistoryBatch({store,runner,schedules:operations.schedules,activeDeliveries:deliver.active}),
    compact:()=>compactHistoryDatabase(store.db,{idle:store.isHistoryIdle()&&!deliver.active.size}),
    onSweep:state=>console.log(JSON.stringify({service:'gateway',event:'history_retention_completed',deleted:state.deleted,failed:state.failed})),
  });
  operations.retention=retention;dispatcher.syncConfiguration=()=>operations.syncConfiguration();
  const internal = createPrivateApi({
    store,
    registry,
    dispatcher,
    config,
    runner,
    operations,
  });
  await Promise.all([
    new Promise((r) => api.listen(config.port, "0.0.0.0", r)),
    new Promise((r) => internal.listen(config.mcpPort, "0.0.0.0", r)),
  ]);
  console.log(
    JSON.stringify({
      service: "gateway",
      event: "listening",
      port: config.port,
      mcpPort: config.mcpPort,
      paused: config.paused,
    }),
  );
  void dispatcher
    .start()
    .catch(() =>
      console.error(
        JSON.stringify({ service: "gateway", event: "reconciliation_failed" }),
      ),
    );
  journal.event({module:'system',event:'listening',code:'SYSTEM_OK',details:{phase:'start'}});
  let scheduling=false;
  const scheduleTimer=setInterval(()=>{
    if (scheduling) return;
    scheduling=true;
    void operations.schedules.tick().then(()=>dispatcher.drain()).catch(()=>{}).finally(()=>{scheduling=false;});
  },1000);
  let closing = false;
  const cleanHistory=()=>void retention.tick().catch(()=>console.error(JSON.stringify({service:'gateway',event:'history_retention_retry_pending'})));
  const retentionTimer=setInterval(cleanHistory,60000);cleanHistory();
  async function stop() {
    if (closing) return;
    closing = true;
    journal.event({module:'system',event:'stopping',code:'WORK_IDLE',details:{phase:'stop'}});
    clearInterval(scheduleTimer);
    clearInterval(retentionTimer);await retention.stop();
    await dispatcher.stop();
    await Promise.all([
      new Promise((r) => api.close(r)),
      new Promise((r) => internal.close(r)),
    ]);
    store.close();
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
} catch (error) {
  startupJournal?.event({module:'system',event:'startup_failed',code:'SERVICE_UNAVAILABLE',level:'error',details:{phase:'start'}});
  console.error(
    JSON.stringify({
      service: "gateway",
      event: "startup_failed",
      reason:
        /^(Missing or invalid configuration:|Invalid configuration:|Configuration tokens)/.test(
          error.message,
        )
          ? error.message
          : "STORAGE_OR_CONFIGURATION_FAILURE",
    }),
  );
  process.exitCode = 1;
}
