import {renderSystemPrompt} from '../prompts.mjs';
import { DEFAULT_TOOL_TIMEOUT_MS, DEFAULT_CONCURRENCY } from "../config.mjs";
import { join, resolve, parse } from "node:path";
import { readFile, symlink, lstat, rm, readdir } from "node:fs/promises";
import { runtimeConfig } from "../codex/config.mjs";
import { safeDirectory, atomicJson, containedPath, readRegular } from "../files.mjs";
import { CodexRpcClient, filteredCodexEnv } from "../codex/rpc.mjs";
import { initialize } from "../codex/session.mjs";
import { digest } from "../core/registry.mjs";
import { safeDiagnostic } from '../codex/diagnostics.mjs';
import {runtimeSettings} from '../configuration/execution.mjs';
import {validateModelEffort} from '../codex/models.mjs';

// Only request identity participates in replay protection. Module code, task
// prompts and configuration may change after a request was accepted.
const runSignature = ({run_id, task_id, type, input}) => digest({run_id, task_id, type, input});

const validId = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const lifecycleKeys = [
  "run_id", "task_id", "status", "thread_id", "turn_id", "created_at",
  "started_at", "updated_at", "ended_at", "completed", "code",
  "metadata_persisted", "metadata_error", "generation",
  "error_source", "error_message", "last_agent_message",
  "execution",
];
export function lifecycleDetails(record) {
  return Object.fromEntries(lifecycleKeys.filter((key) => record[key] !== undefined)
    .map((key) => [key, record[key]]));
}

