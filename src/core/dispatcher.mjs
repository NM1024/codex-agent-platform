import {runtimeSettings} from '../configuration/execution.mjs';
import {resolveAgentSettings} from '../configuration/agent-settings.mjs';
export class Dispatcher {
  constructor({store, registry, runner, config, deliver = async () => {}}) {
    Object.assign(this, {store, registry, runner, config, deliver});
    this.active = new Map();
    this.blocked = new Map();
    this.closed = false;
  }
  reserve(run) {
    if (this.active.has(run.run_id)) return;
    const generation = run.generation ?? 0;
    const timer = setTimeout(() => void this.event(run.run_id, 'TASK_TIMEOUT', {generation}),
      (run.execution?.taskTimeoutMs ?? this.config.taskTimeoutMs ?? 2400000) + 5000);
    this.active.set(run.run_id, {timer, generation});
  }
  release(id) {
    clearTimeout(this.active.get(id)?.timer);
    this.active.delete(id);
  }
  drain() {
    if (this.closed || this.reconciling) return Promise.resolve();
    if (this.syncing) return this.syncing.then(() => this.drain());
    this.again = true;
    if (this.draining) return this.draining;
    this.draining = this.loop().finally(() => {this.draining = null;});
    return this.draining;
  }
  async loop() {
    while (this.again && !this.closed) {
      this.again = false;
      if (this.config.paused || this.active.size >= (this.config.concurrency ?? 1)) return;
      const queued = this.store.queued();
      if (!queued.length) return;
      // Before issuing a continuation, adopt any process that survived a lost ack
      // or a Gateway restart. An unreachable inventory is never an empty one.
      if (queued.some(item => item.run_id)) {
        if (!await this.synchronize()) {this.schedule(); return;}
      }
      const state = await this.runner.ready().catch(() => ({ready:false, reason:'RUNNER_UNAVAILABLE'}));
      const launches = [];
      for (const item of this.store.queued()) {
        if (this.closed || this.config.paused || this.active.size >= (this.config.concurrency ?? 1)) break;
        const module = this.store.moduleFor(this.store.raw(item.task_id));
        const available = module.availability?.(state) ?? state;
        if (!available.ready) {this.blocked.set(item.task_id, available.reason ?? 'RUNTIME_NOT_READY'); continue;}
        this.blocked.delete(item.task_id);
        let run;
        try {run = this.store.claim(item.task_id);} catch (error) {
          this.blocked.set(item.task_id, error.code ?? 'MODULE_VERSION_UNAVAILABLE'); continue;
        }
        if (!run) continue;
        run.execution=resolveAgentSettings(runtimeSettings(this.config),run.definition?.execution);
        this.store.recordExecutionSettings(run.run_id,run.execution,run.generation);
        this.reserve(run);
        this.active.get(run.run_id).launching = true;
        launches.push((async () => {
          try {
            const ack = await this.runner.launch(run);
            if (ack?.status === 'running') this.store.started(run.run_id, ack);
            else if (ack?.status === 'completed' || ack?.status === 'ended') {
              await this.event(run.run_id, ack.completed || ack.status === 'completed' ? 'COMPLETED' : ack.code ?? 'RESULT_NOT_SUBMITTED', {...ack,generation:run.generation});
            } else {
              this.store.suspend(run.run_id, ack);
              this.release(run.run_id);
            }
          } catch (error) {
            // The original process may still exist. Keep its identity and resolve
            // infrastructure state before resuming; never launch a replacement task.
            if (error.code === 'CODEX_SESSION_UNAVAILABLE') {
              this.store.fail(run.run_id, 'CODEX_SESSION_UNAVAILABLE');
              await this.deliver(run.task_id);
            } else {
              this.store.suspend(run.run_id);
              this.blocked.set(run.task_id, error.code ?? 'RUNNER_UNAVAILABLE');
            }
            this.release(run.run_id);
          } finally {
            const slot = this.active.get(run.run_id);
            if (slot) slot.launching = false;
          }
        })());
      }
      await Promise.allSettled(launches);
    }
    this.schedule();
  }
  schedule() {
    if (!this.closed && this.store.queued().length && !this.retry)
      this.retry = setTimeout(() => {this.retry = null; void this.drain();}, 15000);
  }
  async synchronize() {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncRuntime().finally(() => {this.syncing = null;});
    return this.syncing;
  }
  async syncRuntime() {
    if (!this.runner.active) return false;
    let inventory;
    try {await this.runner.configure?.({concurrency:this.config.concurrency ?? 1,...runtimeSettings(this.config)});inventory = await this.runner.active();} catch {return false;}
    if (this.closed) return false;
    const live = new Set(inventory.runs ?? []);
    const details = new Map((inventory.details ?? []).map(run => [run.run_id, run]));
    const unfinished = this.store.unfinished();
    const owned = new Set(unfinished.map(run => run.run_id));
    for (const run of unfinished) {
      if (this.active.get(run.run_id)?.launching) continue;
      const observed = details.get(run.run_id);
      if (live.has(run.run_id) && (observed?.generation ?? 0) === run.generation) {
        if (!this.active.has(run.run_id)) {
          this.store.adopt(run.run_id, observed ?? {});
          this.reserve({...run,execution:observed?.execution});
        }
      } else {
        if (live.has(run.run_id)) {
          // Stop an older process without deleting its conversation, then load
          // it with the current task credential on the next scheduled launch.
          try { await this.runner.suspend(run.run_id); } catch { return false; }
        }
        this.store.suspend(run.run_id);
        this.release(run.run_id);
      }
    }
    // A durable terminal task wins over a leftover runtime, including the window
    // after complete_task committed but its receipt/close signal was lost.
    for (const id of live) {
      if (owned.has(id)) continue;
      const run = this.store.run(id);
      if (run?.status === 'completed') await this.runner.completed?.(id).catch(() => {});
      else await this.runner.cancel?.(id).catch(() => {});
    }
    return true;
  }
  async completed(runId) {
    const run = this.store.run(runId);
    if (run?.status !== 'completed') return;
    const slot = this.active.get(runId);
    if (slot) {
      clearTimeout(slot.timer);
      slot.timer = setTimeout(() => void this.event(runId, 'COMPLETED', {generation:run.generation}),35000);
    }
    await Promise.allSettled([this.runner.completed(runId),this.deliver(run.task_id)]);
  }
  async event(runId, code, details = {}) {
    const run = this.store.run(runId);
    if (!run || (details.generation ?? 0) !== run.generation) return;
    if (code === 'SUSPENDED' || code === 'CODEX_EXIT') {
      this.store.suspend(runId, details);
      this.release(runId);
      if (!this.closed) this.schedule();
      return;
    }
    this.store.recordRun(runId, {status:'ended',ended_at:Date.now(),...details,code});
    this.store.fail(runId, code === 'COMPLETED' ? 'RESULT_NOT_SUBMITTED' : code);
    this.release(runId);
    if (['TASK_TIMEOUT','INTERRUPTED','COMPLETED'].includes(code))
      await this.runner.cancel?.(runId).catch(() => {});
    await this.deliver(run.task_id);
    void this.drain();
  }
  async start() {
    this.reconciling = true;
    await this.synchronize();
    await this.deliver();
    this.reconciling = false;
    this.monitor = setInterval(() => {
      if (this.draining || this.syncing) return;
      void this.synchronize().then(() => this.drain()).catch(() => {});
    },15000);
    this.monitor.unref();
    await this.drain();
  }
  async stop() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.monitor);
    await this.draining;
    await this.syncing;
    for (const id of this.active.keys()) this.release(id);
    // Runner owns the process. Gateway shutdown neither fails nor cancels it.
  }
}
