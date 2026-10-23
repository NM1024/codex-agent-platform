import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { removeTableUniqueness } from "./sqlite.mjs";
import { digest, fault } from "./registry.mjs";
import { PluginStore } from '../plugins/store.mjs';
import { PluginConnectionStore } from '../plugins/connections.mjs';
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const active = "'dispatching','running','completing','suspended'";

export class RequestStore {
  constructor(path, { registry, queueLimit = 10000 } = {}) {
    this.registry = registry;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON");
    this.queueLimit = queueLimit;
    removeTableUniqueness(this.db, "agent_requests", ["client_id", "request_id"]);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_requests(task_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,request_id TEXT NOT NULL,type TEXT NOT NULL,module_version TEXT NOT NULL,input TEXT NOT NULL,execution_input TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_runs(run_id TEXT PRIMARY KEY,task_id TEXT UNIQUE NOT NULL REFERENCES agent_requests,token_hash TEXT UNIQUE NOT NULL,receipt_until INTEGER NOT NULL DEFAULT 0,launch_status TEXT NOT NULL DEFAULT 'intent',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_operations(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,tool TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_results(task_id TEXT PRIMARY KEY REFERENCES agent_requests,result_digest TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_deliveries(task_id TEXT PRIMARY KEY REFERENCES agent_requests,status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_queue ON agent_requests(status,created_at);
      CREATE TABLE IF NOT EXISTS platform_errors(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,generation INTEGER NOT NULL,source TEXT NOT NULL,tool TEXT,code TEXT NOT NULL,message TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_error_task ON platform_errors(task_id,created_at);
    `);
    // Old databases may require retired digest columns. Preserve their history,
    // and write neutral values only for new requests without adding those columns.
    this.requestColumns = new Set(this.db.prepare("PRAGMA table_info(agent_requests)").all().map((column) => column.name));
    if (!this.requestColumns.has('definition')) {
      this.db.exec('ALTER TABLE agent_requests ADD COLUMN definition TEXT');
      this.requestColumns.add('definition');
    }
    if (!this.requestColumns.has('retry_of')) {
      this.db.exec('ALTER TABLE agent_requests ADD COLUMN retry_of TEXT');this.requestColumns.add('retry_of');
    }
    if(this.registry.catalog.requirePluginConnections===true) {
      this.pluginConnections=new PluginConnectionStore(this.db,this.registry);
      this.registry.pluginConnections=this.pluginConnections;
    }
    this.plugins = new PluginStore(this.db,this.registry);
    for (const definition of this.registry.initialDefinitions ?? [])
      if (!this.db.prepare('SELECT 1 FROM platform_plugins WHERE type=?').get(definition.type)) this.plugins.save(definition);
    this.registry.catalog.initializeStorage?.({db:this.db});
    this.operationColumns = new Set(this.db.prepare("PRAGMA table_info(agent_operations)").all().map((column) => column.name));
    this.db.exec(
      "UPDATE agent_deliveries SET status='unknown' WHERE status='attempted'",
    );
    if (!this.db.prepare("PRAGMA table_info(agent_runs)").all().some((column) => column.name === "runtime_metadata"))
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN runtime_metadata TEXT NOT NULL DEFAULT '{}'");
    if (!this.db.prepare("PRAGMA table_info(agent_runs)").all().some(column => column.name === "generation"))
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    this.validations = new Set();
    this.moduleStorage = new Map();
    try {
      for (const [type, module] of this.registry.modules) {
        if (module.initializeStorage)
          this.moduleStorage.set(type, module.initializeStorage({
            db: this.db,
            transaction: (fn) => this.transaction(fn),
            queueLimit,
          }));
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  storageFor(type) {
    const storage = this.moduleStorage.get(type);
    if (!storage) throw fault("MODULE_STORAGE_UNAVAILABLE", 503);
    return storage;
  }
  transaction(fn) {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
  ping() {
    return this.db.prepare("SELECT 1 AS ok").get().ok === 1;
  }
  close() {
    this.db.close();
  }
  overview() {
    const tasks=Object.fromEntries(['queued','dispatching','running','completing','suspended','completed','failed'].map(key=>[key,0]));
    for(const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM agent_requests GROUP BY status').all())tasks[row.status]=row.count;
    return {tasks,deliveries:this.db.prepare('SELECT status,COUNT(*) AS count FROM agent_deliveries GROUP BY status').all(),
      recent_errors:this.db.prepare("SELECT task_id,type,error,updated_at FROM agent_requests WHERE status='failed' ORDER BY updated_at DESC LIMIT 20").all().map(row=>({...row,error:JSON.parse(row.error ?? '{}')}))};
  }
  listTasks(args={}) {
    const filters=[],values=[];
    for(const key of ['status','type'])if(args[key]){filters.push(`${key}=?`);values.push(args[key]);}
    if(args.after!==undefined){filters.push('created_at>=?');values.push(args.after);}
    if(args.before!==undefined){filters.push('created_at<?');values.push(args.before);}
    if(args.search){filters.push('(request_id LIKE ? OR input LIKE ?)');values.push(`%${args.search}%`,`%${args.search}%`);}
    return this.db.prepare(`SELECT task_id,request_id,type,status,error,created_at,updated_at,retry_of FROM agent_requests ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY created_at DESC,task_id LIMIT ? OFFSET ?`).all(...values,args.limit ?? 50,args.offset ?? 0).map(row=>({...row,error:row.error?JSON.parse(row.error):null}));
  }
  operationRecords(runId){return this.db.prepare('SELECT tool,status FROM agent_operations WHERE run_id=?').all(runId);}
  retry(taskId,{itemIds}={}) {
    return this.transaction(()=>{
      const row=this.raw(taskId);if(!row)throw fault('NOT_FOUND',404);
      if(!['completed','failed'].includes(row.status))throw fault('TASK_NOT_TERMINAL',409);
      const module=this.moduleFor(row);let input=JSON.parse(row.input);
      if(itemIds){if(!module.retryInput)throw fault('ITEM_SELECTION_UNAVAILABLE',400);input=module.retryInput(input,itemIds);}
      const next=this.accept(row.client_id,{type:row.type,request_id:`retry:${row.task_id}:${randomUUID()}`,input});
      this.db.prepare('UPDATE agent_requests SET retry_of=? WHERE task_id=?').run(row.task_id,next.task_id);
      return {...next,retry_of:row.task_id};
    });
  }
  raw(id) {
    return this.db
      .prepare("SELECT * FROM agent_requests WHERE task_id=?")
      .get(id);
  }
  get(id, client) {
    const row = this.raw(id);
    if (!row || (client !== undefined && row.client_id !== client)) return null;
    return {
      task_id: row.task_id,
      type: row.type,
      module_version: row.module_version,
      retry_of:row.retry_of ?? null,
      created_at:row.created_at,updated_at:row.updated_at,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error ? JSON.parse(row.error) : null,
      errors:this.db.prepare('SELECT source,tool,code,message,generation,created_at FROM platform_errors WHERE task_id=? ORDER BY created_at,id').all(id),
      execution: row.run_id ? {
        run_id: row.run_id,
        ...JSON.parse(this.run(row.run_id)?.runtime_metadata ?? "{}"),
      } : null,
      delivery: {...(this.db
        .prepare("SELECT status FROM agent_deliveries WHERE task_id=?")
        .get(id) ?? { status: "not_required" }),...this.registry.catalog.deliveryDetails?.(this,id)},
    };
  }
  moduleFor(row) {return this.registry.forTask(row);}
  recordToolError(run,tool,error) {
    this.db.prepare('INSERT INTO platform_errors VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),run.task_id,run.run_id,run.generation ?? 0,'tool',tool,error.code,error.message?.slice(0,4096) ?? null,Date.now());
  }
  accept(client, body, { prepared: imported } = {}) {
    if(body?.type&&this.registry.modules.get(body.type)?.definition)this.pluginConnections?.assertReady(body.type);
    const { module, input } = this.registry.normalize(body);
    // Only trusted legacy imports supply prepared data; new admissions use the
    // module's configuration check without preventing historical queue migration.
    if (!imported) module.assertRequest?.(input);
    return this.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_requests WHERE status='queued'",
          )
          .get().n >= this.queueLimit
      )
        throw fault("QUEUE_FULL", 503);
      const taskId = randomUUID();
      const prepared = imported ??
        module.prepareRequest?.(input, { store: this, taskId, client }) ?? {
          input,
        };
      const done = prepared.result !== undefined;
      const timestamp = Date.now();
      const values = {
        task_id: taskId, client_id: client, request_id: body.request_id,
        type: module.type, module_version: module.version,
        definition: module.definition ? JSON.stringify(module.definition) : null,
        input: JSON.stringify(input), execution_input: JSON.stringify(prepared.input ?? input),
        status: done ? "completed" : "queued",
        result: done ? JSON.stringify(prepared.result) : null,
        created_at: timestamp, updated_at: timestamp,
      };
      for (const column of ["fingerprint", "config_digest", "request_digest"])
        if (this.requestColumns.has(column)) values[column] = "";
      const columns = Object.keys(values);
      this.db.prepare(`INSERT INTO agent_requests(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(values));
      return {
        ...this.get(taskId),
        duplicate: false,
        ...(prepared.acceptance ? { acceptance: prepared.acceptance } : {}),
      };
    });
  }
  queued() {
    return this.db
      .prepare(
        "SELECT task_id,type,run_id FROM agent_requests WHERE status IN ('queued','suspended') ORDER BY CASE status WHEN 'suspended' THEN 0 ELSE 1 END,created_at,task_id",
      )
      .all();
  }
  claim(id) {
    return this.transaction(() => {
      const row = this.raw(id);
      if(row&&['queued','suspended'].includes(row.status)&&(row.definition||this.registry.modules.get(row.type)?.definition))this.pluginConnections?.assertReady(row.type);
      if (row?.status === "suspended") {
        const token = randomBytes(32).toString("base64url");
        this.db.prepare("UPDATE agent_runs SET token_hash=?,generation=generation+1,launch_status='intent' WHERE run_id=?").run(tokenHash(token), row.run_id);
        this.db.prepare("UPDATE agent_requests SET status='dispatching',updated_at=? WHERE task_id=?").run(Date.now(), id);
        const resumed = this.run(row.run_id);
        return { run_id: row.run_id, task_id: id, token, type: row.type, input: JSON.parse(row.execution_input),
          module_version: row.module_version, definition:row.definition ? JSON.parse(row.definition) : undefined, generation: resumed.generation, resume: true };
      }
      if (row?.status !== "queued") return null;
      const module = this.moduleFor(row);
      const run_id = randomUUID(),
        token = randomBytes(32).toString("base64url");
      this.db
        .prepare(
          "UPDATE agent_requests SET status='dispatching',run_id=?,updated_at=? WHERE task_id=? AND status='queued'",
        )
        .run(run_id, Date.now(), id);
      this.db
        .prepare(
          "INSERT INTO agent_runs(run_id,task_id,token_hash,created_at) VALUES(?,?,?,?)",
        )
        .run(run_id, id, tokenHash(token), Date.now());
      module.onClaim?.({
        store: this,
        runId: run_id,
        input: JSON.parse(row.execution_input),
      });
      return {
        run_id,
        generation: 0,
        task_id: id,
        token,
        type: row.type,
        input: JSON.parse(row.execution_input),
        module_version: row.module_version,
        definition:row.definition ? JSON.parse(row.definition) : undefined,
      };
    });
  }
  run(id) {
    return this.db
      .prepare(
        "SELECT r.*,q.status,q.type,q.execution_input,q.module_version,q.definition FROM agent_runs r JOIN agent_requests q USING(task_id) WHERE r.run_id=?",
      )
      .get(id);
  }
  recordRun(id, details = {}) {
    const run = this.run(id);
    if (!run) return;
    const previous = JSON.parse(run.runtime_metadata ?? "{}");
    const safe = {};
    for (const key of ["status", "thread_id", "turn_id", "started_at", "updated_at", "ended_at", "completed", "code", "generation"]) {
      const value = details[key];
      if ((typeof value === "string" && value.length <= 256) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
        safe[key] = value;
    }
    if (typeof details.metadata_persisted === "boolean") safe.metadata_persisted = details.metadata_persisted;
    for (const key of ['error_source','error_message','last_agent_message'])
      if (typeof details[key]==='string') safe[key]=details[key].slice(0,4096);
    if (details.metadata_error === "RUNTIME_METADATA_WRITE_FAILED" || details.metadata_error === null)
      safe.metadata_error = details.metadata_error;
    // A delayed launch acknowledgement must not reopen a run already closed.
    const metadata = previous.ended_at
      ? { ...safe, ...previous, thread_id: previous.thread_id ?? safe.thread_id, turn_id: previous.turn_id ?? safe.turn_id }
      : { ...previous, ...safe };
    this.db.prepare("UPDATE agent_runs SET runtime_metadata=? WHERE run_id=?").run(JSON.stringify(metadata), id);
    if(details.execution)this.recordExecutionSettings(id,details.execution,details.generation);
  }
  recordExecutionSettings(id,execution,generation) {
    const run=this.run(id);
    if(!run||!['dispatching','running','completing','suspended'].includes(run.status)||(generation!==undefined&&run.generation!==generation))return;
    if(!execution||typeof execution.model!=='string'||!Number.isSafeInteger(execution.taskTimeoutMs)||execution.taskTimeoutMs<1||!Number.isSafeInteger(execution.toolTimeoutMs)||execution.toolTimeoutMs<1)return;
    const metadata=JSON.parse(run.runtime_metadata ?? '{}');
    metadata.execution={model:execution.model,...(execution.reasoningEffort!==undefined?{reasoningEffort:execution.reasoningEffort}:{}),taskTimeoutMs:execution.taskTimeoutMs,toolTimeoutMs:execution.toolTimeoutMs};metadata.execution_generation=run.generation;
    this.db.prepare('UPDATE agent_runs SET runtime_metadata=? WHERE run_id=?').run(JSON.stringify(metadata),id);
  }
  executionSettings(id,generation) {
    const run=this.run(id);if(!run||(generation!==undefined&&run.generation!==generation))return;
    const metadata=JSON.parse(run.runtime_metadata ?? '{}');return metadata.execution_generation===run.generation?metadata.execution:undefined;
  }
  started(id, details = {}) {
    this.recordRun(id, { status: "running", started_at: Date.now(), ...details });
    this.db
      .prepare(
        "UPDATE agent_runs SET launch_status='acknowledged' WHERE run_id=?",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE agent_requests SET status='running' WHERE run_id=? AND status IN ('dispatching','suspended')",
      )
      .run(id);
  }
  adopt(runId, details) {
    // Clear an orphaned completion barrier, never a validator in this process.
    const run = this.run(runId);
    if (run && !this.validations.has(`${runId}:${run.generation}`))
      this.db.prepare("UPDATE agent_requests SET status='running' WHERE run_id=? AND status='completing'").run(runId);
    this.started(runId, details);
  }
  authenticate(token) {
    if (typeof token !== "string" || token.length > 256)
      throw fault("UNAUTHORIZED", 401);
    const row = this.db
      .prepare("SELECT run_id FROM agent_runs WHERE token_hash=?")
      .get(tokenHash(token));
    const run = row && this.run(row.run_id);
    if (
      !run ||
      !(
        ["dispatching", "running", "completing"].includes(run.status) ||
        (run.status === "completed" && run.receipt_until > Date.now())
      )
    )
      throw fault("UNAUTHORIZED", 401);
    return { ...run, receiptOnly: run.status === "completed" };
  }
  beginOperation(runId, tool) {
    return this.transaction(() => {
      const run = this.run(runId);
      if (!run || !["dispatching", "running"].includes(run.status))
        throw fault("TASK_CLOSED");
      const operation_id = randomUUID();
      const values = { operation_id, run_id: runId, tool, status: "executing" };
      // Legacy columns remain for historical rows, without their old replay policy.
      if (this.operationColumns.has("operation_key")) values.operation_key = operation_id;
      if (this.operationColumns.has("input_digest")) values.input_digest = "";
      const columns = Object.keys(values);
      this.db.prepare(`INSERT INTO agent_operations(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(values));
      return { operation_id };
    });
  }
  finishOperation(id) {
    return this.transaction(() => {
      const operation = this.db
        .prepare("SELECT * FROM agent_operations WHERE operation_id=?")
        .get(id);
      if (
        !operation ||
        !["dispatching", "running"].includes(this.run(operation.run_id)?.status)
      )
        throw fault("TASK_CLOSED");
      if (
        !this.db
          .prepare(
            "UPDATE agent_operations SET status='completed' WHERE operation_id=? AND status='executing'",
          )
          .run(id).changes
      )
        throw fault("OPERATION_CONFLICT");
    });
  }
  unknownOperation(id) {
    this.db
      .prepare(
        "UPDATE agent_operations SET status='unknown' WHERE operation_id=? AND status='executing'",
      )
      .run(id);
  }
  failLocalOperation(id) {
    this.db
      .prepare(
        "UPDATE agent_operations SET status='failed' WHERE operation_id=? AND status='executing'",
      )
      .run(id);
  }
  async complete(runId, result, expectedGeneration) {
    const resultDigest = digest(result);
    const begin = this.transaction(() => {
      const run = this.run(runId);
      if (!run || (expectedGeneration !== undefined && run.generation !== expectedGeneration)) throw fault("TASK_CLOSED");
      const old = this.db
        .prepare("SELECT * FROM agent_results WHERE task_id=?")
        .get(run.task_id);
      if (old) {
        if (old.result_digest !== resultDigest)
          throw fault("COMPLETION_CONFLICT");
        return { receipt: JSON.parse(old.receipt) };
      }
      if (!["dispatching", "running"].includes(run.status))
        throw fault("TASK_CLOSED");
      if (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_operations WHERE run_id=? AND status='executing'",
          )
          .get(runId).n
      )
        throw fault("OPERATIONS_PENDING");
      this.db
        .prepare("UPDATE agent_requests SET status='completing' WHERE run_id=?")
        .run(runId);
      return { run, module: this.moduleFor(run) };
    });
    if (begin.receipt) return begin.receipt;
    const validation = `${runId}:${begin.run.generation}`;
    this.validations.add(validation);
    try {
      const { run, module } = begin;
      if (!module.checkResult(result)) throw fault("INVALID_RESULT", 400);
      const context = {
        ...this.context,
        store: this,
        runId,
        taskId: run.task_id,
        input: JSON.parse(run.execution_input),
      };
      if (context.process) {
        const process = context.process;
        context.process = body => process({...body,generation:run.generation});
      }
      const validated =
        (await module.validateResult?.(result, context)) ?? result;
      return this.transaction(() => {
        if (this.run(runId)?.status !== "completing" || this.run(runId)?.generation !== run.generation)
          throw fault("TASK_CLOSED");
        module.persistResult?.(validated, context);
        const deliveryStatus = module.delivery ? "pending" : "not_required";
        const receipt = {
          accepted: true,
          task_status: "completed",
          delivery_status: deliveryStatus,
          task_id: run.task_id,
          run_id: runId,
          status: "completed",
          receipt_id: randomUUID(),
        };
        this.db
          .prepare(
            "INSERT INTO agent_results(task_id,result_digest,receipt) VALUES(?,?,?)",
          )
          .run(run.task_id, resultDigest, JSON.stringify(receipt));
        this.db
          .prepare(
            "UPDATE agent_requests SET status='completed',result=?,updated_at=? WHERE task_id=? AND status='completing'",
          )
          .run(JSON.stringify(validated), Date.now(), run.task_id);
        this.db
          .prepare("UPDATE agent_runs SET receipt_until=? WHERE run_id=?")
          .run(Date.now() + 30000, runId);
        this.db
          .prepare("INSERT INTO agent_deliveries(task_id,status) VALUES(?,?)")
          .run(run.task_id, deliveryStatus);
        return receipt;
      });
    } catch (error) {
      this.db
        .prepare(
          "UPDATE agent_requests SET status='running' WHERE run_id=? AND status='completing' AND EXISTS(SELECT 1 FROM agent_runs WHERE run_id=? AND generation=?)",
        )
        .run(runId, runId, begin.run.generation);
      throw error;
    } finally { this.validations.delete(validation); }
  }
  fail(runId, code) {
    return this.transaction(() => {
      const run = this.run(runId);
      if (!run) return false;
      const changed = this.db
        .prepare(
          `UPDATE agent_requests SET status='failed',error=?,updated_at=? WHERE run_id=? AND status IN (${active})`,
        )
        .run(JSON.stringify({ code,...(JSON.parse(run.runtime_metadata ?? '{}').error_message ? {message:JSON.parse(run.runtime_metadata).error_message,source:JSON.parse(run.runtime_metadata).error_source ?? 'runtime'}:{}) }), Date.now(), runId).changes;
      if (changed) {
        this.db
          .prepare(
            "UPDATE agent_operations SET status='unknown' WHERE run_id=? AND status='executing'",
          )
          .run(runId);
        const module = this.moduleFor(run);
        module.onFailure?.({
          store: this,
          runId,
          input: JSON.parse(run.execution_input),
          code,
        });
        if (module.delivery)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO agent_deliveries(task_id,status) VALUES(?,'pending')",
            )
            .run(run.task_id);
      }
      return !!changed;
    });
  }
  unfinished() {
    return this.db.prepare("SELECT q.*,r.generation FROM agent_requests q JOIN agent_runs r USING(run_id) WHERE q.status IN ('dispatching','running','completing','suspended') ORDER BY q.created_at,q.task_id").all();
  }
  suspend(runId, details = {}) {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE agent_requests SET status='suspended',updated_at=? WHERE run_id=? AND status IN ('dispatching','running','completing')").run(Date.now(),runId).changes;
      if (changed) {
        this.db.prepare("UPDATE agent_operations SET status='unknown' WHERE run_id=? AND status='executing'").run(runId);
        this.recordRun(runId, { ...details, status: 'suspended', code: 'SUSPENDED' });
      }
      return !!changed;
    });
  }
  reconcile() {
    for (const row of this.unfinished()) this.suspend(row.run_id);
  }
}