export class AgentRuntime {
  constructor({
    workspace,
    codexHome = "/codex",
    mcpUrl = "http://gateway:3006/mcp",
    model = "gpt-6.1-sol",
    taskTimeoutMs = 2400000,
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    closingTimeoutMs = 30000,
    concurrency = DEFAULT_CONCURRENCY,
    createClient = (options) => new CodexRpcClient(options),
    onExit = () => {},
    onDiagnostic = () => {},
  } = {}) {
    Object.assign(this, {
      workspace,
      codexHome,
      mcpUrl,
      model,
      taskTimeoutMs,
      toolTimeoutMs,
      closingTimeoutMs,
      concurrency,
      createClient,
      onExit,
      onDiagnostic,
    });
    this.active = new Map();
    this.launches = new Map();
    this.purges = new Map();
    this.cancelled = new Set();
    this.closed = false;
  }
  launch(run, { beforeStart, scope } = {}) {
    if (this.recovering) return Promise.reject(new Error("RUNNER_RECOVERING"));
    if (this.closed) return Promise.reject(new Error("RUNNER_STOPPING"));
    if (!validId(run.run_id) || !validId(run.task_id))
      return Promise.reject(new Error("INVALID_RUN"));
    if (this.purges.has(run.run_id)) return Promise.reject(new Error("RUN_CONFLICT"));
    const signature = runSignature(run);
    run = { ...run, generation: run.generation ?? 0,execution:{...runtimeSettings(this),...run.execution} };
    if (this.launches.has(run.run_id)) {
      const pending = this.launches.get(run.run_id);
      if (pending.signature !== signature || pending.generation !== run.generation)
        return Promise.reject(new Error("RUN_CONFLICT"));
      return pending;
    }
    if (
      !this.active.has(run.run_id) &&
      new Set([...this.active.keys(), ...this.launches.keys()]).size >=
        this.concurrency
    )
      return Promise.reject(new Error("RUNNER_BUSY"));
    // Reserve synchronously, including while readiness or filesystem setup waits.
    const pending = Promise.resolve().then(async () => {
      await beforeStart?.();
      if (this.closed) throw new Error("RUNNER_STOPPING");
      return this.start(run, { scope });
    }).finally(() => {
      this.launches.delete(run.run_id);
      this.cancelled.delete(run.run_id);
    });
    pending.signature = signature;
    pending.generation = run.generation;
    pending.execution = run.execution;
    this.launches.set(run.run_id, pending);
    return pending;
  }
  purgeHistory(identity) {
    if (this.recovering) return Promise.reject(new Error("RUNNER_RECOVERING"));
    if (this.closed) return Promise.reject(new Error("RUNNER_STOPPING"));
    if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
        Object.keys(identity).length !== 2 || !Object.hasOwn(identity, "run_id") ||
        !Object.hasOwn(identity, "task_id") || !validId(identity.run_id) || !validId(identity.task_id))
      return Promise.reject(new Error("INVALID_RUN"));
    const {run_id, task_id} = identity;
    if (this.active.has(run_id) || this.launches.has(run_id))
      return Promise.reject(new Error("RUN_CONFLICT"));
    const existing = this.purges.get(run_id);
    if (existing) return existing.task_id === task_id ? existing : Promise.reject(new Error("RUN_CONFLICT"));
    // Reserve before any I/O, so neither launch nor recovery can race cleanup.
    const pending = Promise.resolve().then(async () => {
      const paths = [
        [this.workspace, join(this.workspace, ".agent-runs", run_id)],
        [this.workspace, join(this.workspace, "artifacts", run_id)],
        [this.codexHome, join(this.codexHome, "runs", run_id)],
      ];
      // Preflight every target before deleting anything. Inspect the configured
      // roots' ancestors too: a real directory can have a symlinked parent.
      for (const [base, target] of paths) {
        await containedPath(parse(resolve(base)).root, base, {allowMissing: true});
        try { await containedPath(base, target, {allowMissing: true}); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      try {
        const markerPath = join(paths[0][1], "launch.json");
        const markerStat = await lstat(markerPath);
        // Reject special files before open: opening a FIFO for reading could
        // otherwise hold cleanup and Runner shutdown indefinitely.
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024 * 1024)
          throw new Error("INVALID_FILE");
        const marker = JSON.parse(await readRegular(this.workspace, markerPath, 1024 * 1024));
        if (marker?.run_id !== run_id || marker?.task_id !== task_id) throw new Error("RUN_CONFLICT");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      // Gateway owns the terminal/expiry decision. A stale crash marker need
      // only agree on identity. Recursive rm unlinks child symlinks themselves.
      for (const [, target] of paths) await rm(target, {recursive: true, force: true});
    }).finally(() => { this.purges.delete(run_id); });
    pending.task_id = task_id;
    this.purges.set(run_id, pending);
    return pending;
  }
  async start(run, { scope } = {}) {
    const { token } = run;
    const signature = runSignature(run);
    const owned = join(this.workspace, ".agent-runs", run.run_id);
    await safeDirectory(owned);
    const marker = join(owned, "launch.json");
    let old;
    try {
      old = JSON.parse(await readFile(marker, "utf8"));
      if (old.signature !== signature) throw new Error("RUN_CONFLICT");
      const active = this.active.get(run.run_id);
      if (active && (active.run.generation ?? 0) !== run.generation) throw new Error("RUN_CONFLICT");
      if (active || old.completed || old.status === "ended" || !run.resume || run.generation <= (old.generation ?? 0)) {
        return { ...lifecycleDetails(old), status: active ? "running" : old.completed ? "completed" : old.status === "ended" ? "ended" : "suspended" };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const createdAt = new Date().toISOString();
    const record = {
      run_id: run.run_id,
      task_id: run.task_id,
      signature,
      status: "intent",
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      ended_at: null,
      thread_id: null,
      turn_id: null,
      completed: false,
      code: null,
      persistent: true,
      metadata_persisted: true,
      metadata_error: null,
      ...old,
      generation: run.generation,
      status: "intent",
      ended_at: null,
      code: null,
    };
    record.execution=run.execution;
    await atomicJson(marker, record);
    const workDir = join(owned, "work");
    const home = join(this.codexHome, "runs", run.run_id);
    await safeDirectory(workDir);
    await safeDirectory(home);
    const state = {
      run,
      owned,
      workDir,
      home,
      marker,
      signature,
      record,
      completed: false,
      ending: false,
    };
    this.active.set(run.run_id, state);
    if (this.closed || this.cancelled.has(run.run_id)) {
      await this.end(run.run_id, this.closed ? "SUSPENDED" : "INTERRUPTED");
      return this.acknowledge(state);
    }
    try {
      // Fresh config/plugin/home state per task; authentication remains in the
      // existing login volume, referenced without inspecting its contents.
      const authLink = join(home, "auth.json");
      try {
        await lstat(authLink);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await symlink(join(this.codexHome, "auth.json"), authLink);
      }
      const access = await scope?.({ run, workDir, home, owned }) ?? { readRoots: [workDir], referenceFiles: [] };
      const env = {
        ...filteredCodexEnv(),
        HOME: home,
        CODEX_HOME: home,
        AGENT_TASK_MCP_TOKEN: token,
        AGENT_TASK_WORK_DIR: workDir,
        AGENT_TASK_READ_ROOTS: JSON.stringify(access.readRoots ?? [workDir]),
        AGENT_TASK_REFERENCE_FILES: JSON.stringify(access.referenceFiles ?? []),
      };
      if (state.ending) return this.acknowledge(state);
      const client = this.createClient({ cwd: workDir, env });
      state.client = client;
      await initialize(client);
      const effort=await validateModelEffort(client,run.execution);
      if (state.ending) return this.acknowledge(state);
      const config = runtimeConfig(run.package, this.mcpUrl, { toolTimeoutMs: run.execution.toolTimeoutMs });
      const resuming = !!old?.thread_id;
      if (resuming && !old.persistent) throw new Error("CODEX_SESSION_UNAVAILABLE");
      let thread;
      try {
        thread = await client.request(resuming ? "thread/resume" : "thread/start", {
          ...(resuming ? { threadId: old.thread_id, excludeTurns: false } : { ephemeral: false }),
          model: run.execution.model,
          cwd: workDir,
          approvalPolicy: "never",
          sandbox: "read-only",
          config,
        });
      } catch (error) {
        if (resuming && error.code === "CODEX_RPC_ERROR") throw new Error("CODEX_RESUME_FAILED");
        throw error;
      }
      state.threadId = thread.thread.id;
      await this.save(state, { thread_id: state.threadId, started_at: new Date().toISOString() });
      if (state.ending) return this.acknowledge(state);
      state.unsubscribe = client.subscribe((message) => {
        const params = message.params ?? {};
        if (message.method === "transport/closed") {
          void this.end(run.run_id, "SUSPENDED");
          return;
        }
        if (params.threadId !== state.threadId) return;
        // Optional diagnostics observe only; they never steer or end the task.
        try { this.onDiagnostic(message); } catch {}
        if (message.method==='item/completed' && params.item?.type==='agentMessage')
          state.record.last_agent_message=safeDiagnostic(params.item.text,[token]);
        if (message.method==='turn/completed' && params.turn?.error?.message) {
          state.record.error_source='codex';
          state.record.error_message=safeDiagnostic(params.turn.error.message,[token]);
        }
        if (message.method === "turn/completed")
          void this.end(
            run.run_id,
            state.completed
              ? "COMPLETED"
              : params.turn?.status === "completed"
                ? "RESULT_NOT_SUBMITTED"
                : "CODEX_TURN_FAILED",
          );
      });
      state.timer = setTimeout(
        () => void this.end(run.run_id, "TASK_TIMEOUT"),
        run.execution.taskTimeoutMs,
      );
      const hasInitialTurn = resuming && (old.turn_id || thread.thread.turns?.length);
      const input = hasInitialTurn ? [{ type: "text", text:
        renderSystemPrompt('task-resume') }]
        : [{ type: "text", text: run.package.prompt }, ...(run.package.inputAttachments ?? [])];
      const turn = await client.request("turn/start", {
        threadId: state.threadId,
        input,
        model:run.execution.model,
        effort,
      });
      state.turnId = turn.turn.id;
      await this.save(state, {
        turn_id: state.turnId,
        ...(!state.ending && !state.completed ? { status: "started" } : {}),
      });
      return this.acknowledge(state);
    } catch (error) {
      if(error.code==='UNSUPPORTED_REASONING_EFFORT'||error.code==='MODEL_UNAVAILABLE'){
        state.record.error_source='configuration';state.record.error_message=error.message;
      }
      await this.end(run.run_id, ["CODEX_EXIT", "CODEX_TIMEOUT", "CODEX_RESUME_FAILED"].includes(error.message) ? "SUSPENDED" : error.message === "CODEX_SESSION_UNAVAILABLE" ? "CODEX_SESSION_UNAVAILABLE" : "CODEX_START_FAILED");
      throw error;
    }
  }
  async acknowledge(state) {
    if (state.ending) await state.endPromise;
    return { ...lifecycleDetails(state.record), status: state.completed ? "completed" : state.ending ? state.record.status : "running" };
  }
  save(state, patch) {
    state.record = {
      ...state.record, ...patch,
      updated_at: patch.ended_at ?? new Date().toISOString(),
      metadata_persisted: true, metadata_error: null,
    };
    const snapshot = { ...state.record };
    state.metadataWrites = (state.metadataWrites ?? Promise.resolve())
      .catch(() => {}) // A temporary failure must not poison all later writes.
      .then(async () => {
        try {
          await atomicJson(state.marker, snapshot);
          state.record.metadata_persisted = true;
          state.record.metadata_error = null;
        } catch {
          state.record.metadata_persisted = false;
          state.record.metadata_error = "RUNTIME_METADATA_WRITE_FAILED";
          throw new Error("RUNTIME_METADATA_WRITE_FAILED");
        }
      });
    return state.metadataWrites;
  }
  completed(runId) {
    const state = this.active.get(runId);
    if (!state || state.completed) return state?.metadataWrites;
    state.completed = true;
    const saved = this.save(state, { completed: true, status: "closing" });
    clearTimeout(state.timer);
    if (!state.ending) state.timer = setTimeout(
      () => void this.end(runId, "COMPLETED"),
      this.closingTimeoutMs,
    );
    return saved;
  }
  async end(runId, code) {
    const state = this.active.get(runId);
    if (!state) {
      if (this.launches.has(runId)) this.cancelled.add(runId);
      return;
    }
    if (state.ending) return state.endPromise;
    state.ending = true;
    state.endPromise = this.closeRun(state, code);
    return state.endPromise;
  }
  async closeRun(state, code) {
    const runId = state.run.run_id;
    clearTimeout(state.timer);
    state.unsubscribe?.();
    // Do not turn a successful durable commit into failure during cleanup.
    if (state.completed) code = "COMPLETED";
    try {
      if (state.threadId && state.turnId && code !== "RESULT_NOT_SUBMITTED")
        await state.client
          .request(
            "turn/interrupt",
            { threadId: state.threadId, turnId: state.turnId },
            1000,
          )
          .catch(() => {});
    } finally {
      await state.client?.close().catch(() => {});
      await Promise.allSettled([...(state.processors ?? [])]);
      if (code !== "SUSPENDED" || state.completed) {
        await rm(state.home, { recursive: true, force: true }).catch(() => {});
        await rm(state.workDir, { recursive: true, force: true }).catch(() => {});
      }
      if (state.completed) code = "COMPLETED";
      try {
        await this.save(state, {
          status: code === "SUSPENDED" ? "suspended" : "ended",
          code,
          completed: state.completed,
          ended_at: code === "SUSPENDED" ? null : new Date().toISOString(),
        });
      } catch {
        // The lifecycle event carries a fixed persistence flag, never raw I/O
        // errors. Metadata failure cannot hold the root slot or undo a result.
      } finally {
        this.active.delete(runId);
        await Promise.resolve().then(() => this.onExit(runId, code, lifecycleDetails(state.record))).catch(() => {});
      }
    }
  }
  async recover() {
    if (this.active.size || this.launches.size || this.purges.size)
      throw new Error("RUNNER_ACTIVE");
    this.recovering = true;
    try {
      const root = join(this.workspace, ".agent-runs");
      await safeDirectory(root);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validId(entry.name)) continue;
        const marker = join(root, entry.name, "launch.json");
        let saved;
        try {
          saved = JSON.parse(await readFile(marker, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (saved.status === "ended") continue;
        const endedAt = new Date().toISOString();
        const code = saved.completed ? "COMPLETED" : "SUSPENDED";
        const recovered = {
          ...saved,
          status: saved.completed ? "ended" : "suspended",
          code,
          ended_at: saved.completed ? endedAt : null,
          updated_at: endedAt,
        };
        await atomicJson(marker, recovered);
        await this.onExit(saved.run_id, code, lifecycleDetails(recovered));
        if (saved.completed) await rm(join(this.codexHome, "runs", saved.run_id), { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      this.recovering = false;
    }
  }
  async stop() {
    this.closed = true;
    await Promise.allSettled([
      ...[...this.active.keys()].map(id => this.end(id, "SUSPENDED")),
      ...this.launches.values(),
      ...this.purges.values(),
    ]);
  }
}
